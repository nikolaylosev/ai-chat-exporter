// The button on a chat page: shown on a chat, not elsewhere; its menu saves the
// chat with its files (one .zip) or as text only, or copies it; the setting hides it.
import assert from 'node:assert/strict';
import { startStand, waitFor } from '../harness.mjs';
import { fakeGrok, grokChats, uuid } from '../fakes.mjs';

const CHAT = `https://grok.com/c/${uuid(6)}`;
const root = `document.getElementById('ai-chat-exporter-page-button')?.shadowRoot`;
const button = `${root}?.querySelector('button.round')`;
const items = `[...(${root}?.querySelectorAll('.menu button') ?? [])]`;
const panel = `document.getElementById('ai-chat-exporter-panel')?.shadowRoot?.textContent ?? ''`;

export default {
  name: 'page-button',
  async run(extDir) {
    const assets = {
      [`${uuid(0x10)}/content`]: Buffer.from('%PDF-1.4 grok pdf', 'latin1'),
      [`${uuid(0x11)}/content`]: Buffer.from('PK grok docx', 'latin1'),
      [`${uuid(0x12)}/content`]: Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(30), 'hex'),
    };
    const fake = fakeGrok({ chats: grokChats(['uploads']), assets });
    const stand = await startStand({ extDir, ...fake });
    const notes = () =>
      stand.files().filter((f) => f.endsWith('(Grok).md') || f.endsWith('(Grok) (2).md'));
    try {
      const chat = await stand.openTab(CHAT);
      await waitFor(() => stand.ev(chat, `Boolean(${button})`), 20000, 'the button on a chat');

      // The menu: three actions, the saves naming what they make.
      await stand.ev(chat, `${button}.click()`);
      const labels = await stand.ev(chat, `${items}.map((b) => b.textContent)`);
      assert.deepEqual(labels, [
        'Save chat with files.zip',
        'Save text only.md',
        'Copy as Markdown',
      ]);

      // With files: the note and the uploads.
      await stand.ev(chat, `${items}[0].click()`);
      await waitFor(() => notes().length === 1, 30000, 'the chat saved with files');
      await waitFor(
        () => stand.files().some((f) => f.endsWith('/files/fruit-prices.pdf')),
        30000,
        'its files',
      );
      assert.equal(await stand.ev(chat, `${items}.length`), 0, 'the menu closes');
      // The panel shows the result once the export has finished, record and all.
      await waitFor(() => stand.ev(chat, `${panel}.includes('AI Chats')`), 20000, 'the result');

      // Text only: a second note, no more files.
      const filesBefore = stand.files().filter((f) => f.includes('/files/')).length;
      await stand.ev(chat, `${button}.click()`);
      await stand.ev(chat, `${items}[1].click()`);
      await waitFor(() => notes().length === 2, 30000, 'the chat saved as text');
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(
        stand.files().filter((f) => f.includes('/files/')).length,
        filesBefore,
        'no files',
      );

      // Copy: the panel says it is on the clipboard.
      await stand.ev(chat, `${button}.click()`);
      await stand.ev(chat, `${items}[2].click()`);
      await waitFor(
        () => stand.ev(chat, `${panel}.includes('Copied to the clipboard')`),
        20000,
        'copied',
      );

      // Escape closes the menu (its listener is attached once the menu has rendered).
      await stand.ev(chat, `${button}.click()`);
      await waitFor(() => stand.ev(chat, `${items}.length === 3`), 5000, 'the menu open');
      await new Promise((r) => setTimeout(r, 200));
      await stand.ev(
        chat,
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`,
      );
      await waitFor(() => stand.ev(chat, `${items}.length === 0`), 5000, 'Escape closes the menu');

      const home = await stand.openTab('https://grok.com/');
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(await stand.ev(home, `Boolean(${button})`), false, 'no button off a chat');

      await stand.settings({ showPageButton: false });
      await waitFor(() => stand.ev(chat, `!${button}`), 10000, 'the button hidden by the setting');
    } finally {
      await stand.close();
    }
  },
};
