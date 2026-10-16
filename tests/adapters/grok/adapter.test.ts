import { describe, expect, it } from 'vitest';
import { PlatformFormatError } from '../../../src/adapters/errors';
import { GrokAdapter } from '../../../src/adapters/grok/adapter';
import { cleanAnswer } from '../../../src/adapters/grok/normalize';
import { grokConversationId, grokProjectId, parseGrokUrl } from '../../../src/adapters/grok/urls';
import type { Message } from '../../../src/model/conversation';
import { fixture, grokServer, loadConversations, ORIGIN, WORKSPACE } from './server';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const BASIC = id(1);
const UPLOADS = id(6);
const IMAGE = id(0x14);

const all = loadConversations('conversation-basic', 'conversation-uploads', 'conversation-image');
const adapter = (url = `${ORIGIN}/`) => {
  const server = grokServer(all);
  return { server, grok: new GrokAdapter(server.fetchFn, () => url, ORIGIN) };
};
const text = (m: Message | undefined) =>
  m?.blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.markdown)
    .join('\n');

describe('grok urls', () => {
  it.each([
    [`https://grok.com/c/${BASIC}`, BASIC],
    [`https://grok.com/c/${BASIC}?rid=${id(4)}`, BASIC],
    [`https://grok.com/project/abc/c/${BASIC}`, BASIC],
    [`https://grok.com/project/${id(0xc0)}?chat=${BASIC}`, BASIC],
    [`https://grok.com/project/${id(0xc0)}`, null],
    ['https://grok.com/', null],
    [`https://x.com/i/grok/c/${BASIC}`, null],
  ])('%s', (url, expected) => {
    expect(grokConversationId(url)).toBe(expected);
  });

  it('finds the project of a project page and of a chat open in it', () => {
    expect(grokProjectId(`https://grok.com/project/${WORKSPACE}`)).toBe(WORKSPACE);
    expect(grokProjectId(`https://grok.com/project/${WORKSPACE}?chat=${BASIC}`)).toBe(WORKSPACE);
    expect(grokProjectId(`https://grok.com/c/${BASIC}`)).toBeNull();
  });

  it('keeps a valid ?rid only', () => {
    expect(parseGrokUrl(`https://grok.com/c/${BASIC}?rid=${id(4)}`)?.responseId).toBe(id(4));
    expect(parseGrokUrl(`https://grok.com/c/${BASIC}?rid=x`)?.responseId).toBeNull();
  });
});

describe('GrokAdapter.getConversation', () => {
  it('reads title, dates, model and Markdown', async () => {
    const { grok } = adapter();
    const c = await grok.getConversation(BASIC);
    expect(c).toMatchObject({
      id: BASIC,
      platform: 'grok',
      title: 'AI Chat Exporter test request with fruits list and Python code',
      createdAt: '2026-10-13T20:19:14.730Z',
      updatedAt: '2026-10-13T20:19:26.199Z',
      url: `${ORIGIN}/c/${BASIC}`,
      model: 'grok-3',
    });
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(text(c.messages[0])).toMatch(/^AI Chat Exporter test 1\./);
    expect(text(c.messages[1])).toMatch(/```python\n/);
  });

  it('saves a file the model made from its card, byte for byte from assets.grok.com', async () => {
    // As seen on 2026-10-16: the answer marks the card, the card names the file.
    const basic = structuredClone(all[BASIC]) as (typeof all)[string];
    const answer = basic.responses.responses.find((r) => r.responseId === id(5)) as unknown as {
      message: string;
      cardAttachmentsJson: string[];
    };
    answer.message +=
      '\n\n<grok:render card_id="a1b2c" card_type="rendered_file_card" type="render_file"></grok:render>';
    answer.cardAttachmentsJson = [
      JSON.stringify({
        id: 'a1b2c',
        type: 'render_file',
        cardType: 'rendered_file_card',
        file_name: 'contests.pdf',
        content_type: 'pdf',
        mime_type: 'application/pdf',
        file_size: 31739,
        url: `users/${id(0xd0)}/generated/${id(0xd1)}/contests.pdf`,
        thumbnail_url: 'https://grok.com/file-icons/pdf_light.png',
      }),
    ];
    const server = grokServer({ [BASIC]: basic });
    const c = await new GrokAdapter(server.fetchFn, () => '', ORIGIN).getConversation(BASIC);
    expect(c.messages[1]?.attachments).toEqual([
      {
        id: `${id(5)}:file:0`,
        name: 'contests.pdf',
        mime: 'application/pdf',
        size: 31739,
        origin: 'model-generated',
        source: {
          kind: 'url',
          url: `https://assets.grok.com/users/${id(0xd0)}/generated/${id(0xd1)}/contests.pdf`,
        },
      },
    ]);
    expect(c.messages[1]?.blocks.some((b) => b.type === 'unreadable')).toBe(false);
  });

  it('shows the newest answer and keeps the regenerated one as a branch', async () => {
    const { grok } = adapter();
    const c = await grok.getConversation(BASIC);
    expect(text(c.messages[1])).toContain('3. Cherry');
    expect(c.branches).toHaveLength(1);
    expect(c.branches[0]?.forkAfterMessageId).toBe(id(2));
    expect(text(c.branches[0]?.messages[0])).toContain('3. Orange');
  });

  it('shows the answer in ?rid= of the open page', async () => {
    const { grok } = adapter(`${ORIGIN}/c/${BASIC}?rid=${id(4)}`);
    const c = await grok.getConversation(BASIC);
    expect(text(c.messages[1])).toContain('3. Orange');
    expect(text(c.branches[0]?.messages[0])).toContain('3. Cherry');
  });

  it('keeps reasoning steps as a thinking block', async () => {
    const { grok } = adapter();
    const c = await grok.getConversation(BASIC);
    expect(c.messages[1]?.blocks[0]).toEqual({
      type: 'thinking',
      markdown:
        '**Thinking about your request**\n\n**Generating the requested response with formatting**',
    });
  });

  it('downloads uploads from assets.grok.com by key', async () => {
    const { grok } = adapter();
    const c = await grok.getConversation(UPLOADS);
    const files = c.messages[0]?.attachments ?? [];
    expect(files.map((a) => [a.name, a.mime, a.size, a.origin])).toEqual([
      ['fruit-prices.pdf', 'application/pdf', 621, 'user-upload'],
      [
        'meeting-notes.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        1317,
        'user-upload',
      ],
      ['stripes.png', 'image/png', expect.any(Number), 'user-upload'],
    ]);
    expect(files[0]?.source).toEqual({
      kind: 'url',
      url: `https://assets.grok.com/users/${id(0x13)}/${id(0x10)}/content`,
    });
    expect(files.every((a) => a.note === undefined)).toBe(true);
  });

  it('saves a generated image once, without the card tag in the text', async () => {
    const { grok } = adapter();
    const c = await grok.getConversation(IMAGE);
    const answer = c.messages[1];
    expect(text(answer)).toBe('');
    expect(answer?.blocks.some((b) => b.type === 'unreadable')).toBe(false);
    expect(answer?.attachments).toEqual([
      {
        id: `${id(0x17)}:file:0`,
        name: 'image.jpg',
        mime: 'image/jpeg',
        size: 78058,
        origin: 'image',
        source: {
          kind: 'url',
          url: `https://assets.grok.com/users/${id(0x13)}/generated/${id(0x18)}/image.jpg`,
        },
      },
    ]);
  });

  it('asks for every response of the tree in one call', async () => {
    const { grok, server } = adapter();
    await grok.getConversation(BASIC);
    const load = server.calls.find((c) => c.path.endsWith('/load-responses'));
    expect(load?.method).toBe('POST');
    expect(load?.body).toEqual({ responseIds: [id(2), id(4), id(5)] });
  });

  it('names the field when the format changes', async () => {
    const server = grokServer(all);
    const broken: typeof server.fetchFn = (url, init) =>
      url.includes('conversations_v2')
        ? Promise.resolve(new Response(JSON.stringify({ conversation: { title: 'x' } })))
        : server.fetchFn(url, init);
    const grok = new GrokAdapter(broken, () => ORIGIN, ORIGIN);
    const error = await grok.getConversation(BASIC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformFormatError);
    expect((error as PlatformFormatError).path).toBe(
      'conversations_v2.conversation.conversationId',
    );
  });
});

describe('GrokAdapter.listConversations', () => {
  it('stops after the current page when asked', async () => {
    const { grok, server } = adapter();
    const list = await grok.listConversations(undefined, () => true);
    expect(server.calls).toHaveLength(1);
    expect(list.incomplete).toEqual({ loaded: list.conversations.length, stopped: true });
  });

  it('follows page tokens, keeps each chat once, with dates and project', async () => {
    const { grok, server } = adapter();
    const list = (await grok.listConversations()).conversations;
    expect(server.calls.map((c) => c.path)).toEqual([
      '/rest/app-chat/conversations?pageSize=60',
      '/rest/app-chat/conversations?pageSize=60&pageToken=NEXT_PAGE_TOKEN',
      '/rest/workspaces?pageSize=50&orderBy=ORDER_BY_LAST_USE_TIME&kind=WORKSPACE_KIND_ALL',
      `/rest/app-chat/conversations?pageSize=60&workspaceId=${WORKSPACE}`,
    ]);
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({
      id: IMAGE,
      platform: 'grok',
      createdAt: '2026-10-13T20:20:02.262Z',
      url: `${ORIGIN}/c/${IMAGE}`,
    });
    // The list leaves the project out; each project's own list names it.
    expect(list.find((c) => c.id === UPLOADS)?.project).toBe('Photo book');
    expect(list.filter((c) => c.project)).toHaveLength(1);
  });

  it('keeps the list when the projects cannot be read', async () => {
    const server = grokServer(all, { workspaces: false });
    const list = (await new GrokAdapter(server.fetchFn, () => '', ORIGIN).listConversations())
      .conversations;
    expect(list).toHaveLength(4);
    expect(list.some((c) => c.project)).toBe(false);
  });
});

describe('GrokAdapter projects', () => {
  it('lists projects with their dates and page', async () => {
    expect(await adapter().grok.listProjects()).toEqual([
      {
        id: WORKSPACE,
        platform: 'grok',
        name: 'Photo book',
        description: '',
        createdAt: '2026-10-16T07:46:16.263051Z',
        updatedAt: '2026-10-16T07:48:15.787924Z',
        url: `${ORIGIN}/project/${WORKSPACE}`,
      },
    ]);
  });

  it('reads a project with its files from assets.grok.com and its chats', async () => {
    const project = await adapter().grok.getProject(WORKSPACE);
    expect(project).toMatchObject({ name: 'Photo book', instructions: '', knowledgeCount: 1 });
    expect(project.knowledge).toEqual([
      {
        id: id(0xc1),
        name: 'contest-rules.pdf',
        mime: 'application/pdf',
        size: 2048,
        origin: 'project-knowledge',
        source: {
          kind: 'url',
          url: `https://assets.grok.com/users/${id(0xd0)}/${id(0xc1)}/content`,
        },
      },
    ]);
    expect(project.conversations.map((c) => [c.id, c.project])).toEqual([[UPLOADS, 'Photo book']]);
  });

  it('takes instructions when Grok gives them', async () => {
    const server = grokServer(all);
    const base = server.fetchFn;
    const withInstructions: typeof base = (url, init) =>
      url.endsWith(`/rest/workspaces/${WORKSPACE}`)
        ? Promise.resolve(
            Response.json({
              ...(fixture('workspace.json') as object),
              customPersonality: ' Answer in one sentence. ',
            }),
          )
        : base(url, init);
    const project = await new GrokAdapter(withInstructions, () => '', ORIGIN).getProject(WORKSPACE);
    expect(project.instructions).toBe('Answer in one sentence.');
  });

  it('says a project that is gone is not there', async () => {
    await expect(adapter().grok.getProject(id(0xff))).rejects.toThrow(/no conversation/);
  });

  it('names the project of a project page and of a chat open in it', async () => {
    expect(await adapter(`${ORIGIN}/project/${WORKSPACE}`).grok.getCurrentProject()).toEqual({
      id: WORKSPACE,
      name: 'Photo book',
    });
    expect(await adapter(`${ORIGIN}/c/${BASIC}`).grok.getCurrentProject()).toBeNull();
  });
});

describe('cleanAnswer', () => {
  it('drops image and citation cards, reports others', () => {
    expect(
      cleanAnswer(
        'A<grok:render card_id="1" card_type="citation_card" type="render_inline_citation"><argument name="citation_id">0</argument></grok:render> b\n\n<grok:render card_id="2" card_type="studio_card" type="render_studio"></grok:render>',
      ),
    ).toEqual({ markdown: 'A b', unknownCards: ['studio_card'] });
  });
});
