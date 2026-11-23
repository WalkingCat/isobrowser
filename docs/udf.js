/*
 * udf.js — UDF (Universal Disk Format) support for ISOBrowser.
 *
 * Reads a UDF filesystem (DVD/Blu-ray discs, and ISO/UDF "bridge" discs) via a
 * read(offset, length) -> Promise<Uint8Array> callback, where offset is an
 * ABSOLUTE byte offset into the image.
 *
 * Supports: UDF 2.x with a single type-1 (physical) partition, long_ad
 * allocation descriptors, and both 8-bit and 16-bit (UCS-2BE) dstrings.
 * Not supported: type-2 virtual partitions (sparing), short_ad allocations,
 * multi-extent files with extended attributes, and UDF with metadata partitions.
 */
(function (global) {
  'use strict';

  function u16(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }
  function u64(d, o) { const lo = u32(d, o), hi = u32(d, o + 4); return hi * 0x100000000 + lo; }

  // decode a UDF "dstring" (8-bit or 16-bit UCS-2BE compression)
  function dstring(bytes) {
    const c = bytes[0];
    let s = '';
    if (c === 8) {
      for (let i = 1; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    } else if (c === 16) {
      for (let i = 1; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    } else {
      for (let i = 1; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    }
    return s;
  }

  // Detect and parse the UDF volume. Returns null if not UDF.
  async function detect(read) {
    let anchor;
    try { anchor = await read(256 * 2048, 2048); } catch (e) { return null; }
    if (anchor.length < 32 || u16(anchor, 0) !== 2) return null; // Anchor Volume Descriptor Pointer

    const vdsLoc = u32(anchor, 20); // Main Volume Descriptor Sequence (LSN)
    let vds;
    try { vds = await read(vdsLoc * 2048, 16 * 2048); } catch (e) { return null; }

    let blockSize = 2048;
    let partitionStart = 0;
    let fsdLoc = -1, fsdPart = 0;

    for (let off = 0; off + 512 <= vds.length; off += blockSize) {
      const tagId = u16(vds, off);
      if (tagId === 8) break; // Terminating Descriptor
      if (tagId === 5) { // Partition Descriptor
        partitionStart = u32(vds, off + 188);
      } else if (tagId === 6) { // Logical Volume Descriptor
        blockSize = u32(vds, off + 212);
        const numMaps = u32(vds, off + 268);
        let p = off + 440;
        for (let i = 0; i < numMaps; i++) { const len = vds[p + 1]; if (len < 4) break; p += len; }
        fsdLoc = u32(vds, p + 4);
        fsdPart = u16(vds, p + 14);
      }
    }
    if (fsdLoc < 0) return null;

    // File Set Descriptor -> root directory ICB
    const fsd = await read((partitionStart + fsdLoc) * blockSize, 2048);
    if (fsd.length < 416 || u16(fsd, 0) !== 256) return null;
    const rootLoc = u32(fsd, 404);   // logical block of root directory ICB
    const rootPart = u16(fsd, 412);

    return { blockSize, partitionStart, fsdLoc, fsdPart, rootLoc, rootPart };
  }

  // physical byte offset for a (logical block, partition) pair
  function phys(vol, loc) { return (vol.partitionStart + loc) * vol.blockSize; }

  // Parse a File Entry (ICB). Returns { isDir, size, extents:[{loc, len}] }.
  function parseFileEntry(bytes, blockSize) {
    const isDir = bytes[27] === 4;
    const size = u64(bytes, 56);
    const extents = [];
    // Allocation descriptors follow the Unique ID at offset 232.
    let off = 232;
    let remaining = size;
    while (remaining > 0 && off + 16 <= bytes.length) {
      const len = u32(bytes, off);
      const loc = u32(bytes, off + 4);
      if (len === 0 && loc === 0) break;
      extents.push({ loc, len });
      remaining -= len;
      off += 16;
    }
    return { isDir, size, extents };
  }

  // Parse File Identifier Descriptors from a directory's data.
  function parseFids(bytes) {
    const out = [];
    let p = 0;
    while (p + 38 <= bytes.length) {
      if (u16(bytes, p) !== 257) break; // not an FID
      const chars = bytes[p + 18];
      const lenFileId = bytes[p + 19];
      const lenImplUse = u16(bytes, p + 36);
      const icbLoc = u32(bytes, p + 24);
      const isDir = (chars & 0x02) !== 0;
      const name = dstring(bytes.subarray(p + 38 + lenImplUse, p + 38 + lenImplUse + lenFileId));
      if (name && name !== '.' && name !== '..') {
        out.push({ name, isDir, loc: icbLoc });
      }
      const total = 38 + lenImplUse + lenFileId;
      p += total + ((4 - (total % 4)) % 4); // 4-byte alignment
    }
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
    return out;
  }

  // Read a directory's data (concatenate its extents).
  async function readDirData(read, vol, fe) {
    const chunks = [];
    let total = 0;
    for (const e of fe.extents) {
      if (total >= fe.size) break;
      const want = Math.min(e.len, fe.size - total);
      const data = await read(phys(vol, e.loc), want);
      chunks.push(data);
      total += data.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // Read a directory and return its sorted entries (with per-file info).
  async function readDir(read, vol, loc) {
    const feBytes = await read(phys(vol, loc), vol.blockSize);
    const fe = parseFileEntry(feBytes, vol.blockSize);
    const data = await readDirData(read, vol, fe);
    const entries = [];
    for (const f of parseFids(data)) {
      if (f.isDir) {
        entries.push({ name: f.name, isDir: true, loc: f.loc, size: 0, extents: [] });
      } else {
        const childFe = await read(phys(vol, f.loc), vol.blockSize);
        const cfe = parseFileEntry(childFe, vol.blockSize);
        entries.push({ name: f.name, isDir: false, loc: f.loc, size: cfe.size, extents: cfe.extents });
      }
    }
    return entries;
  }

  // Recursively yield { path, name, isDir, size, extents } entries in BFS order.
  async function* catalogEntries(read, vol) {
    const queue = [{ loc: vol.rootLoc, path: '' }];
    while (queue.length) {
      const dir = queue.shift();
      const feBytes = await read(phys(vol, dir.loc), vol.blockSize);
      const fe = parseFileEntry(feBytes, vol.blockSize);
      const data = await readDirData(read, vol, fe);
      for (const f of parseFids(data)) {
        const path = dir.path === '' ? '/' + f.name : dir.path + '/' + f.name;
        if (f.isDir) {
          yield { name: f.name, path, isDir: true, size: 0, extents: [] };
          queue.push({ loc: f.loc, path });
        } else {
          const childFe = await read(phys(vol, f.loc), vol.blockSize);
          const cfe = parseFileEntry(childFe, vol.blockSize);
          yield { name: f.name, path, isDir: false, size: cfe.size, extents: cfe.extents };
        }
      }
    }
  }

  // Read a file's data fork by concatenating its extents.
  async function readFile(read, vol, node) {
    const out = new Uint8Array(node.size);
    let off = 0;
    for (const e of node.extents) {
      if (off >= node.size) break;
      const want = Math.min(e.len, node.size - off);
      const data = await read(phys(vol, e.loc), want);
      out.set(data, off);
      off += data.length;
    }
    return out;
  }

  global.UDF = { detect, catalogEntries, readFile, readDir };
})(typeof globalThis !== 'undefined' ? globalThis : self);
