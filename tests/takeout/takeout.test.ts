// @vitest-environment happy-dom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Conversation } from '../../src/model/conversation';
import { renderHtml } from '../../src/render/html';
import { renderJson } from '../../src/render/json';
import { renderMarkdown } from '../../src/render/markdown';
import { takeoutPrompts } from '../../src/takeout/activity';
import {
  cleanName,
  completeFromTakeout,
  noteMinute,
  SECTION_START,
} from '../../src/takeout/complete';
import { imageSize } from '../../src/takeout/image-size';
import {
  htmlText,
  reportMarkdown,
  withSection,
  writeSections,
  type SectionLabels,
} from '../../src/takeout/section';
import { readActivity, readTakeoutFiles } from '../../src/takeout/source';
import { LABELS } from '../render/labels';
import { MemoryDir } from './memory-fs';

const ID = '00000000000000a1';
const link = (id: string) => [{ name: 'x', url: `https://gemini.google.com/app/${id}` }];

/** A PNG's first bytes, enough for its size. */
function png(width: number, height: number, fill = 0): Uint8Array {
  const bytes = new Uint8Array(40).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

// Made up: a prompt the chat shows (10:00) with its files, one it does not (12:30), and others.
const activity = [
  {
    header: 'Gemini Apps',
    title: 'Prompted look at these',
    time: '2026-10-20T10:00:20.000Z',
    details: link(ID),
    safeHtmlItem: [{ html: '<p>Seen.</p>' }],
    attachedFiles: [
      'photo-1111111111111111.png',
      'clip-0123456789abcdef.mp4',
      'shot-2222222222222222.png',
      'chart-3333333333333333.png',
    ],
  },
  {
    header: 'Gemini Apps',
    title: 'Prompted an edited question',
    time: '2026-10-20T12:30:05.000Z',
    details: link(ID),
    safeHtmlItem: [{ html: '<p>The <b>answer</b></p><ul><li>one</li><li><p>two</p></li></ul>' }],
    attachedFiles: ['doc-4444444444444444.pdf', 'gone-5555555555555555.pdf'],
  },
  {
    header: 'Gemini Apps',
    title: 'Cleared',
    time: '2026-10-21T00:00:00.000Z',
    details: [...link(ID), ...link('00000000000000b2')],
  },
  {
    header: 'Gemini Apps',
    title: 'Prompted elsewhere',
    time: '2026-10-20T09:00:00.000Z',
    details: link('00000000000000c3'),
    safeHtmlItem: [{ html: '<p>x</p>' }],
  },
];

const takeoutZip = () =>
  new File(
    [
      zipSync({
        'Takeout/My Activity/Gemini Apps/MyActivity.json': strToU8(JSON.stringify(activity)),
        'Takeout/My Activity/Gemini Apps/photo-1111111111111111.png': png(10, 10, 1),
        'Takeout/My Activity/Gemini Apps/clip-0123456789abcdef.mp4': strToU8('video bytes'),
        // The saved photo under another name: same size, other bytes.
        'Takeout/My Activity/Gemini Apps/shot-2222222222222222.png': png(10, 10, 2),
        'Takeout/My Activity/Gemini Apps/chart-3333333333333333.png': png(20, 10, 3),
        'Takeout/My Activity/Gemini Apps/doc-4444444444444444.pdf': strToU8('%PDF doc'),
        'Takeout/My Activity/Search/MyActivity.json': strToU8('[]'),
      }),
    ],
    'takeout-1-001.zip',
  );

const chat: Conversation = {
  id: ID,
  platform: 'gemini',
  title: 'Photos',
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T11:00:00Z',
  url: `https://gemini.google.com/app/${ID}`,
  messages: [
    {
      id: 'm1',
      role: 'user',
      createdAt: '2026-10-20T10:00:00Z',
      blocks: [{ type: 'text', markdown: 'Look at these' }],
      attachments: [{ id: 'a1', name: 'photo.png', origin: 'user-upload', source: null }],
    },
    {
      id: 'm2',
      role: 'assistant',
      createdAt: '2026-10-20T10:01:00Z',
      blocks: [{ type: 'text', markdown: 'Seen.' }],
      attachments: [],
    },
    {
      id: 'm3',
      role: 'user',
      createdAt: '2026-10-20T11:00:00Z',
      blocks: [{ type: 'text', markdown: 'Thanks' }],
      attachments: [],
    },
  ],
  branches: [],
};
const options = {
  labels: LABELS,
  includeThinking: true,
  includeToolCalls: true,
  toolCallDetail: 'compact' as const,
  includeBranches: false,
  exportedAt: new Date('2026-10-22T00:00:00Z'),
  createdSource: 'platform' as const,
  timeZone: 'UTC',
  attachmentPaths: new Map([['a1', 'files/photo.png']]),
};
const markdown = renderMarkdown(chat, options);

/** An archive with the chat saved as Markdown, as HTML elsewhere, and as JSON elsewhere. */
const archive = () =>
  new MemoryDir('AI Chats')
    .put('Photos (Gemini)/Photos (Gemini).md', markdown)
    .put('Photos (Gemini)/files/photo.png', png(10, 10, 9))
    .put('Html/Photos/Photos.html', renderHtml(markdown, chat.title))
    .put('Html/Photos/files/photo.png', png(10, 10, 9))
    .put('Json/Photos/Photos.json', renderJson(chat, options))
    .put('Json/Photos/files/photo.png', png(10, 10, 9))
    .put('_reports/old.md', '# report');

const labels: SectionLabels = {
  heading: 'From Google Takeout',
  intro: (date) => `Added from Google Takeout on ${date}.`,
  files: 'Files Gemini left out',
  user: 'User',
  assistant: 'Gemini',
  attachments: 'Attachments',
  notInTakeout: 'not in Takeout',
};
const run = (root: MemoryDir, dryRun = false) =>
  completeFromTakeout(
    root.asHandle(),
    { kind: 'files', files: [takeoutZip()] },
    {
      dryRun,
      timeZone: 'UTC',
      writeNotes: (c) => writeSections(c, labels, '2026-10-29', 'UTC'),
    },
  );

describe('Takeout activity', () => {
  it('gives each prompt of one chat with its answer and files, oldest first', () => {
    const prompts = takeoutPrompts(activity);
    expect(prompts.map((p) => [p.chatId, p.text])).toEqual([
      ['00000000000000c3', 'elsewhere'],
      [ID, 'look at these'],
      [ID, 'an edited question'],
    ]);
    expect(prompts[2]?.files).toEqual(['doc-4444444444444444.pdf', 'gone-5555555555555555.pdf']);
  });

  it('drops the id Takeout adds to a file name', () => {
    expect(cleanName('THE HACIENDA-a738de6a182c3255.xlsx')).toBe('THE HACIENDA.xlsx');
    expect(cleanName('notes.txt')).toBe('notes.txt');
  });

  it('reads note times as minutes, local text as it is and ISO in the time zone', () => {
    expect(noteMinute('2026-10-20 10:00')).toBe('2026-10-20 10:00');
    expect(noteMinute('2026-10-20T10:00:59+05:00', 'UTC')).toBe('2026-10-20 05:00');
    expect(noteMinute(null)).toBeNull();
  });
});

describe('Takeout sources', () => {
  it('reads the activity and the files from parts of a .zip, and from the Gemini Apps folder itself', async () => {
    const part2 = new File(
      [
        zipSync({
          'Takeout/My Activity/Gemini Apps/late-6666666666666666.txt': strToU8('late'),
        }),
      ],
      'takeout-1-002.zip',
    );
    const zips = { kind: 'files' as const, files: [takeoutZip(), part2] };
    expect(await readActivity(zips)).toHaveLength(1);
    const names: string[] = [];
    await readTakeoutFiles(
      zips,
      (n) => n.startsWith('late') || n.startsWith('doc'),
      (n) => void names.push(n),
    );
    expect(names.sort()).toEqual(['doc-4444444444444444.pdf', 'late-6666666666666666.txt']);

    const folder = new MemoryDir('Gemini Apps').put('MyActivity.json', JSON.stringify(activity));
    expect(await readActivity({ kind: 'folder', handle: folder.asHandle() })).toHaveLength(1);
  });
});

describe('image size', () => {
  it('reads PNG, GIF, JPEG and WebP headers', () => {
    expect(imageSize(png(640, 480))).toEqual([640, 480]);
    const gif = strToU8('GIF89a\x20\x03\x58\x02');
    expect(imageSize(gif)).toEqual([800, 600]);
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0,
    ]);
    expect(imageSize(jpeg)).toEqual([640, 480]);
    const webp = new Uint8Array(30);
    webp.set(strToU8('RIFF\0\0\0\0WEBPVP8X'));
    webp.set([0x7f, 0x02, 0, 0xdf, 0x01, 0], 24);
    expect(imageSize(webp)).toEqual([640, 480]);
    expect(imageSize(strToU8('%PDF'))).toBeNull();
  });
});

describe('completing saved chats from Takeout', () => {
  it('finds, without writing, the files the chat lacks and the prompt it does not show', async () => {
    const root = archive();
    const before = root.paths().length;
    const [md, html, json] = await run(root, true);
    expect(root.paths()).toHaveLength(before);
    const byPath = new Map([md, html, json].map((c) => [c?.chat.path, c]));
    for (const path of ['Photos (Gemini)/', 'Html/Photos/']) {
      const c = byPath.get(path);
      // The photo by name and the shot by its size are there already.
      expect(c?.files.map((f) => f.path)).toEqual(['files/clip.mp4', 'files/chart.png']);
      expect(c?.prompts.map((p) => p.text)).toEqual(['an edited question']);
      expect(c?.prompts[0]?.links).toEqual([
        { takeoutName: 'doc-4444444444444444.pdf', path: 'files/doc.pdf' },
        { takeoutName: 'gone-5555555555555555.pdf', path: null },
      ]);
    }
    // A JSON note takes no section: the missing prompt gives only its file.
    expect(byPath.get('Json/Photos/')?.files.map((f) => f.path)).toEqual([
      'files/clip.mp4',
      'files/chart.png',
      'files/doc.pdf',
    ]);
    expect(byPath.get('Json/Photos/')?.prompts).toEqual([]);
    expect([md, html, json].map((c) => c?.chat.path).sort()).toEqual([
      'Html/Photos/',
      'Json/Photos/',
      'Photos (Gemini)/',
    ]);
  });

  it('copies the files, writes the section once, and changes nothing on a second run', async () => {
    const root = archive();
    await run(root);
    const folder = 'Photos (Gemini)/';
    expect(root.read(`${folder}files/clip.mp4`)).toBe('video bytes');
    expect(root.bytes(`${folder}files/chart.png`)).toEqual(png(20, 10, 3));
    expect(root.read(`${folder}files/doc.pdf`)).toBe('%PDF doc');
    expect(root.bytes(`${folder}files/shot.png`)).toBeUndefined();

    const note = root.read(`${folder}Photos (Gemini).md`)!;
    expect(note.startsWith(markdown.replace(/\s+$/, ''))).toBe(true);
    const section = note.slice(note.indexOf(SECTION_START));
    expect(section).toContain('## From Google Takeout');
    expect(section).toContain('- 2026-10-20 10:00 · [clip.mp4](files/clip.mp4)');
    expect(section).toContain('### User · 2026-10-20 12:30\n\nan edited question');
    expect(section).toContain(
      '- [doc.pdf](files/doc.pdf)\n- gone-5555555555555555.pdf (not in Takeout)',
    );
    expect(section).toContain('### Gemini · 2026-10-20 12:30\n\nThe answer\n\n- one\n- two');

    const html = root.read('Html/Photos/Photos.html')!;
    expect(html.indexOf(SECTION_START)).toBeLessThan(html.lastIndexOf('</body>'));
    expect(html).toContain('<h3>User · 2026-10-20 12:30</h3>');
    expect(root.read('Json/Photos/Photos.json')).toBe(renderJson(chat, options));
    expect(root.read('Json/Photos/files/clip.mp4')).toBe('video bytes');

    const paths = root.paths().sort();
    const again = await run(root);
    expect(root.paths().sort()).toEqual(paths);
    expect(root.read(`${folder}Photos (Gemini).md`)).toBe(note);
    // A JSON note has no section: the files copied the first time are its own now.
    expect(Object.fromEntries(again.map((c) => [c.chat.path, c.files.length]))).toEqual({
      'Photos (Gemini)/': 2,
      'Html/Photos/': 2,
    });
  });

  it('reads the note back with every message after its section was added', async () => {
    const { parseNote } = await import('../../src/search/archive');
    const root = archive();
    await run(root);
    const note = parseNote('Photos (Gemini).md', root.bytes('Photos (Gemini)/Photos (Gemini).md')!);
    expect(note?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('the section and the report', () => {
  it('turns an answer into lines of text', () => {
    expect(
      htmlText('<p>A <b>b</b></p><ol><li><p>one</p></li><li>two</li></ol><div>x<br>y</div>'),
    ).toBe('A b\n\n- one\n- two\n\nx\ny');
  });

  it('replaces an earlier section instead of adding one', () => {
    const once = withSection(
      '# Note\n',
      `${SECTION_START}\nold\n<!-- /ai-chat-exporter:takeout -->`,
      'markdown',
    );
    const twice = withSection(
      once,
      `${SECTION_START}\nnew\n<!-- /ai-chat-exporter:takeout -->`,
      'markdown',
    );
    expect(twice).toBe(`# Note\n\n${SECTION_START}\nnew\n<!-- /ai-chat-exporter:takeout -->\n`);
  });

  it('lists each chat with a link to its note', async () => {
    const completions = await run(archive(), true);
    const report = reportMarkdown(
      completions,
      {
        title: 'Completed',
        summary: (d, c, f, p) => `${d}: ${c} ${f} ${p}`,
        chat: (f, p) => `${f} files, ${p} prompts`,
        filesOnly: 'files only',
      },
      '2026-10-29',
    );
    expect(report).toContain('2026-10-29: 3 9 2');
    expect(report).toContain(
      '- [Photos](../Photos%20%28Gemini%29/Photos%20%28Gemini%29.md): 3 files, 1 prompts',
    );
    expect(report).toContain('(files only)');
  });
});
