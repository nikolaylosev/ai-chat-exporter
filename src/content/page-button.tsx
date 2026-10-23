import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import { send } from '../shared/messages';
import { loadSettings } from '../shared/settings';

/**
 * A small button in the corner of a chat page that saves the open chat, as the
 * keyboard shortcut does (the result shows in the panel). It floats over the
 * page instead of sitting in the site's own toolbar, which changes too often to
 * hook into. Shown on chat pages only, unless turned off in the settings.
 */

const HOST_ID = 'ai-chat-exporter-page-button';
/** How often the page is checked: these sites change the chat without reloading. */
const CHECK_MS = 1000;

const STYLE = `
:host { all: initial; }
button {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
  width: 40px; height: 40px; border-radius: 50%; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.18); background: #14161f; color: #ffb000;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28); cursor: pointer;
  transition: transform 0.12s ease, opacity 0.12s ease;
}
button:hover { transform: scale(1.08); }
button:focus-visible { outline: 2px solid #ffb000; outline-offset: 2px; }
button:disabled { opacity: 0.6; cursor: default; transform: none; }
svg { width: 20px; height: 20px; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
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

function PageButton({ isChat }: { isChat: () => boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [onChat, setOnChat] = useState(isChat());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const read = () => void loadSettings().then((s) => setEnabled(s.showPageButton));
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

  if (!enabled || !onChat) return null;
  const save = async () => {
    setBusy(true);
    try {
      // The worker shows progress and the result in the page's panel.
      await send('background', 'export:this-tab', {});
    } catch {
      // The extension was reloaded or updated; the page needs a reload.
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      title={t('pageButtonTitle')}
      aria-label={t('pageButtonTitle')}
      disabled={busy}
      onClick={() => void save()}
    >
      <SaveIcon />
    </button>
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
