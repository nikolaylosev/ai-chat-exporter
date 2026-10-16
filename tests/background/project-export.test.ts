import { describe, expect, it } from 'vitest';
import type { Attachment } from '../../src/model/conversation';
import {
  chatParents,
  moveProject,
  planProjectExport,
  renderProjectMarkdown,
  type ProjectLabels,
  type ProjectNote,
} from '../../src/background/project-export';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

const file = (id: string, name: string): Attachment => ({
  id,
  name,
  origin: 'project-knowledge',
  source: { kind: 'url', url: `https://claude.ai/files/${id}` },
});

const labels: ProjectLabels = {
  untitled: 'Untitled project',
  untitledChat: 'Untitled',
  description: 'Description',
  instructions: 'Project instructions',
  knowledge: 'Knowledge base files',
  chats: 'Chats',
  noKnowledge: 'No files.',
  noChats: 'No chats.',
  fileFailed: (r) => `could not download: ${r}`,
  chatFailed: (r) => `could not save: ${r}`,
};

describe('planProjectExport', () => {
  it('puts the project under Projects/ with knowledge/ and chats/', () => {
    const plan = planProjectExport(
      { name: 'Session: Lens?', knowledge: [file('a', 'spec.pdf'), file('b', 'spec.pdf')] },
      DEFAULT_SETTINGS,
      'Untitled project',
    );
    expect(plan.root).toEqual(['AI Chats']);
    expect(plan.folderPath).toBe('Projects/Session_ Lens_ (Claude)');
    expect(plan.markdownPath).toBe('Projects/Session_ Lens_ (Claude)/Session_ Lens_ (Claude).md');
    expect(plan.knowledge.map((k) => k.link)).toEqual([
      'knowledge/spec.pdf',
      'knowledge/spec-2.pdf',
    ]);
    expect(chatParents(plan)).toEqual(['Projects', 'Session_ Lens_ (Claude)', 'chats']);
  });

  it('uses the chosen folder as the root and leaves the platform out when asked', () => {
    const plan = planProjectExport(
      { name: 'P', knowledge: [] },
      { ...DEFAULT_SETTINGS, destination: 'folder', includePlatformInFolderName: false },
      'Untitled project',
    );
    expect(plan.root).toEqual([]);
    expect(plan.folderPath).toBe('Projects/P');
  });

  it('renames the note with the folder', () => {
    const plan = planProjectExport(
      { name: 'P', knowledge: [file('a', 'x.pdf')] },
      DEFAULT_SETTINGS,
      '',
    );
    const moved = moveProject(plan, 'Projects/P (Claude) (2)');
    expect(moved.markdownPath).toBe('Projects/P (Claude) (2)/P (Claude) (2).md');
    expect(moved.knowledge[0]?.path).toBe('Projects/P (Claude) (2)/knowledge/x.pdf');
    expect(moved.knowledge[0]?.link).toBe('knowledge/x.pdf');
  });
});

describe('renderProjectMarkdown', () => {
  const note: ProjectNote = {
    id: 'p1',
    name: 'SessionLens',
    description: 'Short description.',
    instructions: 'Answer briefly.',
    url: 'https://claude.ai/project/p1',
    createdAt: '2026-09-01T05:00:00Z',
    updatedAt: '2026-10-08T13:30:00Z',
    knowledge: [
      { name: 'spec (v2).pdf', link: 'knowledge/spec (v2).pdf' },
      { name: 'data.xlsx', error: 'not found on the server' },
    ],
    chats: [
      {
        id: 'c1',
        title: 'Plan',
        url: 'https://claude.ai/chat/c1',
        link: 'chats/Plan - 2026-10-01 (Claude)/Plan - 2026-10-01 (Claude).md',
      },
      { id: 'c2', title: 'Broken', url: 'https://claude.ai/chat/c2', error: 'HTTP 500' },
      { id: 'c3', title: 'Later', url: 'https://claude.ai/chat/c3' },
    ],
  };

  it('writes frontmatter, sections and links', () => {
    expect(
      renderProjectMarkdown(note, labels, new Date('2026-10-13T09:10:00Z'), 'Asia/Yekaterinburg'),
    ).toBe(
      [
        '---',
        'title: "SessionLens"',
        'platform: claude',
        'type: project',
        'project_id: "p1"',
        'url: "https://claude.ai/project/p1"',
        'created: 2026-09-01T10:00:00+05:00',
        'updated: 2026-10-08T18:30:00+05:00',
        'exported: 2026-10-13T14:10:00+05:00',
        'knowledge_files: 2',
        'chats: 3',
        'tags: [ai-project, claude]',
        '---',
        '',
        '# SessionLens',
        '',
        '## Description',
        '',
        'Short description.',
        '',
        '## Project instructions',
        '',
        'Answer briefly.',
        '',
        '## Knowledge base files',
        '',
        '- [spec (v2).pdf](knowledge/spec%20%28v2%29.pdf)',
        '- ⚠️ data.xlsx — could not download: not found on the server',
        '',
        '## Chats',
        '',
        '- [Plan](chats/Plan%20-%202026-10-01%20%28Claude%29/Plan%20-%202026-10-01%20%28Claude%29.md)',
        '- ⚠️ Broken — could not save: HTTP 500',
        '- [Later](https://claude.ai/chat/c3)',
        '',
      ].join('\n'),
    );
  });

  it('leaves out empty sections and says when there is nothing', () => {
    const text = renderProjectMarkdown(
      { ...note, description: ' ', instructions: '', knowledge: [], chats: [] },
      labels,
      new Date('2026-10-13T09:10:00Z'),
      'UTC',
    );
    expect(text).not.toContain('## Description');
    expect(text).not.toContain('## Project instructions');
    expect(text).toContain('## Knowledge base files\n\nNo files.\n\n## Chats\n\nNo chats.\n');
  });
});

describe('a Gemini notebook', () => {
  it('goes under Notebooks/ with sources/ and chats/', () => {
    const plan = planProjectExport(
      { platform: 'gemini', name: 'Fruit', knowledge: [file('s1', 'fruit-prices.pdf')] },
      DEFAULT_SETTINGS,
      'Untitled notebook',
    );
    expect(plan.folderPath).toBe('Notebooks/Fruit (Gemini)');
    expect(plan.markdownPath).toBe('Notebooks/Fruit (Gemini)/Fruit (Gemini).md');
    expect(plan.knowledge[0]?.link).toBe('sources/fruit-prices.pdf');
    expect(chatParents(plan)).toEqual(['Notebooks', 'Fruit (Gemini)', 'chats']);
  });

  it('is a notebook in its note, with sources listed without a link', () => {
    const text = renderProjectMarkdown(
      {
        platform: 'gemini',
        id: 'nb1',
        name: 'Fruit',
        description: '',
        instructions: '',
        url: 'https://gemini.google.com/notebook/nb1',
        createdAt: '2026-10-01T10:00:00Z',
        updatedAt: '2026-10-02T10:00:00Z',
        knowledge: [{ name: 'fruit-prices.pdf', info: 'only its name is here' }],
        chats: [
          { id: 'c1', title: '', url: 'https://gemini.google.com/app/c1', link: 'chats/c1.md' },
        ],
      },
      {
        ...labels,
        knowledge: 'Sources',
        filesElsewhere: (n) => `In NotebookLM: https://notebooklm.google.com/notebook/${n.id}`,
      },
      new Date('2026-10-13T09:10:00Z'),
      'UTC',
    );
    expect(text).toContain('platform: gemini\ntype: notebook\nnotebook_id: "nb1"');
    expect(text).toContain('tags: [ai-notebook, gemini]');
    expect(text).toContain('sources: 1\nchats: 1');
    expect(text).toContain('- [Untitled](chats/c1.md)');
    expect(text).toContain(
      '## Sources\n\n- fruit-prices.pdf — only its name is here\n\nIn NotebookLM: https://notebooklm.google.com/notebook/nb1',
    );
    expect(text).not.toContain('⚠️');
  });
});
