import { describe, expect, it } from 'vitest';
import { ChatNotFoundError, PlatformBusyError } from '../../../src/adapters/errors';
import { GeminiAdapter } from '../../../src/adapters/gemini/adapter';
import type { FetchLike } from '../../../src/util/http';
import { cleanAnswer, fullSizeUrl } from '../../../src/adapters/gemini/normalize';
import { geminiNotebookId } from '../../../src/adapters/gemini/urls';
import { fixture, geminiServer, loadConversations, ORIGIN } from './server';

const all = loadConversations(
  'conversation-basic',
  'conversation-long',
  'conversation-image',
  'conversation-canvas',
  'conversation-gem',
  'conversation-upload-image',
  'conversation-upload-documents',
);
const adapter = (url = `${ORIGIN}/app`) => {
  const server = geminiServer(all);
  return { server, gemini: new GeminiAdapter(server.fetchFn, () => url, ORIGIN) };
};
const texts = (c: { messages: { role: string; blocks: { type: string }[] }[] }) =>
  c.messages.map((m) => [
    m.role,
    m.blocks.map((b) => ('markdown' in b ? (b.markdown as string) : b.type)).join('|'),
  ]);

describe('GeminiAdapter.getConversation', () => {
  it('reads a chat oldest turn first, with title, dates and model', async () => {
    const { gemini, server } = adapter();
    const c = await gemini.getConversation('0000000000000001');
    expect(c).toMatchObject({
      id: '0000000000000001',
      platform: 'gemini',
      title: 'Fruit List and Python Code',
      url: `${ORIGIN}/app/0000000000000001`,
      model: '3.8 Flash',
      branches: [],
    });
    expect(texts(c)[0]?.[1]).toContain('Name three fruits');
    expect(texts(c)[1]?.[1]).toMatch(
      /^1\. Apple\n2\. Banana[\s\S]*\*\*essential vitamins[\s\S]*```python/,
    );
    expect(texts(c)[2]?.[1]).toContain('turn 2');
    expect(c.createdAt! < c.messages[2]!.createdAt!).toBe(true);
    expect(c.updatedAt).not.toBeNull();
    // Every call carried the XSRF token from the page.
    expect(server.calls.every((call) => call.at === 'xsrf-token')).toBe(true);
  });

  it('follows history pages', async () => {
    const { gemini, server } = adapter();
    const c = await gemini.getConversation('0000000000000006');
    const prompts = c.messages
      .filter((m) => m.role === 'user')
      .map((m) => (m.blocks[0] as { markdown: string }).markdown);
    expect(prompts).toHaveLength(11);
    expect(prompts[0]).toContain('turn 1.');
    expect(prompts[10]).toContain('turn 11.');
    const history = server.calls.filter((call) => call.rpcId === 'hNvQHb');
    expect(history).toHaveLength(2);
    expect((history[1]?.args as unknown[])[2]).toEqual(expect.any(String));
  });

  it('downloads uploaded documents from their links and drops citation markers', async () => {
    const { gemini } = adapter();
    const c = await gemini.getConversation('000000000000002a');
    expect(c.messages[0]?.attachments).toEqual([
      expect.objectContaining({
        name: 'fruit-prices.pdf',
        origin: 'user-upload',
        source: {
          kind: 'url',
          url: expect.stringMatching(
            /^https:\/\/contribution\.usercontent\.google\.com\/download\?.*filename=fruit-prices\.pdf/,
          ) as string,
        },
      }),
      expect.objectContaining({
        name: 'meeting-notes.docx',
        mime: expect.stringContaining('wordprocessingml') as string,
      }),
    ]);
    expect(texts(c)[1]?.[1]).not.toContain('[cite');
  });

  it('takes uploaded images at full size and marks them re-encoded', async () => {
    const { gemini } = adapter();
    const c = await gemini.getConversation('0000000000000027');
    expect(c.messages[0]?.attachments).toEqual([
      expect.objectContaining({
        name: 'stripes.png',
        note: 'recompressed',
        source: {
          kind: 'url',
          url: expect.stringMatching(
            /^https:\/\/lh3\.googleusercontent\.com\/gg\/.*=s0$/,
          ) as string,
        },
      }),
    ]);
  });

  it('attaches generated images and removes their placeholder from the text', async () => {
    const { gemini } = adapter();
    const c = await gemini.getConversation('000000000000001d');
    const answer = c.messages[1]!;
    expect(answer.blocks).toEqual([]);
    expect(answer.attachments).toEqual([
      expect.objectContaining({
        name: expect.stringMatching(/^watermarked_img_\d+\.jpg$/) as string,
        origin: 'image',
        mime: 'image/jpeg',
      }),
    ]);
    expect((answer.attachments[0]?.source as { url: string }).url).toMatch(/=s0$/);
  });

  it('keeps the Canvas link and text, without the file tag', async () => {
    const { gemini } = adapter();
    const c = await gemini.getConversation('0000000000000021');
    const text = texts(c)[1]?.[1] ?? '';
    expect(text).toContain('[Exporter Canvas Test](https://docs.google.com/document/d/');
    expect(text).toContain('### Exporter Canvas Test');
    expect(text).not.toContain('[file-tag');
  });

  it('names the Gem and links the chat under it', async () => {
    const { gemini } = adapter();
    const c = await gemini.getConversation('0000000000000024');
    expect(c.project).toBe('Brainstormer');
    expect(c.url).toBe(`${ORIGIN}/gem/brainstormer/0000000000000024`);
  });

  it('uses the account prefix of a second Google account', async () => {
    const { gemini, server } = adapter(`${ORIGIN}/u/1/app/0000000000000001`);
    expect(gemini.getCurrentConversationId()).toBe('0000000000000001');
    const c = await gemini.getConversation('0000000000000001');
    expect(c.url).toBe(`${ORIGIN}/u/1/app/0000000000000001`);
    expect(server.calls[0]?.sourcePath).toMatch(/^\/u\/1\//);
  });
});

describe('GeminiAdapter: a chat that is gone', () => {
  it('says the chat is not there, not that the format changed', async () => {
    const { gemini } = adapter();
    await expect(gemini.getConversation('0000000000abcdef')).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
  });
});

describe('GeminiAdapter.listConversations', () => {
  it('maps the list with update times and Gem names', async () => {
    const { gemini } = adapter();
    const list = (await gemini.listConversations()).conversations;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toMatchObject({
      platform: 'gemini',
      createdAt: null,
      url: expect.stringMatching(/^https:\/\/gemini\.google\.com\/(app|gem)\//) as string,
    });
    expect(list.every((c) => /^[0-9a-f]{16}$/.test(c.id))).toBe(true);
  });

  it('stops after the current page when asked', async () => {
    const { gemini, server } = adapter();
    const list = await gemini.listConversations(undefined, () => true);
    expect(server.calls.filter((c) => c.rpcId === 'MaZiqc')).toHaveLength(1);
    expect(list.incomplete).toEqual({ loaded: list.conversations.length, stopped: true });
    expect(list.conversations.length).toBeGreaterThan(0);
  });

  it('follows page tokens and keeps each chat once', async () => {
    const { gemini, server } = adapter();
    const list = (await gemini.listConversations()).conversations;
    const pages = server.calls.filter((c) => c.rpcId === 'MaZiqc').map((c) => c.args);
    expect(pages).toEqual([
      [100, null, expect.any(Array)],
      [100, 'NEXT_PAGE_TOKEN', expect.any(Array)],
      [100, 'LAST_PAGE_TOKEN', expect.any(Array)],
    ]);
    expect(list.at(-1)).toMatchObject({ id: '00000000000000ff', title: 'Older chat' });
    expect(list.filter((c) => c.id === '0000000000000001')).toHaveLength(1);
  });
});

describe('GeminiAdapter.listConversations with chats known from before', () => {
  it('stops after the page holding a known chat with the same update time', async () => {
    const whole = (await adapter().gemini.listConversations()).conversations;
    const { gemini, server } = adapter();
    const second = whole[2];
    const known = new Map([[second?.id ?? '', second?.updatedAt ?? null]]);
    const list = await gemini.listConversations(undefined, undefined, known);
    expect(list.reachedKnown).toBe(true);
    expect(server.calls.filter((c) => c.rpcId === 'MaZiqc')).toHaveLength(1);
    expect(list.conversations.length).toBeGreaterThan(0);
  });

  it('reads on past a known chat that changed since', async () => {
    const whole = (await adapter().gemini.listConversations()).conversations;
    const { gemini } = adapter();
    const known = new Map(whole.map((c) => [c.id, '2020-01-01T00:00:00.000Z']));
    const list = await gemini.listConversations(undefined, undefined, known);
    expect(list.reachedKnown).toBeUndefined();
    expect(list.conversations).toHaveLength(whole.length);
  });
});

describe('GeminiAdapter.listConversations when Gemini fails', () => {
  const statusBody = (status: number) =>
    `)]}'\n\n${JSON.stringify([['wrb.fr', 'MaZiqc', null, null, null, [status], 'generic']])}`;
  type Failure = 'status 13' | 'connection' | 'body' | 'http 500';
  /** The fake server, with list pages failing while `fails(size, token)` says so. */
  const failing = (
    fails: (size: number, token: unknown) => boolean,
    failure: Failure = 'status 13',
  ) => {
    const server = geminiServer(all);
    const seen: [number, unknown, string][] = [];
    const fetchFn: FetchLike = (url, init) => {
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      const request = JSON.parse(form.get('f.req') ?? '[[[]]]') as [[[string, string]]];
      if (request[0][0][0] === 'MaZiqc') {
        const args = JSON.parse(request[0][0][1]) as [number, unknown, unknown[]];
        if (typeof args[2][5] !== 'string') {
          const fail = fails(args[0], args[1]);
          seen.push([args[0], args[1], fail ? failure : 'ok']);
          if (fail && failure === 'status 13') return Promise.resolve(new Response(statusBody(13)));
          if (fail && failure === 'connection') {
            return Promise.reject(new TypeError('Failed to fetch'));
          }
          if (fail && failure === 'http 500')
            return Promise.resolve(new Response('', { status: 500 }));
          if (fail) {
            // The answer starts, then the connection drops while the body is read.
            return Promise.resolve({
              ok: true,
              status: 200,
              text: () => Promise.reject(new TypeError('Failed to fetch')),
            } as unknown as Response);
          }
        }
      }
      return server.fetchFn(url, init);
    };
    const gemini = new GeminiAdapter(
      fetchFn,
      () => `${ORIGIN}/app`,
      ORIGIN,
      () => Promise.resolve(),
    );
    return { gemini, seen };
  };

  it('asks for a failing page again and goes on', async () => {
    let failures = 2;
    const { gemini, seen } = failing(
      (_size, token) => token === 'NEXT_PAGE_TOKEN' && failures-- > 0,
    );
    const list = await gemini.listConversations();
    expect(list.incomplete).toBeUndefined();
    expect(list.conversations.at(-1)).toMatchObject({ title: 'Older chat' });
    // The same page: a smaller one is no faster for Gemini.
    expect(seen.filter(([, token]) => token === 'NEXT_PAGE_TOKEN')).toEqual([
      [100, 'NEXT_PAGE_TOKEN', 'status 13'],
      [100, 'NEXT_PAGE_TOKEN', 'status 13'],
      [100, 'NEXT_PAGE_TOKEN', 'ok'],
    ]);
  });

  it('returns the chats read so far, marked incomplete, when Gemini keeps failing', async () => {
    const { gemini } = failing((_size, token) => token === 'NEXT_PAGE_TOKEN');
    const list = await gemini.listConversations();
    expect(list.incomplete).toEqual({ loaded: list.conversations.length });
    expect(list.conversations.length).toBeGreaterThan(0);
  });

  it.each<Failure>(['connection', 'body', 'http 500'])(
    'returns the chats read so far after a lost %s too',
    async (failure) => {
      const { gemini } = failing((_size, token) => token === 'NEXT_PAGE_TOKEN', failure);
      const list = await gemini.listConversations();
      expect(list.incomplete).toEqual({ loaded: list.conversations.length });
      expect(list.conversations.length).toBeGreaterThan(0);
    },
  );

  it('reads past one dropped connection while a deep page is read', async () => {
    let drops = 1;
    const { gemini } = failing(
      (_size, token) => token === 'NEXT_PAGE_TOKEN' && drops-- > 0,
      'body',
    );
    const list = await gemini.listConversations();
    expect(list.incomplete).toBeUndefined();
    expect(list.conversations.at(-1)).toMatchObject({ title: 'Older chat' });
  });

  it('fails when not even the first page comes', async () => {
    const { gemini } = failing(() => true);
    await expect(gemini.listConversations()).rejects.toBeInstanceOf(PlatformBusyError);
  });
});

describe('cleanAnswer', () => {
  it.each([
    ['Prices[cite: 1].', 'Prices.'],
    ['A [cite: 1, 2] b', 'A b'],
    ['Text\n[file-tag: drive-uploaded-file-X]\n\nMore', 'Text\n\nMore'],
    ['\n\nhttp://googleusercontent.com/image_generation_content/0_801\n\n', ''],
    ['Before\n\nhttp://googleusercontent.com/youtube_content/2\n\nAfter', 'Before\n\nAfter'],
  ])('%j → %j', (input, expected) => {
    expect(cleanAnswer(input)).toBe(expected);
  });
});

describe('fullSizeUrl', () => {
  it.each([
    ['https://lh3.googleusercontent.com/gg/abc', 'https://lh3.googleusercontent.com/gg/abc=s0'],
    [
      'https://lh3.googleusercontent.com/gg/abc=w512',
      'https://lh3.googleusercontent.com/gg/abc=s0',
    ],
    [
      'https://contribution.usercontent.google.com/download?c=x',
      'https://contribution.usercontent.google.com/download?c=x',
    ],
  ])('%s', (url, expected) => {
    expect(fullSizeUrl(url)).toBe(expected);
  });
});

describe('GeminiAdapter: notebooks', () => {
  const NOTEBOOK_ID = '00000000-0000-4000-8000-0000000000b0';

  it('lists notebooks as projects', async () => {
    const { gemini } = adapter();
    expect(await gemini.listProjects()).toEqual([
      {
        id: NOTEBOOK_ID,
        platform: 'gemini',
        name: 'Test notebook about fruit',
        description: '',
        createdAt: expect.stringMatching(/^2026-/) as string,
        updatedAt: expect.stringMatching(/^2026-/) as string,
        url: `${ORIGIN}/notebook/${NOTEBOOK_ID}`,
        knowledgeCount: 1,
      },
    ]);
  });

  it('reads a notebook with its source, listed only, and every chat it holds', async () => {
    const { gemini, server } = adapter();
    const notebook = await gemini.getProject(NOTEBOOK_ID);
    expect(notebook.knowledge).toEqual([
      {
        id: `notebooks/${NOTEBOOK_ID}/sources/src000000000000000000000000000000001`,
        name: 'fruit-prices.pdf',
        mime: 'application/pdf',
        origin: 'project-knowledge',
        source: null,
        note: 'unavailable',
      },
    ]);
    expect(notebook.conversations.map((c) => [c.title, c.project])).toEqual([
      ['Notebook chat 1', 'Test notebook about fruit'],
      ['Notebook chat 2', 'Test notebook about fruit'],
      ['Notebook chat 3', 'Test notebook about fruit'],
      ['Notebook chat 4', 'Test notebook about fruit'],
    ]);
    expect(notebook.conversations[0]?.url).toBe(`${ORIGIN}/app/0000000000000031`);
    const asked = server.calls.find((c) => c.rpcId === 'MaZiqc')?.args;
    expect(asked).toEqual([20, null, [null, null, 1, `notebooks/${NOTEBOOK_ID}`, 1]]);
  });

  it('names the open notebook, and none on a chat page', async () => {
    const onNotebook = new GeminiAdapter(
      geminiServer(all).fetchFn,
      () => `${ORIGIN}/notebook/${NOTEBOOK_ID}`,
      ORIGIN,
      () => Promise.resolve(),
    );
    expect(await onNotebook.getCurrentProject()).toEqual({
      id: NOTEBOOK_ID,
      name: 'Test notebook about fruit',
    });
    expect(await adapter().gemini.getCurrentProject()).toBeNull();
  });

  it("names the notebook of a notebook's chat, and none for another chat", async () => {
    const [entry] = (fixture('notebook-chats.json') as [null, null, unknown[]])[2];
    const chats = { ...all, '0000000000000031': { history: [], meta: [null, null, [entry]] } };
    const on = (id: string) =>
      new GeminiAdapter(geminiServer(chats).fetchFn, () => `${ORIGIN}/app/${id}`, ORIGIN);
    expect(await on('0000000000000031').getCurrentProject()).toEqual({
      id: NOTEBOOK_ID,
      name: 'Test notebook about fruit',
    });
    expect(await on('0000000000000001').getCurrentProject()).toBeNull();
  });

  it('says a notebook that is gone is not there', async () => {
    await expect(
      adapter().gemini.getProject('00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toBeInstanceOf(ChatNotFoundError);
  });
});

describe('geminiNotebookId', () => {
  it.each([
    [
      `${ORIGIN}/notebook/00000000-0000-4000-8000-0000000000b0`,
      '00000000-0000-4000-8000-0000000000b0',
    ],
    [
      `${ORIGIN}/u/1/notebook/00000000-0000-4000-8000-0000000000B0`,
      '00000000-0000-4000-8000-0000000000b0',
    ],
    [`${ORIGIN}/app/0123456789abcdef`, null],
    ['https://notebooklm.google.com/notebook/00000000-0000-4000-8000-0000000000b0', null],
  ])('%s', (url, id) => {
    expect(geminiNotebookId(url)).toBe(id);
  });
});
