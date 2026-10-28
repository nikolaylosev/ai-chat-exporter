// @vitest-environment happy-dom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Conversation } from '../../src/model/conversation';
import { renderDocx } from '../../src/render/docx';
import { renderHtml } from '../../src/render/html';
import { renderJson } from '../../src/render/json';
import { renderMarkdown } from '../../src/render/markdown';
import { parseNote } from '../../src/search/archive';
import { headingRole, mayBeNote, plainText } from '../../src/search/notes';
import { LABELS } from '../render/labels';

const chat: Conversation = {
  id: 'c1',
  platform: 'claude',
  title: 'Trip to Rome',
  createdAt: '2026-10-24T10:00:00Z',
  updatedAt: '2026-10-24T11:00:00Z',
  url: 'https://claude.ai/chat/c1',
  project: 'Travel',
  messages: [
    {
      id: 'm1',
      role: 'user',
      createdAt: '2026-10-24T10:00:00Z',
      blocks: [{ type: 'text', markdown: 'Plan a **trip** to [Rome](https://rome.example)' }],
      attachments: [],
    },
    {
      id: 'm2',
      role: 'assistant',
      createdAt: '2026-10-24T10:01:00Z',
      blocks: [
        { type: 'thinking', markdown: 'Colosseum first.' },
        { type: 'text', markdown: '## Day 1\n\n```js\nconst ticket = 1;\n```\n\nSee the Vatican.' },
      ],
      attachments: [],
    },
  ],
  branches: [
    {
      forkAfterMessageId: 'm1',
      messages: [
        {
          id: 'b1',
          role: 'assistant',
          createdAt: null,
          blocks: [{ type: 'text', markdown: 'Or Florence.' }],
          attachments: [],
        },
      ],
    },
  ],
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
const markdown = renderMarkdown(chat, options);

describe('notes read back', () => {
  it.each([
    ['Markdown', 'Chat.md', strToU8(markdown)],
    ['HTML', 'Chat.html', strToU8(renderHtml(markdown, chat.title))],
    ['Word', 'Chat.docx', renderDocx(markdown, chat.title, () => undefined)],
  ])('%s: the properties and every message with its role', (_format, name, bytes) => {
    const note = parseNote(name, bytes);
    expect(note).toMatchObject({
      title: 'Trip to Rome',
      platform: 'claude',
      url: 'https://claude.ai/chat/c1',
      project: 'Travel',
    });
    expect(note?.created).toMatch(/^2026-10-24/);
    expect(note?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(note?.messages[0]?.text).toContain('Plan a trip to Rome');
    expect(note?.messages[0]?.text).not.toContain('https://rome.example');
    expect(note?.messages[1]?.text).toContain('Colosseum first.');
    expect(note?.messages[1]?.text).toContain('const ticket = 1;');
    expect(note?.messages[1]?.text).toContain('See the Vatican.');
    // The branch's message, after the "Other branches" heading, which is not a message.
    expect(note?.messages[2]?.text).toBe('Or Florence.');
    expect(note?.messages.some((m) => m.text.includes('Other branches'))).toBe(false);
  });

  it('JSON: the conversation as it was', () => {
    const note = parseNote('Chat.json', strToU8(renderJson(chat, options)));
    expect(note?.title).toBe('Trip to Rome');
    expect(note?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(note?.messages[1]?.text).toContain('See the Vatican.');
  });

  it('skips files that are not the extension notes', () => {
    expect(parseNote('notes.md', strToU8('# Just a note\n\nText.'))).toBeNull();
    expect(parseNote('notes.md', strToU8('---\ntitle: x\n---\n## User\n\nhi'))).toBeNull();
    expect(parseNote('data.json', strToU8('{"a":1}'))).toBeNull();
    expect(parseNote('broken.json', strToU8('{'))).toBeNull();
    expect(parseNote('page.html', strToU8('<p>hi</p>'))).toBeNull();
    expect(
      parseNote('other.docx', zipSync({ 'word/document.xml': strToU8('<w:document/>') })),
    ).toBeNull();
    expect(parseNote('photo.png', new Uint8Array(4))).toBeNull();
  });

  it('knows message headings in both languages and where notes may be', () => {
    expect(headingRole('User · 2026-10-24 10:00')).toEqual({
      role: 'user',
      time: '2026-10-24 10:00',
    });
    expect(headingRole('Пользователь')).toEqual({ role: 'user', time: null });
    expect(headingRole('ChatGPT · 10:00')?.role).toBe('assistant');
    expect(headingRole('Day 1')).toBeNull();
    expect(mayBeNote('Chat - 2026 (Claude)/Chat - 2026 (Claude).md')).toBe(true);
    expect(mayBeNote('Chat/files/readme.md')).toBe(false);
    expect(mayBeNote('Projects/P/knowledge/spec.docx')).toBe(false);
    expect(mayBeNote('_reports/export-report.md')).toBe(false);
    expect(mayBeNote('.obsidian/workspace.json')).toBe(false);
    expect(mayBeNote('Chat/photo.png')).toBe(false);
  });

  it('makes Markdown plain', () => {
    expect(plainText('> [!note]- Thinking\n> **bold** and `code` [link](x)')).toBe(
      'Thinking\nbold and code link',
    );
  });
});
