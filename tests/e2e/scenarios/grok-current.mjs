// Grok: chats saved through its REST API; uploads and a generated image from
// assets.grok.com byte for byte.
import assert from 'node:assert/strict';
import { startStand } from '../harness.mjs';
import { fakeGrok, grokChats, uuid } from '../fakes.mjs';

export default {
  name: 'grok-current',
  async run(extDir) {
    const assets = {
      [`${uuid(0x10)}/content`]: Buffer.from('%PDF-1.4 grok pdf \u0000ÿ', 'latin1'),
      [`${uuid(0x11)}/content`]: Buffer.from('PK grok docx \u0001\u0002', 'latin1'),
      [`${uuid(0x12)}/content`]: Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(30), 'hex'),
      'image.jpg': Buffer.from('ffd8ffe000104a4649460001' + '11'.repeat(50) + 'ffd9', 'hex'),
    };
    const fake = fakeGrok({ chats: grokChats(['basic', 'uploads', 'image']), assets });
    const stand = await startStand({ extDir, ...fake });
    try {
      for (const path of [
        `/c/${uuid(1)}`,
        `/c/${uuid(1)}?rid=${uuid(4)}`,
        `/c/${uuid(6)}`,
        `/c/${uuid(0x14)}`,
      ]) {
        const result = await stand.exportTab(`https://grok.com${path}`);
        assert.equal(result.ok, true, path);
        assert.equal(result.failedAttachmentCount, 0, `${path} failed files`);
      }
      const all = stand.files();
      const expect = {
        'fruit-prices.pdf': assets[`${uuid(0x10)}/content`],
        'meeting-notes.docx': assets[`${uuid(0x11)}/content`],
        'stripes.png': assets[`${uuid(0x12)}/content`],
        'image.jpg': assets['image.jpg'],
      };
      for (const [name, bytes] of Object.entries(expect)) {
        const path = all.find((f) => f.endsWith(`/files/${name}`));
        assert.ok(path && stand.read(path).equals(bytes), `${name} byte-identical`);
      }
    } finally {
      await stand.close();
    }
  },
};
