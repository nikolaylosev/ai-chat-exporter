import { describe, expect, it } from 'vitest';
import { DeepseekAdapter } from '../../../src/adapters/deepseek/adapter';
import { linkCitations } from '../../../src/adapters/deepseek/normalize';
import { deepseekConversationId, deepseekFileUrl } from '../../../src/adapters/deepseek/urls';
import { ChatNotFoundError } from '../../../src/adapters/errors';
import type { Block, Message } from '../../../src/model/conversation';
import { HttpError } from '../../../src/util/http';
import { deepseekServer, FILES, ORIGIN, TOKEN, type ServerOptions } from './server';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SEARCH = id(1);
const IMAGE = id(2);
const TEXT = id(4);
const EDITED = id(6);
const OLD = id(7);

const adapter = (options: ServerOptions = {}, token: string | null = TOKEN) => {
  const server = deepseekServer(options);
  const sleeps: number[] = [];
  const deepseek = new DeepseekAdapter(
    server.fetchFn,
    () => `${ORIGIN}/`,
    () => token,
    ORIGIN,
    FILES,
    (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  );
  return { server, deepseek, sleeps };
};
const text = (m: Message | undefined) =>
  m?.blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.markdown)
    .join('\n');
const types = (m: Message | undefined) => m?.blocks.map((b) => b.type);

describe('deepseek urls', () => {
  it.each([
    [`https://chat.deepseek.com/a/chat/s/${SEARCH}`, SEARCH],
    [`https://chat.deepseek.com/a/chat/s/${SEARCH.toUpperCase()}`, SEARCH],
    ['https://chat.deepseek.com/', null],
    [`https://chat.deepseek.com/share/abc`, null],
    [`https://deepseek.com/a/chat/s/${SEARCH}`, null],
  ])('%s', (url, expected) => {
    expect(deepseekConversationId(url)).toBe(expected);
  });

  it('asks for a document as it is and for an image as a JPEG preview', () => {
    expect(deepseekFileUrl('/file?file_id=a&state=s', false)).toBe(
      'https://files.deepseeksvc.com/api/file?file_id=a&state=s&ty=r',
    );
    expect(deepseekFileUrl('/file?file_id=a&state=s', true)).toBe(
      'https://files.deepseeksvc.com/api/file?file_id=a&state=s&ty=p&fmt=jpeg',
    );
  });
});

describe('DeepseekAdapter.listConversations', () => {
  it('lists the chats with their times', async () => {
    const { deepseek } = adapter();
    const { conversations } = await deepseek.listConversations();
    expect(conversations.map((c) => c.id).sort()).toEqual(
      [SEARCH, IMAGE, TEXT, EDITED, OLD].sort(),
    );
    const edited = conversations.find((c) => c.id === EDITED);
    expect(edited).toMatchObject({
      platform: 'deepseek',
      title: 'France capital test',
      url: `${ORIGIN}/a/chat/s/${EDITED}`,
    });
    expect(edited?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('pages from the last chat, pinned ones first, without repeats', async () => {
    const sessions = Array.from({ length: 230 }, (_, i) => ({
      id: id(1000 + i),
      title: `Chat ${i}`,
      pinned: i % 50 === 0,
      updated_at: 1_700_000_000 + i * 10,
      inserted_at: 1_700_000_000,
    }));
    const { deepseek, server } = adapter({ sessions });
    const progress: number[] = [];
    const { conversations } = await deepseek.listConversations((n) => progress.push(n));
    expect(conversations).toHaveLength(230);
    expect(new Set(conversations.map((c) => c.id)).size).toBe(230);
    // The five pinned chats come first.
    expect(conversations.slice(0, 5).map((c) => c.title)).toEqual([
      'Chat 200',
      'Chat 150',
      'Chat 100',
      'Chat 50',
      'Chat 0',
    ]);
    expect(progress).toEqual([100, 199, 230]);
    expect(server.requests[1]).toContain('lte_cursor.pinned=false&lte_cursor.updated_at=');
  });

  it('stops after a page when asked', async () => {
    const sessions = Array.from({ length: 150 }, (_, i) => ({
      id: id(2000 + i),
      title: `Chat ${i}`,
      pinned: false,
      updated_at: 1_700_000_000 + i,
    }));
    const { deepseek } = adapter({ sessions });
    const list = await deepseek.listConversations(undefined, () => true);
    expect(list.incomplete).toEqual({ loaded: 100, stopped: true });
  });

  it('says the user is signed out without a token or with a rejected one', async () => {
    await expect(adapter({}, null).deepseek.listConversations()).rejects.toMatchObject({
      status: 401,
    });
    await expect(adapter({}, 'expired').deepseek.listConversations()).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('waits and tries again when the app is asked too often', async () => {
    const { deepseek, sleeps } = adapter({ rateLimited: 2 });
    const { conversations } = await deepseek.listConversations();
    expect(conversations).toHaveLength(5);
    expect(sleeps).toEqual([2000, 4000]);
    await expect(adapter({ rateLimited: 9 }).deepseek.listConversations()).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe('DeepseekAdapter.getConversation', () => {
  it('follows the current branch and keeps the others', async () => {
    const c = await adapter().deepseek.getConversation(EDITED);
    // The prompt was edited (a second root) and its answer regenerated.
    expect(c.messages.map((m) => [m.id, m.role])).toEqual([
      ['3', 'user'],
      ['5', 'assistant'],
    ]);
    expect(c.branches.map((b) => [b.forkAfterMessageId, b.messages.map((m) => m.id)])).toEqual([
      [null, ['1', '2']],
      ['3', ['4']],
    ]);
    expect(c.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('reads thinking, the search and links citations to its results', async () => {
    const c = await adapter().deepseek.getConversation(SEARCH);
    const answer = c.messages[1];
    expect(types(answer)).toEqual(['web-search', 'thinking', 'text']);
    const search = answer?.blocks[0] as Extract<Block, { type: 'web-search' }>;
    expect(search.results.length).toBeGreaterThan(5);
    expect(search.results[0]?.url).toMatch(/^https:\/\/example\.com\/(source|uncited)-\d+$/);
    expect(text(answer)).not.toContain('[citation:');
    expect(text(answer)).toMatch(/Claim 1 \(\[Example 6\]\(https:\/\/example\.com\/source-6\)\)\./);
  });

  it('shows the busy notice as such, and an empty stopped answer as nothing', async () => {
    const c = await adapter().deepseek.getConversation(SEARCH);
    // The current answer was stopped before it said anything.
    expect(c.messages.at(-1)).toMatchObject({ id: '7', role: 'assistant', blocks: [] });
    const busy = c.branches.flatMap((b) => b.messages).find((m) => m.id === '5');
    expect(text(busy)).toBe('*The server is busy. Please try again later.*');
  });

  it('saves a document as it is and an image as a JPEG preview', async () => {
    const { deepseek } = adapter();
    const doc = (await deepseek.getConversation(TEXT)).messages[0];
    expect(doc?.blocks).toEqual([]);
    expect(doc?.attachments).toEqual([
      {
        id: id(5),
        name: 'notes-1.txt',
        size: 293,
        origin: 'user-upload',
        source: {
          kind: 'url',
          url: `${FILES}/api/file?file_id=${id(5)}&state=TEST-STATE-1&ty=r`,
        },
      },
    ]);
    const image = (await deepseek.getConversation(IMAGE)).messages[0]?.attachments[0];
    expect(image).toEqual({
      id: id(3),
      name: 'picture-1.jpg',
      mime: 'image/jpeg',
      origin: 'user-upload',
      source: {
        kind: 'url',
        url: `${FILES}/api/file?file_id=${id(3)}&state=TEST-STATE-1&ty=p&fmt=jpeg`,
      },
      note: 'preview',
    });
  });

  it('names an old upload whose bytes the server no longer keeps', async () => {
    const files = (await adapter().deepseek.getConversation(OLD)).messages[0]?.attachments;
    expect(files?.map((f) => [f.name, f.source, f.note])).toEqual([
      ['picture-1.png', null, 'unavailable'],
      ['picture-2.png', null, 'unavailable'],
    ]);
  });

  it('says a chat that is not there is not found', async () => {
    await expect(adapter().deepseek.getConversation(id(99))).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
  });
});

describe('DeepseekAdapter.fileLink', () => {
  it('asks for a new signed link', async () => {
    const { deepseek } = adapter({
      freshPaths: { [id(5)]: { signed_path: `/file?file_id=${id(5)}&state=NEW`, is_image: false } },
    });
    expect(await deepseek.fileLink(TEXT, id(5))).toBe(
      `${FILES}/api/file?file_id=${id(5)}&state=NEW&ty=r`,
    );
    expect(await deepseek.fileLink(TEXT, id(77))).toBeNull();
  });
});

describe('linkCitations', () => {
  const sources = new Map([
    [1, { url: 'https://a.example/', label: 'A' }],
    [2, { url: 'https://b.example/', label: 'B [x]' }],
  ]);
  it.each([
    ['Fact[citation:1].', 'Fact ([A](https://a.example/)).'],
    [
      'Fact [citation:1][citation:2][citation:1]',
      'Fact ([A](https://a.example/), [B \\[x\\]](https://b.example/))',
    ],
    ['Fact[citation:9].', 'Fact.'],
  ])('%s', (input, expected) => {
    expect(linkCitations(input, sources)).toBe(expected);
  });
});
