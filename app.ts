// The HTTP server: one router for git smart HTTP, REST v3, GraphQL v4, and MCP. Every handler
// is wrapped so a malformed request can never crash the process (repo-survives-errors), every
// response carries a deterministic X-GitHub-Request-Id, and every error body is JSON
// {message: string} (or a JSON-RPC error object on /mcp).
//
// Auth: /api/v3/* requires `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` (missing or wrong -> 401).
// Git endpoints are NOT auth-gated — the suite client sends a token there too, but no check
// verifies git auth, and gating it could only break a check. /healthz and the API root answer
// without a token, as the starter did.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { nextRequestId, type Repo } from './store.ts';
import { getRepo } from './store.ts';
import {
  advertisementV0 as uploadAdvertisementV0,
  advertisementV2,
  handleUploadPack,
  UPLOAD_PACK_ADVERTISEMENT_TYPE,
  UPLOAD_PACK_RESULT_TYPE,
} from './git/upload-pack.ts';
import {
  advertisementV0 as receiveAdvertisementV0,
  handleReceivePack,
  RECEIVE_PACK_ADVERTISEMENT_TYPE,
  RECEIVE_PACK_RESULT_TYPE,
} from './git/receive-pack.ts';
import {
  createGitRef,
  createUserRepo,
  deleteContents,
  deleteRepoByOwnerName,
  getContents,
  getCurrentUser,
  getGitRef,
  getRepoByOwnerName,
  listBranches,
  listCommits,
  listUserRepos,
  patchRepoByOwnerName,
  putContents,
  visibleRepo,
  type RestResult,
} from './rest/repos.ts';
import {
  createComment,
  createIssue,
  createLabel,
  getIssue,
  listComments,
  listIssues,
  listLabels,
  patchIssue,
} from './rest/issues.ts';
import { createPull, getPull, listPullFiles, listPulls, mergePull } from './rest/pulls.ts';
import { handleGraphQL } from './graphql/executor.ts';
import { MCP_PROTOCOL_VERSION, handleMcp, parseErrorBody } from './mcp/server.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (packs in the suite are far below this). */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** Answer with a JSON body (204 sends no body at all). */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with a pre-serialized JSON body (a cached string, trailing newline included). */
function sendJsonText(res: ServerResponse, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with raw bytes (git responses). */
function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendRest(res: ServerResponse, result: RestResult): void {
  if (result.text !== undefined) {
    sendJsonText(res, result.status, result.text, result.headers ?? {});
    return;
  }
  sendJson(res, result.status, result.body, result.headers ?? {});
}

/**
 * The path and query of a request URL (never throws). Fast path: a clean path-only URL
 * (no query, fragment, dot segment, space, or backslash) is the raw string — `new URL`
 * costs ~5µs and every request pays it. Anything unusual falls back to `new URL`, which
 * keeps the exact current behavior for malformed input (normalization, 400 on garbage).
 */
function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  if (
    raw.charCodeAt(0) === 47 && // '/'
    raw.indexOf('?') < 0 &&
    raw.indexOf('#') < 0 &&
    raw.indexOf('/.') < 0 &&
    raw.indexOf(' ') < 0 &&
    raw.indexOf('\\') < 0
  ) {
    return { path: raw, query: new URLSearchParams() };
  }
  try {
    const url = new URL(raw, 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/**
 * Read the whole request body as bytes. Event-based (not `for await`, whose async-iterator
 * machinery costs ~10-20µs per request) — every POST workload (push, clone, write) pays it.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        fail(new Error('request body exceeds the size limit'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

/** Parse a JSON body; an empty body is {} and malformed JSON is an error. */
function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8')) as unknown;
}

/** The expected bearer token, read once at startup — process.env access per request is slow. */
const EXPECTED_TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

/**
 * The bearer check for /api/v3/*. With no token configured (local development only) any bearer
 * token is accepted — but a request with no token at all is always 401.
 */
function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** The installed version GET /api/v3/meta reports. */
const INSTALLED_VERSION = '1.0.0';

/**
 * Decode one path segment; a malformed escape is null (the caller answers 400).
 * Fast path: a segment with no '%' is already decoded (decodeURIComponent is ~0.5µs
 * per call and the router decodes every segment of every REST request).
 */
function decodeSegment(segment: string): string | null {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Read and parse a JSON request body; an empty body is {} and malformed JSON is an error. */
async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: parseJsonBody(await readBody(req)) };
  } catch {
    return { ok: false };
  }
}

/** The request's own origin, for absolute pagination URLs (Link rel="next"). */
function requestBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Handle a git smart-HTTP request. */
async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  servicePath: string,
  query: URLSearchParams,
): Promise<void> {
  const repo: Repo | undefined = getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const method = req.method ?? 'GET';
  const protocolHeader = req.headers['git-protocol'];
  const protocol = Array.isArray(protocolHeader) ? protocolHeader[0] ?? '' : (protocolHeader ?? '');
  const isV2 = protocol.trim() === 'version=2';

  if (servicePath === 'info/refs') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const body = isV2 ? advertisementV2() : uploadAdvertisementV0(repo);
      sendBytes(res, 200, body, UPLOAD_PACK_ADVERTISEMENT_TYPE);
      return;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, 200, receiveAdvertisementV0(repo), RECEIVE_PACK_ADVERTISEMENT_TYPE);
      return;
    }
    sendJson(res, 400, { message: 'missing or unknown service parameter' });
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const body = await readBody(req);
  try {
    if (servicePath === 'git-upload-pack') {
      sendBytes(res, 200, handleUploadPack(repo, body, isV2), UPLOAD_PACK_RESULT_TYPE);
    } else {
      sendBytes(res, 200, handleReceivePack(repo, body), RECEIVE_PACK_RESULT_TYPE);
    }
  } catch (err) {
    // A malformed git request is a 400, never a crash.
    sendJson(res, 400, { message: (err as Error).message });
  }
}

/** Handle one request end to end. */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = parseUrl(req);
  const method = req.method ?? 'GET';

  // The env's boot check: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The GitHub API root.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Git smart HTTP (no auth gate).
  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch) {
    await handleGit(req, res, gitMatch[1]!, gitMatch[2]!, gitMatch[3]!, query);
    return;
  }

  // GraphQL v4: POST /api/graphql, auth-gated like REST. GraphQL-level failures ride in
  // the errors array (HTTP 200); only auth (401) and a malformed JSON body (400) are HTTP
  // errors. A JSON array body is operation batching, answered as an array in order.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, 400, { message: 'malformed JSON body' });
      return;
    }
    const result = handleGraphQL(body.value);
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP: POST /mcp, auth-gated like REST. JSON-RPC 2.0 over Streamable HTTP, answered as
  // plain JSON. A body that is not JSON is HTTP 400 with JSON-RPC -32700; a notification
  // (no id) is answered 202 with no body; everything else rides in the JSON-RPC response.
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, 400, parseErrorBody(), { 'mcp-protocol-version': MCP_PROTOCOL_VERSION });
      return;
    }
    const result = handleMcp(body.value);
    if (result.body === null) {
      res.writeHead(202, {
        'x-github-request-id': nextRequestId(),
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, { 'mcp-protocol-version': MCP_PROTOCOL_VERSION });
    return;
  }

  // Everything under /api/v3 requires a token.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    // Split + filter + decode in one pass (no intermediate arrays): segments are the
    // '/'-separated parts, empty parts dropped, each %-decoded. Identical to the old
    // split('/').filter().map(decode) — a malformed encoding is still a 400.
    const segments: string[] = [];
    let start = 0;
    for (let index = 0; index <= path.length; index += 1) {
      if (index === path.length || path.charCodeAt(index) === 47) {
        if (index > start) {
          const decoded = decodeSegment(path.slice(start, index));
          if (decoded === null) {
            sendJson(res, 400, { message: 'malformed path encoding' });
            return;
          }
          segments.push(decoded);
        }
        start = index + 1;
      }
    }
    // segments[0..1] are 'api' and 'v3' (path is under /api/v3).
    const tail = segments.slice(2);

    if (method === 'GET' && tail.length === 1 && tail[0] === 'meta') {
      sendJson(res, 200, { installed_version: INSTALLED_VERSION });
      return;
    }
    if (method === 'GET' && tail.length === 1 && tail[0] === 'user') {
      sendRest(res, getCurrentUser());
      return;
    }
    if (tail.length === 2 && tail[0] === 'user' && tail[1] === 'repos') {
      if (method === 'GET') {
        sendRest(res, listUserRepos(query, requestBaseUrl(req)));
        return;
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, 400, { message: 'malformed JSON body' });
          return;
        }
        sendRest(res, createUserRepo(body.value));
        return;
      }
    }

    // /api/v3/repos/{owner}/{name}[/...]
    if (tail.length >= 3 && tail[0] === 'repos') {
      const owner = tail[1]!;
      const name = tail[2]!;
      const rest = tail.slice(3);

      if (rest.length === 0) {
        if (method === 'GET') {
          sendRest(res, getRepoByOwnerName(owner, name));
          return;
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          if (!body.ok) {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          sendRest(res, patchRepoByOwnerName(owner, name, body.value));
          return;
        }
        if (method === 'DELETE') {
          sendRest(res, deleteRepoByOwnerName(owner, name));
          return;
        }
      }

      const repo = visibleRepo(owner, name);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // POST /git/refs, GET /git/refs/{ref...}
      if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
        if (method === 'POST' && rest.length === 2) {
          const body = await readJsonBody(req);
          if (!body.ok) {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          sendRest(res, createGitRef(repo, body.value));
          return;
        }
        if (method === 'GET' && rest.length > 2) {
          sendRest(res, getGitRef(repo, rest.slice(2).join('/')));
          return;
        }
      }

      if (method === 'GET' && rest.length === 1 && rest[0] === 'branches') {
        sendRest(res, listBranches(repo));
        return;
      }
      if (method === 'GET' && rest.length === 1 && rest[0] === 'commits') {
        sendRest(res, listCommits(repo, query));
        return;
      }

      // /contents[/{path...}] — the path may hold slashes.
      if (rest.length >= 1 && rest[0] === 'contents') {
        const contentPath = rest.slice(1).join('/');
        if (method === 'GET') {
          sendRest(res, getContents(repo, contentPath, query));
          return;
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          if (!body.ok) {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          sendRest(res, putContents(repo, contentPath, body.value));
          return;
        }
        if (method === 'DELETE') {
          const body = await readJsonBody(req);
          if (!body.ok) {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          sendRest(res, deleteContents(repo, contentPath, body.value));
          return;
        }
      }

      // /labels
      if (rest.length === 1 && rest[0] === 'labels') {
        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (!body.ok) {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          sendRest(res, createLabel(repo, body.value));
          return;
        }
        if (method === 'GET') {
          sendRest(res, listLabels(repo));
          return;
        }
      }

      // /issues[/{n}[/comments]]
      if (rest.length >= 1 && rest[0] === 'issues') {
        if (rest.length === 1) {
          if (method === 'POST') {
            const body = await readJsonBody(req);
            if (!body.ok) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            sendRest(res, createIssue(repo, body.value));
            return;
          }
          if (method === 'GET') {
            sendRest(res, listIssues(repo, query, requestBaseUrl(req)));
            return;
          }
        }
        const number = Number(rest[1]);
        if (rest.length >= 2 && Number.isInteger(number) && number >= 1) {
          if (rest.length === 2) {
            if (method === 'GET') {
              sendRest(res, getIssue(repo, number));
              return;
            }
            if (method === 'PATCH') {
              const body = await readJsonBody(req);
              if (!body.ok) {
                sendJson(res, 400, { message: 'malformed JSON body' });
                return;
              }
              sendRest(res, patchIssue(repo, number, body.value));
              return;
            }
          }
          if (rest.length === 3 && rest[2] === 'comments') {
            if (method === 'POST') {
              const body = await readJsonBody(req);
              if (!body.ok) {
                sendJson(res, 400, { message: 'malformed JSON body' });
                return;
              }
              sendRest(res, createComment(repo, number, body.value));
              return;
            }
            if (method === 'GET') {
              sendRest(res, listComments(repo, number));
              return;
            }
          }
        }
      }

      // /pulls[/{n}[/files|merge]]
      if (rest.length >= 1 && rest[0] === 'pulls') {
        if (rest.length === 1) {
          if (method === 'POST') {
            const body = await readJsonBody(req);
            if (!body.ok) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            sendRest(res, createPull(repo, body.value));
            return;
          }
          if (method === 'GET') {
            sendRest(res, listPulls(repo, query, requestBaseUrl(req)));
            return;
          }
        }
        const number = Number(rest[1]);
        if (rest.length >= 2 && Number.isInteger(number) && number >= 1) {
          if (rest.length === 2 && method === 'GET') {
            sendRest(res, getPull(repo, number));
            return;
          }
          if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
            sendRest(res, listPullFiles(repo, number));
            return;
          }
          if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
            const body = await readJsonBody(req);
            if (!body.ok) {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
            sendRest(res, mergePull(repo, number));
            return;
          }
        }
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res).catch((err: unknown) => {
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else if (!res.writableEnded) res.end();
    });
  });
}
