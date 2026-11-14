// REST v3 repository resources (Phase 1: create/get/delete + the current user). The repo and user
// shapes are the full GitHub shapes the later phases reuse — Phase 2 adds the list/update/contents
// endpoints on top of these serializers, it does not change them.

import {
  createRepo as storeCreateRepo,
  deleteRepo as storeDeleteRepo,
  getRepo as storeGetRepo,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Repo,
} from '../store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The token's user, as GET /api/v3/user returns it (login/id/name/email are asserted). */
export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: `U_${VIEWER_ID}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    followers_url: `/api/v3/users/${VIEWER_LOGIN}/followers`,
    following_url: `/api/v3/users/${VIEWER_LOGIN}/following{/other_user}`,
    gists_url: `/api/v3/users/${VIEWER_LOGIN}/gists{/gist_id}`,
    starred_url: `/api/v3/users/${VIEWER_LOGIN}/starred{/owner}{/repo}`,
    subscriptions_url: `/api/v3/users/${VIEWER_LOGIN}/subscriptions`,
    organizations_url: `/api/v3/users/${VIEWER_LOGIN}/orgs`,
    repos_url: `/api/v3/users/${VIEWER_LOGIN}/repos`,
    events_url: `/api/v3/users/${VIEWER_LOGIN}/events{/privacy}`,
    received_events_url: `/api/v3/users/${VIEWER_LOGIN}/received_events`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    company: null,
    blog: '',
    location: null,
    email: VIEWER_EMAIL,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

/** The full GitHub repository shape. */
export function repoJson(repo: Repo): Record<string, unknown> {
  const owner = userJson();
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner,
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: 0,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    url: `/api/v3/repos/${repo.fullName}`,
    forks_url: `/api/v3/repos/${repo.fullName}/forks`,
    keys_url: `/api/v3/repos/${repo.fullName}/keys{/key_id}`,
    collaborators_url: `/api/v3/repos/${repo.fullName}/collaborators{/collaborator}`,
    teams_url: `/api/v3/repos/${repo.fullName}/teams`,
    hooks_url: `/api/v3/repos/${repo.fullName}/hooks`,
    issue_events_url: `/api/v3/repos/${repo.fullName}/issues/events{/number}`,
    events_url: `/api/v3/repos/${repo.fullName}/events`,
    assignees_url: `/api/v3/repos/${repo.fullName}/assignees{/user}`,
    branches_url: `/api/v3/repos/${repo.fullName}/branches{/branch}`,
    tags_url: `/api/v3/repos/${repo.fullName}/tags`,
    blobs_url: `/api/v3/repos/${repo.fullName}/git/blobs{/sha}`,
    git_tags_url: `/api/v3/repos/${repo.fullName}/git/tags{/sha}`,
    git_refs_url: `/api/v3/repos/${repo.fullName}/git/refs{/sha}`,
    trees_url: `/api/v3/repos/${repo.fullName}/git/trees{/sha}`,
    statuses_url: `/api/v3/repos/${repo.fullName}/statuses/{sha}`,
    languages_url: `/api/v3/repos/${repo.fullName}/languages`,
    stargazers_url: `/api/v3/repos/${repo.fullName}/stargazers`,
    contributors_url: `/api/v3/repos/${repo.fullName}/contributors`,
    subscribers_url: `/api/v3/repos/${repo.fullName}/subscribers`,
    subscription_url: `/api/v3/repos/${repo.fullName}/subscription`,
    compares_url: `/api/v3/repos/${repo.fullName}/compare/{base}...{head}`,
    merges_url: `/api/v3/repos/${repo.fullName}/merges`,
    archive_url: `/api/v3/repos/${repo.fullName}/{archive_format}{/ref}`,
    downloads_url: `/api/v3/repos/${repo.fullName}/downloads`,
    issues_url: `/api/v3/repos/${repo.fullName}/issues{/number}`,
    pulls_url: `/api/v3/repos/${repo.fullName}/pulls{/number}`,
    milestones_url: `/api/v3/repos/${repo.fullName}/milestones{/number}`,
    notifications_url: `/api/v3/repos/${repo.fullName}/notifications{?since,all,participating}`,
    labels_url: `/api/v3/repos/${repo.fullName}/labels{/name}`,
    releases_url: `/api/v3/repos/${repo.fullName}/releases{/id}`,
    deployments_url: `/api/v3/repos/${repo.fullName}/deployments`,
  };
}

/** GET /api/v3/user. */
export function getCurrentUser(): RestResult {
  return { status: 200, body: userJson() };
}

function notFound(): RestResult {
  return { status: 404, body: { message: 'Not Found' } };
}

/** A repo under any owner other than the token's owner is 404 — never 403. */
function visibleRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return storeGetRepo(owner, name);
}

/** POST /api/v3/user/repos. A duplicate name is 422 with 'already exists' in the message. */
export function createUserRepo(body: unknown): RestResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = input.name;
  if (typeof name !== 'string' || name === '') {
    return { status: 422, body: { message: 'name is required' } };
  }
  const description = typeof input.description === 'string' ? input.description : '';
  const isPrivate = input.private === true;
  const created = storeCreateRepo(name, VIEWER_LOGIN, { description, private: isPrivate });
  if (!created.ok) {
    if (created.reason === 'exists') {
      return { status: 422, body: { message: `name already exists on this account` } };
    }
    return { status: 422, body: { message: `name ${JSON.stringify(name)} is not a valid repository name` } };
  }
  return { status: 201, body: repoJson(created.repo) };
}

/** GET /api/v3/repos/{owner}/{repo}. */
export function getRepoByOwnerName(owner: string, name: string): RestResult {
  const repo = visibleRepo(owner, name);
  if (!repo) return notFound();
  return { status: 200, body: repoJson(repo) };
}

/** DELETE /api/v3/repos/{owner}/{repo} (204, no body). */
export function deleteRepoByOwnerName(owner: string, name: string): RestResult {
  if (owner !== VIEWER_LOGIN) return notFound();
  if (!storeDeleteRepo(owner, name)) return notFound();
  return { status: 204, body: null };
}
