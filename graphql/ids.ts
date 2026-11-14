// Relay global ids: opaque, stable across reads, and decodable by the mutations that take
// them as input. Format: base64("<Type>:<payload>") — GitHub's real shape. The payloads are
// the store's own ids (repository database id, issue/pull-request number within its repo,
// comment id within its repo), so decoding needs no lookup table, only the store.

import { getRepo, getRepoById, type Issue, type IssueComment, type PullRequest, type Repo } from '../store.ts';

export type GlobalIdKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';

export interface DecodedGlobalId {
  kind: GlobalIdKind;
  /** The repository the id belongs to (the repository itself for a Repository id). */
  repo: Repo;
  /** The issue/pull-request number, or the comment id, for non-repository ids. */
  number: number;
}

/** Encode a global id. The payload is never the plain number, so the id is opaque. */
export function encodeGlobalId(kind: GlobalIdKind, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64');
}

/** A repository's global id. */
export function repositoryGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', String(repo.id));
}

/** An issue's global id. */
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', `${repo.id}:${issue.number}`);
}

/** A pull request's global id. */
export function pullRequestGlobalId(repo: Repo, pull: PullRequest): string {
  return encodeGlobalId('PullRequest', `${repo.id}:${pull.number}`);
}

/** An issue comment's global id. */
export function commentGlobalId(repo: Repo, comment: IssueComment): string {
  return encodeGlobalId('IssueComment', `${repo.id}:${comment.id}`);
}

function parsePositiveInt(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Decode a global id and resolve its repository. Returns null for a malformed id, an
 * unknown kind, or a repository that does not exist — the caller turns that into a
 * GraphQL error (mutations) or a null node (Query.node).
 */
export function decodeGlobalId(id: unknown): DecodedGlobalId | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(Repository|Issue|PullRequest|IssueComment):(\d+)(?::(\d+))?$/.exec(text);
  if (!match) return null;
  const kind = match[1] as GlobalIdKind;
  const repoId = parsePositiveInt(match[2]!);
  if (repoId === null) return null;
  const repo = getRepoById(repoId);
  if (!repo) return null;
  if (kind === 'Repository') {
    if (match[3] !== undefined) return null;
    return { kind, repo, number: repoId };
  }
  const number = match[3] === undefined ? null : parsePositiveInt(match[3]);
  if (number === null) return null;
  return { kind, repo, number };
}

/** Resolve a decoded id to its issue, or null when the id is not an issue id. */
export function issueOf(decoded: DecodedGlobalId): Issue | null {
  if (decoded.kind !== 'Issue') return null;
  return decoded.repo.issues.get(decoded.number) ?? null;
}

/** Resolve a decoded id to its pull request, or null when the id is not a pull-request id. */
export function pullRequestOf(decoded: DecodedGlobalId): PullRequest | null {
  if (decoded.kind !== 'PullRequest') return null;
  return decoded.repo.pulls.get(decoded.number) ?? null;
}

/** The repository a decoded id names (for a Repository id, the repository itself). */
export function repoOf(decoded: DecodedGlobalId): Repo {
  return decoded.repo;
}

/** Re-export for callers that resolve a repository by owner/name first. */
export { getRepo };
