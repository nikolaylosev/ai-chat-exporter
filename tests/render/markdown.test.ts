import { describe, expect, it } from 'vitest';
import type { Conversation } from '../../src/model/conversation';
import { closeFences, renderMarkdown, type RenderOptions } from '../../src/render/markdown';
import { LABELS } from './labels';

const base: RenderOptions = {
  labels: LABELS,
  includeThinking: true,
  includeToolCalls: true,
  toolCallDetail: 'compact',
  includeBranches: false,
  exportedAt: new Date('2026-10-13T09:10:00Z'),
  createdSource: 'platform',
  timeZone: 'Asia/Yekaterinburg',
};

const conversation: Conversation = {
  id: 'c1',
  platform: 'claude',
  title: 'How to "export" chats',
  createdAt: '2026-10-13T07:41:00Z',
  updatedAt: '2026-10-13T08:02:00Z',
  url: 'https://claude.ai/chat/c1',
  model: 'claude-opus-5-5',
  messages: [
    {
      id: 'm1',
      role: 'user',
      createdAt: '2026-10-13T07:41:00Z',
      blocks: [{ type: 'text', markdown: 'Save my chats.' }],
      attachments: [
        { id: 'a1', name: 'notes (1).pdf', origin: 'user-upload', source: null },
        { id: 'a2', name: 'chart.png', origin: 'image', source: null },
        { id: 'a3', name: 'data.csv', origin: 'user-upload', source: null },
      ],
    },
    {
      id: 'm2',
      role: 'assistant',
      createdAt: '2026-10-13T07:42:00Z',
      blocks: [
        { type: 'thinking', markdown: 'Plan:\n\n1. search' },
        {
          type: 'web-search',
          query: 'obsidian import',
          results: [{ title: 'Docs [v2]', url: 'https://example.com/a' }],
        },
        {
          type: 'tool-call',
          name: 'Bash',
          label: 'Ran a command',
          input: '{\n  "command": "ls"\n}',
          output: 'a.txt',
        },
        { type: 'text', markdown: 'Here is how:\n\n```js\nconsole.log(1)\n```\n' },
        { type: 'tool-call', name: 'Write', isError: true },
      ],
      attachments: [],
    },
  ],
  branches: [],
};

describe('renderMarkdown', () => {
  it('renders frontmatter, headings, callouts and attachments', () => {
    const md = renderMarkdown(conversation, {
      ...base,
      attachmentPaths: new Map([['a1', 'files/notes (1).pdf']]),
      attachmentErrors: new Map([['a3', 'HTTP 404']]),
    });
    expect(md).toBe(`---
title: "How to \\"export\\" chats"
platform: claude
conversation_id: "c1"
url: "https://claude.ai/chat/c1"
created: 2026-10-13T12:41:00+05:00
updated: 2026-10-13T13:02:00+05:00
created_source: platform
exported: 2026-10-13T14:10:00+05:00
model: "claude-opus-5-5"
project: null
message_count: 2
attachments: 3
tags: [ai-chat, claude]
---

# How to "export" chats

## User · 2026-10-13 12:41

Save my chats.

**Attachments:**
- [notes (1).pdf](files/notes%20%281%29.pdf)
- chart.png
- ⚠️ data.csv — could not download: HTTP 404

## Claude · 2026-10-13 12:42

> [!note]- Thinking
> Plan:
>
> 1. search

> [!info]- Web search: “obsidian import”
> - [Docs \\[v2\\]](https://example.com/a)

> [!abstract]- Tools (2)
> - **Bash**: Ran a command
> - **Write** (error)

Here is how:

\`\`\`js
console.log(1)
\`\`\`
`);
  });

  it('leaves out thinking and tool calls when they are turned off', () => {
    const md = renderMarkdown(conversation, {
      ...base,
      includeThinking: false,
      includeToolCalls: false,
    });
    expect(md).not.toContain('[!note]');
    expect(md).not.toContain('[!info]');
    expect(md).not.toContain('[!abstract]');
    expect(md).toContain('Here is how:');
  });

  it('shows tool input and output in full mode with safe fences', () => {
    const withFence: Conversation = {
      ...conversation,
      messages: [
        {
          id: 'm',
          role: 'assistant',
          createdAt: null,
          blocks: [
            {
              type: 'tool-call',
              name: 'Write',
              label: 'Created a file',
              input: '{"x":1}',
              output: 'has ``` inside',
            },
          ],
          attachments: [],
        },
      ],
    };
    const md = renderMarkdown(withFence, { ...base, toolCallDetail: 'full' });
    expect(md).toContain(`> [!abstract]- Tools (1)
> **Write**: Created a file
>
> \`\`\`json
> {"x":1}
> \`\`\`
>
> \`\`\`\`
> has \`\`\` inside
> \`\`\`\``);
    expect(md).toContain('## Claude\n');
  });

  it('uses the export time when the platform has no date', () => {
    const md = renderMarkdown(
      { ...conversation, createdAt: null },
      { ...base, createdSource: 'export' },
    );
    expect(md).toContain('created: 2026-10-13T14:10:00+05:00\n');
    expect(md).toContain('created_source: export\n');
  });

  it('falls back to Untitled and quotes the project', () => {
    const md = renderMarkdown({ ...conversation, title: '', project: 'Proj: "A"' }, base);
    expect(md).toContain('title: "Untitled"\n');
    expect(md).toContain('# Untitled\n');
    expect(md).toContain('project: "Proj: \\"A\\""\n');
  });

  it('renders other branches only when asked', () => {
    const withBranches: Conversation = {
      ...conversation,
      branches: [
        {
          forkAfterMessageId: 'm1',
          messages: [
            {
              id: 'b1',
              role: 'assistant',
              createdAt: null,
              blocks: [{ type: 'text', markdown: 'Alt answer' }],
              attachments: [],
            },
          ],
        },
        {
          forkAfterMessageId: null,
          messages: [
            {
              id: 'b2',
              role: 'user',
              createdAt: null,
              blocks: [{ type: 'text', markdown: 'Alt start' }],
              attachments: [],
            },
          ],
        },
        {
          forkAfterMessageId: 'b2',
          messages: [
            {
              id: 'b3',
              role: 'assistant',
              createdAt: null,
              blocks: [{ type: 'text', markdown: 'Deep' }],
              attachments: [],
            },
          ],
        },
      ],
    };
    expect(renderMarkdown(withBranches, base)).not.toContain('Other branches');
    const md = renderMarkdown(withBranches, { ...base, includeBranches: true });
    expect(md).toContain(
      '## Other branches\n\n### Branch 2, after message 1\n\n#### Claude\n\nAlt answer\n\n### Branch 3, from the start\n\n#### User\n\nAlt start\n\n### Branch 4, after message 1 of branch 3\n\n#### Claude\n\nDeep\n',
    );
  });
});

describe('code fences a reply leaves open', () => {
  it('are closed at the end of the text, with the fence that opened them', () => {
    expect(closeFences('Here:\n```js\nconst a = 1;')).toBe('Here:\n```js\nconst a = 1;\n```');
    expect(closeFences('````md\n```js\nx\n```')).toBe('````md\n```js\nx\n```\n````');
    expect(closeFences('~~~\nx')).toBe('~~~\nx\n~~~');
  });

  it('leave closed fences alone', () => {
    const text = 'a\n```\nb\n```\nc\n````\n```\n````';
    expect(closeFences(text)).toBe(text);
  });

  it('do not swallow the next message', () => {
    const md = renderMarkdown(
      {
        ...conversation,
        messages: [
          {
            ...conversation.messages[0]!,
            blocks: [{ type: 'text', markdown: 'Run:\n```sh\nls' }],
            attachments: [],
          },
          {
            ...conversation.messages[0]!,
            id: 'm9',
            blocks: [{ type: 'text', markdown: 'Next.' }],
            attachments: [],
          },
        ],
      },
      base,
    );
    expect(md).toMatch(/ls\n```\n\n## /);
  });
});

describe('a chat read only partly', () => {
  it('says at the top that its oldest messages are missing', () => {
    const md = renderMarkdown({ ...conversation, incomplete: true }, base);
    expect(md).toMatch(/\n# How to "export" chats\n\n> ⚠️ The oldest messages are missing\.\n/);
    expect(renderMarkdown(conversation, base)).not.toContain('oldest messages');
  });
});
