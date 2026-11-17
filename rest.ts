// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests, files and merges. Shapes and statuses follow the
// suite's checks-rest.ts: exact statuses, X-GitHub-Request-Id on every
// answer, JSON error bodies with a string message, Link pagination on lists.

import type { ServerResponse } from 'node:http';
import { parseCommit, parseTree } from './gitcore.ts';
import {
  bearerToken,
  decodeSegment,
  isRecord,
  jsonError,
  parseJsonBody,
  sendJson,
  type Req,
} from './httputil.ts';
import { shopToken } from './scenario.ts';
import { Store, type Issue, type Pull, type Repo } from './store.ts';

const INSTALLED_VERSION = '1.0.0';

type AuthResult = 'ok' | 'missing' | 'invalid';

function checkAuth(req: Req): AuthResult {
  const token = bearerToken(req.headers);
  if (token === null) return 'missing';
  const expected = shopToken();
  if (expected === null) return 'ok';
  return token === expected ? 'ok' : 'invalid';
}

function requireAuth(req: Req, res: ServerResponse): boolean {
  const auth = checkAuth(req);
  if (auth !== 'ok') {
    jsonError(res, req.requestId, 401, 'Bad credentials');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

// ---------------------------------------------------------------- pagination

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(req: Req): PageParams {
  const perPage = Math.max(1, Math.min(100, parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(req.query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function pageSlice<T>(items: T[], params: PageParams): T[] {
  const start = (params.page - 1) * params.perPage;
  return items.slice(start, start + params.perPage);
}

function linkHeader(req: Req, total: number, params: PageParams): string {
  const host = req.headers.host ?? 'localhost';
  const totalPages = Math.max(1, Math.ceil(total / params.perPage));
  const base = `http://${host}${req.path}`;
  const links: string[] = [];
  const query = new URLSearchParams(req.query);
  const urlFor = (page: number): string => {
    query.set('page', String(page));
    query.set('per_page', String(params.perPage));
    return `<${base}?${query.toString()}>`;
  };
  if (params.page < totalPages) links.push(`${urlFor(params.page + 1)}; rel="next"`);
  if (params.page > 1) links.push(`${urlFor(params.page - 1)}; rel="prev"`);
  links.push(`${urlFor(1)}; rel="first"`);
  links.push(`${urlFor(totalPages)}; rel="last"`);
  return links.join(', ');
}

function sendList<T>(req: Req, res: ServerResponse, items: T[], params: PageParams): void {
  const page = pageSlice(items, params);
  sendJson(res, req.requestId, 200, page, { link: linkHeader(req, items.length, params) });
}

// ---------------------------------------------------------------- routing helpers

interface RepoRoute {
  owner: string;
  repoName: string;
  tail: string[];
}

/** Match /api/v3/repos/:owner/:repo[/...]. */
function matchRepoRoute(path: string): RepoRoute | null {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'v3' || parts[2] !== 'repos') return null;
  return {
    owner: decodeSegment(parts[3] as string),
    repoName: decodeSegment(parts[4] as string),
    tail: parts.slice(5).map(decodeSegment),
  };
}

function jsonBody(req: Req, res: ServerResponse): Record<string, unknown> | null {
  const parsed = parseJsonBody(req.body);
  if (!parsed.ok) {
    jsonError(res, req.requestId, 400, 'Problems parsing JSON');
    return null;
  }
  if (parsed.value === null) return {};
  if (!isRecord(parsed.value)) {
    jsonError(res, req.requestId, 400, 'Problems parsing JSON');
    return null;
  }
  return parsed.value;
}

function lookupRepoOr404(req: Req, res: ServerResponse, store: Store, owner: string, repoName: string): Repo | null {
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    jsonError(res, req.requestId, 404, 'Not Found');
    return null;
  }
  return repo;
}

function parseNumberSegment(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  return parseInt(segment, 10);
}

// ---------------------------------------------------------------- the handler

export function handleRest(req: Req, res: ServerResponse, store: Store): boolean {
  const { method, path } = req;

  // API root and meta: no auth, as the starter answers them.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, req.requestId, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, req.requestId, 200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: false });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    if (!requireAuth(req, res)) return true;
    sendJson(res, req.requestId, 200, { login: store.identity.viewerLogin, id: store.identity.viewerId });
    return true;
  }

  // POST /api/v3/user/repos and GET /api/v3/user/repos.
  if (path === '/api/v3/user/repos') {
    if (!requireAuth(req, res)) return true;
    if (method === 'POST') {
      const body = jsonBody(req, res);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        jsonError(res, req.requestId, 422, 'Invalid repository name');
        return true;
      }
      if (store.getRepoByName(name)) {
        jsonError(res, req.requestId, 422, 'Repository already exists');
        return true;
      }
      const isPrivate = body.private === true;
      const description = typeof body.description === 'string' ? body.description : '';
      const repo = store.createRepo(store.identity.viewerLogin, name, isPrivate, description);
      sendJson(res, req.requestId, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const params = pageParams(req);
      sendList(req, res, store.listViewerRepos().map(repoJson), params);
      return true;
    }
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }

  // Everything under /api/v3/repos/:owner/:repo.
  const route = matchRepoRoute(path);
  if (route !== null) {
    return handleRepoRoute(req, res, store, route);
  }

  // Unknown /api/v3 route: JSON 404 (only when the path is under the prefix).
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }
  return false;
}

function handleRepoRoute(req: Req, res: ServerResponse, store: Store, route: RepoRoute): boolean {
  const { method } = req;
  const { owner, repoName, tail } = route;

  // GET a repository: a public repo answers without a token; anything else
  // needs one. A foreign owner is a 404, never a 403.
  if (method === 'GET' && tail.length === 0) {
    const repo = store.getRepo(owner, repoName);
    if (repo && !repo.private) {
      sendJson(res, req.requestId, 200, repoJson(repo));
      return true;
    }
    if (!requireAuth(req, res)) return true;
    if (!repo) {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    sendJson(res, req.requestId, 200, repoJson(repo));
    return true;
  }

  if (!requireAuth(req, res)) return true;
  const repo = lookupRepoOr404(req, res, store, owner, repoName);
  if (repo === null) return true;

  // PATCH / DELETE the repository.
  if (tail.length === 0) {
    if (method === 'PATCH') {
      const body = jsonBody(req, res);
      if (body === null) return true;
      if (typeof body.description === 'string') repo.description = body.description;
      sendJson(res, req.requestId, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': req.requestId });
      res.end();
      return true;
    }
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }

  const [head, ...rest] = tail as [string, ...string[]];

  // POST git/refs — create a branch (or another ref).
  if (head === 'git' && rest[0] === 'refs' && rest.length === 1) {
    if (method !== 'POST') {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    const body = jsonBody(req, res);
    if (body === null) return true;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
      jsonError(res, req.requestId, 422, 'Invalid ref or sha');
      return true;
    }
    if (repo.refs.has(ref)) {
      jsonError(res, req.requestId, 422, 'Reference already exists');
      return true;
    }
    repo.refs.set(ref, sha);
    sendJson(res, req.requestId, 201, { ref, object: { sha }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}` });
    return true;
  }

  // GET branches.
  if (head === 'branches' && rest.length === 0) {
    if (method !== 'GET') {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }));
    sendJson(res, req.requestId, 200, branches);
    return true;
  }

  // GET commits[?sha=<ref>].
  if (head === 'commits' && rest.length === 0) {
    if (method !== 'GET') {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    const tip = store.resolveRef(repo, req.query.get('sha') ?? undefined);
    if (tip === null) {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    const ancestors = store.commitAncestors(repo, tip);
    const out = ancestors.map((sha) => {
      const obj = repo.objects.get(sha);
      let message = '';
      let author = { name: '', email: '', date: '' };
      let committer = { name: '', email: '', date: '' };
      const parents: { sha: string }[] = [];
      if (obj && obj.type === 'commit') {
        try {
          const parsed = parseCommit(obj.bytes);
          message = parsed.message;
          for (const p of parsed.parents) parents.push({ sha: p });
          author = parseIdent(parsed.author);
          committer = parseIdent(parsed.committer);
        } catch {
          // Keep the empty shape.
        }
      }
      return { sha, commit: { message, author, committer }, parents };
    });
    const params = pageParams(req);
    sendList(req, res, out, params);
    return true;
  }

  // Contents: PUT / GET / DELETE /repos/:o/:r/contents/:path...
  if (head === 'contents') {
    return handleContents(req, res, store, repo, owner, repoName, rest);
  }

  // POST labels.
  if (head === 'labels' && rest.length === 0) {
    if (method !== 'POST') {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    const body = jsonBody(req, res);
    if (body === null) return true;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      jsonError(res, req.requestId, 422, 'Label name is required');
      return true;
    }
    const existing = repo.labels.get(name);
    if (existing) {
      sendJson(res, req.requestId, 200, { name: existing.name, color: existing.color });
      return true;
    }
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    repo.labels.set(name, { name, color });
    sendJson(res, req.requestId, 201, { name, color });
    return true;
  }

  // Issues.
  if (head === 'issues') {
    return handleIssues(req, res, store, repo, rest);
  }

  // Pulls.
  if (head === 'pulls') {
    return handlePulls(req, res, store, repo, rest);
  }

  jsonError(res, req.requestId, 404, 'Not Found');
  return true;
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (!match) return { name: line, email: '', date: '' };
  const epoch = parseInt(match[3] as string, 10);
  return { name: match[1] as string, email: match[2] as string, date: new Date(epoch * 1000).toISOString() };
}

// ---------------------------------------------------------------- contents

function handleContents(
  req: Req,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  owner: string,
  repoName: string,
  rest: string[],
): boolean {
  const { method } = req;
  const filePath = rest.join('/');
  const branch = req.query.get('branch') ?? req.query.get('ref') ?? undefined;

  if (method === 'GET') {
    const tip = store.resolveRef(repo, req.query.get('ref') ?? undefined);
    if (tip === null) {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    if (filePath === '') {
      const entries = store.listDir(repo, tip, '');
      if (entries === null) {
        jsonError(res, req.requestId, 404, 'Not Found');
        return true;
      }
      sendJson(res, req.requestId, 200, entries.map((e) => ({ ...e, size: e.type === 'dir' ? 0 : (repo.objects.get(e.sha)?.bytes.length ?? 0) })));
      return true;
    }
    const file = store.readPath(repo, tip, filePath);
    if (file !== null) {
      sendJson(res, req.requestId, 200, {
        type: 'file',
        encoding: 'base64',
        size: file.bytes.length,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        sha: file.oid,
        content: file.bytes.toString('base64'),
      });
      return true;
    }
    const entries = store.listDir(repo, tip, filePath);
    if (entries !== null) {
      sendJson(res, req.requestId, 200, entries.map((e) => ({ ...e, size: e.type === 'dir' ? 0 : (repo.objects.get(e.sha)?.bytes.length ?? 0) })));
      return true;
    }
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    const body = jsonBody(req, res);
    if (body === null) return true;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      jsonError(res, req.requestId, 400, 'Content is not valid base64');
      return true;
    }
    const targetBranch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${targetBranch}`);
    if (tip === undefined && targetBranch !== repo.defaultBranch) {
      jsonError(res, req.requestId, 404, 'Branch not found');
      return true;
    }
    const current = tip === undefined ? null : store.readPath(repo, tip, filePath);
    const isUpdate = current !== null;
    if (isUpdate && typeof body.sha === 'string' && body.sha !== current.oid) {
      jsonError(res, req.requestId, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    const baseTree = tip === undefined ? null : store.commitTree(repo, tip);
    const changes = new Map<string, Buffer | null>([[filePath, bytes]]);
    const newTree = store.applyPathChanges(repo, baseTree, changes);
    const commitSha = store.commitOnBranch(repo, targetBranch, message, newTree);
    const blobOid = store.readPath(repo, commitSha, filePath)?.oid ?? '';
    sendJson(res, req.requestId, isUpdate ? 200 : 201, {
      content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = jsonBody(req, res);
    if (body === null) return true;
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const targetBranch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${targetBranch}`);
    if (tip === undefined) {
      jsonError(res, req.requestId, 404, 'Branch not found');
      return true;
    }
    const current = store.readPath(repo, tip, filePath);
    if (current === null) {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    if (typeof body.sha === 'string' && body.sha !== current.oid) {
      jsonError(res, req.requestId, 409, 'Conflict: sha does not match the current file');
      return true;
    }
    const baseTree = store.commitTree(repo, tip);
    const changes = new Map<string, Buffer | null>([[filePath, null]]);
    const newTree = store.applyPathChanges(repo, baseTree, changes);
    const commitSha = store.commitOnBranch(repo, targetBranch, message, newTree);
    sendJson(res, req.requestId, 200, { commit: { sha: commitSha, message } });
    return true;
  }

  void branch;
  void owner;
  void repoName;
  jsonError(res, req.requestId, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------- issues

function handleIssues(req: Req, res: ServerResponse, store: Store, repo: Repo, rest: string[]): boolean {
  const { method } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(req, res);
      if (body === null) return true;
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        jsonError(res, req.requestId, 422, 'Title is required');
        return true;
      }
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          jsonError(res, req.requestId, 422, `Label does not exist: ${label}`);
          return true;
        }
      }
      const issue = store.createIssue(repo, title, bodyText, labels);
      sendJson(res, req.requestId, 201, issueJson(issue));
      return true;
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let items = [...repo.issues];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      if (sort === 'created') {
        items.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const params = pageParams(req);
      sendList(req, res, items.map(issueJson), params);
      return true;
    }
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }

  const number = parseNumberSegment(rest[0] as string);
  if (number === null) {
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }
  const issue = repo.issues.find((i) => i.number === number);
  if (rest.length === 1) {
    if (!issue) {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, req.requestId, 200, issueJson(issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = jsonBody(req, res);
      if (body === null) return true;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, req.requestId, 200, issueJson(issue));
      return true;
    }
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }

  if (rest[0] !== undefined && rest[1] === 'comments') {
    if (!issue) {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    if (method === 'POST') {
      const body = jsonBody(req, res);
      if (body === null) return true;
      const text = typeof body.body === 'string' ? body.body : '';
      const comment = store.createComment(repo, issue, text);
      sendJson(res, req.requestId, 201, commentJson(comment));
      return true;
    }
    if (method === 'GET') {
      const params = pageParams(req);
      sendList(req, res, issue.comments.map(commentJson), params);
      return true;
    }
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }

  jsonError(res, req.requestId, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------- pulls

function handlePulls(req: Req, res: ServerResponse, store: Store, repo: Repo, rest: string[]): boolean {
  const { method } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(req, res);
      if (body === null) return true;
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      const title = typeof body.title === 'string' ? body.title : '';
      const bodyText = typeof body.body === 'string' ? body.body : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) {
        jsonError(res, req.requestId, 422, 'Head or base branch does not exist');
        return true;
      }
      const pull = store.createPull(repo, title, bodyText, head, base, headSha, baseSha);
      sendJson(res, req.requestId, 201, pullJson(pull, repo));
      return true;
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let items = [...repo.pulls];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((a, b) => b.createdSeq - a.createdSeq);
      const params = pageParams(req);
      sendList(req, res, items.map((p) => pullJson(p, repo)), params);
      return true;
    }
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }

  const number = parseNumberSegment(rest[0] as string);
  if (number === null) {
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }
  const pull = repo.pulls.find((p) => p.number === number);

  if (rest.length === 1) {
    if (!pull) {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, req.requestId, 200, pullJson(pull, repo));
      return true;
    }
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }

  if (rest[1] === 'files' && rest.length === 2) {
    if (!pull) {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    if (method !== 'GET') {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    const baseTree = store.commitTree(repo, pull.baseSha);
    const headTree = store.commitTree(repo, pull.headSha);
    const files = store.diffTrees(repo, baseTree, headTree);
    sendJson(res, req.requestId, 200, files);
    return true;
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (!pull) {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    if (method !== 'PUT') {
      jsonError(res, req.requestId, 404, 'Not Found');
      return true;
    }
    const body = jsonBody(req, res);
    if (body === null) return true;
    const result = store.squashMerge(repo, pull);
    if ('error' in result) {
      jsonError(res, req.requestId, result.status, result.error);
      return true;
    }
    sendJson(res, req.requestId, 200, { merged: true, sha: result.sha, message: `Pull request #${pull.number} merged` });
    return true;
  }

  jsonError(res, req.requestId, 404, 'Not Found');
  return true;
}

// Keep the tree parser import used by the commits reader above.
export { parseTree };
