import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import type { FetchLike } from '../../../src/util/http';
import { fixtureJson, ORG, ORIGIN } from './fixtures';

const chat = fixtureJson('conversation-attachments.json') as {
  uuid: string;
  chat_messages: { files?: { file_name: string }[] }[];
};
const PPTX = 'Draft deck- why it starts, with what we hated.pptx';
// The fixture's docx upload, renamed like a real one whose name has spaces and a comma.
const withPptx = structuredClone(chat);
const docx = withPptx.chat_messages
  .flatMap((m) => m.files ?? [])
  .find((f) => f.file_name.endsWith('.docx'));
if (docx) docx.file_name = PPTX;

function server(listFiles: { status: number; body?: unknown }) {
  const seen: string[] = [];
  const fetchFn: FetchLike = (url) => {
    seen.push(url);
    const u = new URL(url);
    const json = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (u.pathname === '/api/organizations') return json(200, [{ uuid: ORG }]);
    if (u.pathname.endsWith(`/chat_conversations/${chat.uuid}`)) return json(200, withPptx);
    if (u.pathname.endsWith('/wiggle/list-files'))
      return json(listFiles.status, listFiles.body ?? {});
    return json(404, {});
  };
  return { fetchFn, seen };
}

const uploadUrls = async (fetchFn: FetchLike) => {
  const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(chat.uuid);
  return Object.fromEntries(
    c.messages
      .flatMap((m) => m.attachments)
      .map((a) => [a.name, a.source?.kind === 'url' ? a.source.url : null]),
  );
};

describe('uploads in a chat with a sandbox', () => {
  it('are downloaded from the sandbox, matched by the stored name', async () => {
    const path = '/mnt/user-data/uploads/Draft_deck-_why_it_starts__with_what_we_hated.pptx';
    const { fetchFn } = server({
      status: 200,
      body: {
        files: [path],
        files_metadata: [{ path, custom_metadata: { filename: 'something else' } }],
      },
    });
    const urls = await uploadUrls(fetchFn);
    expect(urls[PPTX]).toBe(
      `${ORIGIN}/api/organizations/${ORG}/conversations/${chat.uuid}/wiggle/download-file?path=${encodeURIComponent(path).replace(/%20/g, '+')}`,
    );
    // Images and files not in the sandbox keep the files API.
    expect(urls['stripes.png']).toMatch(/\/files\/[^/]+\/contents$/);
    expect(urls['fruit-prices.pdf']).toMatch(/\/files\/[^/]+\/contents$/);
  });

  it('match a name whose version dots the sandbox replaced', async () => {
    const versioned = structuredClone(withPptx);
    const file = versioned.chat_messages
      .flatMap((m) => m.files ?? [])
      .find((f) => f.file_name === PPTX);
    if (file) file.file_name = 'sessionlens-vscode-0.1.98.vsix';
    const vsix = '/mnt/user-data/uploads/sessionlens-vscode-0_1_98.vsix';
    const other = '/mnt/user-data/uploads/sessionlens-vscode-0_1_98-src.zip';
    const base = server({
      status: 200,
      body: { files_metadata: [{ path: other }, { path: vsix }] },
    });
    const fetchFn: FetchLike = (url, init) =>
      url.includes(`/chat_conversations/${chat.uuid}`)
        ? Promise.resolve(new Response(JSON.stringify(versioned)))
        : base.fetchFn(url, init);
    expect((await uploadUrls(fetchFn))['sessionlens-vscode-0.1.98.vsix']).toContain(
      encodeURIComponent('sessionlens-vscode-0_1_98.vsix'),
    );
  });

  it('use the original name from the metadata when there is one', async () => {
    const path = '/mnt/user-data/uploads/upload-1.pptx';
    const { fetchFn } = server({
      status: 200,
      body: { files_metadata: [{ path, custom_metadata: { filename: PPTX } }] },
    });
    expect((await uploadUrls(fetchFn))[PPTX]).toContain('upload-1.pptx');
  });

  it('keep the files API when the chat has no sandbox', async () => {
    const { fetchFn } = server({ status: 404 });
    expect((await uploadUrls(fetchFn))[PPTX]).toMatch(/\/files\/[^/]+\/contents$/);
  });

  it('save the other files of the sandbox, attached to messages by time', async () => {
    const pptx = '/mnt/user-data/uploads/Draft_deck-_why_it_starts__with_what_we_hated.pptx';
    const { fetchFn } = server({
      status: 200,
      body: {
        files_metadata: [
          { path: pptx },
          {
            path: '/mnt/user-data/outputs/slides.pptx',
            size: 1234,
            content_type: 'application/vnd.ms-powerpoint',
            created_at: '2099-01-01T00:00:00Z',
          },
          { path: '/mnt/user-data/outputs/img/chart.png', content_type: 'image/png' },
          { path: '/home/claude/scratch.txt' },
        ],
      },
    });
    const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(chat.uuid);
    const all = c.messages.flatMap((m) => m.attachments.map((a) => ({ role: m.role, a })));
    const named = (name: string) => all.filter((x) => x.a.name === name);
    expect(named('slides.pptx')).toMatchObject([
      { role: 'assistant', a: { origin: 'model-generated', size: 1234 } },
    ]);
    expect(named('chart.png')).toMatchObject([{ role: 'assistant', a: { mime: 'image/png' } }]);
    // Already attached as an upload: not added again. Outside uploads/outputs: ignored.
    expect(named(PPTX)).toHaveLength(1);
    expect(all.some((x) => x.a.name === 'scratch.txt')).toBe(false);
  });

  it('do not ask for the sandbox in a chat without files or tools', async () => {
    const plain = structuredClone(withPptx) as unknown as {
      chat_messages: { files?: unknown; attachments?: unknown; content: { type: string }[] }[];
    };
    for (const m of plain.chat_messages) {
      delete m.files;
      delete m.attachments;
      m.content = m.content.filter((b) => b.type === 'text');
    }
    const base = server({ status: 200, body: {} });
    const fetchFn: FetchLike = (url, init) =>
      url.includes(`/chat_conversations/${chat.uuid}`)
        ? Promise.resolve(new Response(JSON.stringify(plain)))
        : base.fetchFn(url, init);
    await new ClaudeAdapter(fetchFn, () => '').getConversation(chat.uuid);
    expect(base.seen.some((u) => u.includes('list-files'))).toBe(false);
  });
});
