// git-upload-pack: the fetch/clone side. Protocol v2 (advertisement, ls-refs, fetch) and the v0
// fallback (advertisement + fetch). Written against the suite client's parseV2Fetch/fetchV0 line
// by line — the client's parser IS the spec.
//
// v2 advertisement: `version 2`, capability lines, flush. No service preamble (v0 only).
// v2 fetch response: sections separated by flush, each starting with its header line:
//   acknowledgments (NAK / ACK <oid>), shallow-info (shallow / unshallow), wanted-refs
//   (<oid> <ref>), packfile (sideband: band 1 = pack bytes, band 2 = progress, band 3 = error).
// A packfile section with zero sideband packets is an error — even an empty pack is sent.
// No deltas anywhere: the server sends full-object packs only.

import { encodePktLine, encodePktLines, decodePktLines, packetsToLines } from './pktline.ts';
import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  walkWithDepth,
  type GitObject,
} from './objects.ts';
import { writePack } from './pack.ts';
import { buildV0Advertisement, headTarget, listRefs } from './refs.ts';
import type { Repo } from '../store.ts';

export const UPLOAD_PACK_ADVERTISEMENT_TYPE = 'application/x-git-upload-pack-advertisement';
export const UPLOAD_PACK_RESULT_TYPE = 'application/x-git-upload-pack-result';

const AGENT = 'makefun-forge/1.0';

/** v0 upload-pack capabilities (the client reads side-band-64k, shallow, thin-pack, ofs-delta). */
const V0_CAPABILITIES = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;

/** The largest pack-data chunk in one sideband packet (65520 total − 4 header − 1 band byte). */
const SIDEBAND_CHUNK = 65515;

/**
 * The v2 capability advertisement. `fetch=shallow` is required; `filter` is NOT advertised.
 * Constant (no repo dependence) — built once, shared by every request.
 */
const ADVERTISEMENT_V2: Buffer = encodePktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

export function advertisementV2(): Buffer {
  return ADVERTISEMENT_V2;
}

/** The v0 ref advertisement (answered when the client sends no Git-Protocol header). */
export function advertisementV0(repo: Repo): Buffer {
  return buildV0Advertisement(repo, 'git-upload-pack', V0_CAPABILITIES);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Parse a v2 fetch request's argument lines (after the delim) into wants/haves/shallow/depth. */
function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    } else if (line === 'done') args.done = true;
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not: accepted, no action.
  }
  return args;
}

interface FetchPlan {
  /** Objects to send, deduplicated. */
  objects: GitObject[];
  /** The id of each object, parallel to `objects` (same order) — lets writePack skip hashing. */
  oids: string[];
  /** The new shallow boundary. */
  shallow: string[];
  /** Old shallow commits now fully included. */
  unshallow: string[];
  /** Haves that are ancestors-or-equal of a want. */
  acks: string[];
}

/**
 * Plan a fetch: which objects to send, the new shallow boundary, unshallow lines, and ACKs.
 * Objects reachable from the haves are never re-sent; a depth limit truncates commit ancestry
 * only (trees/blobs of included commits are sent in full).
 */
export function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const wants = [...new Set(args.wants.filter((oid) => isObjectId(oid) && oid !== ZERO_OID))];
  const haves = [...new Set(args.haves.filter((oid) => isObjectId(oid) && oid !== ZERO_OID))];

  // Fast path: a depth-1 fetch of a single commit, no haves, no client shallow set — the
  // clone workload's shape. The answer is the tip commit plus its full tree subtree; no
  // reachability analysis, no ACKs, no unshallow. The result is identical to the general
  // path for this shape (same object set, same shallow boundary); anything else falls
  // through to the general path below.
  if (haves.length === 0 && args.depth === 1 && args.shallow.length === 0 && wants.length === 1) {
    const tip = lookup(wants[0]!);
    if (tip && tip.type === 'commit') {
      const treeObjects = collectReachable([parseCommit(tip.data).tree], lookup, { allowMissing: true });
      const objects: GitObject[] = [tip];
      const oids: string[] = [wants[0]!];
      for (const oid of treeObjects) {
        const object = lookup(oid);
        if (object) {
          objects.push(object);
          oids.push(oid);
        }
      }
      return { objects, oids, shallow: [wants[0]!], unshallow: [], acks: [] };
    }
  }

  // Tag wants contribute their tag object plus their peeled commit as a walk root; tree/blob
  // wants are included directly; commit wants are walk roots.
  const directObjects = new Set<string>();
  const walkRoots: string[] = [];
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      directObjects.add(want);
      let target = parseTag(object.data).object;
      for (;;) {
        const next = lookup(target);
        if (!next || next.type !== 'tag') break;
        directObjects.add(target);
        target = parseTag(next.data).object;
      }
      const targetObject = lookup(target);
      if (targetObject && targetObject.type === 'commit') walkRoots.push(target);
      else if (targetObject) directObjects.add(target);
    } else if (object.type === 'commit') {
      walkRoots.push(want);
    } else {
      directObjects.add(want);
    }
  }

  const { commits, boundary, treeObjects } = walkWithDepth(walkRoots, lookup, args.depth);

  // Everything the client already holds (full closure of its haves, cut at its shallow boundary —
  // a shallow commit's parents are NOT held) is excluded.
  const shallowSet = new Set(args.shallow.filter((oid) => isObjectId(oid)));
  const held = haves.length
    ? collectReachable(haves, lookup, { allowMissing: true, stopAt: shallowSet })
    : new Set<string>();

  const send = new Set<string>();
  for (const oid of commits.keys()) if (!held.has(oid)) send.add(oid);
  for (const oid of treeObjects) if (!held.has(oid)) send.add(oid);
  for (const oid of directObjects) if (!held.has(oid)) send.add(oid);
  // A direct tree/blob want's subtree (for a tree want) is included in full.
  for (const oid of [...directObjects]) {
    const object = lookup(oid);
    if (object && object.type === 'tree') {
      for (const reached of collectReachable([oid], lookup, { allowMissing: true })) {
        if (!held.has(reached)) send.add(reached);
      }
    }
  }

  const objects: GitObject[] = [];
  const oids: string[] = [];
  for (const oid of send) {
    const object = lookup(oid);
    if (object) {
      objects.push(object);
      oids.push(oid);
    }
  }

  // Shallow: the walk's boundary. Unshallow: the client's old boundary commits that are now in
  // the walk at a generation below the boundary (their parents are now included).
  const shallow = [...boundary];
  const boundarySet = new Set(boundary);
  const unshallow: string[] = [];
  if (args.depth !== null) {
    for (const old of args.shallow) {
      const generation = commits.get(old);
      if (generation !== undefined && !boundarySet.has(old)) unshallow.push(old);
    }
    unshallow.sort();
  }

  // ACK every have that is an ancestor-or-equal of a want (commit) — else the response is NAK.
  const acks: string[] = [];
  for (const have of haves) {
    for (const root of walkRoots) {
      if (isAncestor(have, root, lookup)) {
        acks.push(have);
        break;
      }
    }
  }
  return { objects, oids, shallow, unshallow, acks };
}

/** The pack cache key for a fetch: wants + haves + the client's shallow set + depth determine the object set exactly. */
function packCacheKey(args: FetchArgs): string {
  const wants = [...new Set(args.wants)].sort().join(',');
  const haves = [...new Set(args.haves)].sort().join(',');
  const shallow = [...new Set(args.shallow)].sort().join(',');
  return `${wants}|${haves}|${shallow}|${args.depth ?? ''}`;
}

/** Build (or reuse the cached) pack for a fetch plan. */
function packFor(repo: Repo, args: FetchArgs, plan: FetchPlan): Buffer {
  const key = packCacheKey(args);
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const pack = writePack(plan.objects, plan.oids);
  repo.packCache.set(key, pack);
  return pack;
}

/** Chunk pack bytes into sideband band-1 pkt-lines (each ≤ 65520 bytes total). */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    packets.push(encodePktLine(payload));
  }
  return packets;
}

/** The refs whose tips match a want (for the wanted-refs section). */
function wantedRefs(repo: Repo, wants: readonly string[]): Array<{ oid: string; ref: string }> {
  const wantSet = new Set(wants);
  const out: Array<{ oid: string; ref: string }> = [];
  for (const ref of listRefs(repo)) {
    if (wantSet.has(ref.oid)) out.push({ oid: ref.oid, ref: ref.name });
  }
  return out;
}

/** The full-response cache key: the fetch args + the repo state the response reads. */
function fetchResponseCacheKey(repo: Repo, version: 'v2' | 'v0', args: FetchArgs): string {
  return `${version}|${packCacheKey(args)}|${repo.refsVersion}|${repo.objects.size}`;
}

/** Build the v2 fetch response body for a parsed request. */
export function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = fetchResponseCacheKey(repo, 'v2', args);
  const cached = repo.fetchResponseCache.get(cacheKey);
  if (cached) return cached;
  const plan = planFetch(repo, args);
  const pack = packFor(repo, args, plan);
  const parts: Buffer[] = [];

  // acknowledgments
  const ackLines: Array<string | 'flush'> = ['acknowledgments\n'];
  if (plan.acks.length) {
    for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
  } else {
    ackLines.push('NAK\n');
  }
  ackLines.push('flush');
  parts.push(encodePktLines(ackLines));

  // shallow-info (only when there is something to say)
  if (plan.shallow.length || plan.unshallow.length) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }

  // wanted-refs (only when a want matches a ref tip)
  const wanted = wantedRefs(repo, args.wants);
  if (wanted.length) {
    const lines: Array<string | 'flush'> = ['wanted-refs\n'];
    for (const entry of wanted) lines.push(`${entry.oid} ${entry.ref}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }

  // packfile: at least one sideband packet even for an empty pack.
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(encodePktLines(['flush']));
  const response = Buffer.concat(parts);
  repo.fetchResponseCache.set(cacheKey, response);
  return response;
}

/** Build the v0 fetch response body: NAK/ACK + shallow lines, then the sideband pack. */
export function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = fetchResponseCacheKey(repo, 'v0', args);
  const cached = repo.fetchResponseCache.get(cacheKey);
  if (cached) return cached;
  const plan = planFetch(repo, args);
  const pack = packFor(repo, args, plan);
  const lines: Array<string | 'flush'> = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) lines.push(`ACK ${ack}\n`);
  } else {
    lines.push('NAK\n');
  }
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  const parts: Buffer[] = [encodePktLines(lines)];
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(encodePktLines(['flush']));
  const response = Buffer.concat(parts);
  repo.fetchResponseCache.set(cacheKey, response);
  return response;
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 ls-refs request's argument lines (after the delim). */
function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/**
 * Build the v2 ls-refs response. HEAD is listed first (with symref-target when symrefs is
 * requested); an empty repo lists only `unborn HEAD` (never `unborn refs/...` — the suite's
 * clone-empty check forbids refs-named entries there). Prefixes filter server-side, HEAD included.
 */
export function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const cacheKey = `lsrefs|${repo.refsVersion}|${repo.objects.size}|${args.peel ? 1 : 0}|${args.symrefs ? 1 : 0}|${args.unborn ? 1 : 0}|${args.prefixes.join(',')}`;
  const cached = repo.lsRefsCache.get(cacheKey);
  if (cached) return cached;
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = headTarget(repo);
  if (keep('HEAD')) {
    const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    if (head) {
      lines.push(`${head.oid} HEAD${symref}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${symref}\n`);
    }
  }
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  const response = encodePktLines([...lines, 'flush']);
  repo.lsRefsCache.set(cacheKey, response);
  return response;
}

/**
 * Handle POST /git-upload-pack. A `Git-Protocol: version=2` request is parsed as a v2 command
 * (ls-refs or fetch); anything else is parsed as a v0 fetch. Throws on a malformed body — the
 * caller turns that into a 400 without crashing (repo-survives-errors).
 */
export function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): Buffer {
  const { packets } = decodePktLines(body);
  if (!isV2) {
    // v0: want lines (capabilities on the first), shallow/deepen, flush, have lines, done, flush.
    const lines = packetsToLines(packets);
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
    for (const raw of lines) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const oid = rest.split(' ')[0]!;
        args.wants.push(oid);
      } else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const depth = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(depth) && depth > 0) args.depth = depth;
      } else if (line === 'done') args.done = true;
    }
    return handleFetchV0(repo, args);
  }
  // v2: command line(s), delim, argument lines, flush.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const headPackets = delimIndex < 0 ? packets : packets.slice(0, delimIndex);
  const argPackets = delimIndex < 0 ? [] : packets.slice(delimIndex + 1);
  const headLines = packetsToLines(headPackets);
  const commandLine = (headLines[0] ?? '').replace(/\n$/, '');
  const match = /^command=([a-z-]+)$/.exec(commandLine);
  if (!match) throw new Error(`upload-pack v2 request has no command line (saw ${JSON.stringify(commandLine)})`);
  const command = match[1];
  const argLines = packetsToLines(argPackets);
  if (command === 'ls-refs') return handleLsRefs(repo, parseLsRefsArgs(argLines));
  if (command === 'fetch') return handleFetchV2(repo, parseFetchArgs(argLines));
  throw new Error(`upload-pack v2 command ${JSON.stringify(command)} is not supported`);
}