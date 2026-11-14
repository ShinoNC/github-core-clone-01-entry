// The HTTP server: one router for git smart HTTP, REST v3 (GraphQL v4 and MCP join in later
// phases). Every handler is wrapped so a malformed request can never crash the process
// (repo-survives-errors), every response carries a deterministic X-GitHub-Request-Id, and every
// error body is JSON {message: string}.
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
  createUserRepo,
  deleteRepoByOwnerName,
  getCurrentUser,
  getRepoByOwnerName,
  type RestResult,
} from './rest/repos.ts';

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
  sendJson(res, result.status, result.body, result.headers ?? {});
}

/** The path and query of a request URL (never throws). */
function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Read the whole request body as bytes. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body exceeds the size limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body; an empty body is {} and malformed JSON is an error. */
function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8')) as unknown;
}

/**
 * The bearer check for /api/v3/*. With no token configured (local development only) any bearer
 * token is accepted — but a request with no token at all is always 401.
 */
function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const expected = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  if (expected === '') return true;
  return match[1] === expected;
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const REPO_PATH = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/;

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

  // Everything under /api/v3 requires a token.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (method === 'GET' && path === '/api/v3/user') {
      sendRest(res, getCurrentUser());
      return;
    }
    if (method === 'POST' && path === '/api/v3/user/repos') {
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(req));
      } catch {
        sendJson(res, 400, { message: 'malformed JSON body' });
        return;
      }
      sendRest(res, createUserRepo(body));
      return;
    }
    const repoMatch = REPO_PATH.exec(path);
    if (repoMatch) {
      if (method === 'GET') {
        sendRest(res, getRepoByOwnerName(repoMatch[1]!, repoMatch[2]!));
        return;
      }
      if (method === 'DELETE') {
        sendRest(res, deleteRepoByOwnerName(repoMatch[1]!, repoMatch[2]!));
        return;
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
