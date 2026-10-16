// A Gemini notebook from the export page: its folder under Notebooks/, a note
// listing its source (Gemini gives no file for it) and linking its four chats,
// each saved in chats/.
import assert from 'node:assert/strict';
import { runBulkJob, startStand, waitFor } from '../harness.mjs';
import { fakeGemini, fixture } from '../fakes.mjs';

const NOTEBOOK = 'notebooks/00000000-0000-4000-8000-0000000000b0';

export default {
  name: 'gemini-notebook',
  async run(extDir) {
    const basic = JSON.stringify(fixture('gemini', 'conversation-basic.json'));
    const chats = {};
    for (const [i, id] of [
      '0000000000000031',
      '0000000000000033',
      '0000000000000035',
      '0000000000000037',
    ].entries()) {
      const chat = JSON.parse(
        basic
          .replaceAll('c_0000000000000001', `c_${id}`)
          .replaceAll('Fruit List and Python Code', `Notebook chat ${i + 1}`),
      );
      // Gemini names the notebook in each of its chats' metadata.
      chat.meta[2][0][7] = NOTEBOOK;
      chats[id] = chat;
    }
    const fake = fakeGemini({
      chats,
      notebooks: {
        list: fixture('gemini', 'notebooks-list.json'),
        bot: fixture('gemini', 'notebook-get.json'),
        chats: fixture('gemini', 'notebook-chats.json'),
      },
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      await stand.settings({ delayBetweenChatsMs: 0 });
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=gemini&tab=projects`,
      );
      await waitFor(
        () => stand.ev(page, `document.querySelectorAll('tbody tr').length === 1`),
        60000,
        'the notebook list',
      );
      await stand.ev(page, `document.querySelector('tbody input[type=checkbox]').click()`);
      const job = await runBulkJob(stand, page);
      assert.deepEqual(job.counts, { done: 5 }, 'the notebook and its four chats');
      const all = stand.files();
      const folder = 'AI Chats/Notebooks/Test notebook about fruit (Gemini)';
      const note = stand.read(`${folder}/Test notebook about fruit (Gemini).md`).toString();
      assert.match(note, /type: notebook/);
      assert.match(note, /- fruit-prices\.pdf — the service keeps this file without a download/);
      assert.match(
        note,
        /\(https:\/\/notebooklm\.google\.com\/notebook\/00000000-0000-4000-8000-0000000000b0\)/,
      );
      assert.equal((note.match(/\]\(chats\//g) ?? []).length, 4, 'the note links the four chats');
      const chatNotes = all.filter((f) => f.startsWith(`${folder}/chats/`) && f.endsWith('.md'));
      assert.equal(chatNotes.length, 4, 'four chat notes in chats/');
      assert.match(stand.read(chatNotes[0]).toString(), /project: "Test notebook about fruit"/);
    } finally {
      await stand.close();
    }
  },
};
