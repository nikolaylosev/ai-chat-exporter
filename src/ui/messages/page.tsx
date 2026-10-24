import { useEffect, useState } from 'preact/hooks';
import { codeText, errorText } from '../../shared/error-text';
import { t } from '../../shared/i18n';
import { send, type ChatOutline, type ExportResult } from '../../shared/messages';
import { PLATFORM_LABEL } from '../../shared/platform';
import { localDateTime } from '../../util/dates';
import { ensureFolderAccess, ExportResultView, FilesCheckbox, useSettings } from '../common';
import '../styles.css';
import './messages.css';

type Outcome =
  | { kind: 'saved'; result: ExportResult }
  | { kind: 'copied'; count: number }
  | { kind: 'error'; message: string };

/**
 * Choosing messages of one chat (the chat of tab `?tab=`): its messages with a
 * box each, then save the chosen ones, with or without their files, or copy
 * them as Markdown. Shift-click ticks a range.
 */
export function MessagesPage() {
  const tabId = Number(new URLSearchParams(location.search).get('tab'));
  const [settings, updateSettings] = useSettings();
  const [chat, setChat] = useState<ChatOutline | null>(null);
  const [loadError, setLoadError] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    send('background', 'messages:list', { tabId }).then(
      (outline) => {
        setChat(outline);
        document.title = `${outline.title || t('untitledChat')} · ${t('extName')}`;
      },
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [tabId]);

  if (loadError) {
    return (
      <main>
        <h1>{t('messagesTitle')}</h1>
        <p class="error">{loadError}</p>
        <p class="muted">{t('messagesReopen')}</p>
      </main>
    );
  }
  if (!chat) {
    return (
      <main>
        <h1>{t('messagesTitle')}</h1>
        <p class="muted">{t('messagesLoading')}</p>
      </main>
    );
  }

  const ids = chat.messages.map((m) => m.id);
  // In the chat's order, whatever order they were ticked in.
  const picked = () => ids.filter((id) => chosen.has(id));

  const toggle = (index: number, range: boolean) => {
    const next = new Set(chosen);
    const id = ids[index] ?? '';
    const on = !next.has(id);
    const from = range && anchor !== null ? Math.min(anchor, index) : index;
    const to = range && anchor !== null ? Math.max(anchor, index) : index;
    for (const each of ids.slice(from, to + 1)) {
      if (on) next.add(each);
      else next.delete(each);
    }
    setChosen(next);
    setAnchor(index);
  };

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setOutcome(null);
    try {
      if (settings.destination === 'folder') {
        const code = await ensureFolderAccess();
        if (code) return setOutcome({ kind: 'error', message: codeText(code) });
      }
      const result = await send('background', 'messages:export', {
        tabId,
        ids: picked(),
        withFiles: settings.saveAttachments,
      });
      setOutcome({ kind: 'saved', result });
    } catch (error) {
      setOutcome({ kind: 'error', message: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const copied = await send('background', 'messages:copy', { tabId, ids: picked() });
      if (!copied.ok) return setOutcome({ kind: 'error', message: copied.message });
      await navigator.clipboard.writeText(copied.markdown);
      setOutcome({ kind: 'copied', count: copied.messageCount });
    } catch (error) {
      setOutcome({ kind: 'error', message: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const assistant = PLATFORM_LABEL[chat.platform];
  return (
    <main>
      <h1>{chat.title || t('untitledChat')}</h1>
      <p class="muted">{t('messagesHint')}</p>
      <div class="tools">
        <button type="button" onClick={() => setChosen(new Set(ids))}>
          {t('messagesAll')}
        </button>
        <button type="button" onClick={() => setChosen(new Set())}>
          {t('messagesNone')}
        </button>
        <button
          type="button"
          onClick={() =>
            setChosen(new Set(chat.messages.filter((m) => m.role === 'user').map((m) => m.id)))
          }
        >
          {t('messagesMine')}
        </button>
      </div>
      <ul class="messages">
        {chat.messages.map((m, index) => (
          <li
            key={m.id}
            class={`${m.role} ${chosen.has(m.id) ? 'chosen' : ''}`}
            onClick={(e) => toggle(index, e.shiftKey)}
          >
            <input
              type="checkbox"
              checked={chosen.has(m.id)}
              aria-label={t('messagesChoose', String(index + 1))}
              // The row handles the click, so the box and the row do not toggle twice.
              onClick={(e) => {
                e.stopPropagation();
                toggle(index, e.shiftKey);
              }}
            />
            <div class="body">
              <span class="who">{m.role === 'user' ? t('mdUser') : assistant}</span>
              {m.createdAt && <span class="muted">{localDateTime(m.createdAt)}</span>}
              {m.preview ? (
                <p class="text">{m.preview}</p>
              ) : (
                <p class="text muted">{t('messagesNoText')}</p>
              )}
              {m.files.length > 0 && (
                <p class="files muted">{t('messagesFiles', m.files.join(', '))}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {outcome?.kind === 'saved' && (
        <div class="outcome">
          <ExportResultView result={outcome.result} />
        </div>
      )}
      {outcome?.kind === 'copied' && (
        <p class="outcome ok">{t('panelCopied', String(outcome.count))}</p>
      )}
      {outcome?.kind === 'error' && <p class="outcome error">{outcome.message}</p>}
      <div class="actions">
        <p class="count muted">
          {t('messagesCount', [String(chosen.size), String(chat.messages.length)])}
        </p>
        {settings && <FilesCheckbox settings={settings} update={updateSettings} />}
        <button type="button" disabled={chosen.size === 0 || busy} onClick={() => void copy()}>
          {t('messagesCopy')}
        </button>
        <button
          type="button"
          class="primary"
          disabled={chosen.size === 0 || busy || !settings}
          onClick={() => void save()}
        >
          {busy ? t('popupSaving') : t('messagesSave', String(chosen.size))}
        </button>
      </div>
    </main>
  );
}
