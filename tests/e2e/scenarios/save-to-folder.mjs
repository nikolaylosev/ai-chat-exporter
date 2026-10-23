// "Save to a folder…": the window opens for the chat's tab, and the chat with its
// files is written straight into the chosen folder. The picker cannot be clicked
// on a stand, so the extension's own private file system stands in for the folder.
import assert from 'node:assert/strict';
import { startStand, waitFor } from '../harness.mjs';
import { fakeGrok, grokChats, uuid } from '../fakes.mjs';

const LIST = `(async () => {
  const out = [];
  const walk = async (dir, prefix) => {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'directory') await walk(entry, prefix + name + '/');
      else out.push(prefix + name);
    }
  };
  await walk(await navigator.storage.getDirectory(), '');
  return out;
})()`;

export default {
  name: 'save-to-folder',
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
      // The chosen folder: stored where the options page keeps it.
      await stand.inExtension(`(async () => {
        const root = await navigator.storage.getDirectory();
        const db = await new Promise((ok, no) => { const r = indexedDB.open('ai-chat-exporter', 1); r.onupgradeneeded = () => r.result.createObjectStore('handles'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
        await new Promise((ok, no) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(root, 'export-folder'); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
        db.close();
        return 'ok';
      })()`);
      const tabId = await stand.inExtension(
        `chrome.tabs.create({ url: 'https://grok.com/c/${uuid(6)}', active: false }).then((t) => t.id)`,
      );
      await new Promise((r) => setTimeout(r, 2500));

      // The popup's folder button opens the window for that tab.
      await stand.inExtension(
        `chrome.runtime.sendMessage({ target: 'background', type: 'folder:pick', payload: { tabId: ${tabId} } })`,
      );
      await waitFor(
        async () =>
          (await stand.targets()).some((t) =>
            t.url.includes(`pick-folder/index.html?tab=${tabId}`),
          ),
        10000,
        'the folder window',
      );

      // What the window does once a folder is chosen.
      const result = await stand.inExtension(
        `chrome.runtime.sendMessage({ target: 'background', type: 'export:to-folder', payload: { tabId: ${tabId} } })`,
      );
      assert.equal(result?.value?.ok, true, JSON.stringify(result));
      const files = await stand.inExtension(LIST);
      assert.ok(
        files.some((f) => /\(Grok\)\.md$/.test(f)),
        JSON.stringify(files),
      );
      assert.ok(
        files.some((f) => f.endsWith('/files/fruit-prices.pdf')),
        'its files in the folder',
      );
      assert.equal(
        stand.files().filter((f) => !f.startsWith('.')).length,
        0,
        'nothing in Downloads',
      );
    } finally {
      await stand.close();
    }
  },
};
