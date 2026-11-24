/*
 * FAT12/FAT16 filesystem parser for raw floppy/disk images (.ima/.img).
 *
 * All `read` callbacks have the signature read(offset, length) -> Promise<Uint8Array>
 * and address the raw image (byte offset = sector number * bytesPerSector).
 *
 * Public API:
 *   FAT.detectBoot(bytes)              -> bpb object | null   (synchronous, >= 512 bytes)
 *   FAT.parseVolume(read, bpb)         -> Promise<vol>
 *   FAT.catalogEntries(read, vol)      -> async iterator of { name, path, isDir, size, cluster }
 *   FAT.readFile(read, vol, node)      -> Promise<Uint8Array>
 */
(function (global) {
  'use strict';

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  // Parse the BIOS Parameter Block from a boot sector (>= 512 bytes).
  // Returns null when it is not a recognizable FAT boot sector.
  function detectBoot(bytes) {
    if (bytes.length < 512) return null;
    if (bytes[510] !== 0x55 || bytes[511] !== 0xAA) return null;
    const bytesPerSector = u16(bytes, 11);
    if (bytesPerSector !== 512 && bytesPerSector !== 1024 && bytesPerSector !== 2048 && bytesPerSector !== 4096) return null;
    const sectorsPerCluster = bytes[13];
    if (sectorsPerCluster === 0 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0) return null;
    const reservedSectors = u16(bytes, 14);
    if (reservedSectors < 1) return null;
    const numFATs = bytes[16];
    if (numFATs !== 1 && numFATs !== 2) return null;
    const rootEntryCount = u16(bytes, 17);
    if (rootEntryCount === 0) return null;
    let totalSectors = u16(bytes, 19);
    if (totalSectors === 0) totalSectors = u32(bytes, 32);
    if (totalSectors === 0) return null;
    let fatSectors = u16(bytes, 22);
    if (fatSectors === 0) fatSectors = u32(bytes, 36);
    if (fatSectors === 0) return null;

    const rootDirSectors = Math.ceil(rootEntryCount * 32 / bytesPerSector);
    const firstDataSector = reservedSectors + numFATs * fatSectors + rootDirSectors;
    if (firstDataSector >= totalSectors) return null;
    const dataSectors = totalSectors - firstDataSector;
    const clusterCount = Math.floor(dataSectors / sectorsPerCluster);
    if (clusterCount < 2) return null;
    const fatType = clusterCount < 4085 ? 12 : (clusterCount < 65525 ? 16 : 32);

    return {
      bytesPerSector,
      sectorsPerCluster,
      reservedSectors,
      numFATs,
      rootEntryCount,
      totalSectors,
      fatSectors,
      mediaDescriptor: bytes[21],
      rootDirSectors,
      firstDataSector,
      dataSectors,
      clusterCount,
      fatType
    };
  }

  // Read the first FAT into memory and return a volume handle.
  async function parseVolume(read, bpb) {
    const fatBytes = await read(
      bpb.reservedSectors * bpb.bytesPerSector,
      bpb.fatSectors * bpb.bytesPerSector
    );
    const fatOf = bpb.fatType === 12
      ? function (cluster) {
          const off = Math.floor(cluster * 3 / 2);
          const v = fatBytes[off] | (fatBytes[off + 1] << 8);
          return (cluster & 1) ? (v >>> 4) : (v & 0x0FFF);
        }
      : function (cluster) {
          const off = cluster * 2;
          return fatBytes[off] | (fatBytes[off + 1] << 8);
        };
    return { bpb: bpb, fat: fatBytes, fatOf: fatOf };
  }

  function sectorOf(vol, cluster) {
    return vol.bpb.firstDataSector + (cluster - 2) * vol.bpb.sectorsPerCluster;
  }

  // Follow a cluster chain from `start`, excluding the end-of-chain marker.
  function clusterChain(vol, start) {
    const chain = [];
    let c = start;
    while (c >= 2 && c < 0xFF0) {
      chain.push(c);
      c = vol.fatOf(c);
    }
    return chain;
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  function readShortName(data, p) {
    let name = '', ext = '';
    for (let i = 0; i < 8; i++) {
      const c = data[p + i];
      if (c === 0x20 || c === 0) break;
      name += String.fromCharCode(c);
    }
    for (let i = 8; i < 11; i++) {
      const c = data[p + i];
      if (c === 0x20 || c === 0) break;
      ext += String.fromCharCode(c);
    }
    return ext ? name + '.' + ext : name;
  }

  function readLfnChunk(data, p) {
    let s = '';
    for (let i = 0; i < 5; i++) {
      const c = u16(data, p + 1 + i * 2);
      if (c === 0 || c === 0xFFFF) return s;
      s += String.fromCharCode(c);
    }
    for (let i = 0; i < 6; i++) {
      const c = u16(data, p + 14 + i * 2);
      if (c === 0 || c === 0xFFFF) return s;
      s += String.fromCharCode(c);
    }
    for (let i = 0; i < 2; i++) {
      const c = u16(data, p + 28 + i * 2);
      if (c === 0 || c === 0xFFFF) return s;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function parseDirEntries(data) {
    const entries = [];
    let lfn = '';
    for (let p = 0; p + 32 <= data.length; p += 32) {
      const first = data[p];
      if (first === 0x00) break;
      if (first === 0xE5) { lfn = ''; continue; }
      const attr = data[p + 11];
      if (attr === 0x0F) {
        lfn = readLfnChunk(data, p) + lfn;
        continue;
      }
      if (attr & 0x08) { lfn = ''; continue; } // volume label
      const shortName = readShortName(data, p);
      const name = lfn || shortName;
      lfn = '';
      if (shortName === '.' || shortName === '..') continue;
      entries.push({
        name: name,
        isDir: (attr & 0x10) !== 0,
        cluster: u16(data, p + 26),
        size: u32(data, p + 28)
      });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
    return entries;
  }
  // Read one directory's raw bytes. Root is a fixed region; subdirectories are
  // cluster chains.
  async function readDirData(read, vol, dir) {
    if (dir.isRoot) {
      const off = (vol.bpb.reservedSectors + vol.bpb.numFATs * vol.bpb.fatSectors) * vol.bpb.bytesPerSector;
      const len = vol.bpb.rootDirSectors * vol.bpb.bytesPerSector;
      return read(off, len);
    }
    const clusters = clusterChain(vol, dir.cluster);
    const parts = [];
    let remaining = dir.size;
    for (const c of clusters) {
      if (remaining <= 0) break;
      const want = Math.min(vol.bpb.sectorsPerCluster * vol.bpb.bytesPerSector, remaining);
      parts.push(await read(sectorOf(vol, c) * vol.bpb.bytesPerSector, want));
      remaining -= want;
    }
    return concat(parts);
  }

  // Read one directory and return its sorted entries.
  async function readDir(read, vol, dir) {
    const data = await readDirData(read, vol, dir);
    return parseDirEntries(data);
  }

  async function* catalogEntries(read, vol) {
    const queue = [{ dir: { isRoot: true }, path: '' }];
    while (queue.length) {
      const { dir, path } = queue.shift();
      const data = await readDirData(read, vol, dir);
      for (const e of parseDirEntries(data)) {
        const p = path === '' ? '/' + e.name : path + '/' + e.name;
        if (e.isDir) {
          yield { name: e.name, path: p, isDir: true, size: 0, cluster: e.cluster };
          queue.push({ dir: { cluster: e.cluster, size: e.size }, path: p });
        } else {
          yield { name: e.name, path: p, isDir: false, size: e.size, cluster: e.cluster };
        }
      }
    }
  }

  async function readFile(read, vol, node) {
    const out = new Uint8Array(node.size);
    let off = 0;
    const clusters = clusterChain(vol, node.cluster);
    for (const c of clusters) {
      if (off >= node.size) break;
      const want = Math.min(vol.bpb.sectorsPerCluster * vol.bpb.bytesPerSector, node.size - off);
      const data = await read(sectorOf(vol, c) * vol.bpb.bytesPerSector, want);
      out.set(data, off);
      off += data.length;
    }
    return out;
  }

  global.FAT = {
    detectBoot: detectBoot,
    parseVolume: parseVolume,
    readDir: readDir,
    catalogEntries: catalogEntries,
    readFile: readFile
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));
