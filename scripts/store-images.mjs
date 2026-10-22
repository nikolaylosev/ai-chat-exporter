// Makes the Chrome Web Store images in store/: four 1280×800 screenshots of the
// real extension on a stand with made-up chats, and the 440×280 promo tile.
// Run: node scripts/store-images.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExtension, sleep, startStand, waitFor } from '../tests/e2e/harness.mjs';
import { fakeClaude, fixture } from '../tests/e2e/fakes.mjs';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'store');
const COLORS = { bg: '#14161f', panel: '#1b1e29', text: '#f2f2ee', yellow: '#ffb000' };
const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** Made-up chats: titles, dates and projects for the export page. */
const TITLES = [
  ['Trip plan for Lisbon in May', null],
  ['Kitchen layout options', 'Home renovation'],
  ['Python script to clean a CSV', null],
  ['Literature review outline', 'Thesis'],
  ['Weekly meal plan with shopping list', null],
  ['Tile and paint budget', 'Home renovation'],
  ['Explain Rust lifetimes with examples', null],
  ['Survey questions for chapter 3', 'Thesis'],
  ['Cover letter for a data analyst role', null],
  ['Marathon training schedule', null],
  ['SQL query for monthly revenue', null],
  ['Garden watering system', 'Home renovation'],
  ['Summary of the interview notes', 'Thesis'],
  ['Birthday party ideas for a 7-year-old', null],
];

function standData() {
  const base = JSON.stringify(fixture('claude', 'conversation-branches.json'));
  const listItem = fixture('claude', 'conversations-list-v2.json').data[4];
  const chats = {};
  const list = [];
  TITLES.forEach(([title, project], i) => {
    const uuid = id(0x500 + i);
    const day = String(20 - i).padStart(2, '0');
    const chat = JSON.parse(base.replaceAll(id(3), uuid));
    chat.name = title;
    chats[uuid] = chat;
    list.push({
      ...listItem,
      uuid,
      name: title,
      created_at: `2026-10-${day}T09:${String(10 + i).padStart(2, '0')}:00.000000Z`,
      updated_at: `2026-10-${day}T11:${String(20 + i).padStart(2, '0')}:00.000000Z`,
      ...(project ? { project_uuid: id(0x33), project: { uuid: id(0x33), name: project } } : {}),
    });
  });
  const inProject = fixture('claude', 'conversation-in-project.json');
  inProject.name = 'Kitchen layout options';
  chats[inProject.uuid] = inProject;
  const project = { ...fixture('claude', 'project.json'), name: 'Home renovation' };
  return {
    chats,
    list,
    projects: [
      {
        project,
        docs: fixture('claude', 'project-docs.json'),
        files: fixture('claude', 'project-files.json'),
        conversations: fixture('claude', 'project-conversations.json'),
      },
    ],
    chatInProject: inProject.uuid,
  };
}

async function shot(stand, session, width, height, path) {
  await stand.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    session,
  );
  await sleep(600);
  const { result } = await stand.send('Page.captureScreenshot', { format: 'png' }, session);
  writeFileSync(path, Buffer.from(result.data, 'base64'));
}

/** A page of the stand browser showing local HTML (the frames and the mock-ups). */
async function htmlShot(stand, dir, name, html, width, height, path) {
  const file = join(dir, `${name}.html`);
  writeFileSync(file, html);
  const session = await stand.openTab(`file://${file}`);
  await shot(stand, session, width, height, path);
}

const dataUrl = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;

/** A screenshot in the brand frame: the caption on top, the picture below. */
function frame(caption, inner) {
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
    body { background: radial-gradient(circle at 20% 0%, #262b3b, ${COLORS.panel} 45%, ${COLORS.bg});
      font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: ${COLORS.text};
      display: flex; flex-direction: column; align-items: center; }
    h1 { margin: 44px 0 30px; font-size: 40px; font-weight: 750; letter-spacing: -0.01em; }
    h1 b { color: ${COLORS.yellow}; font-weight: inherit; }
    .pic { flex: 1; display: flex; align-items: flex-start; justify-content: center; }
    .pic img { max-width: 1160px; max-height: 640px; border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45); }
  </style><h1>${caption}</h1><div class="pic">${inner}</div>`;
}

/** A neutral chat page (no service's look or logo) with the real popup over it. */
function chatWithPopup(popup) {
  const msg = (who, text) => `<div class="m ${who}"><div class="b">${text}</div></div>`;
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: 1160px; height: 640px; overflow: hidden; }
    body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; background: #f6f6f3; color: #1d1d1f; position: relative; }
    .bar { height: 46px; background: #e9e9e5; border-bottom: 1px solid #d6d6d0; display: flex; align-items: center; gap: 10px; padding: 0 16px; }
    .dot { width: 12px; height: 12px; border-radius: 50%; background: #d0d0ca; }
    .url { margin-left: 18px; flex: 1; height: 28px; border-radius: 14px; background: #fff; display: flex; align-items: center; padding: 0 14px; color: #6b6b66; font-size: 14px; }
    .ext { width: 28px; height: 28px; border-radius: 7px; background: url(${popup.icon}) center/cover; }
    .chat { width: 640px; margin: 28px 0 0 70px; display: flex; flex-direction: column; gap: 16px; }
    .m { display: flex; } .m.u { justify-content: flex-end; }
    .b { max-width: 470px; padding: 14px 18px; border-radius: 16px; font-size: 16px; line-height: 1.45; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
    .u .b { background: #e3e8f4; }
    code { font-family: ui-monospace, Menlo, monospace; font-size: 14px; background: #f0f0ec; padding: 1px 5px; border-radius: 4px; }
    .popup { position: absolute; top: 52px; right: 16px; width: 320px; border-radius: 12px; overflow: hidden; box-shadow: 0 18px 48px rgba(0,0,0,.35); }
    .popup img { display: block; width: 320px; }
  </style>
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
    <div class="url">Kitchen layout options</div><div class="ext"></div></div>
  <div class="chat">
    ${msg('u', 'Our kitchen is 3.2 × 4 m with a window on the long wall. Which layouts work?')}
    ${msg('a', 'Three good options for that room:<br>1. <b>L-shape</b> along the window wall and the short wall.<br>2. <b>Galley</b> with two parallel runs, if the door is on the short side.<br>3. <b>U-shape</b> if you can give up the dining table.')}
    ${msg('u', 'Draw the L-shape with dimensions and list the cabinets.')}
    ${msg('a', 'Here is the plan as <code>kitchen-l-shape.pdf</code> and the cabinet list as <code>cabinets.csv</code>.')}
  </div>
  <div class="popup"><img src="${popup.image}"></div>`;
}

/** A saved note as a Markdown reader shows it, next to its folder. */
function savedNote() {
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: 1160px; height: 640px; overflow: hidden; }
    body { display: flex; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; background: #202230; color: #e6e6e1; }
    .tree { width: 430px; flex: none; background: #181a24; padding: 22px 18px; font-size: 14px; line-height: 2; color: #b9bbc6; box-sizing: border-box; }
    .tree div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tree .d { color: #e6e6e1; } .tree .i1 { padding-left: 18px; } .tree .i2 { padding-left: 36px; } .tree .i3 { padding-left: 54px; }
    .tree .on { color: ${COLORS.yellow}; }
    .note { flex: 1; padding: 26px 40px; font-size: 15.5px; line-height: 1.55; overflow: hidden; }
    .props { border: 1px solid #343748; border-radius: 10px; padding: 10px 14px; font-size: 13.5px; color: #a9abb8; display: grid; grid-template-columns: 110px 1fr; gap: 3px 10px; margin-bottom: 18px; }
    .props span:nth-child(odd) { color: #7f8293; }
    h1 { font-size: 26px; margin: 0 0 14px; } h2 { font-size: 17px; margin: 18px 0 6px; color: #f2f2ee; }
    .callout { border-left: 3px solid ${COLORS.yellow}; background: #2a2c3a; padding: 8px 12px; border-radius: 6px; color: #b9bbc6; font-size: 14px; margin: 8px 0; }
    a { color: #8ab4ff; text-decoration: none; }
  </style>
  <div class="tree">
    <div class="d">📁 AI Chats</div>
    <div class="d i1">📁 Projects</div>
    <div class="d i2">📁 Home renovation (Claude)</div>
    <div class="i3">📄 Home renovation (Claude).md</div>
    <div class="i3">📁 knowledge</div>
    <div class="i3">📁 chats</div>
    <div class="d i1">📁 Kitchen layout options - 2026-10-19 (Claude)</div>
    <div class="i2 on">📄 Kitchen layout options - 2026-10-19 (Claude).md</div>
    <div class="d i2">📁 files</div>
    <div class="i3">📕 kitchen-l-shape.pdf</div>
    <div class="i3">📊 cabinets.csv</div>
  </div>
  <div class="note">
    <div class="props">
      <span>platform</span><span>claude</span>
      <span>created</span><span>2026-10-19 09:12</span>
      <span>project</span><span>Home renovation</span>
      <span>model</span><span>claude-opus-5-5</span>
      <span>attachments</span><span>2</span>
      <span>tags</span><span>ai-chat, claude</span>
    </div>
    <h1>Kitchen layout options</h1>
    <h2>User · 2026-10-19 09:12</h2>
    Our kitchen is 3.2 × 4 m with a window on the long wall. Which layouts work?
    <h2>Claude · 2026-10-19 09:13</h2>
    <div class="callout">▸ Thinking</div>
    Three good options for that room: an <b>L-shape</b>, a <b>galley</b>, or a <b>U-shape</b>…
    <h2>Claude · 2026-10-19 09:15</h2>
    Here is the plan and the cabinet list.<br>
    <b>Attachments:</b> <a>kitchen-l-shape.pdf</a> · <a>cabinets.csv</a>
  </div>`;
}

/** The small promo tile: the icon, the name, the four services. */
function promoTile(icon) {
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; }
    body { background: radial-gradient(circle at 25% 40%, #262b3b, ${COLORS.panel} 55%, ${COLORS.bg});
      font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: ${COLORS.text};
      display: flex; align-items: center; gap: 18px; padding: 0 26px; box-sizing: border-box; }
    img { width: 150px; height: 150px; flex: none; }
    .brand { color: ${COLORS.yellow}; font-size: 14px; font-weight: 700; letter-spacing: .12em; }
    h1 { margin: 4px 0 8px; font-size: 30px; line-height: 1.05; font-weight: 800; }
    p { margin: 0; font-size: 14px; line-height: 1.35; color: rgba(242,242,238,.82); }
  </style><img src="${icon}"><div><div class="brand">CODINGCAT</div><h1>AI Chat<br>Exporter</h1>
  <p>Claude, Gemini, Grok and ChatGPT chats to Markdown, with every file</p></div>`;
}

/** The marquee promo tile, for the store's carousel: the preview card, wider. */
function marqueeTile(icon) {
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: 1400px; height: 560px; overflow: hidden; }
    body { background: radial-gradient(circle at 18% 50%, #262b3b, ${COLORS.panel} 45%, ${COLORS.bg});
      font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: ${COLORS.text};
      display: flex; align-items: center; gap: 56px; padding: 0 110px; box-sizing: border-box; }
    img { width: 380px; height: 380px; flex: none; }
    .brand { color: ${COLORS.yellow}; font-size: 30px; font-weight: 700; letter-spacing: .12em; }
    h1 { margin: 10px 0 18px; font-size: 84px; line-height: 1; font-weight: 800; letter-spacing: -0.02em; }
    p { margin: 0 0 24px; font-size: 32px; line-height: 1.3; color: rgba(242,242,238,.82); max-width: 760px; }
    .chips { display: flex; gap: 14px; }
    .chip { border: 2px solid rgba(255,176,0,.75); color: ${COLORS.yellow}; border-radius: 999px; padding: 8px 22px; font-size: 26px; font-weight: 600; }
  </style><img src="${icon}"><div><div class="brand">CODINGCAT</div><h1>AI Chat Exporter</h1>
  <p>Save your chats and projects as Markdown, with every file in its original format.</p>
  <div class="chips"><span class="chip">Claude</span><span class="chip">Gemini</span><span class="chip">Grok</span><span class="chip">ChatGPT</span></div></div>`;
}

const build = mkdtempSync(join(tmpdir(), 'ai-chat-exporter-store-'));
const work = mkdtempSync(join(tmpdir(), 'ai-chat-exporter-shots-'));
mkdirSync(OUT, { recursive: true });
try {
  buildExtension(ROOT, build);
  const data = standData();
  const stand = await startStand({ extDir: build, ...fakeClaude(data) });
  try {
    const ext = `chrome-extension://${stand.extensionId}/src/ui`;
    await stand.settings({ delayBetweenChatsMs: 0 });
    const icon = dataUrl(join(ROOT, 'assets/logo.png'));

    // 1. The popup on a chat inside a project: its active tab is that chat.
    const chatTab = await stand.inExtension(
      `chrome.tabs.create({ url: 'https://claude.ai/chat/${data.chatInProject}', active: false }).then((t) => t.id)`,
    );
    await sleep(2500);
    const { result: target } = await stand.send('Target.createTarget', { url: 'about:blank' });
    const { result: attached } = await stand.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const popup = attached.sessionId;
    await stand.send('Page.enable', {}, popup);
    await stand.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `chrome.tabs.query = () => Promise.resolve([{ id: ${chatTab}, url: 'https://claude.ai/chat/${data.chatInProject}' }]);`,
      },
      popup,
    );
    await stand.send('Page.navigate', { url: `${ext}/popup/index.html` }, popup);
    await sleep(3000);
    const popupHeight = await stand.ev(
      popup,
      `Math.ceil(document.querySelector('main').getBoundingClientRect().height)`,
    );
    await shot(stand, popup, 320, popupHeight, join(work, 'popup.png'));
    await htmlShot(
      stand,
      work,
      'chat',
      chatWithPopup({ image: dataUrl(join(work, 'popup.png')), icon }),
      1160,
      640,
      join(work, 'chat.png'),
    );
    await htmlShot(
      stand,
      work,
      'frame1',
      frame(
        'Save the chat you are reading <b>in one click</b>',
        `<img src="${dataUrl(join(work, 'chat.png'))}">`,
      ),
      1280,
      800,
      join(OUT, 'screenshot-1-popup.png'),
    );

    // 2. The export page with the list, some chats ticked.
    const page = await stand.openTab(`${ext}/export-page/index.html?platform=claude`);
    await waitFor(
      () => stand.ev(page, `document.querySelectorAll('tbody tr').length === ${TITLES.length}`),
      60000,
      'the list',
    );
    await stand.ev(
      page,
      `[...document.querySelectorAll('tbody input[type=checkbox]')].slice(0, 6).forEach((c) => c.click())`,
    );
    await shot(stand, page, 1160, 640, join(work, 'list.png'));
    await htmlShot(
      stand,
      work,
      'frame2',
      frame(
        'Pick chats by date, project or title — <b>or all of them</b>',
        `<img src="${dataUrl(join(work, 'list.png'))}">`,
      ),
      1280,
      800,
      join(OUT, 'screenshot-2-choose.png'),
    );

    // 3. The same page after the export: progress and statuses.
    await stand.ev(page, `document.querySelector('.actions button.primary').click()`);
    await waitFor(
      async () => {
        const job = await stand.job();
        return job && job.status === 'finished';
      },
      120000,
      'the export',
    );
    await sleep(800);
    await stand.ev(page, `window.scrollTo(0, 0)`);
    await shot(stand, page, 1160, 640, join(work, 'done.png'));
    await htmlShot(
      stand,
      work,
      'frame3',
      frame(
        'Hundreds of chats in the background, <b>with a report</b>',
        `<img src="${dataUrl(join(work, 'done.png'))}">`,
      ),
      1280,
      800,
      join(OUT, 'screenshot-3-progress.png'),
    );

    // 4. A saved note and its folder.
    await htmlShot(stand, work, 'note', savedNote(), 1160, 640, join(work, 'note.png'));
    await htmlShot(
      stand,
      work,
      'frame4',
      frame(
        'Markdown notes with <b>every file</b>, ready for Obsidian',
        `<img src="${dataUrl(join(work, 'note.png'))}">`,
      ),
      1280,
      800,
      join(OUT, 'screenshot-4-note.png'),
    );

    // The small promo tile.
    await htmlShot(
      stand,
      work,
      'tile',
      promoTile(icon),
      440,
      280,
      join(OUT, 'promo-small-440x280.png'),
    );
    await htmlShot(
      stand,
      work,
      'marquee',
      marqueeTile(icon),
      1400,
      560,
      join(OUT, 'promo-marquee-1400x560.png'),
    );
  } finally {
    await stand.close();
  }
} finally {
  rmSync(build, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
console.log(`Images written to ${OUT}`);
