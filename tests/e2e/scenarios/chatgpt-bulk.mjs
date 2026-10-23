// ChatGPT bulk export: the history over two pages, archived chats and a project's
// chats, all saved as one ZIP; a file that never arrives brings its chats back on
// the next run, the others are skipped as unchanged.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runBulkJob, startStand, waitFor } from '../harness.mjs';
import { chatgptFile, chatgptFiles, fakeChatgpt, fixture, uuid } from '../fakes.mjs';

const { unzipSync } = createRequire(import.meta.url)('fflate');

export default {
  name: 'chatgpt-bulk',
  async run(extDir) {
    const chats = {};
    const history = [];
    const archived = [];
    const projectChats = [];
    for (let i = 1; i <= 110; i++) {
      const id = uuid(0x1000 + i);
      const base = JSON.stringify(
        fixture(
          'chatgpt',
          i % 25 === 0 ? 'conversation-uploads.json' : 'conversation-branches.json',
        ),
      );
      const source = JSON.parse(base).conversation_id;
      const chat = JSON.parse(base.replaceAll(source, id));
      const updated = Date.UTC(2026, 9, 14) - i * 3600e3;
      chat.title = `Stand chat ${i}`;
      // As on the real service: the conversation reports a later update than the list.
      chat.update_time = updated / 1000 + 3.5;
      chats[id] = chat;
      const item = {
        id,
        title: chat.title,
        create_time: new Date(chat.create_time * 1000).toISOString(),
        update_time: new Date(updated).toISOString(),
      };
      (i <= 105 ? history : i <= 108 ? archived : projectChats).push(item);
    }
    const files = chatgptFiles();
    const fake = fakeChatgpt({
      chats,
      files,
      history,
      archived,
      projects: [{ id: 'g-p-stand', name: 'Stand project', chats: projectChats }],
      // The docx never arrives: the connection drops halfway.
      content: (fid, _req, res) => {
        if (fid !== chatgptFile(4)) return false;
        res.writeHead(200, { 'content-length': '1000' });
        res.write('PK partial');
        setTimeout(() => res.socket.destroy(), 100);
        return true;
      },
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      await stand.settings({ skipUnchanged: true, delayBetweenChatsMs: 0 });
      await stand.openTab('https://chatgpt.com/');
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=chatgpt`,
      );
      await waitFor(
        () => stand.ev(page, `document.querySelectorAll('tbody tr').length >= 110`),
        60000,
        'the list',
      );
      const marked = await stand.ev(
        page,
        `[...document.querySelectorAll('tbody tr')].map((r) => r.textContent).filter((t) => /archived|Stand project/.test(t)).length`,
      );
      assert.equal(marked, 5, 'archived and project chats marked');

      // Every chat, as the user ticks "select all".
      await stand.ev(page, `document.querySelector('thead input[type=checkbox]').click()`);
      const first = await runBulkJob(stand, page);
      assert.deepEqual(first.counts, { done: 106, warning: 4 });
      const zip = stand.files().find((f) => f.endsWith('.zip'));
      const notes = Object.keys(unzipSync(stand.read(zip))).filter(
        (n) => n.endsWith('.md') && !n.includes('_reports/'),
      );
      assert.equal(notes.length, 110, 'a note per chat in the ZIP');

      const readsBefore = fake.state.conversationReads;
      const second = await runBulkJob(stand, page);
      assert.deepEqual(second.counts, { skipped: 106, warning: 4 });
      assert.equal(
        fake.state.conversationReads - readsBefore,
        4,
        'only chats that missed a file are read again',
      );
    } finally {
      await stand.close();
    }
  },
};
