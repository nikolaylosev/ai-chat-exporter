// Saving into an Obsidian vault (the chosen folder with `.obsidian/app.json`): the
// chat goes under "AI Chats/ChatGPT", its files into the vault's attachment folder
// in a folder of its own, links are wikilinks and images show in the note. The
// user then adds a property and their own notes; saving again updates the same
// note, keeps both, and drops a file the chat no longer has. The extension's
// private file system stands in for the vault.
import assert from 'node:assert/strict';
import { startStand } from '../harness.mjs';
import { chatgptChats, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

const OPFS = `navigator.storage.getDirectory()`;
const CHOOSE = `(async () => {
  const root = await ${OPFS};
  const config = await root.getDirectoryHandle('.obsidian', { create: true });
  const file = await config.getFileHandle('app.json', { create: true });
  const w = await file.createWritable();
  await w.write(JSON.stringify({ attachmentFolderPath: 'Attachments', newLinkFormat: 'shortest' }));
  await w.close();
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
  await walk(await ${OPFS}, '');
  return out;
})()`;
const at = (path) => `(async () => {
  let dir = await ${OPFS};
  const parts = ${JSON.stringify(path)}.split('/');
  const name = parts.pop();
  for (const p of parts) dir = await dir.getDirectoryHandle(p);
  return dir.getFileHandle(name);
})()`;
const READ = (path) => `${at(path)}.then((f) => f.getFile()).then((f) => f.text())`;
const WRITE = (path, text) =>
  `${at(path)}.then(async (f) => { const w = await f.createWritable(); await w.write(${JSON.stringify(text)}); await w.close(); return 'ok'; })`;

export default {
  name: 'obsidian-vault',
  async run(extDir) {
    const chats = chatgptChats();
    const fake = fakeChatgpt({ chats, files: chatgptFiles() });
    const stand = await startStand({ extDir, ...fake });
    const url = `https://chatgpt.com/c/${uuid(0x13)}`;
    try {
      await stand.inExtension(CHOOSE);
      await stand.settings({ destination: 'folder', obsidian: true });
      const first = await stand.exportTab(url);
      assert.equal(first.failedAttachmentCount, 0);
      assert.match(
        first.location.obsidian,
        /^obsidian:\/\/open\?vault=.*&file=AI%20Chats%2FChatGPT%2F/,
      );

      const all = await stand.inExtension(LIST);
      const note = all.find((f) => f.startsWith('AI Chats/ChatGPT/') && f.endsWith('.md'));
      assert.ok(note, `the note under AI Chats/ChatGPT: ${all.join(', ')}`);
      const folder = note.split('/')[2];
      assert.equal(note, `AI Chats/ChatGPT/${folder}/${folder}.md`);
      assert.equal(first.location.path, note);
      const image = `Attachments/${folder}/stripes.png`;
      assert.ok(all.includes(image), 'files in the attachment folder, in a folder of the chat');
      assert.ok(!all.some((f) => f.includes('/files/')), 'no files/ beside the note');

      const text = await stand.inExtension(READ(note));
      assert.ok(text.includes(`![[${image}]]`), 'the image shows in the note');
      assert.match(text, /- \[\[Attachments\/.+\|.+\]\]/, 'other files as wikilinks');
      assert.match(text, /## My notes\n\n%% ai-chat-exporter:keep .* %%\n$/);

      // The user tags the note and writes under "My notes".
      const edited = text
        .replace('\n---\n', '\nrating: 5\n---\n')
        .replace(/(%% ai-chat-exporter:keep .* %%\n)$/, '$1My own thought.\n');
      await stand.inExtension(WRITE(note, edited));

      // The png is renamed in the chat; saving again updates the same note.
      for (const node of Object.values(chats[uuid(0x13)].mapping)) {
        for (const a of node.message?.metadata?.attachments ?? []) {
          if (a.name === 'stripes.png') a.name = 'stripes-renamed.png';
        }
      }
      const second = await stand.exportTab(url);
      assert.equal(second.location.path, note, 'the same note');
      const now = await stand.inExtension(LIST);
      assert.deepEqual(
        now.filter((f) => f.endsWith('.md')),
        [note],
        'one note for the chat, no copy',
      );
      assert.ok(now.includes(`Attachments/${folder}/stripes-renamed.png`), 'the new name');
      assert.ok(!now.includes(image), 'the old file is gone');
      const updated = await stand.inExtension(READ(note));
      assert.match(updated, /\nrating: 5\n---\n/, "the user's property is kept");
      assert.match(updated, /%%\nMy own thought\.\n$/, "the user's notes are kept");
      assert.ok(updated.includes('stripes-renamed.png'), 'the chat is as it is now');
    } finally {
      await stand.close();
    }
  },
};
