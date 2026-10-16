// Gemini keeps an uploaded png as a JPEG: it is saved as stripes.jpg, byte for
// byte, and for a ZIP the image is fetched once.
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
      await stand.exportTab('https://gemini.google.com/app/0000000000000027');
      const jpg = stand.files().find((f) => f.endsWith('/files/stripes.jpg'));
      assert.ok(jpg && stand.read(jpg).equals(image), 'stripes.jpg, byte-identical');
      const note = stand.read(stand.files().find((f) => f.endsWith('.md'))).toString();
      assert.match(
        note,
        /\[stripes\.jpg\]\(files\/stripes\.jpg\)/,
        'the note links to the new name',
      );
      assert.equal(fake.state.lh3, 2, 'as files: the first bytes, then the download');

      await stand.settings({ saveAsZip: true });
      await stand.exportTab('https://gemini.google.com/app/0000000000000027');
      assert.equal(fake.state.lh3, 3, 'in a ZIP: one download');
      const entries = unzipSync(stand.read(stand.files().find((f) => f.endsWith('.zip'))));
      const inZip = Object.entries(entries).find(([n]) => n.endsWith('/files/stripes.jpg'));
      assert.ok(inZip && Buffer.from(inZip[1]).equals(image), 'stripes.jpg in the ZIP');
    } finally {
      await stand.close();
    }
  },
};
