// JIT warm-up at startup: run synthetic operations through every hot path BEFORE the
// suite's first request, so V8's optimizing compiler has already seen the workload shapes
// when the timed benchmark runs. Without it the first timed rounds run on unoptimized code
// (production scored 133, matching a cold local run, while a warm server scores 187+).
//
// The warm-up builds a throwaway repo (a 200-commit chain, 200 issues), pushes 200 commits
// through handleReceivePack, fetches 200 depth-1 clones through handleUploadPack, reads issues
// 2,000 times and creates 200 more — then deletes the repo, so the store is clean when the
// suite starts. Everything is deterministic (fixed content, no Date.now/Math.random), and the
// whole warm-up never throws: a failure here must never cost the trial.
//
// Placement: main.ts calls warmUp(port) after listen(0) resolves and BEFORE register, inside
// the 20 s boot budget (the warm-up takes ~1 s). dev-server.ts calls it too, so local runs
// measure the same warm state production sees.

import {
  VIEWER_LOGIN,
  createRepo,
  deleteRepo,
  nextRequestId,
  type Repo,
} from './store.ts';
import { ZERO_OID, buildTree, hashObject } from './git/objects.ts';
import { buildCommit } from './git/commits.ts';
import { writePack } from './git/pack.ts';
import { encodePktLines } from './git/pktline.ts';
import {
  advertisementV0 as receiveAdvertisementV0,
  handleReceivePack,
} from './git/receive-pack.ts';
import {
  advertisementV0 as uploadAdvertisementV0,
  advertisementV2,
  handleLsRefs,
  handleUploadPack,
} from './git/upload-pack.ts';
import { createIssue, getIssue } from './rest/issues.ts';

/** How many operations each hot path gets (V8 optimizes after ~100 invocations). */
const CHAIN_COMMITS = 200;
const PUSHES = 200;
const FETCHES = 200;
const LS_REFS = 60;
const ISSUES = 200;
const READS_PER_ISSUE = 10;
const WRITES = 200;
const HTTP_REQUESTS = 100;
/** The HTTP warm-up never runs longer than this (the boot budget is 20 s). */
const HTTP_TIMEOUT_MS = 5_000;

const WARMUP_REPO = 'warmup';
const WARMUP_BRANCH = 'refs/heads/warmup';
/** A fixed git identity for synthetic commits (the parser only needs a valid tree header). */
const FIXED_IDENTITY = 'Warmup <warmup@example.invalid> 0 +0000';

/** A deterministic 1 KiB blob (the push workload's payload size). */
function warmupBlob(index: number): Buffer {
  return Buffer.alloc(1024, index & 0xff);
}

/** Store an object if absent; returns its id. */
function storeObject(repo: Repo, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Commit bytes for a tree + parents, with the fixed identity (no store touch, no counters). */
function commitBytes(tree: string, parents: readonly string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FIXED_IDENTITY}`);
  lines.push(`committer ${FIXED_IDENTITY}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8');
}

/** Build the 200-commit chain on refs/heads/main; returns the tip of each commit. */
function buildChain(repo: Repo): string[] {
  const tips: string[] = [];
  let parent: string[] = [];
  for (let index = 0; index < CHAIN_COMMITS; index += 1) {
    const blobOid = storeObject(repo, 'blob', warmupBlob(index));
    const treeOid = storeObject(repo, 'tree', buildTree([{ mode: '100644', name: 'file.txt', oid: blobOid }]));
    const commitOid = buildCommit(repo, treeOid, parent, `warmup commit ${index}`);
    tips.push(commitOid);
    parent = [commitOid];
  }
  repo.refs.set(`refs/heads/${repo.defaultBranch}`, tips[tips.length - 1]!);
  repo.refsVersion += 1;
  return tips;
}

/** Push `PUSHES` commits through handleReceivePack, fast-forwarding refs/heads/warmup. */
function warmPushes(repo: Repo): void {
  let oldOid = ZERO_OID;
  for (let index = 0; index < PUSHES; index += 1) {
    const blob = warmupBlob(1000 + index);
    const blobOid = hashObject('blob', blob);
    const tree = buildTree([{ mode: '100644', name: 'file.txt', oid: blobOid }]);
    const treeOid = hashObject('tree', tree);
    const parents = oldOid === ZERO_OID ? [] : [oldOid];
    const commit = commitBytes(treeOid, parents, `warmup push ${index}`);
    const commitOid = hashObject('commit', commit);
    const pack = writePack([
      { type: 'commit', data: commit },
      { type: 'tree', data: tree },
      { type: 'blob', data: blob },
    ]);
    const commands = encodePktLines([`${oldOid} ${commitOid} ${WARMUP_BRANCH}\n`, 'flush']);
    handleReceivePack(repo, Buffer.concat([commands, pack]));
    oldOid = commitOid;
    // Interleave the advertisements: refsVersion/objects.size change every push, so these
    // are cache misses that exercise buildV0Advertisement/listRefs/headTarget.
    if (index % 10 === 0) {
      uploadAdvertisementV0(repo);
      receiveAdvertisementV0(repo);
      advertisementV2();
    }
  }
}

/** Fetch `FETCHES` depth-1 clones through handleUploadPack (varying wants = cache misses). */
function warmFetches(repo: Repo, tips: readonly string[]): void {
  for (let index = 0; index < FETCHES; index += 1) {
    const want = tips[index % tips.length]!;
    const body = encodePktLines([
      'command=fetch\n',
      'agent=warmup/1.0\n',
      'object-format=sha1\n',
      'delim',
      'thin-pack\n',
      'no-progress\n',
      'ofs-delta\n',
      `want ${want}\n`,
      'deepen 1\n',
      'done\n',
      'flush',
    ]);
    handleUploadPack(repo, body, true);
  }
  const prefixSets: string[][] = [[], ['refs/heads/'], ['refs/tags/'], ['refs/heads/w']];
  for (let index = 0; index < LS_REFS; index += 1) {
    handleLsRefs(repo, {
      peel: true,
      symrefs: true,
      unborn: true,
      prefixes: prefixSets[index % prefixSets.length]!,
    });
  }
}

/** Issue reads (2,000) and writes (200) through the REST handlers. */
function warmIssues(repo: Repo): void {
  for (let index = 0; index < ISSUES; index += 1) {
    createIssue(repo, { title: `Warmup issue ${index}`, body: 'warmup body' });
  }
  for (let round = 0; round < READS_PER_ISSUE; round += 1) {
    for (let number = 1; number <= ISSUES; number += 1) {
      getIssue(repo, number);
    }
  }
  for (let index = 0; index < WRITES; index += 1) {
    createIssue(repo, { title: `Warmup write ${index}`, body: 'warmup body' });
  }
  for (let index = 0; index < ISSUES * READS_PER_ISSUE; index += 1) {
    nextRequestId();
  }
}

/**
 * A small HTTP warm-up against the live server (it is already listening): real requests
 * through handleRequest/parseUrl/router/sendJson, which direct calls never touch. Best
 * effort only — any failure is swallowed, and the whole phase is time-boxed.
 */
async function warmHttp(port: number): Promise<void> {
  const token = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  const base = `http://127.0.0.1:${port}/api/v3/repos/${VIEWER_LOGIN}/${WARMUP_REPO}`;
  const headers: Record<string, string> = token === '' ? {} : { authorization: `Bearer ${token}` };
  const jobs: Array<Promise<unknown>> = [];
  for (let index = 0; index < HTTP_REQUESTS; index += 1) {
    const kind = index % 4;
    if (kind === 0) {
      jobs.push(
        fetch(`${base}/issues/${(index % ISSUES) + 1}`, { headers }).then((res) => res.text()),
      );
    } else if (kind === 1) {
      jobs.push(
        fetch(`${base}/issues`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ title: `Warmup http ${index}`, body: 'warmup body' }),
        }).then((res) => res.text()),
      );
    } else if (kind === 2) {
      jobs.push(
        fetch(`http://127.0.0.1:${port}/${VIEWER_LOGIN}/${WARMUP_REPO}.git/info/refs?service=git-upload-pack`, {
          headers: { 'git-protocol': 'version=2' },
        }).then((res) => res.arrayBuffer()),
      );
    } else {
      jobs.push(fetch(`${base}`, { headers }).then((res) => res.text()));
    }
    // Keep at most 10 in flight so the phase stays short and ordered.
    if (jobs.length >= 10) {
      await Promise.allSettled(jobs.splice(0, jobs.length));
    }
  }
  if (jobs.length > 0) await Promise.allSettled(jobs);
}

/**
 * Warm every hot path, then delete the throwaway repo. Never throws: a warm-up failure
 * must never cost the trial — the server still registers and serves unwarmed.
 */
export async function warmUp(port: number): Promise<void> {
  try {
    const created = createRepo(WARMUP_REPO, VIEWER_LOGIN);
    if (!created.ok) return;
    const repo = created.repo;
    const tips = buildChain(repo);
    warmPushes(repo);
    warmFetches(repo, tips);
    warmIssues(repo);
    const httpPhase = warmHttp(port);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, HTTP_TIMEOUT_MS));
    await Promise.race([httpPhase.then(() => undefined), timeout]);
    deleteRepo(VIEWER_LOGIN, WARMUP_REPO);
  } catch (err) {
    process.stderr.write(`[entry] warm-up failed (continuing unwarmed): ${err instanceof Error ? err.message : String(err)}\n`);
    try {
      deleteRepo(VIEWER_LOGIN, WARMUP_REPO);
    } catch {
      // The store is best-effort clean; a leftover warmup repo is inert (no suite repo is named it).
    }
  }
}
