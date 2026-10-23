import { describe, expect, it } from 'vitest';
import type { Conversation } from '../../src/model/conversation';
import { JSON_FORMAT, renderJson } from '../../src/render/json';

const chat: Conversation = {
  id: 'c1',
  platform: 'claude',
  title: 'A chat',
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T11:00:00Z',
  url: 'https://claude.ai/chat/c1',
  model: 'claude-opus-5-5',
  messages: [
    {
      id: 'm1',
      role: 'user',
      createdAt: '2026-10-20T10:00:00Z',
      blocks: [{ type: 'text', markdown: 'Hello' }],
      attachments: [
        {
          id: 'a1',
          name: 'report.pdf',
          mime: 'application/pdf',
          size: 900,
          origin: 'user-upload',
          source: { kind: 'url', url: 'https://example.com/signed?sig=secret' },
        },
        { id: 'a2', name: 'gone.png', origin: 'user-upload', source: null },
      ],
    },
    {
      id: 'm2',
      role: 'assistant',
      createdAt: '2026-10-20T10:01:00Z',
      blocks: [
        { type: 'thinking', markdown: 'Hmm' },
        { type: 'tool-call', name: 'Bash' },
        { type: 'text', markdown: 'Hi' },
      ],
      attachments: [],
    },
  ],
  branches: [{ forkAfterMessageId: 'm1', messages: [] }],
};

describe('renderJson', () => {
  const options = {
    includeThinking: false,
    includeToolCalls: true,
    includeBranches: false,
    exportedAt: new Date('2026-10-21T09:00:00Z'),
    attachmentPaths: new Map([['a1', 'files/report.pdf']]),
    attachmentErrors: new Map([['a2', 'not available']]),
  };
  const doc = JSON.parse(renderJson(chat, options)) as {
    format: string;
    conversation: Conversation & { messages: { blocks: unknown[]; attachments: unknown[] }[] };
  };

  it('describes the conversation with its format and dates', () => {
    expect(doc.format).toBe(JSON_FORMAT);
    expect(doc.conversation).toMatchObject({ id: 'c1', title: 'A chat', model: 'claude-opus-5-5' });
  });

  it('gives where each file was saved, or why not, never its download link', () => {
    expect(doc.conversation.messages[0]?.attachments).toEqual([
      {
        name: 'report.pdf',
        mime: 'application/pdf',
        size: 900,
        origin: 'user-upload',
        path: 'files/report.pdf',
      },
      { name: 'gone.png', origin: 'user-upload', error: 'not available' },
    ]);
    expect(renderJson(chat, options)).not.toContain('sig=secret');
  });

  it('leaves out what the settings leave out of the Markdown', () => {
    expect(doc.conversation.messages[1]?.blocks).toEqual([
      { type: 'tool-call', name: 'Bash' },
      { type: 'text', markdown: 'Hi' },
    ]);
    expect(doc.conversation.branches).toEqual([]);
  });
});
