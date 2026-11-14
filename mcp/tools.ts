// MCP tools (Phase 5): the six tools the suite's mcp group calls, as thin wrappers over the
// same store cores REST and GraphQL use — one store, four surfaces. A tool result carries the
// object twice (a JSON text block AND structuredContent) because the suite reads both shapes:
// resultText for titles/numbers, resultJson for ids. A tool failure is isError: true, never a
// thrown error and never an HTTP 500.
//
// The tools list is a module constant built once: two tools/list calls answer the same list,
// byte for byte (tools-list-idempotent). `required` holds only what the suite always sends —
// a required property the suite cannot fill fails the check that calls the tool.

import { createRepo as storeCreateRepo, VIEWER_LOGIN, type Repo } from '../store.ts';
import { createIssueRecord, issueJson } from '../rest/issues.ts';
import { createPullRequest, mergePullRequest, pullJson } from '../rest/pulls.ts';
import { repoJson, visibleRepo } from '../rest/repos.ts';

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, Record<string, unknown>>;
    readonly required: readonly string[];
  };
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

function booleanProp(description: string): Record<string, unknown> {
  return { type: 'boolean', description };
}

function integerProp(description: string): Record<string, unknown> {
  return { type: 'integer', description };
}

/** The six tools, in the order tools/list answers them. Built once, never mutated. */
export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: booleanProp('Whether the repository is private.'),
      },
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open, closed, or all.'),
      },
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
      },
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: integerProp('The pull request number.'),
      },
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(data: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}

function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

type Args = Record<string, unknown>;

function stringArg(args: Args, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function optionalStringArg(args: Args, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function numberArg(args: Args, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Resolve owner/repo to a visible repository (a foreign owner is Not Found, never 403). */
function resolveRepo(args: Args): { repo: Repo } | { error: string } {
  const owner = stringArg(args, 'owner');
  const name = stringArg(args, 'repo');
  if (owner === null || name === null) return { error: 'owner and repo are required' };
  const repo = visibleRepo(owner, name);
  if (!repo) return { error: `repository ${owner}/${name} was not found` };
  return { repo };
}

/** create_repo: the repository belongs to the token's owner, as on REST. */
function toolCreateRepo(args: Args): McpToolResult {
  const name = stringArg(args, 'name');
  if (name === null) return errorResult('name is required');
  const description = optionalStringArg(args, 'description');
  const isPrivate = args.private === true;
  const created = storeCreateRepo(name, VIEWER_LOGIN, { description, private: isPrivate });
  if (!created.ok) {
    if (created.reason === 'exists') return errorResult(`name already exists on this account`);
    return errorResult(`name ${JSON.stringify(name)} is not a valid repository name`);
  }
  return okResult(repoJson(created.repo));
}

/** get_repo: the full repository shape. */
function toolGetRepo(args: Args): McpToolResult {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return errorResult(resolved.error);
  return okResult(repoJson(resolved.repo));
}

/** create_issue: an open issue over the shared issue/PR numbering sequence. */
function toolCreateIssue(args: Args): McpToolResult {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return errorResult(resolved.error);
  const title = stringArg(args, 'title');
  if (title === null) return errorResult('title is required');
  const issue = createIssueRecord(resolved.repo, title, optionalStringArg(args, 'body'));
  return okResult(issueJson(issue, resolved.repo));
}

/** list_issues: the repository's issues, newest first, filtered by state. */
function toolListIssues(args: Args): McpToolResult {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return errorResult(resolved.error);
  const repo = resolved.repo;
  const state = optionalStringArg(args, 'state').toLowerCase();
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') {
    issues = issues.filter((issue) => issue.state === state);
  }
  issues.sort((a, b) => b.number - a.number);
  return okResult(issues.map((issue) => issueJson(issue, repo)));
}

/** create_pull_request: opens the PR; the REST shape carries number, head, and base. */
function toolCreatePullRequest(args: Args): McpToolResult {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return errorResult(resolved.error);
  const title = stringArg(args, 'title');
  const head = stringArg(args, 'head');
  const base = stringArg(args, 'base');
  if (title === null) return errorResult('title is required');
  if (head === null) return errorResult('head is required');
  if (base === null) return errorResult('base is required');
  const created = createPullRequest(resolved.repo, {
    title,
    body: optionalStringArg(args, 'body'),
    head,
    base,
  });
  if (!created.ok) {
    const messages: Record<string, string> = {
      'missing-title': 'title is required',
      'missing-head': 'head is required',
      'missing-base': 'base is required',
      'unknown-head': `head branch ${JSON.stringify(head)} does not exist`,
      'unknown-base': `base branch ${JSON.stringify(base)} does not exist`,
    };
    return errorResult(messages[created.error.kind] ?? 'could not create the pull request');
  }
  return okResult(pullJson(created.pull, resolved.repo));
}

/** merge_pull_request: squash-merges; the merged PR reads back over REST as merged:true. */
function toolMergePullRequest(args: Args): McpToolResult {
  const resolved = resolveRepo(args);
  if ('error' in resolved) return errorResult(resolved.error);
  const number = numberArg(args, 'pull_number');
  if (number === null) return errorResult('pull_number is required');
  const result = mergePullRequest(resolved.repo, number);
  if (!result.ok) {
    const error = result.error;
    if (error.kind === 'not-found') return errorResult(`pull request #${number} was not found`);
    if (error.kind === 'conflict') {
      return errorResult(`Pull request is not mergeable: conflicting files: ${error.conflicts.join(', ')}`);
    }
    if (error.kind === 'already-merged') return errorResult('Pull request has already been merged');
    if (error.kind === 'closed') return errorResult('Pull request is closed');
    return errorResult('Pull request is not mergeable: a branch no longer exists');
  }
  const pull = resolved.repo.pulls.get(number);
  if (!pull) return errorResult(`pull request #${number} was not found`);
  return okResult(pullJson(pull, resolved.repo));
}

const TOOL_HANDLERS: Readonly<Record<string, (args: Args) => McpToolResult>> = Object.freeze({
  create_repo: toolCreateRepo,
  get_repo: toolGetRepo,
  create_issue: toolCreateIssue,
  list_issues: toolListIssues,
  create_pull_request: toolCreatePullRequest,
  merge_pull_request: toolMergePullRequest,
});

/** Whether a tool name is one this server offers. */
export function hasTool(name: string): boolean {
  return name in TOOL_HANDLERS;
}

/**
 * Run a tool. A handler never throws to the caller: an unexpected failure is an isError
 * result, so a tool call can never become an HTTP 500.
 */
export function callTool(name: string, args: Args): McpToolResult {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return errorResult(`unknown tool: ${name}`);
  try {
    return handler(args);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
