// Saving a chat again. A chat that missed a file completes its earlier folder
// (no "(2)" copy, no "(1)" duplicates) even in the default "copy" mode; a complete
// chat then makes a copy, as set. In "overwrite" mode, a file the chat no longer
// has is deleted from the folder.
import assert from 'node:assert/strict';
import { startStand } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

const folders = (files) =>
  [...new Set(files.map((f) => f.split('/').slice(0, 2).join('/')))].sort();

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
    try {
      const first = await stand.exportTab(url);
      assert.equal(first.failedAttachmentCount, 1);
      docxBroken = false;
      const second = await stand.exportTab(url);
      assert.equal(second.failedAttachmentCount, 0);
      let all = stand.files();
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
      assert.equal(folders(stand.files()).length, 2, 'a complete chat makes a copy');

      // Overwrite mode: the png upload is renamed in the chat.
      await stand.settings({ onFolderExists: 'overwrite' });
      await stand.exportTab(url);
      for (const node of Object.values(chats[uuid(0x13)].mapping)) {
        for (const a of node.message?.metadata?.attachments ?? []) {
          if (a.name === 'stripes.png') a.name = 'stripes-renamed.png';
        }
      }
      await stand.exportTab(url);
      all = stand.files().filter((f) => f.startsWith(folders(stand.files()).at(-1)));
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
