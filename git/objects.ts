// The git object model (SHA-1): object hashing exactly as git computes it, commit/tree/tag
// parsing and building, and reachability walks. Object bytes are stored verbatim — never
// re-serialized — because clone-commit-bytes checks byte-exact round-trip.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** A git object: its type and its exact byte content (no header). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** A lookup from object id to object. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commit → tree + parents, tree → entries (gitlinks skipped),
 * tag → its target, blob → nothing. Throws on a missing object unless `allowMissing` is set.
 * Commits in `stopAt` are included with their trees but their parents are NOT followed — that is
 * how a fetch computes what a shallow client already holds: the client's shallow boundary commits
 * are held, but their ancestry is not.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean; stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      // A boundary commit's parents are not reachable (the client's shallow cut).
      if (!options.stopAt?.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Walk commits from `roots` (tags are peeled to their commit target) with an optional depth limit.
 * Returns the included commits with their generation (0 = a want), the shallow boundary (commits at
 * generation depth-1, when a depth is set), and every object reachable from the included commits'
 * trees (trees + blobs, fully recursive — a shallow cut only truncates commit ancestry).
 */
export function walkWithDepth(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  depth: number | null,
): { commits: Map<string, number>; boundary: string[]; treeObjects: Set<string> } {
  const commits = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const root of roots) {
    if (!isObjectId(root) || root === ZERO_OID) continue;
    const object = lookup(root);
    if (!object) continue;
    if (object.type === 'tag') {
      // A tag want: the tag object itself is carried separately; the walk starts at its target.
      let target = parseTag(object.data).object;
      for (;;) {
        const next = lookup(target);
        if (!next || next.type !== 'tag') break;
        target = parseTag(next.data).object;
      }
      const targetObject = lookup(target);
      if (targetObject && targetObject.type === 'commit') queue.push({ oid: target, generation: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: root, generation: 0 });
    }
    // A tree/blob want has no commit ancestry; it is included directly by the caller.
  }
  while (queue.length) {
    const { oid, generation } = queue.pop()!;
    const known = commits.get(oid);
    if (known !== undefined && known <= generation) continue;
    commits.set(oid, generation);
    if (depth !== null && generation >= depth - 1) continue; // at the boundary: parents are cut
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, generation: generation + 1 });
    }
  }
  const boundary: string[] = [];
  if (depth !== null) {
    for (const [oid, generation] of commits) {
      if (generation === depth - 1) boundary.push(oid);
    }
    boundary.sort();
  }
  // Every tree/blob reachable from the included commits (full recursion; the cut is commit-only).
  const treeObjects = new Set<string>();
  const treeQueue: string[] = [];
  for (const oid of commits.keys()) {
    const object = lookup(oid);
    if (object && object.type === 'commit') treeQueue.push(parseCommit(object.data).tree);
  }
  while (treeQueue.length) {
    const oid = treeQueue.pop()!;
    if (treeObjects.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    treeObjects.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        treeQueue.push(entry.oid);
      }
    }
  }
  return { commits, boundary, treeObjects };
}

/** True when `ancestor` is reachable from `tip` following commit parents (or equals it). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return false;
}

/** Peel a tag chain to its non-tag target (a commit for annotated tags). */
export function peelToNonTag(oid: string, lookup: ObjectLookup): string {
  let current = oid;
  for (;;) {
    const object = lookup(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}
