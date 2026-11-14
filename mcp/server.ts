// MCP endpoint (Phase 5): JSON-RPC 2.0 over Streamable HTTP at POST /mcp, answering plain JSON
// (the client accepts application/json; no SSE stream is needed — every request is answered by
// one JSON body). Both protocol eras the suite accepts are served:
//
//   modern 2026-07-28: `server/discover` returns the server's identity, capabilities, and
//           supportedVersions in one answer; no handshake, no session.
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`.
//
// The client probes server/discover first; a working discover settles the modern era, so
// initialize is only a fallback. Every method echoes the request's id verbatim (the
// concurrent-calls check requires it), unknown methods answer -32601, and a tool call for an
// unknown tool answers -32602 — never an HTTP 500. Nothing here reads the clock or a random
// source, so the answers replay byte for byte.

import { MCP_TOOLS, callTool, hasTool } from './tools.ts';

/** The server's identity, as both eras report it. */
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

/** The current revision, mirrored in the MCP-Protocol-Version response header. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/** The revisions this server supports, newest first (the discover result's list). */
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25'];

/** The handshake-era revisions the legacy client offers (the client's own list). */
const LEGACY_REVISIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;

type JsonRpcId = string | number | null;

export interface McpResult {
  status: number;
  /** Null for a notification: no JSON-RPC answer, the transport answers 202 with no body. */
  body: unknown | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function success(id: JsonRpcId, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function failure(id: JsonRpcId, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** The tools capability both eras declare (a record is all the suite requires). */
function toolsCapability(): Record<string, unknown> {
  return { tools: {} };
}

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

/**
 * `server/discover` (2026-07-28): identity, capabilities, and supportedVersions in one result.
 * The client settles the modern era on this and negotiates 2026-07-28 from the list.
 */
function discover(id: JsonRpcId): McpResult {
  return success(id, {
    resultType: 'server/discover',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: toolsCapability(),
    serverInfo: serverInfo(),
  });
}

/**
 * `initialize` (legacy): echo a revision the client offered when it is one this server speaks,
 * else the newest legacy revision. The client accepts the echo as the negotiated revision.
 */
function initialize(id: JsonRpcId, params: Record<string, unknown>): McpResult {
  const offered = params.protocolVersion;
  const negotiated =
    typeof offered === 'string' && LEGACY_REVISIONS.includes(offered) ? offered : '2025-11-25';
  return success(id, {
    protocolVersion: negotiated,
    capabilities: toolsCapability(),
    serverInfo: serverInfo(),
  });
}

/** `tools/list`: the six tools, built once — the same list, byte for byte, every call. */
function listTools(id: JsonRpcId): McpResult {
  return success(id, { tools: MCP_TOOLS });
}

/**
 * `tools/call`: params {name, arguments}. An unknown tool is a JSON-RPC error (-32602), never
 * an HTTP 500; a tool that runs and fails reports isError in its result.
 */
function toolsCall(id: JsonRpcId, params: Record<string, unknown>): McpResult {
  const name = params.name;
  if (typeof name !== 'string' || name === '') {
    return failure(id, JSON_RPC_INVALID_PARAMS, 'tools/call requires a tool name');
  }
  if (!hasTool(name)) {
    return failure(id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${name}`);
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  return success(id, callTool(name, args));
}

/**
 * Handle one parsed JSON-RPC request body (the app layer answers parse failures with -32700
 * before calling here). A body that is not a JSON-RPC request object is -32600. A message
 * without an id is a notification: handled (notifications/initialized is a no-op) and answered
 * with no body.
 */
export function handleMcp(value: unknown): McpResult {
  if (!isRecord(value)) {
    return failure(null, JSON_RPC_INVALID_REQUEST, 'request must be a JSON-RPC object');
  }
  const hasId = value.id !== undefined && (typeof value.id === 'string' || typeof value.id === 'number' || value.id === null);
  const id: JsonRpcId = hasId ? (value.id as JsonRpcId) : null;
  const method = value.method;
  if (typeof method !== 'string' || method === '') {
    if (!hasId) return { status: 202, body: null };
    return failure(id, JSON_RPC_INVALID_REQUEST, 'request must name a method');
  }
  const params = isRecord(value.params) ? value.params : {};

  // Notifications carry no id and get no JSON-RPC answer.
  if (!hasId) {
    return { status: 202, body: null };
  }

  switch (method) {
    case 'server/discover':
      return discover(id);
    case 'initialize':
      return initialize(id, params);
    case 'tools/list':
      return listTools(id);
    case 'tools/call':
      return toolsCall(id, params);
    case 'ping':
      return success(id, {});
    default:
      return failure(id, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

/** The JSON-RPC parse error the app layer answers for a body that is not JSON (HTTP 400). */
export function parseErrorBody(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: null,
    error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' },
  };
}
