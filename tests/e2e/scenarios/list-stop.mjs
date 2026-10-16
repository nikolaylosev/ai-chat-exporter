// Stopping a slow chat list: the page keeps the chats read so far, says so, and
// "Load the whole list" brings the rest.
import assert from 'node:assert/strict';
import { startStand, waitFor } from '../harness.mjs';
import { fakeGemini } from '../fakes.mjs';
import { geminiAccount } from '../gemini-list.mjs';

export default {
  name: 'list-stop',
  async run(extDir) {
    const fake = fakeGemini({ ...geminiAccount(), listDelay: 1500 });
    const stand = await startStand({ extDir, ...fake });
    try {
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=gemini`,
      );
      const rows = () => stand.ev(page, `document.querySelectorAll('tbody tr').length`);
      const notes = () =>
        stand.ev(
          page,
          `[...document.querySelectorAll('main p')].map((e) => e.innerText).join(' | ')`,
        );
      await waitFor(async () => /so far/.test(await notes()), 30000, 'the progress');
      await stand.ev(
        page,
        `[...document.querySelectorAll('main p button.link')].find((b) => /Stop/.test(b.textContent)).click()`,
      );
      await waitFor(async () => (await rows()) > 0, 30000, 'the stopped list');
      const stopped = await rows();
      assert.ok(stopped >= 27 && stopped < 61, `a part of the list (${stopped})`);
      assert.match(await notes(), new RegExp(`Loading was stopped at ${stopped} chats`));
      await stand.ev(
        page,
        `[...document.querySelectorAll('main p button.link')].find((b) => /whole list/.test(b.textContent)).click()`,
      );
      await waitFor(async () => (await rows()) === 61, 60000, 'the whole list');
      assert.ok(!/stopped/.test(await notes()), 'no warning after the whole list');
    } finally {
      await stand.close();
    }
  },
};
