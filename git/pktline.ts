// pkt-line framing (gitformat-protocol): every line is 4 lowercase hex digits giving the length
// INCLUDING those 4 digits, then the payload. 0000 = flush, 0001 = delim, 0002 = response-end.
// Max packet 65520 bytes total (git's LARGE_PACKET_MAX).

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type Pkt =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a mixed sequence; 'flush'/'delim' are the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a complete buffer into packets. Returns the packets and the offset just past the last
 * complete packet; `allowTrailing` stops before bytes that are not a pkt-line header (the raw
 * packfile after a receive-pack command list).
 */
export function decodePktLines(
  bytes: Buffer,
  options: { allowTrailing?: boolean } = {},
): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (options.allowTrailing && offset + 4 <= bytes.length && !HEX4.test(bytes.subarray(offset, offset + 4).toString('ascii'))) {
      break;
    }
    if (offset + 4 > bytes.length) {
      throw new Error(`truncated pkt-line: ${bytes.length - offset} trailing byte(s)`);
    }
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) {
      throw new Error(`invalid pkt-line length ${length}`);
    }
    if (offset + length > bytes.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${bytes.length - offset} available`);
    }
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}
