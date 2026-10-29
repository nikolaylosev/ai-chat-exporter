// Chats from Google Takeout on the export page: the activity file links to chats
// the list does not reach; they are asked of Gemini one by one, join the table,
// are remembered after a reload and export like any other.
import assert from 'node:assert/strict';
import { runBulkJob, sleep, startStand, waitFor } from '../harness.mjs';
import { fakeGemini, fixture } from '../fakes.mjs';
import { geminiAccount } from '../gemini-list.mjs';

const OLD = ['d000000000000001', 'd000000000000002', 'd000000000000003'];
const GONE = 'e000000000000001';
const LISTED = 'a000000000000001';

export default {
  name: 'gemini-takeout',
  async run(extDir) {
    const account = geminiAccount();
    // Old chats Gemini still has, past the depth its list answers.
    const basic = JSON.stringify(fixture('gemini', 'conversation-basic.json'));
    OLD.forEach((id, i) => {
      account.chats[id] = JSON.parse(
        basic
          .replaceAll('c_0000000000000001', `c_${id}`)
          .replaceAll('Fruit List and Python Code', `Takeout chat ${i + 1}`),
      );
    });
    const fake = fakeGemini(account);
    const stand = await startStand({ extDir, ...fake });
    try {
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=gemini`,
      );
      const rows = () => stand.ev(page, `document.querySelectorAll('tbody tr').length`);
      const text = () => stand.ev(page, `document.querySelector('.search-more')?.innerText ?? ''`);
      await waitFor(async () => (await rows()) >= 61, 60000, 'the list');

      // The activity as Takeout writes it: one record per prompt.
      const activity = [...OLD, GONE, LISTED, OLD[0]].map((id, i) => ({
        header: 'Gemini Apps',
        title: 'Prompted something',
        time: `2025-0${i + 1}-01T10:00:00.000Z`,
        products: ['Gemini Apps'],
        details: [{ name: 'x', url: `https://gemini.google.com/app/${id}` }],
      }));
      await stand.ev(
        page,
        `(() => {
          const input = document.querySelector('.search-more input[type=file]');
          const files = new DataTransfer();
          files.items.add(new File([${JSON.stringify(JSON.stringify(activity))}], 'MyActivity.json'));
          input.files = files.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok';
        })()`,
      );
      await waitFor(async () => /Takeout: 3 chats added/.test(await text()), 30000, 'the import');
      assert.match(
        await text(),
        /Takeout: 3 chats added, 1 were already here, 1 no longer on Gemini/,
      );
      assert.match(await text(), /61 chats from the list, 0 found by search, 3 from Takeout/);
      assert.equal(await rows(), 64);
      // Only the chats from Takeout.
      const pickSource = (value) =>
        stand.ev(
          page,
          `(() => {
            const source = [...document.querySelectorAll('.filters select')].find((s) =>
              [...s.options].some((o) => o.value === 'takeout'),
            );
            source.value = ${JSON.stringify(value)};
            source.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
          })()`,
        );
      await pickSource('takeout');
      await waitFor(async () => (await rows()) === 3, 5000, 'only the chats from Takeout');
      assert.match(
        await stand.ev(page, `document.querySelector('.filters').innerText`),
        /Google Takeout \(3\)/,
      );

      // Remembered after a reload, marked as from Takeout.
      await stand.ev(page, 'location.reload()');
      await sleep(1500);
      // The source chosen is remembered too; then all of them again.
      await waitFor(async () => (await rows()) === 3, 60000, 'the remembered chats and filter');
      await pickSource('all');
      await waitFor(async () => (await rows()) >= 64, 10000, 'all the chats');
      const row = `[...document.querySelectorAll('tbody tr')].find((r) => /Takeout chat 2/.test(r.innerText))`;
      assert.match(await stand.ev(page, `${row}.innerText`), /from Takeout/);

      // It exports like any other chat.
      await stand.ev(page, `${row}.querySelector('input[type=checkbox]').click()`);
      const job = await runBulkJob(stand, page);
      assert.deepEqual(job.counts, { done: 1 });
      assert.ok(
        stand.files().some((f) => f.includes('Takeout chat 2')),
        stand.files().join(', '),
      );
    } finally {
      await stand.close();
    }
  },
};
