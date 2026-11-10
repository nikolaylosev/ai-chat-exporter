import { describe, expect, it } from 'vitest';
import {
  keepLine,
  mergeNote,
  obsidianUri,
  parseVaultRules,
  relativePath,
  vaultSafeName,
} from '../../src/obsidian/vault';

describe('parseVaultRules', () => {
  it("uses Obsidian's defaults without the file or with a broken one", () => {
    const defaults = {
      name: 'Notes',
      attachments: { kind: 'chat' },
      wiki: true,
      linkFormat: 'shortest',
    };
    expect(parseVaultRules('Notes', null)).toEqual(defaults);
    expect(parseVaultRules('Notes', '{not json')).toEqual(defaults);
    expect(parseVaultRules('Notes', '{"attachmentFolderPath":"/"}')).toEqual(defaults);
  });

  it.each([
    ['./', { kind: 'beside' }],
    ['.', { kind: 'beside' }],
    ['./attachments', { kind: 'beside-sub', dir: 'attachments' }],
    ['./a/../b/', { kind: 'beside-sub', dir: 'a/b' }],
    ['Attachments', { kind: 'shared', dir: 'Attachments' }],
    ['/Meta/Files/', { kind: 'shared', dir: 'Meta/Files' }],
  ])('reads attachmentFolderPath %s', (path, place) => {
    expect(
      parseVaultRules('V', JSON.stringify({ attachmentFolderPath: path })).attachments,
    ).toEqual(place);
  });

  it('reads the link settings', () => {
    const rules = parseVaultRules(
      'V',
      JSON.stringify({ useMarkdownLinks: true, newLinkFormat: 'relative' }),
    );
    expect(rules).toMatchObject({ wiki: false, linkFormat: 'relative' });
    expect(parseVaultRules('V', '{"newLinkFormat":"odd"}').linkFormat).toBe('shortest');
  });
});

describe('paths and links', () => {
  it('replaces what breaks a wikilink', () => {
    expect(vaultSafeName('C# [draft] a|b ^1.png')).toBe('C_ _draft_ a_b _1.png');
  });

  it('makes relative paths between vault folders', () => {
    expect(relativePath('AI Chats/Claude/Chat', 'AI Chats/Claude/Chat/files/a.png')).toBe(
      'files/a.png',
    );
    expect(relativePath('AI Chats/Claude/Chat', 'Attachments/Chat/a.png')).toBe(
      '../../../Attachments/Chat/a.png',
    );
    expect(relativePath('', 'a.png')).toBe('a.png');
  });

  it('opens a note in its vault', () => {
    expect(obsidianUri('My Vault', 'AI Chats/Claude/Chat - 2026-11-10/Chat - 2026-11-10.md')).toBe(
      'obsidian://open?vault=My%20Vault&file=AI%20Chats%2FClaude%2FChat%20-%202026-11-10%2FChat%20-%202026-11-10.md',
    );
  });
});

describe('mergeNote', () => {
  const keep = keepLine('Write below this line.');
  const note = (frontmatter: string, body: string, own = '') =>
    `---\n${frontmatter}\n---\n# Chat\n\n${body}\n\n## My notes\n\n${keep}\n${own}`;

  it('is the fresh note when nothing was there', () => {
    const fresh = note('title: "Chat"\ntags: [ai-chat, claude]', 'New answer');
    expect(mergeNote(fresh, null)).toBe(fresh);
  });

  it("keeps the user's properties, tags and notes, and takes the chat as it is now", () => {
    const before = note(
      'title: "Old title"\ntags:\n  - ai-chat\n  - claude\n  - work\naliases:\n  - The chat\nrating: 5',
      'Old answer, edited by hand',
      'My thought.\n\n- [ ] follow up\n',
    );
    const fresh = note('title: "Chat"\nmessage_count: 4\ntags: [ai-chat, claude]', 'New answer');
    const merged = mergeNote(fresh, before);
    expect(merged).toBe(
      `---\ntitle: "Chat"\nmessage_count: 4\ntags: [ai-chat, claude, work]\naliases:\n  - The chat\nrating: 5\n---\n# Chat\n\nNew answer\n\n## My notes\n\n${keep}\nMy thought.\n\n- [ ] follow up\n`,
    );
    // Saving again changes nothing more.
    expect(mergeNote(fresh, merged)).toBe(merged);
  });

  it('finds the keep line in any language', () => {
    const before = `---\ntitle: x\n---\n%% ai-chat-exporter:keep Пишите ниже этой строки. %%\nМоё.\n`;
    expect(mergeNote(note('title: x', 'A'), before)).toMatch(/\nМоё\.\n$/);
  });

  it('keeps a note without frontmatter or keep line as the fresh one', () => {
    const fresh = note('title: x', 'A');
    expect(mergeNote(fresh, 'Something the user wrote')).toBe(fresh);
  });
});
