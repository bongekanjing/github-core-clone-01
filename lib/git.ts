// Git smart HTTP v0/v2: info/refs advertisements, upload-pack (ls-refs + fetch), receive-pack.
// Everything is served from the in-memory Forge in core.ts; the wire format is spelled out in
// sdk/conformance/git-client.ts, which is what the suite drives us with.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  type CommitInfo,
  type FileMap,
  type GitObject,
  type ObjType,
  type Repo,
  ZERO_OID,
  ancestors,
  buildTree,
  commitsAtDepth,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  peel,
  putObject,
  reachable,
  readObject,
  treeClosure,
} from './core.ts';

export const PKT_MAX = 65520;

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_MAX) throw new Error(`pkt-line payload ${body.length} exceeds the maximum`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a pkt-line stream. Trailing partial data is ignored (a client may append a pack). */
export function decodePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

// ------------------------------------------------------------------ packs

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(type: ObjType, size: number): Buffer {
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

/** A packfile of whole objects (no deltas), trailer included. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buffer: Buffer, start: number): { value: number; first: number; next: number } {
  let byte = buffer[start];
  const first = byte;
  let value = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    offset += 1;
  }
  return { value, first, next: offset };
}

function readOfsBase(buffer: Buffer, start: number): { distance: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readSize();
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  return out;
}

/** Index a pushed pack into `repo.objects`. Returns the oids it added. */
export function indexPack(repo: Repo, pack: Buffer): string[] {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const trailerStart = pack.length - 20;
  const declared = pack.readUInt32BE(8);
  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.distance;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const added: string[] = [];
  const resolvedByOid = new Map<string, { type: ObjType; data: Buffer }>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: ObjType; data: Buffer } => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pushed pack');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset as number);
      if (!base) throw new Error('ofs-delta base missing from the pushed pack');
      const resolved = resolve(base);
      type = resolved.type;
      data = applyDelta(resolved.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const inPack = resolvedByOid.get(wanted);
      if (inPack) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else {
        const existing = repo.objects.get(wanted);
        if (!existing) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the repository`);
        type = existing.type;
        data = applyDelta(existing.data, entry.data);
      }
    } else {
      const named = CODE_TYPE[entry.typeCode];
      if (!named) throw new Error(`pack entry has unknown type code ${entry.typeCode}`);
      type = named;
      data = entry.data;
    }
    resolving.delete(entry.offset);
    const oid = hashObject(type, data);
    resolvedByOid.set(oid, { type, data });
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      added.push(oid);
    }
    return { type, data };
  };
  for (const entry of raw) resolve(entry);
  return added;
}

// ------------------------------------------------------------------ refs

export interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
  unborn?: boolean;
}

/** Every ref a client may see, plus HEAD, sorted the way git sorts them. */
export function advertise(repo: Repo): AdvertisedRef[] {
  const out: AdvertisedRef[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: AdvertisedRef = { name, oid };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') entry.peeled = peel(repo, oid);
    out.push(entry);
  }
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) out.unshift({ name: 'HEAD', oid: headOid });
  else out.unshift({ name: 'HEAD', oid: ZERO_OID, unborn: true });
  return out;
}

const V2_CAPABILITIES = [
  'version 2',
  'agent=makefun-forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
  'server-option',
  'object-format=sha1',
];

const RECEIVE_CAPABILITIES = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=makefun-forge/1.0'];
const UPLOAD_V0_CAPABILITIES = ['multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', 'agent=makefun-forge/1.0'];

const SERVICE_OF: Record<string, string> = {
  upload: 'git-upload-pack',
  receive: 'git-receive-pack',
};

/** The `info/refs` body for one service; `v2` only applies to upload-pack. */
export function advertisementBody(repo: Repo, service: 'upload' | 'receive', v2: boolean): Buffer {
  const name = SERVICE_OF[service];
  const parts: Buffer[] = [pkt(`# service=${name}\n`), FLUSH];
  const refs = advertise(repo);
  if (v2 && service === 'upload') {
    for (const capability of V2_CAPABILITIES) parts.push(pkt(`${capability}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  if (refs.length === 1 && refs[0].unborn) {
    // An empty repository advertises the capabilities^{} pseudo-ref.
    const capabilities = service === 'receive' ? RECEIVE_CAPABILITIES : UPLOAD_V0_CAPABILITIES;
    const caps = service === 'receive' ? [...capabilities, 'symref=HEAD:refs/heads/' + repo.defaultBranch] : capabilities;
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps.join(' ')}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  let first = true;
  for (const ref of refs) {
    if (ref.unborn) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (first) {
      const capabilities =
        service === 'receive'
          ? [...RECEIVE_CAPABILITIES, `symref=HEAD:refs/heads/${repo.defaultBranch}`]
          : [...UPLOAD_V0_CAPABILITIES, `symref=HEAD:refs/heads/${repo.defaultBranch}`];
      line += `\u0000${capabilities.join(' ')}`;
      first = false;
    }
    parts.push(pkt(`${line}\n`));
    if (ref.peeled) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (v2)

export interface LsRefsRequest {
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

export function lsRefsResponse(repo: Repo, request: LsRefsRequest): Buffer {
  const name = repo.defaultBranch;
  const parts: Buffer[] = [];
  const matches = (refName: string): boolean => {
    if (request.prefixes.length === 0) return true;
    return request.prefixes.some((prefix) => refName.startsWith(prefix));
  };
  const headTarget = `refs/heads/${name}`;
  const headOid = repo.refs.get(headTarget);
  const wantHead = matches('HEAD');
  if (wantHead) {
    if (headOid) {
      let line = `${headOid} HEAD`;
      if (request.symrefs) line += ` symref-target:${headTarget}`;
      parts.push(pkt(`${line}\n`));
    } else if (request.unborn) {
      let line = `unborn HEAD`;
      if (request.symrefs) line += ` symref-target:${headTarget}`;
      parts.push(pkt(`${line}\n`));
    }
  }
  for (const ref of advertise(repo)) {
    if (ref.name === 'HEAD' || ref.unborn) continue;
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (request.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch (v2)

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/** Which commits a depth-limited walk from `tips` includes, and where it stops. */
function commitSet(repo: Repo, tips: string[], depth: number | null, stop: Set<string>): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 0 }));
  while (queue.length) {
    const item = queue.shift() as { oid: string; depth: number };
    const commitOid = peel(repo, item.oid);
    if (included.has(commitOid) || stop.has(commitOid)) continue;
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') continue;
    included.add(commitOid);
    const info = parseCommit(object.data);
    if (depth !== null && item.depth + 1 >= depth) {
      for (const parent of info.parents) if (!included.has(parent) && !stop.has(parent)) boundary.add(parent);
      continue;
    }
    for (const parent of info.parents) if (!included.has(parent)) queue.push({ oid: parent, depth: item.depth + 1 });
  }
  return { included, boundary };
}

/**
 * Decide what a fetch delivers: the commits reachable from `wants` within `depth`, minus everything
 * the client already holds (its `haves`, whose own history stops at its `shallow` boundary).
 * Only the newly-reachable commits and their trees/blobs travel.
 */
export function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const stop = new Set<string>();
  for (const have of request.haves) stop.add(peel(repo, have));
  // A have at the client's shallow boundary: stop there, do not walk past it.
  const wants = request.wants.length ? request.wants : [...repo.refs.values()];
  const { included, boundary } = commitSet(repo, wants, request.depth, new Set<string>());
  const deliver = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const clientShallow = new Set(request.shallow.map((oid) => peel(repo, oid)));
  for (const commitOid of included) {
    const already = stop.has(commitOid);
    if (already && !clientShallow.has(commitOid)) continue;
    if (already && clientShallow.has(commitOid)) {
      // Already held, but the client called it shallow: if we now include its parent, unshallow it.
      const info = parseCommit((repo.objects.get(commitOid) as GitObject).data);
      if (info.parents.some((parent) => included.has(parent))) unshallow.push(commitOid);
      else shallow.push(commitOid);
      continue;
    }
    deliver.add(commitOid);
    const info = parseCommit((repo.objects.get(commitOid) as GitObject).data);
    const cutParents = info.parents.filter((parent) => !included.has(parent));
    if (request.depth !== null) {
      if (cutParents.length) shallow.push(commitOid);
    } else if (clientShallow.has(commitOid) && info.parents.length && info.parents.every((parent) => !included.has(parent))) {
      shallow.push(commitOid);
    }
  }
  for (const got of boundary) if (deliver.has(got)) shallow.push(got);
  // A want may name an annotated tag: the tag object itself is not a commit, so commitSet peels past
  // it and it would never travel. Ship it (and it alone — its target commit still comes from the walk).
  const objectOids = new Set<string>(deliver);
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag' && !stop.has(want)) objectOids.add(want);
  }
  for (const commitOid of deliver) treeClosure(repo, commitOid, objectOids);
  // Everything the client already holds is on its disk byte for byte, so re-sending any of it is what
  // makes an incremental fetch carry objects nobody asked for. "Holds" stops at its shallow boundary:
  // a shallow client has the boundary commit but none of its history, which is exactly what a deepen
  // asks us to supply.
  const held = new Set<string>();
  const seen = new Set<string>();
  const stack = request.haves.map((have) => peel(repo, have));
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    held.add(oid);
    treeClosure(repo, oid, held);
    if (clientShallow.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  for (const oid of held) if (!deliver.has(oid)) objectOids.delete(oid);
  // A delivered commit always travels with its own tree and blobs, whatever the client already had.
  for (const commitOid of deliver) treeClosure(repo, commitOid, objectOids);
  const objects: GitObject[] = [];
  for (const oid of objectOids) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const acks: string[] = [];
  for (const have of request.haves) {
    const commitOid = peel(repo, have);
    if (included.has(commitOid)) acks.push(commitOid);
  }
  return { objects, shallow: [...new Set(shallow)], unshallow: [...new Set(unshallow)], acks };
}

/** A v2 fetch response: acknowledgments, shallow-info, then the packfile in sideband band 1. */
export function fetchResponse(plan: FetchPlan, request: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  if (request.haves.length || !request.done) {
    parts.push(pkt('acknowledgments\n'));
    if (plan.acks.length) {
      for (const oid of plan.acks) parts.push(pkt(`ACK ${oid}\n`));
      parts.push(pkt('ready\n'));
    } else {
      parts.push(pkt('NAK\n'));
    }
    parts.push(DELIM);
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  const pack = writePack(plan.objects);
  for (let offset = 0; offset < pack.length; offset += PKT_MAX - 5) {
    const chunk = pack.subarray(offset, Math.min(offset + PKT_MAX - 5, pack.length));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface RefReport {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Parse a receive-pack request body into its command list and (optional) pack. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer | null } {
  const { packets, rest } = decodePackets(body);
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    if (line.endsWith('\n')) line = line.slice(0, -1);
    if (first) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  let pack: Buffer | null = rest.length >= 12 ? rest : null;
  if (pack && pack.subarray(0, 4).toString('ascii') !== 'PACK') pack = null;
  return { commands, capabilities, pack };
}

/** Apply a push command list to the repository and return one report line per ref. */
export function applyPush(repo: Repo, commands: PushCommand[]): { reports: RefReport[]; unpackDetail: string } {
  const reports: RefReport[] = [];
  for (const command of commands) {
    const existing = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (!existing) {
        reports.push({ ref: command.ref, ok: false, reason: 'not-found' });
        continue;
      }
      if (command.oldOid !== existing && command.oldOid !== ZERO_OID) {
        reports.push({ ref: command.ref, ok: false, reason: 'stale-info' });
        continue;
      }
      repo.refs.delete(command.ref);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'missing-object' });
      continue;
    }
    if (existing) {
      if (command.oldOid !== existing) {
        reports.push({ ref: command.ref, ok: false, reason: 'stale-info' });
        continue;
      }
      // Fast-forward means the old tip is reachable from the new one, so walk the new commit's
      // history, not the old tip's.
      const reachableFromNew = new Set(ancestors(repo, command.newOid));
      if (!reachableFromNew.has(existing)) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    } else if (command.oldOid !== ZERO_OID) {
      reports.push({ ref: command.ref, ok: false, reason: 'stale-info' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { reports, unpackDetail: 'ok' };
}

/** The report-status stream, sideband-framed when the client asked for side-band-64k. */
export function receivePackResponse(reports: RefReport[], unpackDetail: string, sideband: boolean): Buffer {
  const lines: Buffer[] = [pkt(`unpack ${unpackDetail}\n`)];
  for (const report of reports) {
    lines.push(pkt(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  lines.push(FLUSH);
  const stream = Buffer.concat(lines);
  if (!sideband) return stream;
  const out: Buffer[] = [];
  for (let offset = 0; offset < stream.length; offset += PKT_MAX - 5) {
    const chunk = stream.subarray(offset, Math.min(offset + PKT_MAX - 5, stream.length));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ helper: commit from a file map

export function commitInfo(repo: Repo, oid: string): CommitInfo | null {
  const object = readObject(repo, peel(repo, oid));
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

export function treeEntriesOf(repo: Repo, commitOid: string): { mode: string; name: string; oid: string }[] {
  const info = commitInfo(repo, commitOid);
  if (!info) return [];
  const tree = readObject(repo, info.tree);
  if (!tree) return [];
  return parseTree(tree.data);
}
