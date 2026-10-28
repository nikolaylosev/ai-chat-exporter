// Searching the archive: notes saved as Markdown and as a Word document into a
// folder, and an HTML note inside a .zip export copied there, are all found from
// the search page, and so is the text of a chat's Word file inside that .zip;
// the author filter works, and the viewer marks the match and shows the note's
// image from the archive. The extension's private file system stands in for the
// folder.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sleep, startStand, waitFor } from '../harness.mjs';
import { fakeGrok, grokChats, uuid } from '../fakes.mjs';

const { strToU8, zipSync } = createRequire(import.meta.url)('fflate');

const KEEP = (key) => `(async () => {
  const root = await navigator.storage.getDirectory();
  const db = await new Promise((ok, no) => { const r = indexedDB.open('ai-chat-exporter', 1); r.onupgradeneeded = () => r.result.createObjectStore('handles'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  await new Promise((ok, no) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(root, '${key}'); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  db.close();
  return 'ok';
})()`;

export default {
  name: 'archive-search',
  async run(extDir) {
    const assets = {
      [`${uuid(0x10)}/content`]: Buffer.from('%PDF-1.4 grok pdf', 'latin1'),
      // The chat's meeting-notes.docx, a real Word document this time.
      [`${uuid(0x11)}/content`]: Buffer.from(
        zipSync({
          'word/document.xml': strToU8(
            '<w:document><w:body><w:p><w:r><w:t>Paint the fence turquoise</w:t></w:r></w:p></w:body></w:document>',
          ),
        }),
      ),
      [`${uuid(0x12)}/content`]: Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(30), 'hex'),
      'image.jpg': Buffer.from('ffd8ffe000104a4649460001' + '11'.repeat(50) + 'ffd9', 'hex'),
    };
    const stand = await startStand({
      extDir,
      ...fakeGrok({ chats: grokChats(['basic', 'uploads', 'image']), assets }),
    });
    try {
      // Into the folder: one chat as Markdown, one as a Word document.
      await stand.inExtension(KEEP('export-folder'));
      await stand.settings({ destination: 'folder', noteFormat: 'markdown' });
      assert.equal((await stand.exportTab(`https://grok.com/c/${uuid(1)}`)).ok, true);
      await stand.settings({ noteFormat: 'docx' });
      assert.equal((await stand.exportTab(`https://grok.com/c/${uuid(0x14)}`)).ok, true);
      // Into Downloads as HTML: a .zip, which is copied into the folder as it is.
      await stand.settings({ destination: 'downloads', noteFormat: 'html' });
      assert.equal((await stand.exportTab(`https://grok.com/c/${uuid(6)}`)).ok, true);
      const zip = stand.downloaded().find((f) => f.endsWith('.zip'));
      const base64 = stand.read(zip).toString('base64');
      await stand.inExtension(`(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('AI Chats', { create: true });
        const file = await dir.getFileHandle('export.zip', { create: true });
        const w = await file.createWritable();
        await w.write(Uint8Array.from(atob('${base64}'), (c) => c.charCodeAt(0)));
        await w.close();
        return 'ok';
      })()`);

      // The search page on that folder.
      await stand.inExtension(KEEP('search-folder'));
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/search/index.html`,
      );
      const box = `document.querySelector('input[type=search]')`;
      await waitFor(() => stand.ev(page, `Boolean(${box})`), 30000, 'the index');
      assert.match(await stand.ev(page, `${box}.placeholder`), /Search 3 chats/);

      const find = async (query, role = '') => {
        await stand.ev(
          page,
          `(() => {
            const who = document.querySelectorAll('.query select')[1];
            who.value = '${role}';
            who.dispatchEvent(new Event('change', { bubbles: true }));
            const box = ${box};
            box.value = ${JSON.stringify(query)};
            box.dispatchEvent(new Event('input', { bubbles: true }));
          })()`,
        );
        await sleep(300);
        return stand.ev(
          page,
          `[...document.querySelectorAll('.hits li')].map((li) => li.querySelector('.title').textContent + ' | ' + li.querySelector('.snippet').textContent)`,
        );
      };

      const banana = await find('banana');
      assert.ok(
        banana.length >= 1 && banana.every((h) => /fruits list/.test(h)),
        banana.join('\n'),
      );
      assert.deepEqual(await find('banana', 'user'), [], 'not in the user messages');
      const fence = await find('fence');
      assert.ok(
        fence.some((h) => /File Summaries/.test(h)),
        `the HTML note in the zip: ${fence}`,
      );
      const circle = await find('"red circle"', 'user');
      assert.ok(
        circle.some((h) => /Image Test/.test(h)),
        `the Word note: ${circle}`,
      );

      // The text of a chat's file inside the .zip.
      const turquoise = await stand.ev(
        page,
        `(async () => {
          // Files have no author: the author filter goes back to everyone first.
          const who = document.querySelectorAll('.query select')[1];
          who.value = '';
          who.dispatchEvent(new Event('change', { bubbles: true }));
          const box = ${box};
          box.value = 'turquoise';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 300));
          return [...document.querySelectorAll('.hits li .meta')].map((m) => m.textContent);
        })()`,
      );
      assert.ok(
        turquoise.some((m) => m.includes('📎 meeting-notes.docx')),
        `the file's text: ${turquoise}`,
      );

      // The viewer shows the note with the match marked.
      await find('fence');
      await stand.ev(page, `document.querySelector('.hits li').click()`);
      const marked = await waitFor(
        () =>
          stand.ev(
            page,
            `document.querySelector('.viewer iframe')?.contentDocument?.querySelector('mark')?.textContent ?? ''`,
          ),
        10000,
        'the marked match',
      );
      assert.equal(marked.toLowerCase(), 'fence');
      // The note's image, read from the .zip.
      const image = await waitFor(
        () =>
          stand.ev(
            page,
            `(() => { const img = document.querySelector('.viewer iframe')?.contentDocument?.querySelector('img'); return img && img.src.startsWith('blob:') && img.complete && img.naturalWidth >= 0 ? img.src : ''; })()`,
          ),
        10000,
        'the image from the archive',
      );
      assert.match(image, /^blob:/);
    } finally {
      await stand.close();
    }
  },
};
