// mcp.ts: the Model Context Protocol endpoint over the same Forge the REST surface writes.
//
// JSON-RPC 2.0 over the Streamable HTTP transport, answering application/json (a JSON body is always a
// legal answer; SSE is the other the transport allows). Two eras are served:
//   - modern: server/discover answers supportedVersions, and no session or handshake is needed;
//   - handshake: initialize then notifications/initialized, with an Mcp-Session-Id handed out.
// Tools act on the shared store, so an object made here reads back over /api/v3 with the same id.

import type { Forge, Issue, Pull, Repo } from './core.ts';

export interface McpContext {
  forge: Forge;
  viewer: string;
  method: string;
  body: Buffer;
  token: string | null;
  headers: Record<string, string>;
}

export interface McpReply {
  status: number;
  body: Buffer | unknown;
  type?: string;
  headers?: Record<string, string>;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

/** One tool: its name, its description, and the JSON-schema properties it reads. */
interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the signed-in login and return it.',
    properties: {
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      full_name: { type: 'string', description: 'owner/repo shorthand.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body.' },
      labels: { type: 'array', description: 'Label names the issue carries.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List a repository\u2019s issues, newest first.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
      limit: { type: 'number', description: 'How many issues to return.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      body: { type: 'string', description: 'Pull request body.' },
      head: { type: 'string', description: 'Source branch.' },
      base: { type: 'string', description: 'Target branch.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'merge, squash or rebase.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'search_repositories',
    description: 'Search the signed-in login\u2019s repositories by name.',
    properties: { query: { type: 'string', description: 'Text the repository name contains.' } },
    required: ['query'],
  },
];

/** The tools/list payload, built once: two calls must answer the same array byte for byte. */
const TOOL_LIST = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.properties).map(([key, value]) => [key, { type: value.type, description: value.description }]),
      ),
      required: tool.required,
    },
  })),
};

// ------------------------------------------------------------------ ids

let sessionCounter = 0;
const sessions = new Map<string, { created: number; revision: string }>();

function newSession(revision: string): string {
  sessionCounter += 1;
  const id = `sess-${process.pid.toString(36)}-${sessionCounter.toString(36)}`;
  sessions.set(id, { created: Date.now(), revision });
  return id;
}

// ------------------------------------------------------------------ json helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

// ------------------------------------------------------------------ resource shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repoIdentity(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** A stable numeric id per repository, derived from its full name so it never moves. */
function repoIdentity(repo: Repo): number {
  const key = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 100000000;
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repoIdentity(repo) * 1000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user, type: 'User' },
    labels: [],
    repository: repo.name,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head },
    base: { ref: pull.base },
    user: { login: pull.user, type: 'User' },
  };
}

// ------------------------------------------------------------------ tool bodies

interface ToolOutcome {
  payload: unknown;
  isError: boolean;
}

/** Split `owner/repo` out of whichever arguments the caller sent. */
function resolveTarget(args: Record<string, unknown>): { owner: string; repo: string } {
  const full = textOf(args.full_name);
  if (full.includes('/')) {
    const [owner, repo] = full.split('/');
    return { owner, repo };
  }
  const repoName = textOf(args.repo) || textOf(args.name) || textOf(args.repository);
  return { owner: textOf(args.owner), repo: repoName };
}

function createRepo(ctx: McpContext, args: Record<string, unknown>): ToolOutcome {
  const name = textOf(args.name) || textOf(args.repo);
  if (name === '') return { payload: { error: 'create_repo needs a name' }, isError: true };
  const created = ctx.forge.create(ctx.viewer, name, {
    description: textOf(args.description),
    private: args.private === true,
  });
  if (created.defaultBranch === '') created.defaultBranch = 'main';
  return { payload: repoJson(created), isError: false };
}

function getRepo(ctx: McpContext, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo: name } = resolveTarget(args);
  const repo = ctx.forge.owned(owner === '' ? ctx.viewer : owner, name, ctx.viewer);
  if (repo === null) return { payload: { error: `no repository ${owner}/${name}` }, isError: true };
  return { payload: repoJson(repo), isError: false };
}

function createIssue(ctx: McpContext, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo: name } = resolveTarget(args);
  const repo = ctx.forge.owned(owner === '' ? ctx.viewer : owner, name, ctx.viewer);
  if (repo === null) return { payload: { error: `no repository ${owner}/${name}` }, isError: true };
  const title = textOf(args.title);
  if (title === '') return { payload: { error: 'create_issue needs a title' }, isError: true };
  const issue: Issue = {
    number: repo.nextIssue + 1,
    title,
    body: textOf(args.body),
    state: 'open',
    labels: [],
    user: ctx.viewer,
    createdAt: ctx.forge.tick(),
    comments: [],
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return { payload: issueJson(repo, issue), isError: false };
}

function listIssues(ctx: McpContext, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo: name } = resolveTarget(args);
  const repo = ctx.forge.owned(owner === '' ? ctx.viewer : owner, name, ctx.viewer);
  if (repo === null) return { payload: { error: `no repository ${owner}/${name}` }, isError: true };
  const state = textOf(args.state) || 'open';
  const limit = numberOrNull(args.limit) ?? numberOrNull(args.per_page) ?? 30;
  let issues = [...repo.issues];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => b.number - a.number);
  return { payload: issues.slice(0, limit).map((issue) => issueJson(repo, issue)), isError: false };
}

function createPullRequest(ctx: McpContext, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo: name } = resolveTarget(args);
  const repo = ctx.forge.owned(owner === '' ? ctx.viewer : owner, name, ctx.viewer);
  if (repo === null) return { payload: { error: `no repository ${owner}/${name}` }, isError: true };
  const head = textOf(args.head).replace(/^refs\/heads\//, '').replace(/^[^:]+:/, '');
  const base = textOf(args.base).replace(/^refs\/heads\//, '');
  if (head === '' || base === '') return { payload: { error: 'create_pull_request needs head and base' }, isError: true };
  const pull: Pull = {
    number: repo.nextPull + 1,
    title: textOf(args.title),
    body: textOf(args.body),
    state: 'open',
    head,
    base,
    user: ctx.viewer,
    createdAt: ctx.forge.tick(),
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return { payload: pullJson(pull), isError: false };
}

function mergePullRequest(ctx: McpContext, args: Record<string, unknown>): ToolOutcome {
  const { owner, repo: name } = resolveTarget(args);
  const repo = ctx.forge.owned(owner === '' ? ctx.viewer : owner, name, ctx.viewer);
  if (repo === null) return { payload: { error: `no repository ${owner}/${name}` }, isError: true };
  const number = numberOrNull(args.pull_number) ?? numberOrNull(args.number);
  if (number === null) return { payload: { error: 'merge_pull_request needs pull_number' }, isError: true };
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return { payload: { error: `no pull request #${number}` }, isError: true };
  if (pull.merged) return { payload: { error: `pull request #${number} is already merged` }, isError: true };
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date(0).toISOString();
  return { payload: { ...pullJson(pull), merged: true, message: `Pull request #${number} merged` }, isError: false };
}

function searchRepositories(ctx: McpContext, args: Record<string, unknown>): ToolOutcome {
  const query = textOf(args.query).toLowerCase();
  const found = ctx.forge.list(ctx.viewer).filter((repo) => repo.name.toLowerCase().includes(query));
  return { payload: { total_count: found.length, items: found.map(repoJson) }, isError: false };
}

const TOOL_BODIES: Record<string, (ctx: McpContext, args: Record<string, unknown>) => ToolOutcome> = {
  create_repo: createRepo,
  get_repo: getRepo,
  create_issue: createIssue,
  list_issues: listIssues,
  create_pull_request: createPullRequest,
  merge_pull_request: mergePullRequest,
  search_repositories: searchRepositories,
};

/** The body a tools/call answers: the payload as JSON text plus structured content. */
function toolResult(outcome: ToolOutcome): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
    structuredContent: outcome.payload,
    isError: outcome.isError,
  };
}

/** Whether every required property of a tool is present and non-empty in the arguments. */
function missingRequired(tool: ToolSpec, args: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const key of tool.required) {
    const value = args[key];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) missing.push(key);
  }
  return missing;
}

/** The tool whose canonical name this is, allowing one of the client's documented aliases. */
const ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

/** A tool name as the store knows it, accepting a server prefix and a case-insensitive suffix match. */
function canonicalTool(raw: string): string | null {
  const lowered = raw.toLowerCase();
  if (TOOL_BODIES[lowered] !== undefined) return lowered;
  if (ALIASES[lowered] !== undefined) return ALIASES[lowered];
  for (const name of Object.keys(TOOL_BODIES)) {
    if (lowered.endsWith(`__${name}`) || lowered.endsWith(`_${name}`) || lowered.endsWith(name)) return name;
  }
  for (const [alias, name] of Object.entries(ALIASES)) {
    if (lowered.endsWith(`__${alias}`) || lowered.endsWith(alias)) return name;
  }
  return null;
}

// ------------------------------------------------------------------ dispatch

/** One JSON-RPC message: a result, an error, or null for a notification (which is answered 202). */
interface Handled {
  answer: Record<string, unknown> | null;
  isError: boolean;
}

function handleMessage(ctx: McpContext, message: unknown, protocolVersion: string): Handled {
  if (!isRecord(message)) return { answer: rpcError(null, ERR_INVALID_REQUEST, 'Invalid Request'), isError: true };
  const id = message.id ?? null;
  const method = textOf(message.method);
  const params = isRecord(message.params) ? message.params : {};
  const isNotification = message.id === undefined || message.id === null;

  if (method === '') {
    return { answer: rpcError(id, ERR_INVALID_REQUEST, 'Invalid Request: no method'), isError: true };
  }

  if (isNotification) {
    // notifications/initialized and any other notification: no answer, and the transport says 202.
    return { answer: null, isError: false };
  }

  switch (method) {
    case 'server/discover':
      return {
        answer: rpcResult(id, {
          serverInfo: SERVER_INFO,
          capabilities: { tools: { listChanged: false } },
          supportedVersions: PROTOCOL_VERSIONS,
          protocolVersion,
          instructions: 'A GitHub-compatible forge: repositories, issues, pull requests and merges.',
        }),
        isError: false,
      };

    case 'initialize':
      return {
        answer: rpcResult(id, {
          protocolVersion: textOf(params.protocolVersion) || PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
        isError: false,
      };

    case 'ping':
      return { answer: rpcResult(id, {}), isError: false };

    case 'tools/list':
      return { answer: rpcResult(id, TOOL_LIST), isError: false };

    case 'tools/call': {
      const name = textOf(params.name);
      const canonical = canonicalTool(name);
      if (canonical === null) {
        return { answer: rpcError(id, ERR_INVALID_PARAMS, `Unknown tool: ${name}`), isError: true };
      }
      const rawArgs = isRecord(params.arguments) ? params.arguments : {};
      const spec = TOOLS.find((tool) => tool.name === canonical);
      if (spec !== undefined) {
        const missing = missingRequired(spec, rawArgs);
        if (missing.length > 0) {
          return { answer: rpcError(id, ERR_INVALID_PARAMS, `Missing required argument(s): ${missing.join(', ')}`), isError: true };
        }
      }
      const outcome = TOOL_BODIES[canonical](ctx, rawArgs);
      return { answer: rpcResult(id, toolResult(outcome)), isError: outcome.isError };
    }

    case 'resources/list':
      return { answer: rpcResult(id, { resources: [] }), isError: false };

    case 'prompts/list':
      return { answer: rpcResult(id, { prompts: [] }), isError: false };

    default:
      return { answer: rpcError(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`), isError: true };
  }
}

/** Whether a body is a JSON-RPC batch (an array of messages). */
function isBatch(parsed: unknown): boolean {
  return Array.isArray(parsed);
}

export async function handleMcp(ctx: McpContext): Promise<McpReply> {
  if (ctx.method !== 'POST') {
    return { status: 405, body: { message: 'Method Not Allowed' }, type: JSON_TYPE, headers: { allow: 'POST' } };
  }
  if (ctx.token === null) {
    return { status: 401, body: { message: 'Requires authentication' }, type: JSON_TYPE };
  }

  // A session header, when the client has one, names a session this server handed out.
  let sessionId: string | null = ctx.headers['mcp-session-id'] ?? null;
  if (sessionId !== null && !sessions.has(sessionId)) sessionId = null;

  const protocolVersion = ctx.headers['mcp-protocol-version'] ?? PROTOCOL_VERSIONS[0];

  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    // The modern transport answers a malformed body with HTTP 400 and -32700.
    return { status: 400, body: rpcError(null, ERR_PARSE, 'Parse error'), type: JSON_TYPE };
  }

  const messages = isBatch(parsed) ? (parsed as unknown[]) : [parsed];
  const answers: Record<string, unknown>[] = [];

  for (const message of messages) {
    const handled = handleMessage(ctx, message, protocolVersion);
    if (handled.answer !== null) answers.push(handled.answer);
  }

  // A new session is minted on an initialize, as the handshake era expects.
  const headers: Record<string, string> = {};
  const initializing = messages.some((message) => isRecord(message) && textOf(message.method) === 'initialize');
  if (initializing) {
    sessionId = newSession(protocolVersion);
    headers['mcp-session-id'] = sessionId;
  }

  // Only notifications: the transport answers 202 with no body.
  if (answers.length === 0) return { status: 202, body: Buffer.alloc(0), type: JSON_TYPE, headers };

  if (isBatch(parsed)) {
    return { status: 200, body: answers, type: JSON_TYPE, headers };
  }
  return { status: 200, body: answers[0], type: JSON_TYPE, headers };
}
