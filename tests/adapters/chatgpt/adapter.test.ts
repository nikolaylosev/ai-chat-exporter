import { describe, expect, it } from 'vitest';
import { ChatgptAdapter, projectOf } from '../../../src/adapters/chatgpt/adapter';
import { canvasFileName, TextdocReplay } from '../../../src/adapters/chatgpt/canvas';
import { toConversation } from '../../../src/adapters/chatgpt/normalize';
import { conversationSchema } from '../../../src/adapters/chatgpt/schema';
import { cleanAnswer, sandboxPaths, sourceKey } from '../../../src/adapters/chatgpt/text';
import { chatgptConversationId, chatgptProjectId } from '../../../src/adapters/chatgpt/urls';
import type { Block, Message } from '../../../src/model/conversation';
import { HttpError, type FetchLike } from '../../../src/util/http';
import {
  chatgptServer,
  fixture,
  loadConversations,
  ORIGIN,
  TOKEN,
  type ServerOptions,
} from './server';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const fileId = (n: number) => `file_${n.toString().padStart(32, '0')}`;
const BRANCHES = id(0x01);
const UPLOADS = id(0x13);
const IMAGE = id(0x27);
const CODE_FILE = id(0x2f);
const CANVAS = id(0x3a);
const SEARCH = id(0x42);
const TEMPORARY = id(0x54);

const all = loadConversations(
  'conversation-branches',
  'conversation-uploads',
  'conversation-image',
  'conversation-code-file',
  'conversation-canvas',
  'conversation-search',
  'conversation-temporary',
);
const adapter = (opts: ServerOptions = {}, url = `${ORIGIN}/`) => {
  const server = chatgptServer(all, opts);
  return { server, gpt: new ChatgptAdapter(server.fetchFn, () => url, ORIGIN, { minGapMs: 0 }) };
};
const text = (m: Message | undefined) =>
  m?.blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.markdown)
    .join('\n') ?? '';
const blocksOf = <T extends Block['type']>(m: Message | undefined, type: T) =>
  (m?.blocks ?? []).filter((b): b is Extract<Block, { type: T }> => b.type === type);

describe('chatgpt urls', () => {
  it.each([
    [`https://chatgpt.com/c/${BRANCHES}`, BRANCHES],
    [`https://chatgpt.com/c/${TEMPORARY}?temporary-chat=true`, TEMPORARY],
    [`https://chatgpt.com/g/g-p-abc-garden/c/${BRANCHES}`, BRANCHES],
    ['https://chatgpt.com/', null],
    [`https://chat.openai.com/c/${BRANCHES}`, null],
  ])('%s', (url, expected) => {
    expect(chatgptConversationId(url)).toBe(expected);
  });
});

describe('ChatgptAdapter: access token', () => {
  it('sends the session token with every API request', async () => {
    const { gpt, server } = adapter();
    await gpt.getConversation(TEMPORARY);
    await gpt.listConversations();
    const api = server.calls.filter((c) => c.path.startsWith('/backend-api/'));
    expect(api.length).toBeGreaterThan(1);
    expect(api.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    // The token is asked for once and kept in memory.
    expect(server.calls.filter((c) => c.path === '/api/auth/session')).toHaveLength(1);
  });

  it('treats a session without a token as signed out, not as an empty list', async () => {
    const { gpt } = adapter({ signedOut: true });
    const error = await gpt.listConversations().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).isAuth).toBe(true);
  });

  it('asks for a new token once when the old one is refused', async () => {
    const { gpt, server } = adapter({ expireTokenOnce: true });
    expect((await gpt.getConversation(TEMPORARY)).id).toBe(TEMPORARY);
    expect(server.calls.filter((c) => c.path === '/api/auth/session')).toHaveLength(2);
  });
});

describe('ChatgptAdapter: rate limit', () => {
  const make = (rateLimited: number, fileLinksRateLimited = false) => {
    const server = chatgptServer(all, { rateLimited, fileLinksRateLimited });
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    // The pacer starts without a gap; after a 429 it adds its own (under 15 s).
    return {
      gpt: new ChatgptAdapter(server.fetchFn, () => ORIGIN, ORIGIN, { sleep, minGapMs: 0 }),
      waits,
    };
  };

  it('waits 15, 30, 60 s after a 429 and goes on', async () => {
    const { gpt, waits } = make(3);
    expect((await gpt.getConversation(TEMPORARY)).id).toBe(TEMPORARY);
    expect(waits.filter((ms) => ms >= 15000)).toEqual([15000, 30000, 60000]);
    // The next requests keep a wider gap.
    expect(waits.some((ms) => ms > 0 && ms < 15000)).toBe(true);
  });

  it('gives up with a 429 after four retries, also while asking for a file link', async () => {
    const { gpt, waits } = make(Infinity);
    await expect(gpt.getConversation(UPLOADS)).rejects.toMatchObject({ status: 429 });
    expect(waits.filter((ms) => ms >= 15000)).toEqual([15000, 30000, 60000, 120000]);
    // A 429 for a file link is not taken for a missing file.
    const files = make(0, true);
    await expect(files.gpt.getConversation(UPLOADS)).rejects.toMatchObject({ status: 429 });
    expect(files.waits.filter((ms) => ms >= 15000)).toEqual([15000, 30000, 60000, 120000]);
  });
});

describe('ChatgptAdapter.listConversations', () => {
  it('reads the list with ISO dates', async () => {
    const { gpt } = adapter();
    const { conversations } = await gpt.listConversations();
    expect(conversations).toHaveLength(6);
    expect(conversations[0]).toEqual({
      id: SEARCH,
      platform: 'chatgpt',
      title: 'Iceland Population Search',
      createdAt: '2026-10-15T08:01:13.315769Z',
      updatedAt: '2026-10-15T08:01:31.250101Z',
      url: `${ORIGIN}/c/${SEARCH}`,
    });
  });

  it('stops after the current page when asked, before the archive and projects', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: id(0x1000 + i),
      title: `Chat ${i}`,
    }));
    const { gpt, server } = adapter({ listItems: items });
    const list = await gpt.listConversations(undefined, () => true);
    expect(list.conversations).toHaveLength(100);
    expect(list.incomplete).toEqual({ loaded: 100, stopped: true });
    expect(server.calls.filter((c) => c.path.startsWith('/backend-api/'))).toHaveLength(1);
  });

  it('pages by 100 with an overlap until a short page, whatever `total` says', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: id(0x1000 + i),
      title: `Chat ${i}`,
    }));
    const { gpt, server } = adapter({ listItems: items });
    const loaded: number[] = [];
    const { conversations } = await gpt.listConversations((n) => loaded.push(n));
    expect(conversations).toHaveLength(250);
    // Then the first page again, then the (empty) archive.
    expect(loaded).toEqual([100, 195, 250, 250, 250]);
    const pages = server.calls.filter(
      (c) => c.path.startsWith('/backend-api/conversations') && !c.path.includes('is_archived'),
    );
    expect(pages.map((c) => new URL(c.path, ORIGIN).searchParams.get('offset'))).toEqual([
      '0',
      '95',
      '190',
      '0',
    ]);
  });

  it('does not skip a chat when one already read is archived meanwhile', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: id(0x1000 + i),
      title: `Chat ${i}`,
    }));
    let reads = 0;
    const server = chatgptServer(all, { listItems: items });
    const fetchFn: FetchLike = (url, init) => {
      // After the second page, chat 150 leaves the history: the rest shift up by one,
      // so chat 200 moves onto the second page, already read.
      if (
        url.includes('/backend-api/conversations?') &&
        !url.includes('is_archived') &&
        ++reads === 3
      ) {
        items.splice(150, 1);
      }
      return server.fetchFn(url, init);
    };
    const gpt = new ChatgptAdapter(fetchFn, () => ORIGIN, ORIGIN, { minGapMs: 0 });
    const ids = (await gpt.listConversations()).conversations.map((c) => c.id);
    expect(ids).toContain(id(0x1000 + 200));
  });

  it('keeps chats that move while the list is read', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: id(0x1000 + i),
      title: `Chat ${i}`,
    }));
    let reads = 0;
    const server = chatgptServer(all, { listItems: items });
    const fetchFn: FetchLike = (url, init) => {
      if (url.includes('/backend-api/conversations?') && !url.includes('is_archived')) {
        reads++;
        // After the first page, chat 220 is updated: it goes to the top, the rest shift down.
        if (reads === 2) items.unshift(...items.splice(220, 1));
      }
      return server.fetchFn(url, init);
    };
    const gpt = new ChatgptAdapter(fetchFn, () => ORIGIN, ORIGIN, { minGapMs: 0 });
    const { conversations } = await gpt.listConversations();
    expect(new Set(conversations.map((c) => c.id)).size).toBe(250);
  });
});

describe('ChatgptAdapter.listConversations: archive and projects', () => {
  const chat = (n: number, extra: Record<string, unknown> = {}) => ({
    id: id(n),
    title: `Chat ${n}`,
    create_time: '2026-10-01T10:00:00.000000Z',
    update_time: '2026-10-02T10:00:00.000000Z',
    ...extra,
  });
  const project = (gizmoId: string, name: string) => ({
    gizmo: { gizmo: { id: gizmoId, display: { name } } },
    conversations: { items: [] },
  });

  it('adds archived chats and project chats with the project name', async () => {
    const { gpt } = adapter({
      listItems: [chat(0x100), chat(0x101, { gizmo_id: 'g-p-1' })],
      archivedItems: [chat(0x102)],
      sidebarPages: [[project('g-p-1', 'Garden')], [project('g-p-2', 'House')]],
      projectChats: {
        'g-p-1': [[chat(0x101)], [chat(0x103)]],
        // A project's chats may come with dates in seconds.
        'g-p-2': [[chat(0x104, { create_time: 1790000000, update_time: 1790000100.5 })]],
      },
    });
    const { conversations, incomplete } = await gpt.listConversations();
    expect(incomplete).toBeUndefined();
    expect(conversations.map((c) => [c.title, c.project ?? null, c.archived ?? false])).toEqual([
      ['Chat 256', null, false],
      ['Chat 257', 'Garden', false],
      ['Chat 258', null, true],
      ['Chat 259', 'Garden', false],
      ['Chat 260', 'House', false],
    ]);
    expect(conversations[4]?.updatedAt).toBe('2026-09-21T14:15:00.500Z');
  });

  it('keeps the history when the projects cannot be read', async () => {
    const { gpt } = adapter({ listItems: [chat(0x100)], sidebarBroken: true });
    const { conversations } = await gpt.listConversations();
    expect(conversations.map((c) => c.id)).toEqual([id(0x100)]);
  });

  it('reads a flatter sidebar entry and skips one without an id', () => {
    expect(projectOf({ gizmo: { id: 'g-p-9', name: 'Flat' } })).toMatchObject({
      id: 'g-p-9',
      name: 'Flat',
    });
    expect(projectOf({ gizmo: { gizmo: { id: 'g-p-8' } } })).toMatchObject({
      id: 'g-p-8',
      name: 'g-p-8',
      shortUrl: 'g-p-8',
      files: [],
    });
    expect(projectOf({ something: 1 })).toBeNull();
  });
});

describe('ChatgptAdapter.getConversation', () => {
  it('follows current_node and keeps the regenerated answer and the edit as branches', async () => {
    const { gpt } = adapter();
    const c = await gpt.getConversation(BRANCHES);
    expect(c).toMatchObject({
      id: BRANCHES,
      platform: 'chatgpt',
      title: 'Fruit List and Code',
      url: `${ORIGIN}/c/${BRANCHES}`,
      model: 'gpt-6',
    });
    expect(c.createdAt).toMatch(/^2026-10-15T/);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(text(c.messages[0])).toMatch(/\(edited\)/);
    expect(text(c.messages[1])).toBe('- Carrot\n- Broccoli');
    // The first question with its answer forks at the root; its regenerated answer
    // forks after that question.
    expect(c.branches).toHaveLength(2);
    expect(c.branches[0]?.forkAfterMessageId).toBeNull();
    expect(c.branches[0]?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(text(c.branches[0]?.messages[1])).toMatch(/Mango/);
    expect(c.branches[1]?.forkAfterMessageId).toBe(c.branches[0]?.messages[0]?.id);
    expect(text(c.branches[1]?.messages[0])).toMatch(/Orange/);
  });

  it('saves uploads through signed links and shows code with its output', async () => {
    const { gpt } = adapter({ missingFiles: [fileId(4)] });
    const c = await gpt.getConversation(UPLOADS);
    const [question, answer] = c.messages;
    expect(c.messages).toHaveLength(2);
    expect(text(question)).toMatch(/^AI Chat Exporter uploads test/);
    // The pasted image is also an upload: it is saved once.
    expect(question?.attachments.map((a) => [a.name, a.origin])).toEqual([
      ['fruit-prices.pdf', 'user-upload'],
      ['meeting-notes.docx', 'user-upload'],
      ['stripes.png', 'user-upload'],
    ]);
    expect(question?.attachments[0]).toMatchObject({
      mime: 'application/pdf',
      size: 414,
      source: { kind: 'url', url: `${ORIGIN}/backend-api/estuary/content?id=${fileId(2)}&sig=s` },
    });
    // A file ChatGPT no longer gives is saved as the text it extracted for the model.
    expect(question?.attachments[1]).toMatchObject({
      note: 'extracted-text-only',
      source: {
        kind: 'text',
        text: 'Meeting notes: paint the fence green. Next meeting on Friday.\n',
      },
    });

    const calls = blocksOf(answer, 'tool-call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'python', inputLanguage: 'python' });
    expect(calls[0]?.input).toMatch(/^from PIL import Image/);
    expect(calls[0]?.output).toMatch(/\(90, 60\)/);
    expect(blocksOf(answer, 'thinking')[0]?.markdown).toBe(
      'Inspecting stripe image dimensions and pixels',
    );
    // The files' extracted text is the model's context, not part of the chat.
    expect(JSON.stringify(answer)).not.toMatch(/PARSED TEXT/);
    expect(text(answer)).toMatch(/plums 5\.\n- \*\*meeting-notes/);
    expect(text(answer)).not.toMatch(/FileCite/);
  });

  it('notes a file that is gone and has no extracted text', async () => {
    const { gpt } = adapter({ missingFiles: [fileId(1)] });
    const c = await gpt.getConversation(UPLOADS);
    // The png was not read as text: nothing to fall back to.
    expect(c.messages[0]?.attachments[2]).toMatchObject({ source: null, note: 'unavailable' });
  });

  it('gives a new link for a file of a conversation it read', async () => {
    const { gpt, server } = adapter();
    const c = await gpt.getConversation(UPLOADS);
    const pdf = c.messages[0]?.attachments[0];
    const before = server.calls.length;
    expect(await gpt.fileLink(UPLOADS, pdf?.id ?? '')).toBe(
      `${ORIGIN}/backend-api/estuary/content?id=${fileId(2)}&sig=s`,
    );
    expect(server.calls.length).toBe(before + 1);
    expect(await gpt.fileLink(UPLOADS, 'unknown')).toBeNull();
    expect(await gpt.fileLink(BRANCHES, pdf?.id ?? '')).toBeNull();
  });

  it('saves a generated image at full size under its title', async () => {
    const { gpt } = adapter();
    const c = await gpt.getConversation(IMAGE);
    const answer = c.messages[1];
    expect(c.messages).toHaveLength(2);
    expect(answer?.blocks).toEqual([]);
    expect(answer?.attachments).toEqual([
      expect.objectContaining({
        name: 'Minimalist Red Circle on White.png',
        origin: 'image',
        mime: 'image/png',
        size: 952394,
        source: { kind: 'url', url: expect.stringContaining(fileId(7)) as string },
      }),
    ]);
  });

  it('fetches a file made by code through its sandbox path', async () => {
    const { gpt } = adapter();
    const c = await gpt.getConversation(CODE_FILE);
    const answer = c.messages[1];
    expect(text(answer)).toMatch(/^Created `fruits.csv`/);
    expect(text(answer)).toMatch(/\*\*Download fruits\.csv\*\*/);
    expect(text(answer)).not.toMatch(/sandbox:/);
    expect(answer?.attachments).toEqual([
      expect.objectContaining({
        name: 'fruits.csv',
        origin: 'model-generated',
        source: {
          kind: 'url',
          url: `${ORIGIN}/backend-api/estuary/content?id=sandbox&msg=${id(0x37)}`,
        },
      }),
    ]);
    expect(blocksOf(answer, 'tool-call')[0]?.output).toBe('Created /mnt/data/fruits.csv\n');
  });

  it('shows a canvas with the user’s edits and saves it as a file', async () => {
    const { gpt } = adapter();
    const c = await gpt.getConversation(CANVAS);
    const answer = c.messages[1];
    // The edit is only in writing_blocks; the answer text still has the first version.
    expect(text(answer)).toMatch(/^# Now open a code canvas/);
    expect(text(answer)).not.toMatch(/WritingBlock/);
    expect(answer?.attachments).toHaveLength(1);
    expect(answer?.attachments[0]).toMatchObject({
      origin: 'artifact',
      source: { kind: 'text' },
    });
    expect(answer?.attachments[0]?.name).toMatch(/^canvas-now-open-a-code-canvas.*\.md$/);
  });

  it('turns citations into links and entities into names', async () => {
    const { gpt } = adapter();
    const c = await gpt.getConversation(SEARCH);
    const answer = c.messages[1];
    const search = blocksOf(answer, 'web-search');
    expect(search).toHaveLength(1);
    expect(search[0]?.results.length).toBeGreaterThan(1);
    expect(search[0]?.results[0]?.url).toMatch(/^https:\/\/www\.statice\.is\//);
    const body = text(answer);
    expect(body).not.toMatch(/<Cite|<Entity/);
    expect(body).toMatch(/end of June 2026\. \(\[statice\.is\]\(https:\/\/statice\.is\//);
    expect(body).toMatch(/1\. Statistics Iceland — /);
  });

  it('reads a temporary chat while it is open', async () => {
    const { gpt } = adapter({}, `${ORIGIN}/c/${TEMPORARY}?temporary-chat=true`);
    expect(gpt.getCurrentConversationId()).toBe(TEMPORARY);
    const c = await gpt.getConversation(TEMPORARY);
    expect(text(c.messages[1])).toBe('ok');
  });
});

describe('cleanAnswer', () => {
  const sources = new Map([
    ['search0', { title: 'Page', url: 'https://example.com/a', attribution: 'Example' }],
  ]);
  const ctx = { sources, references: [], writingBlock: () => '' };

  it('reads the older private-use marks', () => {
    expect(
      cleanAnswer('Hello entity["place","Reykjavík","capital"]. citeturn0search0', ctx),
    ).toBe('Hello Reykjavík. ([Example](https://example.com/a))');
  });

  it('replaces marks that content_references describe, and only marks', () => {
    const references = [
      {
        type: 'grouped_webpages',
        matched_text: 'citeturn0search9',
        alt: '([Wiki](https://w.example))',
        items: [],
      },
      { type: 'code_block', matched_text: '```\nx\n```', alt: null, items: [] },
    ];
    expect(cleanAnswer('A citeturn0search9\n\n```\nx\n```', { ...ctx, references })).toBe(
      'A ([Wiki](https://w.example))\n\n```\nx\n```',
    );
  });

  it('maps a reference to its search result by type and number', () => {
    expect(sourceKey('turn446501search1')).toBe('search1');
    expect(sourceKey('turn0news12')).toBe('news12');
  });
});

describe('canvas made with tool calls (2025)', () => {
  const node = (n: number, parent: number | null, message: Record<string, unknown> | null) => ({
    id: id(n),
    parent: parent === null ? null : id(parent),
    children: [] as string[],
    message: message && { id: id(n), create_time: 1760000000 + n, metadata: {}, ...message },
  });
  const call = (recipient: string, args: unknown) => ({
    author: { role: 'assistant' },
    recipient,
    content: { content_type: 'code', text: JSON.stringify(args) },
  });
  const nodes = [
    node(0, null, null),
    node(1, 0, {
      author: { role: 'user' },
      content: { content_type: 'text', parts: ['Write a poem'] },
    }),
    node(
      2,
      1,
      call('canmore.create_textdoc', { name: 'Poem', type: 'document', content: 'Roses are red' }),
    ),
    node(3, 2, {
      author: { role: 'tool', name: 'canmore.create_textdoc' },
      content: { content_type: 'text', parts: ['Created'] },
    }),
    node(4, 3, {
      author: { role: 'assistant' },
      recipient: 'all',
      content: { content_type: 'text', parts: ['Done.'] },
    }),
    node(5, 4, {
      author: { role: 'user' },
      content: { content_type: 'text', parts: ['Make it blue'] },
    }),
    node(
      6,
      5,
      call('canmore.update_textdoc', {
        updates: [{ pattern: 'red', multiple: false, replacement: 'blue' }],
      }),
    ),
    node(7, 6, {
      author: { role: 'assistant' },
      recipient: 'all',
      content: { content_type: 'text', parts: ['Updated.'] },
    }),
  ];
  nodes.forEach((n) => {
    const parent = nodes.find((p) => p.id === n.parent);
    parent?.children.push(n.id);
  });
  const raw = conversationSchema.parse({
    conversation_id: id(0x99),
    title: 'Poem',
    current_node: id(7),
    mapping: Object.fromEntries(nodes.map((n) => [n.id, n])),
  });
  const files = (versions: 'latest' | 'all') =>
    toConversation(raw, {
      url: 'u',
      options: { artifactVersions: versions },
    }).conversation.messages.flatMap((m) =>
      m.attachments.map((a) => [a.name, a.source?.kind === 'text' ? a.source.text : null, a.note]),
    );

  it('keeps the newest version by default', () => {
    expect(files('latest')).toEqual([['canvas-poem.md', 'Roses are blue', 'rebuilt-from-chat']]);
  });

  it('keeps every version when asked', () => {
    expect(files('all')).toEqual([
      ['canvas-poem-v1.md', 'Roses are red', 'rebuilt-from-chat'],
      ['canvas-poem-v2.md', 'Roses are blue', 'rebuilt-from-chat'],
    ]);
  });

  it('does not show the canvas calls as tool calls', () => {
    const c = toConversation(raw, {
      url: 'u',
      options: { artifactVersions: 'latest' },
    }).conversation;
    expect(c.messages.flatMap((m) => m.blocks.map((b) => b.type))).toEqual([
      'text',
      'text',
      'text',
      'text',
    ]);
  });

  it('names files by language', () => {
    expect(canvasFileName('Add numbers', 'code/python', null)).toBe('canvas-add-numbers.py');
    expect(canvasFileName('', 'code/unknownlang', 2)).toBe('canvas-canvas-v2.txt');
  });

  it('applies updates in order', () => {
    const replay = new TextdocReplay();
    replay.apply('canmore.create_textdoc', JSON.stringify({ name: 'a', content: 'one two two' }));
    const v = replay.apply(
      'canmore.update_textdoc',
      JSON.stringify({ updates: [{ pattern: 'two', multiple: true, replacement: '2' }] }),
    );
    expect(v?.content).toBe('one 2 2');
  });
});

describe('ChatGPT in a Team workspace (2026-10-15)', () => {
  const node = (n: number, parent: number | null, message: Record<string, unknown> | null) => ({
    id: id(n),
    parent: parent === null ? null : id(parent),
    children: [] as string[],
    message: message && { id: id(n), create_time: 1790000000 + n, ...message },
  });
  const tree = (nodes: ReturnType<typeof node>[], current: number) => {
    nodes.forEach((x) => nodes.find((p) => p.id === x.parent)?.children.push(x.id));
    return conversationSchema.parse({
      conversation_id: id(0x77),
      title: 'Work',
      current_node: id(current),
      mapping: Object.fromEntries(nodes.map((x) => [x.id, x])),
    });
  };
  const options = { artifactVersions: 'latest' as const };

  it('keeps the extracted text of a long paste and says when it is cut', () => {
    const header =
      '[L1] <PARSED TEXT FOR PAGE: 1 / 1>\nUse ref_id "turn0file0" to reference this file. Full file size: 900 file lines.';
    const long = Array.from({ length: 900 }, (_, i) => `[L${i + 2}] line ${i} ${'x'.repeat(40)}`)
      .join('\n')
      .slice(0, 16384);
    const raw = tree(
      [
        node(0, null, null),
        node(1, 0, {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['See the paste'] },
          metadata: {
            attachments: [
              {
                id: 'file_paste',
                name: 'Pasted text.md',
                mime_type: 'text/plain',
                size: 30000,
                is_big_paste: true,
              },
            ],
          },
        }),
        node(2, 1, {
          author: { role: 'tool', name: 'api_tool' },
          content: { content_type: 'multimodal_text', parts: [header, long] },
          metadata: { is_visually_hidden_from_conversation: true },
        }),
        node(3, 2, {
          author: { role: 'assistant' },
          recipient: 'all',
          content: { content_type: 'text', parts: ['Read it.'] },
          metadata: {},
        }),
      ],
      3,
    );
    const { extracted, conversation } = toConversation(raw, { url: 'u', options });
    const paste = extracted.get(`${id(1)}:file_paste`);
    expect(paste?.complete).toBe(false);
    expect(paste?.text.startsWith(`line 0 ${'x'.repeat(40)}\nline 1 `)).toBe(true);
    // The hidden tool message is still not part of the transcript.
    expect(conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('saves files a tool attached, shows shell commands as text and names the image tool', () => {
    const raw = tree(
      [
        node(0, null, null),
        node(1, 0, {
          author: { role: 'user' },
          content: { content_type: 'text', parts: ['Draw and list'] },
          metadata: {},
        }),
        node(2, 1, {
          author: { role: 'assistant' },
          recipient: 'container.exec',
          content: { content_type: 'code', text: 'ls -la /mnt/data' },
          metadata: {},
        }),
        node(3, 2, {
          author: { role: 'tool', name: 'container.exec' },
          content: { content_type: 'execution_output', text: 'total 0' },
          metadata: {},
        }),
        node(4, 3, {
          author: { role: 'assistant' },
          recipient: 'container.open_image',
          content: { content_type: 'code', text: '{"path":"/mnt/data/chart.png"}' },
          metadata: {},
        }),
        node(5, 4, {
          author: { role: 'tool', name: 'container.open_image' },
          content: { content_type: 'execution_output', text: 'Image shown' },
          metadata: {
            attachments: [
              { id: 'file_chart', name: 'chart.png', mime_type: 'image/png', size: 10 },
            ],
          },
        }),
        node(6, 5, {
          author: { role: 'assistant' },
          recipient: 't2uay3k.sj1i4kz',
          content: {
            content_type: 'code',
            text: '{"prompt":{"text":"a cat"},"size":"1024x1024","n":1}',
          },
          metadata: {},
        }),
        node(7, 6, {
          author: { role: 'tool', name: 't2uay3k.sj1i4kz' },
          content: {
            content_type: 'multimodal_text',
            parts: [
              {
                content_type: 'image_asset_pointer',
                asset_pointer: 'sediment://file_cat',
                mime_type: 'image/png',
              },
            ],
          },
          metadata: { image_gen_title: 'Cat' },
        }),
      ],
      7,
    );
    const { conversation, files } = toConversation(raw, { url: 'u', options });
    const answer = conversation.messages[1];
    const calls = (answer?.blocks ?? []).filter((b) => b.type === 'tool-call');
    expect(calls.map((b) => [b.name, b.inputLanguage ?? null, b.output ?? null])).toEqual([
      ['container.exec', null, 'total 0'],
      ['container.open_image', 'json', 'Image shown'],
      ['image_gen', 'json', null],
    ]);
    expect(answer?.attachments.map((a) => [a.name, a.origin])).toEqual([
      ['chart.png', 'image'],
      ['Cat.png', 'image'],
    ]);
    expect([...files.values()]).toEqual([
      { kind: 'file', fileId: 'file_chart' },
      { kind: 'file', fileId: 'file_cat' },
    ]);
  });
});

describe('ChatgptAdapter projects', () => {
  const P = 'g-p-00000000000000000000000000000a01';
  const detail = fixture('project.json') as { gizmo: object; files: unknown[] };
  const entry = { gizmo: { gizmo: detail.gizmo, files: [] }, conversations: { items: [] } };
  const chatItem = {
    id: id(0x300),
    title: 'Airline list',
    create_time: '2026-10-16T07:31:00.000000Z',
    update_time: '2026-10-16T07:32:00.000000Z',
    gizmo_id: P,
  };
  const options = (extra: Partial<ServerOptions> = {}): ServerOptions => ({
    sidebarPages: [
      [entry, { gizmo: { gizmo: { id: 'g-abc', display: { name: 'A custom GPT' } } } }],
    ],
    projects: { [P]: detail },
    projectChats: { [P]: [[chatItem]] },
    ...extra,
  });

  it('lists projects from the sidebar, without custom GPTs', async () => {
    const { gpt } = adapter(options());
    expect(await gpt.listProjects()).toEqual([
      {
        id: P,
        platform: 'chatgpt',
        name: 'Airlines',
        description: 'Lists of airlines for the exporter test.',
        createdAt: '2026-10-16T07:30:00.000000+00:00',
        updatedAt: '2026-10-16T07:40:00.000000+00:00',
        url: `${ORIGIN}/g/${P}-airlines/project`,
        knowledgeCount: 0,
      },
    ]);
  });

  it('reads a project with its instructions, its files and its chats', async () => {
    // The shape of a project file is a guess: the discovery project had none.
    const withFile = {
      ...detail,
      files: [{ file_id: 'file-k1', name: 'fares.pdf', type: 'application/pdf', size: 900 }],
    };
    const { gpt, server } = adapter(options({ projects: { [P]: withFile } }));
    const project = await gpt.getProject(P);
    expect(project).toMatchObject({
      name: 'Airlines',
      instructions: 'Answer in one short sentence.',
      knowledgeCount: 1,
    });
    expect(project.knowledge).toEqual([
      {
        id: 'file-k1',
        name: 'fares.pdf',
        mime: 'application/pdf',
        size: 900,
        origin: 'project-knowledge',
        source: { kind: 'url', url: `${ORIGIN}/backend-api/estuary/content?id=file-k1&sig=s` },
      },
    ]);
    // A project's file belongs to no conversation.
    expect(server.calls.map((c) => c.path)).toContain(
      '/backend-api/files/download/file-k1?inline=false',
    );
    expect(project.conversations).toEqual([
      expect.objectContaining({ id: id(0x300), title: 'Airline list', project: 'Airlines' }),
    ]);
  });

  it('says a project that is gone is not there', async () => {
    await expect(adapter(options()).gpt.getProject('g-p-gone')).rejects.toThrow(/no conversation/);
  });

  it('names the project of a project page, of a project chat, and none elsewhere', async () => {
    const at = (url: string) => {
      const server = chatgptServer(
        { [id(0x300)]: { ...(all[BRANCHES] as object), conversation_id: id(0x300), gizmo_id: P } },
        options(),
      );
      return new ChatgptAdapter(server.fetchFn, () => url, ORIGIN, { minGapMs: 0 });
    };
    const named = { id: P, name: 'Airlines' };
    expect(await at(`${ORIGIN}/g/${P}-airlines/project`).getCurrentProject()).toEqual(named);
    expect(await at(`${ORIGIN}/g/${P}-airlines/c/${id(0x300)}`).getCurrentProject()).toEqual(named);
    expect(await at(`${ORIGIN}/c/${id(0x300)}`).getCurrentProject()).toEqual(named);
    expect(await at(`${ORIGIN}/`).getCurrentProject()).toBeNull();
  });

  it("records a project chat's project in its note", async () => {
    const server = chatgptServer(
      { [id(0x300)]: { ...(all[BRANCHES] as object), conversation_id: id(0x300), gizmo_id: P } },
      options(),
    );
    const gpt = new ChatgptAdapter(server.fetchFn, () => ORIGIN, ORIGIN, { minGapMs: 0 });
    expect((await gpt.getConversation(id(0x300))).project).toBe('Airlines');
  });
});

describe('chatgptProjectId', () => {
  it.each([
    [
      `${ORIGIN}/g/g-p-00000000000000000000000000000a01-airlines/project`,
      'g-p-00000000000000000000000000000a01',
    ],
    [
      `${ORIGIN}/g/g-p-00000000000000000000000000000a01/c/${id(1)}`,
      'g-p-00000000000000000000000000000a01',
    ],
    [`${ORIGIN}/g/g-abc123-some-gpt/c/${id(1)}`, null],
    [`${ORIGIN}/c/${id(1)}`, null],
  ])('%s', (url, expected) => {
    expect(chatgptProjectId(url)).toBe(expected);
  });
});

describe('a rich answer with a layout (2026-10)', () => {
  // The shape seen on 2026-10-16: cards with download buttons, then a note.
  const answer = [
    'Here are the files.',
    '',
    '<row gap={4}>',
    '  <box flex="1" radius="lg" padding={4} gap={2} align="start">',
    '    <icon name="file-text" size="2xl" color="accent"/>',
    '    **PDF**',
    '    <button size="md" onClick={()=>api.download("sandbox:/mnt/data/airlines.pdf")}>Download PDF <icon name="download" size="xs"/></button>',
    '  </box>',
    '  <box flex="1" radius="lg" padding={4} gap={2} align="start">',
    '    <icon name="file" size="2xl" color="accent"/>',
    '    **TXT**',
    '    <button size="md" onClick={()=>api.download("sandbox:/mnt/data/airlines.txt")}>Download TXT <icon name="download" size="xs"/></button>',
    '  </box>',
    '</row>',
    '',
    'The list has **2 airlines**.',
    '',
    '```html',
    '<button onClick={go}>Kept in code</button>',
    '```',
    '',
    '<text color="muted" size="sm">Checked today.</text>',
  ].join('\n');
  const ctx = { sources: new Map(), references: [], writingBlock: () => '' };

  it('finds the files its buttons download', () => {
    expect(sandboxPaths(answer)).toEqual(['/mnt/data/airlines.pdf', '/mnt/data/airlines.txt']);
  });

  it('keeps the text and drops the layout, leaving code blocks alone', () => {
    expect(cleanAnswer(answer, ctx)).toBe(
      [
        'Here are the files.',
        '',
        '**PDF**',
        '',
        'Download PDF',
        '',
        '**TXT**',
        '',
        'Download TXT',
        '',
        'The list has **2 airlines**.',
        '',
        '```html',
        '<button onClick={go}>Kept in code</button>',
        '```',
        '',
        'Checked today.',
      ].join('\n'),
    );
  });
});
