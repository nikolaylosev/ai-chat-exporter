// ChatGPT: six chats saved, each with files as one .zip and a chat without any as
// its note alone; every file byte-identical; the token goes only to the API,
// never to the signed file links.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startStand } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

const { unzipSync } = createRequire(import.meta.url)('fflate');

export default {
  name: 'chatgpt-current',
  async run(extDir) {
    const files = chatgptFiles();
    const fake = fakeChatgpt({ chats: chatgptChats(), files });
    const stand = await startStand({ extDir, ...fake });
    try {
      for (const n of [0x01, 0x13, 0x27, 0x2f, 0x3a, 0x42]) {
        const result = await stand.exportTab(`https://chatgpt.com/c/${uuid(n)}`);
        assert.equal(result.ok, true, `chat ${n}`);
        assert.equal(result.failedAttachmentCount, 0, `chat ${n} failed files`);
      }
      const all = stand.files();
      const expect = {
        'fruit-prices.pdf': files[chatgptFile(2)],
        'meeting-notes.docx': files[chatgptFile(4)],
        'stripes.png': files[chatgptFile(1)],
        'Minimalist Red Circle on White.png': files[chatgptFile(7)],
        'fruits.csv': files.sandbox,
      };
      for (const [name, bytes] of Object.entries(expect)) {
        const path = all.find((f) => f.endsWith(`/files/${name}`));
        assert.ok(path, `${name} saved`);
        assert.ok(stand.read(path).equals(bytes), `${name} byte-identical`);
      }
      assert.equal(fake.state.noAuth, 0, 'every API request had the token');

      // Into Downloads: a chat with files is one archive, a chat without any its note.
      const saved = stand.downloaded();
      const uploadsZip = saved.find(
        (f) =>
          f.endsWith('.zip') &&
          Object.keys(unzipSync(stand.read(f))).some((n) => n.endsWith('/files/fruit-prices.pdf')),
      );
      assert.ok(uploadsZip, 'the chat with uploads as one .zip');
      assert.ok(
        saved.some((f) => f.endsWith('(ChatGPT).md')),
        'a chat without files as its note alone',
      );
      assert.ok(!saved.some((f) => f.includes('/files/')), 'no loose files in Downloads');

      // Text only: the note alone, even for the chat with uploads.
      const notesBefore = saved.filter((f) => f.endsWith('.md')).length;
      await stand.settings({ saveAttachments: false });
      await stand.exportTab(`https://chatgpt.com/c/${uuid(0x13)}`);
      assert.equal(stand.downloaded().filter((f) => f.endsWith('.md')).length, notesBefore + 1);
    } finally {
      await stand.close();
    }
  },
};
