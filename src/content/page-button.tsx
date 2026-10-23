import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import { send } from '../shared/messages';
import { loadSettings, NOTE_EXTENSION, saveSettings, type Settings } from '../shared/settings';
import { showPanel } from './panel';

/**
 * A small button in the corner of a chat page with a menu: save the chat with
 * its files, save its text only, or copy it as Markdown. Saving works as the
 * keyboard shortcut does (the result shows in the panel); the menu's choice
 * applies to this export only. The button floats over the page instead of
 * sitting in the site's own toolbar, which changes too often to hook into. Shown
 * on chat pages only, unless turned off in the settings.
 */

const HOST_ID = 'ai-chat-exporter-page-button';
/** How often the page is checked: these sites change the chat without reloading. */
const CHECK_MS = 1000;

const STYLE = `
:host { all: initial; }
.round {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
  width: 40px; height: 40px; border-radius: 50%; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.18); background: #14161f; color: #ffb000;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28); cursor: pointer;
  transition: transform 0.12s ease;
}
.round:hover { transform: scale(1.08); }
.round:focus-visible, .menu button:focus-visible { outline: 2px solid #ffb000; outline-offset: 2px; }
.round svg { width: 20px; height: 20px; }
.menu {
  position: fixed; right: 20px; bottom: 68px; z-index: 2147483646;
  min-width: 230px; padding: 6px; border-radius: 10px;
  background: #14161f; border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
}
.menu button {
  display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 16px;
  padding: 8px 10px; border: none; border-radius: 6px; background: none;
  color: #f2f2ee; font: inherit; text-align: left; cursor: pointer;
}
.menu button:hover { background: rgba(255, 255, 255, 0.08); }
.menu .ext { color: #9aa0ad; font-size: 12px; }
.menu hr { border: none; border-top: 1px solid rgba(255, 255, 255, 0.12); margin: 6px 4px; }
.menu label { display: flex; align-items: center; gap: 8px; padding: 6px 10px; color: #c9cbd3; cursor: pointer; }
.menu input { accent-color: #ffb000; margin: 0; }
@media (prefers-reduced-motion: reduce) { .round { transition: none; } }
`;

function SaveIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5" />
      <path d="M3.5 13.5v2a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </svg>
  );
}

/** What a save will make: the note's extension, or `.zip` when saving as an archive. */
function savedAs(settings: Settings): string {
  return settings.saveAsZip ? '.zip' : `.${NOTE_EXTENSION[settings.noteFormat]}`;
}

async function save(withFiles: boolean): Promise<void> {
  try {
    // The worker shows progress and the result in the page's panel.
    await send('background', 'export:this-tab', { withFiles });
  } catch {
    // The extension was reloaded or updated; the page needs a reload.
  }
}

async function copy(): Promise<void> {
  showPanel({ state: 'running', copying: true });
  try {
    const copied = await send('background', 'copy:this-tab', {});
    showPanel(
      copied.ok
        ? { state: 'copied', messageCount: copied.messageCount }
        : { state: 'result', result: copied },
    );
  } catch {
    // The extension was reloaded or updated; the page needs a reload.
  }
}

function PageButton({ isChat }: { isChat: () => boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [onChat, setOnChat] = useState(isChat());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const read = () => void loadSettings().then(setSettings);
    read();
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && 'settings' in changes) read();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setOnChat(isChat()), CHECK_MS);
    return () => clearInterval(timer);
  }, [isChat]);

  // The menu closes on Escape and on a click anywhere else.
  useEffect(() => {
    if (!open) return undefined;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const away = (e: PointerEvent) => {
      const host = document.getElementById(HOST_ID);
      if (!host || !e.composedPath().includes(host)) setOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', away, true);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', away, true);
    };
  }, [open]);

  if (!settings?.showPageButton || !onChat) return null;
  const pick = (action: () => Promise<void>) => {
    setOpen(false);
    void action();
  };
  return (
    <div>
      {open && (
        <div class="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => pick(() => save(true))}>
            <span>{t('pageMenuWithFiles')}</span>
            <span class="ext">{savedAs(settings)}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => pick(() => save(false))}>
            <span>{t('pageMenuTextOnly')}</span>
            <span class="ext">{savedAs(settings)}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => pick(copy)}>
            <span>{t('pageMenuCopy')}</span>
          </button>
          <hr />
          {/* The same choice as in the popup and the panel: it stays for the next saves. */}
          <label>
            <input
              type="checkbox"
              checked={settings.saveAsZip}
              onChange={(e) => void saveSettings({ saveAsZip: e.currentTarget.checked })}
            />
            {t('saveAsZip')}
          </label>
        </div>
      )}
      <button
        type="button"
        class="round"
        title={t('pageButtonTitle')}
        aria-label={t('pageButtonTitle')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <SaveIcon />
      </button>
    </div>
  );
}

/**
 * Puts the button on the page; `isChat` says whether a chat is open now. A
 * button left by a copy of the script from before an extension update is replaced.
 */
export function mountPageButton(isChat: () => boolean): void {
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const mount = document.createElement('div');
  shadow.append(style, mount);
  document.documentElement.append(host);
  render(<PageButton isChat={isChat} />, mount);
}
