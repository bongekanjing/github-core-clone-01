// git-http.ts: the smart-HTTP routes over lib/git.ts's protocol pieces.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack   advertisement
//   POST /{owner}/{repo}.git/git-upload-pack                                     ls-refs / fetch
//   POST /{owner}/{repo}.git/git-receive-pack                                    push
//
// upload-pack speaks protocol v2 when the client asks for it with Git-Protocol: version=2, and falls
// back to v0 otherwise. receive-pack is v0 only. A repository that does not exist, or belongs to
// another login, is a JSON 404 on both services and the server stays up.

import type { Forge, GitObject, Repo } from './core.ts';
import {
  PKT_MAX,
  type FetchPlan,
  type FetchRequest,
  type LsRefsRequest,
  advertisementBody,
  applyPush,
  decodePackets,
  fetchResponse,
  indexPack,
  lsRefsResponse,
  parseReceivePack,
  pkt,
  planFetch,
  receivePackResponse,
  writePack,
} from './git.ts';

export interface GitReply {
  status: number;
  body: Buffer | unknown;
  type?: string;
  headers?: Record<string, string>;
}

export interface GitContext {
  forge: Forge;
  viewer: string;
  url: URL;
  path: string;
  method: string;
  body: Buffer;
  token: string | null;
  headers: Record<string, string>;
}

const NO_CACHE: Record<string, string> = { 'cache-control': 'no-cache, max-age=0, must-revalidate' };
const JSON_REPLY_TYPE = 'application/json; charset=utf-8';

/** The repository a git path names, or null when the path is not a git route. */
function target(path: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+?)\.git(\/.*)?$/.exec(path);
  if (!match) return null;
  try {
    return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]), rest: match[3] ?? '' };
  } catch {
    return null;
  }
}

/** The data packets of a request body, in order, with the flush and delim markers dropped. */
function linesOf(body: Buffer): string[] {
  const out: string[] = [];
  for (const packet of decodePackets(body).packets) {
    if (packet.kind !== 'data') continue;
    out.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

/** Whether a v2 body carries a section header naming `command`. */
function hasCommand(lines: string[], command: string): boolean {
  return lines.some((line) => line === `command=${command}`);
}

/** The argument lines of the section whose header is command=<command>, to the next header. */
function sectionArgs(lines: string[], command: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith('command=')) {
      inside = line === `command=${command}`;
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

/** The v2 ls-refs arguments: prefixes plus the three flags. */
function lsRefsRequest(args: string[]): LsRefsRequest {
  const request: LsRefsRequest = { prefixes: [], peel: false, symrefs: false, unborn: false };
  for (const arg of args) {
    if (arg === 'peel') request.peel = true;
    else if (arg === 'symrefs') request.symrefs = true;
    else if (arg === 'unborn') request.unborn = true;
    else if (arg.startsWith('ref-prefix ')) request.prefixes.push(arg.slice('ref-prefix '.length));
  }
  return request;
}

/** The v2 fetch arguments: wants, haves, shallow lines, a depth, and done. */
function fetchRequest(args: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.depth = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('deepen-since ')) request.depth = 1;
    else if (arg === 'done') request.done = true;
  }
  return request;
}

/** The v0 upload-pack body: capability-suffixed want lines, haves, and an optional pack. */
function v0Fetch(body: Buffer): { request: FetchRequest; capabilities: string[] } {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  const capabilities: string[] = [];
  for (const line of linesOf(body)) {
    if (line.startsWith('want ')) {
      const parts = line.slice(5).split(' ');
      request.wants.push((parts[0] ?? '').trim());
      if (capabilities.length === 0) for (const cap of parts.slice(1)) if (cap.trim() !== '') capabilities.push(cap.trim());
    } else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') request.done = true;
  }
  return { request, capabilities };
}

/** A v0 upload-pack answer: NAK or the last ack, then the pack, sideband-framed when asked for. */
function v0Answer(plan: FetchPlan, capabilities: string[]): Buffer {
  const parts: Buffer[] = [pkt(plan.acks.length ? `ACK ${plan.acks[plan.acks.length - 1]}\n` : 'NAK\n')];
  const pack = writePack(plan.objects as GitObject[]);
  if (capabilities.includes('side-band-64k') || capabilities.includes('side-band')) {
    for (let offset = 0; offset < pack.length; offset += PKT_MAX - 5) {
      const chunk = pack.subarray(offset, Math.min(offset + PKT_MAX - 5, pack.length));
      parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    }
  } else {
    parts.push(pack);
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** The one route handler app.ts calls; null when the path is not a git route at all. */
export function handleGit(ctx: GitContext): GitReply | null {
  const where = target(ctx.path);
  if (where === null) return null;

  const repo: Repo | null = ctx.forge.owned(where.owner, where.repo, ctx.viewer);
  if (repo === null) return { status: 404, body: { message: 'Not Found' }, type: JSON_REPLY_TYPE };
  if (ctx.token === null) return { status: 401, body: { message: 'Requires authentication' }, type: JSON_REPLY_TYPE };

  const rest = where.rest;

  if (rest === '/info/refs' && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
    const service = ctx.url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return { status: 403, body: { message: 'Smart HTTP is the only protocol this server speaks' }, type: JSON_REPLY_TYPE };
    }
    const v2 = service === 'git-upload-pack' && (ctx.headers['git-protocol'] ?? '').includes('version=2');
    return {
      status: 200,
      body: advertisementBody(repo, service === 'git-upload-pack' ? 'upload' : 'receive', v2),
      type: `application/x-${service}-advertisement`,
      headers: { ...NO_CACHE },
    };
  }

  if (rest === '/git-upload-pack' && ctx.method === 'POST') {
    if ((ctx.headers['git-protocol'] ?? '').includes('version=2')) {
      const lines = linesOf(ctx.body);
      if (hasCommand(lines, 'ls-refs')) {
        return {
          status: 200,
          body: lsRefsResponse(repo, lsRefsRequest(sectionArgs(lines, 'ls-refs'))),
          type: 'application/x-git-upload-pack-result',
          headers: { ...NO_CACHE },
        };
      }
      if (hasCommand(lines, 'fetch')) {
        const request = fetchRequest(sectionArgs(lines, 'fetch'));
        return {
          status: 200,
          body: fetchResponse(planFetch(repo, request), request),
          type: 'application/x-git-upload-pack-result',
          headers: { ...NO_CACHE },
        };
      }
      return {
        status: 200,
        body: Buffer.from('0000', 'ascii'),
        type: 'application/x-git-upload-pack-result',
        headers: { ...NO_CACHE },
      };
    }
    const { request, capabilities } = v0Fetch(ctx.body);
    return {
      status: 200,
      body: v0Answer(planFetch(repo, request), capabilities),
      type: 'application/x-git-upload-pack-result',
      headers: { ...NO_CACHE },
    };
  }

  if (rest === '/git-receive-pack' && ctx.method === 'POST') {
    const { commands, capabilities, pack } = parseReceivePack(ctx.body);
    if (process.env.MAKEFUN_DEBUG) console.error('PUSH', repo.owner + '/' + repo.name, JSON.stringify(commands), 'pack', pack?.length ?? 0);
    if (pack !== null && pack.length > 0) indexPack(repo, pack);
    const { reports, unpackDetail } = applyPush(repo, commands);
    return {
      status: 200,
      body: receivePackResponse(reports, unpackDetail, capabilities.includes('side-band-64k')),
      type: 'application/x-git-receive-pack-result',
      headers: { ...NO_CACHE },
    };
  }

  return { status: 404, body: { message: 'Not Found' }, type: JSON_REPLY_TYPE };
}
