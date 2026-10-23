// Claude bulk export from the export page: five chats with uploads, files the
// model made, branches, a published artifact and a project chat, each file byte
// for byte; then a project with its knowledge base and its chat.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runBulkJob, startStand, waitFor } from '../harness.mjs';
import { FIXTURES, fakeClaude, fixture } from '../fakes.mjs';

const { unzipSync } = createRequire(import.meta.url)('fflate');
const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const bytes = (head, size) => Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(size, 7)]);

export default {
  name: 'claude-bulk',
  async run(extDir) {
    const chats = {};
    for (const name of ['attachments', 'generated-files', 'branches', 'in-project', 'artifact']) {
      const chat = fixture('claude', `conversation-${name}.json`);
      chats[chat.uuid] = chat;
    }
    const files = {
      [id(0x16)]: Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(40), 'hex'),
      [id(0x17)]: bytes('PK stand meeting notes ', 900),
      [id(0x18)]: bytes('%PDF-1.4 stand ', 2000),
      [id(0x30)]: bytes('PK stand xlsx ', 5000),
      [id(0x31)]: bytes('PK stand docx ', 3000),
      [id(0x37)]: bytes('%PDF-1.4 knowledge ', 600),
      [id(0x38)]: bytes('PK stand inventory ', 800),
    };
    const meta = fixture('claude', 'artifact-meta.json');
    const artifactHtml = readFileSync(join(FIXTURES, 'claude', 'artifact-v2.html'), 'utf8');
    const fake = fakeClaude({
      chats,
      list: fixture('claude', 'conversations-list-v2.json').data,
      files,
      projects: [
        {
          project: fixture('claude', 'project.json'),
          docs: fixture('claude', 'project-docs.json'),
          files: fixture('claude', 'project-files.json'),
          conversations: fixture('claude', 'project-conversations.json'),
        },
      ],
      artifact: {
        id: meta.session.external_metadata.artifacts[0].artifact_id,
        session: 'cse_00000000000000000000000001',
        meta: meta.session,
        ver: meta.frame.ver,
        title: meta.frame.title,
        html: artifactHtml,
      },
    });
    const stand = await startStand({ extDir, ...fake });
    try {
      await stand.settings({
        delayBetweenChatsMs: 0,
        claudeBranches: 'all',
      });
      await stand.openTab('https://claude.ai/');
      const page = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=claude`,
      );
      await waitFor(
        () => stand.ev(page, `document.querySelectorAll('tbody tr').length === 5`),
        60000,
        'the list',
      );
      // Every chat, as the user ticks "select all".
      await stand.ev(page, `document.querySelector('thead input[type=checkbox]').click()`);
      const job = await runBulkJob(stand, page);
      assert.deepEqual(job.counts, { done: 5 }, JSON.stringify(fake.state.missing));
      const all = stand.files();
      const saved = (name) => {
        const path = all.find((f) => f.endsWith(`/files/${name}`));
        assert.ok(path, `${name} saved`);
        return stand.read(path);
      };
      assert.ok(saved('meeting-notes.docx').equals(files[id(0x17)]), 'docx upload');
      assert.ok(saved('stripes.png').equals(files[id(0x16)]), 'image upload');
      assert.ok(saved('fruit-prices.pdf').equals(files[id(0x18)]), 'pdf upload');
      assert.ok(saved('exporter_test.xlsx').equals(files[id(0x30)]), 'xlsx the model made');
      assert.ok(saved('exporter_test.docx').equals(files[id(0x31)]), 'docx the model made');
      const html = all.find((f) => f.includes('(Claude)/files/') && f.endsWith('.html'));
      assert.ok(html, 'the artifact saved');
      assert.equal(stand.read(html).toString(), artifactHtml, 'the published artifact');
      const note = (title) => {
        const path = all.find((f) => f.startsWith(`AI Chats/${title}`) && f.endsWith('.md'));
        assert.ok(path, `${title} saved`);
        return stand.read(path).toString();
      };
      assert.match(note('Fruit naming test'), /Branch 2/, 'every branch, as asked');
      assert.match(note('Widget glossary definition'), /project: "Exporter Test Project"/);

      // The project, from the Projects tab, with its knowledge base and its chat.
      const projects = await stand.openTab(
        `chrome-extension://${stand.extensionId}/src/ui/export-page/index.html?platform=claude&tab=projects`,
      );
      await waitFor(
        () => stand.ev(projects, `document.querySelectorAll('tbody tr').length === 1`),
        60000,
        'the project list',
      );
      await stand.ev(projects, `document.querySelector('tbody input[type=checkbox]').click()`);
      const second = await runBulkJob(stand, projects);
      assert.deepEqual(second.counts, { done: 2 }, 'the project and its chat');
      const folder = 'AI Chats/Projects/Exporter Test Project (Claude)';
      const after = stand.files();
      const project = stand.read(`${folder}/Exporter Test Project (Claude).md`).toString();
      assert.match(project, /Exporter test instructions/);
      assert.match(project, /\]\(chats\//);
      assert.ok(stand.read(`${folder}/knowledge/fruit-prices.pdf`).equals(files[id(0x37)]));
      assert.ok(stand.read(`${folder}/knowledge/inventory.xlsx`).equals(files[id(0x38)]));
      assert.match(stand.read(`${folder}/knowledge/project-glossary.md`).toString(), /# Glossary/);
      assert.equal(
        after.filter((f) => f.startsWith(`${folder}/chats/`) && f.endsWith('.md')).length,
        1,
        'the project chat in chats/',
      );

      // Files off: the project again, its files listed by name only.
      await stand.settings({ saveAttachments: false });
      await stand.ev(projects, `location.reload()`);
      await waitFor(
        () => stand.ev(projects, `document.querySelectorAll('tbody tr').length === 1`),
        60000,
        'the project list again',
      );
      await stand.ev(projects, `document.querySelector('tbody input[type=checkbox]').click()`);
      const zipsBefore = stand.downloaded().filter((f) => f.endsWith('.zip'));
      await runBulkJob(stand, projects);
      // A project into Downloads is one archive; this one is new.
      const again = stand.downloaded().find((f) => f.endsWith('.zip') && !zipsBefore.includes(f));
      assert.ok(again, 'the project again as one .zip');
      const entries = Object.keys(unzipSync(stand.read(again)));
      assert.ok(
        !entries.some((f) => f.includes('/knowledge/') || f.includes('/files/')),
        'no files',
      );
      const projectNote = entries.find((f) => /Exporter Test Project \(Claude\)\.md$/.test(f));
      assert.match(
        Buffer.from(unzipSync(stand.read(again))[projectNote]).toString(),
        /- fruit-prices\.pdf — not saved: saving files is off/,
      );

      // The popup's clipboard copy: the note without files, nothing written.
      const before = stand.files().length;
      const copied = await stand.inExtension(
        `(async () => { const t = await chrome.tabs.create({ url: 'https://claude.ai/chat/${id(0x11)}', active: false }); await new Promise((r) => setTimeout(r, 2500)); try { return await chrome.runtime.sendMessage({ target: 'background', type: 'export:copy', payload: { tabId: t.id } }); } finally { chrome.tabs.remove(t.id).catch(() => {}); } })()`,
      );
      assert.equal(copied?.ok, true, JSON.stringify(copied));
      const markdown = copied.value.markdown;
      assert.match(markdown, /^---\ntitle: "File content summary"/);
      assert.match(markdown, /meeting-notes\.docx/);
      assert.doesNotMatch(markdown, /\]\(files\//, 'files listed by name, without links');
      assert.equal(stand.files().length, before, 'nothing saved');

      // The note as an HTML page and as JSON, next to the same files.
      await stand.settings({ saveAttachments: true, noteFormat: 'html' });
      await stand.exportTab(`https://claude.ai/chat/${id(0x11)}`);
      const htmlNote = stand.files().find((f) => /File content summary.*\.html$/.test(f));
      assert.ok(htmlNote, 'an HTML note');
      const pageText = stand.read(htmlNote).toString();
      assert.match(pageText, /^<!doctype html>/);
      assert.match(pageText, /<img src="files\/stripes\.png"/, 'the image shown');
      assert.doesNotMatch(pageText, /<script/);
      await stand.settings({ noteFormat: 'json' });
      await stand.exportTab(`https://claude.ai/chat/${id(0x11)}`);
      const data = stand.files().find((f) => /File content summary.*\.json$/.test(f));
      assert.ok(data, 'a JSON note');
      const doc = JSON.parse(stand.read(data).toString());
      assert.equal(doc.format, 'ai-chat-exporter/conversation@1');
      const savedPaths = doc.conversation.messages.flatMap((m) => m.attachments).map((a) => a.path);
      assert.ok(savedPaths.includes('files/meeting-notes.docx'), JSON.stringify(savedPaths));
      assert.doesNotMatch(stand.read(data).toString(), /\/contents"/, 'no download links');
    } finally {
      await stand.close();
    }
  },
};
