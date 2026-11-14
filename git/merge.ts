// Three-way merge for pull requests: flatten trees to path maps, find the merge base, diff the
// two sides against it, detect conflicts per path, and apply the head side onto the base tip for
// a squash merge. The suite's conflict case is simple (same file, different content both sides),
// but the rule is the real one: a path changed on both sides with different resulting content is
// a conflict; the same resulting content on both sides is not.
//
// Everything here is pure over the store (no timestamps, no counters), so the same repository
// state always yields the same plan — deterministic across live and replay.

import { EMPTY_TREE_OID, buildCommit, removePathFromTree, setPathInTree, splitPath } from './commits.ts';
import { parseCommit, parseTree, type GitObject } from './objects.ts';
import type { Repo } from '../store.ts';

/** One file in a flattened tree: its blob id and mode. Directories are not listed. */
export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

/** A tree flattened to `path -> entry`, recursively. */
export type FlatTree = Map<string, FlatEntry>;

function treeEntries(repo: Repo, treeOid: string): Array<{ mode: string; name: string; oid: string }> {
  if (treeOid === EMPTY_TREE_OID) return [];
  const object: GitObject | undefined = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/** Flatten `treeOid` into a path map (gitlinks are skipped: the repo does not hold them). */
export function flattenTree(repo: Repo, treeOid: string): FlatTree {
  const out: FlatTree = new Map();
  const walk = (oid: string, prefix: string): void => {
    for (const entry of treeEntries(repo, oid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The tree id of a commit, or the empty tree when the commit is missing. */
export function commitTree(repo: Repo, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return EMPTY_TREE_OID;
  return parseCommit(object.data).tree;
}

/** The parents of a commit (empty when the commit is missing). */
function commitParents(repo: Repo, commitOid: string): string[] {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/**
 * The merge base of two commits: the closest common ancestor, found by collecting every ancestor
 * of `a` and walking `b`'s ancestry breadth-first (closest first). For the linear histories the
 * suite builds there is exactly one common ancestor on the path, so the first hit is the base.
 * Returns null when the histories share no commit.
 */
export function findMergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    for (const parent of commitParents(repo, oid)) stack.push(parent);
  }
  const queue = [b];
  const seenB = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    for (const parent of commitParents(repo, oid)) queue.push(parent);
  }
  return null;
}

export type ChangeStatus = 'added' | 'modified' | 'removed';

/** One path's change between two trees: its status and the resulting blob (null when removed). */
export interface PathChange {
  readonly status: ChangeStatus;
  /** The blob id after the change (null for a removal). */
  readonly oid: string | null;
  /** The blob id before the change (null for an addition). */
  readonly oldOid: string | null;
}

/**
 * The per-path diff from `before` to `after`: added (in after only), removed (in before only),
 * modified (in both, different blob id). A mode-only change with the same blob is not a change
 * (the suite never changes modes through the REST surface).
 */
export function diffTrees(before: FlatTree, after: FlatTree): Map<string, PathChange> {
  const out = new Map<string, PathChange>();
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (old === undefined) {
      out.set(path, { status: 'added', oid: entry.oid, oldOid: null });
    } else if (old.oid !== entry.oid) {
      out.set(path, { status: 'modified', oid: entry.oid, oldOid: old.oid });
    }
  }
  for (const [path, entry] of before) {
    if (!after.has(path)) {
      out.set(path, { status: 'removed', oid: null, oldOid: entry.oid });
    }
  }
  return out;
}

export type SquashPlan =
  | { ok: true; tree: string; changes: Map<string, PathChange> }
  | { ok: false; conflicts: string[] };

/**
 * Plan a squash merge of `headTip` onto `baseTip`: find the merge base, diff both sides against
 * it, and apply the head side's changes onto the base tip's tree. A path changed on both sides
 * with different resulting content (or removed on one side and changed on the other) is a
 * conflict and the whole merge is refused; the same resulting content on both sides merges
 * cleanly. The returned tree is stored; the caller commits it onto the base branch.
 */
export function planSquashMerge(repo: Repo, baseTip: string, headTip: string): SquashPlan {
  const mergeBase = findMergeBase(repo, baseTip, headTip);
  const baseTree = commitTree(repo, baseTip);
  const headTree = commitTree(repo, headTip);
  const ancestorTree = mergeBase === null ? EMPTY_TREE_OID : commitTree(repo, mergeBase);
  const ancestorFlat = flattenTree(repo, ancestorTree);
  const baseFlat = flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, headTree);
  const headChanges = diffTrees(ancestorFlat, headFlat);
  const baseChanges = diffTrees(ancestorFlat, baseFlat);

  const conflicts: string[] = [];
  for (const [path, headChange] of headChanges) {
    const baseChange = baseChanges.get(path);
    if (baseChange === undefined) continue;
    // Both sides changed the path. The same resulting blob is a clean agreement.
    if (headChange.oid !== baseChange.oid) conflicts.push(path);
  }
  conflicts.sort();
  if (conflicts.length > 0) return { ok: false, conflicts };

  let tree = baseTree;
  for (const [path, change] of headChanges) {
    const segments = splitPath(path);
    if (segments.length === 0) continue;
    if (change.status === 'removed') {
      tree = removePathFromTree(repo, tree, segments);
    } else {
      tree = setPathInTree(repo, tree, segments, change.oid!);
    }
  }
  return { ok: true, tree, changes: headChanges };
}

/**
 * Perform the squash merge: plan it, build the single squash commit on top of `baseTip`, and
 * move the base branch ref to it. Returns the merge commit id, or the conflict list.
 */
export function squashMerge(
  repo: Repo,
  baseBranch: string,
  baseTip: string,
  headTip: string,
  message: string,
): { ok: true; commitSha: string } | { ok: false; conflicts: string[] } {
  const plan = planSquashMerge(repo, baseTip, headTip);
  if (!plan.ok) return { ok: false, conflicts: plan.conflicts };
  const commitSha = buildCommit(repo, plan.tree, [baseTip], message);
  repo.refs.set(`refs/heads/${baseBranch}`, commitSha);
  repo.refsVersion += 1;
  return { ok: true, commitSha };
}

/** The content lines of a blob (a trailing newline does not add an empty line). */
function blobLines(repo: Repo, oid: string | null): string[] {
  if (oid === null) return [];
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return [];
  const text = object.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line-level addition/deletion counts for one path change, from a multiset diff of the old and
 * new contents: a line present N times in the new content and M times in the old counts
 * max(0, N - M) additions and max(0, M - N) deletions. For a fully rewritten file this is the
 * whole line count on both sides; for a one-line edit it is 1/1.
 */
export function lineDiffCounts(
  repo: Repo,
  change: PathChange,
): { additions: number; deletions: number } {
  const oldLines = blobLines(repo, change.oldOid);
  const newLines = blobLines(repo, change.oid);
  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  }
  for (const [line, count] of oldCounts) {
    deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  }
  return { additions, deletions };
}
