// Gemini: chats saved through batchexecute; uploaded documents byte-identical; a
// generated image saved; a Gem chat names its Gem.
import assert from 'node:assert/strict';
import { startStand } from '../harness.mjs';
import { fakeGemini, geminiChats } from '../fakes.mjs';

export default {
  name: 'gemini-current',
  async run(extDir) {
    const documents = {
      'fruit-prices.pdf': Buffer.from('%PDF-1.4 stand pdf \u0000ÿ', 'latin1'),
      'meeting-notes.docx': Buffer.from('PK stand docx \u0001\u0002', 'latin1'),
    };
    const image = Buffer.from('ffd8ffe000104a4649460001' + '00'.repeat(40) + 'ffd9', 'hex');
    const fake = fakeGemini({
      chats: geminiChats(['basic', 'long', 'image', 'canvas', 'gem', 'upload-documents']),
      documents,
      image,
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      for (const path of [
        '/app/0000000000000001',
        '/app/0000000000000006',
        '/app/000000000000002a',
        '/app/000000000000001d',
        '/gem/brainstormer/0000000000000024',
        '/app/0000000000000021',
      ]) {
        const result = await stand.exportTab(`https://gemini.google.com${path}`);
        assert.equal(result.ok, true, path);
        assert.equal(result.failedAttachmentCount, 0, `${path} failed files`);
      }
      const all = stand.files();
      for (const [name, bytes] of Object.entries(documents)) {
        const path = all.find((f) => f.endsWith(`/files/${name}`));
        assert.ok(path && stand.read(path).equals(bytes), `${name} byte-identical`);
      }
      const note = (needle) =>
        stand.read(all.find((f) => f.includes(needle) && f.endsWith('.md'))).toString();
      assert.match(note('Fruit Stand'), /project: "Brainstormer"/, 'the Gem is named');
      assert.ok(!note('Apple Document').includes('file-tag'), 'no file tags left');
    } finally {
      await stand.close();
    }
  },
};
