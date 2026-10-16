// ChatGPT's signed link for the pdf has expired by the time the file is written:
// the extension asks the tab for a new one, as separate files and in a ZIP.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startStand } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

const { unzipSync } = createRequire(import.meta.url)('fflate');

export default {
  name: 'expired-link',
  async run(extDir) {
    const files = chatgptFiles();
    const fake = fakeChatgpt({
      chats: chatgptChats(),
      files,
      // The first link of each run (n1) is refused for the pdf; later ones work.
      content: (fid, _req, res, url) => {
        if (fid !== chatgptFile(2) || url.searchParams.get('sig') !== 'n1') return false;
        res.writeHead(403);
        res.end();
        return true;
      },
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      for (const zip of [false, true]) {
        await stand.settings({ saveAsZip: zip });
        fake.state.links = 0;
        const result = await stand.exportTab(`https://chatgpt.com/c/${uuid(0x13)}`);
        assert.equal(result.failedAttachmentCount, 0, `nothing failed (zip: ${zip})`);
        assert.equal(fake.state.links, 4, `three links and one renewed (zip: ${zip})`);
      }
      const all = stand.files();
      const pdf = all.find((f) => f.endsWith('/files/fruit-prices.pdf'));
      assert.ok(pdf && stand.read(pdf).equals(files[chatgptFile(2)]), 'pdf as a file');
      const entries = unzipSync(stand.read(all.find((f) => f.endsWith('.zip'))));
      const inZip = Object.entries(entries).find(([n]) => n.endsWith('fruit-prices.pdf'));
      assert.ok(inZip && Buffer.from(inZip[1]).equals(files[chatgptFile(2)]), 'pdf in the ZIP');
    } finally {
      await stand.close();
    }
  },
};
