// Saving a chat again into a folder the user chose (into Downloads a chat with
// files is one .zip). A chat that missed a file completes its earlier folder (no
// "(2)" copy, no "(1)" duplicates) even in the default "copy" mode; a complete
// chat then makes a copy, as set. In "overwrite" mode, a file the chat no longer
// has is deleted from the folder. The extension's private file system stands in
// for the chosen folder.
import assert from 'node:assert/strict';
import { startStand } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

const folders = (files) => [...new Set(files.map((f) => f.split('/')[0]))].sort();

const CHOOSE = `(async () => {
  const root = await navigator.storage.getDirectory();
  const db = await new Promise((ok, no) => { const r = indexedDB.open('ai-chat-exporter', 1); r.onupgradeneeded = () => r.result.createObjectStore('handles'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  await new Promise((ok, no) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(root, 'export-folder'); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  db.close();
  return 'ok';
})()`;
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
  name: 'folder-rewrite',
  async run(extDir) {
    const files = chatgptFiles();
    const chats = chatgptChats();
    let docxBroken = true;
    const fake = fakeChatgpt({
      chats,
      files,
      content: (fid, _req, res) => {
        if (fid !== chatgptFile(4) || !docxBroken) return false;
        res.writeHead(200, { 'content-length': '100' });
        res.write('PK');
        setTimeout(() => res.socket.destroy(), 100);
        return true;
      },
    });
    const stand = await startStand({ extDir, ...fake });
    const url = `https://chatgpt.com/c/${uuid(0x13)}`;
    const saved = () => stand.inExtension(LIST);
    try {
      await stand.inExtension(CHOOSE);
      await stand.settings({ destination: 'folder' });
      const first = await stand.exportTab(url);
      assert.equal(first.failedAttachmentCount, 1);
      docxBroken = false;
      const second = await stand.exportTab(url);
      assert.equal(second.failedAttachmentCount, 0);
      let all = await saved();
      assert.equal(folders(all).length, 1, 'the earlier folder was completed');
      assert.ok(
        all.some((f) => f.endsWith('/files/meeting-notes.docx')),
        'the docx is there now',
      );
      assert.deepEqual(
        all.filter((f) => / \(\d\)\./.test(f)),
        [],
        'no duplicates',
      );
      await stand.exportTab(url);
      assert.equal(folders(await saved()).length, 2, 'a complete chat makes a copy');

      // Overwrite mode: the png upload is renamed in the chat.
      await stand.settings({ onFolderExists: 'overwrite' });
      await stand.exportTab(url);
      for (const node of Object.values(chats[uuid(0x13)].mapping)) {
        for (const a of node.message?.metadata?.attachments ?? []) {
          if (a.name === 'stripes.png') a.name = 'stripes-renamed.png';
        }
      }
      await stand.exportTab(url);
      const now = await saved();
      all = now.filter((f) => f.startsWith(folders(now).at(-1)));
      assert.ok(
        all.some((f) => f.endsWith('/files/stripes-renamed.png')),
        'the new name is saved',
      );
      assert.ok(!all.some((f) => f.endsWith('/files/stripes.png')), 'the old file is gone');
    } finally {
      await stand.close();
    }
  },
};
