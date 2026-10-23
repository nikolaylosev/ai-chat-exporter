// Gemini keeps an uploaded png as a JPEG: it is saved as stripes.jpg, byte for
// byte, in the chat's .zip, and the image is fetched once.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startStand } from '../harness.mjs';
import { fakeGemini, geminiChats } from '../fakes.mjs';

const { unzipSync } = createRequire(import.meta.url)('fflate');

export default {
  name: 'gemini-images',
  async run(extDir) {
    const image = Buffer.from('ffd8ffe000104a4649460001' + '00'.repeat(40) + 'ffd9', 'hex');
    const fake = fakeGemini({ chats: geminiChats(['upload-image']), image });
    const stand = await startStand({ extDir, ...fake });
    try {
      // A chat with files into Downloads is one .zip: the image is fetched once.
      await stand.exportTab('https://gemini.google.com/app/0000000000000027');
      assert.equal(fake.state.lh3, 1, 'in a ZIP: one download');
      const zip = stand.downloaded().find((f) => f.endsWith('.zip'));
      const entries = unzipSync(stand.read(zip));
      const inZip = Object.entries(entries).find(([n]) => n.endsWith('/files/stripes.jpg'));
      assert.ok(inZip && Buffer.from(inZip[1]).equals(image), 'stripes.jpg, byte-identical');
      const note = Object.entries(entries).find(([n]) => n.endsWith('.md'));
      assert.match(
        Buffer.from(note[1]).toString(),
        /\[stripes\.jpg\]\(files\/stripes\.jpg\)/,
        'the note links to the new name',
      );
    } finally {
      await stand.close();
    }
  },
};
