// A connection that drops while a chat's files are fetched for its .zip: a pdf
// cut twice is fetched again and saved byte for byte; a docx that never arrives
// is marked as failed and leaves nothing behind.
import assert from 'node:assert/strict';
import { sleep, startStand } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

export default {
  name: 'downloads-dropped',
  async run(extDir) {
    const files = chatgptFiles();
    const hits = {};
    const fake = fakeChatgpt({
      chats: chatgptChats(),
      files,
      content: (fid, req, res) => {
        const body = files[fid];
        hits[fid] = (hits[fid] ?? 0) + 1;
        const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
        if (fid === chatgptFile(2) && range) {
          const from = Number(range[1]);
          res.writeHead(206, {
            'content-length': String(body.length - from),
            'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
            'accept-ranges': 'bytes',
          });
          res.end(body.subarray(from));
          return true;
        }
        if ((fid === chatgptFile(2) && hits[fid] <= 2) || fid === chatgptFile(4)) {
          res.writeHead(200, {
            'content-length': String(body.length),
            'accept-ranges': 'bytes',
            etag: '"v1"',
          });
          res.write(body.subarray(0, Math.floor(body.length / 2)));
          setTimeout(() => res.socket.destroy(), 300);
          return true;
        }
        return false;
      },
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      const result = await stand.exportTab(`https://chatgpt.com/c/${uuid(0x13)}`);
      assert.equal(result.failedAttachmentCount, 1, 'only the docx failed');
      await sleep(500);
      const all = stand.files();
      const pdf = all.find((f) => f.endsWith('/files/fruit-prices.pdf'));
      assert.ok(
        pdf && stand.read(pdf).equals(files[chatgptFile(2)]),
        'pdf under its name, byte-identical',
      );
      assert.deepEqual(
        all.filter((f) => / \(\d\)|crdownload|\.docx$/.test(f) || !f.includes('/')),
        [],
        'no leftovers',
      );
      const interrupted = await stand.inExtension(
        `chrome.downloads.search({ state: 'interrupted' }).then((d) => d.length)`,
      );
      assert.equal(interrupted, 0, 'no interrupted item left in the download list');
    } finally {
      await stand.close();
    }
  },
};
