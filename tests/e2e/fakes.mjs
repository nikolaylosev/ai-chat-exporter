// Fake platforms for the stands, answering from tests/fixtures like the real
// ones answered during discovery (docs/platforms-*.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
export const fixture = (platform, name) =>
  JSON.parse(readFileSync(join(FIXTURES, platform, name), 'utf8'));
export const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const html = (res, title, cookie) => {
  res.writeHead(200, { 'content-type': 'text/html', ...(cookie ? { 'set-cookie': cookie } : {}) });
  res.end(`<!doctype html><title>${title}</title><p>stand`);
};

/**
 * chatgpt.com: the session token (after a page visit sets the cookie), the list
 * with archive and projects, conversations, signed file links (a new signature
 * each time), sandbox files. `content(fid, req, res, url)` may take over a file
 * download (return true) to drop or refuse it.
 */
export function fakeChatgpt({
  chats = {},
  files = {},
  history = [],
  archived = [],
  projects = [],
  content,
} = {}) {
  const TOKEN = 'stand-token';
  const state = { conversationReads: 0, links: 0, contents: {}, noAuth: 0 };
  const handler = (req, res, url) => {
    const auth = req.headers.authorization === `Bearer ${TOKEN}`;
    if (url.pathname === '/api/auth/session') {
      return json(res, /sess=1/.test(req.headers.cookie ?? '') ? { accessToken: TOKEN } : {});
    }
    if (url.pathname === '/backend-api/estuary/content') {
      const fid = url.searchParams.get('id');
      state.contents[fid] = (state.contents[fid] ?? 0) + 1;
      if (content?.(fid, req, res, url)) return;
      const body = files[fid];
      if (!body) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(body);
    }
    if (url.pathname.startsWith('/backend-api/') && !auth) {
      state.noAuth++;
      return url.pathname === '/backend-api/conversations'
        ? json(res, { items: [] })
        : json(res, { detail: 'Unauthorized' }, 401);
    }
    let m;
    if (url.pathname === '/backend-api/conversations') {
      const all = url.searchParams.get('is_archived') === 'true' ? archived : history;
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return json(res, {
        items: all.slice(offset, offset + limit),
        total: offset + limit + 1,
        limit,
        offset,
      });
    }
    if (url.pathname === '/backend-api/gizmos/snorlax/sidebar') {
      return json(res, {
        items: projects.map((p) => ({
          gizmo: { gizmo: { id: p.id, display: { name: p.name } } },
          conversations: { items: [] },
        })),
        cursor: null,
      });
    }
    if ((m = /^\/backend-api\/gizmos\/([^/]+)\/conversations$/.exec(url.pathname))) {
      return json(res, { items: projects.find((p) => p.id === m[1])?.chats ?? [], cursor: null });
    }
    if ((m = /^\/backend-api\/conversation\/([^/]+)$/.exec(url.pathname))) {
      state.conversationReads++;
      return chats[m[1]] ? json(res, chats[m[1]]) : json(res, { detail: 'Not found' }, 404);
    }
    if ((m = /^\/backend-api\/files\/download\/([^/]+)$/.exec(url.pathname))) {
      state.links++;
      return json(res, {
        status: 'success',
        download_url: `https://chatgpt.com/backend-api/estuary/content?id=${m[1]}&sig=n${state.links}`,
      });
    }
    if (/^\/backend-api\/conversation\/[^/]+\/interpreter\/download$/.test(url.pathname)) {
      return url.searchParams.get('sandbox_path') === '/mnt/data/fruits.csv'
        ? json(res, {
            status: 'success',
            download_url: '/backend-api/estuary/content?id=sandbox&sig=s',
          })
        : json(res, { status: 'error', error_code: 'file_not_found' });
    }
    return html(res, 'ChatGPT', 'sess=1; Domain=chatgpt.com; Path=/; Secure; SameSite=None');
  };
  return { hosts: ['chatgpt.com'], handler, state };
}

/** File ids of the ChatGPT uploads fixture, and stand bytes for them. */
export const chatgptFile = (n) => `file_${String(n).padStart(32, '0')}`;
export function chatgptFiles() {
  return {
    [chatgptFile(2)]: Buffer.concat([Buffer.from('%PDF-1.4 stand pdf '), Buffer.alloc(300000, 7)]),
    [chatgptFile(4)]: Buffer.from('PK stand docx \u0001\u0002', 'latin1'),
    [chatgptFile(1)]: Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(30), 'hex'),
    [chatgptFile(7)]: Buffer.from('89504e470d0a1a0a' + 'cd'.repeat(40), 'hex'),
    sandbox: Buffer.from('name,price\napple,3\npear,4\nplum,5\n'),
  };
}

/** The six ChatGPT fixture chats by id. */
export function chatgptChats() {
  const chats = {};
  for (const name of ['branches', 'uploads', 'image', 'code-file', 'canvas', 'search']) {
    const c = fixture('chatgpt', `conversation-${name}.json`);
    chats[c.conversation_id] = c;
  }
  return chats;
}

const batch = (rpc, payload) => {
  const line = JSON.stringify([
    ['wrb.fr', rpc, JSON.stringify(payload), null, null, null, 'generic'],
  ]);
  return `)]}'\n\n${line.length}\n${line}\n`;
};

/**
 * gemini.google.com: page tokens, batchexecute (history, list in pages linked by
 * a token, Gems, `notebooks` with their chats), GraphQL search over `searchable`,
 * and the file hosts. `listDelay` slows each list page; `images` and `documents`
 * are the file bytes.
 */
export function fakeGemini({
  chats = {},
  pages = null,
  searchable = [],
  listDelay = 0,
  image,
  documents = {},
  notebooks = null,
} = {}) {
  const state = { listPages: 0, searches: 0, lh3: 0, contribution: 0, history: 0 };
  const handler = (req, res, url) => {
    if (url.hostname === 'lh3.googleusercontent.com') {
      state.lh3++;
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(image);
    }
    if (url.hostname === 'contribution.usercontent.google.com') {
      state.contribution++;
      const name = url.searchParams.get('filename');
      res.writeHead(200, {
        'content-disposition': `attachment; filename="${name}"`,
        'content-type': 'application/octet-stream',
      });
      return res.end(documents[name] ?? '');
    }
    if (url.pathname.endsWith('/executeQuery')) {
      state.searches++;
      const q = JSON.parse(url.searchParams.get('variables')).query.toLowerCase();
      const found = searchable.filter((h) => h.title.toLowerCase().includes(q)).slice(0, 5);
      const snippets = found.map((h) => ({
        conversation: { conversationId: `c_${h.id}`, title: h.title },
        snippets: [{ timestamp: '2025-03-01T10:00:00Z' }],
      }));
      const answer = [
        {
          data: {
            viewer: {
              rpcs: { searchHistory: snippets.length ? { historySnippets: snippets } : null },
            },
          },
        },
      ];
      return setTimeout(() => json(res, answer), 100);
    }
    if (req.method === 'POST' && url.pathname.endsWith('/batchexecute')) {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        const rpc = url.searchParams.get('rpcids');
        if (form.get('at') !== 'stand-token') {
          res.writeHead(400);
          return res.end();
        }
        const args = JSON.parse(JSON.parse(form.get('f.req'))[0][0][1]);
        let payload = null;
        let delay = 0;
        if (rpc === 'hNvQHb') {
          state.history++;
          const history = chats[args[0].slice(2)]?.history ?? [];
          const i = args[2] ? history.findIndex((p) => p[1] === args[2]) + 1 : 0;
          payload = history[i] ?? [[], null];
        }
        if (notebooks && rpc === 'HcT8bb') {
          payload = args[0] === notebooks.bot[0][0] ? notebooks.bot : null;
        } else if (notebooks && rpc === 'CNgdBe' && JSON.stringify(args[4]) === '[2]') {
          payload = notebooks.list;
        } else if (notebooks && rpc === 'MaZiqc' && typeof args[2][3] === 'string') {
          payload = args[2][3] === notebooks.bot[0][0] ? notebooks.chats : [null, null, []];
        } else if (rpc === 'MaZiqc') {
          const id = typeof args[2][5] === 'string' ? args[2][5].slice(2) : null;
          if (id) payload = chats[id]?.meta ?? [null, null, []];
          else if (pages) {
            state.listPages++;
            delay = listDelay;
            const n = args[1] ? Number(String(args[1]).slice(4)) : 0;
            payload = [null, n + 1 < pages.length ? `page${n + 1}` : null, pages[n]];
          } else payload = fixture('gemini', 'conversations-list.json');
        } else if (rpc === 'CNgdBe') {
          payload = args[0] === 1 ? fixture('gemini', 'gems-premade.json') : [null, null, []];
        }
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(batch(rpc, payload));
        }, delay);
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><title>Gemini</title><script>window.WIZ_global_data = {"SNlM0e":"stand-token","cfb2h":"boq_stand","FdrFJe":"-1"};</script>',
    );
  };
  return {
    hosts: [
      'gemini.google.com',
      'lh3.googleusercontent.com',
      'contribution.usercontent.google.com',
    ],
    handler,
    state,
  };
}

/** The Gemini fixture chats by id. */
export function geminiChats(names) {
  const chats = {};
  for (const name of names) {
    const c = fixture('gemini', `conversation-${name}.json`);
    chats[c.meta[2][0][0].slice(2)] = c;
  }
  return chats;
}

/**
 * claude.ai: organizations, the chat list, conversations, files by uuid, projects
 * with their documents, files and chats, a cloud session's artifacts and the
 * artifact's published file on its frame host. The sandbox and the timeline stream
 * answer 404, as for a chat without them. `files` maps a file uuid to its bytes.
 */
export function fakeClaude({ chats = {}, list = [], projects = [], files = {}, artifact } = {}) {
  const ORG = '00000000-0000-4000-8000-0000000000a1';
  const state = { files: 0, missing: [] };
  const frameHost = artifact && `${artifact.id}.frame.claudeusercontent.com`;
  const handler = (req, res, url) => {
    if (url.hostname === frameHost) {
      const ok = url.searchParams.get('__frame_t') === 'stand-asset-token';
      res.writeHead(ok ? 200 : 403, {
        'content-type': 'text/html',
        'access-control-allow-origin': '*',
      });
      return res.end(ok ? artifact.html : 'forbidden');
    }
    const path = url.pathname;
    let m;
    if (path === '/api/organizations') return json(res, [{ uuid: ORG }]);
    if ((m = /\/files\/([0-9a-f-]{36})\/contents$/.exec(path))) {
      state.files++;
      if (!files[m[1]]) {
        state.missing.push(path);
        return json(res, { error: 'not found' }, 404);
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(files[m[1]]);
    }
    if (path.endsWith('/chat_conversations_v2')) {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return json(res, {
        data: list.slice(offset, offset + limit),
        has_more: offset + limit < list.length,
      });
    }
    if ((m = /\/chat_conversations\/([0-9a-f-]{36})$/.exec(path))) {
      return chats[m[1]] ? json(res, chats[m[1]]) : json(res, { error: 'not found' }, 404);
    }
    if (path.endsWith('/projects_v2')) {
      return json(res, { data: projects.map((p) => p.project), has_more: false });
    }
    if ((m = /\/projects\/([0-9a-f-]{36})(\/[a-z_0-9]+)?$/.exec(path))) {
      const project = projects.find((p) => p.project.uuid === m[1]);
      if (!project) return json(res, { error: 'not found' }, 404);
      if (!m[2]) return json(res, project.project);
      if (m[2] === '/docs') return json(res, project.docs);
      if (m[2] === '/files') return json(res, project.files);
      if (m[2] === '/conversations_v2') return json(res, project.conversations);
    }
    if (artifact && path === `/v1/code/sessions/${artifact.session}`) {
      return json(res, { response_shape: artifact.meta });
    }
    if (artifact && path === `/api/frame/${artifact.id}`) {
      return json(res, {
        ver: artifact.ver,
        history: [artifact.ver],
        files: [{ path: 'index.html', contentType: 'text/html' }],
        assetToken: 'stand-asset-token',
        title: artifact.title,
      });
    }
    if (path.startsWith('/api/') || req.method !== 'GET') {
      // The sandbox file list and the timeline stream: none for these chats.
      state.missing.push(path);
      return json(res, { error: 'not found' }, 404);
    }
    return html(res, 'Claude');
  };
  return { hosts: ['claude.ai', ...(frameHost ? [frameHost] : [])], handler, state };
}

/** grok.com and assets.grok.com: list by page token, conversation, tree, responses, files. */
export function fakeGrok({ chats = {}, pages = null, assets = {} } = {}) {
  const state = { list: 0, conversations: 0, assets: 0 };
  const handler = (req, res, url) => {
    if (url.hostname === 'assets.grok.com') {
      state.assets++;
      const key = Object.keys(assets).find((k) => url.pathname.endsWith(k));
      if (!key) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        'content-type': key.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream',
        'access-control-allow-origin': 'https://grok.com',
        'access-control-allow-credentials': 'true',
      });
      return res.end(assets[key]);
    }
    let m;
    if (url.pathname === '/rest/app-chat/conversations') {
      state.list++;
      if (!pages) return json(res, fixture('grok', 'conversations-list.json'));
      const n = Number((url.searchParams.get('pageToken') ?? 'p0').slice(1));
      return json(res, {
        conversations: pages[n] ?? [],
        nextPageToken: n + 1 < pages.length ? `p${n + 1}` : null,
      });
    }
    if ((m = /^\/rest\/app-chat\/conversations_v2\/([^/]+)$/.exec(url.pathname))) {
      state.conversations++;
      return chats[m[1]] ? json(res, chats[m[1]].meta) : json(res, {}, 404);
    }
    if ((m = /^\/rest\/app-chat\/conversations\/([^/]+)\/response-node$/.exec(url.pathname))) {
      return json(res, chats[m[1]].nodes);
    }
    if ((m = /^\/rest\/app-chat\/conversations\/([^/]+)\/load-responses$/.exec(url.pathname))) {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const ids = new Set(JSON.parse(raw).responseIds);
        json(res, {
          responses: chats[m[1]].responses.responses.filter((r) => ids.has(r.responseId)),
        });
      });
      return;
    }
    return html(res, 'Grok', 'stand=1; Domain=grok.com; Path=/; Secure; SameSite=None');
  };
  return { hosts: ['grok.com', 'assets.grok.com'], handler, state };
}

/** The Grok fixture chats by id. */
export function grokChats(names) {
  const chats = {};
  for (const name of names) {
    const c = fixture('grok', `conversation-${name}.json`);
    chats[c.meta.conversation.conversationId] = c;
  }
  return chats;
}
