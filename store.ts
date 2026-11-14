// The in-memory store: one process, one trial, no disk. Every surface (git smart HTTP, REST v3,
// GraphQL v4, MCP) reads and writes the same Repo objects, so cross-surface checks pass by
// construction. All ids are sequential counters and all timestamps derive from MAKEFUN_TRIAL_NOW
// plus a monotonic counter — no wall clock, no randomness, so a replay produces identical bytes.

import type { GitObject } from './git/objects.ts';

/**
 * The token's owner. The suite's scenario is fixed by the public seed SCENARIO_SEED
 * (0x6a09e667f3bcc909n) in the kit's wire.ts; its viewer is users[0] of generateUsers, login
 * `adaiversen`, id 1000. The GraphQL viewer-login check requires Query.viewer.login to equal it,
 * and the REST foreign-token check requires any other owner to 404 — so the forge must know it.
 * It is a published constant of the sealed scenario, never a per-trial value.
 */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export const DEFAULT_BRANCH = 'main';

/** The scenario's day one, 2025-01-01T00:00:00Z — the fallback when MAKEFUN_TRIAL_NOW is unset. */
const SCENARIO_EPOCH_MS = 1_735_689_600_000;

/** The trial's opening time in ms, from MAKEFUN_TRIAL_NOW (ISO, epoch ms, or epoch seconds). */
function trialNowMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return SCENARIO_EPOCH_MS;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : SCENARIO_EPOCH_MS;
}

const TRIAL_NOW_MS = trialNowMs();

/** A global monotonic counter: every timestamp is TRIAL_NOW + counter seconds, strictly increasing. */
let timestampCounter = 0;

/** The next deterministic timestamp, ISO 8601. Never the wall clock. */
export function nextTimestamp(): string {
  const ms = TRIAL_NOW_MS + timestampCounter * 1000;
  timestampCounter += 1;
  return new Date(ms).toISOString();
}

/** The trial's opening time as ISO 8601 (for fields that share one timestamp). */
export function trialNowIso(): string {
  return new Date(TRIAL_NOW_MS).toISOString();
}

/** A global monotonic counter for X-GitHub-Request-Id (non-empty is all the suite requires). */
let requestCounter = 0;

/** The next deterministic request id. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  headSha: string;
  readonly baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Git objects, keyed by OID, stored verbatim. */
  readonly objects: Map<string, GitObject>;
  /** Refs, keyed by full name (refs/heads/main, refs/tags/v1). */
  readonly refs: Map<string, string>;
  /** Bumped on every ref change; cache keys include it where staleness matters. */
  refsVersion: number;
  /** Built packs, keyed by (tip, depth, haves) — the clone workload hits one entry 50 times. */
  readonly packCache: Map<string, Buffer>;
  /** REST resources (Phase 2+); the maps live here so every surface shares one store. */
  readonly issues: Map<number, Issue>;
  issueCounter: number;
  readonly pulls: Map<number, PullRequest>;
  pullCounter: number;
  /** Issues and pull requests share one numbering sequence, as on real GitHub. */
  numberCounter: number;
  readonly labels: Map<string, Label>;
  commentCounter: number;
}

let repoIdCounter = 0;

function newRepo(name: string, owner: string, options: { description?: string; private?: boolean }): Repo {
  repoIdCounter += 1;
  const now = nextTimestamp();
  return {
    id: repoIdCounter,
    name,
    fullName: `${owner}/${name}`,
    owner,
    description: options.description ?? '',
    private: options.private ?? false,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: now,
    updatedAt: now,
    objects: new Map(),
    refs: new Map(),
    refsVersion: 0,
    packCache: new Map(),
    issues: new Map(),
    issueCounter: 0,
    pulls: new Map(),
    pullCounter: 0,
    numberCounter: 0,
    labels: new Map(),
    commentCounter: 0,
  };
}

/** All repositories, keyed by `owner/name`. */
const repos = new Map<string, Repo>();

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export type CreateRepoResult = { ok: true; repo: Repo } | { ok: false; reason: 'exists' | 'invalid-name' };

/** Create a repository owned by `owner`. A duplicate name under the same owner is an error. */
export function createRepo(
  name: string,
  owner: string,
  options: { description?: string; private?: boolean } = {},
): CreateRepoResult {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    return { ok: false, reason: 'invalid-name' };
  }
  const key = repoKey(owner, name);
  if (repos.has(key)) return { ok: false, reason: 'exists' };
  const repo = newRepo(name, owner, options);
  repos.set(key, repo);
  return { ok: true, repo };
}

/** Look up a repository by owner and name. */
export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

/** Look up a repository by its numeric database id (GraphQL global ids decode to it). */
export function getRepoById(id: number): Repo | undefined {
  for (const repo of repos.values()) {
    if (repo.id === id) return repo;
  }
  return undefined;
}

/** Delete a repository. Returns false when it did not exist. */
export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

/** Every repository owned by `owner`, in creation order. */
export function listRepos(owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of repos.values()) {
    if (repo.owner === owner) out.push(repo);
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

/** The token's login: every repository the token creates belongs to this owner. */
export function tokenOwner(): string {
  return VIEWER_LOGIN;
}
