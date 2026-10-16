// Chrome stops the extension's worker while a download stalls; when the
// connection drops, Chrome resumes the download by itself, and the restarted
// worker still names the file (before the fix it landed in Downloads as "content").
import assert from 'node:assert/strict';
import { sleep, startStand, waitFor } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

export default {
  name: 'worker-restart',
  async run(extDir) {
    const files = chatgptFiles();
    const hits = {};
    const fake = fakeChatgpt({
      chats: chatgptChats(),
      files,
      content: (fid, req, res) => {
        if (fid !== chatgptFile(2)) return false;
        const body = files[fid];
        hits[fid] = (hits[fid] ?? 0) + 1;
        const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
        if (range) {
          const from = Number(range[1]);
          res.writeHead(206, {
            'content-length': String(body.length - from),
            'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
            'accept-ranges': 'bytes',
          });
          res.end(body.subarray(from));
          return true;
        }
        if (hits[fid] > 1) return false;
        res.writeHead(200, {
          'content-length': String(body.length),
          'accept-ranges': 'bytes',
          etag: '"v1"',
        });
        res.write(body.subarray(0, Math.floor(body.length / 2)));
        setTimeout(() => res.socket.destroy(), 5000);
        return true;
      },
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      const exporting = stand.exportTab(`https://chatgpt.com/c/${uuid(0x13)}`).catch(() => null);
      await waitFor(() => hits[chatgptFile(2)] >= 1, 30000, 'the pdf download');
      await sleep(1000);
      const worker = await stand.worker();
      await stand.send('Target.closeTarget', { targetId: worker.id });
      await sleep(12000);
      await Promise.race([exporting, sleep(100)]);
      const all = stand.files();
      const pdf = all.find((f) => f.endsWith('/files/fruit-prices.pdf'));
      assert.ok(
        pdf && stand.read(pdf).equals(files[chatgptFile(2)]),
        'pdf under its own name, byte-identical',
      );
      assert.deepEqual(
        all.filter((f) => !f.includes('/')),
        [],
        'nothing at the Downloads root',
      );
    } finally {
      await stand.close();
    }
  },
};
