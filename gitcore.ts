// Git object model, pkt-line framing and packfiles, implemented from the git
// wire format (the suite's git-client.ts is the authority on what the other
// end sends and accepts). No git binary, no dependencies: node:crypto for
// SHA-1 and node:zlib for deflate/inflate.

import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly bytes: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of an object: SHA-1 of "<type> <size>\0" + raw bytes. */
export function hashObject(type: ObjectType, bytes: Buffer): string {
  const header = Buffer.from(`${type} ${bytes.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, bytes]));
}

export function makeObject(type: ObjectType, bytes: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, bytes), object: { type, bytes } };
}

// ---------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

const PKT_MAX = 65520;

/** One pkt-line: 4 hex digits of (payload length + 4), then the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error(`pkt-line payload too large: ${data.length}`);
  const head = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const pktFlush: Buffer = Buffer.from('0000', 'ascii');
export const pktDelim: Buffer = Buffer.from('0001', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 3) throw new Error('pkt-line length 0003 is invalid');
    if (len < 4 || pos + len > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(pos + 4, pos + len)) });
    pos += len;
  }
  return out;
}

/** Split a buffer into data lines (strings, trailing \n kept) up to the first flush. */
export function pktDataLines(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(buf)) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Encode a type/size varint header (first byte: size low 4 bits, type, cont). */
function encodeTypeSize(type: ObjectType, size: number): Buffer {
  const typeNum = TYPE_NUMBERS[type];
  const bytes: number[] = [];
  let b = (typeNum << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    b |= 0x80;
    bytes.push(b);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

/** Write a packfile (version 2, no deltas) from objects in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const obj of objects) {
    chunks.push(encodeTypeSize(obj.type, obj.bytes.length));
    chunks.push(zlibDeflate(obj.bytes));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A pack entry header: type, size, and where the data starts. */
interface PackEntryHeader {
  type: number;
  size: number;
  dataStart: number;
}

function readTypeSize(buf: Buffer, pos: number): { header: PackEntryHeader; next: number } {
  let byte = buf[pos];
  if (byte === undefined) throw new Error('truncated pack entry header');
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let next = pos + 1;
  while (byte & 0x80) {
    byte = buf[next];
    if (byte === undefined) throw new Error('truncated pack entry size');
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
    if (shift > 64) throw new Error('pack entry size varint too long');
  }
  return { header: { type, size, dataStart: next }, next };
}

/** Decode an ofs-delta offset varint (git's ((v+1)*128 + b) form). */
function readOfsOffset(buf: Buffer, pos: number): { value: number; next: number } {
  let byte = buf[pos];
  if (byte === undefined) throw new Error('truncated ofs-delta offset');
  let value = byte & 0x7f;
  let next = pos + 1;
  while (byte & 0x80) {
    byte = buf[next];
    if (byte === undefined) throw new Error('truncated ofs-delta offset');
    value = ((value + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { value, next };
}

/** Read one delta varint (7 bits per byte, little-endian groups). */
function readDeltaVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = pos;
  for (;;) {
    const byte = buf[next];
    if (byte === undefined) throw new Error('truncated delta varint');
    next += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return { value, next };
}

/** Apply a delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readDeltaVarint(delta, pos);
  pos = src.next;
  if (src.value !== base.length) throw new Error('delta source size does not match base');
  const tgt = readDeltaVarint(delta, pos);
  pos = tgt.next;
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op === 0) throw new Error('delta opcode 0 is invalid');
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          const b = delta[pos];
          if (b === undefined) throw new Error('truncated delta copy offset');
          offset |= b << (i * 8);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          const b = delta[pos];
          if (b === undefined) throw new Error('truncated delta copy size');
          size |= b << (i * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past base');
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else {
      const size = op & 0x7f;
      if (pos + size > delta.length) throw new Error('truncated delta literal');
      out.push(delta.subarray(pos, pos + size));
      pos += size;
      produced += size;
    }
  }
  if (produced !== tgt.value) throw new Error('delta output size does not match target');
  return Buffer.concat(out);
}

export interface ReadPackResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/**
 * Parse a packfile. Deltas resolve against earlier pack entries and, when
 * given, objects the receiving side already holds (thin packs). The end of
 * each zlib stream comes from inflateSync's `info` result, which reports
 * exactly how many input bytes the stream consumed.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): ReadPackResult {
  if (pack.length < 32) throw new Error('pack too small');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack magic is not PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const actual = sha1(pack.subarray(0, pack.length - 20));
  if (actual !== trailer.toString('hex')) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; object: GitObject }>();
  let deltaCount = 0;
  let pos = 12;
  interface Pending {
    offset: number;
    size: number;
    kind: 'plain' | 'ofs' | 'ref';
    type?: ObjectType;
    baseOffset?: number;
    baseOid?: string;
    raw: Buffer;
  }
  const pending: Pending[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    const { header, next } = readTypeSize(pack, pos);
    pos = next;
    let kind: Pending['kind'] = 'plain';
    let type: ObjectType | undefined;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (header.type >= 1 && header.type <= 4) {
      type = TYPE_CODES[header.type];
    } else if (header.type === 6) {
      kind = 'ofs';
      const ofs = readOfsOffset(pack, pos);
      pos = ofs.next;
      baseOffset = entryStart - ofs.value;
      if (baseOffset < 0) throw new Error('ofs-delta base offset out of range');
    } else if (header.type === 7) {
      kind = 'ref';
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else {
      throw new Error(`unknown pack entry type ${header.type}`);
    }
    const dataStart = pos;
    const inflated = zlibInflate(pack.subarray(dataStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry inflated size mismatch');
    if (!inflated.engine.bytesWritten || inflated.engine.bytesWritten <= 0) {
      throw new Error('pack entry zlib stream consumed no bytes');
    }
    pos = dataStart + inflated.engine.bytesWritten;
    pending.push({ offset: entryStart, size: header.size, kind, type, baseOffset, baseOid, raw: inflated.buffer });
  }
  if (pos !== pack.length - 20) throw new Error('pack has trailing bytes before the trailer');
  const resolve = (entry: Pending): GitObject => {
    if (entry.kind === 'plain') {
      const object: GitObject = { type: entry.type as ObjectType, bytes: entry.raw };
      const oid = hashObject(object.type, object.bytes);
      objects.set(oid, object);
      byOffset.set(entry.offset, { oid, object });
      return object;
    }
    deltaCount += 1;
    let base: GitObject | undefined;
    if (entry.kind === 'ofs') {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry) base = baseEntry.object;
    } else {
      const oid = entry.baseOid as string;
      base = objects.get(oid) ?? resolveBase?.(oid);
    }
    if (!base) throw new Error('delta base object is missing');
    const bytes = applyDelta(base.bytes, entry.raw);
    const object: GitObject = { type: base.type, bytes };
    const oid = hashObject(object.type, object.bytes);
    objects.set(oid, object);
    byOffset.set(entry.offset, { oid, object });
    return object;
  };
  for (const entry of pending) {
    if (entry.kind === 'plain') resolve(entry);
  }
  for (const entry of pending) {
    if (entry.kind !== 'plain' && !byOffset.has(entry.offset)) resolve(entry);
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------- commits / trees

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(bytes: Buffer): ParsedCommit {
  const text = bytes.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('commit has no valid tree');
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  let out = `tree ${tree}\n`;
  for (const parent of parents) out += `parent ${parent}\n`;
  out += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(out, 'utf8');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const space = bytes.indexOf(0x20, pos);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = bytes.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    const mode = bytes.subarray(pos, space).toString('ascii');
    const name = bytes.subarray(space + 1, nul).toString('utf8');
    if (!/^[0-7]+$/.test(mode)) throw new Error('tree entry mode is not octal');
    if (nul + 21 > bytes.length) throw new Error('tree entry oid is truncated');
    entries.push({ mode, name, oid: bytes.subarray(nul + 1, nul + 21).toString('hex') });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag object. */
export function parseTag(bytes: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = bytes.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}
