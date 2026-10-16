import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/adapters/claude/adapter';
import type { Attachment, Conversation } from '../../../src/model/conversation';
import type { FetchLike } from '../../../src/util/http';
import { fixtureJson, ORG } from './fixtures';

const chat = fixtureJson('conversation-artifact.json') as { uuid: string };
const meta = fixtureJson('artifact-meta.json') as {
  session: { external_metadata: { artifacts: { artifact_id: string }[] } };
};
const ARTIFACT = meta.session.external_metadata.artifacts[0]!.artifact_id;
const V1 = '1791882876-61ba';
const V2 = '1791882915-2e7b';

interface Options {
  sessionId?: string | null;
  frameStatus?: number;
  /** A frame without its file list, as some artifacts answer. */
  noFiles?: boolean;
  /** The conversation to serve instead of the fixture. */
  conversation?: unknown;
}

function server({
  sessionId = 'cse_1',
  frameStatus = 200,
  noFiles = false,
  conversation = chat,
}: Options = {}) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const json = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const fetchFn: FetchLike = (url, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({ url, headers });
    const u = new URL(url);
    if (u.pathname === '/api/organizations') return json(200, [{ uuid: ORG }]);
    if (u.pathname.endsWith(`/chat_conversations/${chat.uuid}`)) return json(200, conversation);
    if (u.pathname.endsWith('/chat_conversations_v2')) {
      return json(200, {
        data: [{ uuid: 'other' }, { uuid: chat.uuid, workspace_session_id: sessionId }],
        has_more: false,
      });
    }
    if (u.pathname === '/v1/code/sessions/cse_1')
      return json(200, { response_shape: meta.session });
    if (u.pathname === `/api/frame/${ARTIFACT}`) {
      if (frameStatus !== 200) return json(frameStatus, { error: 'x' });
      const ver = u.searchParams.get('ver') ?? V2;
      return json(200, {
        ver,
        history: [V2, V1],
        ...(noFiles ? {} : { files: [{ path: 'index.html', contentType: 'text/html' }] }),
        assetToken: `token-${ver}`,
        title: 'Exporter Test',
      });
    }
    if (u.hostname === `${ARTIFACT}.frame.claudeusercontent.com`) {
      const ver = u.pathname.split('/')[2];
      const ok = u.searchParams.get('__frame_t') === `token-${ver}`;
      return Promise.resolve(
        new Response(ok ? `<h1>published ${ver}</h1>` : 'forbidden', { status: ok ? 200 : 403 }),
      );
    }
    return json(404, {});
  };
  return { fetchFn, seen };
}

function artifacts(c: Conversation): [number, Attachment][] {
  return c.messages.flatMap((m, i) =>
    m.attachments.filter((a) => a.origin === 'artifact').map((a): [number, Attachment] => [i, a]),
  );
}

const text = (a: Attachment | undefined) => (a?.source?.kind === 'text' ? a.source.text : null);

describe('ClaudeAdapter artifacts', () => {
  it('downloads the published latest version onto the message that published it', async () => {
    const { fetchFn, seen } = server();
    const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(chat.uuid);
    const found = artifacts(c);
    expect(found).toHaveLength(1);
    const [index, attachment] = found[0]!;
    expect(index).toBe(c.messages.length - 1);
    expect(attachment).toMatchObject({
      name: 'artifact-exporter-test.html',
      origin: 'artifact',
      mime: 'text/html',
    });
    expect(attachment.note).toBeUndefined();
    expect(text(attachment)).toBe(`<h1>published ${V2}</h1>`);

    const session = seen.find((r) => r.url.includes('/v1/code/sessions/'));
    expect(session?.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': ORG,
    });
    expect(seen.find((r) => r.url.includes('/api/frame/'))?.headers['x-frame-cp']).toBe('go');
  });

  it('keeps every version with numbered names when asked', async () => {
    const { fetchFn } = server();
    const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(chat.uuid, {
      artifactVersions: 'all',
    });
    expect(artifacts(c).map(([, a]) => [a.name, text(a)])).toEqual([
      ['artifact-exporter-test-v1.html', `<h1>published ${V1}</h1>`],
      ['artifact-exporter-test-v2.html', `<h1>published ${V2}</h1>`],
    ]);
  });

  it('falls back to the file rebuilt from the chat when the artifact cannot be read', async () => {
    const { fetchFn } = server({ frameStatus: 404 });
    const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(chat.uuid);
    const [, attachment] = artifacts(c)[0]!;
    expect(attachment.note).toBe('rebuilt-from-chat');
    expect(attachment.name).toBe('artifact-exporter-test.html');
    expect(text(attachment)).toContain('<h1>Exporter test v2</h1>');
  });

  it('rebuilds an artifact whose frame lists no files', async () => {
    const { fetchFn } = server({ noFiles: true });
    const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(chat.uuid);
    expect(artifacts(c)[0]?.[1].note).toBe('rebuilt-from-chat');
  });

  it('takes the file from the sandbox when it cannot be rebuilt in an older chat', async () => {
    // The file was written by a shell command: no Write or create_file call to replay.
    const written = structuredClone(chat) as unknown as {
      chat_messages: { content: { type: string; name?: string }[] }[];
    };
    for (const m of written.chat_messages) {
      m.content = m.content.filter(
        (b) =>
          !(b.type === 'tool_use' && /^(Write|create_file|Edit|str_replace)$/.test(b.name ?? '')),
      );
    }
    const { fetchFn } = server({ sessionId: null, conversation: written });
    const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(chat.uuid);
    const [, attachment] = artifacts(c)[0]!;
    expect(attachment.note).toBeUndefined();
    expect(attachment.source).toMatchObject({
      kind: 'url',
      url: expect.stringMatching(/\/conversations\/[^/]+\/wiggle\/download-file\?path=/) as string,
    });
  });

  it('rebuilds artifacts of chats without a cloud session', async () => {
    const { fetchFn, seen } = server({ sessionId: null });
    const c = await new ClaudeAdapter(fetchFn, () => '').getConversation(chat.uuid);
    expect(artifacts(c)[0]?.[1].note).toBe('rebuilt-from-chat');
    expect(seen.some((r) => r.url.includes('/v1/code/sessions/'))).toBe(false);
    expect(c.messages[0]?.attachments).toEqual([]);
  });

  it('does not look for artifacts in chats that have none', async () => {
    const { fetchFn, seen } = server();
    const plain = fixtureJson('conversation-branches.json') as { uuid: string };
    const fetchPlain: FetchLike = (url, init) =>
      url.includes(`/chat_conversations/${plain.uuid}`)
        ? Promise.resolve(new Response(JSON.stringify(plain)))
        : fetchFn(url, init);
    await new ClaudeAdapter(fetchPlain, () => '').getConversation(plain.uuid);
    expect(seen.some((r) => r.url.includes('chat_conversations_v2'))).toBe(false);
  });
});
