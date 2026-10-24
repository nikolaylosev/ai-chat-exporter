import { describe, expect, it } from 'vitest';
import { selectMessages, type Conversation, type Message } from '../../src/model/conversation';
import { outline } from '../../src/background/outline';
import { renderMarkdown } from '../../src/render/markdown';
import { renderJson } from '../../src/render/json';
import { LABELS } from '../render/labels';

const message = (id: string, role: Message['role'], markdown: string, files: string[] = []) => ({
  id,
  role,
  createdAt: '2026-10-24T10:00:00Z',
  blocks: [{ type: 'text' as const, markdown }],
  attachments: files.map((name) => ({
    id: `${id}-${name}`,
    name,
    origin: 'user-upload' as const,
    source: { kind: 'url' as const, url: `https://x.test/${name}` },
  })),
});

const chat: Conversation = {
  id: 'c1',
  platform: 'claude',
  title: 'Trip',
  createdAt: '2026-10-24T10:00:00Z',
  updatedAt: '2026-10-24T11:00:00Z',
  url: 'https://claude.ai/chat/c1',
  messages: [
    message('m1', 'user', 'Plan a **trip** to [Rome](https://rome.example)', ['map.pdf']),
    message('m2', 'assistant', '# Day 1\n\n```js\nconst a = 1;\n```\nSee the Colosseum.'),
    message('m3', 'user', 'And day 2?'),
    message('m4', 'assistant', 'Day 2: the Vatican.', ['tickets.png']),
  ],
  branches: [{ forkAfterMessageId: 'm2', messages: [message('b1', 'user', 'Other')] }],
};

const options = {
  labels: LABELS,
  includeThinking: true,
  includeToolCalls: true,
  toolCallDetail: 'compact' as const,
  includeBranches: true,
  exportedAt: new Date('2026-10-24T12:00:00Z'),
  createdSource: 'platform' as const,
};

describe('selectMessages', () => {
  it('keeps the chosen messages in the chat order, with their files, and no other branch', () => {
    const chosen = selectMessages(chat, ['m4', 'm1']);
    expect(chosen.messages.map((m) => m.id)).toEqual(['m1', 'm4']);
    expect(chosen.messages[1]?.attachments.map((a) => a.name)).toEqual(['tickets.png']);
    expect(chosen.branches).toEqual([]);
    expect(chosen.selection).toEqual({ total: 4 });
    expect(chat.messages).toHaveLength(4);
  });

  it('says in the note how many of the chat it holds', () => {
    const md = renderMarkdown(selectMessages(chat, ['m3', 'm4']), options);
    expect(md).toContain('message_count: 2\nchosen_from: 4\n');
    expect(md).toContain("# Trip\n\n*2 of the chat's 4 messages*\n");
    expect(md).not.toContain('Plan a');
    expect(md).not.toContain('Other branches');
    expect(renderMarkdown(chat, options)).not.toContain('chosen_from');
  });

  it('records it in JSON as well', () => {
    const json = JSON.parse(
      renderJson(selectMessages(chat, ['m1']), { ...options, includeBranches: true }),
    ) as { conversation: { chosenFrom?: number; messages: unknown[] } };
    expect(json.conversation.chosenFrom).toBe(4);
    expect(json.conversation.messages).toHaveLength(1);
  });
});

describe('outline', () => {
  it('lists each message with its role, a plain preview and its files', () => {
    const list = outline(chat);
    expect(list.title).toBe('Trip');
    expect(list.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(list.messages[0]).toMatchObject({ preview: 'Plan a trip to Rome', files: ['map.pdf'] });
    expect(list.messages[1]?.preview).toBe('Day 1 [code] See the Colosseum.');
  });

  it('cuts a long text', () => {
    const long = outline({ ...chat, messages: [message('x', 'user', 'word '.repeat(200))] });
    const preview = long.messages[0]?.preview ?? '';
    expect(preview.length).toBe(400);
    expect(preview.endsWith('…')).toBe(true);
  });
});
