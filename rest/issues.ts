// REST v3 issue resources (Phase 2): labels, issues, and issue comments. Issues share their
// numbering sequence with pull requests (store.numberCounter), as on real GitHub. Every handler
// is O(1) on the hot path — the read/write workloads hit GET /issues/{n} and POST /issues
// thousands of times — so lookups are Map gets and the serializers build one object each.

import {
  VIEWER_LOGIN,
  nextTimestamp,
  type Issue,
  type IssueComment,
  type Label,
  type Repo,
} from '../store.ts';
import { userJson, type RestResult } from './repos.ts';

function notFound(): RestResult {
  return { status: 404, body: { message: 'Not Found' } };
}

/** The GitHub label shape. */
export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.name,
    node_id: `L_${label.name}`,
    url: `/api/v3/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

/** The GitHub issue shape (the checks assert number, title, body, state, labels). */
export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  const labels = issue.labels.map((name) => {
    const label = repo.labels.get(name);
    return label ? labelJson(label) : { name, color: 'ededed', description: '' };
  });
  return {
    id: issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels,
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

/** The GitHub issue-comment shape (the checks assert id and body). */
export function commentJson(comment: IssueComment, repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${repo.id}_${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

/** POST /api/v3/repos/{o}/{r}/labels (201; a duplicate name is 422). */
export function createLabel(repo: Repo, body: unknown): RestResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = input.name;
  if (typeof name !== 'string' || name === '') {
    return { status: 422, body: { message: 'name is required' } };
  }
  if (repo.labels.has(name)) {
    return { status: 422, body: { message: `label ${JSON.stringify(name)} already exists` } };
  }
  const color = typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed';
  const description = typeof input.description === 'string' ? input.description : '';
  const label: Label = { name, color, description };
  repo.labels.set(name, label);
  return { status: 201, body: labelJson(label) };
}

/** GET /api/v3/repos/{o}/{r}/labels. */
export function listLabels(repo: Repo): RestResult {
  return { status: 200, body: [...repo.labels.values()].map(labelJson) };
}

/** POST /api/v3/repos/{o}/{r}/issues (201; an unknown label is 422). */
export function createIssue(repo: Repo, body: unknown): RestResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const title = input.title;
  if (typeof title !== 'string' || title === '') {
    return { status: 422, body: { message: 'title is required' } };
  }
  const bodyText = typeof input.body === 'string' ? input.body : '';
  const rawLabels = Array.isArray(input.labels) ? input.labels : [];
  const labels: string[] = [];
  for (const entry of rawLabels) {
    const name = typeof entry === 'string' ? entry : (entry as Record<string, unknown> | null)?.name;
    if (typeof name !== 'string') continue;
    if (!repo.labels.has(name)) {
      return { status: 422, body: { message: `label ${JSON.stringify(name)} does not exist` } };
    }
    if (!labels.includes(name)) labels.push(name);
  }
  repo.numberCounter += 1;
  const now = nextTimestamp();
  const issue: Issue = {
    number: repo.numberCounter,
    title,
    body: bodyText,
    state: 'open',
    labels,
    comments: [],
    userLogin: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.set(issue.number, issue);
  return { status: 201, body: issueJson(issue, repo) };
}

/** Parse a positive integer query value, with a default when absent or invalid. */
function queryInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * GET /api/v3/repos/{o}/{r}/issues. `state` filters (open, closed, all; default open),
 * `sort=created` orders by creation, `direction` is asc or desc (default desc), and
 * `per_page`/`page` paginate. The Link header carries rel="next" when another page follows.
 */
export function listIssues(repo: Repo, query: URLSearchParams, baseUrl: string): RestResult {
  const state = (query.get('state') ?? 'open').toLowerCase();
  const direction = (query.get('direction') ?? 'desc').toLowerCase();
  const perPage = Math.min(100, queryInt(query.get('per_page'), 30));
  const page = queryInt(query.get('page'), 1);
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') {
    issues = issues.filter((issue) => issue.state === state);
  }
  // Creation order is number order (numbers come from one counter).
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const total = issues.length;
  const start = (page - 1) * perPage;
  const slice = issues.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < total) {
    const next = `${baseUrl}/api/v3/repos/${repo.fullName}/issues?state=${encodeURIComponent(state)}&sort=created&direction=${encodeURIComponent(direction)}&per_page=${perPage}&page=${page + 1}`;
    const lastPage = Math.ceil(total / perPage);
    const last = `${baseUrl}/api/v3/repos/${repo.fullName}/issues?state=${encodeURIComponent(state)}&sort=created&direction=${encodeURIComponent(direction)}&per_page=${perPage}&page=${lastPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { status: 200, body: slice.map((issue) => issueJson(issue, repo)), headers };
}

/** GET /api/v3/repos/{o}/{r}/issues/{n}. */
export function getIssue(repo: Repo, number: number): RestResult {
  const issue = repo.issues.get(number);
  if (!issue) return notFound();
  return { status: 200, body: issueJson(issue, repo) };
}

/** PATCH /api/v3/repos/{o}/{r}/issues/{n}: state, title, body, labels (unknown label is 422). */
export function patchIssue(repo: Repo, number: number, body: unknown): RestResult {
  const issue = repo.issues.get(number);
  if (!issue) return notFound();
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.title === 'string') issue.title = input.title;
  if (typeof input.body === 'string') issue.body = input.body;
  if (Array.isArray(input.labels)) {
    const labels: string[] = [];
    for (const entry of input.labels) {
      const name = typeof entry === 'string' ? entry : (entry as Record<string, unknown> | null)?.name;
      if (typeof name !== 'string') continue;
      if (!repo.labels.has(name)) {
        return { status: 422, body: { message: `label ${JSON.stringify(name)} does not exist` } };
      }
      if (!labels.includes(name)) labels.push(name);
    }
    issue.labels = labels;
  }
  if (input.state === 'open' || input.state === 'closed') {
    issue.state = input.state;
    issue.closedAt = input.state === 'closed' ? nextTimestamp() : null;
  }
  issue.updatedAt = nextTimestamp();
  return { status: 200, body: issueJson(issue, repo) };
}

/** POST /api/v3/repos/{o}/{r}/issues/{n}/comments (201). */
export function createComment(repo: Repo, number: number, body: unknown): RestResult {
  const issue = repo.issues.get(number);
  if (!issue) return notFound();
  const input = (body ?? {}) as Record<string, unknown>;
  const text = input.body;
  if (typeof text !== 'string' || text === '') {
    return { status: 422, body: { message: 'body is required' } };
  }
  repo.commentCounter += 1;
  const now = nextTimestamp();
  const comment: IssueComment = {
    id: repo.commentCounter,
    body: text,
    userLogin: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
  };
  issue.comments.push(comment);
  return { status: 201, body: commentJson(comment, repo, number) };
}

/** GET /api/v3/repos/{o}/{r}/issues/{n}/comments. */
export function listComments(repo: Repo, number: number): RestResult {
  const issue = repo.issues.get(number);
  if (!issue) return notFound();
  return { status: 200, body: issue.comments.map((comment) => commentJson(comment, repo, number)) };
}
