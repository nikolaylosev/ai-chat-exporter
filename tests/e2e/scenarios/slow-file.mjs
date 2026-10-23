// A file whose server answers only after several seconds is saved, and the
// export goes on: a download without a name yet is not taken for a Save As
// dialog until its bytes arrive.
import assert from 'node:assert/strict';
import { startStand } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

export default {
  name: 'slow-file',
  async run(extDir) {
    const files = chatgptFiles();
    const fake = fakeChatgpt({
      chats: chatgptChats(),
      files,
      content: (fid, _req, res) => {
        if (fid !== chatgptFile(2)) return false;
        // Longer than the extension's 5 s wait for a dialog, before any byte.
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(files[fid]);
        }, 7000);
        return true;
      },
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      const result = await stand.exportTab(`https://chatgpt.com/c/${uuid(0x13)}`);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.failedAttachmentCount, 0);
      const pdf = stand.files().find((f) => f.endsWith('/files/fruit-prices.pdf'));
      assert.ok(pdf && stand.read(pdf).equals(files[chatgptFile(2)]), 'the slow pdf saved');
    } finally {
      await stand.close();
    }
  },
};
