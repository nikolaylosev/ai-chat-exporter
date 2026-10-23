// The save button on a chat page: shown on a chat, not elsewhere; a click saves
// the chat like the keyboard shortcut; the setting hides it.
import assert from 'node:assert/strict';
import { startStand, waitFor } from '../harness.mjs';
import { fakeGrok, grokChats } from '../fakes.mjs';

const CHAT = 'https://grok.com/c/00000000-0000-4000-8000-000000000001';
const button = `document.getElementById('ai-chat-exporter-page-button')?.shadowRoot?.querySelector('button')`;

export default {
  name: 'page-button',
  async run(extDir) {
    const stand = await startStand({ extDir, ...fakeGrok({ chats: grokChats(['basic']) }) });
    try {
      const chat = await stand.openTab(CHAT);
      await waitFor(() => stand.ev(chat, `Boolean(${button})`), 20000, 'the button on a chat');
      await stand.ev(chat, `${button}.click()`);
      await waitFor(
        () => stand.files().some((f) => f.endsWith('(Grok).md')),
        30000,
        'the chat saved by the button',
      );

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
