/**
 * The web app loads a chat through a Connect RPC stream,
 * `ConversationService/StreamTimeline` (protobuf). Unlike the REST conversation,
 * it names the saved copy of every file the model presented:
 * `/mnt/user-data/outputs/<name>` → `/api/organizations/{org}/files/{uuid}/contents`.
 * That copy stays downloadable after the file is gone from the chat's sandbox
 * (docs/platforms-claude.md, section 6).
 *
 * Only the two strings are needed, so the protobuf is scanned for them instead of
 * being decoded with a schema the extension does not have.
 */

export const TIMELINE_PATH =
  '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline';

const encoder = new TextEncoder();

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function stringField(field: number, text: string): number[] {
  const bytes = encoder.encode(text);
  return [(field << 3) | 2, ...varint(bytes.length), ...bytes];
}

/**
 * The request the web app sends, as recorded on 2026-10-14: the conversation id,
 * flags it always sets, the locale and the time zone. Wrapped in a Connect frame.
 */
export function timelineRequestBody(
  conversationId: string,
  timeZone = 'UTC',
): Uint8Array<ArrayBuffer> {
  const message = [
    ...stringField(1, conversationId),
    0x18,
    0x01, // field 3: 1
    0x22,
    0x02,
    0x30,
    0x01, // field 4: { field 6: 1 }
    ...stringField(5, 'en-US'),
    0x30,
    0x01, // field 6: 1
    ...stringField(8, timeZone),
  ];
  const frame = new Uint8Array(5 + message.length);
  new DataView(frame.buffer).setUint32(1, message.length);
  frame.set(message, 5);
  return frame;
}

export interface StreamOptions {
  /** Stop when no data frame came for this long after the first one. */
  idleMs?: number;
  maxMs?: number;
}

/**
 * Data frames of a Connect stream. The first frame holds the whole timeline; the
 * server then sends 4-byte keep-alive frames and closes the stream after a while,
 * so reading stops at the end frame, after a pause, or at the time limit.
 */
export async function readConnectFrames(
  body: ReadableStream<Uint8Array>,
  { idleMs = 1500, maxMs = 20000 }: StreamOptions = {},
): Promise<Uint8Array[]> {
  const reader = body.getReader();
  const frames: Uint8Array[] = [];
  let buffer = new Uint8Array(0);
  const started = Date.now();
  let lastData = 0;
  try {
    for (;;) {
      const elapsed = Date.now() - started;
      const wait = lastData ? Math.min(idleMs, maxMs - elapsed) : maxMs - elapsed;
      if (wait <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), wait))),
      ]);
      clearTimeout(timer);
      if (chunk === null || chunk.done) break;
      const joined = new Uint8Array(buffer.length + chunk.value.length);
      joined.set(buffer);
      joined.set(chunk.value, buffer.length);
      buffer = joined;
      let ended = false;
      while (buffer.length >= 5) {
        const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
        if (buffer.length < 5 + length) break;
        const flags = buffer[0] ?? 0;
        const payload = buffer.slice(5, 5 + length);
        buffer = buffer.slice(5 + length);
        if (flags & 0x02) {
          ended = true;
          break;
        }
        // Keep-alive frames are 4 bytes; only real data restarts the idle clock.
        if (length > 4) {
          frames.push(payload);
          lastData = Date.now();
        }
      }
      if (ended) break;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return frames;
}

const FILE_URL = /^\/api\/organizations\/[0-9a-f-]{36}\/files\/([0-9a-f-]{36})\/contents$/;
const SANDBOX_URL =
  /^\/api\/organizations\/[0-9a-f-]{36}\/conversations\/[0-9a-f-]{36}\/wiggle\/download-file\?path=([A-Za-z0-9%._~!*'()-]+)$/;
/** Field of a file record with the web app's note, e.g. "This file was replaced by newer files." */
const NOTE_FIELD = 27;
/** A file record is small; a bigger message holding one path and one copy is not one record. */
const MAX_RECORD_BYTES = 4096;
const MAX_DEPTH = 48;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A whole sandbox path: no control characters, which would mean it is not text. */
const isCleanPath = (text: string) =>
  text.startsWith('/mnt/user-data/') &&
  text.length > 15 &&
  ![...text].some((c) => c.charCodeAt(0) < 0x20);

interface Field {
  number: number;
  /** Length-delimited bytes; other wire types are skipped. */
  bytes?: Uint8Array;
}

/** The fields of a protobuf message, or null when the bytes are not one. */
function fieldsOf(bytes: Uint8Array): Field[] | null {
  const fields: Field[] = [];
  let i = 0;
  const varint = (): number | null => {
    let result = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      if (i >= bytes.length) return null;
      const byte = bytes[i++] ?? 0;
      result += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return result;
    }
    return null;
  };
  while (i < bytes.length) {
    const tag = varint();
    if (tag === null) return null;
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) return null;
    if (wire === 0) {
      if (varint() === null) return null;
      fields.push({ number });
    } else if (wire === 1 || wire === 5) {
      i += wire === 1 ? 8 : 4;
      if (i > bytes.length) return null;
      fields.push({ number });
    } else if (wire === 2) {
      const length = varint();
      if (length === null || i + length > bytes.length) return null;
      fields.push({ number, bytes: bytes.subarray(i, i + length) });
      i += length;
    } else {
      return null;
    }
  }
  return fields;
}

function text(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** What a message holds that is not yet paired, passed up to its parent. */
interface Loose {
  paths: string[];
  copies: string[];
}

export interface TimelineFiles {
  /**
   * Saved copies by sandbox path, in timeline order: a path presented twice (a file
   * rewritten between presentations) has two.
   */
  copies: Map<string, string[]>;
  /** Files with no saved copy that the web app marks unavailable, with its note. */
  unavailable: Map<string, string>;
}

/**
 * File records of the timeline: the smallest message that holds exactly one
 * sandbox path and a copy's address pairs the two, wherever they sit in it (the
 * stream has records with the path before the address and after it). The
 * protobuf is walked without a schema: a length-delimited field is a path, an
 * address or a note when its text says so, otherwise a nested message if it
 * parses as one.
 */
export function timelineFiles(frames: Uint8Array[]): TimelineFiles {
  const copies = new Map<string, string[]>();
  const unavailable = new Map<string, string>();

  const walk = (fields: Field[], size: number, depth: number): Loose => {
    const loose: Loose = { paths: [], copies: [] };
    let note: string | null = null;
    let sandboxPath: string | null = null;
    for (const field of fields) {
      if (!field.bytes) continue;
      const value = field.bytes.length < 2048 ? text(field.bytes) : null;
      if (value !== null && isCleanPath(value)) {
        loose.paths.push(value);
        continue;
      }
      const copy = value === null ? null : FILE_URL.exec(value);
      if (copy?.[1]) {
        loose.copies.push(copy[1]);
        continue;
      }
      const sandbox = value === null ? null : SANDBOX_URL.exec(value);
      if (sandbox?.[1]) {
        try {
          sandboxPath = decodeURIComponent(sandbox[1]);
        } catch {
          // Not a path after all.
        }
        continue;
      }
      if (field.number === NOTE_FIELD && value) note = value;
      if (depth < MAX_DEPTH && field.bytes.length > 1) {
        const nested = fieldsOf(field.bytes);
        if (nested?.length) {
          const inner = walk(nested, field.bytes.length, depth + 1);
          loose.paths.push(...inner.paths);
          loose.copies.push(...inner.copies);
        }
      }
    }
    const paths = [...new Set(loose.paths)];
    const record = size <= MAX_RECORD_BYTES && paths.length === 1 ? paths[0] : undefined;
    if (note && (record ?? sandboxPath)) {
      const path = (record ?? sandboxPath) as string;
      if (!unavailable.has(path)) unavailable.set(path, note);
    }
    if (record && loose.copies.length) {
      const list = copies.get(record) ?? [];
      for (const uuid of loose.copies) if (!list.includes(uuid)) list.push(uuid);
      copies.set(record, list);
      return { paths: [], copies: [] };
    }
    return loose;
  };

  for (const frame of frames) {
    const fields = fieldsOf(frame);
    if (fields) walk(fields, frame.length, 0);
  }
  return { copies, unavailable };
}
