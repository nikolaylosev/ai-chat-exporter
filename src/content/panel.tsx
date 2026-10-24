import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from '../shared/i18n';
import { locationLabel } from '../shared/location';
import { send, type ExportResult, type PanelView } from '../shared/messages';

/**
 * Panel on the chat page for a keyboard-shortcut export: progress, then the
 * result and where it went, and the ZIP choice for the next export. It lives in a
 * shadow root, so the page's styles do not reach it and its styles stay inside.
 */

const HOST_ID = 'ai-chat-exporter-panel';
const HIDE_AFTER_MS = { ok: 6000, attention: 15000 };

const STYLE = `
:host { all: initial; }
.panel {
  --bg: #ffffff; --text: #18181b; --muted: #52525b; --border: #d4d4d8;
  --accent: #2563eb; --ok: #15803d; --warn: #b45309; --error: #b91c1c;
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 320px; max-width: calc(100vw - 32px); box-sizing: border-box;
  padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
}
@media (prefers-color-scheme: dark) {
  .panel {
    --bg: #27272a; --text: #f4f4f5; --muted: #a1a1aa; --border: #3f3f46;
    --accent: #60a5fa; --ok: #4ade80; --warn: #fbbf24; --error: #f87171;
  }
}
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
h2 { margin: 0; font-size: 13px; font-weight: 600; }
p { margin: 0 0 6px; }
.close { border: none; background: none; color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; }
.ok { color: var(--ok); }
.warn { color: var(--warn); }
.error { color: var(--error); }
.muted { color: var(--muted); }
.failures { margin: 0 0 8px; padding-left: 18px; font-size: 12px; color: var(--warn); overflow-wrap: anywhere; }
.failures code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; color: var(--muted); }
.link { border: none; background: none; padding: 0; color: var(--accent); text-decoration: underline; cursor: pointer; font: inherit; }
label { display: flex; gap: 6px; align-items: center; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); color: var(--muted); cursor: pointer; }
.spinner { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -1px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

function needsAttention(result: ExportResult): boolean {
  // A cancelled save goes quickly; a cancelled file stays, for its hint about Chrome's setting.
  if (!result.ok) return result.code !== 'save-cancelled';
  return result.failedAttachmentCount > 0;
}

function ResultView({ result }: { result: ExportResult }) {
  if (!result.ok) {
    const folderProblem = result.code.startsWith('folder-');
    return (
      <>
        <p
          class={
            ['save-cancelled', 'save-dialog', 'download-cancelled'].includes(result.code)
              ? 'muted'
              : 'error'
          }
        >
          {result.message}
        </p>
        {folderProblem && (
          <p>
            <button
              type="button"
              class="link"
              onClick={() => void send('background', 'open:options', {})}
            >
              {t('openSettings')}
            </button>
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <p class={result.failedAttachmentCount ? 'warn' : 'ok'}>
        {result.failedAttachmentCount
          ? t('popupDonePartial', [
              String(result.messageCount),
              String(result.attachmentCount),
              String(result.failedAttachmentCount),
            ])
          : t('popupDone', [String(result.messageCount), String(result.attachmentCount)])}
      </p>
      {result.failures?.length ? (
        <ul class="failures">
          {result.failures.map((f, i) => (
            <li key={i}>
              <code>{f.name}</code>
              {f.reason ? ` — ${f.reason}` : ''}
            </li>
          ))}
          {result.failedAttachmentCount > result.failures.length && (
            <li>
              {t('failedFilesMore', String(result.failedAttachmentCount - result.failures.length))}
            </li>
          )}
        </ul>
      ) : null}
      <p>
        {locationLabel(result.location)}
        <br />
        <span class="path">{result.location.path}</span>
      </p>
    </>
  );
}

function Panel({ view, onClose }: { view: PanelView; onClose: () => void }) {
  const hovered = useRef(false);
  useEffect(() => {
    if (view.state === 'running') return undefined;
    const delay =
      view.state === 'result' && needsAttention(view.result)
        ? HIDE_AFTER_MS.attention
        : HIDE_AFTER_MS.ok;
    const timer = setInterval(() => {
      if (!hovered.current) onClose();
    }, delay);
    return () => clearInterval(timer);
  }, [view, onClose]);

  return (
    <div
      class="panel"
      role="status"
      aria-live="polite"
      onMouseEnter={() => (hovered.current = true)}
      onMouseLeave={() => (hovered.current = false)}
    >
      <header>
        <h2>{t('extName')}</h2>
        <button type="button" class="close" aria-label={t('panelClose')} onClick={onClose}>
          ×
        </button>
      </header>
      {view.state === 'running' ? (
        <p>
          <span class="spinner" aria-hidden="true" />
          {t(view.copying ? 'panelCopying' : 'popupSaving')}
        </p>
      ) : view.state === 'copied' ? (
        <p class="ok">{t('panelCopied', String(view.messageCount))}</p>
      ) : (
        <ResultView result={view.result} />
      )}
    </div>
  );
}

function hide(): void {
  const host = document.getElementById(HOST_ID);
  if (host?.shadowRoot) render(null, host.shadowRoot);
  host?.remove();
}

export function showPanel(view: PanelView): void {
  let host = document.getElementById(HOST_ID);
  if (!host?.shadowRoot) {
    host?.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.append(style, document.createElement('div'));
    document.documentElement.append(host);
  }
  const mount = host.shadowRoot!.lastElementChild!;
  render(<Panel view={view} onClose={hide} />, mount);
}
