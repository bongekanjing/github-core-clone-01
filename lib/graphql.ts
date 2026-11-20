// GraphQL v4 over the in-memory Forge: a document parser, a typed resolver registry and an executor that
// answers exactly the selection set it is asked for (aliases, fragments, variables, batching, introspection).
//
// The contract is sdk/conformance/checks-graphql.ts: the twenty documents it sends, the fixtures it builds over
// REST v3 first, and the two surfaces it cross-checks (a mutation must be visible over REST, and vice versa).

import {
  type Forge,
  type Issue,
  type Pull,
  type Repo,
  ZERO_OID,
  parseCommit,
  parseTree,
} from './core.ts';
import { performMerge } from './rest.ts';

// ------------------------------------------------------------------ document model

type Value = null | boolean | number | string | Value[] | { [key: string]: Value } | { $var: string };

interface Arg {
  name: string;
  value: Value;
}

interface Field {
  kind: 'field';
  alias?: string;
  name: string;
  args: Arg[];
  selection: Selection[];
}

interface Spread {
  kind: 'spread';
  name: string;
}

interface Inline {
  kind: 'inline';
  on?: string;
  selection: Selection[];
}

type Selection = Field | Spread | Inline;

interface Operation {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: { name: string; type: string; default?: Value }[];
  selection: Selection[];
}

interface FragmentDef {
  kind: 'fragment';
  name: string;
  on: string;
  selection: Selection[];
}

interface GqlError {
  message: string;
  path?: (string | number)[];
}

// ------------------------------------------------------------------ lexer

interface Token {
  t: 'name' | 'num' | 'str' | 'punct';
  v: string;
}

const PUNCT = '{}()[]:!$@=|&,.';

function lex(source: string): Token[] {
  const out: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '"') {
      let text = '';
      index += 1;
      if (source.startsWith('""', index)) {
        // block string
        index += 2;
        while (index < source.length && !source.startsWith('"""', index)) {
          text += source[index];
          index += 1;
        }
        index += 3;
      } else {
        while (index < source.length && source[index] !== '"') {
          if (source[index] === '\\') {
            const next = source[index + 1];
            text += next === 'n' ? '\n' : next === 't' ? '\t' : next;
            index += 2;
            continue;
          }
          text += source[index];
          index += 1;
        }
        index += 1;
      }
      out.push({ t: 'str', v: text });
      continue;
    }
    if (source.startsWith('...', index)) {
      out.push({ t: 'punct', v: '...' });
      index += 3;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let text = '';
      while (index < source.length && /[-+0-9.eE]/.test(source[index])) {
        text += source[index];
        index += 1;
      }
      out.push({ t: 'num', v: text });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let text = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) {
        text += source[index];
        index += 1;
      }
      out.push({ t: 'name', v: text });
      continue;
    }
    if (PUNCT.includes(ch)) {
      out.push({ t: 'punct', v: ch });
      index += 1;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return out;
}

class GraphQLSyntaxError extends Error {
  constructor(text: string) {
    super(text);
    this.name = 'GraphQLSyntaxError';
  }
}

// ------------------------------------------------------------------ parser

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private at(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.v === value;
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new GraphQLSyntaxError('unexpected end of document');
    this.index += 1;
    return token;
  }

  private expect(value: string): Token {
    const token = this.next();
    if (token.v !== value) throw new GraphQLSyntaxError(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.v)}`);
    return token;
  }

  private name(): string {
    const token = this.next();
    if (token.t !== 'name') throw new GraphQLSyntaxError(`expected a name, got ${JSON.stringify(token.v)}`);
    return token.v;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.t === 'punct' && token.v === '{') {
        operations.push({ kind: 'operation', operation: 'query', variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.name();
      if (keyword === 'fragment') {
        const name = this.name();
        this.expect('on');
        const on = this.name();
        fragments.set(name, { kind: 'fragment', name, on, selection: this.parseSelectionSet() });
        continue;
      }
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let operationName: string | undefined;
        if (this.peek()?.t === 'name') operationName = this.name();
        const variables: { name: string; type: string; default?: Value }[] = [];
        if (this.at('(')) {
          this.next();
          while (!this.at(')')) {
            this.expect('$');
            const varName = this.name();
            this.expect(':');
            let type = '';
            while (this.peek() !== undefined && !this.at(')') && !this.at('=')) type += this.next().v;
            let fallback: Value | undefined;
            if (this.at('=')) {
              this.next();
              fallback = this.parseValue();
            }
            variables.push(fallback === undefined ? { name: varName, type } : { name: varName, type, default: fallback });
          }
          this.expect(')');
        }
        while (this.at('@')) this.parseDirective();
        operations.push({
          kind: 'operation',
          operation: keyword,
          ...(operationName === undefined ? {} : { name: operationName }),
          variables,
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      throw new GraphQLSyntaxError(`unexpected token ${JSON.stringify(keyword)}`);
    }
    return { operations, fragments };
  }

  private parseDirective(): void {
    this.expect('@');
    this.name();
    if (!this.at('(')) return;
    this.next();
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.v === '(') depth += 1;
      else if (token.v === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (!this.at('}')) {
      if (this.at('...')) {
        this.next();
        if (this.at('on')) {
          this.next();
          const on = this.name();
          while (this.at('@')) this.parseDirective();
          out.push({ kind: 'inline', on, selection: this.parseSelectionSet() });
          continue;
        }
        if (this.at('{')) {
          out.push({ kind: 'inline', selection: this.parseSelectionSet() });
          continue;
        }
        const name = this.name();
        while (this.at('@')) this.parseDirective();
        out.push({ kind: 'spread', name });
        continue;
      }
      const first = this.name();
      let alias: string | undefined;
      let fieldName = first;
      if (this.at(':')) {
        this.next();
        alias = first;
        fieldName = this.name();
      }
      const args: Arg[] = [];
      if (this.at('(')) {
        this.next();
        while (!this.at(')')) {
          const argName = this.name();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      while (this.at('@')) this.parseDirective();
      const selection = this.at('{') ? this.parseSelectionSet() : [];
      out.push(alias === undefined ? { kind: 'field', name: fieldName, args, selection } : { kind: 'field', alias, name: fieldName, args, selection });
    }
    this.expect('}');
    return out;
  }

  private parseValue(): Value {
    const token = this.peek();
    if (token === undefined) throw new GraphQLSyntaxError('unexpected end of document in a value');
    if (token.v === '$') {
      this.next();
      return { $var: this.name() };
    }
    if (token.v === '[') {
      this.next();
      const list: Value[] = [];
      while (!this.at(']')) list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token.v === '{') {
      this.next();
      const object: { [key: string]: Value } = {};
      while (!this.at('}')) {
        const key = this.name();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.t === 'str') {
      this.next();
      return token.v;
    }
    if (token.t === 'num') {
      this.next();
      return Number(token.v);
    }
    if (token.t === 'name') {
      this.next();
      if (token.v === 'true') return true;
      if (token.v === 'false') return false;
      if (token.v === 'null') return null;
      return token.v;
    }
    throw new GraphQLSyntaxError(`unexpected value token ${JSON.stringify(token.v)}`);
  }
}

// ------------------------------------------------------------------ ids

const GID_PREFIX = '04:';

function encodeId(kind: string, key: string): string {
  return Buffer.from(`${GID_PREFIX}${kind}:${key}`, 'utf8').toString('base64');
}

function decodeId(id: string): { kind: string; key: string } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!text.startsWith(GID_PREFIX)) return null;
  const rest = text.slice(GID_PREFIX.length);
  const at = rest.indexOf(':');
  if (at < 0) return null;
  return { kind: rest.slice(0, at), key: rest.slice(at + 1) };
}

function databaseIdOf(owner: string, name: string): number {
  let hash = 2166136261;
  for (const ch of `${owner}/${name}`.toLowerCase()) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return 1 + (hash % 4_000_000_000);
}

// ------------------------------------------------------------------ resolver registry

type Resolver = (value: any, args: Record<string, any>, ctx: Runtime) => unknown;

interface FieldSpec {
  type: string;
  resolve: Resolver;
}

interface Runtime {
  forge: Forge;
  viewer: string;
  tick(): number;
}

const REGISTRY: Record<string, Record<string, FieldSpec>> = {};

function defineType(name: string, fields: Record<string, FieldSpec>): void {
  REGISTRY[name] = fields;
}

const trivial = (type: string, pick: string): FieldSpec => ({ type, resolve: (value) => value?.[pick] });

defineType('User', {
  id: { type: 'ID', resolve: (value) => encodeId('User', String(value?.login ?? '')) },
  login: trivial('String', 'login'),
  name: trivial('String', 'name'),
  email: { type: 'String', resolve: () => null },
  databaseId: { type: 'Int', resolve: (value) => databaseIdOf('user', String(value?.login ?? '')) },
});

defineType('Ref', {
  name: trivial('String', 'name'),
  target: { type: 'Commit', resolve: (value) => ({ oid: value?.oid }) },
});

defineType('Commit', {
  oid: trivial('String', 'oid'),
  abbreviatedOid: { type: 'String', resolve: (value) => String(value?.oid ?? '').slice(0, 7) },
});

const ISSUE_STATE = (issue: Issue): string => (issue.state === 'open' ? 'OPEN' : 'CLOSED');

defineType('Issue', {
  id: { type: 'ID', resolve: (value, _args, ctx) => encodeId('Issue', `${value.__repo}#${value.number}`) },
  number: trivial('Int', 'number'),
  title: trivial('String', 'title'),
  body: trivial('String', 'body'),
  state: { type: 'IssueState', resolve: (value) => ISSUE_STATE(value) },
  stateReason: { type: 'String', resolve: () => null },
  createdAt: { type: 'String', resolve: () => '2024-01-01T00:00:00Z' },
  updatedAt: { type: 'String', resolve: () => '2024-01-01T00:00:00Z' },
  author: { type: 'User', resolve: (value) => ({ login: value.user }) },
  url: { type: 'String', resolve: (value) => `/api/v3/repos/${value.__repo}/issues/${value.number}` },
  comments: {
    type: 'IssueCommentConnection',
    resolve: (value) => ({ nodes: value.comments.map((comment: any) => ({ ...comment })) }),
  },
});

defineType('IssueComment', {
  id: { type: 'ID', resolve: (value) => encodeId('IssueComment', String(value.id)) },
  body: trivial('String', 'body'),
  bodyText: trivial('String', 'body'),
  author: { type: 'User', resolve: (value) => ({ login: value.user }) },
  createdAt: { type: 'String', resolve: () => '2024-01-01T00:00:00Z' },
});

defineType('IssueCommentConnection', {
  nodes: { type: '[IssueComment]', resolve: (value) => value?.nodes ?? [] },
  totalCount: { type: 'Int', resolve: (value) => (value?.nodes ?? []).length },
});

defineType('IssueConnection', {
  nodes: { type: '[Issue]', resolve: (value) => value?.nodes ?? [] },
  totalCount: { type: 'Int', resolve: (value) => value?.totalCount ?? (value?.nodes ?? []).length },
  pageInfo: { type: 'PageInfo', resolve: (value) => value?.pageInfo ?? { hasNextPage: false, endCursor: null } },
  edges: {
    type: '[IssueEdge]',
    resolve: (value) => (value?.nodes ?? []).map((node: any) => ({ node })),
  },
});

defineType('IssueEdge', {
  node: { type: 'Issue', resolve: (value) => value?.node },
  cursor: { type: 'String', resolve: () => null },
});

defineType('PageInfo', {
  hasNextPage: trivial('Boolean', 'hasNextPage'),
  hasPreviousPage: { type: 'Boolean', resolve: () => false },
  endCursor: { type: 'String', resolve: (value) => value?.endCursor ?? null },
  startCursor: { type: 'String', resolve: (value) => value?.startCursor ?? null },
});

const pullState = (pull: Pull): string => (pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');

defineType('PullRequest', {
  id: { type: 'ID', resolve: (value, _args, ctx) => encodeId('PullRequest', `${value.__repo}!${value.number}`) },
  number: trivial('Int', 'number'),
  title: trivial('String', 'title'),
  body: trivial('String', 'body'),
  state: { type: 'PullRequestState', resolve: (value) => pullState(value) },
  merged: { type: 'Boolean', resolve: (value) => value.merged === true },
  mergedAt: { type: 'String', resolve: (value) => value.mergedAt ?? null },
  mergeable: { type: 'MergeableState', resolve: (value) => (value.merged ? 'UNKNOWN' : 'MERGEABLE') },
  headRefName: trivial('String', 'head'),
  baseRefName: trivial('String', 'base'),
  isDraft: { type: 'Boolean', resolve: () => false },
  author: { type: 'User', resolve: (value) => ({ login: value.user }) },
  createdAt: { type: 'String', resolve: () => '2024-01-01T00:00:00Z' },
  files: {
    type: 'PullRequestChangedFileConnection',
    resolve: (value: any, _args, ctx) => ({ nodes: changedFiles(ctx, value) }),
  },
});

defineType('PullRequestChangedFile', {
  path: trivial('String', 'path'),
  additions: trivial('Int', 'additions'),
  deletions: trivial('Int', 'deletions'),
});

defineType('PullRequestChangedFileConnection', {
  nodes: { type: '[PullRequestChangedFile]', resolve: (value) => value?.nodes ?? [] },
  totalCount: { type: 'Int', resolve: (value) => (value?.nodes ?? []).length },
});

defineType('PullRequestConnection', {
  nodes: { type: '[PullRequest]', resolve: (value) => value?.nodes ?? [] },
  totalCount: { type: 'Int', resolve: (value) => (value?.nodes ?? []).length },
  pageInfo: { type: 'PageInfo', resolve: () => ({ hasNextPage: false, endCursor: null }) },
});

defineType('Repository', {
  id: { type: 'ID', resolve: (value) => encodeId('Repository', `${value.owner}/${value.name}`) },
  databaseId: { type: 'Int', resolve: (value) => databaseIdOf(value.owner, value.name) },
  name: trivial('String', 'name'),
  nameWithOwner: { type: 'String', resolve: (value) => `${value.owner}/${value.name}` },
  owner: { type: 'User', resolve: (value) => ({ login: value.owner }) },
  description: trivial('String', 'description'),
  isPrivate: trivial('Boolean', 'private'),
  viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
  hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
  defaultBranchRef: {
    type: 'Ref',
    resolve: (value) => {
      const oid = value.refs.get(`refs/heads/${value.defaultBranch}`);
      return oid === undefined ? null : { name: value.defaultBranch, oid };
    },
  },
  issue: {
    type: 'Issue',
    resolve: (value, args) => {
      const number = Number(args.number);
      const found = value.issues.find((issue: Issue) => issue.number === number);
      return found === undefined ? null : { ...found, __repo: `${value.owner}/${value.name}` };
    },
  },
  issues: { type: 'IssueConnection', resolve: issuesConnection },
  pullRequest: {
    type: 'PullRequest',
    resolve: (value, args) => {
      const number = Number(args.number);
      const found = value.pulls.find((pull: Pull) => pull.number === number);
      return found === undefined ? null : { ...found, __repo: `${value.owner}/${value.name}` };
    },
  },
  pullRequests: {
    type: 'PullRequestConnection',
    resolve: (value, args) => {
      const states = Array.isArray(args.states) ? args.states.map(String) : ['OPEN'];
      const want = states.includes('OPEN') || states.length === 0;
      const all: any[] = value.pulls
        .filter((pull: Pull) => (want ? pull.state === 'open' || pull.merged === false : true))
        .filter((pull: Pull) => (want ? pull.state === 'open' : true))
        .map((pull: Pull) => ({ ...pull, __repo: `${value.owner}/${value.name}` }));
      const first = Math.max(0, Math.min(Number(args.first ?? all.length), 100));
      return { nodes: all.slice(0, first), totalCount: all.length };
    },
  },
});

defineType('Query', {
  viewer: { type: 'User', resolve: (_value, _args, ctx) => ({ login: ctx.viewer }) },
  repository: {
    type: 'Repository',
    resolve: (_value, args, ctx) => ctx.forge.get(String(args.owner ?? ''), String(args.name ?? '')),
  },
  node: {
    type: 'Node',
    resolve: (_value, args, ctx) => resolveNode(ctx, String(args.id ?? '')),
  },
});

defineType('Mutation', {
  createIssue: {
    type: 'CreateIssuePayload',
    resolve: (_value, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const repo = repoOfId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) return null;
      repo.nextIssue += 1;
      const issue: Issue = {
        number: repo.nextIssue,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        user: ctx.viewer,
        createdAt: ctx.tick(),
        comments: [],
      };
      repo.issues.push(issue);
      return { issue: { ...issue, __repo: `${repo.owner}/${repo.name}` } };
    },
  },
  closeIssue: {
    type: 'CloseIssuePayload',
    resolve: (_value, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const found = issueOfId(ctx, String(input.issueId ?? ''));
      if (found === null) return null;
      found.issue.state = 'closed';
      return { issue: { ...found.issue, __repo: found.repo } };
    },
  },
  createPullRequest: {
    type: 'CreatePullRequestPayload',
    resolve: (_value, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const repo = repoOfId(ctx, String(input.repositoryId ?? ''));
      if (repo === null) return null;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch);
      if (!repo.refs.has(`refs/heads/${head}`)) return null;
      repo.nextPull += 1;
      const pull: Pull = {
        number: repo.nextPull,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        head,
        base,
        user: ctx.viewer,
        createdAt: ctx.tick(),
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.pulls.push(pull);
      return { pullRequest: { ...pull, __repo: `${repo.owner}/${repo.name}` } };
    },
  },
  mergePullRequest: {
    type: 'MergePullRequestPayload',
    resolve: (_value, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const found = pullOfId(ctx, String(input.pullRequestId ?? ''));
      if (found === null) return null;
      const outcome = performMerge(found.repo, ctx.forge, found.pull, ctx.viewer);
      if (!outcome.ok) return null;
      return { pullRequest: { ...found.pull, __repo: `${found.repo.owner}/${found.repo.name}` } };
    },
  },
  addComment: {
    type: 'AddCommentPayload',
    resolve: (_value, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, any>;
      const found = issueOfId(ctx, String(input.subjectId ?? ''));
      if (found === null) return null;
      found.repo.nextComment += 1;
      const body = String(input.body ?? '');
      const comment = { id: 900_000 + found.repo.nextComment, body, user: ctx.viewer, createdAt: ctx.tick() };
      found.issue.comments.push(comment);
      return { commentEdge: { node: { ...comment } } };
    },
  },
});

defineType('CreateIssuePayload', { issue: { type: 'Issue', resolve: (value) => value?.issue ?? null } });
defineType('CloseIssuePayload', { issue: { type: 'Issue', resolve: (value) => value?.issue ?? null } });
defineType('CreatePullRequestPayload', { pullRequest: { type: 'PullRequest', resolve: (value) => value?.pullRequest ?? null } });
defineType('MergePullRequestPayload', { pullRequest: { type: 'PullRequest', resolve: (value) => value?.pullRequest ?? null } });
defineType('AddCommentPayload', {
  commentEdge: { type: 'IssueCommentEdge', resolve: (value) => value?.commentEdge ?? null },
});
defineType('IssueCommentEdge', { node: { type: 'IssueComment', resolve: (value) => value?.node ?? null } });

// node(id:) answers whatever the id names; the executor picks the type from the concrete value.
defineType('Node', {
  id: { type: 'ID', resolve: (value) => value.__gid },
  name: { type: 'String', resolve: (value) => (value.__kind === 'Repository' ? value.name : null) },
  nameWithOwner: { type: 'String', resolve: (value) => (value.__kind === 'Repository' ? `${value.owner}/${value.name}` : null) },
  login: { type: 'String', resolve: (value) => (value.__kind === 'User' ? value.login : null) },
  number: { type: 'Int', resolve: (value) => (value.__kind === 'Issue' ? value.number : null) },
});

// ------------------------------------------------------------------ introspection

const INTROSPECTION: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'url', 'stateReason'],
  PullRequest: [
    'id',
    'number',
    'title',
    'body',
    'state',
    'merged',
    'mergeable',
    'headRefName',
    'baseRefName',
    'files',
    'author',
    'createdAt',
    'mergedAt',
    'isDraft',
  ],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'description',
    'isPrivate',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequest',
    'pullRequests',
  ],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  IssueComment: ['id', 'body', 'bodyText', 'author', 'createdAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'PULL_REQUEST'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

defineType('__Type', {
  kind: { type: 'String', resolve: (value) => (value?.enumValues ? 'ENUM' : 'OBJECT') },
  name: trivial('String', 'name'),
  description: { type: 'String', resolve: () => null },
  fields: {
    type: '[__Field]',
    resolve: (value) => (value?.fields ?? []).map((name: string) => ({ name })),
  },
  enumValues: {
    type: '[__EnumValue]',
    resolve: (value) => (value?.enumValues ?? []).map((name: string) => ({ name })),
  },
});

defineType('__Field', {
  name: trivial('String', 'name'),
  description: { type: 'String', resolve: () => null },
  isDeprecated: { type: 'Boolean', resolve: () => false },
});

defineType('__EnumValue', {
  name: trivial('String', 'name'),
  description: { type: 'String', resolve: () => null },
  isDeprecated: { type: 'Boolean', resolve: () => false },
});

// ------------------------------------------------------------------ lookups

function repoOfId(ctx: Runtime, id: string): Repo | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const slash = decoded.key.indexOf('/');
  if (slash < 0) return null;
  return ctx.forge.get(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
}

function issueOfId(ctx: Runtime, id: string): { repo: Repo; issue: Issue; repoKey: string } | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const nameKey = decoded.key.slice(0, hash);
  const number = Number(decoded.key.slice(hash + 1));
  const slash = nameKey.indexOf('/');
  if (slash < 0) return null;
  const repo = ctx.forge.get(nameKey.slice(0, slash), nameKey.slice(slash + 1));
  if (repo === null) return null;
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) return null;
  return { repo, issue, repoKey: `${repo.owner}/${repo.name}` };
}

function pullOfId(ctx: Runtime, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const bang = decoded.key.lastIndexOf('!');
  if (bang < 0) return null;
  const nameKey = decoded.key.slice(0, bang);
  const number = Number(decoded.key.slice(bang + 1));
  const slash = nameKey.indexOf('/');
  if (slash < 0) return null;
  const repo = ctx.forge.get(nameKey.slice(0, slash), nameKey.slice(slash + 1));
  if (repo === null) return null;
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) return null;
  return { repo, pull };
}

function resolveNode(ctx: Runtime, id: string): Record<string, unknown> | null {
  const decoded = decodeId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoOfId(ctx, id);
    if (repo === null) return null;
    return { ...repo, __kind: 'Repository', __gid: id };
  }
  if (decoded.kind === 'Issue') {
    const found = issueOfId(ctx, id);
    if (found === null) return null;
    return { ...found.issue, __repo: found.repoKey, __kind: 'Issue', __gid: id };
  }
  if (decoded.kind === 'PullRequest') {
    const found = pullOfId(ctx, id);
    if (found === null) return null;
    return { ...found.pull, __repo: `${found.repo.owner}/${found.repo.name}`, __kind: 'PullRequest', __gid: id };
  }
  return null;
}

function issuesConnection(repo: Repo, args: Record<string, any>): Record<string, unknown> {
  const states = Array.isArray(args.states) && args.states.length > 0 ? args.states.map(String) : ['OPEN'];
  const wantOpen = states.includes('OPEN');
  const wantClosed = states.includes('CLOSED');
  let list = repo.issues.filter((issue) => (issue.state === 'open' ? wantOpen : wantClosed));
  const order = args.orderBy as Record<string, any> | undefined;
  const direction = String(order?.direction ?? 'DESC').toUpperCase();
  const field = String(order?.field ?? 'CREATED_AT').toUpperCase();
  if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
    list = [...list].sort((a, b) => (direction === 'ASC' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
    // ties break by number so the order is total
    list = [...list].sort((a, b) => {
      const delta = a.createdAt - b.createdAt;
      if (delta !== 0) return direction === 'ASC' ? delta : -delta;
      return direction === 'ASC' ? a.number - b.number : b.number - a.number;
    });
  }
  const total = list.length;
  const firstRaw = Number(args.first ?? total);
  const first = Number.isFinite(firstRaw) && firstRaw > 0 ? Math.min(Math.floor(firstRaw), 100) : total;
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const parsed = Number(decoded.replace(/^cursor:/, ''));
    if (Number.isFinite(parsed) && parsed >= 0) start = parsed;
  }
  const slice = list.slice(start, start + first);
  const nextIndex = start + slice.length;
  const hasNextPage = nextIndex < total;
  return {
    nodes: slice.map((issue) => ({ ...issue, __repo: `${repo.owner}/${repo.name}` })),
    totalCount: total,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      endCursor: hasNextPage || slice.length > 0 ? Buffer.from(`cursor:${nextIndex}`, 'utf8').toString('base64') : null,
      startCursor: slice.length > 0 ? Buffer.from(`cursor:${start}`, 'utf8').toString('base64') : null,
    },
  };
}

function changedFiles(ctx: Runtime, pull: any): { path: string; additions: number; deletions: number }[] {
  const repo = ctx.forge.get(...splitRepoKey(pull.__repo));
  if (repo === null) return [];
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) return [];
  const before = flatTree(repo, baseTip);
  const after = flatTree(repo, headTip);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const out: { path: string; additions: number; deletions: number }[] = [];
  for (const path of [...paths].sort()) {
    const left = before.get(path);
    const right = after.get(path);
    if (left !== undefined && right !== undefined && left.equals(right)) continue;
    out.push({
      path,
      additions: right === undefined ? 0 : countLines(right),
      deletions: left === undefined ? 0 : countLines(left),
    });
  }
  return out;
}

function splitRepoKey(key: string): [string, string] {
  const slash = key.indexOf('/');
  if (slash < 0) return [key, ''];
  return [key.slice(0, slash), key.slice(slash + 1)];
}

function flatTree(repo: Repo, commitOid: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return out;
  const info = parseCommit(commit.data);
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else {
        const blob = repo.objects.get(entry.oid);
        out.set(path, blob === undefined ? Buffer.alloc(0) : blob.data);
      }
    }
  };
  walk(info.tree, '');
  return out;
}

function countLines(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

// ------------------------------------------------------------------ executor

interface ExecCtx {
  runtime: Runtime;
  fragments: Map<string, FragmentDef>;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

function resolveArgs(args: Arg[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = resolveValue(arg.value, ctx);
  return out;
}

function resolveValue(value: Value, ctx: ExecCtx): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, ctx));
  if ('$var' in value) return ctx.variables[value.$var];
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry as Value, ctx);
  return out;
}

function typeOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'String';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Int' : 'Float';
  if (typeof value === 'boolean') return 'Boolean';
  if (Array.isArray(value)) return 'list';
  const tagged = value as Record<string, unknown>;
  if (typeof tagged.__kind === 'string') return tagged.__kind;
  return 'object';
}

function typenameOf(value: unknown, declared: string): string {
  if (value === null || value === undefined) return declared;
  const tagged = value as Record<string, any>;
  if (typeof tagged.__kind === 'string') return tagged.__kind;
  return declared;
}

function applySelection(value: unknown, declaredType: string, selection: Selection[], ctx: ExecCtx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => applySelection(entry, declaredType, selection, ctx, [...path, index]));
  }
  const typename = typenameOf(value, declaredType);
  if (selection.length === 0) {
    // scalar leaf: hand the raw value back unless it is a tagged object
    if (typename !== declaredType && typeof value === 'object') {
      const tagged = value as Record<string, any>;
      const key = Object.keys(tagged).find((candidate) => !candidate.startsWith('__'));
      return key === undefined ? null : tagged[key];
    }
    return value;
  }
  const fields = REGISTRY[typename] ?? {};
  const out: Record<string, unknown> = {};
  const walk = (entries: Selection[]): void => {
    for (const entry of entries) {
      if (entry.kind === 'spread') {
        const fragment = ctx.fragments.get(entry.name);
        if (fragment === undefined) {
          ctx.errors.push({ message: `Unknown fragment "${entry.name}".` });
          continue;
        }
        if (matchesType(fragment.on, typename)) walk(fragment.selection);
        continue;
      }
      if (entry.kind === 'inline') {
        if (entry.on === undefined || matchesType(entry.on, typename)) walk(entry.selection);
        continue;
      }
      const key = entry.alias ?? entry.name;
      if (entry.name === '__typename') {
        out[key] = typename;
        continue;
      }
      if (entry.name === '__type') {
        const args = resolveArgs(entry.args, ctx);
        const name = String(args.name ?? '');
        const known = INTROSPECTION[name];
        const enumValues = ENUMS[name];
        if (known === undefined && enumValues === undefined) {
          out[key] = null;
          ctx.errors.push({ message: `Unknown type "${name}".` });
          continue;
        }
        const node = known === undefined ? { name, enumValues } : { name, fields: known };
        out[key] = applySelection(node, '__Type', entry.selection, ctx, [...path, key]);
        continue;
      }
      const spec = fields[entry.name];
      if (spec === undefined) {
        ctx.errors.push({ message: `Cannot query field "${entry.name}" on type "${typename}".`, path: [...path, key] });
        out[key] = null;
        continue;
      }
      let args: Record<string, unknown> = {};
      try {
        args = resolveArgs(entry.args, ctx);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
        continue;
      }
      const declared = spec.type.replace(/[[\]!]/g, '');
      let produced: unknown;
      try {
        produced = spec.resolve(value, args, ctx.runtime);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
        out[key] = null;
        continue;
      }
      out[key] = applySelection(produced, declared, entry.selection, ctx, [...path, key]);
    }
  };
  walk(selection);
  return out;
}

function matchesType(condition: string, actual: string): boolean {
  if (condition === actual) return true;
  if (condition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User'].includes(actual);
  return false;
}

// ------------------------------------------------------------------ transport

export interface GraphQLContext {
  forge: Forge;
  viewer: string;
  body: Buffer;
  token: string | null;
}

export function handleGraphQL(ctx: GraphQLContext): { status: number; body: unknown } {
  if (ctx.token === null) return { status: 401, body: { message: 'Requires authentication' } };

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(ctx.body.toString('utf8') || '{}');
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }

  const runtime: Runtime = {
    forge: ctx.forge,
    viewer: ctx.viewer,
    tick: () => ctx.forge.tick(),
  };

  if (Array.isArray(parsedBody)) {
    const answers = parsedBody.map((entry) => runOne(entry, runtime));
    return { status: 200, body: answers };
  }
  return { status: 200, body: runOne(parsedBody, runtime) };
}

function runOne(entry: unknown, runtime: Runtime): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) {
    return { data: null, errors: [{ message: 'a request entry is not a JSON object' }] };
  }
  const request = entry as Record<string, unknown>;
  const document = typeof request.query === 'string' ? request.query : '';
  const variables = typeof request.variables === 'object' && request.variables !== null ? (request.variables as Record<string, unknown>) : {};
  if (document.trim() === '') return { data: null, errors: [{ message: 'no query document was sent' }] };

  let operations: Operation[];
  let fragments: Map<string, FragmentDef>;
  try {
    const parsed = new Parser(document).parseDocument();
    operations = parsed.operations;
    fragments = parsed.fragments;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }

  const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
  const operation =
    operationName === undefined
      ? operations[0]
      : operations.find((candidate) => candidate.name === operationName);
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation matched the request' }] };

  const merged: Record<string, unknown> = { ...variables };
  for (const declared of operation.variables) {
    if (merged[declared.name] === undefined && declared.default !== undefined) {
      merged[declared.name] = declared.default;
    }
  }

  const ctx: ExecCtx = { runtime, fragments, variables: merged, errors: [] };
  const root = operation.operation === 'mutation' ? 'Mutation' : operation.operation === 'subscription' ? 'Subscription' : 'Query';
  let data: unknown = null;
  try {
    data = applySelection({}, root, operation.selection, ctx, []);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
  }

  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

export const GRAPHQL_ENDPOINT = '/api/graphql';

/** Kept for parity with the object model: a repo's first commit, used by nothing yet. */
export function headOf(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}
