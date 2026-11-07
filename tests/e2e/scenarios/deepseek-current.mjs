// DeepSeek: chats saved through its API with the page's token; a document byte for
// byte by `ty=r`, an image as its JPEG preview by `ty=p` (marked so in the note),
// from a file host that sends no CORS headers; citations as links; an edited
// prompt's other version as a branch; old uploads named without a file; then every
// chat from the export page in one job.
import assert from 'node:assert/strict';
import { runBulkJob, startStand, waitFor } from '../harness.mjs';
import { deepseekHistories, fakeDeepseek, uuid } from '../fakes.mjs';

export default {
  name: 'deepseek-current',
  async run(extDir) {
    const files = {
      [uuid(5)]: { image: false, bytes: Buffer.from('Plain text upload \u0000ÿ', 'latin1') },
      [uuid(3)]: {
        image: true,
        preview: Buffer.from('ffd8ffe000104a4649460001' + '22'.repeat(60) + 'ffd9', 'hex'),
      },
    };
    const fake = fakeDeepseek({
      histories: deepseekHistories([
        'search-think',
        'image-upload',
        'text-upload',
        'edited',
        'old-upload',
      ]),
      files,
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      for (const n of [1, 2, 4, 6, 7]) {
        const result = await stand.exportTab(`https://chat.deepseek.com/a/chat/s/${uuid(n)}`);
        assert.equal(result.ok, true, `chat ${n}`);
        // Chat 7's two old uploads have no file left on the server: named, not saved.
        assert.equal(result.failedAttachmentCount, n === 7 ? 2 : 0, `chat ${n} failed files`);
      }
      const all = stand.files();
      const doc = all.find((f) => f.endsWith('/files/notes-1.txt'));
      assert.ok(doc && stand.read(doc).equals(files[uuid(5)].bytes), 'the document byte-identical');
      const image = all.find((f) => f.endsWith('/files/picture-1.jpg'));
      assert.ok(
        image && stand.read(image).equals(files[uuid(3)].preview),
        'the image preview saved',
      );
      assert.ok(
        fake.state.fileRequests.includes(`${uuid(3)}:p:jpeg`) &&
          fake.state.fileRequests.includes(`${uuid(5)}:r:`),
        'documents by ty=r, images by ty=p as JPEG',
      );
      assert.equal(fake.state.noAuth, 0, 'every API request had the token');
      assert.equal(fake.state.tokenOnFiles, 0, 'the token never went to the file host');

      const note = (part) => {
        const path = all.find((f) => f.endsWith('.md') && f.includes(part));
        assert.ok(path, `note for ${part}`);
        return stand.read(path).toString('utf8');
      };
      const imageNote = note('image-upload');
      assert.match(
        imageNote,
        /picture-1\.jpg\]\([^)]*\) \(a smaller preview/,
        'the preview is marked',
      );
      const search = note('search-think');
      assert.match(search, /Claim 1 \(\[Example 6\]\(https:\/\/example\.com\/source-6\)\)/);
      assert.doesNotMatch(search, /\[citation:\d+\]/);
      const old = note('old-upload');
      assert.match(
        old,
        /picture-1\.png — could not download: the service does not provide this file/,
        'an old upload is named',
      );
      const edited = note('France capital test');
      assert.match(edited, /Synthetic question/, 'the edited chat saved');

      // The export page: the list from the API, every chat in one job.
      await stand.settings({ delayBetweenChatsMs: 0 });
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=deepseek`,
      );
      await waitFor(
        () => stand.ev(page, `document.querySelectorAll('tbody tr').length === 5`),
        60000,
        'the list',
      );
      await stand.ev(page, `document.querySelector('thead input[type=checkbox]').click()`);
      const job = await runBulkJob(stand, page);
      // The chat with the old uploads ends with a warning, the others are done.
      assert.deepEqual(job.counts, { done: 4, warning: 1 });
    } finally {
      await stand.close();
    }
  },
};
