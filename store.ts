// The forge's in-memory store: repositories, git objects and refs, issues,
// pull requests, labels and comments, plus the tree surgery the contents API
// needs and the three-way merge the merge endpoint and GraphQL `mergeable`
// share. Everything lives in this process; each grading run starts fresh.

import {
  buildCommit,
  buildTree,
  hashObject,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitcore.ts';
import type { ScenarioIdentity } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  seq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private seqCounter = 1;
  readonly identity: ScenarioIdentity;

  constructor(identity: ScenarioIdentity) {
    this.identity = identity;
  }

  private nextSeq(): number {
    return this.seqCounter++;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      seq: this.nextSeq(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoByName(name: string): Repo | undefined {
    return this.repos.get(this.key(this.identity.viewerLogin, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.identity.viewerLogin) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: ObjectType, bytes: Buffer): string {
    const { oid, object } = makeObject(type, bytes);
    repo.objects.set(oid, object);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Walk a commit's ancestry (first-parent chain plus merges, breadth-first). */
  commitAncestors(repo: Repo, tip: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      try {
        const commit = parseCommit(obj.bytes);
        for (const parent of commit.parents) queue.push(parent);
      } catch {
        // Unparseable commit: treat as a leaf.
      }
    }
    return out;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, tip: string, ancestor: string): boolean {
    if (tip === ancestor) return true;
    return this.commitAncestors(repo, tip).includes(ancestor);
  }

  /** The merge base of two tips: the first common ancestor found walking both. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAncestors = new Set(this.commitAncestors(repo, a));
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      try {
        for (const parent of parseCommit(obj.bytes).parents) queue.push(parent);
      } catch {
        // Leaf.
      }
    }
    return null;
  }

  /** Resolve a ref name, branch name, or commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    const headed = `refs/heads/${ref}`;
    if (repo.refs.has(headed)) return repo.refs.get(headed) as string;
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const obj = repo.objects.get(ref);
      if (obj && obj.type === 'commit') return ref;
      if (obj && obj.type === 'tag') {
        try {
          return parseTag(obj.bytes).object;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /** The tree oid of a commit, or null. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    try {
      return parseCommit(obj.bytes).tree;
    } catch {
      return null;
    }
  }

  /** Flat map of path -> { oid, mode } for a tree, recursing into subtrees. */
  treePaths(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, base: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(obj.bytes);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Read one blob's bytes at a commit, by path. */
  readPath(repo: Repo, commitOid: string, path: string): { oid: string; bytes: Buffer } | null {
    const treeOid = this.commitTree(repo, commitOid);
    if (treeOid === null) return null;
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return null;
      let entries: TreeEntry[];
      try {
        entries = parseTree(obj.bytes);
      } catch {
        return null;
      }
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') return null;
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { oid: entry.oid, bytes: blob.bytes };
      }
      current = entry.oid;
    }
    return null;
  }

  /** List a directory's immediate children at a commit (empty path = root). */
  listDir(repo: Repo, commitOid: string, dir: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] | null {
    const treeOid = this.commitTree(repo, commitOid);
    if (treeOid === null) return null;
    let current = treeOid;
    const clean = dir.split('/').filter((p) => p !== '').join('/');
    if (clean !== '') {
      for (const part of clean.split('/')) {
        const obj = repo.objects.get(current);
        if (!obj || obj.type !== 'tree') return null;
        let entries: TreeEntry[];
        try {
          entries = parseTree(obj.bytes);
        } catch {
          return null;
        }
        const entry = entries.find((e) => e.name === part && e.mode === '40000');
        if (!entry) return null;
        current = entry.oid;
      }
    }
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    let entries: TreeEntry[];
    try {
      entries = parseTree(obj.bytes);
    } catch {
      return null;
    }
    return entries
      .filter((e) => e.mode !== '160000')
      .map((e) => ({
        type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        name: e.name,
        path: clean === '' ? e.name : `${clean}/${e.name}`,
        sha: e.oid,
      }));
  }

  /**
   * Build a new tree from a base tree with path changes applied
   * (value null deletes the path). Returns the new tree oid.
   */
  applyPathChanges(repo: Repo, baseTreeOid: string | null, changes: Map<string, Buffer | null>): string {
    const build = (treeOid: string | null, segments: string[], value: Buffer | null, depth: number): string => {
      let entries: TreeEntry[] = [];
      if (treeOid !== null) {
        const obj = repo.objects.get(treeOid);
        if (obj && obj.type === 'tree') {
          try {
            entries = parseTree(obj.bytes);
          } catch {
            entries = [];
          }
        }
      }
      const name = segments[depth] as string;
      const isLeaf = depth === segments.length - 1;
      const idx = entries.findIndex((e) => e.name === name);
      if (isLeaf) {
        if (value === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else {
          const blobOid = this.putObject(repo, 'blob', value);
          const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
          if (idx >= 0) entries[idx] = entry;
          else entries.push(entry);
        }
      } else {
        const childTree = idx >= 0 && entries[idx]?.mode === '40000' ? entries[idx]?.oid ?? null : null;
        const newChild = build(childTree, segments, value, depth + 1);
        // An empty subtree disappears: git never stores empty trees.
        const childObj = repo.objects.get(newChild);
        let childEntries: TreeEntry[] = [];
        if (childObj && childObj.type === 'tree') {
          try {
            childEntries = parseTree(childObj.bytes);
          } catch {
            childEntries = [];
          }
        }
        if (childEntries.length === 0) {
          if (idx >= 0) entries.splice(idx, 1);
        } else {
          const entry: TreeEntry = { mode: '40000', name, oid: newChild };
          if (idx >= 0) entries[idx] = entry;
          else entries.push(entry);
        }
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    let current: string | null = baseTreeOid;
    for (const [path, value] of changes) {
      const segments = path.split('/').filter((p) => p !== '');
      if (segments.length === 0) continue;
      current = build(current, segments, value, 0);
    }
    return current ?? this.putObject(repo, 'tree', buildTree([]));
  }

  /** Create a commit object on a branch and move the branch to it. */
  commitOnBranch(
    repo: Repo,
    branch: string,
    message: string,
    treeOid: string,
    authorName?: string,
    authorEmail?: string,
    timestampSec?: number,
  ): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const parents = parent && parent !== ZERO_OID ? [parent] : [];
    const ts = timestampSec ?? Math.floor(Date.now() / 1000);
    const name = authorName ?? this.identity.viewerName;
    const email = authorEmail ?? this.identity.viewerEmail;
    const ident = `${name} <${email}> ${ts} +0000`;
    // The message is stored exactly as given: GET /commits must echo it back
    // byte for byte, so no trailing newline is added here.
    const bytes = buildCommit(treeOid, parents, ident, ident, message);
    const oid = this.putObject(repo, 'commit', bytes);
    repo.refs.set(ref, oid);
    return oid;
  }

  // ------------------------------------------------------------ issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
    };
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body };
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  // ------------------------------------------------------------ merge

  /** Line diff counts between two blobs (simple LCS over lines). */
  diffLines(oldBytes: Buffer | null, newBytes: Buffer | null): { additions: number; deletions: number } {
    const oldLines = oldBytes === null ? [] : oldBytes.toString('utf8').split('\n');
    const newLines = newBytes === null ? [] : newBytes.toString('utf8').split('\n');
    if (oldBytes !== null && oldBytes.length > 0 && oldBytes[oldBytes.length - 1] === 0x0a) oldLines.pop();
    if (newBytes !== null && newBytes.length > 0 && newBytes[newBytes.length - 1] === 0x0a) newLines.pop();
    const m = oldLines.length;
    const n = newLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    const common = dp[0]![0]!;
    return { additions: n - common, deletions: m - common };
  }

  /** The paths that differ between two trees, with per-path line counts. */
  diffTrees(
    repo: Repo,
    baseTreeOid: string | null,
    headTreeOid: string | null,
  ): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
    const base = baseTreeOid === null ? new Map() : this.treePaths(repo, baseTreeOid);
    const head = headTreeOid === null ? new Map() : this.treePaths(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldBytes = repo.objects.get(b.oid)?.bytes ?? null;
        const d = this.diffLines(oldBytes, null);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: d.deletions, changes: d.deletions });
      } else if (!b && h) {
        const newBytes = repo.objects.get(h.oid)?.bytes ?? null;
        const d = this.diffLines(null, newBytes);
        out.push({ filename: path, status: 'added', additions: Math.max(d.additions, 1), deletions: 0, changes: Math.max(d.additions, 1) });
      } else if (b && h && b.oid !== h.oid) {
        const oldBytes = repo.objects.get(b.oid)?.bytes ?? null;
        const newBytes = repo.objects.get(h.oid)?.bytes ?? null;
        const d = this.diffLines(oldBytes, newBytes);
        out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
      }
    }
    return out;
  }

  /**
   * Three-way merge of the head branch into the base branch.
   * Returns the merged tree oid, or null with conflict paths when the same
   * path changed differently on both sides of the merge base.
   */
  threeWayMerge(repo: Repo, baseTip: string, headTip: string): { tree: string; conflicts: string[] } | null {
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseTree = base === null ? null : this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const branchTree = this.commitTree(repo, baseTip);
    if (headTree === null || branchTree === null) return null;
    const basePaths = baseTree === null ? new Map() : this.treePaths(repo, baseTree);
    const headPaths = this.treePaths(repo, headTree);
    const branchPaths = this.treePaths(repo, branchTree);
    const all = new Set([...basePaths.keys(), ...headPaths.keys(), ...branchPaths.keys()]);
    const conflicts: string[] = [];
    const changes = new Map<string, Buffer | null>();
    for (const path of all) {
      const b = basePaths.get(path)?.oid ?? null;
      const h = headPaths.get(path)?.oid ?? null;
      const t = branchPaths.get(path)?.oid ?? null;
      if (h === t) continue;
      if (b === h) continue; // Only the base side changed: keep it.
      if (b === t) {
        // Only the head side changed: take the head side.
        if (h === null) changes.set(path, null);
        else {
          const obj = repo.objects.get(h);
          if (obj) changes.set(path, obj.bytes);
        }
        continue;
      }
      conflicts.push(path);
    }
    if (conflicts.length > 0) return { tree: '', conflicts };
    const mergedTree = this.applyPathChanges(repo, branchTree, changes);
    return { tree: mergedTree, conflicts: [] };
  }

  /** Squash-merge a pull request. Returns the merge commit oid, or an error. */
  squashMerge(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.merged || pull.state !== 'open') return { error: 'pull request is already merged or closed', status: 405 };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return { error: 'head or base branch is missing', status: 404 };
    const merged = this.threeWayMerge(repo, baseTip, headTip);
    if (merged === null) return { error: 'cannot merge: missing commits', status: 404 };
    if (merged.conflicts.length > 0) {
      return { error: `merge conflict in ${merged.conflicts.join(', ')}`, status: 405 };
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const sha = this.commitOnBranch(repo, pull.baseRef, message, merged.tree);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = sha;
    pull.baseSha = sha;
    return { sha };
  }

  /** MERGEABLE / CONFLICTING / UNKNOWN for a pull request, without merging. */
  mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return 'UNKNOWN';
    if (baseTip === headTip) return 'MERGEABLE';
    const merged = this.threeWayMerge(repo, baseTip, headTip);
    if (merged === null) return 'UNKNOWN';
    return merged.conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }
}
