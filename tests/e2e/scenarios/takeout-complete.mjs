// Completing saved Gemini chats from Google Takeout: a chat is saved into the
// folder (the extension's private file system stands in for it), then the
// Takeout page reads a Takeout .zip that holds a prompt the chat does not show,
// with its file, and adds both to the chat: the file into its files/ folder and
// the prompt as a section at the end of its note.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startStand, waitFor } from '../harness.mjs';
import { fakeGemini, geminiChats } from '../fakes.mjs';

const { strToU8, zipSync } = createRequire(import.meta.url)('fflate');

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
const READ = (path) => `(async () => {
  let dir = await navigator.storage.getDirectory();
  const parts = ${JSON.stringify(path)}.split('/');
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
})()`;

export default {
  name: 'takeout-complete',
  async run(extDir) {
    const stand = await startStand({ extDir, ...fakeGemini({ chats: geminiChats(['basic']) }) });
    try {
      await stand.settings({ destination: 'folder', noteFormat: 'markdown' });
      await stand.inExtension(`(async () => {
        const root = await navigator.storage.getDirectory();
        const db = await new Promise((ok, no) => { const r = indexedDB.open('ai-chat-exporter', 1); r.onupgradeneeded = () => r.result.createObjectStore('handles'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
        await new Promise((ok, no) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(root, 'export-folder'); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
        db.close();
        return 'ok';
      })()`);
      assert.equal(
        (await stand.exportTab('https://gemini.google.com/app/0000000000000001')).ok,
        true,
      );
      const note = (await stand.inExtension(LIST)).find((p) => p.endsWith('.md'));
      assert.ok(note, 'the saved note');
      const folder = note.slice(0, note.lastIndexOf('/') + 1);

      // Takeout: a prompt of this chat the chat does not show, years before it, with a PDF.
      const activity = [
        {
          header: 'Gemini Apps',
          title: 'Prompted an older question',
          time: '2020-01-02T03:04:05.000Z',
          details: [{ name: 'x', url: 'https://gemini.google.com/app/0000000000000001' }],
          safeHtmlItem: [{ html: '<p>An older answer</p>' }],
          attachedFiles: ['plan-0123456789abcdef.pdf'],
        },
      ];
      const zip = Buffer.from(
        zipSync({
          'Takeout/My Activity/Gemini Apps/MyActivity.json': strToU8(JSON.stringify(activity)),
          'Takeout/My Activity/Gemini Apps/plan-0123456789abcdef.pdf': strToU8('%PDF plan'),
        }),
      ).toString('base64');

      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/takeout/index.html`,
      );
      const text = () => stand.ev(page, `document.querySelector('main').innerText`);
      const click = (label) =>
        stand.ev(
          page,
          `[...document.querySelectorAll('button')].find((b) => b.innerText.startsWith(${JSON.stringify(label)})).click()`,
        );
      await waitFor(
        async () => /Use the export folder/.test(await text()),
        30000,
        'the export folder offered',
      );
      await click('Use the export folder');
      await waitFor(async () => /Saved chats:/.test(await text()), 10000, 'the folder chosen');
      await stand.ev(
        page,
        `(() => {
          const bytes = Uint8Array.from(atob(${JSON.stringify(zip)}), (c) => c.charCodeAt(0));
          const files = new DataTransfer();
          files.items.add(new File([bytes], 'takeout-20200101-1-001.zip'));
          const input = document.querySelector('input[type=file]');
          input.files = files.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok';
        })()`,
      );
      await waitFor(async () => /Takeout: takeout-/.test(await text()), 10000, 'Takeout chosen');
      await click('Check');
      await waitFor(async () => /would get something/.test(await text()), 30000, 'the check');
      assert.match(await text(), /1 chats would get something from Takeout: 1 files and 1 prompts/);
      assert.ok(
        !(await stand.inExtension(LIST)).some((p) => p.endsWith('plan.pdf')),
        'nothing written by the check',
      );

      await click('Add them');
      await waitFor(async () => /Added to 1 chats/.test(await text()), 30000, 'the addition');
      const files = await stand.inExtension(LIST);
      assert.ok(files.includes(`${folder}files/plan.pdf`), files.join(', '));
      assert.ok(
        files.some((p) => /^_reports\/takeout-.*\.md$/.test(p)),
        'the report',
      );
      assert.equal(await stand.inExtension(READ(`${folder}files/plan.pdf`)), '%PDF plan');
      const saved = await stand.inExtension(READ(note));
      assert.match(saved, /## From Google Takeout/);
      assert.match(saved, /### User · 2020-01-02 \d\d:04\n\nan older question/);
      assert.match(saved, /\[plan\.pdf\]\(files\/plan\.pdf\)/);
      assert.match(saved, /### Gemini · .*\n\nAn older answer/);

      // Again: nothing more.
      await click('Check');
      await waitFor(
        async () => /would get something|already have everything/.test(await text()),
        30000,
        'the second check',
      );
      assert.match(await text(), /1 chats would get something from Takeout: 1 files and 1 prompts/);
      await click('Add them');
      await waitFor(
        async () => /Added to 1 chats/.test(await text()),
        30000,
        'the second addition',
      );
      assert.equal((await stand.inExtension(LIST)).filter((p) => p.includes('plan')).length, 1);
      assert.equal(
        (await stand.inExtension(READ(note))).match(/## From Google Takeout/g).length,
        1,
      );
    } finally {
      await stand.close();
    }
  },
};
