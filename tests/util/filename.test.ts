import { describe, expect, it } from 'vitest';
import {
  MAX_TITLE_LENGTH,
  MIN_TITLE_LENGTH,
  PATH_BUDGET,
  conversationFolderName,
  cutGraphemes,
  fitFileNames,
  joinPath,
  planConversationFolder,
  sanitizeRelativeDir,
  sanitizeSegment,
  shortenFileName,
  splitExtension,
  truncateAtWordBoundary,
  uniqueFileNames,
} from '../../src/util/filename';

const FALLBACK = 'Untitled';

describe('sanitizeSegment', () => {
  it.each([
    // [input, expected, note]
    ['Plain title', 'Plain title', 'unchanged'],
    ['a\\b/c:d*e?f"g<h>i|j', 'a_b_c_d_e_f_g_h_i_j', 'every forbidden character'],
    [
      'Как сохранить чаты: вопрос?',
      'Как сохранить чаты_ вопрос_',
      'Cyrillic kept, : and ? replaced',
    ],
    ['Рецепт 🍕 пиццы', 'Рецепт 🍕 пиццы', 'emoji kept'],
    ['日本語のタイトル', '日本語のタイトル', 'CJK kept'],
    ['bell\u0007char', 'bell_char', 'control character'],
    ['nul\u0000byte', 'nul_byte', 'NUL character'],
    ['line\nbreak\ttab', 'line break tab', 'whitespace controls become spaces'],
    ['  many    spaces  ', 'many spaces', 'collapse and trim spaces'],
    ['...dots around...', 'dots around', 'trim dots at both ends'],
    [' . . title . . ', 'title', 'mixed dots and spaces at the edges'],
    ['v1.2 notes', 'v1.2 notes', 'inner dots kept'],
    ['', FALLBACK, 'empty'],
    ['   ', FALLBACK, 'only spaces'],
    ['...', FALLBACK, 'only dots'],
    ['CON', 'CON_', 'reserved name'],
    ['con', 'con_', 'reserved name, lower case'],
    ['Aux', 'Aux_', 'reserved name, mixed case'],
    ['NUL.txt', 'NUL_.txt', 'reserved name with extension'],
    ['COM1', 'COM1_', 'COM1'],
    ['LPT9', 'LPT9_', 'LPT9'],
    ['COM10', 'COM10', 'not reserved'],
    ['CONSOLE', 'CONSOLE', 'not reserved: longer word'],
    ['Cafe\u0301', 'Café', 'normalized to NFC'],
  ])('%j → %j (%s)', (input, expected) => {
    expect(sanitizeSegment(input, FALLBACK)).toBe(expected);
  });

  it('limits the title to 80 characters at a word boundary', () => {
    const title = `${'word '.repeat(30)}end`;
    const result = sanitizeSegment(title, FALLBACK);
    expect(result.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(result.endsWith('word')).toBe(true);
  });

  it('cuts a single long word hard', () => {
    expect(sanitizeSegment('x'.repeat(200), FALLBACK)).toBe('x'.repeat(MAX_TITLE_LENGTH));
  });

  it('applies the reserved-name guard after truncation', () => {
    expect(sanitizeSegment('CON. something', FALLBACK, 4)).toBe('CON_');
  });
});

describe('truncateAtWordBoundary', () => {
  it.each([
    ['short', 10, 'short'],
    ['hello world foo', 11, 'hello world'],
    ['hello world foo', 13, 'hello world'],
    ['hello world', 5, 'hello'],
    ['abcdefghij klm', 12, 'abcdefghij'],
    ['ab cdefghijklmnop', 10, 'ab cdefghi'],
    ['title. more', 7, 'title'],
  ])('%j at %i → %j', (input, max, expected) => {
    expect(truncateAtWordBoundary(input, max)).toBe(expected);
  });
});

describe('cutGraphemes', () => {
  it('never splits a surrogate pair', () => {
    expect(cutGraphemes('ab😀cd', 3)).toBe('ab');
  });

  it('never splits a ZWJ emoji sequence', () => {
    const family = '👨‍👩‍👧';
    expect(cutGraphemes(`a${family}b`, 4)).toBe('a');
    expect(cutGraphemes(`a${family}b`, 1 + family.length)).toBe(`a${family}`);
  });
});

describe('splitExtension', () => {
  it.each([
    ['report.pdf', 'report', '.pdf'],
    ['archive.tar.gz', 'archive.tar', '.gz'],
    ['README', 'README', ''],
    ['.env', '.env', ''],
    ['v1.this-is-not-an-extension-really', 'v1.this-is-not-an-extension-really', ''],
  ])('%j → %j + %j', (name, base, ext) => {
    expect(splitExtension(name)).toEqual({ base, ext });
  });
});

describe('shortenFileName', () => {
  it('keeps short names', () => {
    expect(shortenFileName('a.pdf', 10)).toBe('a.pdf');
  });

  it('keeps the extension when shortening', () => {
    expect(shortenFileName('very long report name.pdf', 12)).toBe('very lon.pdf');
  });

  it('trims spaces left at the cut', () => {
    expect(shortenFileName('ab cd.txt', 7)).toBe('ab.txt');
  });
});

describe('uniqueFileNames', () => {
  it('adds -2, -3 before the extension', () => {
    expect(uniqueFileNames(['image.png', 'image.png', 'image.png'])).toEqual([
      'image.png',
      'image-2.png',
      'image-3.png',
    ]);
  });

  it('compares case-insensitively', () => {
    expect(uniqueFileNames(['Report.PDF', 'report.pdf'])).toEqual(['Report.PDF', 'report-2.pdf']);
  });

  it('skips a suffix that is already taken', () => {
    expect(uniqueFileNames(['a.txt', 'a-2.txt', 'a.txt'])).toEqual(['a.txt', 'a-2.txt', 'a-3.txt']);
  });

  it('handles names without an extension', () => {
    expect(uniqueFileNames(['README', 'README'])).toEqual(['README', 'README-2']);
  });

  it('sanitizes names and uses the fallback for empty ones', () => {
    expect(uniqueFileNames(['a/b.txt', '', ''])).toEqual(['a_b.txt', 'file', 'file-2']);
  });
});

describe('fitFileNames', () => {
  it('shortens, deduplicates and keeps every name within the limit', () => {
    const long = `${'x'.repeat(40)}.pdf`;
    const fitted = fitFileNames([long, long, long, 'short.txt'], 20);
    expect(fitted.every((n) => n.length <= 20)).toBe(true);
    expect(new Set(fitted.map((n) => n.toLowerCase())).size).toBe(4);
    expect(fitted.slice(0, 3).every((n) => n.endsWith('.pdf'))).toBe(true);
    expect(fitted[3]).toBe('short.txt');
  });

  it('leaves names that already fit untouched', () => {
    expect(fitFileNames(['a.pdf', 'a.pdf'], 50)).toEqual(['a.pdf', 'a-2.pdf']);
  });
});

describe('sanitizeRelativeDir', () => {
  it.each([
    ['AI Chats', ['AI Chats']],
    ['', []],
    ['  ', []],
    ['Archive/AI Chats', ['Archive', 'AI Chats']],
    ['Archive\\AI Chats', ['Archive', 'AI Chats']],
    ['/leading/and/trailing/', ['leading', 'and', 'trailing']],
    ['../../etc', ['etc']],
    ['./a/./b', ['a', 'b']],
    ['a//b', ['a', 'b']],
    ['Чаты: ИИ', ['Чаты_ ИИ']],
    ['C:/Windows', ['C_', 'Windows']],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeRelativeDir(input)).toEqual(expected);
  });
});

describe('joinPath', () => {
  it('joins with /', () => {
    expect(joinPath('AI Chats', 'x', 'y.md')).toBe('AI Chats/x/y.md');
  });

  it.each([[''], ['.'], ['..'], ['a/b'], ['a\\b']])('rejects %j', (segment) => {
    expect(() => joinPath('ok', segment)).toThrow(/Unsafe/);
  });
});

describe('conversationFolderName', () => {
  it.each([
    ['Notes', '2026-10-13', 'Claude', 1, 'Notes - 2026-10-13 (Claude)'],
    ['Notes', '2026-10-13', 'Claude', 2, 'Notes - 2026-10-13 (Claude) (2)'],
    ['Notes', '2026-10-13', null, 1, 'Notes - 2026-10-13'],
    ['Notes', '2026-10-13', null, 3, 'Notes - 2026-10-13 (3)'],
  ] as const)('%j %j %j #%i', (title, date, platform, copy, expected) => {
    expect(conversationFolderName(title, date, platform, copy)).toBe(expected);
  });
});

describe('planConversationFolder', () => {
  const base = {
    parents: [] as string[],
    date: '2026-10-13',
    platformLabel: 'Claude',
    fallbackTitle: FALLBACK,
  };

  it('builds folder and Markdown paths with the same name', () => {
    const plan = planConversationFolder({ ...base, title: 'How to: export?' });
    expect(plan).toEqual({
      folder: 'How to_ export_ - 2026-10-13 (Claude)',
      folderPath: 'How to_ export_ - 2026-10-13 (Claude)',
      markdownPath:
        'How to_ export_ - 2026-10-13 (Claude)/How to_ export_ - 2026-10-13 (Claude).md',
      overBudget: false,
    });
  });

  it('puts parents in the paths and adds the copy suffix', () => {
    const plan = planConversationFolder({
      ...base,
      parents: ['Projects', 'Demo (Claude)', 'chats'],
      title: 'Notes',
      copyIndex: 2,
    });
    expect(plan.folderPath).toBe('Projects/Demo (Claude)/chats/Notes - 2026-10-13 (Claude) (2)');
    expect(plan.markdownPath).toBe(`${plan.folderPath}/Notes - 2026-10-13 (Claude) (2).md`);
  });

  it('does not include the root in the paths', () => {
    const plan = planConversationFolder({ ...base, rootPath: 'AI Chats', title: 'Notes' });
    expect(plan.folderPath).toBe('Notes - 2026-10-13 (Claude)');
  });

  it('keeps a title unchanged when the path fits', () => {
    // 9 (root) + 72 (folder) + 1 + 75 (Markdown file) = 157 <= 180.
    const plan = planConversationFolder({ ...base, rootPath: 'AI Chats', title: 'a'.repeat(50) });
    expect(plan.folder).toBe(`${'a'.repeat(50)} - 2026-10-13 (Claude)`);
  });

  it('shortens the title so the longest path fits the budget', () => {
    const title = 'Очень длинный заголовок разговора про экспорт чатов в Obsidian и не только';
    const plan = planConversationFolder({ ...base, rootPath: 'AI Chats', title });
    const fullPath = `AI Chats/${plan.markdownPath}`;
    expect(fullPath.length).toBeLessThanOrEqual(PATH_BUDGET);
    expect(plan.overBudget).toBe(false);
    expect(plan.folder.endsWith(' - 2026-10-13 (Claude)')).toBe(true);
    // Shortened at a word boundary: no partial word before the date.
    const shortTitle = plan.folder.replace(' - 2026-10-13 (Claude)', '');
    expect(title.startsWith(shortTitle)).toBe(true);
    expect(title.charAt(shortTitle.length)).toBe(' ');
  });

  it('accounts for long attachment paths inside the folder', () => {
    // 9 (root) + 38 (folder) + 1 + 135 = 183: the title must lose a word.
    const plan = planConversationFolder({
      ...base,
      rootPath: 'AI Chats',
      title: 'Short title here',
      longestInnerPath: 135,
    });
    expect(plan.folder).toBe('Short title - 2026-10-13 (Claude)');
    expect(`AI Chats/${plan.folderPath}`.length + 1 + 135).toBeLessThanOrEqual(PATH_BUDGET);
    expect(plan.overBudget).toBe(false);
  });

  it('reports overBudget when attachments are too long for any title', () => {
    const plan = planConversationFolder({
      ...base,
      rootPath: 'AI Chats',
      title: 'Short title here',
      longestInnerPath: 150,
    });
    expect(plan.overBudget).toBe(true);
  });

  it('accounts for deep project paths', () => {
    const plan = planConversationFolder({
      ...base,
      rootPath: 'AI Chats',
      parents: ['Projects', 'A rather long project name for testing (Claude)', 'chats'],
      title: 'Discussion about the architecture of the export queue and retries',
    });
    expect(`AI Chats/${plan.markdownPath}`.length).toBeLessThanOrEqual(PATH_BUDGET);
  });

  it('stops at the minimum title length and reports overBudget', () => {
    const plan = planConversationFolder({
      ...base,
      rootPath: 'x'.repeat(150),
      title: 'A title that cannot possibly fit',
    });
    expect(plan.overBudget).toBe(true);
    const title = plan.folder.replace(' - 2026-10-13 (Claude)', '');
    expect(title.length).toBeLessThanOrEqual(MIN_TITLE_LENGTH);
    expect(title.length).toBeGreaterThan(0);
  });

  it('uses the fallback for an empty title', () => {
    expect(planConversationFolder({ ...base, title: '  ' }).folder).toBe(
      'Untitled - 2026-10-13 (Claude)',
    );
  });
});
