/*
 * aif.js — Aaru Image Format (AIF / .aaruf) container reader for the browser.
 *
 * AIF is a block-based disk-image container. It does NOT define a filesystem;
 * it stores raw sectors (typically ISO 9660 or HFS). This module parses the
 * container and exposes a random-access readSector(lba) so the existing
 * ISO/HFS parsers can browse the filesystem inside.
 *
 * On-disk layout (all integers little-endian):
 *
 *   offset 0        AaruHeader (v1, 104 bytes) or AaruHeaderV2 (v2, 147 bytes)
 *                     - identifier  = "AARUFRMT"
 *                     - indexOffset = absolute offset of the index block
 *   indexOffset     IndexBlock ("INDX"/"IDX2"/"IDX3") = a directory of blocks
 *                     - each IndexEntry { blockType, dataType, offset }
 *   (indexed)       DeDuplicationTable2 ("DDT2") maps logical LBA -> data block
 *   (indexed)       DataBlock ("DBLK") = BlockHeader + compressed payload
 *
 * readSector(lba) flow:
 *   1. I = lba + ddt.negative
 *   2. entryIndex = I (single-level DDT, tableShift == 0)
 *   3. E = ddt entry[entryIndex] (u64)
 *   4. base = E & 0x0FFFFFFFFFFFFFFF
 *      blockIndex = base >> dataShift
 *      sectorInBlock = base & ((1 << dataShift) - 1)
 *      blockOffset = blockIndex << blockAlignmentShift
 *   5. read BlockHeader at blockOffset, decompress payload, return
 *      sector[sectorInBlock * sectorSize .. + sectorSize]
 *
 * Compression codecs are pluggable: by default only "None" is supported; call
 * AIF.setCodec() with a { decompress(compression, data, uncompressedLength) }
 * function to enable LZMA / Zstd (needs a WASM codec — browser
 * DecompressionStream only does gzip/deflate/brotli).
 *
 * Usage:
 *   const reader = await AIF.open(read);   // read(start, length) -> Promise<Uint8Array>
 *   const sector = await reader.readSector(16);  // bytes of logical sector 16
 *   console.log(reader.sectorSize, reader.sectorCount);
 */
(function (global) {
  'use strict';

  // ---- little-endian readers ----

  function rdU8(d, o) { return d[o]; }

  function rdU16(d, o) { return d[o] | (d[o + 1] << 8); }

  function rdU32(d, o) {
    return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  }

  // NOTE: JS Numbers lose precision above 2^53. File offsets in real images are
  // well below that, so this is acceptable for a browser reader.
  function rdU64(d, o) {
    const lo = rdU32(d, o);
    const hi = rdU32(d, o + 4);
    return hi * 0x100000000 + lo;
  }

  // BigInt reader for 64-bit fields that can exceed 2^53 (DDT entries pack a
  // 4-bit status above a 60-bit block/sector pointer).
  function rdU64Big(d, o) {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
    return v;
  }

  function ascii(d, o, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(d[o + i]);
    return s;
  }

  // ---- on-disk identifiers ----

  var MAGIC = 'AARUFRMT';

  var BLOCK_TYPE = {
    DataBlock: 'DBLK',
    Ddt1: 'DDT*',
    Ddt2: 'DDT2',
    DdtSecondary: 'DDTS',
    Index1: 'INDX',
    Index2: 'IDX2',
    Index3: 'IDX3',
    Metadata: 'META'
  };

  var COMPRESSION = {
    None: 0,
    Lzma: 1,
    Flac: 2,
    LzmaCst: 3,
    Zstd: 4,
    ZstdCst: 5
  };

  var DATA_TYPE = { UserData: 1 };

  // ---- pluggable decompression ----

  var codec = {
    decompress: function (compression, data, uncompressedLength) {
      if (compression === COMPRESSION.None) return Promise.resolve(data);
      if (compression === COMPRESSION.Lzma) {
        var Lzma1 = (typeof globalThis !== 'undefined' ? globalThis : self).Lzma1;
        if (!Lzma1 || !Lzma1.decompressRawLzma1) {
          return Promise.reject(new Error('LZMA codec not loaded (load lzma1.bundle.js first)'));
        }
        try {
          var p = data[0];
          var lc = p % 9, lp = Math.floor((p - lc) / 9) % 5, pb = Math.floor((p - lc) / 9 / 5);
          var dictSize = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
          var out = Lzma1.decompressRawLzma1(data.subarray(5), {
            lc: lc, lp: lp, pb: pb, dictSize: dictSize, uncompressedSize: uncompressedLength
          });
          return Promise.resolve(out);
        } catch (e) {
          return Promise.reject(e);
        }
      }
      return Promise.reject(new Error('AIF compression type ' + compression + ' not supported'));
    }
  };

  // ---- header parsing ----

  function parseHeader(bytes) {
    if (bytes.length < 104 || ascii(bytes, 0, 8) !== MAGIC) {
      throw new Error('Not an Aaru image (bad magic)');
    }
    var imageMajorVersion = rdU8(bytes, 72);
    var imageMinorVersion = rdU8(bytes, 73);
    var indexOffset = rdU64(bytes, 80);

    var h = {
      imageMajorVersion: imageMajorVersion,
      imageMinorVersion: imageMinorVersion,
      indexOffset: indexOffset
    };

    if (imageMajorVersion >= 2 && bytes.length >= 147) {
      h.blockAlignmentShift = rdU8(bytes, 120);
      h.biggestSectorSize = rdU16(bytes, 121);
    }

    if (!h.indexOffset) throw new Error('Aaru image has no index (indexOffset == 0)');
    return h;
  }

  // ---- index parsing ----

  // Returns { entries: [ { blockType, dataType, offset } ] }
  function parseIndex(bytes) {
    var id = ascii(bytes, 0, 4);
    var entriesCount;
    var headerSize;

    if (id === BLOCK_TYPE.Index1) {
      entriesCount = rdU16(bytes, 4);
      headerSize = 14;
    } else if (id === BLOCK_TYPE.Index2) {
      entriesCount = rdU64(bytes, 4);
      headerSize = 20;
    } else if (id === BLOCK_TYPE.Index3) {
      entriesCount = rdU64(bytes, 4);
      headerSize = 28;
    } else {
      throw new Error('Unknown index block identifier: ' + JSON.stringify(id));
    }

    var entries = [];
    for (var i = 0; i < entriesCount; i++) {
      var o = headerSize + i * 14;
      entries.push({
        blockType: ascii(bytes, o, 4),
        dataType: rdU16(bytes, o + 4),
        offset: rdU64(bytes, o + 6)
      });
    }
    return { entries: entries };
  }

  // ---- DDT parsing (v2, the common case) ----

  function parseDdtHeader2(bytes) {
    return {
      id: ascii(bytes, 0, 4),
      type: rdU16(bytes, 4),
      compression: rdU16(bytes, 6),
      levels: rdU8(bytes, 8),
      tableLevel: rdU8(bytes, 9),
      previousLevelOffset: rdU64(bytes, 10),
      negative: rdU32(bytes, 18),
      blocks: rdU64(bytes, 22),
      overflow: rdU32(bytes, 30),
      blockAlignmentShift: rdU8(bytes, 42),
      dataShift: rdU8(bytes, 43),
      tableShift: rdU8(bytes, 44),
      entries: rdU64(bytes, 45),
      cmpLength: rdU64(bytes, 53),
      length: rdU64(bytes, 61)
    };
  }

  // Decode one DDT entry (u64 BigInt) into { blockOffset, sectorInBlock, dumped }.
  // Bits 63-60 = sector status, bits 59-0 = (blockIndex << dataShift) | sectorInBlock.
  function decodeDdtEntry(E, ddt) {
    if (E === 0n) return { blockOffset: 0, sectorInBlock: 0, dumped: false };
    const base = E & 0x0FFFFFFFFFFFFFFFn;
    const mask = (1n << BigInt(ddt.dataShift)) - 1n;
    const sectorInBlock = Number(base & mask);
    const blockIndex = base >> BigInt(ddt.dataShift);
    const blockOffset = Number(blockIndex << BigInt(ddt.blockAlignmentShift));
    return { blockOffset: blockOffset, sectorInBlock: sectorInBlock, dumped: true };
  }

  // ---- data block ----

  function parseBlockHeader(bytes) {
    return {
      id: ascii(bytes, 0, 4),
      type: rdU16(bytes, 4),
      compression: rdU16(bytes, 6),
      sectorSize: rdU32(bytes, 8),
      cmpLength: rdU32(bytes, 12),
      length: rdU32(bytes, 16)
    };
  }

  // ---- main open ----

  // read(start, length) -> Promise<Uint8Array>
  async function open(read) {
    var headerBytes = await read(0, 147);
    var header = parseHeader(headerBytes);

    // Read the index header to learn the entry count, then read the whole index.
    var indexHeaderBytes = await read(header.indexOffset, 28);
    var idxId = ascii(indexHeaderBytes, 0, 4);
    var idxHeaderSize, idxEntryCount;
    if (idxId === BLOCK_TYPE.Index1) { idxHeaderSize = 14; idxEntryCount = rdU16(indexHeaderBytes, 4); }
    else if (idxId === BLOCK_TYPE.Index2) { idxHeaderSize = 20; idxEntryCount = rdU64(indexHeaderBytes, 4); }
    else if (idxId === BLOCK_TYPE.Index3) { idxHeaderSize = 28; idxEntryCount = rdU64(indexHeaderBytes, 4); }
    else throw new Error('Unknown index block identifier: ' + JSON.stringify(idxId));
    var indexBytes = await read(header.indexOffset, idxHeaderSize + idxEntryCount * 14);
    var index = parseIndex(indexBytes);

    // Locate the user-data DDT block.
    var ddtEntry = null;
    for (var i = 0; i < index.entries.length; i++) {
      var e = index.entries[i];
      if ((e.blockType === BLOCK_TYPE.Ddt2 || e.blockType === BLOCK_TYPE.Ddt1) &&
          e.dataType === DATA_TYPE.UserData) {
        ddtEntry = e;
        break;
      }
    }
    if (!ddtEntry) throw new Error('Aaru image has no user-data DDT block');

    var ddtHeaderBytes = await read(ddtEntry.offset, 85);

    var ddt;
    if (ddtEntry.blockType === BLOCK_TYPE.Ddt2) {
      var h2 = parseDdtHeader2(ddtHeaderBytes);
      if (h2.id !== BLOCK_TYPE.Ddt2) throw new Error('Bad DDT2 identifier');
      if (h2.tableShift !== 0) {
        throw new Error('Multi-level DDT (tableShift != 0) not implemented yet');
      }
      // Read the compressed entries payload (its exact size is in the header).
      var ddtPayload = await read(ddtEntry.offset + 85, h2.cmpLength);
      var bodyComp = await codec.decompress(h2.compression, ddtPayload, h2.length);
      ddt = { version: 2, header: h2, entries: bodyComp };
    } else {
      throw new Error('DDT v1 not implemented yet');
    }

    var sectorSize = header.biggestSectorSize || 2048;
    var blockCache = new Map(); // blockOffset -> decompressed payload

    async function readSector(lba) {
      if (!ddt || ddt.version !== 2) throw new Error('DDT v2 not loaded');
      var h = ddt.header;
      var I = lba + h.negative;
      if (I < 0 || I >= h.entries) {
        throw new Error('Sector ' + lba + ' out of range');
      }
      var entryOffset = I * 8;
      var E = rdU64Big(ddt.entries, entryOffset);
      var dec = decodeDdtEntry(E, h);
      if (!dec.dumped) {
        return null; // sector not dumped
      }

      // Read the block header, then its payload.
      var bhBytes = await read(dec.blockOffset, 36);
      var bh = parseBlockHeader(bhBytes);
      if (bh.id !== BLOCK_TYPE.DataBlock) {
        throw new Error('DDT entry points to non-data block at ' + dec.blockOffset);
      }

      var payload = blockCache.get(dec.blockOffset);
      if (!payload) {
        payload = await codec.decompress(
          bh.compression,
          await read(dec.blockOffset + 36, bh.cmpLength),
          bh.length
        );
        blockCache.set(dec.blockOffset, payload);
      }

      var sectorBytes = bh.sectorSize || sectorSize;
      var start = dec.sectorInBlock * sectorBytes;
      if (start + sectorBytes > payload.length) {
        throw new Error('Sector beyond decompressed block payload');
      }
      return payload.subarray(start, start + sectorBytes);
    }

    return {
      header: header,
      index: index,
      ddt: ddt,
      sectorSize: sectorSize,
      // logical user-data sectors (external LBA 0 .. this-1)
      sectorCount: ddt.header.blocks - ddt.header.negative - ddt.header.overflow,
      readSector: readSector
    };
  }

  // ---- public API ----

  global.AIF = {
    open: open,
    setCodec: function (c) { codec = c; },
    COMPRESSION: COMPRESSION,
    BLOCK_TYPE: BLOCK_TYPE
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));
