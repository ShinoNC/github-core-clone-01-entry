// The GraphQL v4 executor: validates a parsed document against graphql/schema.ts, then
// executes it against the store. One operation per body, or a JSON array of operations
// (GitHub's operation batching) answered in order. The rules the suite rests on:
//   - an unknown field is HTTP 200 with an `errors` array naming it, never an HTTP error;
//   - an unknown repository is data.repository = null with no errors;
//   - a mutation failure is a field-level error (the field reads null, the rest stands);
//   - nothing here reads a clock or randomness: ids are deterministic base64 of store ids,
//     cursors are base64 of issue numbers, timestamps come from the store counter.

import { branchTip } from '../git/commits.ts';
import { VIEWER_LOGIN, getRepo, type Issue, type IssueComment, type PullRequest, type Repo } from '../store.ts';
import { addCommentRecord, closeIssueRecord, createIssueRecord } from '../rest/issues.ts';
import { createPullRequest, isMergeable, mergePullRequest, pullFiles, type PullFile } from '../rest/pulls.ts';
import {
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  issueOf,
  pullRequestGlobalId,
  pullRequestOf,
  repositoryGlobalId,
} from './ids.ts';
import { parseDocument, valueFromAst, type DocumentNode, type OperationNode, type SelectionNode } from './parser.ts';
import { fieldType, introspectionEnumValues, introspectionFields, isLeafType } from './schema.ts';

// -------------------------------------------------------------------------------------------
// Resolved values: every object the executor hands back carries its GraphQL type in `kind`,
// so fragments (`... on Repository`) match the runtime type and `__typename` is exact.
// -------------------------------------------------------------------------------------------

type Source =
  | { kind: 'Query' }
  | { kind: 'Mutation' }
  | { kind: 'User'; login: string }
  | { kind: 'Repository'; repo: Repo }
  | { kind: 'Ref'; name: string }
  | { kind: 'Issue'; repo: Repo; issue: Issue }
  | { kind: 'IssueConnection'; repo: Repo; page: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { kind: 'PullRequestConnection'; repo: Repo; items: PullRequest[] }
  | { kind: 'PullRequestChangedFileConnection'; files: PullFile[] }
  | { kind: 'PullRequestChangedFile'; path: string }
  | { kind: '__Type'; typeName: string }
  | { kind: '__Field'; name: string }
  | { kind: '__EnumValue'; name: string }
  | { kind: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { kind: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { kind: 'CreatePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { kind: 'MergePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { kind: 'AddCommentPayload'; repo: Repo; comment: IssueComment }
  | { kind: 'IssueCommentEdge'; repo: Repo; comment: IssueComment }
  | { kind: 'IssueComment'; repo: Repo; comment: IssueComment };

/** A field-level failure: the field reads null and the error joins the errors array. */
class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldError';
  }
}

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: { message: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// -------------------------------------------------------------------------------------------
// Cursors: base64("cursor:<issue number>") — opaque, stable, and decodable without state.
// -------------------------------------------------------------------------------------------

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^cursor:(\d+)$/.exec(text);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// -------------------------------------------------------------------------------------------
// Validation: every field in the document must exist on its (fragment-narrowed) type.
// Only field existence is validated — the one thing the suite probes (invalid-field).
// -------------------------------------------------------------------------------------------

function validateSelections(
  selections: readonly SelectionNode[],
  typeName: string,
  doc: DocumentNode,
  errors: string[],
  fragmentStack: Set<string>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      if (selection.name === '__typename') continue;
      const next = fieldType(typeName, selection.name);
      if (next === null) {
        errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
        continue;
      }
      if (selection.selectionSet !== null && !isLeafType(next)) {
        validateSelections(selection.selectionSet, next, doc, errors, fragmentStack);
      }
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      validateSelections(selection.selectionSet, selection.typeCondition ?? typeName, doc, errors, fragmentStack);
      continue;
    }
    const fragment = doc.fragments.get(selection.name);
    if (!fragment) {
      errors.push(`Unknown fragment "${selection.name}".`);
      continue;
    }
    if (fragmentStack.has(selection.name)) continue;
    fragmentStack.add(selection.name);
    validateSelections(fragment.selectionSet, fragment.typeCondition, doc, errors, fragmentStack);
    fragmentStack.delete(selection.name);
  }
}

// -------------------------------------------------------------------------------------------
// Field resolvers. Each returns a scalar, a Source, an array of Sources, or null.
// -------------------------------------------------------------------------------------------

/** The global id of a resolved object (for Node.id and every concrete id field). */
function globalIdOf(source: Source): string {
  switch (source.kind) {
    case 'Repository':
      return repositoryGlobalId(source.repo);
    case 'Issue':
      return issueGlobalId(source.repo, source.issue);
    case 'PullRequest':
      return pullRequestGlobalId(source.repo, source.pull);
    case 'IssueComment':
      return commentGlobalId(source.repo, source.comment);
    default:
      throw new FieldError(`no global id for a ${source.kind}`);
  }
}

function asInput(args: Record<string, unknown>, field: string): Record<string, unknown> {
  const input = args.input;
  if (!isRecord(input)) throw new FieldError(`${field} needs an input object`);
  return input;
}

/** The issues connection: states filter, orderBy, first/after cursor paging. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): Source {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const descending = orderBy !== null && orderBy.direction === 'DESC';
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const number = decodeCursor(after);
    if (number !== null) {
      const index = list.findIndex((issue) => issue.number === number);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return { kind: 'IssueConnection', repo, page, hasNextPage, endCursor };
}

function resolveField(
  typeName: string,
  field: string,
  source: Source,
  args: Record<string, unknown>,
): unknown {
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return { kind: 'User', login: VIEWER_LOGIN } satisfies Source;
      if (field === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = getRepo(owner, name);
        return repo ? ({ kind: 'Repository', repo } satisfies Source) : null;
      }
      if (field === 'node') {
        const decoded = decodeGlobalId(args.id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') return { kind: 'Repository', repo: decoded.repo } satisfies Source;
        if (decoded.kind === 'Issue') {
          const issue = issueOf(decoded);
          return issue ? ({ kind: 'Issue', repo: decoded.repo, issue } satisfies Source) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const pull = pullRequestOf(decoded);
          return pull ? ({ kind: 'PullRequest', repo: decoded.repo, pull } satisfies Source) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        return introspectionFields(name) !== null || introspectionEnumValues(name) !== null
          ? ({ kind: '__Type', typeName: name } satisfies Source)
          : null;
      }
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = asInput(args, 'createIssue');
        const decoded = decodeGlobalId(input.repositoryId);
        if (!decoded || decoded.kind !== 'Repository') throw new FieldError('createIssue: unknown repositoryId');
        const title = input.title;
        if (typeof title !== 'string' || title === '') throw new FieldError('createIssue: title is required');
        const body = typeof input.body === 'string' ? input.body : '';
        const issue = createIssueRecord(decoded.repo, title, body);
        return { kind: 'CreateIssuePayload', repo: decoded.repo, issue } satisfies Source;
      }
      if (field === 'closeIssue') {
        const input = asInput(args, 'closeIssue');
        const decoded = decodeGlobalId(input.issueId);
        if (!decoded || decoded.kind !== 'Issue') throw new FieldError('closeIssue: unknown issueId');
        const issue = closeIssueRecord(decoded.repo, decoded.number);
        if (!issue) throw new FieldError('closeIssue: unknown issueId');
        return { kind: 'CloseIssuePayload', repo: decoded.repo, issue } satisfies Source;
      }
      if (field === 'createPullRequest') {
        const input = asInput(args, 'createPullRequest');
        const decoded = decodeGlobalId(input.repositoryId);
        if (!decoded || decoded.kind !== 'Repository') throw new FieldError('createPullRequest: unknown repositoryId');
        const title = input.title;
        const head = input.headRefName;
        const base = input.baseRefName;
        if (typeof title !== 'string' || title === '') throw new FieldError('createPullRequest: title is required');
        if (typeof head !== 'string' || head === '') throw new FieldError('createPullRequest: headRefName is required');
        if (typeof base !== 'string' || base === '') throw new FieldError('createPullRequest: baseRefName is required');
        const created = createPullRequest(decoded.repo, { title, head, base });
        if (!created.ok) {
          const messages: Record<string, string> = {
            'missing-title': 'title is required',
            'missing-head': 'headRefName is required',
            'missing-base': 'baseRefName is required',
            'unknown-head': `head branch ${JSON.stringify(head)} does not exist`,
            'unknown-base': `base branch ${JSON.stringify(base)} does not exist`,
          };
          throw new FieldError(`createPullRequest: ${messages[created.error.kind] ?? 'cannot create the pull request'}`);
        }
        return { kind: 'CreatePullRequestPayload', repo: decoded.repo, pull: created.pull } satisfies Source;
      }
      if (field === 'mergePullRequest') {
        const input = asInput(args, 'mergePullRequest');
        const decoded = decodeGlobalId(input.pullRequestId);
        if (!decoded || decoded.kind !== 'PullRequest') throw new FieldError('mergePullRequest: unknown pullRequestId');
        const merged = mergePullRequest(decoded.repo, decoded.number);
        if (!merged.ok) {
          const error = merged.error;
          if (error.kind === 'not-found') throw new FieldError('mergePullRequest: unknown pullRequestId');
          if (error.kind === 'conflict') {
            throw new FieldError(`mergePullRequest: conflicting files: ${error.conflicts.join(', ')}`);
          }
          if (error.kind === 'already-merged') throw new FieldError('mergePullRequest: the pull request is already merged');
          if (error.kind === 'closed') throw new FieldError('mergePullRequest: the pull request is closed');
          throw new FieldError('mergePullRequest: a branch no longer exists');
        }
        const pull = decoded.repo.pulls.get(decoded.number);
        if (!pull) throw new FieldError('mergePullRequest: unknown pullRequestId');
        return { kind: 'MergePullRequestPayload', repo: decoded.repo, pull } satisfies Source;
      }
      if (field === 'addComment') {
        const input = asInput(args, 'addComment');
        const decoded = decodeGlobalId(input.subjectId);
        if (!decoded || decoded.kind !== 'Issue') throw new FieldError('addComment: unknown subjectId');
        const body = input.body;
        if (typeof body !== 'string' || body === '') throw new FieldError('addComment: body is required');
        const comment = addCommentRecord(decoded.repo, decoded.number, body);
        if (!comment) throw new FieldError('addComment: unknown subjectId');
        return { kind: 'AddCommentPayload', repo: decoded.repo, comment } satisfies Source;
      }
      break;
    }
    case 'User': {
      if (field === 'login' && source.kind === 'User') return source.login;
      break;
    }
    case 'Repository': {
      if (source.kind !== 'Repository') break;
      const repo = source.repo;
      switch (field) {
        case 'id':
          return repositoryGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { kind: 'User', login: repo.owner } satisfies Source;
        case 'defaultBranchRef':
          return branchTip(repo, repo.defaultBranch) === null
            ? null
            : ({ kind: 'Ref', name: repo.defaultBranch } satisfies Source);
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const issue = repo.issues.get(number);
          return issue ? ({ kind: 'Issue', repo, issue } satisfies Source) : null;
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequests': {
          const items = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : items.length;
          return { kind: 'PullRequestConnection', repo, items: items.slice(0, first) } satisfies Source;
        }
        case 'pullRequest': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const pull = repo.pulls.get(number);
          return pull ? ({ kind: 'PullRequest', repo, pull } satisfies Source) : null;
        }
        default:
          break;
      }
      break;
    }
    case 'Ref': {
      if (field === 'name' && source.kind === 'Ref') return source.name;
      break;
    }
    case 'Issue': {
      if (source.kind !== 'Issue') break;
      switch (field) {
        case 'id':
          return issueGlobalId(source.repo, source.issue);
        case 'number':
          return source.issue.number;
        case 'title':
          return source.issue.title;
        case 'state':
          return source.issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return source.issue.body;
        default:
          break;
      }
      break;
    }
    case 'IssueConnection': {
      if (source.kind !== 'IssueConnection') break;
      if (field === 'nodes') {
        return source.page.map((issue) => ({ kind: 'Issue', repo: source.repo, issue }) satisfies Source);
      }
      if (field === 'pageInfo') {
        return { kind: 'PageInfo', hasNextPage: source.hasNextPage, endCursor: source.endCursor } satisfies Source;
      }
      break;
    }
    case 'PageInfo': {
      if (source.kind !== 'PageInfo') break;
      if (field === 'hasNextPage') return source.hasNextPage;
      if (field === 'endCursor') return source.endCursor;
      break;
    }
    case 'PullRequest': {
      if (source.kind !== 'PullRequest') break;
      const { repo, pull } = source;
      switch (field) {
        case 'id':
          return pullRequestGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
          return isMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const files = pullFiles(repo, pull);
          const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : files.length;
          return { kind: 'PullRequestChangedFileConnection', files: files.slice(0, first) } satisfies Source;
        }
        default:
          break;
      }
      break;
    }
    case 'PullRequestConnection': {
      if (source.kind !== 'PullRequestConnection') break;
      if (field === 'nodes') {
        return source.items.map((pull) => ({ kind: 'PullRequest', repo: source.repo, pull }) satisfies Source);
      }
      break;
    }
    case 'PullRequestChangedFileConnection': {
      if (source.kind !== 'PullRequestChangedFileConnection') break;
      if (field === 'nodes') {
        return source.files.map((file) => ({ kind: 'PullRequestChangedFile', path: file.filename }) satisfies Source);
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path' && source.kind === 'PullRequestChangedFile') return source.path;
      break;
    }
    case 'Node': {
      if (field === 'id') return globalIdOf(source);
      break;
    }
    case '__Type': {
      if (source.kind !== '__Type') break;
      if (field === 'name') return source.typeName;
      if (field === 'fields') {
        const names = introspectionFields(source.typeName);
        return names === null ? null : names.map((name) => ({ kind: '__Field', name }) satisfies Source);
      }
      if (field === 'enumValues') {
        const values = introspectionEnumValues(source.typeName);
        return values === null ? null : values.map((name) => ({ kind: '__EnumValue', name }) satisfies Source);
      }
      break;
    }
    case '__Field': {
      if (field === 'name' && source.kind === '__Field') return source.name;
      break;
    }
    case '__EnumValue': {
      if (field === 'name' && source.kind === '__EnumValue') return source.name;
      break;
    }
    case 'CreateIssuePayload': {
      if (field === 'issue' && source.kind === 'CreateIssuePayload') {
        return { kind: 'Issue', repo: source.repo, issue: source.issue } satisfies Source;
      }
      break;
    }
    case 'CloseIssuePayload': {
      if (field === 'issue' && source.kind === 'CloseIssuePayload') {
        return { kind: 'Issue', repo: source.repo, issue: source.issue } satisfies Source;
      }
      break;
    }
    case 'CreatePullRequestPayload': {
      if (field === 'pullRequest' && source.kind === 'CreatePullRequestPayload') {
        return { kind: 'PullRequest', repo: source.repo, pull: source.pull } satisfies Source;
      }
      break;
    }
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest' && source.kind === 'MergePullRequestPayload') {
        return { kind: 'PullRequest', repo: source.repo, pull: source.pull } satisfies Source;
      }
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge' && source.kind === 'AddCommentPayload') {
        return { kind: 'IssueCommentEdge', repo: source.repo, comment: source.comment } satisfies Source;
      }
      break;
    }
    case 'IssueCommentEdge': {
      if (field === 'node' && source.kind === 'IssueCommentEdge') {
        return { kind: 'IssueComment', repo: source.repo, comment: source.comment } satisfies Source;
      }
      break;
    }
    case 'IssueComment': {
      if (source.kind !== 'IssueComment') break;
      if (field === 'id') return commentGlobalId(source.repo, source.comment);
      if (field === 'body') return source.comment.body;
      break;
    }
    default:
      break;
  }
  throw new FieldError(`Cannot query field "${field}" on type "${typeName}".`);
}

// -------------------------------------------------------------------------------------------
// Execution.
// -------------------------------------------------------------------------------------------

/** Whether a fragment's type condition matches the runtime type of a resolved value. */
function fragmentApplies(typeCondition: string, source: Source): boolean {
  if (typeCondition === source.kind) return true;
  // Repository, Issue and PullRequest all implement the Node interface.
  if (typeCondition === 'Node' && (source.kind === 'Repository' || source.kind === 'Issue' || source.kind === 'PullRequest')) {
    return true;
  }
  return false;
}

function resolveArguments(
  args: readonly { name: string; value: import('./parser.ts').ValueNode }[],
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = valueFromAst(arg.value, variables);
  return out;
}

function completeValue(
  value: unknown,
  typeName: string,
  selectionSet: SelectionNode[] | null,
  ctx: ExecContext,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (selectionSet === null) return value;
    return value.map((item) => executeSelectionSet(selectionSet, typeName, item as Source, ctx));
  }
  if (typeof value === 'object') {
    if (selectionSet === null) return value;
    return executeSelectionSet(selectionSet, typeName, value as Source, ctx);
  }
  return value;
}

function executeSelectionSet(
  selections: readonly SelectionNode[],
  typeName: string,
  source: Source,
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = source.kind;
        continue;
      }
      const nextType = fieldType(typeName, selection.name) ?? typeName;
      try {
        const args = resolveArguments(selection.arguments, ctx.variables);
        const value = resolveField(typeName, selection.name, source, args);
        out[key] = completeValue(value, nextType, selection.selectionSet, ctx);
      } catch (err) {
        if (err instanceof FieldError) {
          ctx.errors.push({ message: err.message });
          out[key] = null;
          continue;
        }
        throw err;
      }
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && !fragmentApplies(selection.typeCondition, source)) continue;
      Object.assign(out, executeSelectionSet(selection.selectionSet, selection.typeCondition ?? typeName, source, ctx));
      continue;
    }
    const fragment = ctx.fragments.get(selection.name);
    if (!fragment) continue;
    if (!fragmentApplies(fragment.typeCondition, source)) continue;
    Object.assign(out, executeSelectionSet(fragment.selectionSet, fragment.typeCondition, source, ctx));
  }
  return out;
}

function selectOperation(doc: DocumentNode, operationName: string | undefined): OperationNode | string {
  if (operationName !== undefined) {
    const found = doc.operations.find((operation) => operation.name === operationName);
    return found ?? `Unknown operation named "${operationName}".`;
  }
  if (doc.operations.length === 1) return doc.operations[0]!;
  return 'This document holds more than one operation; an operationName is required.';
}

/** Fill in variable defaults for variables the request did not send. */
function applyDefaults(operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...variables };
  for (const definition of operation.variableDefinitions) {
    if (!(definition.name in out) && definition.defaultValue !== null) {
      out[definition.name] = valueFromAst(definition.defaultValue, variables);
    }
  }
  return out;
}

/** Execute one operation document ({query, variables?, operationName?}) into its envelope. */
function executeOperation(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || typeof input.query !== 'string') {
    return { data: null, errors: [{ message: 'a GraphQL operation needs a query string' }] };
  }
  const variables = isRecord(input.variables) ? input.variables : {};
  const operationName = typeof input.operationName === 'string' ? input.operationName : undefined;
  let doc: DocumentNode;
  try {
    doc = parseDocument(input.query);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to parse the query';
    return { data: null, errors: [{ message }] };
  }
  const operation = selectOperation(doc, operationName);
  if (typeof operation === 'string') {
    return { data: null, errors: [{ message: operation }] };
  }
  const errors: string[] = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(operation.selectionSet, rootType, doc, errors, new Set());
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const ctx: ExecContext = {
    variables: applyDefaults(operation, variables),
    fragments: doc.fragments,
    errors: [],
  };
  const rootSource: Source = rootType === 'Mutation' ? { kind: 'Mutation' } : { kind: 'Query' };
  let data: Record<string, unknown>;
  try {
    data = executeSelectionSet(operation.selectionSet, rootType, rootSource, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to execute the query';
    return { data: null, errors: [{ message }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/**
 * Handle a POST /api/graphql body: one operation object, or a JSON array of operations
 * (GitHub's operation batching) answered as an array in the same order. Always HTTP 200 —
 * GraphQL-level failures ride in the errors array; auth (401) is the router's job.
 */
export function handleGraphQL(body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOperation(entry)) };
  }
  return { status: 200, body: executeOperation(body) };
}
