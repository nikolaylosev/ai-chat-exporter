// A Word note: with files, the chat's .zip holds the .docx with the uploaded png
// inside it, byte for byte, next to files/; as text only, the .docx alone.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startStand } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

const { strFromU8, unzipSync } = createRequire(import.meta.url)('fflate');

export default {
  name: 'word-note',
  async run(extDir) {
    const files = chatgptFiles();
    const stand = await startStand({ extDir, ...fakeChatgpt({ chats: chatgptChats(), files }) });
    try {
      await stand.settings({ noteFormat: 'docx' });
      const chat = `https://chatgpt.com/c/${uuid(0x13)}`;
      const result = await stand.exportTab(chat);
      assert.equal(result.ok, true, JSON.stringify(result));
      const zip = stand.downloaded().find((f) => f.endsWith('.zip'));
      const entries = unzipSync(stand.read(zip));
      const names = Object.keys(entries);
      // The note, not the chat's own meeting-notes.docx in files/.
      const docxName = names.find((n) => n.endsWith('.docx') && !n.includes('/files/'));
      assert.ok(docxName, `a .docx note in ${JSON.stringify(names)}`);
      assert.ok(
        names.some((n) => n.endsWith('/files/fruit-prices.pdf')),
        'the pdf in files/',
      );

      const docx = unzipSync(entries[docxName]);
      const text = strFromU8(docx['word/document.xml']);
      assert.match(text, /<w:pStyle w:val="Heading1"\/>/, 'the title as a heading');
      const image = Object.keys(docx).find((n) => n.startsWith('word/media/'));
      assert.ok(image, 'the png inside the document');
      assert.ok(Buffer.from(docx[image]).equals(files[chatgptFile(1)]), 'byte for byte');
      assert.match(
        strFromU8(docx['word/_rels/document.xml.rels']),
        /Target="files\/fruit-prices\.pdf" TargetMode="External"/,
        'the pdf linked',
      );

      // Text only: the note alone, a Word document without images.
      await stand.settings({ saveAttachments: false });
      const before = new Set(stand.downloaded());
      const text2 = await stand.exportTab(chat);
      assert.equal(text2.ok, true, JSON.stringify(text2));
      const added = stand.downloaded().filter((f) => !before.has(f));
      const alone = added.filter((f) => f.endsWith('.docx'));
      assert.equal(alone.length, 1, JSON.stringify(added));
      const plain = unzipSync(stand.read(alone[0]));
      assert.ok(plain['word/document.xml'], 'a Word package');
      assert.equal(Object.keys(plain).filter((n) => n.startsWith('word/media/')).length, 0);
    } finally {
      await stand.close();
    }
  },
};
