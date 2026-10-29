// Gemini's list and search are remembered on the export page: the next visit
// reads only the newest page of the list, a search goes on where the last one
// stopped, and chats exported before that neither has are listed too.
import assert from 'node:assert/strict';
import { sleep, startStand, waitFor } from '../harness.mjs';
import { fakeGemini } from '../fakes.mjs';
import { geminiAccount } from '../gemini-list.mjs';

const SAVED = 'c0ffee0000000001';

export default {
  name: 'gemini-memory',
  async run(extDir) {
    const fake = fakeGemini(geminiAccount());
    const stand = await startStand({ extDir, ...fake });
    try {
      // A chat exported earlier that the list and the search do not have.
      await stand.inExtension(`chrome.storage.local.set({ registry: { issued: [], records: {
        'gemini:${SAVED}': { updatedAt: '2025-01-02T00:00:00.000Z', exportedAt: '2025-01-03T00:00:00.000Z',
          destination: 'downloads', folder: 'Saved earlier - 2025-01-01 (Gemini)' } } } }).then(() => 'ok')`);
      const url = `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=gemini`;
      const page = await stand.openTab(url);
      const rows = () => stand.ev(page, `document.querySelectorAll('tbody tr').length`);
      const text = () => stand.ev(page, `document.querySelector('main').innerText`);
      const more = () => stand.ev(page, `document.querySelector('.search-more')?.innerText ?? ''`);

      await waitFor(async () => (await rows()) >= 62, 60000, 'the list');
      assert.equal(fake.state.listPages, 3, 'the whole list the first time');
      assert.match(await text(), /Saved earlier\s+saved before/);
      assert.match(
        await more(),
        /61 chats from the list, 0 found by search, 0 from Takeout, 1 saved before/,
      );

      // The Gem filter: the one Gem chat, then back to all.
      const pickGem = (value) =>
        stand.ev(
          page,
          `(() => {
            const gem = [...document.querySelectorAll('.filters select')].find((s) =>
              [...s.options].some((o) => o.value === '='),
            );
            gem.value = ${JSON.stringify(value)} ?? [...gem.options].find((o) => o.value.length > 1).value;
            gem.dispatchEvent(new Event('change', { bubbles: true }));
            return gem.value;
          })()`,
        );
      await pickGem(null);
      await waitFor(async () => (await rows()) === 1, 5000, 'the Gem chat');
      await pickGem('*');
      await waitFor(async () => (await rows()) === 62, 5000, 'all chats again');

      // The next visit reads only the first page: its chats are known and unchanged.
      await stand.ev(page, 'location.reload()');
      await sleep(1500);
      await waitFor(async () => (await rows()) >= 62, 60000, 'the remembered list');
      assert.equal(fake.state.listPages, 4, 'one page the second time');
      assert.match(
        await text(),
        /Only the newest chats were read from Gemini \(0 new or changed\)/,
      );
      await stand.ev(
        page,
        `[...document.querySelectorAll('button.link')].find((b) => /Read the whole list/.test(b.innerText)).click()`,
      );
      await waitFor(() => fake.state.listPages === 7, 30000, 'the whole list again');
      await waitFor(async () => (await rows()) >= 62, 30000, 'the list after reading it all');

      // A search stopped partway goes on from where it stopped after a reload.
      await stand.ev(page, `document.querySelector('.search-more button:not(.link)').click()`);
      await waitFor(() => fake.state.queries.length >= 8, 60000, 'some queries');
      await stand.ev(
        page,
        `[...document.querySelectorAll('.search-more button.link')].find((b) => /Stop/.test(b.innerText)).click()`,
      );
      await waitFor(async () => /Search more/.test(await more()), 30000, 'the stop');
      await sleep(500);
      const first = [...fake.state.queries];
      await stand.ev(page, 'location.reload()');
      await sleep(1500);
      await waitFor(async () => /Search more/.test(await more()), 60000, 'the remembered search');
      await stand.ev(page, `document.querySelector('.search-more button:not(.link)').click()`);
      await waitFor(() => fake.state.queries.length >= first.length + 3, 60000, 'the next queries');
      const next = fake.state.queries.slice(first.length);
      assert.ok(
        next.every((q) => !first.includes(q)),
        `no word asked again: ${first.join(',')} then ${next.join(',')}`,
      );
      await stand.ev(
        page,
        `[...document.querySelectorAll('.search-more button.link')].find((b) => /Stop/.test(b.innerText)).click()`,
      );
      await waitFor(async () => /Search more/.test(await more()), 30000, 'the second stop');
    } finally {
      await stand.close();
    }
  },
};
