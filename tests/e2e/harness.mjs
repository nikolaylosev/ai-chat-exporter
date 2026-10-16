// Stand harness: the built extension in Chrome for Testing, driven over the
// DevTools protocol, with the platforms faked by a local HTTPS server. See
// tests/e2e/README.md.
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chrome for Testing: CHROME_PATH, or the newest one Playwright installed. */
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const linuxCache = join(homedir(), '.cache/ms-playwright');
  for (const root of [cache, linuxCache]) {
    if (!existsSync(root)) continue;
    const builds = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const candidate of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
      ]) {
        const path = join(root, build, candidate);
        if (existsSync(path)) return path;
      }
    }
  }
  throw new Error(
    'Chrome for Testing not found: run `npx playwright install chromium` or set CHROME_PATH',
  );
}

/** Builds the extension into a fresh folder (never into dist/, which may be in use). */
export function buildExtension(root, outDir) {
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: root,
    stdio: 'ignore',
  });
  return outDir;
}

/** A self-signed certificate for the fake hosts; Chrome is told to accept it. */
function certificate(dir) {
  const key = join(dir, 'stand.key');
  const crt = join(dir, 'stand.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      crt,
      '-days',
      '1',
      '-subj',
      '/CN=stand',
    ],
    { stdio: 'ignore' },
  );
  return { key: readFileSync(key), cert: readFileSync(crt) };
}

export async function waitFor(fn, timeout = 30000, what = 'condition') {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ''}`);
}

export function listFiles(dir, prefix = '') {
  return readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory()
      ? listFiles(join(dir, name), `${prefix}${name}/`)
      : [`${prefix}${name}`],
  );
}

/**
 * Starts a stand: `handler(req, res, url)` answers for every host in `hosts`,
 * Chrome loads the extension from `extDir` with a fresh profile and downloads
 * folder. Returns helpers; call `close()` at the end.
 */
export async function startStand({ extDir, hosts, handler }) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-exporter-e2e-'));
  const server = createServer(certificate(dir), (req, res) =>
    handler(req, res, new URL(req.url, `https://${req.headers.host}`)),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const profile = join(dir, 'profile');
  const downloads = join(dir, 'downloads');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(downloads);
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
  );
  const chrome = spawn(
    findChrome(),
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${extDir}`,
      `--disable-extensions-except=${extDir}`,
      '--remote-debugging-port=0',
      `--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(', ')}`,
      '--ignore-certificate-errors',
      '--headless=new',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const activePort = join(profile, 'DevToolsActivePort');
  const devtools = await waitFor(
    () => existsSync(activePort) && readFileSync(activePort, 'utf8').split('\n')[0],
    20000,
    'DevTools',
  );
  const http = `http://127.0.0.1:${devtools}`;
  const version = await waitFor(
    async () => (await fetch(`${http}/json/version`)).json(),
    20000,
    'DevTools version',
  );
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const targets = async () => (await fetch(`${http}/json/list`)).json();
  const worker = () =>
    targets().then((list) =>
      list.find((t) => t.type === 'service_worker' && t.url.endsWith('/service-worker-loader.js')),
    );
  const extensionId = new URL((await waitFor(worker, 20000, 'the extension')).url).host;
  const openTab = async (url) => {
    const { result } = await send('Target.createTarget', { url });
    await sleep(1500);
    const { result: attached } = await send('Target.attachToTarget', {
      targetId: result.targetId,
      flatten: true,
    });
    return attached.sessionId;
  };
  const ev = async (session, expression) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      session,
    );
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluation failed');
    return r.result?.result?.value;
  };
  const extPage = await openTab(`chrome-extension://${extensionId}/src/ui/options/index.html`);
  return {
    port,
    downloads,
    extensionId,
    send,
    targets,
    worker,
    openTab,
    ev,
    /** Evaluates in an extension page: chrome.* APIs are there. */
    inExtension: (expression) => ev(extPage, expression),
    /** Changes settings the way the options page would. */
    settings: (patch) =>
      ev(
        extPage,
        `chrome.storage.local.get('settings').then((d) => chrome.storage.local.set({ settings: { ...(d.settings ?? {}), ...${JSON.stringify(patch)} } })).then(() => 'ok')`,
      ),
    /** Opens `url` in a background tab and asks the worker to export it, like the shortcut. */
    exportTab: async (url) => {
      const reply = await ev(
        extPage,
        `(async () => { const t = await chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false }); await new Promise((r) => setTimeout(r, 2500)); try { return await chrome.runtime.sendMessage({ target: 'background', type: 'export:current', payload: { tabId: t.id } }); } finally { chrome.tabs.remove(t.id).catch(() => {}); } })()`,
      );
      if (!reply?.ok) throw new Error(`export failed: ${JSON.stringify(reply)}`);
      return reply.value;
    },
    /** The bulk job's state (counts by status), from chrome.storage.session. */
    job: () =>
      ev(
        extPage,
        `chrome.storage.session.get(null).then((d) => { const j = Object.values(d).find((v) => v && v.items); if (!j) return null; const c = {}; for (const i of j.items) c[i.status] = (c[i.status] ?? 0) + 1; return { status: j.status, started: j.startedAt, counts: c }; })`,
      ),
    files: () => listFiles(downloads),
    read: (path) => readFileSync(join(downloads, path)),
    async close() {
      chrome.kill();
      server.close();
      ws.close();
      await sleep(500);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs a bulk export from an export page like the user: click Save, wait for the end. */
export async function runBulkJob(stand, page) {
  const before = (await stand.job())?.started;
  await waitFor(
    () => stand.ev(page, `!document.querySelector('.actions button.primary').disabled`),
    60000,
    'the Save button',
  );
  await stand.ev(page, `document.querySelector('.actions button.primary').click()`);
  return waitFor(
    async () => {
      const job = await stand.job();
      return (
        job &&
        job.started !== before &&
        !['running', 'cancelling', 'queued', 'starting'].includes(job.status) &&
        job
      );
    },
    300000,
    'the bulk export',
  );
}
