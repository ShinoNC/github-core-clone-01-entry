// REST v3 pull-request resources (Phase 3): create/list/get, the files diff, and the squash
// merge with real three-way conflict detection (git/merge.ts). Pull requests share their
// numbering sequence with issues (store.numberCounter), as on real GitHub.
//
// The core functions (createPullRequest, mergePullRequest, pullFiles, isMergeable) are pure over
// the store and are the same functions the GraphQL and MCP surfaces will call in later phases —
// one store, four surfaces — so a PR created over one surface reads back identically over another.

import { branchTip } from '../git/commits.ts';
import {
  commitTree,
  diffTrees,
  findMergeBase,
  flattenTree,
  lineDiffCounts,
  planSquashMerge,
  squashMerge,
  type PathChange,
} from '../git/merge.ts';
import { VIEWER_LOGIN, nextTimestamp, type PullRequest, type Repo } from '../store.ts';
import { userJson, type RestResult } from './repos.ts';

function notFound(): RestResult {
  return { status: 404, body: { message: 'Not Found' } };
}

/** Parse a positive integer query value, with a default when absent or invalid. */
function queryInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// -------------------------------------------------------------------------------------------
// Core pull-request operations (shared by REST, GraphQL, MCP)

export type CreatePullError =
  | { kind: 'missing-title' }
  | { kind: 'missing-head' }
  | { kind: 'missing-base' }
  | { kind: 'unknown-head' }
  | { kind: 'unknown-base' };

/**
 * Open a pull request from `head` onto `base`. The head and base shas are the branch tips at
 * creation; the number comes from the shared issue/PR sequence. Both branches must exist.
 */
export function createPullRequest(
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): { ok: true; pull: PullRequest } | { ok: false; error: CreatePullError } {
  if (input.title === '') return { ok: false, error: { kind: 'missing-title' } };
  if (input.head === '') return { ok: false, error: { kind: 'missing-head' } };
  if (input.base === '') return { ok: false, error: { kind: 'missing-base' } };
  const headSha = branchTip(repo, input.head);
  if (headSha === null) return { ok: false, error: { kind: 'unknown-head' } };
  const baseSha = branchTip(repo, input.base);
  if (baseSha === null) return { ok: false, error: { kind: 'unknown-base' } };
  repo.numberCounter += 1;
  const now = nextTimestamp();
  const pull: PullRequest = {
    number: repo.numberCounter,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    headSha,
    baseRef: input.base,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergeable: true,
    userLogin: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(pull.number, pull);
  return { ok: true, pull };
}

/** The live tips of a pull request's branches (null when a branch no longer exists). */
function liveTips(repo: Repo, pull: PullRequest): { baseTip: string; headTip: string } | null {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return null;
  return { baseTip, headTip };
}

/**
 * Whether the pull request can merge cleanly right now: open, both branches present, and the
 * three-way merge has no conflicts. A merged or closed pull request is never mergeable.
 */
export function isMergeable(repo: Repo, pull: PullRequest): boolean {
  if (pull.state !== 'open' || pull.merged) return false;
  const tips = liveTips(repo, pull);
  if (tips === null) return false;
  return planSquashMerge(repo, tips.baseTip, tips.headTip).ok;
}

export type MergePullError =
  | { kind: 'not-found' }
  | { kind: 'already-merged' }
  | { kind: 'closed' }
  | { kind: 'missing-branch' }
  | { kind: 'conflict'; conflicts: string[] };

/**
 * Squash-merge a pull request onto its base branch: the head side's changes land as ONE commit
 * on the base branch (parent = the base tip), the pull request closes as merged, and the merge
 * commit id is returned. A conflicted pull request is refused without changing anything.
 */
export function mergePullRequest(
  repo: Repo,
  number: number,
): { ok: true; sha: string } | { ok: false; error: MergePullError } {
  const pull = repo.pulls.get(number);
  if (!pull) return { ok: false, error: { kind: 'not-found' } };
  if (pull.merged) return { ok: false, error: { kind: 'already-merged' } };
  if (pull.state !== 'open') return { ok: false, error: { kind: 'closed' } };
  const tips = liveTips(repo, pull);
  if (tips === null) return { ok: false, error: { kind: 'missing-branch' } };
  const merged = squashMerge(repo, pull.baseRef, tips.baseTip, tips.headTip, `${pull.title} (#${pull.number})`);
  if (!merged.ok) return { ok: false, error: { kind: 'conflict', conflicts: merged.conflicts } };
  const now = nextTimestamp();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = merged.commitSha;
  pull.mergeable = false;
  pull.updatedAt = now;
  repo.updatedAt = nextTimestamp();
  return { ok: true, sha: merged.commitSha };
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  /** The blob id after the change (the old blob for a removal). */
  readonly sha: string;
}

/**
 * The pull request's changed files: the diff between the merge base of the stored head/base shas
 * and the head tip. The stored shas are used (not the live branches) so the list is a property
 * of the pull request's own commits, as on real GitHub.
 */
export function pullFiles(repo: Repo, pull: PullRequest): PullFile[] {
  const mergeBase = findMergeBase(repo, pull.baseSha, pull.headSha);
  const ancestorTree = mergeBase === null ? null : commitTree(repo, mergeBase);
  const ancestorFlat = ancestorTree === null ? new Map() : flattenTree(repo, ancestorTree);
  const headFlat = flattenTree(repo, commitTree(repo, pull.headSha));
  const changes: Map<string, PathChange> = diffTrees(ancestorFlat, headFlat);
  const out: PullFile[] = [];
  for (const [filename, change] of changes) {
    const counts = lineDiffCounts(repo, change);
    out.push({
      filename,
      status: change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: change.oid ?? change.oldOid ?? '',
    });
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

// -------------------------------------------------------------------------------------------
// Serializers

/** The GitHub pull-request shape (the checks assert number, state, title, body, head, base). */
export function pullJson(pull: PullRequest, repo: Repo): Record<string, unknown> {
  const files = pullFiles(repo, pull);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const mergeable = isMergeable(repo, pull);
  const head = {
    label: `${repo.owner}:${pull.headRef}`,
    ref: pull.headRef,
    sha: pull.headSha,
    user: userJson(),
    repo: {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      owner: userJson(),
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    },
  };
  const base = {
    label: `${repo.owner}:${pull.baseRef}`,
    ref: pull.baseRef,
    sha: pull.baseSha,
    user: userJson(),
    repo: {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      owner: userJson(),
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    },
  };
  return {
    id: pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
    commits_url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.fullName}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.fullName}/statuses/${pull.headSha}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(),
    body: pull.body,
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? pull.updatedAt) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head,
    base,
    _links: {
      self: { href: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}` },
      html: { href: `https://github.com/${repo.fullName}/pull/${pull.number}` },
      issue: { href: `/api/v3/repos/${repo.fullName}/issues/${pull.number}` },
      comments: { href: `/api/v3/repos/${repo.fullName}/issues/${pull.number}/comments` },
      review_comments: { href: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/comments` },
      review_comment: { href: `/api/v3/repos/${repo.fullName}/pulls/comments{/number}` },
      commits: { href: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/commits` },
      statuses: { href: `/api/v3/repos/${repo.fullName}/statuses/${pull.headSha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
    merged: pull.merged,
    mergeable,
    rebaseable: mergeable,
    mergeable_state: mergeable ? 'clean' : pull.merged ? 'merged' : 'dirty',
    merged_by: pull.merged ? userJson() : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions,
    deletions,
    changed_files: files.length,
  };
}

/** One pull-request file: {filename, status, additions, deletions, changes, sha}. */
export function pullFileJson(file: PullFile, repo: Repo): Record<string, unknown> {
  return {
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: `/api/v3/repos/${repo.fullName}/git/blobs/${file.sha}`,
    raw_url: `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${file.filename}`,
    contents_url: `/api/v3/repos/${repo.fullName}/contents/${file.filename}`,
  };
}

// -------------------------------------------------------------------------------------------
// REST handlers

/** POST /api/v3/repos/{o}/{r}/pulls (201; an unknown branch is 422). */
export function createPull(repo: Repo, body: unknown): RestResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const title = input.title;
  const head = input.head;
  const base = input.base;
  const created = createPullRequest(repo, {
    title: typeof title === 'string' ? title : '',
    body: typeof input.body === 'string' ? input.body : '',
    head: typeof head === 'string' ? head : '',
    base: typeof base === 'string' ? base : '',
  });
  if (!created.ok) {
    const messages: Record<CreatePullError['kind'], string> = {
      'missing-title': 'title is required',
      'missing-head': 'head is required',
      'missing-base': 'base is required',
      'unknown-head': `head branch ${JSON.stringify(head)} does not exist`,
      'unknown-base': `base branch ${JSON.stringify(base)} does not exist`,
    };
    return { status: 422, body: { message: messages[created.error.kind] } };
  }
  return { status: 201, body: pullJson(created.pull, repo) };
}

/**
 * GET /api/v3/repos/{o}/{r}/pulls. `state` filters (open, closed, all; default open) and
 * `per_page`/`page` paginate, newest first. The Link header carries rel="next" while another
 * page follows.
 */
export function listPulls(repo: Repo, query: URLSearchParams, baseUrl: string): RestResult {
  const state = (query.get('state') ?? 'open').toLowerCase();
  const perPage = Math.min(100, queryInt(query.get('per_page'), 30));
  const page = queryInt(query.get('page'), 1);
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') {
    pulls = pulls.filter((pull) => pull.state === state);
  }
  pulls.sort((a, b) => b.number - a.number);
  const total = pulls.length;
  const start = (page - 1) * perPage;
  const slice = pulls.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < total) {
    const next = `${baseUrl}/api/v3/repos/${repo.fullName}/pulls?state=${encodeURIComponent(state)}&per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(total / perPage);
    const last = `${baseUrl}/api/v3/repos/${repo.fullName}/pulls?state=${encodeURIComponent(state)}&per_page=${perPage}&page=${lastPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { status: 200, body: slice.map((pull) => pullJson(pull, repo)), headers };
}

/** GET /api/v3/repos/{o}/{r}/pulls/{n}. */
export function getPull(repo: Repo, number: number): RestResult {
  const pull = repo.pulls.get(number);
  if (!pull) return notFound();
  return { status: 200, body: pullJson(pull, repo) };
}

/** GET /api/v3/repos/{o}/{r}/pulls/{n}/files. */
export function listPullFiles(repo: Repo, number: number): RestResult {
  const pull = repo.pulls.get(number);
  if (!pull) return notFound();
  return { status: 200, body: pullFiles(repo, pull).map((file) => pullFileJson(file, repo)) };
}

/**
 * PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge: squash-merge (200 {merged:true, sha, message}).
 * An unknown pull request is 404; a conflicted, already-merged, or closed pull request is 405
 * with a message (the suite's conflict check expects exactly 405).
 */
export function mergePull(repo: Repo, number: number): RestResult {
  const result = mergePullRequest(repo, number);
  if (!result.ok) {
    const error = result.error;
    if (error.kind === 'not-found') return notFound();
    if (error.kind === 'conflict') {
      return { status: 405, body: { message: `Pull request is not mergeable: conflicting files: ${error.conflicts.join(', ')}` } };
    }
    if (error.kind === 'already-merged') {
      return { status: 405, body: { message: 'Pull request has already been merged' } };
    }
    if (error.kind === 'closed') {
      return { status: 405, body: { message: 'Pull request is closed' } };
    }
    return { status: 405, body: { message: 'Pull request is not mergeable: a branch no longer exists' } };
  }
  return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
}
