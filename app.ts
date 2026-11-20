// app.ts: the forge's HTTP surface, put together from its four protocol modules.
//
// One in-memory Forge backs every surface, so an object created over REST reads back over GraphQL
// and MCP unchanged. Dispatch is by path: git smart HTTP by its .git suffix, REST under /api/v3,
// GraphQL at /api/graphql, MCP at /mcp.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './lib/core.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleGit } from './lib/git-http.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The token a trial's suite presents, and the login it names: every surface but the probe needs it. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
// The trial hands one bearer token and no login. The suite's scenario is drawn from the fixed public
// seed wire.ts ships (SCENARIO_SEED), whose first user — the login the token owns — is always this one.
const SHOP_OWNER = process.env.MAKEFUN_SHOP_OWNER ?? 'adaiversen';

/** One counter for the X-GitHub-Request-Id every reply carries. */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  const mixed = (requestCounter * 2654435761) % 4294967296;
  return `MF-${process.pid.toString(36)}-${requestCounter.toString(36)}-${mixed.toString(16)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, type: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

/** Read a request body whole. A push pack is the largest legitimate one, so the cap is generous. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    total += part.length;
    if (total > 256 * 1024 * 1024) break;
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

/** The bearer token on a request, or null when it carries none. */
function tokenOf(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token === '' ? null : token;
}

/** The trial's token is the only good one; a missing token is never authenticated. */
function authenticated(token: string | null): boolean {
  if (token === null) return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(', ');
  }
  return out;
}

const forge = new Forge();

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await dispatch(req, res);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${detail}` });
        else res.end();
      }
    })();
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    // Absolute URLs we hand back (a Link rel="next", say) must stay on the origin the caller dialed,
    // so the base comes from the Host header rather than a placeholder.
    const host = req.headers.host ?? '127.0.0.1';
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
    url = new URL(req.url ?? '/', `${proto}://${host}`);
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  // The boot probe is the one route that needs no token.
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const token = tokenOf(req);
  const authed = authenticated(token);
  const segments = path.split('/').filter((part) => part !== '');
  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const headers = headersOf(req);

  // git smart HTTP: matched by the .git suffix, and unauthenticated requests are refused there too.
  const gitReply = handleGit({ forge, viewer: SHOP_OWNER, url, path, method, body, token: authed ? token : null, headers });
  if (gitReply !== null) {
    if (gitReply.body instanceof Buffer) sendBytes(res, gitReply.status, gitReply.body, gitReply.type ?? 'application/octet-stream', gitReply.headers ?? {});
    else sendJson(res, gitReply.status, gitReply.body, gitReply.headers ?? {});
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authed) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const reply = handleRest({ forge, viewer: SHOP_OWNER, url, token, body, method, segments, headers })
      ?? { status: 404, body: { message: 'Not Found' } };
    sendJson(res, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  if (path === '/api/graphql' || path === '/api/graphql/') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const outcome = handleGraphQL({ forge, viewer: SHOP_OWNER, body, token: authed ? token : null });
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  if (path === '/mcp' || path === '/mcp/') {
    const outcome = await handleMcp({ forge, viewer: SHOP_OWNER, method, body, token: authed ? token : null, headers });
    if (outcome.body instanceof Buffer) sendBytes(res, outcome.status, outcome.body, outcome.type ?? 'application/json', outcome.headers ?? {});
    else sendJson(res, outcome.status, outcome.body, outcome.headers ?? {});
    return;
  }

  if ((path === '/' || path === '/api' || path === '/api/') && method === 'GET') {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repositories_url: '/api/v3/user/repos',
      rate_limit_url: '/api/v3/rate_limit',
      installed_version: '3.0.0',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
