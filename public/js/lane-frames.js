/**
 * Binary framing for the Browser-mode fast lane (pc-fetch.js / fetch-tunnel.js).
 *
 * Control messages on the lane are JSON strings. Bytes — request and response
 * bodies, binary WebSocket messages — travel as binary messages instead, so
 * nothing is base64'd and nothing is re-encoded as text:
 *
 *   [ u32 id (big-endian) ][ u8 kind ][ payload … ]
 *
 * A body larger than one frame is split into several, sent in order on the
 * ordered channel, with the count announced in the JSON message before them.
 */

export const FRAME = {
  RESPONSE_BODY: 1,
  REQUEST_BODY: 2,
  WS_BINARY: 3,
};

/** Comfortably under Chromium's 256 KiB data-channel message ceiling. */
export const FRAME_PAYLOAD = 64 * 1024;

export function encodeFrame(id, kind, bytes) {
  const out = new Uint8Array(5 + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, id);
  view.setUint8(4, kind);
  out.set(bytes, 5);
  return out.buffer;
}

export function decodeFrame(buffer) {
  const view = new DataView(buffer);
  return { id: view.getUint32(0), kind: view.getUint8(4), bytes: new Uint8Array(buffer, 5) };
}

/** Splits bytes into frame-sized views (no copies). An empty body is zero parts. */
export function splitBytes(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.byteLength; offset += FRAME_PAYLOAD) {
    parts.push(bytes.subarray(offset, Math.min(offset + FRAME_PAYLOAD, bytes.byteLength)));
  }
  return parts;
}

/** Joins received parts back into one ArrayBuffer. */
export function joinParts(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out.buffer;
}

/** Whatever a body arrived as (ArrayBuffer, typed array, Blob, string, stream), as bytes. */
export async function toBytes(body) {
  if (body == null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Uint8Array(await new Response(body).arrayBuffer());
}
