// Commit and tree operations the REST surface needs: resolving a ref (branch name, full ref, or
// commit id) to a commit, reading a path out of a commit's tree, creating the commits behind PUT
// and DELETE /contents, and listing commits and branches.
//
// Every commit this module builds is deterministic: the author/committer identity is the token's
// user and the timestamps come from the store's deterministic counter (never the wall clock), so
// the same request sequence produces the same commit ids on a replay. Object bytes are stored
// verbatim, exactly as the git surfaces store them.

import {
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  peelToNonTag,
  type GitObject,
  type TreeEntry,
} from './objects.ts';
import { VIEWER_EMAIL, VIEWER_NAME, nextTimestamp, type Repo } from '../store.ts';

/** The well-known id of the empty tree (the tree of zero entries). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Store an object if it is not already present; returns its id. */
function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/**
 * Resolve `ref` to a commit id. `undefined` means the default branch. A branch name, a full ref
 * name, or a 40-hex id (a commit, or a tag peeled to its commit) all resolve; anything else is
 * null. The default branch of an unborn repository is null too.
 */
export function resolveRefToCommit(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return oid === undefined ? null : peelToNonTag(oid, (id) => repo.objects.get(id));
  }
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const name of candidates) {
    const oid = repo.refs.get(name);
    if (oid !== undefined) return peelToNonTag(oid, (id) => repo.objects.get(id));
  }
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    if (object && (object.type === 'commit' || object.type === 'tag')) {
      return peelToNonTag(ref, (id) => repo.objects.get(id));
    }
  }
  return null;
}

/** The tip commit of a branch name, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return null;
  return peelToNonTag(oid, (id) => repo.objects.get(id));
}

/** Split a repository-relative path into its segments (no empty segments, no leading/trailing '/'). */
export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}

/** The entries of a tree object, or an empty list for the empty tree. */
function treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
  if (treeOid === EMPTY_TREE_OID) return [];
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/**
 * Look up `segments` in the tree `treeOid`: the entry at the end of the path, or null when any
 * segment is missing. Directories are followed; a file in the middle of the path is a dead end.
 */
export function lookupPath(
  repo: Repo,
  treeOid: string,
  segments: readonly string[],
): { type: 'file' | 'dir'; oid: string; mode: string } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const entries = treeEntries(repo, current);
    const entry = entries.find((item) => item.name === segments[index]);
    if (!entry) return null;
    const last = index === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) return { type: 'dir', oid: entry.oid, mode: entry.mode };
      current = entry.oid;
    } else {
      if (!last) return null;
      return { type: 'file', oid: entry.oid, mode: entry.mode };
    }
  }
  return null;
}

/** The immediate children of the directory `segments` in `treeOid` (empty segments = the root). */
export function listDirectory(repo: Repo, treeOid: string, segments: readonly string[]): TreeEntry[] | null {
  if (segments.length === 0) return treeEntries(repo, treeOid);
  const found = lookupPath(repo, treeOid, segments);
  if (!found || found.type !== 'dir') return null;
  return treeEntries(repo, found.oid);
}

/**
 * Set `segments` to the blob `blobOid` in the tree `treeOid`, creating intermediate directories
 * and storing every new tree object; returns the new root tree id. An existing entry at the path
 * (file or directory) is replaced. Exported for the squash merge (git/merge.ts), which applies a
 * head-side diff onto the base tip's tree.
 */
export function setPathInTree(repo: Repo, treeOid: string, segments: readonly string[], blobOid: string): string {
  const [head, ...tail] = segments as [string, ...string[]];
  const entries = treeEntries(repo, treeOid);
  const next: TreeEntry[] = [];
  let replaced = false;
  for (const entry of entries) {
    if (entry.name !== head) {
      next.push(entry);
      continue;
    }
    replaced = true;
    if (tail.length === 0) {
      next.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const childTree = entry.mode === '40000' ? entry.oid : EMPTY_TREE_OID;
      next.push({ mode: '40000', name: head, oid: setPathInTree(repo, childTree, tail, blobOid) });
    }
  }
  if (!replaced) {
    if (tail.length === 0) {
      next.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      next.push({ mode: '40000', name: head, oid: setPathInTree(repo, EMPTY_TREE_OID, tail, blobOid) });
    }
  }
  return storeObject(repo, 'tree', buildTree(next));
}

/**
 * Remove `segments` from the tree `treeOid`, pruning directories left empty; returns the new root
 * tree id (the empty tree when nothing remains). Removing a missing path leaves the tree unchanged.
 * Exported for the squash merge (git/merge.ts).
 */
export function removePathFromTree(repo: Repo, treeOid: string, segments: readonly string[]): string {
  const [head, ...tail] = segments as [string, ...string[]];
  const entries = treeEntries(repo, treeOid);
  const next: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.name !== head) {
      next.push(entry);
      continue;
    }
    if (tail.length === 0) continue; // drop the entry itself
    if (entry.mode !== '40000') continue; // a file in the middle: nothing below it to remove
    const child = removePathFromTree(repo, entry.oid, tail);
    if (child !== EMPTY_TREE_OID) next.push({ mode: '40000', name: head, oid: child });
    // An emptied directory is pruned.
  }
  if (next.length === 0) return EMPTY_TREE_OID;
  return storeObject(repo, 'tree', buildTree(next));
}

/** The git identity line for the token's user at the next deterministic timestamp. */
function identityLine(): string {
  const iso = nextTimestamp();
  const epoch = Math.floor(Date.parse(iso) / 1000);
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
}

/**
 * Build and store a commit object: `tree` as its tree, `parents` as its parents, `message` as
 * its message (one trailing newline, as git writes it). Returns the commit id.
 */
export function buildCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
  const identity = identityLine();
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`);
  lines.push(`committer ${identity}`);
  const body = Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8');
  return storeObject(repo, 'commit', body);
}

export interface ContentsCommitResult {
  commitSha: string;
  contentSha: string;
  /** True when the file did not exist before (a 201); false when it was an update (a 200). */
  created: boolean;
}

export type ContentsError = { kind: 'stale-sha' } | { kind: 'not-found' } | { kind: 'bad-branch' };

/**
 * Commit `content` at `path` on `branch` (the default branch when omitted), creating the branch's
 * first commit when the repository is unborn. When `sha` is given it must be the blob id the file
 * currently holds, or the update is a stale-sha conflict. Returns the commit and the new blob id.
 */
export function commitFile(
  repo: Repo,
  options: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): { ok: true; result: ContentsCommitResult } | { ok: false; error: ContentsError } {
  const branch = options.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = branchTip(repo, branch);
  if (tip === null && !(repo.refs.size === 0 && branch === repo.defaultBranch)) {
    // No tip and not the first commit on the default branch: the branch does not exist.
    return { ok: false, error: { kind: 'bad-branch' } };
  }
  const segments = splitPath(options.path);
  if (segments.length === 0) return { ok: false, error: { kind: 'not-found' } };

  const parentTree = tip === null ? EMPTY_TREE_OID : parseCommit(repo.objects.get(tip)!.data).tree;
  const existing = tip === null ? null : lookupPath(repo, parentTree, segments);
  if (options.sha !== undefined) {
    if (existing === null || existing.type !== 'file' || existing.oid.toLowerCase() !== options.sha.toLowerCase()) {
      return { ok: false, error: { kind: 'stale-sha' } };
    }
  }
  const blobOid = storeObject(repo, 'blob', options.content);
  const newTree = setPathInTree(repo, parentTree, segments, blobOid);
  const parents = tip === null ? [] : [tip];
  const commitSha = buildCommit(repo, newTree, parents, options.message);
  repo.refs.set(refName, commitSha);
  repo.refsVersion += 1;
  repo.updatedAt = nextTimestamp();
  return { ok: true, result: { commitSha, contentSha: blobOid, created: existing === null } };
}

/**
 * Delete `path` from `branch` with a commit. When `sha` is given it must be the blob id the file
 * currently holds. A missing file is a not-found error.
 */
export function deleteFile(
  repo: Repo,
  options: { path: string; message: string; branch?: string; sha?: string },
): { ok: true; commitSha: string } | { ok: false; error: ContentsError } {
  const branch = options.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = branchTip(repo, branch);
  if (tip === null) return { ok: false, error: { kind: 'not-found' } };
  const segments = splitPath(options.path);
  if (segments.length === 0) return { ok: false, error: { kind: 'not-found' } };
  const parentTree = parseCommit(repo.objects.get(tip)!.data).tree;
  const existing = lookupPath(repo, parentTree, segments);
  if (existing === null || existing.type !== 'file') return { ok: false, error: { kind: 'not-found' } };
  if (options.sha !== undefined && existing.oid.toLowerCase() !== options.sha.toLowerCase()) {
    return { ok: false, error: { kind: 'stale-sha' } };
  }
  const newTree = removePathFromTree(repo, parentTree, segments);
  const commitSha = buildCommit(repo, newTree, [tip], options.message);
  repo.refs.set(refName, commitSha);
  repo.refsVersion += 1;
  repo.updatedAt = nextTimestamp();
  return { ok: true, commitSha };
}

export interface ListedCommit {
  readonly sha: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly date: string;
  readonly parents: string[];
}

/** Parse a git identity line `Name <email> epoch tz` into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  const epoch = Number(match[3]);
  return { name: match[1]!, email: match[2]!, date: new Date(epoch * 1000).toISOString() };
}

/**
 * The commits reachable from `ref` (default branch when omitted), newest first, each once.
 * A linear history comes back in reverse chronological order; a merge history in depth-first
 * order from the tip. An unresolvable ref is an empty list.
 */
export function listCommits(repo: Repo, ref: string | undefined): ListedCommit[] {
  const tip = resolveRefToCommit(repo, ref);
  if (tip === null) return [];
  const out: ListedCommit[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const author = parseIdentity(commit.author);
    // The stored message ends with one newline (git convention); the REST shape drops it.
    const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
    out.push({
      sha: oid,
      message,
      authorName: author.name,
      authorEmail: author.email,
      date: author.date,
      parents: commit.parents,
    });
    for (let index = commit.parents.length - 1; index >= 0; index -= 1) {
      stack.push(commit.parents[index]!);
    }
  }
  return out;
}

/** Every branch in the repository: name and tip, sorted by name. */
export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) out.push({ name: name.slice('refs/heads/'.length), sha: oid });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
