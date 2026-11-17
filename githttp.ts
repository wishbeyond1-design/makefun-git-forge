// git smart HTTP: info/refs advertisements (v2 and v0), ls-refs and fetch
// over protocol v2 and v0, and receive-pack pushes with report-status.
// The wire shapes follow the suite's git-client.ts: pkt-lines, sideband
// framing for packfiles and push reports, and the exact capability strings
// the client gates on (fetch=shallow for depth, side-band-64k for v0 fetch,
// report-status/side-band-64k/delete-refs for receive-pack).

import type { ServerResponse } from 'node:http';
import {
  buildTree,
  decodePktLines,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Pkt,
} from './gitcore.ts';
import { jsonError, sendBuffer, type Req } from './httputil.ts';
import { Store, type Repo } from './store.ts';

const AGENT = 'makefun-git-forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack shallow multi_ack multi_ack_detailed agent=${AGENT}`;
const V0_RECEIVE_CAPS = `symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k ofs-delta delete-refs agent=${AGENT}`;

interface GitRoute {
  owner: string;
  repoName: string;
  service: string;
}

function parseGitPath(path: string): GitRoute | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return null;
  try {
    return {
      owner: decodeURIComponent(match[1] as string),
      repoName: decodeURIComponent(match[2] as string),
      service: match[3] as string,
    };
  } catch {
    return null;
  }
}

function lookupRepo(store: Store, owner: string, repoName: string): Repo | null {
  const repo = store.getRepo(owner, repoName);
  return repo ?? null;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** The commit a tag object points at (following nested tags). */
function derefToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      try {
        current = parseTag(obj.bytes).object;
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  return null;
}

/** The peeled commit of an annotated tag ref, or null. */
function peeledOf(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  try {
    return derefToCommit(repo, parseTag(obj.bytes).object);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- advertisements

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush];
  const tip = defaultTip(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = tip !== null ? `${tip} HEAD\0${caps}\n` : `${refs[0]?.[1] ?? ZERO_OID} HEAD\0${caps}\n`;
    parts.push(pktLine(headLine));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush,
  ]);
}

export function handleInfoRefs(req: Req, res: ServerResponse, store: Store): boolean {
  const route = parseGitPath(req.path);
  if (!route || route.service !== 'info/refs') return false;
  const service = req.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }
  const repo = lookupRepo(store, route.owner, route.repoName);
  if (repo === null) {
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, req.requestId, 200, v0Advertisement(repo, service), RECEIVE_AD);
    return true;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  sendBuffer(res, req.requestId, 200, wantsV2 ? v2Advertisement() : v0Advertisement(repo, service), UPLOAD_AD);
  return true;
}

// ---------------------------------------------------------------- ls-refs (v2)

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const tip = defaultTip(repo);
  if (tip !== null && symrefs && keep('HEAD')) {
    parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Walk commits from tips, generation by generation. */
function walkCommits(
  repo: Repo,
  tips: string[],
  maxGen: number | null,
): { included: Map<string, number>; boundary: Set<string> } {
  const included = new Map<string, number>();
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const queue: [string, number][] = tips.map((t) => [t, 0] as [string, number]);
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (maxGen !== null && gen >= maxGen) {
      boundary.add(oid);
      continue;
    }
    included.set(oid, gen);
    let parents: string[] = [];
    try {
      parents = [...parseCommit(obj.bytes).parents];
    } catch {
      parents = [];
    }
    for (const parent of parents) queue.push([parent, gen + 1]);
  }
  // The shallow boundary is the deepest included commit whose parents were cut.
  if (maxGen !== null) {
    boundary.clear();
    for (const [oid, gen] of included) {
      if (gen !== maxGen - 1) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      try {
        if (parseCommit(obj.bytes).parents.length > 0) boundary.add(oid);
      } catch {
        // No parents to cut.
      }
    }
  }
  return { included, boundary };
}

/** Everything reachable from `tips`, stopping the walk at shallow boundaries. */
function reachableFrom(repo: Repo, tips: string[], stopAt: Set<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      let commit;
      try {
        commit = parseCommit(obj.bytes);
      } catch {
        continue;
      }
      queue.push(commit.tree);
      if (!stopAt.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (obj.type === 'tree') {
      try {
        for (const entry of parseTree(obj.bytes)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      } catch {
        // Skip a broken tree.
      }
    } else if (obj.type === 'tag') {
      try {
        queue.push(parseTag(obj.bytes).object);
      } catch {
        // Skip a broken tag.
      }
    }
  }
  return out;
}

/** The objects a fetch must send, honouring haves and a depth limit. */
function computeFetch(
  repo: Repo,
  request: FetchRequest,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const stopAt = new Set(request.shallow);
  const excluded = reachableFrom(repo, request.haves, stopAt);
  // A wanted tag counts as a wanted commit for the walk (its target), and a
  // wanted object of any type is collected itself.
  const commitTips: string[] = [];
  for (const oid of request.wants) {
    const commit = derefToCommit(repo, oid);
    if (commit !== null) commitTips.push(commit);
  }
  const { included, boundary } = walkCommits(repo, commitTips, request.depth);
  // Reach everything the included commits need, without walking past them.
  const reachable = new Map<string, GitObject>();
  const seen = new Set<string>();
  const collect = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) return;
    reachable.set(oid, obj);
    if (obj.type === 'commit') {
      let commit;
      try {
        commit = parseCommit(obj.bytes);
      } catch {
        return;
      }
      collect(commit.tree);
      for (const parent of commit.parents) {
        if (included.has(parent)) collect(parent);
      }
    } else if (obj.type === 'tree') {
      try {
        for (const entry of parseTree(obj.bytes)) {
          if (entry.mode !== '160000') collect(entry.oid);
        }
      } catch {
        // Skip.
      }
    } else if (obj.type === 'tag') {
      try {
        collect(parseTag(obj.bytes).object);
      } catch {
        // Skip.
      }
    }
  };
  for (const oid of included.keys()) collect(oid);
  for (const oid of request.wants) collect(oid);
  for (const oid of excluded.keys()) reachable.delete(oid);
  const objects = [...reachable.values()];
  // Old shallow boundaries whose parents are now sent are no longer shallow.
  const unshallow: string[] = [];
  if (request.depth !== null) {
    for (const old of request.shallow) {
      const obj = repo.objects.get(old);
      if (!obj || obj.type !== 'commit') continue;
      try {
        const parents = parseCommit(obj.bytes).parents;
        if (parents.some((p) => included.has(p))) unshallow.push(old);
      } catch {
        // Not a commit we can deepen.
      }
    }
  }
  return { objects, shallow: [...boundary], unshallow };
}

/** Chunk pack bytes into sideband band-1 pkt-lines (max 65515 data bytes each). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(i + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (parts.length === 0) {
    // An empty pack still needs one band-1 packet when a packfile section exists.
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  }
  return parts;
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n)) request.depth = n;
    }
  }
  request.wants = [...new Set(request.wants)];
  const { objects, shallow, unshallow } = computeFetch(repo, request);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      request.wants.push(rest.split(' ')[0] as string);
    } else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) request.depth = n;
    }
  }
  request.wants = [...new Set(request.wants)];
  const { objects, shallow } = computeFetch(repo, request);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

export function handleUploadPack(req: Req, res: ServerResponse, store: Store): boolean {
  const route = parseGitPath(req.path);
  if (!route || route.service !== 'git-upload-pack') return false;
  const repo = lookupRepo(store, route.owner, route.repoName);
  if (repo === null) {
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }
  let packets: Pkt[];
  try {
    packets = decodePktLines(req.body);
  } catch {
    // A malformed request must not take the server down (repo-survives-errors).
    sendBuffer(res, req.requestId, 200, Buffer.concat([pktLine('NAK\n'), pktFlush]), UPLOAD_RESULT);
    return true;
  }
  const lines = packets
    .filter((p) => p.kind === 'data')
    .map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    const command = lines[0]?.replace(/\n$/, '') ?? '';
    if (command === 'command=ls-refs') {
      sendBuffer(res, req.requestId, 200, handleLsRefs(repo, lines.slice(1)), UPLOAD_RESULT);
      return true;
    }
    if (command === 'command=fetch') {
      sendBuffer(res, req.requestId, 200, handleFetchV2(repo, lines.slice(1)), UPLOAD_RESULT);
      return true;
    }
    jsonError(res, req.requestId, 400, 'unknown v2 command');
    return true;
  }
  // v0 fetch.
  sendBuffer(res, req.requestId, 200, handleFetchV0(repo, lines), UPLOAD_RESULT);
  return true;
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into command lines and the trailing pack bytes. */
function splitPushBody(body: Buffer): { commands: string[]; pack: Buffer } | null {
  const commands: string[] = [];
  let pos = 0;
  while (pos < body.length) {
    if (pos + 4 > body.length) return null;
    const lenText = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) return null;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      pos += 4;
      return { commands, pack: body.subarray(pos) };
    }
    if (len < 4 || pos + len > body.length) return null;
    commands.push(body.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return null;
}

export function handleReceivePack(req: Req, res: ServerResponse, store: Store): boolean {
  const route = parseGitPath(req.path);
  if (!route || route.service !== 'git-receive-pack') return false;
  const repo = lookupRepo(store, route.owner, route.repoName);
  if (repo === null) {
    jsonError(res, req.requestId, 404, 'Not Found');
    return true;
  }
  const split = splitPushBody(req.body);
  if (split === null) {
    jsonError(res, req.requestId, 400, 'malformed push body');
    return true;
  }
  const commands: PushCommand[] = [];
  let wantsSideband = false;
  for (let i = 0; i < split.commands.length; i += 1) {
    let line = split.commands[i] as string;
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1);
        wantsSideband = caps.split(' ').includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const text = line.replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length < 3) {
      jsonError(res, req.requestId, 400, 'malformed push command');
      return true;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    if (split.pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error: no packfile';
    } else {
      try {
        const read = readPack(split.pack, (oid) => repo.objects.get(oid));
        for (const [oid, object] of read.objects) repo.objects.set(oid, object);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok');
  else reportLines.push(`unpack ${unpackDetail}`);
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reason = 'remote ref does not exist';
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
      else {
        repo.refs.delete(command.ref);
        ok = true;
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) reason = 'already exists';
      else if (!repo.objects.has(command.newOid)) reason = 'object not found';
      else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    } else {
      // Update.
      if (current === undefined) reason = 'remote ref does not exist';
      else if (command.oldOid !== current) reason = 'non-fast-forward';
      else if (!repo.objects.has(command.newOid)) reason = 'object not found';
      else {
        const newCommit = derefToCommit(repo, command.newOid);
        const oldCommit = derefToCommit(repo, current);
        if (newCommit === null || oldCommit === null) reason = 'non-fast-forward';
        else if (!store.isAncestor(repo, newCommit, oldCommit)) reason = 'non-fast-forward';
        else {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      }
    }
    reportLines.push(ok ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }
  const inner = Buffer.concat(reportLines.map((line) => pktLine(`${line}\n`)));
  let body: Buffer;
  if (wantsSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let i = 0; i < inner.length; i += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(i, Math.min(i + CHUNK, inner.length))])));
    }
    parts.push(pktFlush);
    body = Buffer.concat(parts);
  } else {
    body = Buffer.concat([inner, pktFlush]);
  }
  sendBuffer(res, req.requestId, 200, body, RECEIVE_RESULT);
  return true;
}

// Re-exported for tests and the REST layer's branch creation path.
export { buildTree, hashObject };
