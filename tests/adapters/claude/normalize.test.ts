import { describe, expect, it } from 'vitest';
import { normalizeConversation, normalizeMessage } from '../../../src/adapters/claude/normalize';
import { conversationSchema, parseMessage } from '../../../src/adapters/claude/schema';
import type { Block, Message } from '../../../src/model/conversation';
import { fixtureJson, ORG, ORIGIN, rawConversation } from './fixtures';

const ctx = { origin: ORIGIN, orgId: ORG };
const texts = (messages: Message[]) =>
  messages.map((m) => m.blocks.find((b) => b.type === 'text')?.markdown ?? '');
const toolCalls = (m: Message) =>
  m.blocks.filter((b): b is Extract<Block, { type: 'tool-call' }> => b.type === 'tool-call');

describe('conversation fixtures', () => {
  it.each([
    'conversation-branches.json',
    'conversation-attachments.json',
    'conversation-artifact.json',
    'conversation-generated-files.json',
    'conversation-in-project.json',
  ])('%s matches the schema', (name) => {
    expect(conversationSchema.safeParse(fixtureJson(name)).success).toBe(true);
  });
});

describe('normalizeConversation: branches', () => {
  const c = normalizeConversation(rawConversation('conversation-branches.json'), ctx);

  it('exports the branch the user sees as the main messages', () => {
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(texts(c.messages)).toEqual([
      'Exporter test chat (branches, edited). Reply in one short sentence: name a berry.',
      'Blueberry.',
    ]);
  });

  it('keeps other branches with their fork points', () => {
    expect(c.branches).toHaveLength(2);
    const [first, second] = c.branches;
    // The original first message is a separate branch from the root.
    expect(first?.forkAfterMessageId).toBeNull();
    expect(texts(first?.messages ?? [])).toEqual([
      'Exporter test chat (branches). Reply in one short sentence: name a fruit.',
      'Mango.',
      'Now name a vegetable, one word.',
      'Carrot.',
    ]);
    // The retried answer forks after the vegetable question of that branch.
    expect(second?.forkAfterMessageId).toBe(first?.messages[2]?.id);
    expect(texts(second?.messages ?? [])).toEqual(['Carrot.']);
  });

  it('fills conversation metadata', () => {
    expect(c).toMatchObject({
      platform: 'claude',
      title: 'Fruit naming test',
      model: 'claude-opus-5-5',
      url: `https://claude.ai/chat/${c.id}`,
      createdAt: '2026-10-13T09:10:09.372162Z',
    });
    expect(c.project).toBeUndefined();
  });

  it('falls back to the newest message when the leaf is unknown', () => {
    const raw = rawConversation('conversation-branches.json');
    raw.current_leaf_message_uuid = 'missing';
    const fallback = normalizeConversation(raw, ctx);
    expect(texts(fallback.messages).at(-1)).toBe('Blueberry.');
  });
});

describe('normalizeConversation: uploads', () => {
  const c = normalizeConversation(rawConversation('conversation-attachments.json'), ctx);

  it('skips the prepare_session service message', () => {
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('lists uploads with download URLs', () => {
    const user = c.messages[0];
    expect(user?.attachments.map((a) => [a.name, a.origin])).toEqual([
      ['meeting-notes.docx', 'user-upload'],
      ['stripes.png', 'image'],
      ['fruit-prices.pdf', 'user-upload'],
    ]);
    expect(user?.attachments[0]?.source).toEqual({
      kind: 'url',
      url: `${ORIGIN}/api/organizations/${ORG}/files/${user?.attachments[0]?.id}/contents`,
    });
    expect(user?.attachments[0]?.size).toBe(961);
  });

  it('drops empty thinking and keeps tool calls with labels', () => {
    const assistant = c.messages[1]!;
    expect(assistant.blocks.some((b) => b.type === 'thinking')).toBe(false);
    const [bash] = toolCalls(assistant);
    expect(bash).toMatchObject({ name: 'Bash', label: 'Ran a command' });
    expect(bash?.input).toContain('pdftotext');
    expect(bash?.output).toContain('Fruit prices: apple 3');
  });
});

describe('normalizeConversation: generated files and artifacts', () => {
  it('turns SendUserFile deliveries into model-generated attachments', () => {
    const c = normalizeConversation(rawConversation('conversation-generated-files.json'), ctx);
    const assistant = c.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.attachments.map((a) => [a.name, a.origin])).toEqual([
      ['exporter_test.xlsx', 'model-generated'],
      ['exporter_test.docx', 'model-generated'],
    ]);
    expect(assistant.attachments[1]?.source).toEqual({
      kind: 'url',
      url: `${ORIGIN}/api/organizations/${ORG}/files/${assistant.attachments[1]?.id}/contents`,
    });
  });

  it('keeps artifact tool calls in order', () => {
    const c = normalizeConversation(rawConversation('conversation-artifact.json'), ctx);
    const names = c.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => toolCalls(m).map((t) => t.name));
    expect(names).toEqual([
      ['Skill', 'Write', 'Artifact'],
      ['Edit', 'Artifact'],
    ]);
  });

  it('uses the project name from the context', () => {
    const c = normalizeConversation(rawConversation('conversation-in-project.json'), {
      ...ctx,
      projectName: 'Exporter Test Project',
    });
    expect(c.project).toBe('Exporter Test Project');
  });
});

describe('normalizeMessage: older chats', () => {
  const shapes = fixtureJson('legacy-block-shapes.json') as Record<string, unknown>;
  const base = {
    uuid: 'm1',
    parent_message_uuid: 'root',
    index: 1,
    created_at: '2026-05-01T10:00:00Z',
  };

  it('downloads presented files through the sandbox endpoint', () => {
    const raw = parseMessage({
      ...base,
      sender: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'present_files',
          input: { filepaths: ['/mnt/user-data/outputs/notes v2.md'] },
          message: 'Presented file',
        },
        {
          type: 'tool_result',
          tool_use_id: 't1',
          name: 'present_files',
          is_error: false,
          content: [
            {
              type: 'local_resource',
              file_path: '/mnt/user-data/outputs/notes v2.md',
              name: 'notes v2',
              mime_type: 'text/markdown',
            },
          ],
        },
      ],
    });
    const m = normalizeMessage(raw, 'conv-1', { origin: ORIGIN, orgId: ORG });
    expect(m?.attachments).toEqual([
      {
        id: 'conv-1:/mnt/user-data/outputs/notes v2.md',
        name: 'notes v2.md',
        mime: 'text/markdown',
        origin: 'model-generated',
        source: {
          kind: 'url',
          url: `${ORIGIN}/api/organizations/${ORG}/conversations/conv-1/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Fnotes+v2.md`,
        },
      },
    ]);
  });

  it('keeps a presented file whose name and type are null', () => {
    const raw = parseMessage({
      ...base,
      sender: 'assistant',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          name: 'present_files',
          is_error: null,
          file_deliveries: null,
          content: [
            {
              type: 'local_resource',
              file_path: '/mnt/user-data/outputs/report.docx',
              name: null,
              mime_type: null,
            },
          ],
        },
      ],
    });
    const m = normalizeMessage(raw, 'conv-1', { origin: ORIGIN, orgId: ORG });
    expect(m?.blocks.some((b) => b.type === 'unreadable')).toBe(false);
    expect(m?.attachments.map((a) => [a.name, a.mime])).toEqual([['report.docx', undefined]]);
  });

  it('turns web search into a block with results', () => {
    const raw = parseMessage({
      ...base,
      sender: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 's1',
          name: 'web_search',
          input: { query: 'obsidian import' },
          message: null,
        },
        shapes.search,
        { type: 'text', text: 'Found it.' },
      ].map((b, i) => (i === 1 ? { ...(b as object), tool_use_id: 's1' } : b)),
    });
    const m = normalizeMessage(raw, 'conv-1', { origin: ORIGIN, orgId: ORG });
    expect(m?.blocks[0]).toEqual({
      type: 'web-search',
      query: 'obsidian import',
      results: [
        { title: 'Example page title', url: 'https://example.com/page' },
        { title: 'Example page title', url: 'https://example.com/page' },
      ],
    });
  });

  it('keeps legacy pasted text as a text source', () => {
    const raw = parseMessage({
      ...base,
      sender: 'human',
      content: [{ type: 'text', text: 'See attached.' }],
      attachments: [
        { id: 'a1', file_name: '', file_size: 5, file_type: 'txt', extracted_content: 'hello' },
      ],
    });
    const m = normalizeMessage(raw, 'conv-1', { origin: ORIGIN, orgId: ORG });
    expect(m?.attachments).toEqual([
      {
        id: 'a1',
        name: 'pasted-text',
        size: 5,
        origin: 'user-upload',
        source: { kind: 'text', text: 'hello', mime: 'text/plain' },
        note: 'extracted-text-only',
      },
    ]);
  });

  it('skips unknown block types', () => {
    const raw = parseMessage({
      ...base,
      sender: 'assistant',
      content: [
        { type: 'future_block', data: 1 },
        { type: 'text', text: 'ok' },
      ],
    });
    expect(normalizeMessage(raw, 'c', { origin: ORIGIN, orgId: ORG })?.blocks).toEqual([
      { type: 'text', markdown: 'ok' },
    ]);
  });

  it('marks a block in an unexpected shape and keeps the rest of the message', () => {
    const raw = parseMessage({
      ...base,
      sender: 'assistant',
      content: [
        { type: 'text', text: 'Before.' },
        { type: 'tool_use', name: 'bash' },
        { type: 'text', body: 'renamed field' },
        { type: 'text', text: 'After.' },
      ],
    });
    expect(normalizeMessage(raw, 'c', { origin: ORIGIN, orgId: ORG })?.blocks).toEqual([
      { type: 'text', markdown: 'Before.' },
      { type: 'unreadable', kind: 'tool_use' },
      { type: 'text', markdown: 'After.' },
    ]);
  });

  it('reads tool results with plain-text content and no name', () => {
    const raw = parseMessage({
      ...base,
      sender: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
        { type: 'tool_result', tool_use_id: 't1', content: 'a.txt' },
      ],
    });
    expect(normalizeMessage(raw, 'c', { origin: ORIGIN, orgId: ORG })?.blocks).toEqual([
      expect.objectContaining({ type: 'tool-call', name: 'bash', output: 'a.txt' }),
    ]);
  });

  it('skips messages of other roles and odd file entries', () => {
    const system = parseMessage({ ...base, sender: 'system', content: [] });
    expect(normalizeMessage(system, 'c', { origin: ORIGIN, orgId: ORG })).toBeNull();
    const withFiles = parseMessage({
      ...base,
      sender: 'human',
      content: [{ type: 'text', text: 'Hi' }],
      files: [{ file_uuid: 'f1' }, { file_uuid: 'f2', file_name: 'a.pdf', file_kind: 'document' }],
    });
    expect(
      normalizeMessage(withFiles, 'c', { origin: ORIGIN, orgId: ORG })?.attachments.map(
        (a) => a.id,
      ),
    ).toEqual(['f2']);
  });
});

describe('lenient conversation format', () => {
  it('reads an empty conversation without a current leaf', () => {
    const raw = conversationSchema.parse({
      uuid: 'c-empty',
      name: null,
      created_at: '2026-10-13T10:00:00Z',
      updated_at: '2026-10-13T10:00:00Z',
      current_leaf_message_uuid: null,
      chat_messages: [],
    });
    const c = normalizeConversation(raw, { origin: ORIGIN, orgId: ORG });
    expect(c).toMatchObject({ id: 'c-empty', title: '', messages: [], branches: [] });
  });

  it('fills in missing indexes and parents', () => {
    const raw = conversationSchema.parse({
      uuid: 'c1',
      name: 'Chat',
      created_at: null,
      updated_at: null,
      current_leaf_message_uuid: 'm2',
      chat_messages: [
        { uuid: 'm1', sender: 'human', content: [{ type: 'text', text: 'Hi' }] },
        {
          uuid: 'm2',
          parent_message_uuid: 'm1',
          sender: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      ],
    });
    expect(raw.chat_messages.map((m) => m.index)).toEqual([0, 1]);
    const c = normalizeConversation(raw, { origin: ORIGIN, orgId: ORG });
    expect(c.messages.map((m) => m.blocks)).toEqual([
      [{ type: 'text', markdown: 'Hi' }],
      [{ type: 'text', markdown: 'Hello' }],
    ]);
    expect(c.createdAt).toBeNull();
  });
});
