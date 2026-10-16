import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import {
  readConnectFrames,
  timelineFiles,
  TIMELINE_PATH,
  timelineRequestBody,
} from '../../../src/adapters/claude/timeline';
import type { FetchLike } from '../../../src/util/http';
import { ORG, ORIGIN } from './fixtures';

const CHAT = '00000000-0000-4000-8000-0000000000c1';
const COPY_1 = '00000000-0000-5000-8000-0000000000f1';
const COPY_2 = '00000000-0000-5000-8000-0000000000f2';
const COPY_3 = '00000000-0000-5000-8000-0000000000f3';

const encoder = new TextEncoder();
const varint = (n: number): number[] => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...varint(n >>> 7)]);
const str = (field: number, text: string) => {
  const bytes = [...encoder.encode(text)];
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
};
const nested = (field: number, body: number[]) => [
  (field << 3) | 2,
  ...varint(body.length),
  ...body,
];

/** A file record as the timeline has it: name, path, then the saved copy. */
const fileRecord = (path: string, uuid: string) =>
  nested(4, [
    ...str(1, path.slice(path.lastIndexOf('/') + 1)),
    ...str(2, path),
    ...nested(5, [
      ...str(5, uuid),
      ...str(6, `/api/organizations/${ORG}/files/${uuid}/contents`),
      ...str(8, 'Display name'),
      ...str(9, 'application/octet-stream'),
    ]),
  ]);

/** A file with no saved copy: the sandbox address and the web app's note. */
const goneRecord = (path: string, note: string) =>
  nested(4, [
    ...str(9, path),
    ...str(
      10,
      `/api/organizations/${ORG}/conversations/${CHAT}/wiggle/download-file?path=${encodeURIComponent(path)}`,
    ),
    ...[0x90, 0x01, 0x01, 0xd0, 0x01, 0x03],
    ...str(27, note),
  ]);

const frame = (payload: number[], flags = 0) => {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
};

const stream = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });

const LONG = `/mnt/user-data/outputs/${'отчёт-'.repeat(12)}.md`; // over 127 bytes
const timeline = [
  // A tool input mentions the path inside other text: not a file record.
  ...str(3, 'cp build.vsix /mnt/user-data/outputs/'),
  ...fileRecord('/mnt/user-data/outputs/build-0_1_1.vsix', COPY_1),
  ...fileRecord(LONG, COPY_2),
  // The same path presented again after the file was rewritten.
  ...fileRecord('/mnt/user-data/outputs/build-0_1_1.vsix', COPY_3),
];

describe('timeline', () => {
  it('builds the request the web app sends', () => {
    const body = timelineRequestBody(CHAT, 'Asia/Almaty');
    const expected = `\n$${CHAT}\x18\x01"\x020\x01*\x05en-US0\x01B\x0bAsia/Almaty`;
    expect([...body]).toEqual([0, 0, 0, 0, expected.length, ...encoder.encode(expected)]);
  });

  it('reads data frames split across chunks, skipping keep-alives, until the end frame', async () => {
    const data = frame(timeline);
    const all = new Uint8Array([
      ...data,
      ...frame([0, 0, 0, 0]),
      ...frame([...encoder.encode('{"metadata":{}}')], 2),
      ...frame([1, 2, 3, 4, 5, 6]),
    ]);
    const frames = await readConnectFrames(
      stream(all.slice(0, 7), all.slice(7, 40), all.slice(40)),
    );
    expect(frames).toHaveLength(1);
    expect([...frames[0]!]).toEqual(timeline);
  });

  it('stops waiting when the stream goes quiet', async () => {
    const quiet = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame(timeline));
      },
    });
    const frames = await readConnectFrames(quiet, { idleMs: 20, maxMs: 2000 });
    expect(frames).toHaveLength(1);
  });

  it('pairs each sandbox path with its saved copies, in order', () => {
    const { copies, unavailable } = timelineFiles([new Uint8Array(timeline)]);
    expect(unavailable.size).toBe(0);
    expect(Object.fromEntries(copies)).toEqual({
      '/mnt/user-data/outputs/build-0_1_1.vsix': [COPY_1, COPY_3],
      [LONG]: [COPY_2],
    });
  });
});

/** The other record shape: the copy's address comes before the path. */
const copyFirstRecord = (path: string, uuid: string) =>
  nested(4, [
    ...str(1, uuid),
    ...str(2, path.slice(path.lastIndexOf('/') + 1)),
    ...str(4, 'application/octet-stream'),
    ...str(5, `/api/organizations/${ORG}/files/${uuid}/contents`),
    ...str(10, `sc:${uuid}`),
    ...str(12, path),
  ]);

describe('timeline records with the path after the copy', () => {
  it('pair each path with its own copy, not the next one', () => {
    const a = '/mnt/user-data/outputs/build-0_1_59.vsix';
    const b = '/mnt/user-data/outputs/build-0_1_60.vsix';
    const { copies } = timelineFiles([
      new Uint8Array([...copyFirstRecord(a, COPY_1), ...copyFirstRecord(b, COPY_2)]),
    ]);
    expect(Object.fromEntries(copies)).toEqual({ [a]: [COPY_1], [b]: [COPY_2] });
  });
});

describe('timeline notes', () => {
  it('reads the note of a file that has no saved copy', () => {
    const gone = '/mnt/user-data/outputs/build 0.1.0.vsix';
    const { copies, unavailable } = timelineFiles([
      new Uint8Array([...goneRecord(gone, 'This file was replaced by newer files.')]),
    ]);
    expect(copies.size).toBe(0);
    expect(unavailable.get(gone)).toBe('This file was replaced by newer files.');
  });

  it('does not take the display name of an available file for a note', () => {
    const path = '/mnt/user-data/outputs/build-0_1_2.vsix';
    const available = nested(4, [
      ...str(9, path),
      ...str(
        10,
        `/api/organizations/${ORG}/conversations/${CHAT}/wiggle/download-file?path=${encodeURIComponent(path)}`,
      ),
      ...str(8, 'Build 0 1 2'),
    ]);
    expect(timelineFiles([new Uint8Array(available)]).unavailable.size).toBe(0);
  });
});

describe('saved copies in the adapter', () => {
  const presented = (id: string, path: string, index: number) => [
    {
      uuid: `${id}-q`,
      sender: 'human',
      index: index * 2,
      created_at: '2026-09-22T07:00:00Z',
      parent_message_uuid: index ? `${id.slice(0, -1)}${index - 1}` : 'root',
      content: [{ type: 'text', text: 'Build it' }],
    },
    {
      uuid: id,
      sender: 'assistant',
      index: index * 2 + 1,
      created_at: '2026-09-22T07:30:00Z',
      parent_message_uuid: `${id}-q`,
      content: [
        { type: 'tool_use', id: `t${index}`, name: 'present_files', input: { filepaths: [path] } },
        {
          type: 'tool_result',
          tool_use_id: `t${index}`,
          name: 'present_files',
          content: [{ type: 'local_resource', file_path: path, name: 'build', mime_type: null }],
        },
      ],
    },
  ];
  const chat = {
    uuid: CHAT,
    name: 'Builds',
    current_leaf_message_uuid: 'a1',
    chat_messages: [
      ...presented('a0', '/mnt/user-data/outputs/build-0_1_1.vsix', 0),
      ...presented('a1', '/mnt/user-data/outputs/build-0_1_1.vsix', 1),
      ...presented('a2', '/mnt/user-data/outputs/build-0_1_0.vsix', 2),
    ],
  };
  // Message parents are chained: a0 ← a1-q.
  chat.chat_messages[2]!.parent_message_uuid = 'a0';
  chat.chat_messages[4]!.parent_message_uuid = 'a1';
  chat.current_leaf_message_uuid = 'a2';

  const server = (timelineStatus: number) => {
    const seen: string[] = [];
    const fetchFn: FetchLike = (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      const u = new URL(url);
      const json = (status: number, body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (u.pathname === '/api/organizations') return json(200, [{ uuid: ORG }]);
      if (u.pathname.endsWith(`/chat_conversations/${CHAT}`)) return json(200, chat);
      if (u.pathname === TIMELINE_PATH) {
        return Promise.resolve(
          timelineStatus === 200
            ? new Response(
                stream(
                  frame([
                    ...timeline,
                    ...goneRecord(
                      '/mnt/user-data/outputs/build-0_1_0.vsix',
                      'This file was replaced by newer files.',
                    ),
                  ]),
                  frame([], 2),
                ),
              )
            : new Response('', { status: timelineStatus }),
        );
      }
      return json(404, {});
    };
    return { fetchFn, seen };
  };

  const sources = async (fetchFn: FetchLike) => {
    const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(CHAT);
    return c.messages.flatMap((m) =>
      m.attachments.map((a) => (a.source?.kind === 'url' ? a.source.url : null)),
    );
  };

  it('download presented files from their saved copies, one per presentation', async () => {
    const { fetchFn, seen } = server(200);
    expect(await sources(fetchFn)).toEqual([
      `${ORIGIN}/api/organizations/${ORG}/files/${COPY_1}/contents`,
      `${ORIGIN}/api/organizations/${ORG}/files/${COPY_3}/contents`,
      // No saved copy: unavailable, with the web app's note, and no request for it.
      null,
    ]);
    expect(seen).toContain(`POST ${ORIGIN}${TIMELINE_PATH}`);
  });

  it("give the web app's note for a file it marks unavailable", async () => {
    const { fetchFn } = server(200);
    const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(CHAT);
    const gone = c.messages.flatMap((m) => m.attachments).at(-1);
    expect(gone).toMatchObject({
      note: 'unavailable',
      unavailableReason: 'This file was replaced by newer files.',
    });
  });

  it('keep the sandbox address when the timeline cannot be read', async () => {
    const { fetchFn } = server(500);
    for (const url of await sources(fetchFn)) expect(url).toContain('/wiggle/download-file?path=');
  });
});
