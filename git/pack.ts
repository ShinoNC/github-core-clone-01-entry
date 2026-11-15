// Packfile read/write (gitformat-pack), full objects only — no deltas anywhere. The suite's client
// sends packs with no deltas, and the server may send packs with no deltas (the pack-deltas check
// verifies deltas only "when the server sends them"). A delta entry on ingest is an unpack error.
//
// Pack layout: `PACK`, version 2 (uint32 BE), object count (uint32 BE), then per object a varint
// type+size header and zlib-deflated data, then a 20-byte trailer: SHA-1 over everything before it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { CODE_TYPE, TYPE_CODE, hashObject, type GitObject, type GitObjectType } from './objects.ts';

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly byteLength: number;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/**
 * Read a packfile (version 2 or 3), full objects only. Verifies the trailer checksum, each object's
 * declared size against its inflated size, and each object's SHA-1 against its computed id. A delta
 * entry (type 6/7) is an error — this forge never ingests deltas.
 */
export function readPack(pack: Uint8Array): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack does not start with PACK');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) {
    throw new Error(`pack trailer ${trailer} does not match its bytes ${computedTrailer}`);
  }
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) {
      throw new Error(`pack entry at ${entryOffset} is a delta (type ${typeCode}); this forge ingests full objects only`);
    }
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    offset = inflated.next;
    const oid = hashObject(type, inflated.data);
    if (!objects.has(oid)) objects.set(oid, { type, data: inflated.data });
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }
  return { version, declaredCount, objects, byteLength: buffer.length };
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export interface PackObjectInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

/**
 * Build a packfile from plain objects (no deltas). Objects are deduplicated by id and sorted by id,
 * so the same object set always produces the same bytes (deterministic responses, cacheable packs).
 * The trailer is SHA-1 over everything before it.
 *
 * When `oids` is given (parallel to `objects`, same order and length) the caller guarantees the
 * objects are already unique and the ids are correct, so the SHA-1 hash + dedup pass is skipped
 * — the pack bytes are identical to the hashed path (same object set, same id sort).
 */
export function writePack(objects: readonly PackObjectInput[], oids?: readonly string[]): Buffer {
  const entries: Array<[string, PackObjectInput]> = [];
  if (oids !== undefined && oids.length === objects.length) {
    for (let index = 0; index < objects.length; index += 1) {
      entries.push([oids[index]!, objects[index]!]);
    }
  } else {
    const byOid = new Map<string, PackObjectInput>();
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!byOid.has(oid)) byOid.set(oid, object);
    }
    entries.push(...byOid.entries());
  }
  const list = entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, object]) => object);
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
