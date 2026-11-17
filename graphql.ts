// GitHub GraphQL v4: a small parser and executor for exactly the documents
// gh and github-mcp-server send (viewer, repository reads, issue and pull
// request reads, the create/close/merge mutations, introspection probes and
// batched operations). Unknown fields answer HTTP 200 with an errors array
// naming the field; an unknown repository reads data.repository = null with
// no errors; global ids are opaque base64 and never the bare database id.

import type { ServerResponse } from 'node:http';
import { jsonError, parseJsonBody, sendJson, type Req } from './httputil.ts';
import { shopToken } from './scenario.ts';
import { Store, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------- tokenizer

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const raw = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

type SelectionNode =
  | { kind: 'Field'; alias: string | null; name: string; args: ArgumentNode[]; selections: SelectionNode[] | null }
  | { kind: 'FragmentSpread'; name: string }
  | { kind: 'InlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

interface VariableDef {
  name: string;
  defaultValue: ValueNode | null;
}

interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefs: VariableDef[];
  selections: SelectionNode[];
}

interface Fragment {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        operations.push({ operation: 'query', name: null, variableDefs: [], selections: this.parseSelectionSet() });
      } else if (this.peek().kind === 'name' && (this.peek().value === 'query' || this.peek().value === 'mutation')) {
        operations.push(this.parseOperation());
      } else if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        throw new Error(`unexpected token ${this.peek().value}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const operation = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variableDefs: VariableDef[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefs.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { operation, name, variableDefs, selections };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseFragment(): Fragment {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { name, typeCondition, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'FragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'InlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'Field', alias, name, args, selections };
  }

  private parseArguments(): ArgumentNode[] {
    this.expectPunct('(');
    const args: ArgumentNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'int') return { kind: 'Int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'Float', value: parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- schema

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  User: ['login'],
  IssueConnection: ['nodes', 'pageInfo'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  Ref: ['name'],
  Node: ['id'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PULL_REQUEST'],
  IssueState: ['OPEN', 'CLOSED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

interface GqlError {
  message: string;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, Fragment>;
  errors: GqlError[];
}

type GqlValue =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __type: 'PullRequestConnection'; pulls: { repo: Repo; pull: Pull }[] }
  | { __type: 'PullRequestChangedFileConnection'; files: { path: string }[] }
  | { __type: 'PullRequestChangedFile'; path: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'Ref'; name: string }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __type: 'AddCommentPayload'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __type: 'IssueCommentEdge'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __type: 'IssueComment'; id: number; body: string }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | null;

function globalId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { kind: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name] ?? null;
    case 'String':
      return node.value;
    case 'Int':
    case 'Float':
      return node.value;
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((v) => resolveValue(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsMap(field: { args: ArgumentNode[] }, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

/** Validate selections against the schema; collect unknown-field errors. */
function validateSelections(selections: SelectionNode[], parentType: string, ctx: ExecContext): void {
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) validateSelections(fragment.selections, fragment.typeCondition, ctx);
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      validateSelections(selection.selections, selection.typeCondition ?? parentType, ctx);
      continue;
    }
    if (selection.name === '__typename') continue;
    const fields = SCHEMA_FIELDS[parentType];
    if (!fields || !fields.includes(selection.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      continue;
    }
    if (selection.selections !== null) {
      const childType = childTypeOf(parentType, selection.name);
      if (childType !== null) validateSelections(selection.selections, childType, ctx);
    }
  }
}

function childTypeOf(parentType: string, field: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
    Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
    PullRequest: { files: 'PullRequestChangedFileConnection' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    IssueCommentEdge: { node: 'IssueComment' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return map[parentType]?.[field] ?? null;
}

// ---------------------------------------------------------------- execution

function executeSelections(selections: SelectionNode[], parent: GqlValue, parentType: string, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) continue;
      Object.assign(out, executeSelections(fragment.selections, parent, fragment.typeCondition, ctx));
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType && selection.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(selection.selections, parent, selection.typeCondition ?? parentType, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    const child = resolveField(selection, parent, parentType, ctx);
    if (selection.selections !== null && child !== null && typeof child === 'object' && '__type' in (child as Record<string, unknown>)) {
      // Sub-selections run against the runtime type of the value (so `node`
      // answers its `... on Repository` fragment with the repository type).
      const childType = (child as { __type: string }).__type;
      out[key] = executeSelections(selection.selections, child as GqlValue, childType, ctx);
    } else if (selection.selections !== null && Array.isArray(child)) {
      out[key] = child.map((item) => {
        if (item !== null && typeof item === 'object' && '__type' in (item as Record<string, unknown>)) {
          return executeSelections(selection.selections as SelectionNode[], item as GqlValue, (item as { __type: string }).__type, ctx);
        }
        return item;
      });
    } else {
      out[key] = child;
    }
  }
  return out;
}

function findRepo(ctx: ExecContext, owner: string, name: string): Repo | null {
  return ctx.store.getRepo(owner, name) ?? null;
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __type: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): GqlValue {
  return { __type: 'PullRequest', repo, pull };
}

function resolveField(field: { name: string; args: ArgumentNode[]; selections: SelectionNode[] | null }, parent: GqlValue, parentType: string, ctx: ExecContext): unknown {
  const args = argsMap(field, ctx);
  const store = ctx.store;

  if (parentType === 'Query') {
    if (field.name === 'viewer') return { __type: 'User', login: store.identity.viewerLogin } as GqlValue;
    if (field.name === 'repository') {
      const repo = findRepo(ctx, String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : ({ __type: 'Repository', repo } as GqlValue);
    }
    if (field.name === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repoId = parseInt(parsed.payload, 10);
        for (const repo of store.repos.values()) {
          if (repo.id === repoId) return { __type: 'Repository', repo } as GqlValue;
        }
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (SCHEMA_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) return { __type: '__Type', name } as GqlValue;
      return null;
    }
    if (field.name === '__schema') return null;
    return null;
  }

  if (parentType === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (parsed === null || parsed.kind !== 'Repository') {
        ctx.errors.push({ message: 'createIssue: unknown repository id' });
        return null;
      }
      const repoId = parseInt(parsed.payload, 10);
      const repo = [...store.repos.values()].find((r) => r.id === repoId);
      if (!repo) {
        ctx.errors.push({ message: 'createIssue: repository not found' });
        return null;
      }
      const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __type: 'CreateIssuePayload', repo, issue } as GqlValue;
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (parsed === null || parsed.kind !== 'Issue') {
        ctx.errors.push({ message: 'closeIssue: unknown issue id' });
        return null;
      }
      const [repoId, number] = parsed.payload.split(':');
      const repo = [...store.repos.values()].find((r) => r.id === parseInt(repoId ?? '', 10));
      const issue = repo?.issues.find((i) => i.number === parseInt(number ?? '', 10));
      if (!repo || !issue) {
        ctx.errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      issue.state = 'closed';
      return { __type: 'CloseIssuePayload', repo, issue } as GqlValue;
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (parsed === null || parsed.kind !== 'Repository') {
        ctx.errors.push({ message: 'createPullRequest: unknown repository id' });
        return null;
      }
      const repoId = parseInt(parsed.payload, 10);
      const repo = [...store.repos.values()].find((r) => r.id === repoId);
      if (!repo) {
        ctx.errors.push({ message: 'createPullRequest: repository not found' });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) {
        ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return null;
      }
      const pull = store.createPull(repo, String(input.title ?? ''), '', headRef, baseRef, headSha, baseSha);
      return { __type: 'CreatePullRequestPayload', repo, pull } as GqlValue;
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (parsed === null || parsed.kind !== 'PullRequest') {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request id' });
        return null;
      }
      const [repoId, number] = parsed.payload.split(':');
      const repo = [...store.repos.values()].find((r) => r.id === parseInt(repoId ?? '', 10));
      const pull = repo?.pulls.find((p) => p.number === parseInt(number ?? '', 10));
      if (!repo || !pull) {
        ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      const result = store.squashMerge(repo, pull);
      if ('error' in result) {
        ctx.errors.push({ message: `mergePullRequest: ${result.error}` });
        return null;
      }
      return { __type: 'MergePullRequestPayload', repo, pull } as GqlValue;
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (parsed === null || parsed.kind !== 'Issue') {
        ctx.errors.push({ message: 'addComment: unknown subject id' });
        return null;
      }
      const [repoId, number] = parsed.payload.split(':');
      const repo = [...store.repos.values()].find((r) => r.id === parseInt(repoId ?? '', 10));
      const issue = repo?.issues.find((i) => i.number === parseInt(number ?? '', 10));
      if (!repo || !issue) {
        ctx.errors.push({ message: 'addComment: issue not found' });
        return null;
      }
      const comment = store.createComment(repo, issue, String(input.body ?? ''));
      return { __type: 'AddCommentPayload', repo, issue, commentId: comment.id, body: comment.body } as GqlValue;
    }
    return null;
  }

  if (parent === null) return null;

  if (parentType === 'Repository' && parent.__type === 'Repository') {
    const repo = parent.repo;
    switch (field.name) {
      case 'id':
        return globalId('Repository', String(repo.id));
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __type: 'User', login: repo.owner } as GqlValue;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : ({ __type: 'Ref', name: repo.defaultBranch } as GqlValue);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === (args.number as number));
        return issue ? issueValue(repo, issue) : null;
      }
      case 'issues': {
        const first = typeof args.first === 'number' ? args.first : 10;
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const after = typeof args.after === 'string' ? args.after : null;
        let items = [...repo.issues];
        if (states !== null) {
          const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
          items = items.filter((i) => wanted.has(i.state));
        }
        const direction = orderBy.direction === 'ASC' ? 1 : -1;
        items.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
        if (after !== null) {
          const cursorNumber = decodeCursor(after);
          if (cursorNumber !== null) {
            const idx = items.findIndex((i) => i.number === cursorNumber);
            if (idx >= 0) items = items.slice(idx + 1);
          }
        }
        const page = items.slice(0, Math.max(0, first));
        const hasNextPage = items.length > page.length;
        const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null;
        return {
          __type: 'IssueConnection',
          repo,
          issues: page,
          pageInfo: { hasNextPage, endCursor },
        } as GqlValue;
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 10;
        const pulls = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, Math.max(0, first));
        return { __type: 'PullRequestConnection', pulls: pulls.map((pull) => ({ repo, pull })) } as GqlValue;
      }
      case 'pullRequest': {
        const pull = repo.pulls.find((p) => p.number === (args.number as number));
        return pull ? pullValue(repo, pull) : null;
      }
    }
    return null;
  }

  if (parentType === 'Issue' && parent.__type === 'Issue') {
    const issue = parent.issue;
    switch (field.name) {
      case 'id':
        return globalId('Issue', `${parent.repo.id}:${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
    }
    return null;
  }

  if (parentType === 'PullRequest' && parent.__type === 'PullRequest') {
    const pull = parent.pull;
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', `${parent.repo.id}:${pull.number}`);
      case 'number':
        return pull.number;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return store.mergeableState(parent.repo, pull);
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 10;
        const baseTree = store.commitTree(parent.repo, pull.baseSha);
        const headTree = store.commitTree(parent.repo, pull.headSha);
        const files = store.diffTrees(parent.repo, baseTree, headTree).slice(0, Math.max(0, first));
        return {
          __type: 'PullRequestChangedFileConnection',
          files: files.map((f) => ({ path: f.filename })),
        } as GqlValue;
      }
    }
    return null;
  }

  if (parentType === 'User' && parent.__type === 'User') {
    if (field.name === 'login') return parent.login;
    return null;
  }

  if (parentType === 'Ref' && parent.__type === 'Ref') {
    if (field.name === 'name') return parent.name;
    return null;
  }

  if (parentType === 'IssueConnection' && parent.__type === 'IssueConnection') {
    if (field.name === 'nodes') return parent.issues.map((issue) => issueValue(parent.repo, issue));
    if (field.name === 'pageInfo') return { __type: 'PageInfo', ...parent.pageInfo } as GqlValue;
    return null;
  }

  if (parentType === 'PullRequestConnection' && parent.__type === 'PullRequestConnection') {
    if (field.name === 'nodes') {
      return parent.pulls.map((entry) => pullValue(entry.repo, entry.pull));
    }
    return null;
  }

  if (parentType === 'PullRequestChangedFileConnection' && parent.__type === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') {
      return parent.files.map((file) => ({ __type: 'PullRequestChangedFile', path: file.path }) as GqlValue);
    }
    return null;
  }

  if (parentType === 'PullRequestChangedFile' && parent.__type === 'PullRequestChangedFile') {
    if (field.name === 'path') return parent.path;
    return null;
  }

  if (parentType === 'PageInfo' && parent.__type === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent.hasNextPage;
    if (field.name === 'endCursor') return parent.endCursor;
    return null;
  }

  if (parentType === 'CreateIssuePayload' && parent.__type === 'CreateIssuePayload') {
    if (field.name === 'issue') return issueValue(parent.repo, parent.issue);
    return null;
  }
  if (parentType === 'CloseIssuePayload' && parent.__type === 'CloseIssuePayload') {
    if (field.name === 'issue') return issueValue(parent.repo, parent.issue);
    return null;
  }
  if (parentType === 'CreatePullRequestPayload' && parent.__type === 'CreatePullRequestPayload') {
    if (field.name === 'pullRequest') return pullValue(parent.repo, parent.pull);
    return null;
  }
  if (parentType === 'MergePullRequestPayload' && parent.__type === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return pullValue(parent.repo, parent.pull);
    return null;
  }
  if (parentType === 'AddCommentPayload' && parent.__type === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return { __type: 'IssueCommentEdge', repo: parent.repo, issue: parent.issue, commentId: parent.commentId, body: parent.body } as GqlValue;
    return null;
  }
  if (parentType === 'IssueCommentEdge' && parent.__type === 'IssueCommentEdge') {
    if (field.name === 'node') return { __type: 'IssueComment', id: parent.commentId, body: parent.body } as GqlValue;
    return null;
  }
  if (parentType === 'IssueComment' && parent.__type === 'IssueComment') {
    if (field.name === 'id') return globalId('IssueComment', String(parent.id));
    if (field.name === 'body') return parent.body;
    return null;
  }

  if (parentType === '__Type' && parent.__type === '__Type') {
    const name = parent.name;
    if (field.name === 'name') return name;
    if (field.name === 'kind') return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
    if (field.name === 'fields') {
      const fields = SCHEMA_FIELDS[name] ?? [];
      return fields.map((f) => ({ __type: '__Field', name: f }) as GqlValue);
    }
    if (field.name === 'enumValues') {
      const values = ENUM_VALUES[name] ?? [];
      return values.map((v) => ({ __type: '__EnumValue', name: v }) as GqlValue);
    }
    return null;
  }
  if (parentType === '__Field' && parent.__type === '__Field') {
    if (field.name === 'name') return parent.name;
    return null;
  }
  if (parentType === '__EnumValue' && parent.__type === '__EnumValue') {
    if (field.name === 'name') return parent.name;
    return null;
  }

  return null;
}

// ---------------------------------------------------------------- handler

interface GraphQLOperationBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(body: GraphQLOperationBody, store: Store): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'failed to parse query' }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation in document' }] };
  }
  let operation = doc.operations[0] as Operation;
  if (operationName !== null) {
    const named = doc.operations.find((o) => o.name === operationName);
    if (!named) return { data: null, errors: [{ message: `unknown operation ${operationName}` }] };
    operation = named;
  }
  const ctx: ExecContext = { store, variables, fragments: doc.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(operation.selections, rootType, ctx);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  const data = executeSelections(operation.selections, null, rootType, ctx);
  if (ctx.errors.length > 0) {
    return { data, errors: ctx.errors };
  }
  return { data };
}

export function handleGraphQL(req: Req, res: ServerResponse, store: Store): boolean {
  if (req.path !== '/api/graphql' || req.method !== 'POST') return false;
  const token = req.headers.authorization;
  if (typeof token !== 'string' || !token.startsWith('Bearer ')) {
    jsonError(res, req.requestId, 401, 'Bad credentials');
    return true;
  }
  const expected = shopToken();
  if (expected !== null && token.slice('Bearer '.length).trim() !== expected) {
    jsonError(res, req.requestId, 401, 'Bad credentials');
    return true;
  }
  const parsed = parseJsonBody(req.body);
  if (!parsed.ok) {
    sendJson(res, req.requestId, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  if (Array.isArray(parsed.value)) {
    const results = parsed.value.map((item) => executeOperation((item ?? {}) as GraphQLOperationBody, store));
    sendJson(res, req.requestId, 200, results);
    return true;
  }
  if (parsed.value !== null && typeof parsed.value === 'object') {
    sendJson(res, req.requestId, 200, executeOperation(parsed.value as GraphQLOperationBody, store));
    return true;
  }
  sendJson(res, req.requestId, 400, { errors: [{ message: 'GraphQL body must be an object or an array' }] });
  return true;
}
