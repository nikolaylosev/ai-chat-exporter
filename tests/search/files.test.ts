import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { noteFolder, withFiles } from '../../src/search/archive';
import { attachmentOwner, fileText } from '../../src/search/notes';
import { search } from '../../src/search/query';

const docx = zipSync({
  'word/document.xml': strToU8(
    '<w:document><w:body><w:p><w:r><w:t>Paint the fence</w:t></w:r></w:p><w:p w:rsidR="1"><w:r><w:t xml:space="preserve">turquoise &amp; white</w:t></w:r></w:p></w:body></w:document>',
  ),
});
const xlsx = zipSync({
  'xl/sharedStrings.xml': strToU8('<sst><si><t>Apple</t></si><si><t>Pear</t></si></sst>'),
  'xl/worksheets/sheet1.xml': strToU8(
    '<worksheet><c t="inlineStr"><is><t>Plum</t></is></c></worksheet>',
  ),
});
const pptx = zipSync({
  'ppt/slides/slide2.xml': strToU8('<p:sld><a:t>Second slide</a:t></p:sld>'),
  'ppt/slides/slide1.xml': strToU8('<p:sld><a:t>First slide</a:t></p:sld>'),
});

describe("chats' files", () => {
  it('reads text, code and Office documents', () => {
    expect(fileText('notes.txt', strToU8('Hello'))).toBe('Hello');
    expect(fileText('main.py', strToU8('print(1)'))).toBe('print(1)');
    expect(fileText('meeting.docx', docx)).toBe('Paint the fence\nturquoise & white');
    expect(fileText('prices.xlsx', xlsx)).toContain('Apple Pear');
    expect(fileText('prices.xlsx', xlsx)).toContain('Plum');
    expect(fileText('deck.pptx', pptx)).toBe('First slide\n\nSecond slide');
  });

  it('skips binary files, broken documents and empty text', () => {
    expect(fileText('photo.png', new Uint8Array([137, 80, 78, 71]))).toBeNull();
    expect(fileText('fake.txt', new Uint8Array([65, 0, 66]))).toBeNull();
    expect(fileText('broken.docx', strToU8('PK not a zip'))).toBeNull();
    expect(fileText('empty.txt', strToU8('  \n'))).toBeNull();
    expect(fileText('report.pdf', strToU8('%PDF-1.4'))).toBeNull();
  });

  it('knows which note a file belongs to', () => {
    expect(attachmentOwner('Chat/files/a.txt')).toBe('Chat/');
    expect(attachmentOwner('Projects/P/knowledge/spec.docx')).toBe('Projects/P/');
    expect(attachmentOwner('Projects/P/chats/C/files/x.csv')).toBe('Projects/P/chats/C/');
    expect(attachmentOwner('Chat/files/photo.png')).toBeNull();
    expect(attachmentOwner('Chat/notes.txt')).toBeNull();
    expect(noteFolder('Chat/Chat.md')).toBe('Chat/');
    expect(noteFolder('AI Chats/a.zip::Chat/Chat.md')).toBe('AI Chats/a.zip::Chat/');
    expect(noteFolder('AI Chats/a.zip::Chat.md')).toBe('AI Chats/a.zip::');
    expect(noteFolder('Chat.md')).toBe('');
  });

  it('gives each note the files of its folder, and finds text in them', () => {
    const base = {
      title: 'T',
      platform: 'claude' as const,
      url: null,
      project: null,
      created: null,
    };
    const notes = withFiles(
      [
        {
          ...base,
          key: 'a.zip::Chat/Chat.md',
          source: 'a.zip',
          messages: [{ role: 'user', time: null, text: 'see the file' }],
        },
        { ...base, key: 'Other/Other.md', source: 'Other/Other.md', messages: [] },
      ],
      [
        {
          key: 'a.zip::Chat/files/m.docx',
          source: 'a.zip',
          owner: 'a.zip::Chat/',
          name: 'm.docx',
          text: 'turquoise fence',
        },
      ],
    );
    expect(notes[0]?.files.map((f) => f.name)).toEqual(['m.docx']);
    expect(notes[1]?.files).toEqual([]);
    const { hits } = search(notes, 'turquoise');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ message: null, file: 0 });
    // A file has no author: filtering by one leaves files out.
    expect(search(notes, 'turquoise', { role: 'user' }).total).toBe(0);
  });
});
