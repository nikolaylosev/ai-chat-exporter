// Speed: a chat's files are fetched a few at a time, the panel on the chat page
// counts them, and in a bulk export the next chat is read while the files of the
// current one are still coming.
import assert from 'node:assert/strict';
import { startStand, waitFor } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

const SLOW_MS = 1500;
const root = `document.getElementById('ai-chat-exporter-page-button')?.shadowRoot`;
const panel = `document.getElementById('ai-chat-exporter-panel')?.shadowRoot?.textContent ?? ''`;

export default {
  name: 'faster-files',
  async run(extDir) {
    const files = chatgptFiles();
    let running = 0;
    let most = 0;
    // Chats read by the time the uploads chat's pdf has arrived.
    let readsAtPdf = null;
    const fake = fakeChatgpt({
      chats: chatgptChats(),
      files,
      content: (fid, _req, res) => {
        if (!files[fid]) return false;
        running++;
        most = Math.max(most, running);
        setTimeout(() => {
          running--;
          if (fid === chatgptFile(2)) readsAtPdf = fake.state.conversationReads;
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(files[fid]);
        }, SLOW_MS);
        return true;
      },
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      // One chat: its three files at once, not one after another.
      const result = await stand.exportTab(`https://chatgpt.com/c/${uuid(0x13)}`);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(most >= 3, `files at the same time: ${most}`);

      // The page button's save: the panel counts the files as they arrive.
      const chat = await stand.openTab(`https://chatgpt.com/c/${uuid(0x13)}`);
      await waitFor(
        () => stand.ev(chat, `Boolean(${root}?.querySelector('button.round'))`),
        20000,
        'the button',
      );
      await stand.ev(chat, `${root}.querySelector('button.round').click()`);
      await waitFor(
        () => stand.ev(chat, `${root}.querySelectorAll('.menu button').length > 0`),
        5000,
        'the menu',
      );
      await stand.ev(chat, `${root}.querySelector('.menu button').click()`);
      const counted = await waitFor(
        async () => {
          const text = await stand.ev(chat, panel);
          return /Files: \d+ of \d+/.test(text) && text;
        },
        20000,
        'the file count',
      );
      assert.match(counted, /Files: \d+ of 3/);
      await waitFor(() => stand.ev(chat, `${panel}.includes('Saved')`), 30000, 'the result');

      // Two chats: the second is read while the first one's files arrive.
      await stand.settings({ delayBetweenChatsMs: 0 });
      const before = fake.state.conversationReads;
      const items = [uuid(0x13), uuid(0x27)].map((id) => ({ id, title: id, updatedAt: null }));
      await stand.inExtension(
        `chrome.runtime.sendMessage({ target: 'background', type: 'job:start', payload: { platform: 'chatgpt', items: ${JSON.stringify(items)} } })`,
      );
      const job = await waitFor(
        async () => {
          const j = await stand.job();
          return j && j.status === 'finished' && j;
        },
        60000,
        'the bulk export',
      );
      assert.deepEqual(job.counts, { done: 2 }, JSON.stringify(job.counts));
      assert.equal(readsAtPdf - before, 2, 'the next chat read before the first one was written');
    } finally {
      await stand.close();
    }
  },
};
