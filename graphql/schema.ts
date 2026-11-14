// The GraphQL schema the forge implements: the exact surface checks-graphql.ts's header
// lists (Query.viewer/repository/node/__type, the Repository/Issue/PullRequest fields, the
// five mutations, and the introspection types). One table serves two purposes: the executor
// validates field names against it (an unknown field is a 200 errors array, never a crash),
// and `__type` introspection lists the same fields — so the schema the suite probes is the
// schema the executor answers. Keep this table EXACTLY the fields the executor resolves:
// a field listed here but unimplemented would pass validation and fail at execution.

export interface FieldDef {
  name: string;
  /** The named type the field returns (lists and non-nulls unwrapped). */
  type: string;
}

export interface ObjectTypeDef {
  kind: 'object' | 'interface';
  fields: readonly FieldDef[];
}

export interface EnumTypeDef {
  kind: 'enum';
  values: readonly string[];
}

export type TypeDef = ObjectTypeDef | EnumTypeDef;

function fields(list: readonly (readonly [string, string])[]): readonly FieldDef[] {
  return list.map(([name, type]) => ({ name, type }));
}

export const SCHEMA: Readonly<Record<string, TypeDef>> = {
  Query: {
    kind: 'object',
    fields: fields([
      ['viewer', 'User'],
      ['repository', 'Repository'],
      ['node', 'Node'],
      ['__type', '__Type'],
    ]),
  },
  Mutation: {
    kind: 'object',
    fields: fields([
      ['createIssue', 'CreateIssuePayload'],
      ['closeIssue', 'CloseIssuePayload'],
      ['createPullRequest', 'CreatePullRequestPayload'],
      ['mergePullRequest', 'MergePullRequestPayload'],
      ['addComment', 'AddCommentPayload'],
    ]),
  },
  User: {
    kind: 'object',
    fields: fields([['login', 'String']]),
  },
  Repository: {
    kind: 'object',
    fields: fields([
      ['id', 'ID'],
      ['databaseId', 'Int'],
      ['name', 'String'],
      ['nameWithOwner', 'String'],
      ['owner', 'User'],
      ['defaultBranchRef', 'Ref'],
      ['viewerPermission', 'RepositoryPermission'],
      ['hasIssuesEnabled', 'Boolean'],
      ['issue', 'Issue'],
      ['issues', 'IssueConnection'],
      ['pullRequests', 'PullRequestConnection'],
      ['pullRequest', 'PullRequest'],
    ]),
  },
  Ref: {
    kind: 'object',
    fields: fields([['name', 'String']]),
  },
  Issue: {
    kind: 'object',
    fields: fields([
      ['id', 'ID'],
      ['number', 'Int'],
      ['title', 'String'],
      ['state', 'IssueState'],
      ['body', 'String'],
    ]),
  },
  IssueConnection: {
    kind: 'object',
    fields: fields([
      ['nodes', 'Issue'],
      ['pageInfo', 'PageInfo'],
    ]),
  },
  PageInfo: {
    kind: 'object',
    fields: fields([
      ['hasNextPage', 'Boolean'],
      ['endCursor', 'String'],
    ]),
  },
  PullRequest: {
    kind: 'object',
    fields: fields([
      ['id', 'ID'],
      ['number', 'Int'],
      ['state', 'PullRequestState'],
      ['merged', 'Boolean'],
      ['headRefName', 'String'],
      ['baseRefName', 'String'],
      ['mergeable', 'MergeableState'],
      ['files', 'PullRequestChangedFileConnection'],
    ]),
  },
  PullRequestConnection: {
    kind: 'object',
    fields: fields([['nodes', 'PullRequest']]),
  },
  PullRequestChangedFileConnection: {
    kind: 'object',
    fields: fields([['nodes', 'PullRequestChangedFile']]),
  },
  PullRequestChangedFile: {
    kind: 'object',
    fields: fields([['path', 'String']]),
  },
  Node: {
    kind: 'interface',
    fields: fields([['id', 'ID']]),
  },
  __Type: {
    kind: 'object',
    fields: fields([
      ['name', 'String'],
      ['fields', '__Field'],
      ['enumValues', '__EnumValue'],
    ]),
  },
  __Field: {
    kind: 'object',
    fields: fields([['name', 'String']]),
  },
  __EnumValue: {
    kind: 'object',
    fields: fields([['name', 'String']]),
  },
  CreateIssuePayload: {
    kind: 'object',
    fields: fields([['issue', 'Issue']]),
  },
  CloseIssuePayload: {
    kind: 'object',
    fields: fields([['issue', 'Issue']]),
  },
  CreatePullRequestPayload: {
    kind: 'object',
    fields: fields([['pullRequest', 'PullRequest']]),
  },
  MergePullRequestPayload: {
    kind: 'object',
    fields: fields([['pullRequest', 'PullRequest']]),
  },
  AddCommentPayload: {
    kind: 'object',
    fields: fields([['commentEdge', 'IssueCommentEdge']]),
  },
  IssueCommentEdge: {
    kind: 'object',
    fields: fields([['node', 'IssueComment']]),
  },
  IssueComment: {
    kind: 'object',
    fields: fields([
      ['id', 'ID'],
      ['body', 'String'],
    ]),
  },
  IssueState: { kind: 'enum', values: ['OPEN', 'CLOSED'] },
  MergeableState: { kind: 'enum', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { kind: 'enum', values: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeMethod: { kind: 'enum', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'enum', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'enum', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'enum', values: ['ASC', 'DESC'] },
  SearchType: { kind: 'enum', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
};

/** The named type of `field` on `type`, or null when the field does not exist. */
export function fieldType(typeName: string, fieldName: string): string | null {
  const def = SCHEMA[typeName];
  if (def === undefined || def.kind === 'enum') return null;
  for (const field of def.fields) {
    if (field.name === fieldName) return field.type;
  }
  return null;
}

/** Whether `typeName` is a scalar or enum (a leaf: no sub-selection applies). */
export function isLeafType(typeName: string): boolean {
  if (typeName === 'String' || typeName === 'Int' || typeName === 'Float' || typeName === 'Boolean' || typeName === 'ID') {
    return true;
  }
  return SCHEMA[typeName]?.kind === 'enum';
}

/** The field names `__type(name:)` lists for an object/interface type (null for enums). */
export function introspectionFields(typeName: string): readonly string[] | null {
  const def = SCHEMA[typeName];
  if (def === undefined || def.kind === 'enum') return null;
  return def.fields.map((field) => field.name);
}

/** The enum values `__type(name:)` lists for an enum type (null for objects). */
export function introspectionEnumValues(typeName: string): readonly string[] | null {
  const def = SCHEMA[typeName];
  if (def === undefined || def.kind !== 'enum') return null;
  return def.values;
}
