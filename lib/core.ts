// Core: SHA-1 object model (blob/tree/commit/tag), an in-memory forge store, and diff helpers.
// Everything here is pure data handling; the HTTP surfaces live in rest.ts / git.ts / mcp.ts.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** sha1("type <len>\0" + data), as git computes it. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function unb64(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const mode = data.subarray(i, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
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
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '');
  const message = info.message.endsWith('\n') ? info.message : `${info.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
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

// ------------------------------------------------------------------ store

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: number;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  user: string;
  createdAt: number;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, string>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export class Forge {
  repos = new Map<string, Repo>();
  clock = 1735689600;

  /** A monotonically increasing "now", so ordering never ties. */
  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  get(owner: string, name: string): Repo | null {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  create(owner: string, name: string, options: { private?: boolean; description?: string; defaultBranch?: string } = {}): Repo {
    const existing = this.get(owner, name);
    if (existing) return existing;
    const repo: Repo = {
      owner,
      name,
      private: options.private !== false,
      description: options.description ?? '',
      defaultBranch: options.defaultBranch ?? 'main',
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 0,
      nextPull: 0,
      nextComment: 0,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  /** Owners see only their own repositories: another login's name is a 404, never a 403. */
  owned(owner: string, name: string, viewer: string): Repo | null {
    if (owner.toLowerCase() !== viewer.toLowerCase()) return null;
    return this.get(owner, name);
  }

  list(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }
}

// ------------------------------------------------------------------ object helpers

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function readObject(repo: Repo, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

/** Peel a tag object down to the commit it names (one level is all git tags need here). */
export function peel(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 8; guard += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    const tag = parseTag(object.data);
    if (!tag.object) return current;
    current = tag.object;
  }
  return current;
}

/** Walk ancestors of `tip` (newest first), stopping at `stop` when given. */
export function ancestors(repo: Repo, tip: string, stop?: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [tip];
  while (stack.length) {
    const oid = stack.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (stop && stop.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    let commitOid = oid;
    if (object.type === 'tag') commitOid = peel(repo, oid);
    const commitObject = repo.objects.get(commitOid);
    if (!commitObject || commitObject.type !== 'commit') continue;
    out.push(commitOid);
    const info = parseCommit(commitObject.data);
    for (const parent of info.parents) if (!seen.has(parent)) stack.push(parent);
  }
  return out;
}

/** Every object reachable from `tips` (commits, trees, blobs, tags). */
export function reachable(repo: Repo, tips: Iterable<string>, stopAt?: Set<string>, maxDepth?: number): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 0 });
  while (queue.length) {
    const item = queue.shift() as { oid: string; depth: number };
    if (seen.has(item.oid)) continue;
    const object = repo.objects.get(item.oid);
    if (!object) continue;
    seen.add(item.oid);
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.object) queue.push({ oid: tag.object, depth: item.depth });
      continue;
    }
    if (object.type === 'commit') {
      if (stopAt && stopAt.has(item.oid)) continue;
      const info = parseCommit(object.data);
      queue.push({ oid: info.tree, depth: item.depth });
      if (maxDepth === undefined || item.depth + 1 < maxDepth) {
        for (const parent of info.parents) queue.push({ oid: parent, depth: item.depth + 1 });
      } else {
        // Depth boundary: the parent commits stay out, so their ids are not pulled in.
        for (const parent of info.parents) {
          if (seen.has(parent)) continue;
          // mark the boundary so shallow-info can name it
          boundary.push(parent);
        }
      }
      continue;
    }
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push({ oid: entry.oid, depth: item.depth });
    }
  }
  return seen;
}

/** Commits at each depth from a tip, for shallow handling. */
export function commitsAtDepth(repo: Repo, tip: string, maxDepth: number): { included: string[]; boundary: string[] } {
  const included: string[] = [];
  const boundary: string[] = [];
  const seen = new Set<string>();
  let frontier = [tip];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      const commitOid = object.type === 'tag' ? peel(repo, oid) : oid;
      const commitObject = repo.objects.get(commitOid);
      if (!commitObject || commitObject.type !== 'commit') continue;
      seen.add(commitOid);
      included.push(commitOid);
      const info = parseCommit(commitObject.data);
      for (const parent of info.parents) if (!seen.has(parent)) next.push(parent);
    }
    if (depth === maxDepth - 1) for (const oid of next) if (!seen.has(oid)) boundary.push(oid);
    frontier = next;
  }
  return { included, boundary };
}

/** Every tree and blob under one commit's tree. */
export function treeClosure(repo: Repo, commitOid: string, out: Set<string>): void {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return;
  const info = parseCommit(object.data);
  const stack = [info.tree];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const node = repo.objects.get(oid);
    if (!node) continue;
    out.add(oid);
    if (node.type === 'tree') for (const entry of parseTree(node.data)) stack.push(entry.oid);
  }
}

// ------------------------------------------------------------------ working tree (path -> blob)

export type FileMap = Map<string, { mode: string; data: Buffer; oid: string }>;

/** Flatten a commit's tree into a path -> blob map. */
export function flatten(repo: Repo, commitOid: string | null): FileMap {
  const out: FileMap = new Map();
  if (!commitOid) return out;
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return out;
  const info = parseCommit(object.data);
  const walk = (treeOid: string, prefix: string): void => {
    const node = repo.objects.get(treeOid);
    if (!node || node.type !== 'tree') return;
    for (const entry of parseTree(node.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else {
        const blob = repo.objects.get(entry.oid);
        out.set(path, { mode: entry.mode, data: blob ? Buffer.from(blob.data) : Buffer.alloc(0), oid: entry.oid });
      }
    }
  };
  walk(info.tree, '');
  return out;
}

/** Write a commit whose tree is `files`; returns the commit oid. */
export function commitFiles(
  repo: Repo,
  files: FileMap,
  options: { parents: string[]; message: string; author: string; committer?: string; when?: number },
): string {
  const root = new Map<string, TreeEntry>();
  const dirTree = (prefix: string, entries: TreeEntry[]): string => putObject(repo, 'tree', buildTree(entries));
  // group by directory
  const dirs = new Map<string, TreeEntry[]>();
  for (const [path, file] of files) {
    const parts = path.split('/');
    const name = parts.pop() as string;
    const dir = parts.join('/');
    const list = dirs.get(dir) ?? [];
    list.push({ mode: file.mode, name, oid: putObject(repo, 'blob', file.data) });
    dirs.set(dir, list);
  }
  // build deepest first
  const dirList = [...dirs.keys()].filter((dir) => dir !== '').sort((a, b) => b.split('/').length - a.split('/').length);
  for (const dir of dirList) {
    const entries = dirs.get(dir) as TreeEntry[];
    const oid = dirTree(dir, entries);
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    const name = dir.slice(dir.lastIndexOf('/') + 1);
    const list = dirs.get(parent) ?? [];
    list.push({ mode: '40000', name, oid });
    dirs.set(parent, list);
  }
  const rootEntries = dirs.get('') ?? [];
  for (const entry of rootEntries) {
    if (entry.mode === '40000') root.set(entry.name, entry);
    else root.set(entry.name, entry);
  }
  for (const [name, entry] of root) void [name, entry];
  const treeOid = dirTree('', [...root.values()]);
  const when = options.when ?? Math.floor(Date.now() / 1000);
  const stamp = `${when} +0000`;
  const data = buildCommit({
    tree: treeOid,
    parents: options.parents,
    author: `${options.author} <${options.author.replace(/\s+/g, '')}@example.invalid> ${stamp}`,
    committer: `${options.committer ?? options.author} <${(options.committer ?? options.author).replace(/\s+/g, '')}@example.invalid> ${stamp}`,
    message: options.message,
  });
  return putObject(repo, 'commit', data);
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'removed';
  before: Buffer | null;
  after: Buffer | null;
}

export function diffFiles(before: FileMap, after: FileMap): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const [path, file] of after) {
    const old = before.get(path);
    if (!old) out.push({ path, status: 'added', before: null, after: file.data });
    else if (!old.data.equals(file.data)) out.push({ path, status: 'modified', before: old.data, after: file.data });
  }
  for (const [path, file] of before) {
    if (!after.has(path)) out.push({ path, status: 'removed', before: file.data, after: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export function lineCount(data: Buffer | null): number {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}
