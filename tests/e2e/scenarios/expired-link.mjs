// ChatGPT's signed link for the pdf has expired by the time the file is written:
// the extension asks the tab for a new one, into Downloads (the chat's .zip) and
// into a folder the user chose (separate files; the extension's private file
// system stands in for the folder).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startStand } from '../harness.mjs';
import { chatgptChats, chatgptFile, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

const { unzipSync } = createRequire(import.meta.url)('fflate');

const CHOOSE = `(async () => {
  const root = await navigator.storage.getDirectory();
  const db = await new Promise((ok, no) => { const r = indexedDB.open('ai-chat-exporter', 1); r.onupgradeneeded = () => r.result.createObjectStore('handles'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  await new Promise((ok, no) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(root, 'export-folder'); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  db.close();
  return 'ok';
})()`;
/** The pdf in the chosen folder, as base64. */
const READ_PDF = `(async () => {
  const find = async (dir) => {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'directory') { const hit = await find(entry); if (hit) return hit; }
      else if (name === 'fruit-prices.pdf') return entry;
    }
    return null;
  };
  const file = await (await find(await navigator.storage.getDirectory())).getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
})()`;

export default {
  name: 'expired-link',
  async run(extDir) {
    const files = chatgptFiles();
    const fake = fakeChatgpt({
      chats: chatgptChats(),
      files,
      // The first link of each run (n1) is refused for the pdf; later ones work.
      content: (fid, _req, res, url) => {
        if (fid !== chatgptFile(2) || url.searchParams.get('sig') !== 'n1') return false;
        res.writeHead(403);
        res.end();
        return true;
      },
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      await stand.inExtension(CHOOSE);
      for (const destination of ['downloads', 'folder']) {
        await stand.settings({ destination });
        fake.state.links = 0;
        const result = await stand.exportTab(`https://chatgpt.com/c/${uuid(0x13)}`);
        assert.equal(result.failedAttachmentCount, 0, `nothing failed (${destination})`);
        assert.equal(fake.state.links, 4, `three links and one renewed (${destination})`);
      }
      const zip = stand.downloaded().find((f) => f.endsWith('.zip'));
      const entries = unzipSync(stand.read(zip));
      const inZip = Object.entries(entries).find(([n]) => n.endsWith('fruit-prices.pdf'));
      assert.ok(inZip && Buffer.from(inZip[1]).equals(files[chatgptFile(2)]), 'pdf in the .zip');
      const inFolder = Buffer.from(await stand.inExtension(READ_PDF), 'base64');
      assert.ok(inFolder.equals(files[chatgptFile(2)]), 'pdf in the folder');
    } finally {
      await stand.close();
    }
  },
};
