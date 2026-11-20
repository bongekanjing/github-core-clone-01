// REST v3: repositories, branches, commits, contents, labels, issues, comments, pulls, merges.
// The shapes and statuses are dictated by sdk/conformance/checks-rest.ts, which drives this surface.

import { createHash } from 'node:crypto';
import {
  type Comment,
  type FileMap,
  type Forge,
  type GitObject,
  type Issue,
  type Pull,
  type Repo,
  ZERO_OID,
  buildCommit,
  buildTree,
  commitFiles,
  diffFiles,
  flatten,
  lineCount,
  parseCommit,
  parseTag,
  parseTree,
  peel,
  putObject,
  readObject,
} from './core.ts';

export interface Ctx {
  forge: Forge;
  viewer: string;
  url: URL;
  token: string | null;
  body: Buffer;
  method: string;
  segments: string[];
  headers: Record<string, string>;
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function message(status: number, text: string, headers: Record<string, string> = {}): Reply {
  return { status, body: { message: text }, headers };
}

function unauthorized(): Reply {
  return message(401, 'Requires authentication');
}

function notFound(): Reply {
  return message(404, 'Not Found');
}

export function jsonBody(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body.length === 0) return {};
  try {
    const value = JSON.parse(ctx.body.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function iso(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ------------------------------------------------------------------ serializers

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: 1 + Math.abs(hashNumeric(`${repo.owner}/${repo.name}`)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    archived: false,
    has_issues: true,
    has_wiki: false,
  };
}

function hashNumeric(text: string): number {
  const digest = createHash('sha1').update(text).digest();
  return digest.readUInt32BE(0) % 1_000_000;
}

function userJson(login: string): Record<string, unknown> {
  return { login, id: 1000 + (hashNumeric(login) % 9000), type: 'User', site_admin: false };
}

function labelJson(name: string, color = 'ededed'): Record<string, unknown> {
  return { name, color, description: '' };
}

function issueJson(issue: Issue, labels: Map<string, string>): Record<string, unknown> {
  return {
    id: 10_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(name, labels.get(name) ?? 'ededed')),
    user: userJson(issue.user),
    comments: issue.comments.length,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.createdAt),
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.user),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.createdAt),
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: 20_000 + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: repo.refs.get(`refs/heads/${pull.head}`) ?? ZERO_OID },
    base: { ref: pull.base, sha: repo.refs.get(`refs/heads/${pull.base}`) ?? ZERO_OID },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(pull.user),
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.createdAt),
  };
}

// ------------------------------------------------------------------ ancestry helpers

function parentMap(repo: Repo): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [oid, object] of repo.objects) {
    if (object.type !== 'commit') continue;
    out.set(oid, parseCommit(object.data).parents);
  }
  return out;
}

/** Commits reachable from `tip`, newest-first by commit time then insertion order. */
function historyOf(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [peel(repo, tip)];
  const order: string[] = [];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) if (!seen.has(parent)) stack.push(parent);
  }
  // newest first: order by commit timestamp descending, stable for ties
  out.push(...order);
  out.sort((a, b) => {
    const left = parseCommit((repo.objects.get(a) as GitObject).data);
    const right = parseCommit((repo.objects.get(b) as GitObject).data);
    const leftTime = Number(left.committer.split(' ').slice(-2)[0]);
    const rightTime = Number(right.committer.split(' ').slice(-2)[0]);
    if (leftTime !== rightTime) return rightTime - leftTime;
    return order.indexOf(a) - order.indexOf(b);
  });
  return out;
}

function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  return historyOf(repo, tip).includes(peel(repo, ancestor));
}

/** The best common ancestor: the deepest commit shared by both histories. */
function mergeBase(repo: Repo, left: string, right: string): string | null {
  const rightHistory = new Set(historyOf(repo, right));
  for (const oid of historyOf(repo, left)) if (rightHistory.has(oid)) return oid;
  return null;
}

// ------------------------------------------------------------------ tree helpers

function readTree(repo: Repo, oid: string): { mode: string; name: string; oid: string }[] {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

function lookupPath(repo: Repo, commitOid: string, path: string): { kind: 'file'; mode: string; blob: string } | { kind: 'dir'; tree: string } | null {
  const commit = repo.objects.get(peel(repo, commitOid));
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  const segments = path.split('/').filter((part) => part !== '');
  for (let index = 0; index < segments.length; index += 1) {
    const entries = readTree(repo, treeOid);
    const entry = entries.find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    const last = index === segments.length - 1;
    if (last) {
      if (entry.mode === '40000') return { kind: 'dir', tree: entry.oid };
      return { kind: 'file', mode: entry.mode, blob: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return { kind: 'dir', tree: treeOid };
}

/** Write `file` at `path` into the tree of `baseCommit` (or an empty tree), returning the new tree. */
function writePath(repo: Repo, baseCommit: string | null, path: string, mode: string, blob: string): string {
  const segments = path.split('/').filter((part) => part !== '');
  const fileName = segments.pop() as string;
  const baseTree = (() => {
    if (!baseCommit) return null;
    const commit = repo.objects.get(peel(repo, baseCommit));
    if (!commit || commit.type !== 'commit') return null;
    return parseCommit(commit.data).tree;
  })();
  const entriesAt = (treeOid: string | null): Map<string, { mode: string; name: string; oid: string }> => {
    const out = new Map<string, { mode: string; name: string; oid: string }>();
    if (!treeOid) return out;
    for (const entry of readTree(repo, treeOid)) out.set(entry.name, entry);
    return out;
  };
  const rebuild = (treeOid: string | null, depth: number): string => {
    const entries = entriesAt(treeOid);
    const name = segments[depth];
    if (depth === segments.length) {
      entries.set(fileName, { mode, name: fileName, oid: blob });
    } else {
      const child = entries.get(name);
      const childTree = child && child.mode === '40000' ? child.oid : null;
      const rebuilt = rebuild(childTree, depth + 1);
      entries.set(name, { mode: '40000', name, oid: rebuilt });
    }
    return putObject(repo, 'tree', buildTreeEntries([...entries.values()]));
  };
  return rebuild(baseTree, 0);
}

function removePath(repo: Repo, baseCommit: string, path: string): string | null {
  const segments = path.split('/').filter((part) => part !== '');
  const fileName = segments.pop() as string;
  const commit = repo.objects.get(peel(repo, baseCommit));
  if (!commit || commit.type !== 'commit') return null;
  const root = parseCommit(commit.data).tree;
  const rebuild = (treeOid: string, depth: number): string | null => {
    const entries = readTree(repo, treeOid).map((entry) => ({ ...entry }));
    if (depth === segments.length) {
      const filtered = entries.filter((entry) => entry.name !== fileName);
      if (filtered.length === entries.length) return null;
      if (filtered.length === 0) return null;
      return putObject(repo, 'tree', buildTreeEntries(filtered));
    }
    const name = segments[depth];
    const index = entries.findIndex((entry) => entry.name === name && entry.mode === '40000');
    if (index < 0) return null;
    const rebuilt = rebuild(entries[index].oid, depth + 1);
    if (rebuilt === null) entries.splice(index, 1);
    else entries[index] = { ...entries[index], oid: rebuilt };
    return putObject(repo, 'tree', buildTreeEntries(entries));
  };
  return rebuild(root, 0);
}

function buildTreeEntries(entries: { mode: string; name: string; oid: string }[]): Buffer {
  return buildTree(entries);
}

// ------------------------------------------------------------------ commits

function identity(login: string, when: number): { author: string; committer: string } {
  const stamp = `${when} +0000`;
  const line = `${login} <${login}@users.noreply.github.com> ${stamp}`;
  return { author: line, committer: line };
}

function makeCommit(repo: Repo, forge: Forge, tree: string, parents: string[], message: string, login: string, when?: number): string {
  const at = when ?? forge.tick();
  const who = identity(login, at);
  return putObject(
    repo,
    'commit',
    buildCommit({ tree, parents: parents.filter((parent) => parent && parent !== ZERO_OID), author: who.author, committer: who.committer, message }),
  );
}

function blobOf(repo: Repo, text: string): string {
  return putObject(repo, 'blob', Buffer.from(text, 'utf8'));
}

// ------------------------------------------------------------------ routing

export function handleRest(ctx: Ctx): Reply | null {
  const segments = ctx.segments;
  if (segments.length === 0 || segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2).filter((part) => part !== '');
  const method = ctx.method;

  // GET /api/v3/
  if (rest.length === 0) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '/settings/connections/applications{/client_id}',
        repositories_url: '/api/v3/user/repos',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return { status: 200, body: { installed_version: '3.0.0', verifiable_password_authentication: true } };
  }

  if (ctx.token === null) return unauthorized();

  // /user/repos
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') return createRepo(ctx);
    if (method === 'GET') return listRepos(ctx);
    return message(405, 'Method Not Allowed');
  }

  if (rest[0] === 'user') {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return { status: 200, body: userJson(ctx.viewer) };
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    if (owner.toLowerCase() !== ctx.viewer.toLowerCase()) return notFound();
    const repo = ctx.forge.get(owner, name);
    if (!repo) return notFound();
    return handleRepoRoutes(ctx, repo, rest.slice(3));
  }

  return notFound();
}

function createRepo(ctx: Ctx): Reply {
  const parsed = jsonBody(ctx);
  if (parsed === null) return message(400, 'Problems parsing JSON');
  const name = str(parsed.name).trim();
  if (name === '') return message(422, 'Repository name is required');
  const existing = ctx.forge.get(ctx.viewer, name);
  if (existing) return message(422, 'Repository creation failed: name already exists on this account');
  const repo = ctx.forge.create(ctx.viewer, name, {
    private: bool(parsed.private, true),
    description: str(parsed.description),
    defaultBranch: str(parsed.default_branch, 'main') || 'main',
  });
  return { status: 201, body: repoJson(repo) };
}

function listRepos(ctx: Ctx): Reply {
  const perPageRaw = Number(ctx.url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const pageRaw = Number(ctx.url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const all = ctx.forge.list(ctx.viewer);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const next = new URL(ctx.url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { status: 200, body: items.map(repoJson), headers };
}

function handleRepoRoutes(ctx: Ctx, repo: Repo, rest: string[]): Reply {
  const method = ctx.method;

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const parsed = jsonBody(ctx);
      if (parsed === null) return message(400, 'Problems parsing JSON');
      if (typeof parsed.description === 'string') repo.description = parsed.description;
      if (typeof parsed.private === 'boolean') repo.private = parsed.private;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      ctx.forge.repos.delete(ctx.forge.key(repo.owner, repo.name));
      return { status: 204, body: null };
    }
    return message(405, 'Method Not Allowed');
  }

  // branches
  if (rest[0] === 'branches' && rest.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref) as string, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${repo.refs.get(ref)}` },
        protected: false,
      }));
    return { status: 200, body: branches };
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
    if (method !== 'POST') return message(405, 'Method Not Allowed');
    const parsed = jsonBody(ctx);
    if (parsed === null) return message(400, 'Problems parsing JSON');
    let ref = str(parsed.ref);
    if (ref === '') return message(422, 'ref is required');
    if (!ref.startsWith('refs/')) ref = `refs/heads/${ref}`;
    const sha = str(parsed.sha);
    if (!/^[0-9a-f]{40}$/i.test(sha)) return message(422, 'sha must be a 40-character commit id');
    if (!repo.objects.has(sha)) return message(422, 'Object does not exist');
    if (repo.refs.has(ref)) return message(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, node_id: `R_${hashNumeric(ref)}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${ref.split('/').pop()}`, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } } };
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    const who = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = who.startsWith('refs/') ? repo.refs.get(who) : repo.refs.get(`refs/heads/${who}`);
    const resolved = tip ?? (/^[0-9a-f]{40}$/i.test(who) ? who : undefined);
    if (!resolved) return message(404, 'Not Found');
    const list = historyOf(repo, resolved).map((oid) => {
      const info = parseCommit((repo.objects.get(oid) as GitObject).data);
      return {
        sha: oid,
        node_id: `C_${oid.slice(0, 12)}`,
        commit: {
          message: info.message.replace(/\n$/, ''),
          author: { name: info.author.split(' <')[0], email: (info.author.match(/<([^>]*)>/) ?? ['', ''])[1], date: iso(0) },
          committer: { name: info.committer.split(' <')[0], email: (info.committer.match(/<([^>]*)>/) ?? ['', ''])[1], date: iso(0) },
          tree: { sha: info.tree },
        },
        parents: info.parents.map((parent) => ({ sha: parent })),
      };
    });
    return { status: 200, body: list };
  }

  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(ctx, repo, path);
    if (method === 'PUT') return putContents(ctx, repo, path);
    if (method === 'DELETE') return deleteContents(ctx, repo, path);
    return message(405, 'Method Not Allowed');
  }

  // labels
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const parsed = jsonBody(ctx);
      if (parsed === null) return message(400, 'Problems parsing JSON');
      const name = str(parsed.name);
      if (name === '') return message(422, 'name is required');
      const color = str(parsed.color, 'ededed') || 'ededed';
      repo.labels.set(name, color);
      return { status: 201, body: labelJson(name, color) };
    }
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, body: [...repo.labels.entries()].map(([name, color]) => labelJson(name, color)) };
    }
    return message(405, 'Method Not Allowed');
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssue(ctx, repo);
      if (method === 'GET') return listIssues(ctx, repo);
      return message(405, 'Method Not Allowed');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return notFound();
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (!issue) return notFound();
    if (rest.length === 2) {
      if (method === 'GET') return { status: 200, body: issueJson(issue, repo.labels) };
      if (method === 'PATCH') {
        const parsed = jsonBody(ctx);
        if (parsed === null) return message(400, 'Problems parsing JSON');
        if (parsed.state === 'closed' || parsed.state === 'open') issue.state = parsed.state;
        if (typeof parsed.title === 'string') issue.title = parsed.title;
        if (typeof parsed.body === 'string') issue.body = parsed.body;
        return { status: 200, body: issueJson(issue, repo.labels) };
      }
      return message(405, 'Method Not Allowed');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const parsed = jsonBody(ctx);
        if (parsed === null) return message(400, 'Problems parsing JSON');
        const body = str(parsed.body);
        if (body === '') return message(422, 'body is required');
        repo.nextComment += 1;
        const comment: Comment = { id: 500_000 + repo.nextComment, body, user: ctx.viewer, createdAt: ctx.forge.tick() };
        issue.comments.push(comment);
        return { status: 201, body: commentJson(comment) };
      }
      if (method === 'GET') {
        return { status: 200, body: issue.comments.map(commentJson) };
      }
      return message(405, 'Method Not Allowed');
    }
    return notFound();
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPull(ctx, repo);
      if (method === 'GET') return listPulls(ctx, repo);
      return message(405, 'Method Not Allowed');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return notFound();
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (!pull) return notFound();
    if (rest.length === 2) {
      if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
      return message(405, 'Method Not Allowed');
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return pullFiles(repo, pull);
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePull(ctx, repo, pull);
    return notFound();
  }

  return notFound();
}

// ------------------------------------------------------------------ contents

function getContents(ctx: Ctx, repo: Repo, path: string): Reply {
  if (path === '') return notFound();
  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = ref.startsWith('refs/') ? repo.refs.get(ref) : repo.refs.get(`refs/heads/${ref}`);
  const commitOid = tip ?? (/^[0-9a-f]{40}$/i.test(ref) ? ref : undefined);
  if (!commitOid) return notFound();
  const found = lookupPath(repo, commitOid, path);
  if (!found) return notFound();
  if (found.kind === 'dir') {
    const listing = readTree(repo, found.tree)
      .map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        mode: entry.mode,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { status: 200, body: listing };
  }
  const blob = repo.objects.get(found.blob);
  const data = blob ? blob.data : Buffer.alloc(0);
  return {
    status: 200,
    body: {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: data.toString('base64').replace(/(.{60})/g, '$1\n').trim(),
      sha: found.blob,
      mode: found.mode,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    },
  };
}

function putContents(ctx: Ctx, repo: Repo, path: string): Reply {
  if (path === '') return message(422, 'path is required');
  const parsed = jsonBody(ctx);
  if (parsed === null) return message(400, 'Problems parsing JSON');
  const messageText = str(parsed.message, 'commit') || 'commit';
  const branch = str(parsed.branch, repo.defaultBranch) || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName) ?? null;
  if (str(parsed.branch) !== '' && tip === null) return notFound();
  const b64 = str(parsed.content).replace(/[\r\n\t ]+/g, '');
  if (b64 === '') return message(422, 'content is required');
  const data = Buffer.from(b64, 'base64');
  const existing = tip ? lookupPath(repo, tip, path) : null;
  if (existing && existing.kind === 'dir') return message(422, 'path is a directory');
  const wantsUpdate = typeof parsed.sha === 'string' && parsed.sha !== '';
  if (wantsUpdate) {
    if (!existing || existing.kind !== 'file') return message(422, 'sha does not match any file');
    if (existing.blob.toLowerCase() !== str(parsed.sha).toLowerCase()) {
      return message(409, `${path} does not match ${str(parsed.sha)}`);
    }
  } else if (existing && existing.kind === 'file') {
    return message(422, `${path} already exists`);
  }
  const blob = putObject(repo, 'blob', data);
  const tree = writePath(repo, tip, path, '100644', blob);
  const commit = makeCommit(repo, ctx.forge, tree, tip ? [tip] : [], messageText, ctx.viewer);
  repo.refs.set(refName, commit);
  return {
    status: existing && existing.kind === 'file' ? 200 : 201,
    body: {
      content: { name: path.split('/').pop(), path, sha: blob, size: data.length, encoding: 'base64', type: 'file' },
      commit: { sha: commit, message: messageText, tree: { sha: tree }, parents: tip ? [{ sha: tip }] : [] },
    },
  };
}

function deleteContents(ctx: Ctx, repo: Repo, path: string): Reply {
  const parsed = jsonBody(ctx);
  if (parsed === null) return message(400, 'Problems parsing JSON');
  const branch = str(parsed.branch, repo.defaultBranch) || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  if (!tip) return notFound();
  const existing = lookupPath(repo, tip, path);
  if (!existing || existing.kind !== 'file') return notFound();
  const wantsSha = str(parsed.sha);
  if (wantsSha !== '' && wantsSha.toLowerCase() !== existing.blob.toLowerCase()) {
    return message(409, `${path} does not match ${wantsSha}`);
  }
  const tree = removePath(repo, tip, path) ?? putObject(repo, 'tree', buildTreeEntries([]));
  const messageText = str(parsed.message, 'delete') || 'delete';
  const commit = makeCommit(repo, ctx.forge, tree, [tip], messageText, ctx.viewer);
  repo.refs.set(refName, commit);
  return { status: 200, body: { content: null, commit: { sha: commit, message: messageText, tree: { sha: tree }, parents: [{ sha: tip }] } } };
}

// ------------------------------------------------------------------ issues

function createIssue(ctx: Ctx, repo: Repo): Reply {
  const parsed = jsonBody(ctx);
  if (parsed === null) return message(400, 'Problems parsing JSON');
  const title = str(parsed.title);
  if (title === '') return message(422, 'title is required');
  const labels = Array.isArray(parsed.labels) ? parsed.labels.map((label) => String(label)) : [];
  for (const label of labels) if (!repo.labels.has(label)) return message(422, `Label does not exist: ${label}`);
  repo.nextIssue += 1;
  const issue: Issue = {
    number: repo.nextIssue,
    title,
    body: str(parsed.body),
    state: 'open',
    labels,
    user: ctx.viewer,
    createdAt: ctx.forge.tick(),
    comments: [],
  };
  repo.issues.push(issue);
  return { status: 201, body: issueJson(issue, repo.labels) };
}

function listIssues(ctx: Ctx, repo: Repo): Reply {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const sort = ctx.url.searchParams.get('sort') ?? 'created';
  const direction = (ctx.url.searchParams.get('direction') ?? 'desc').toLowerCase();
  const perPageRaw = Number(ctx.url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  list = [...list].sort((a, b) => {
    if (sort === 'created' || sort === 'updated') {
      const delta = a.createdAt - b.createdAt;
      if (delta !== 0) return direction === 'asc' ? delta : -delta;
      return direction === 'asc' ? a.number - b.number : b.number - a.number;
    }
    return a.number - b.number;
  });
  return { status: 200, body: list.slice(0, perPage).map((issue) => issueJson(issue, repo.labels)) };
}

// ------------------------------------------------------------------ pulls

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function createPull(ctx: Ctx, repo: Repo): Reply {
  const parsed = jsonBody(ctx);
  if (parsed === null) return message(400, 'Problems parsing JSON');
  const head = str(parsed.head).replace(/^refs\/heads\//, '');
  const base = str(parsed.base).replace(/^refs\/heads\//, '') || repo.defaultBranch;
  if (head === '') return message(422, 'head is required');
  if (!branchTip(repo, head)) return message(422, `No commits between ${base} and ${head}`);
  if (!branchTip(repo, base)) return message(422, `Base ${base} does not exist`);
  repo.nextPull += 1;
  const pull: Pull = {
    number: repo.nextPull,
    title: str(parsed.title),
    body: str(parsed.body),
    state: 'open',
    head,
    base,
    user: ctx.viewer,
    createdAt: ctx.forge.tick(),
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.pulls.push(pull);
  return { status: 201, body: pullJson(repo, pull) };
}

function listPulls(ctx: Ctx, repo: Repo): Reply {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const perPageRaw = Number(ctx.url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  return { status: 200, body: list.slice(0, perPage).map((pull) => pullJson(repo, pull)) };
}

function pullFiles(repo: Repo, pull: Pull): Reply {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (!headTip || !baseTip) return notFound();
  const baseCommon = mergeBase(repo, baseTip, headTip);
  const before = flatten(repo, baseCommon ?? null);
  const after = flatten(repo, headTip);
  const changes = diffFiles(before, after);
  return {
    status: 200,
    body: changes.map((change) => {
      const additions = lineCount(change.after);
      const deletions = lineCount(change.before);
      return {
        sha: change.after ? putObject(repo, 'blob', change.after) : change.before ? putObject(repo, 'blob', change.before) : ZERO_OID,
        filename: change.path,
        status: change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      };
    }),
  };
}

export function mergePull(ctx: Ctx, repo: Repo, pull: Pull): Reply {
  const outcome = performMerge(repo, ctx.forge, pull, ctx.viewer);
  if (!outcome.ok) return message(405, outcome.reason ?? 'Pull request is not mergeable');
  return { status: 200, body: { sha: outcome.sha, merged: true, message: outcome.message } };
}

/** Merge `pull` into its base branch. Shared by the REST and GraphQL surfaces so both see one truth. */
export function performMerge(
  repo: Repo,
  forge: Forge,
  pull: Pull,
  viewer: string,
): { ok: true; sha: string; message: string } | { ok: false; reason: string } {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (!baseTip || !headTip) return { ok: false, reason: 'Not Found' };
  if (pull.merged) return { ok: false, reason: 'Pull request is not mergeable: it is already merged' };
  const base = flatten(repo, baseTip);
  const head = flatten(repo, headTip);
  const common = mergeBase(repo, baseTip, headTip);
  const ancestor = flatten(repo, common ?? null);
  const baseChanges = diffFiles(ancestor, base);
  const headChanges = diffFiles(ancestor, head);
  const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
  const conflicts = headChanges.filter((change) => {
    const other = baseByPath.get(change.path);
    if (!other) return false;
    const left = other.after ? other.after.toString('utf8') : null;
    const right = change.after ? change.after.toString('utf8') : null;
    const original = ancestor.get(change.path)?.data.toString('utf8') ?? null;
    if (left === right) return false;
    // one side left the file as it was: no conflict
    if (left === original || right === original) return false;
    return true;
  });
  if (conflicts.length) return { ok: false, reason: 'Pull request is not mergeable: the merge produced a conflict' };
  const merged: FileMap = new Map(base);
  for (const change of headChanges) {
    if (change.after === null) merged.delete(change.path);
    else merged.set(change.path, { mode: '100644', data: change.after, oid: '' });
  }
  const tree = commitTree(repo, merged);
  const messageText = `Merge pull request #${pull.number} from ${pull.head}`;
  const mergeCommit = makeCommit(repo, forge, tree, [baseTip, headTip], messageText, viewer);
  repo.refs.set(`refs/heads/${pull.base}`, mergeCommit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = iso(forge.tick());
  pull.mergeCommitSha = mergeCommit;
  return { ok: true, sha: mergeCommit, message: messageText };
}

/** Build (and store) the tree for a whole file map. */
function commitTree(repo: Repo, files: FileMap): string {
  interface Node {
    files: Map<string, { mode: string; data: Buffer }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1], { mode: file.mode === '100755' ? '100755' : '100644', data: file.data });
  }
  const build = (node: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, file] of node.files) {
      entries.push({ mode: file.mode, name, oid: putObject(repo, 'blob', file.data) });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return putObject(repo, 'tree', buildTreeEntries(entries));
  };
  return build(root);
}
