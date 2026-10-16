import { describe, expect, it } from 'vitest';
import { normalizeConversation } from '../../src/adapters/claude/normalize';
import {
  creationDate,
  planConversationExport,
  renderConversationExport,
} from '../../src/background/conversation-export';
import type { Attachment, Conversation } from '../../src/model/conversation';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { PATH_BUDGET } from '../../src/util/filename';
import { ORG, ORIGIN, rawConversation } from '../adapters/claude/fixtures';
import { LABELS } from '../render/labels';

const now = new Date('2026-10-20T12:00:00Z');
const ctx = { now, labels: LABELS, timeZone: 'UTC' };

function fixture(name: string): Conversation {
  return normalizeConversation(rawConversation(name), { origin: ORIGIN, orgId: ORG });
}

function render(c: Conversation, settings = DEFAULT_SETTINGS): string {
  return renderConversationExport(c, settings, ctx, planConversationExport(c, settings, ctx));
}

const file = (id: string, name: string, extra: Partial<Attachment> = {}): Attachment => ({
  id,
  name,
  origin: 'user-upload',
  source: { kind: 'url', url: `https://claude.ai/f/${id}` },
  ...extra,
});

function withAttachments(attachments: Attachment[], title = 'Files'): Conversation {
  return {
    ...fixture('conversation-branches.json'),
    title,
    messages: [
      { id: 'm1', role: 'user', createdAt: '2026-10-13T09:00:00Z', blocks: [], attachments },
    ],
    branches: [],
  };
}

describe('creationDate', () => {
  const c = fixture('conversation-branches.json');

  it('prefers the platform date', () => {
    expect(creationDate(c, now)).toEqual({ date: c.createdAt, source: 'platform' });
  });

  it('falls back to the first message, then to now', () => {
    const noDate = { ...c, createdAt: null };
    expect(creationDate(noDate, now)).toEqual({
      date: c.messages[0]?.createdAt,
      source: 'first-message',
    });
    const nothing = {
      ...noDate,
      messages: noDate.messages.map((m) => ({ ...m, createdAt: null })),
    };
    expect(creationDate(nothing, now)).toEqual({ date: now, source: 'export' });
  });
});

describe('planConversationExport: folder', () => {
  it('names the folder after title, creation date and platform', () => {
    const plan = planConversationExport(
      fixture('conversation-branches.json'),
      DEFAULT_SETTINGS,
      ctx,
    );
    expect(plan.root).toEqual(['AI Chats']);
    expect(plan.folderPath).toBe('Fruit naming test - 2026-10-13 (Claude)');
    expect(plan.markdownPath).toBe(
      'Fruit naming test - 2026-10-13 (Claude)/Fruit naming test - 2026-10-13 (Claude).md',
    );
    expect(plan.files).toEqual([]);
  });

  it('follows the folder settings', () => {
    const plan = planConversationExport(
      fixture('conversation-branches.json'),
      { ...DEFAULT_SETTINGS, rootFolder: 'Archive/AI', includePlatformInFolderName: false },
      ctx,
    );
    expect(plan.root).toEqual(['Archive', 'AI']);
    expect(plan.folderPath).toBe('Fruit naming test - 2026-10-13');
  });
});

describe('planConversationExport: files', () => {
  it('puts every attachment under files/ with unique names', () => {
    const c = withAttachments([
      file('a', 'image.png'),
      file('b', 'image.png'),
      file('c', 'notes', {
        note: 'extracted-text-only',
        source: { kind: 'text', text: 'x', mime: 'text/plain' },
      }),
      file('d', 'Report.PDF'),
      file('e', 'report.pdf'),
    ]);
    const plan = planConversationExport(c, DEFAULT_SETTINGS, ctx);
    expect(plan.files.map((f) => f.link)).toEqual([
      'files/image.png',
      'files/image-2.png',
      'files/notes.extracted.txt',
      'files/Report.PDF',
      'files/report-2.pdf',
    ]);
    expect(plan.files[0]?.path).toBe('Files - 2026-10-13 (Claude)/files/image.png');
  });

  it('includes attachments from other branches only when they are exported', () => {
    const c = fixture('conversation-attachments.json');
    c.branches = [
      {
        forkAfterMessageId: null,
        messages: [
          {
            id: 'b',
            role: 'user',
            createdAt: null,
            blocks: [],
            attachments: [file('z', 'branch.txt')],
          },
        ],
      },
    ];
    const links = (settings = DEFAULT_SETTINGS) =>
      planConversationExport(c, settings, ctx).files.map((f) => f.link);
    expect(links()).not.toContain('files/branch.txt');
    expect(links({ ...DEFAULT_SETTINGS, claudeBranches: 'all' })).toContain('files/branch.txt');
  });

  it('plans no files when attachments are turned off', () => {
    const c = withAttachments([file('a', 'a.pdf')]);
    const settings = { ...DEFAULT_SETTINGS, saveAttachments: false };
    expect(planConversationExport(c, settings, ctx).files).toEqual([]);
  });

  it('shortens the title first, then file names, to fit the path budget', () => {
    const longName = `${'very long attachment name '.repeat(6)}.pdf`;
    const c = withAttachments(
      [file('a', longName), file('b', longName)],
      'A title that is long enough to be shortened when needed',
    );
    const plan = planConversationExport(c, DEFAULT_SETTINGS, ctx);
    for (const f of plan.files) {
      expect(`AI Chats/${f.path}`.length).toBeLessThanOrEqual(PATH_BUDGET);
      expect(f.link.endsWith('.pdf')).toBe(true);
    }
    expect(new Set(plan.files.map((f) => f.link)).size).toBe(2);
  });
});

describe('renderConversationExport', () => {
  it('includes branches only when the settings say so', () => {
    const c = fixture('conversation-branches.json');
    expect(render(c)).not.toContain('Other branches');
    const all = render(c, { ...DEFAULT_SETTINGS, claudeBranches: 'all' });
    expect(all).toContain('## Other branches');
    expect(all).toContain('Mango.');
  });

  it.each([
    'conversation-branches.json',
    'conversation-attachments.json',
    'conversation-artifact.json',
    'conversation-generated-files.json',
    'conversation-in-project.json',
  ])('renders %s into valid Obsidian Markdown', (name) => {
    const markdown = render(fixture(name), { ...DEFAULT_SETTINGS, saveThinking: true });
    const [, frontmatter, body] = markdown.split(/^---$/m);
    expect(frontmatter).toMatch(/^\ntitle: ".+"\nplatform: claude\n/);
    expect(frontmatter).toContain('\ntags: [ai-chat, claude]\n');
    expect(body).toMatch(/^\n\n# .+\n\n## User · 2026-10-13 \d\d:\d\d\n/);
    for (const block of body?.split('\n\n') ?? []) {
      if (block.startsWith('> [!')) {
        expect(block.split('\n').every((l) => l.startsWith('>'))).toBe(true);
      }
    }
    expect(((body ?? '').match(/^`{3,}/gm) ?? []).length % 2).toBe(0);
  });
});
