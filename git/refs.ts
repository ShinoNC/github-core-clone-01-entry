// Ref listing, HEAD resolution, tag peeling, and the v0 ref advertisement shared by both git
// services. Refs are sorted lexicographically; HEAD is always the default branch symref.

import { encodePktLines } from './pktline.ts';
import { ZERO_OID, peelToNonTag } from './objects.ts';
import type { Repo } from '../store.ts';

export interface ListedRef {
  readonly oid: string;
  readonly name: string;
  /** The peeled commit, when the ref points at an annotated tag. */
  readonly peeled?: string;
}

/** Every ref in the repo, sorted by name. */
export function listRefs(repo: Repo): ListedRef[] {
  const names = [...repo.refs.keys()].sort();
  const out: ListedRef[] = [];
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = repo.objects.get(oid);
    const ref: { oid: string; name: string; peeled?: string } = { oid, name };
    if (object && object.type === 'tag') {
      ref.peeled = peelToNonTag(oid, (id) => repo.objects.get(id));
    }
    out.push(ref);
  }
  return out;
}

/** The HEAD target: the default branch's tip, or null when the branch is unborn. */
export function headTarget(repo: Repo): { oid: string; name: string } | null {
  const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!oid) return null;
  return { oid, name: `refs/heads/${repo.defaultBranch}` };
}

/**
 * Build a v0 ref advertisement body for `service` (git-upload-pack or git-receive-pack):
 * the `# service=...` preamble, a flush, then `<oid> <ref>` lines with the capabilities after a
 * NUL on the first line, then a flush. An empty repo advertises the single
 * `<zero-oid> capabilities^{}` pseudo-ref line. Peeled tags get a `<oid> <ref>^{}` line right
 * after their ref line.
 */
export function buildV0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', capabilities: string): Buffer {
  // The advertisement reads only the refs (+ tag peels, which are immutable once the tag
  // object exists) — refsVersion + objects.size pin its inputs exactly.
  const cacheKey = `${service}|${repo.refsVersion}|${repo.objects.size}`;
  const cached = repo.advertisementCache.get(cacheKey);
  if (cached) return cached;
  const parts: Buffer[] = [encodePktLines([`# service=${service}\n`, 'flush'])];
  const head = headTarget(repo);
  const refs = listRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`);
  } else {
    let first = true;
    if (head) {
      const caps = first ? `\u0000${capabilities}` : '';
      first = false;
      lines.push(`${head.oid} HEAD${caps}\n`);
    }
    for (const ref of refs) {
      const caps = first ? `\u0000${capabilities}` : '';
      first = false;
      lines.push(`${ref.oid} ${ref.name}${caps}\n`);
      if (ref.peeled !== undefined) {
        lines.push(`${ref.peeled} ${ref.name}^{}\n`);
      }
    }
  }
  parts.push(encodePktLines([...lines, 'flush']));
  const response = Buffer.concat(parts);
  repo.advertisementCache.set(cacheKey, response);
  return response;
}

/** True when the repo has no refs at all. */
export function isEmptyRepo(repo: Repo): boolean {
  return repo.refs.size === 0;
}
