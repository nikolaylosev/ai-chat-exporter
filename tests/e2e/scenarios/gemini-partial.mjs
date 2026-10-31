// A Gemini chat whose older history page keeps failing: the bulk export saves
// the newest turns, warns at the top of the note, marks the chat in the table
// and the report, and goes on with the next chat.
import assert from 'node:assert/strict';
import { runBulkJob, startStand, waitFor } from '../harness.mjs';
import { fakeGemini, geminiChats } from '../fakes.mjs';

const LONG = '0000000000000006';

export default {
  name: 'gemini-partial',
  async run(extDir) {
    const fake = fakeGemini({
      chats: geminiChats(['basic', 'long']),
      historyFails: (id, token) => id === LONG && token !== null,
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      await stand.settings({ delayBetweenChatsMs: 0, report: 'always' });
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=gemini`,
      );
      await waitFor(
        () => stand.ev(page, `document.querySelectorAll('tbody tr').length >= 2`),
        60000,
        'the list',
      );
      await stand.ev(
        page,
        `[...document.querySelectorAll('tbody tr')]
          .filter((r) => /0000000000000001|${LONG}/.test(r.querySelector('a').href))
          .forEach((r) => r.querySelector('input[type=checkbox]').click())`,
      );
      const job = await runBulkJob(stand, page);
      assert.deepEqual(job.counts, { done: 1, warning: 1 });
      const incomplete = await stand.ev(
        page,
        `chrome.storage.session.get(null).then((d) => Object.values(d).find((v) => v && v.items).items.filter((i) => i.incomplete).map((i) => i.id))`,
      );
      assert.deepEqual(incomplete, [LONG]);
      assert.match(
        await stand.ev(page, `document.querySelector('tbody').innerText`),
        /saved without its oldest messages/,
      );

      const files = stand.files();
      const notes = files.filter((f) => f.endsWith('.md') && !f.includes('_reports'));
      const partial = notes.filter((f) => /stopped answering/.test(stand.read(f).toString()));
      assert.equal(partial.length, 1, notes.join(', '));
      const text = stand.read(partial[0]).toString();
      assert.match(text, /> ⚠️ The service stopped answering while this chat was read/);
      assert.equal((text.match(/^## User · /gm) ?? []).length, 10, 'the newest ten turns');
      const report = stand.read(files.find((f) => f.includes('_reports/'))).toString();
      assert.match(report, /the oldest messages are missing/);
    } finally {
      await stand.close();
    }
  },
};
