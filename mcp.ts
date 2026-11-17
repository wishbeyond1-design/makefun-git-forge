// Model Context Protocol over Streamable HTTP: the modern server/discover
// path (revision 2026-07-28) and the legacy initialize handshake, tools/list
// with the six github-mcp-server tools, and tools/call over the same store
// the REST and GraphQL surfaces use. Answers are plain JSON bodies; a
// notification gets an empty 202. Unknown tools answer -32602 or -32601,
// never HTTP 500; a missing token answers HTTP 401.

import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { isRecord, jsonError, sendJson, type Req } from './httputil.ts';
import { shopToken } from './scenario.ts';
import { Store } from './store.ts';

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the viewer).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name: string): ToolDef | null {
  const wanted = normalizeToolName(name);
  for (const tool of TOOLS) {
    const candidate = normalizeToolName(tool.name);
    if (candidate === wanted || wanted.endsWith(candidate)) return tool;
  }
  return null;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(res: ServerResponse, requestId: string, id: unknown, result: unknown, sessionId?: string): void {
  const headers: Record<string, string> = {};
  if (sessionId) headers['mcp-session-id'] = sessionId;
  sendJson(res, requestId, 200, { jsonrpc: '2.0', id: id ?? null, result }, headers);
}

function rpcError(res: ServerResponse, requestId: string, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, requestId, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const missing = tool.inputSchema.required.filter((prop) => args[prop] === undefined || args[prop] === null || args[prop] === '');
  if (missing.length > 0) {
    return toolError(`Missing required argument(s): ${missing.join(', ')}`);
  }
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.identity.viewerLogin;
  const repoName = String(args.repo ?? args.name ?? '');

  switch (tool.name) {
    case 'create_repo': {
      const name = String(args.name ?? '');
      if (store.getRepo(owner, name)) return toolError(`Repository ${owner}/${name} already exists`);
      const repo = store.createRepo(owner, name, args.private === true, typeof args.description === 'string' ? args.description : '');
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: repo.owner,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: repo.owner,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'all';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      return toolResult(issues.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state })));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError(`Head or base branch does not exist: ${head} -> ${base}`);
      const pull = store.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
      return toolResult({
        id: pull.id,
        number: pull.number,
        pull_number: pull.number,
        title: pull.title,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolError(`Pull request #${number} not found`);
      const result = store.squashMerge(repo, pull);
      if ('error' in result) return toolError(result.error);
      return toolResult({ merged: true, number: pull.number, sha: result.sha, state: pull.state });
    }
    default:
      return toolError(`Tool ${tool.name} is not implemented`);
  }
}

export function handleMcp(req: Req, res: ServerResponse, store: Store): boolean {
  if (req.path !== '/mcp') return false;
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'x-github-request-id': req.requestId });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    jsonError(res, req.requestId, 405, 'Method Not Allowed');
    return true;
  }
  let body: unknown;
  try {
    body = req.body.length === 0 ? null : JSON.parse(req.body.toString('utf8'));
  } catch {
    rpcError(res, req.requestId, 400, null, -32700, 'Parse error');
    return true;
  }
  if (!isRecord(body)) {
    rpcError(res, req.requestId, 400, null, -32600, 'Invalid Request');
    return true;
  }
  const message = body as JsonRpcRequest;
  const id = message.id ?? null;
  const method = typeof message.method === 'string' ? message.method : '';

  // Notifications carry no id and get no JSON-RPC answer.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': req.requestId });
    res.end();
    return true;
  }

  // Every MCP call needs the shop token.
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    rpcError(res, req.requestId, 401, id, -32000, 'Unauthorized');
    return true;
  }
  const expected = shopToken();
  if (expected !== null && auth.slice('Bearer '.length).trim() !== expected) {
    rpcError(res, req.requestId, 401, id, -32000, 'Unauthorized');
    return true;
  }

  if (method === 'server/discover') {
    rpcResult(res, req.requestId, id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }

  if (method === 'initialize') {
    const params = isRecord(message.params) ? message.params : {};
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0] ?? '2026-07-28';
    rpcResult(
      res,
      req.requestId,
      id,
      {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      },
      `sess-${randomBytes(8).toString('hex')}`,
    );
    return true;
  }

  if (method === 'ping') {
    rpcResult(res, req.requestId, id, {});
    return true;
  }

  if (method === 'tools/list') {
    rpcResult(res, req.requestId, id, { tools: TOOLS });
    return true;
  }

  if (method === 'tools/call') {
    const params = isRecord(message.params) ? message.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = findTool(name);
    if (tool === null) {
      rpcError(res, req.requestId, 200, id, -32602, `Unknown tool: ${name}`);
      return true;
    }
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    rpcResult(res, req.requestId, id, callTool(store, tool, args));
    return true;
  }

  rpcError(res, req.requestId, 200, id, -32601, `Method not found: ${method}`);
  return true;
}
