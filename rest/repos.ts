// REST v3 repository resources (Phase 1: create/get/delete + the current user; Phase 2: list with
// pagination, PATCH, git refs, branches, commits, and the contents API). The repo and user shapes
// are the full GitHub shapes the later phases reuse.

import {
  createRepo as storeCreateRepo,
  deleteRepo as storeDeleteRepo,
  getRepo as storeGetRepo,
  listRepos as storeListRepos,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  nextTimestamp,
  type Repo,
} from '../store.ts';
import {
  commitFile,
  deleteFile,
  listBranches as gitListBranches,
  listCommits as gitListCommits,
  listDirectory,
  lookupPath,
  resolveRefToCommit,
  splitPath,
  type ListedCommit,
} from '../git/commits.ts';
import { isObjectId, parseCommit } from '../git/objects.ts';

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
export function visibleRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return storeGetRepo(owner, name);
}

/** Parse a positive integer query value, with a default when absent or invalid. */
function queryInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * GET /api/v3/user/repos. `per_page` (default 30) and `page` (default 1) paginate the viewer's
 * repositories in creation order; the Link header carries absolute rel="next" and rel="last"
 * URLs on the entry's own origin while another page follows.
 */
export function listUserRepos(query: URLSearchParams, baseUrl: string): RestResult {
  const perPage = Math.min(100, queryInt(query.get('per_page'), 30));
  const page = queryInt(query.get('page'), 1);
  const repos = storeListRepos(VIEWER_LOGIN);
  const total = repos.length;
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < total) {
    const lastPage = Math.ceil(total / perPage);
    headers.link =
      `<${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next", ` +
      `<${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}>; rel="last"`;
  }
  return { status: 200, body: slice.map(repoJson), headers };
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

/** PATCH /api/v3/repos/{owner}/{repo}: description (and private) update, persisted. */
export function patchRepoByOwnerName(owner: string, name: string, body: unknown): RestResult {
  const repo = visibleRepo(owner, name);
  if (!repo) return notFound();
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof input.description === 'string') repo.description = input.description;
  if (typeof input.private === 'boolean') repo.private = input.private;
  repo.updatedAt = nextTimestamp();
  return { status: 200, body: repoJson(repo) };
}

/** The git-ref shape: {ref, object: {sha, type, url}}. */
function refJson(ref: string, sha: string, repo: Repo): Record<string, unknown> {
  const object = repo.objects.get(sha);
  return {
    ref,
    node_id: `R_${repo.id}_${ref}`,
    url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha, type: object?.type ?? 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
  };
}

/** POST /api/v3/repos/{o}/{r}/git/refs: create a ref at an existing object (201). */
export function createGitRef(repo: Repo, body: unknown): RestResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const ref = input.ref;
  const sha = input.sha;
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
    return { status: 422, body: { message: 'ref must start with refs/' } };
  }
  if (typeof sha !== 'string' || !isObjectId(sha.toLowerCase())) {
    return { status: 422, body: { message: 'sha must be a 40-character object id' } };
  }
  const oid = sha.toLowerCase();
  if (!repo.objects.has(oid)) {
    return { status: 422, body: { message: `object ${oid} does not exist` } };
  }
  if (repo.refs.has(ref)) {
    return { status: 422, body: { message: `ref ${ref} already exists` } };
  }
  repo.refs.set(ref, oid);
  repo.refsVersion += 1;
  repo.updatedAt = nextTimestamp();
  return { status: 201, body: refJson(ref, oid, repo) };
}

/** GET /api/v3/repos/{o}/{r}/git/refs/{ref...}: one ref, or 404. */
export function getGitRef(repo: Repo, refPath: string): RestResult {
  const ref = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  return { status: 200, body: refJson(ref, oid, repo) };
}

/** GET /api/v3/repos/{o}/{r}/branches: every branch with its tip commit. */
export function listBranches(repo: Repo): RestResult {
  const branches = gitListBranches(repo).map((branch) => ({
    name: branch.name,
    commit: {
      sha: branch.sha,
      url: `/api/v3/repos/${repo.fullName}/commits/${branch.sha}`,
    },
    protected: false,
  }));
  return { status: 200, body: branches };
}

/** The commit shape: {sha, commit: {message, author, committer}, parents}. */
function commitJson(commit: ListedCommit, repo: Repo): Record<string, unknown> {
  return {
    sha: commit.sha,
    node_id: `C_${commit.sha}`,
    url: `/api/v3/repos/${repo.fullName}/commits/${commit.sha}`,
    html_url: `https://github.com/${repo.fullName}/commit/${commit.sha}`,
    commit: {
      message: commit.message,
      author: { name: commit.authorName, email: commit.authorEmail, date: commit.date },
      committer: { name: commit.authorName, email: commit.authorEmail, date: commit.date },
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((sha) => ({ sha, url: `/api/v3/repos/${repo.fullName}/commits/${sha}` })),
  };
}

/** GET /api/v3/repos/{o}/{r}/commits[?sha=<ref>]: the commits on a ref, newest first. */
export function listCommits(repo: Repo, query: URLSearchParams): RestResult {
  const ref = query.get('sha') ?? undefined;
  // An unknown ref is a 404 on real GitHub; an unborn default branch is an empty list.
  if (ref !== undefined && resolveRefToCommit(repo, ref) === null) return notFound();
  const commits = gitListCommits(repo, ref);
  return { status: 200, body: commits.map((commit) => commitJson(commit, repo)) };
}

/** The contents-API file shape. */
function contentFileJson(repo: Repo, path: string, blobOid: string, content: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    content: content.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
    html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${path}`,
  };
}

/**
 * GET /api/v3/repos/{o}/{r}/contents[/{path}][?ref=]: a file's base64 content, a directory's
 * entries, or 404. With no path, the repository root is listed.
 */
export function getContents(repo: Repo, path: string, query: URLSearchParams): RestResult {
  const ref = query.get('ref') ?? undefined;
  const tip = resolveRefToCommit(repo, ref);
  if (tip === null) return notFound();
  const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
  const segments = splitPath(path);
  if (segments.length === 0) {
    const entries = listDirectory(repo, treeOid, []) ?? [];
    return { status: 200, body: entries.map((entry) => directoryEntryJson(repo, entry, '')) };
  }
  const found = lookupPath(repo, treeOid, segments);
  if (!found) return notFound();
  if (found.type === 'dir') {
    const entries = listDirectory(repo, treeOid, segments) ?? [];
    const dirPath = segments.join('/');
    return { status: 200, body: entries.map((entry) => directoryEntryJson(repo, entry, dirPath)) };
  }
  const blob = repo.objects.get(found.oid);
  if (!blob) return notFound();
  return { status: 200, body: contentFileJson(repo, segments.join('/'), found.oid, blob.data) };
}

/** One directory-listing entry: {type, name, path, sha}. */
function directoryEntryJson(
  repo: Repo,
  entry: { mode: string; name: string; oid: string },
  dirPath: string,
): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    html_url: `https://github.com/${repo.fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${path}`,
  };
}

/** The contents-API commit reply: {content: {sha, encoding}, commit: {sha}}. */
function contentsCommitJson(repo: Repo, path: string, contentSha: string, commitSha: string): Record<string, unknown> {
  return {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: contentSha,
      size: repo.objects.get(contentSha)?.data.length ?? 0,
      url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
      git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${contentSha}`,
      html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
      type: 'file',
      encoding: 'base64',
    },
    commit: {
      sha: commitSha,
      url: `/api/v3/repos/${repo.fullName}/commits/${commitSha}`,
      html_url: `https://github.com/${repo.fullName}/commit/${commitSha}`,
      message: '',
    },
  };
}

/**
 * PUT /api/v3/repos/{o}/{r}/contents/{path}: create (201) or update (200) a file with a commit.
 * A `sha` that does not match the file's current blob is a 409; an unknown branch is a 422.
 */
export function putContents(repo: Repo, path: string, body: unknown): RestResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const message = input.message;
  const content = input.content;
  if (typeof message !== 'string' || message === '') {
    return { status: 422, body: { message: 'message is required' } };
  }
  if (typeof content !== 'string') {
    return { status: 422, body: { message: 'content must be a base64 string' } };
  }
  const branch = typeof input.branch === 'string' ? input.branch : undefined;
  const sha = typeof input.sha === 'string' ? input.sha : undefined;
  const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
  const result = commitFile(repo, { path, content: bytes, message, branch, sha });
  if (!result.ok) {
    if (result.error.kind === 'stale-sha') return { status: 409, body: { message: 'sha does not match the current file' } };
    if (result.error.kind === 'bad-branch') return { status: 422, body: { message: `branch ${JSON.stringify(branch)} does not exist` } };
    return notFound();
  }
  const normalized = splitPath(path).join('/');
  return {
    status: result.result.created ? 201 : 200,
    body: contentsCommitJson(repo, normalized, result.result.contentSha, result.result.commitSha),
  };
}

/**
 * DELETE /api/v3/repos/{o}/{r}/contents/{path}: remove a file with a commit (200 {commit:{sha}}).
 * A `sha` that does not match the file's current blob is a 409; a missing file is a 404.
 */
export function deleteContents(repo: Repo, path: string, body: unknown): RestResult {
  const input = (body ?? {}) as Record<string, unknown>;
  const message = typeof input.message === 'string' ? input.message : '';
  const branch = typeof input.branch === 'string' ? input.branch : undefined;
  const sha = typeof input.sha === 'string' ? input.sha : undefined;
  const result = deleteFile(repo, { path, message, branch, sha });
  if (!result.ok) {
    if (result.error.kind === 'stale-sha') return { status: 409, body: { message: 'sha does not match the current file' } };
    return notFound();
  }
  return {
    status: 200,
    body: {
      commit: {
        sha: result.commitSha,
        url: `/api/v3/repos/${repo.fullName}/commits/${result.commitSha}`,
        html_url: `https://github.com/${repo.fullName}/commit/${result.commitSha}`,
        message,
      },
    },
  };
}

