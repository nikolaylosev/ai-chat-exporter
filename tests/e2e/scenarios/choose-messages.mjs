// Choosing messages: the page lists the chat's messages; the chosen ones are
// saved in the chat's order with their files only, the note says how many of the
// chat it holds, and Copy puts only them on the clipboard.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startStand, waitFor } from '../harness.mjs';
import { fakeGrok, grokChats, uuid } from '../fakes.mjs';

const { strFromU8, unzipSync } = createRequire(import.meta.url)('fflate');

const rows = `[...document.querySelectorAll('.messages li')]`;

export default {
  name: 'choose-messages',
  async run(extDir) {
    const assets = {
      [`${uuid(0x10)}/content`]: Buffer.from('%PDF-1.4 grok pdf', 'latin1'),
      [`${uuid(0x11)}/content`]: Buffer.from('PK grok docx', 'latin1'),
      [`${uuid(0x12)}/content`]: Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(30), 'hex'),
    };
    const stand = await startStand({
      extDir,
      ...fakeGrok({ chats: grokChats(['uploads']), assets }),
    });
    try {
      const tabId = await stand.inExtension(
        `chrome.tabs.create({ url: 'https://grok.com/c/${uuid(6)}', active: false }).then((t) => t.id)`,
      );
      await new Promise((r) => setTimeout(r, 2500));
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/messages/index.html?tab=${tabId}`,
      );
      const total = await waitFor(
        async () => (await stand.ev(page, `${rows}.length`)) || 0,
        30000,
        'the messages',
      );
      assert.ok(total >= 2, `messages listed: ${total}`);
      const list = await stand.ev(
        page,
        `${rows}.map((r) => ({ files: r.querySelector('.files')?.textContent ?? '', text: r.querySelector('.text')?.textContent ?? '' }))`,
      );
      // The first message with files, and the last message.
      const withFiles = list.findIndex((m) => m.files);
      assert.ok(withFiles >= 0, 'a message with files');
      const last = total - 1;
      assert.notEqual(withFiles, last);
      await stand.ev(page, `${rows}[${last}].click()`);
      await stand.ev(page, `${rows}[${withFiles}].click()`);
      assert.match(await stand.ev(page, `document.querySelector('.count').textContent`), /2 of/);

      await stand.ev(page, `document.querySelector('.actions button.primary').click()`);
      const saved = await waitFor(
        () => stand.ev(page, `document.querySelector('.outcome')?.textContent ?? ''`),
        30000,
        'the result',
      );
      assert.match(saved, /Done: 2 messages/, saved);

      const zip = stand.downloaded().find((f) => f.endsWith('.zip'));
      assert.ok(zip, JSON.stringify(stand.downloaded()));
      const entries = unzipSync(stand.read(zip));
      const names = Object.keys(entries);
      const note = strFromU8(entries[names.find((n) => n.endsWith('.md'))]);
      assert.match(note, new RegExp(`\\*2 of the chat's ${total} messages\\*`));
      assert.match(note, new RegExp(`chosen_from: ${total}`));
      // Only the files of the chosen message.
      const expected = list[withFiles].files.replace(/^Files: /, '').split(', ');
      const saved_files = names.filter((n) => n.includes('/files/')).map((n) => n.split('/').pop());
      assert.deepEqual(saved_files.sort(), [...expected].sort());

      // A copy beside the chat's export: the registry does not record it.
      const registry = await stand.inExtension(
        `chrome.storage.local.get('registry').then((d) => JSON.stringify(d.registry ?? {}))`,
      );
      assert.ok(!registry.includes(uuid(6)), 'not in the registry');

      // Copy: only the chosen messages.
      const copied = await stand.ev(
        page,
        `(async () => {
          let text = '';
          navigator.clipboard.writeText = async (t) => { text = t; };
          document.querySelector('.actions button:not(.primary)').click();
          for (let i = 0; i < 100 && !text; i++) await new Promise((r) => setTimeout(r, 100));
          return text;
        })()`,
      );
      assert.match(copied, /chosen_from: /);
      assert.equal((copied.match(/^## /gm) ?? []).length, 2, 'two messages copied');
    } finally {
      await stand.close();
    }
  },
};
