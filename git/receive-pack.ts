// git-receive-pack: the push side. v0 only (the suite client never asks for v2 receive-pack).
// The request is a command list (<old> <new> <ref>, capabilities after NUL on the first line),
// a flush, then the raw packfile. The response is the report-status report (unpack + one ok/ng
// line per command, in order) wrapped in sideband band 1, then an outer flush.
//
// A non-fast-forward refusal must read exactly `ng <ref> non-fast-forward` — the suite asserts
// the reason verbatim. A mixed push applies the fast-forward commands and refuses the rest.

import { encodePktLine, encodePktLines, decodePktLines, packetsToLines } from './pktline.ts';
import { ZERO_OID, isAncestor, isObjectId } from './objects.ts';
import { readPack } from './pack.ts';
import { buildV0Advertisement } from './refs.ts';
import { nextTimestamp, type Repo } from '../store.ts';

export const RECEIVE_PACK_ADVERTISEMENT_TYPE = 'application/x-git-receive-pack-advertisement';
export const RECEIVE_PACK_RESULT_TYPE = 'application/x-git-receive-pack-result';

const AGENT = 'makefun-forge/1.0';

/** v0 receive-pack capabilities. report-status-v2 is deliberately NOT offered (the client prefers it when present, and its framing differs). */
const V0_CAPABILITIES = `symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** The v0 ref advertisement for git-receive-pack. */
export function advertisementV0(repo: Repo): Buffer {
  return buildV0Advertisement(repo, 'git-receive-pack', V0_CAPABILITIES);
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

interface CommandResult {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason?: string;
}

/** A valid git ref name under refs/ (a practical subset of git-check-ref-format). */
function isValidRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length < 6) return false;
  if (ref.endsWith('/') || ref.endsWith('.lock') || ref.includes('..') || ref.includes('//')) return false;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
    if (char === ' ' || char === '~' || char === '^' || char === ':' || char === '?' || char === '*' || char === '[' || char === '\\') {
      return false;
    }
  }
  for (const component of ref.split('/')) {
    if (component.startsWith('.') || component.endsWith('.')) return false;
  }
  return true;
}

/** Parse one command line: `<old> <new> <ref>` (capabilities after NUL are dropped). */
function parseCommand(line: string): PushCommand {
  const withoutCaps = line.split('\u0000')[0]!;
  const parts = withoutCaps.replace(/\n$/, '').split(' ');
  if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
    throw new Error(`malformed push command ${JSON.stringify(line)}`);
  }
  return { oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! };
}

/**
 * Apply the push commands against the repo. The pack's objects are already stored (and verified)
 * by the caller. Commands are applied in order; a refusal never moves its ref.
 */
function applyCommands(repo: Repo, commands: readonly PushCommand[]): CommandResult[] {
  const lookup = (oid: string) => repo.objects.get(oid);
  const results: CommandResult[] = [];
  let changed = false;
  for (const command of commands) {
    if (!isValidRefName(command.ref)) {
      results.push({ ref: command.ref, ok: false, reason: 'invalid ref name' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.delete(command.ref);
      changed = true;
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      changed = true;
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    // Update: the old value must match, and the new tip must contain the old tip.
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (command.oldOid !== current || !isAncestor(command.oldOid, command.newOid, lookup)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    changed = true;
    results.push({ ref: command.ref, ok: true });
  }
  if (changed) {
    repo.refsVersion += 1;
    repo.updatedAt = nextTimestamp();
  }
  return results;
}

/** Build the report-status body: inner pkt-lines wrapped in sideband band 1, then an outer flush. */
function buildReport(unpackOk: boolean, unpackError: string | null, results: readonly CommandResult[]): Buffer {
  const inner: Array<string | 'flush'> = [
    unpackOk ? 'unpack ok\n' : `unpack ${unpackError ?? 'failed'}\n`,
  ];
  for (const result of results) {
    inner.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`);
  }
  inner.push('flush');
  const innerBytes = encodePktLines(inner);
  // Wrap the whole inner stream in sideband band 1 (chunked at the pkt-line maximum).
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < innerBytes.length; offset += CHUNK) {
    const chunk = innerBytes.subarray(offset, Math.min(innerBytes.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

/**
 * Handle POST /git-receive-pack. The pack is verified (trailer, hashes, sizes) before any object
 * is stored or any ref moves; a bad pack fails the whole push with `unpack <error>` and every
 * command reported ng. Throws on a malformed body — the caller turns that into a 400.
 */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, consumed } = decodePktLines(body, { allowTrailing: true });
  const lines = packetsToLines(packets);
  const commands = lines.map(parseCommand);
  const packBytes = body.subarray(consumed);

  if (packBytes.length > 0) {
    let pack;
    try {
      pack = readPack(packBytes);
    } catch (err) {
      const reason = (err as Error).message;
      const results = commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' }));
      return buildReport(false, reason, results);
    }
    for (const [oid, object] of pack.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const results = applyCommands(repo, commands);
  return buildReport(true, null, results);
}
