/* HFS (classic Macintosh Hierarchical File System) support for ISOBrowser.
 *
 * Self-contained, no dependencies. Exposes a global `HFS` object.
 * All `read` callbacks have the signature read(offset, length) -> Promise<Uint8Array>
 * where offset is an ABSOLUTE byte offset into the ISO image.
 *
 * Supports: Apple Partition Map -> Apple_HFS partition -> HFS volume (MDB "BD"),
 * catalog B*-tree enumeration, and data-fork reading via extents.
 * Not yet supported: extents-overflow file (files fragmented across >3 extents),
 * resource forks, HFS+ (Mac OS Extended).
 */
(function (global) {
  'use strict';

  function u16(d, o) { return (d[o] << 8) | d[o + 1]; }
  function u32(d, o) { return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0; }
  function s32(d, o) { return (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]; }
  function ascii(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0x7f); return s; }

  // MacRoman high-half (0x80..0xFF) -> Unicode.
  var MACROMAN_HI = [
    'Ä','Å','Ç','É','Ñ','Ö','Ü','á',
    'à','â','ä','ã','å','ç','é','è',
    'ê','ë','í','ì','î','ï','ñ','ó',
    'ò','ô','ö','õ','ú','ù','û','ü',
    '†','°','¢','£','§','•','¶','ß',
    '®','©','™','´','¨','≠','Æ','Ø',
    '∞','±','≤','≥','¥','µ','∂','∑',
    '∏','π','∫','ª','º','Ω','æ','ø',
    '¿','¡','¬','√','ƒ','≈','∆','«',
    '»','…',' ','À','Ã','Õ','Œ','œ',
    '–','—','“','”','‘','’','÷','◊',
    'ÿ','Ÿ','⁄','€','‹','›','ﬁ','ﬂ',
    '‡','·','‚','„','‰','Â','Ê','Á',
    'Ë','È','Í','Î','Ï','Ì','Ó','Ô',
    '','Ò','Ú','Û','Ù','ı','ˆ','˜',
    '¯','˘','˙','˚','¸','˝','˛','ˇ'
  ];

  function macRoman(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      s += b < 0x80 ? String.fromCharCode(b) : MACROMAN_HI[b - 0x80];
    }
    return s;
  }

  // Pascal string: 1 length byte + bytes.
  function pstr(bytes) {
    const len = bytes[0];
    return macRoman(bytes.subarray(1, 1 + len));
  }

  // ---- detection -----------------------------------------------------------

  // Detect Apple Partition Map -> HFS. Returns volume info or null.
  async function detect(read) {
    try {
      const blk1 = await read(512, 512);
      if (blk1.length < 512 || blk1[0] !== 0x50 || blk1[1] !== 0x4D) return null; // "PM"
      const mapBlocks = u32(blk1, 4);
      if (mapBlocks < 1 || mapBlocks > 64) return null;
      const map = await read(512, mapBlocks * 512);
      let partStart = -1;
      for (let i = 0; i < mapBlocks; i++) {
        const e = map.subarray(i * 512, (i + 1) * 512);
        if (e[0] !== 0x50 || e[1] !== 0x4D) break;
        const type = ascii(e.subarray(48, 80)).replace(/\0[\s\S]*$/, '');
        if (type === 'Apple_HFS') { partStart = u32(e, 8); break; }
      }
      if (partStart < 0) return null;

      const mdb = await read(partStart * 512 + 1024, 512);
      if (mdb.length < 512 || mdb[0] !== 0x42 || mdb[1] !== 0x44) return null; // "BD"
      return parseMdb(mdb, partStart);
    } catch (e) {
      return null;
    }
  }

  function parseMdb(mdb, partStart) {
    const blockSize = u32(mdb, 20);          // drAlBlkSiz
    const alBlSt = u16(mdb, 28);             // drAlBlSt (logical-block number of allocation block 0)
    const volName = pstr(mdb.subarray(36, 64));
    return {
      type: 'hfs',
      partStart,                             // 512-byte block where the HFS partition begins
      blockSize,                             // allocation block size in bytes
      alBlSt,                                // first allocation block (in 512-byte logical blocks)
      fileCount: u32(mdb, 84),               // drFilCnt
      dirCount: u32(mdb, 88),                // drDirCnt
      volName,
      catalogExtents: readExtents(mdb, 150), // drCTExtRec
      extentsOverflowExtents: readExtents(mdb, 134), // drXTExtRec
      baseOffset: partStart * 512            // absolute byte offset of the partition start
    };
  }

  function readExtents(d, o) {
    const ext = [];
    for (let i = 0; i < 3; i++) {
      const start = u16(d, o + i * 4);
      const count = u16(d, o + i * 4 + 2);
      ext.push({ start, count });
    }
    return ext;
  }

  // Allocation block N -> absolute byte offset.
  function allocOffset(vol, block) {
    return vol.baseOffset + vol.alBlSt * 512 + block * vol.blockSize;
  }

  // ---- B-tree --------------------------------------------------------------

  // Parse the catalog B-tree header node, return { nodeSize, rootNode }.
  function parseHeaderNode(node) {
    // BTNodeDescriptor is 14 bytes; the BTHeaderRec follows immediately (header node has no offset array before it).
    return {
      treeDepth: u16(node, 14),
      rootNode: u32(node, 16),
      leafRecords: u32(node, 20),
      firstLeafNode: u32(node, 24),
      lastLeafNode: u32(node, 28),
      nodeSize: u16(node, 32),
      totalNodes: u32(node, 36),
      freeNodes: u32(node, 40)
    };
  }

  // Read the whole catalog file at once (concatenate the extent chain) to avoid per-node request latency.
  async function readCatalogWhole(read, vol) {
    const chunks = [];
    for (const e of vol.catalogExtents) {
      if (!e.count) continue;
      chunks.push(await read(allocOffset(vol, e.start), e.count * vol.blockSize));
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }

  // Record boundaries of a node: the offset array lives at the END of the
  // node and lists boundaries in descending order; reverse it for forward order.
  function recordBounds(node) {
    const numRecords = u16(node, 10);
    const start = node.length - (numRecords + 1) * 2;
    const bounds = [];
    for (let i = 0; i <= numRecords; i++) bounds.push(u16(node, start + i * 2));
    bounds.reverse();
    return bounds;
  }

  // ---- catalog records -----------------------------------------------------

  // Stream catalog entries: walk the leaf chain (fLink) and yield each entry as
  // it is read, so the caller can render incrementally. Parents precede children
  // in the chain (keys are sorted by parentID and parent CNIDs are assigned
  // before their children).
  async function* catalogEntries(read, vol) {
    const catBytes = await readCatalogWhole(read, vol);
    const hdr = parseHeaderNode(catBytes.subarray(0, 512));
    const nodeSize = hdr.nodeSize;

    const ROOT = 2;
    const dirs = new Map();                       // cnid -> { name, parentID }
    const idToPath = new Map([[ROOT, ''], [1, '']]);
    function escName(name) { return name.replace(/\//g, '∕'); }
    function joinPath(parent, name) { return parent ? parent + '/' + escName(name) : '/' + escName(name); }
    function resolvePath(parentID) {
      if (idToPath.has(parentID)) return idToPath.get(parentID);
      const d = dirs.get(parentID);
      if (!d) return '';
      const p = resolvePath(d.parentID);
      const path = joinPath(p, d.name);
      idToPath.set(parentID, path);
      return path;
    }

    // Leaf records are sorted by (parentID, name), so same-parentID records are
    // contiguous. Group by parentID; within a group (a directory's direct children)
    // yield directories first, then files, sorted by name.
    let groupParentID = -1;
    let group = [];

    let nodeNum = hdr.firstLeafNode;
    while (nodeNum) {
      const node = catBytes.subarray(nodeNum * nodeSize, (nodeNum + 1) * nodeSize);
      const n = u16(node, 10);
      const b = recordBounds(node);
      for (let i = 0; i < n; i++) {
        const rec = node.subarray(b[i], b[i + 1]);
        const keyLen = rec[0];
        let dataOff = 1 + keyLen;
        if (dataOff & 1) dataOff++;
        if (dataOff + 6 > rec.length) continue;
        const type = rec[dataOff];
        let entry = null;
        if (type === 0x01) {
          const parentID = u32(rec, 2);
          const name = pstr(rec.subarray(6, 6 + rec[6] + 1));
          const folderID = u32(rec, dataOff + 6);
          dirs.set(folderID, { name, parentID });
          if (folderID !== ROOT) {
            entry = { parentID, cnid: folderID, name, path: joinPath(resolvePath(parentID), name), isDir: true, size: 0 };
          }
        } else if (type === 0x02) {
          const parentID = u32(rec, 2);
          const name = pstr(rec.subarray(6, 6 + rec[6] + 1));
          const dataSize = Math.max(0, s32(rec, dataOff + 26));
          const extents = readExtents(rec, dataOff + 74);
          const ostype = macRoman(rec.subarray(dataOff + 4, dataOff + 8));
          entry = { parentID, name, path: joinPath(resolvePath(parentID), name), isDir: false, size: dataSize, dataSize, type: ostype, extents };
        }
        // thread records (0x03, 0x04) carry no extra info we need.
        if (!entry) continue;
        if (entry.parentID !== groupParentID) {
          if (group.length) {
            group.sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
            });
            for (const e of group) yield e;
          }
          group = [];
          groupParentID = entry.parentID;
        }
        group.push(entry);
      }
      nodeNum = u32(node, 0);  // fLink: next leaf node
    }
    if (group.length) {
      group.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
      });
      for (const e of group) yield e;
    }
  }

  // Read a file's data fork only (the resource fork is Mac metadata, ignored here).
  async function readFile(read, vol, fileEntry) {
    const size = fileEntry.dataSize !== undefined ? fileEntry.dataSize : fileEntry.size;
    const out = new Uint8Array(size);
    let p = 0;
    for (const e of fileEntry.extents) {
      if (!e.count || p >= size) break;
      const off = allocOffset(vol, e.start);
      const want = Math.min(e.count * vol.blockSize, size - p);
      const data = await read(off, want);
      out.set(data, p);
      p += data.length;
    }
    return out;
  }

  global.HFS = { detect, catalogEntries, readFile, allocOffset };
})(typeof globalThis !== 'undefined' ? globalThis : self);
