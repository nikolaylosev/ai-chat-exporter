// ChatGPT: six chats saved as files and as a ZIP; every file byte-identical; the
// token goes only to the API, never to the signed file links.
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

      await stand.settings({ saveAsZip: true });
      await stand.exportTab(`https://chatgpt.com/c/${uuid(0x13)}`);
      const zip = stand.files().find((f) => f.endsWith('.zip'));
      const entries = unzipSync(stand.read(zip));
      for (const name of ['fruit-prices.pdf', 'meeting-notes.docx', 'stripes.png']) {
        const entry = Object.entries(entries).find(([n]) => n.endsWith(`/files/${name}`));
        assert.ok(entry && Buffer.from(entry[1]).equals(expect[name]), `${name} in the ZIP`);
      }
    } finally {
      await stand.close();
    }
  },
};
