// ISOBrowser Service Worker
// Serves ISO/ZIP-internal files for HTML preview, so relative resources
// (CSS/images/JS) load as if they were real files on the origin.

// AIF container support (used only when a session carries aif === true).
// Non-fatal if the files are missing — ISO/ZIP/HFS still work.
try { importScripts('lzma1.bundle.js?v=1', 'aif.js?v=2', 'udf.js?v=1'); } catch (e) {}

const sessions = new Map();
const aifReaders = new WeakMap(); // session object -> Promise<AIF reader>

// Persist sessions so a terminated-and-revived worker doesn't lose them —
// browsers kill idle service workers after a short timeout.
const DB_NAME = 'isobrowser-sw';
const DB_STORE = 'sessions';
let dbPromise = null;
function getDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function dbPut(sessionId, session) {
  getDb().then(db => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(session, sessionId);
  }).catch(() => {});
}
function dbGet(sessionId) {
  return getDb().then(db => new Promise(resolve => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(sessionId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  })).catch(() => undefined);
}
function dbDelete(sessionId) {
  getDb().then(db => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(sessionId);
  }).catch(() => {});
}

function clearSessions() {
  return getDb().then(db => new Promise(resolve => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  })).catch(() => {});
}

// Take over immediately when a new version installs (no manual update needed)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    await self.clients.claim();
    await clearSessions();
  })());
});

self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d) return;
  if (d.type === 'set-session') {
    sessions.set(d.sessionId, d.session);
    if (typeof d.session.url === 'string' || (d.session.url && typeof d.session.url.getFile === 'function')) {
      dbPut(d.sessionId, d.session);
    }
    if (e.ports && e.ports[0]) e.ports[0].postMessage('ok');
  } else if (d.type === 'clear-session') {
    sessions.delete(d.sessionId);
    dbDelete(d.sessionId);
  }
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const idx = url.pathname.indexOf('/_iso/');
  if (idx === -1) return;
  const rest = url.pathname.slice(idx + 6); // after '/_iso/'
  const slash = rest.indexOf('/');
  if (slash === -1) return;
  const sessionId = rest.slice(0, slash);
  const path = decodeURIComponent(rest.slice(slash + 1));
  const session = sessions.get(sessionId);
  if (session) {
    logFetch(e);
    e.respondWith(serve(session, path));
  } else {
    e.respondWith(dbGet(sessionId).then(s => {
      if (!s) {
        self.clients.matchAll().then(list => {
          list.forEach(c => c.postMessage({ type: 'session-expired', sessionId }));
        });
        return new Response('Session expired (local file unavailable). Re-open the archive.', { status: 404 });
      }
      sessions.set(sessionId, s);
      logFetch(e);
      return serve(s, path);
    }));
  }
});

function logFetch(e) {
  self.clients.matchAll().then(list => {
    list.forEach(c => c.postMessage({ type: 'log', method: e.request.method, url: e.request.url }));
  });
}

async function serve(session, path) {
  // The entry HTML document: serve it with a CSP that disables scripts. It is
  // loaded at its real archive-relative path, so relative refs (including ../)
  // resolve against it natively — no <base> needed.
  if (path === session.entry) {
    return new Response(injectCsp(session.html), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  }
  const lower = path.toLowerCase();
  let f = session.files[lower];
  if (!f) {
    // Fallback: match by basename (handles HTML pages whose resource paths
    // don't line up with the archive's actual directory layout)
    const base = lower.split('/').pop();
    for (const k in session.files) {
      if (k.split('/').pop() === base) { f = session.files[k]; break; }
    }
  }
  if (!f && session.dirs && session.archiveType !== 'zip') {
    f = await resolveMiss(session, lower);
  }
  if (!f) return new Response('Not found', { status: 404 });
  try {
    const bytes = await readFileData(session, f);
    return new Response(bytes, {
      headers: { 'Content-Type': mimeType(path), 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return new Response('Failed: ' + err.message, { status: 500 });
  }
}

// Read bytes from the outer ISO at an arbitrary byte offset (handles 2048/2352 layouts)
async function readOuterBytes(session, byteOffset, len) {
  const ss = session.sectorSize || 2048;
  const off = session.dataOffset || 0;
  if (ss === 2048) return fetchRange(session.url, byteOffset, len);
  const firstSector = Math.floor(byteOffset / 2048);
  const lastSector = Math.floor((byteOffset + len - 1) / 2048);
  const n = lastSector - firstSector + 1;
  const raw = await fetchRange(session.url, firstSector * ss, n * ss);
  const out = new Uint8Array(n * 2048);
  for (let i = 0; i < n; i++) out.set(raw.subarray(i * ss + off, i * ss + off + 2048), i * 2048);
  return out.subarray(byteOffset - firstSector * 2048, byteOffset - firstSector * 2048 + len);
}

// Recursively read a file's bytes (supports outer ISO -> nested archive -> file)
async function readFileData(session, f) {
  if (!f.inner) {
    if (f.fs === 'hfs') return readHfsFile(session, f);
    if (session.archiveType === 'zip') return extractZip(session, f);
    if (session.archiveType === 'hfs') return readHfsFile(session, f);
    if (session.archiveType === 'udf') return readUdfFile(session, f);
    if (session.archiveType === 'fat') return readFatFile(session, f);
    if (session.aif) return readAifFile(session, f);
    return readIso(session, f);
  }
  const base = f.inner.containerLba * 2048;  // byte offset of the nested archive in the outer ISO
  if (f.method !== undefined) {
    // File inside a nested ZIP
    if (!f.compressedSize) return new Uint8Array(0);
    const local = await readOuterBytes(session, base + f.offset, 30);
    const nameLen = local[26] | (local[27] << 8);
    const extraLen = local[28] | (local[29] << 8);
    const dataStart = base + f.offset + 30 + nameLen + extraLen;
    const compressed = await readOuterBytes(session, dataStart, f.compressedSize);
    if (f.method === 0) return compressed;
    if (f.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compressed]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('Unsupported ZIP method ' + f.method);
  }
  // File inside a nested ISO
  const ss = f.inner.sectorSize || 2048;
  const off = f.inner.dataOffset || 0;
  if (ss === 2048) return readOuterBytes(session, base + f.lba * 2048, f.size);
  const n = Math.ceil(f.size / 2048);
  const raw = await readOuterBytes(session, base + f.lba * ss, n * ss);
  const out = new Uint8Array(n * 2048);
  for (let i = 0; i < n; i++) out.set(raw.subarray(i * ss + off, i * ss + off + 2048), i * 2048);
  return out.subarray(0, f.size);
}

// Read a classic-HFS file's data fork from its allocation-block extents.
async function readHfsFile(session, f) {
  const vol = session.hfsVol;
  const size = f.dataSize !== undefined ? f.dataSize : f.size;
  const out = new Uint8Array(size);
  let p = 0;
  for (const e of f.extents) {
    if (!e || !e.count || p >= size) break;
    const off = vol.baseOffset + vol.alBlSt * 512 + e.start * vol.blockSize;
    const want = Math.min(e.count * vol.blockSize, size - p);
    const data = session.aif ? await aifByteRead(session, off, want) : await fetchRange(session.url, off, want);
    out.set(data, p);
    p += data.length;
  }
  return out;
}

// Build (and cache per session) the AIF container reader. The AIF's DDT is
// decompressed once and reused for every file read in this session.
function getAifReader(session) {
  if (!aifReaders.has(session)) {
    aifReaders.set(session, self.AIF.open((start, length) => fetchRange(session.url, start, length)));
  }
  return aifReaders.get(session);
}

// Read a file whose sectors live inside an AIF container.
async function readAifFile(session, f) {
  const reader = await getAifReader(session);
  const n = Math.ceil(f.size / 2048);
  const out = new Uint8Array(n * 2048);
  for (let i = 0; i < n; i++) {
    const s = await reader.readSector(f.lba + i);
    out.set(s ? s.subarray(0, 2048) : new Uint8Array(2048), i * 2048);
  }
  return out.subarray(0, f.size);
}

// Byte-offset read through the AIF reader (for HFS-in-AIF file data).
async function aifByteRead(session, off, len) {
  const reader = await getAifReader(session);
  const first = Math.floor(off / 2048);
  const n = Math.floor((off + len - 1) / 2048) - first + 1;
  const out = new Uint8Array(n * 2048);
  for (let i = 0; i < n; i++) {
    const s = await reader.readSector(first + i);
    out.set(s ? s.subarray(0, 2048) : new Uint8Array(2048), i * 2048);
  }
  return out.subarray(off - first * 2048, off - first * 2048 + len);
}

// Read a UDF file by concatenating its allocation extents.
async function readUdfFile(session, f) {
  const vol = session.udfVol;
  const out = new Uint8Array(f.size);
  let off = 0;
  for (const e of f.extents) {
    if (off >= f.size) break;
    const want = Math.min(e.len, f.size - off);
    const absOff = (vol.partitionStart + e.loc) * vol.blockSize;
    const data = session.aif ? await aifByteRead(session, absOff, want) : await fetchRange(session.url, absOff, want);
    out.set(data, off);
    off += data.length;
  }
  return out;
}

// Read a FAT file by following its cluster chain.
async function readFatFile(session, f) {
  const bpb = session.fatVol.bpb;
  const fat = session.fatVol.fat;
  const fatOf = bpb.fatType === 12
    ? (c) => { const o = Math.floor(c * 3 / 2); const v = fat[o] | (fat[o + 1] << 8); return (c & 1) ? (v >>> 4) : (v & 0x0FFF); }
    : (c) => { const o = c * 2; return fat[o] | (fat[o + 1] << 8); };
  const out = new Uint8Array(f.size);
  let off = 0;
  let c = f.cluster;
  while (c >= 2 && c < 0xFF0) {
    if (off >= f.size) break;
    const want = Math.min(bpb.sectorsPerCluster * bpb.bytesPerSector, f.size - off);
    const sector = bpb.firstDataSector + (c - 2) * bpb.sectorsPerCluster;
    const data = await fetchRange(session.url, sector * bpb.bytesPerSector, want);
    out.set(data, off);
    off += data.length;
    c = fatOf(c);
  }
  return out;
}

// ---- ISO directory fallback: re-walk only the un-parsed path on a miss ----

function u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }
function ascii(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0x7f); return s; }
function latin1(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
function ucs2(bytes) { let s = ''; for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]); return s; }

function rockRidgeName(rec) {
  const nameLen = rec[32];
  let su = 33 + nameLen;
  if (su & 1) su++;
  const len = rec.length;
  const parts = [];
  while (su + 4 <= len) {
    const sig = String.fromCharCode(rec[su]) + String.fromCharCode(rec[su + 1]);
    const entryLen = rec[su + 2];
    if (entryLen < 4 || su + entryLen > len) break;
    if (sig === 'NM') {
      const flags = rec[su + 4];
      if (!(flags & 0x06)) parts.push(latin1(rec.subarray(su + 5, su + entryLen)));
      if (!(flags & 0x01)) return parts.join('');
    }
    su += entryLen;
  }
  return '';
}

function isoEntryName(raw, rec, isJoliet, useRR) {
  let name = isJoliet ? ucs2(raw) : ascii(raw).trim();
  name = name.split(';')[0];
  if (useRR && !isJoliet) {
    const rr = rockRidgeName(rec);
    if (rr) name = rr;
  }
  return name;
}

// Walk from a parsed directory descriptor (lba/size, optional inner container)
// to a target file, resolving each path segment through directory records.
async function walkToFile(session, dir, segments, isJoliet) {
  const useRR = !isJoliet;
  const inner = dir.inner;
  let cur = { lba: dir.lba, size: dir.size, inner };
  for (let i = 0; i < segments.length; i++) {
    const want = segments[i].toLowerCase();
    const data = await readFileData(session, cur);
    let hit = null;
    let p = 0;
    while (p + 33 < data.length) {
      const reclen = data[p];
      if (reclen === 0) { p = ((p >> 11) + 1) << 11; if (p >= data.length) break; continue; }
      const nameLen = data[p + 32];
      const raw = data.subarray(p + 33, p + 33 + nameLen);
      if ((nameLen === 1 && (raw[0] === 0 || raw[0] === 1)) || (nameLen === 2 && raw[0] === 0 && (raw[1] === 0 || raw[1] === 1))) { p += reclen; continue; }
      const name = isoEntryName(raw, data.subarray(p, p + reclen), isJoliet, useRR);
      if (name.toLowerCase() === want) {
        hit = { isDir: (data[p + 25] & 0x02) !== 0, lba: u32(data, p + 2), size: u32(data, p + 10) };
        break;
      }
      p += reclen;
    }
    if (!hit) return null;
    if (i === segments.length - 1) return hit.isDir ? null : { lba: hit.lba, size: hit.size, inner };
    if (!hit.isDir) return null;
    cur = { lba: hit.lba, size: hit.size, inner };
  }
  return null;
}

// On a miss, walk from the deepest already-parsed ancestor directory to the file
async function resolveMiss(session, lowerPath) {
  const segs = lowerPath.split('/');
  const fileName = segs.pop();
  for (let i = segs.length; i >= 0; i--) {
    const dirPath = segs.slice(0, i).join('/');
    const d = session.dirs[dirPath];
    if (!d) continue;
    const f = await walkToFile(session, d, segs.slice(i).concat(fileName), !!session.isJoliet);
    if (f) {
      session.files[lowerPath] = f;
      return f;
    }
    return null;
  }
  return null;
}

function injectCsp(html) {
  const csp = '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">';
  const lower = html.toLowerCase();
  const idx = lower.indexOf('<head>');
  if (idx !== -1) return html.slice(0, idx + 6) + csp + html.slice(idx + 6);
  return csp + html;
}

async function fetchRange(src, start, length) {
  if (typeof src !== 'string') {
    let file = src;
    if (typeof src.getFile === 'function') file = await src.getFile();
    return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  }
  const res = await fetch(src, { headers: { Range: 'bytes=' + start + '-' + (start + length - 1) } });
  if (res.status !== 206) throw new Error('HTTP ' + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

async function readIso(session, f) {
  const ss = session.sectorSize || 2048;
  const off = session.dataOffset || 0;
  if (ss === 2048) return fetchRange(session.url, f.lba * 2048, f.size);
  const n = Math.ceil(f.size / 2048);
  const raw = await fetchRange(session.url, f.lba * ss, n * ss);
  const out = new Uint8Array(n * 2048);
  for (let i = 0; i < n; i++) {
    out.set(raw.subarray(i * ss + off, i * ss + off + 2048), i * 2048);
  }
  return out.subarray(0, f.size);
}

async function extractZip(session, f) {
  if (!f.compressedSize) return new Uint8Array(0);
  const local = await fetchRange(session.url, f.offset, 30);
  const nameLen = local[26] | (local[27] << 8);
  const extraLen = local[28] | (local[29] << 8);
  const dataStart = f.offset + 30 + nameLen + extraLen;
  const compressed = await fetchRange(session.url, dataStart, f.compressedSize);
  if (f.method === 0) return compressed;
  if (f.method === 8) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([compressed]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('Unsupported ZIP method ' + f.method);
}

function mimeType(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return {
    html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
    css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
    json: 'application/json', xml: 'application/xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    mp4: 'video/mp4', webm: 'video/webm',
    txt: 'text/plain', md: 'text/plain',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf'
  }[ext] || 'application/octet-stream';
}
