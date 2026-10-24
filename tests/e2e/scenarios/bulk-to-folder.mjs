// "To a folder…" on the export page: the folder picker (replaced on a stand by
// the extension's private file system), then every selected chat with its files
// written straight into that folder; nothing goes to Downloads.
import assert from 'node:assert/strict';
import { sleep, startStand, waitFor } from '../harness.mjs';
import { fakeGrok, grokChats, uuid } from '../fakes.mjs';

const LIST = `(async () => {
  const out = [];
  const walk = async (dir, prefix) => {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'directory') await walk(entry, prefix + name + '/');
      else out.push(prefix + name);
    }
  };
  await walk(await navigator.storage.getDirectory(), '');
  return out;
})()`;

export default {
  name: 'bulk-to-folder',
  async run(extDir) {
    const assets = {
      [`${uuid(0x10)}/content`]: Buffer.from('%PDF-1.4 grok pdf', 'latin1'),
      [`${uuid(0x11)}/content`]: Buffer.from('PK grok docx', 'latin1'),
      [`${uuid(0x12)}/content`]: Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(30), 'hex'),
      'image.jpg': Buffer.from('ffd8ffe000104a4649460001' + '11'.repeat(50) + 'ffd9', 'hex'),
    };
    const fake = fakeGrok({ chats: grokChats(['basic', 'uploads', 'image']), assets });
    const stand = await startStand({ extDir, ...fake });
    try {
      await stand.settings({ delayBetweenChatsMs: 0 });
      // The export page, with the picker answering at once.
      const { result: target } = await stand.send('Target.createTarget', { url: 'about:blank' });
      const { result: attached } = await stand.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      });
      const page = attached.sessionId;
      await stand.send('Page.enable', {}, page);
      await stand.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: 'window.showDirectoryPicker = () => navigator.storage.getDirectory();' },
        page,
      );
      await stand.send(
        'Page.navigate',
        {
          url: `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=grok`,
        },
        page,
      );
      await sleep(1500);
      await waitFor(
        () => stand.ev(page, `document.querySelectorAll('tbody tr').length >= 3`),
        60000,
        'the list',
      );
      await stand.ev(page, `document.querySelector('thead input[type=checkbox]').click()`);
      const before = (await stand.job())?.started;
      await stand.ev(
        page,
        `[...document.querySelectorAll('.actions button')].find((b) => b.textContent === 'To a folder…').click()`,
      );
      const job = await waitFor(
        async () => {
          const j = await stand.job();
          return j && j.started !== before && j.status === 'finished' && j;
        },
        120000,
        'the export',
      );
      assert.deepEqual(job.counts, { done: 3 });
      const files = await stand.inExtension(LIST);
      assert.equal(files.filter((f) => /\(Grok\)\.md$/.test(f)).length, 3, JSON.stringify(files));
      assert.ok(
        files.some((f) => f.endsWith('/files/fruit-prices.pdf')),
        'the uploads',
      );
      assert.deepEqual(stand.files(), [], 'nothing in Downloads');
    } finally {
      await stand.close();
    }
  },
};
