// Saving into Obsidian through its Local REST API plugin (a fake one on
// 127.0.0.1, with the key checked and the vault's `.obsidian` refused, as the
// plugin does by default): the attachment folder typed in the settings is used,
// files and the note are PUT from the service worker, the user's additions
// survive a second save, a file the chat no longer has is deleted, and the
// result's button opens the note in Obsidian.
import assert from 'node:assert/strict';
import { startStand, waitFor } from '../harness.mjs';
import { chatgptChats, chatgptFiles, fakeChatgpt, uuid } from '../fakes.mjs';

const KEY = 'stand-key';

function fakePlugin() {
  const vault = new Map();
  const opened = [];
  const handler = (req, res, url) => {
    const send = (status, body) => {
      res.writeHead(status, {
        'access-control-allow-origin': '*',
        ...(body ? { 'content-type': 'application/json' } : {}),
      });
      res.end(body ? JSON.stringify(body) : undefined);
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, PUT, POST, DELETE',
        'access-control-allow-headers': 'authorization, content-type, accept',
      });
      return res.end();
    }
    const authed = req.headers.authorization === `Bearer ${KEY}`;
    if (url.pathname === '/') return send(200, { status: 'OK', authenticated: authed });
    if (!authed) return send(401, { errorCode: 40101 });
    const path = (p) => p.split('/').map(decodeURIComponent).join('/');
    if (url.pathname.startsWith('/open/') && req.method === 'POST') {
      opened.push(path(url.pathname.slice('/open/'.length)));
      return send(200);
    }
    if (!url.pathname.startsWith('/vault/')) return send(404, { errorCode: 40400 });
    const file = path(url.pathname.slice('/vault/'.length));
    if (file.startsWith('.obsidian/')) return send(403, { errorCode: 40301 });
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        vault.set(file, Buffer.concat(chunks));
        send(204);
      });
      return undefined;
    }
    if (req.method === 'DELETE') return send(vault.delete(file) ? 204 : 404);
    const bytes = vault.get(file);
    if (!bytes) return send(404, { errorCode: 40400 });
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    return res.end(bytes);
  };
  return { vault, opened, handler };
}

export default {
  name: 'obsidian-rest',
  async run(extDir) {
    const chats = chatgptChats();
    const fake = fakeChatgpt({ chats, files: chatgptFiles() });
    const plugin = fakePlugin();
    const stand = await startStand({
      extDir,
      hosts: fake.hosts,
      handler: (req, res, url) =>
        url.hostname === '127.0.0.1' ? plugin.handler(req, res, url) : fake.handler(req, res, url),
    });
    const url = `https://chatgpt.com/c/${uuid(0x13)}`;
    try {
      await stand.settings({
        destination: 'obsidian',
        obsidianUrl: `https://127.0.0.1:${stand.port}`,
        obsidianKey: KEY,
        obsidianAttachments: 'Attachments',
      });
      const first = await stand.exportTab(url);
      assert.equal(first.failedAttachmentCount, 0, JSON.stringify(first.failures));
      assert.equal(first.location.kind, 'obsidian');
      const note = first.location.path;
      assert.match(note, /^AI Chats\/ChatGPT\/[^/]+\/[^/]+\.md$/);
      const folder = note.split('/')[2];
      const image = `Attachments/${folder}/stripes.png`;
      assert.ok(
        plugin.vault.has(image),
        `files in the attachment folder: ${[...plugin.vault.keys()]}`,
      );
      const text = plugin.vault.get(note).toString('utf8');
      assert.ok(text.includes(`![[${image}]]`), 'the image shows in the note');
      assert.match(text, /## My notes\n\n%% ai-chat-exporter:keep .* %%\n$/);

      plugin.vault.set(
        note,
        Buffer.from(text.replace('\n---\n', '\nrating: 5\n---\n') + 'My own thought.\n'),
      );
      for (const node of Object.values(chats[uuid(0x13)].mapping)) {
        for (const a of node.message?.metadata?.attachments ?? []) {
          if (a.name === 'stripes.png') a.name = 'stripes-renamed.png';
        }
      }
      const second = await stand.exportTab(url);
      assert.equal(second.location.path, note, 'the same note');
      const updated = plugin.vault.get(note).toString('utf8');
      assert.match(updated, /\nrating: 5\n---\n/, "the user's property is kept");
      assert.match(updated, /%%\nMy own thought\.\n$/, "the user's notes are kept");
      assert.ok(plugin.vault.has(`Attachments/${folder}/stripes-renamed.png`), 'the new name');
      assert.ok(!plugin.vault.has(image), 'the old file is gone');

      await stand.inExtension(
        `chrome.runtime.sendMessage({ target: 'background', type: 'obsidian:open', payload: { path: ${JSON.stringify(note)} } })`,
      );
      await waitFor(() => plugin.opened.includes(note), 5000, 'the note opened in Obsidian');

      // A wrong key stops with its own message.
      await stand.settings({ obsidianKey: 'wrong' });
      const refused = await stand.exportTab(url);
      assert.deepEqual([refused.ok, refused.code], [false, 'obsidian-key']);
    } finally {
      await stand.close();
    }
  },
};
