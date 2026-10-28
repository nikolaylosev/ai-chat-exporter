// The export page and Gemini's search: chats appear as each query finds them,
// are remembered after a reload, and "Forget them" clears them.
import assert from 'node:assert/strict';
import { sleep, startStand, waitFor } from '../harness.mjs';
import { fakeGemini } from '../fakes.mjs';
import { geminiAccount } from '../gemini-list.mjs';

export default {
  name: 'gemini-search',
  async run(extDir) {
    const fake = fakeGemini(geminiAccount());
    const stand = await startStand({ extDir, ...fake });
    try {
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=gemini`,
      );
      const rows = () => stand.ev(page, `document.querySelectorAll('tbody tr').length`);
      const text = () => stand.ev(page, `document.querySelector('.search-more')?.innerText ?? ''`);
      await waitFor(async () => (await rows()) >= 61, 60000, 'the list');
      await stand.ev(page, `document.querySelector('.search-more button:not(.link)').click()`);
      const seen = new Set();
      const start = Date.now();
      while (Date.now() - start < 120000) {
        seen.add(await rows());
        if (!/Stop/.test(await text()) && seen.size > 1) break;
        await sleep(300);
      }
      assert.equal(await rows(), 101, 'all 40 found');
      assert.ok(seen.size > 3, `rows grew as queries came (${[...seen].join(', ')})`);

      await stand.ev(page, 'location.reload()');
      await sleep(1500);
      await waitFor(async () => (await rows()) >= 101, 60000, 'the remembered chats');
      assert.match(await text(), /40 found by search/);
      await stand.ev(page, `document.querySelector('.search-more button.link').click()`);
      await waitFor(async () => (await rows()) === 61, 10000, 'forgetting');
      await stand.ev(page, 'location.reload()');
      await sleep(1500);
      await waitFor(async () => (await rows()) >= 61, 60000, 'the list again');
      await sleep(1000);
      assert.equal(await rows(), 61, 'forgotten for good');
    } finally {
      await stand.close();
    }
  },
};
