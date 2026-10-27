import { strFromU8 } from 'fflate';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { renderHtml } from '../../render/html';
import { t } from '../../shared/i18n';
import { errorMessage } from '../../shared/logger';
import { PLATFORM_LABEL, type Platform } from '../../shared/platform';
import {
  canUseFolders,
  loadFolderHandle,
  loadSearchFolder,
  saveSearchFolder,
} from '../../sinks/folder-handle';
import {
  clearIndex,
  displayPath,
  parseNote,
  readNote,
  scanArchive,
  type ScanProgress,
} from '../../search/archive';
import { headingRole, noteFormatOf } from '../../search/notes';
import {
  queryTerms,
  search,
  type IndexedNote,
  type SearchFilters,
  type SearchHit,
} from '../../search/query';
import '../styles.css';
import './search.css';

type FolderState =
  | { kind: 'loading' }
  | { kind: 'none'; exportFolder: FileSystemDirectoryHandle | null }
  | { kind: 'needs-access'; handle: FileSystemDirectoryHandle }
  | { kind: 'ready'; handle: FileSystemDirectoryHandle };

/** The note to show: its page, and which message to scroll to. */
interface Shown {
  hit: SearchHit;
  html: string;
}

const PLATFORMS = Object.keys(PLATFORM_LABEL) as Platform[];

async function folderState(): Promise<FolderState> {
  const handle = await loadSearchFolder();
  if (!handle) return { kind: 'none', exportFolder: await loadFolderHandle().catch(() => null) };
  const access = await handle.queryPermission({ mode: 'read' });
  return access === 'granted' ? { kind: 'ready', handle } : { kind: 'needs-access', handle };
}

/** A note as a page for the viewer: Markdown and HTML as they are, the others from their messages. */
function notePage(name: string, bytes: Uint8Array, title: string): string {
  const format = noteFormatOf(name);
  if (format === 'markdown') return renderHtml(strFromU8(bytes), title);
  if (format === 'html') return strFromU8(bytes);
  const note = parseNote(name, bytes);
  const label = (role: 'user' | 'assistant') =>
    role === 'user' ? 'User' : (note?.platform && PLATFORM_LABEL[note.platform]) || 'AI';
  const markdown = (note?.messages ?? [])
    .map((m) => `## ${label(m.role)}${m.time ? ` · ${m.time}` : ''}\n\n${m.text}`)
    .join('\n\n');
  return renderHtml(`# ${title}\n\n${markdown}`, title);
}

/** Scrolls the viewer to message `index` and marks the query's terms in it. */
function showMessage(frame: HTMLIFrameElement, index: number, terms: string[]) {
  const doc = frame.contentDocument;
  if (!doc) return;
  const headings = [...doc.querySelectorAll('h2, h4')].filter((h) =>
    headingRole(h.textContent ?? ''),
  );
  const heading = headings[index];
  if (!heading) return;
  heading.scrollIntoView({ block: 'start' });
  const style = doc.createElement('style');
  style.textContent = 'mark { background: #fde68a; color: inherit; }';
  doc.head.append(style);
  if (!terms.length) return;
  // Marks the terms from this heading to the next one.
  const next = headings[index + 1] ?? null;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  let inside = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) inside = true;
    if (next && next.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
    if (inside) texts.push(node as Text);
  }
  const pattern = new RegExp(
    terms
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/е/g, '[её]'))
      .join('|'),
    'gi',
  );
  for (const text of texts) {
    const value = text.nodeValue ?? '';
    if (!pattern.test(value)) continue;
    pattern.lastIndex = 0;
    const fragment = doc.createDocumentFragment();
    let at = 0;
    for (const m of value.matchAll(pattern)) {
      fragment.append(value.slice(at, m.index));
      const mark = doc.createElement('mark');
      mark.textContent = m[0];
      fragment.append(mark);
      at = (m.index ?? 0) + m[0].length;
    }
    fragment.append(value.slice(at));
    text.replaceWith(fragment);
  }
}

/**
 * Searching the saved archive: a folder (the export folder, an Obsidian vault,
 * Downloads/AI Chats with its .zip exports) is read once into an index kept in
 * IndexedDB; then every query runs locally over all platforms. Nothing leaves
 * the computer.
 */
export function SearchPage() {
  const [folder, setFolder] = useState<FolderState>({ kind: 'loading' });
  const [notes, setNotes] = useState<IndexedNote[] | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  const [shown, setShown] = useState<Shown | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    document.title = `${t('searchTitle')} · ${t('extName')}`;
    void folderState().then(setFolder, () => setFolder({ kind: 'none', exportFolder: null }));
  }, []);

  // Reads the folder whenever it becomes readable.
  useEffect(() => {
    if (folder.kind !== 'ready') return;
    setError('');
    setProgress(null);
    scanArchive(folder.handle, setProgress).then(
      (all) => {
        setNotes(all);
        setProgress(null);
      },
      (e: unknown) => setError(t('searchReadError', errorMessage(e))),
    );
  }, [folder]);

  const use = async (handle: FileSystemDirectoryHandle) => {
    const previous = await loadSearchFolder();
    if (!previous || !(await previous.isSameEntry(handle))) {
      await clearIndex();
      setNotes(null);
      setShown(null);
    }
    await saveSearchFolder(handle);
    const access = await handle.requestPermission({ mode: 'read' });
    setFolder(access === 'granted' ? { kind: 'ready', handle } : { kind: 'needs-access', handle });
  };

  const choose = async () => {
    try {
      await use(await window.showDirectoryPicker({ id: 'search-folder', mode: 'read' }));
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(t('searchReadError', errorMessage(e)));
    }
  };

  const result = useMemo(
    () => (notes ? search(notes, query, filters) : { hits: [], total: 0 }),
    [notes, query, filters],
  );

  const open = async (hit: SearchHit) => {
    if (folder.kind !== 'ready') return;
    try {
      const bytes = await readNote(folder.handle, hit.note.key);
      const name = hit.note.key.slice(hit.note.key.lastIndexOf('/') + 1);
      setShown({ hit, html: notePage(name, bytes, hit.note.title || t('untitledChat')) });
    } catch (e) {
      setError(t('searchReadError', errorMessage(e)));
    }
  };

  const update = (patch: Partial<SearchFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const chats = new Set(result.hits.map((h) => h.note.key)).size;

  return (
    <main>
      <h1>{t('searchTitle')}</h1>
      <p class="muted">{t('searchHint')}</p>

      {!canUseFolders() && (
        <p class="warn">
          {t('searchUnsupported')}
          {'brave' in navigator && <> {t('optionsFolderBrave')}</>}
        </p>
      )}
      <div class="folder">
        {folder.kind === 'none' && <p>{t('searchNoFolder')}</p>}
        {(folder.kind === 'ready' || folder.kind === 'needs-access') && (
          <p>{t('searchFolder', folder.handle.name)}</p>
        )}
        {folder.kind === 'needs-access' && (
          <button type="button" class="primary" onClick={() => void use(folder.handle)}>
            {t('searchAllow')}
          </button>
        )}
        {folder.kind === 'none' && folder.exportFolder && (
          <button type="button" class="primary" onClick={() => void use(folder.exportFolder!)}>
            {t('searchUseExportFolder', folder.exportFolder.name)}
          </button>
        )}
        {folder.kind !== 'loading' && canUseFolders() && (
          <button type="button" onClick={() => void choose()}>
            {folder.kind === 'none' ? t('searchChoose') : t('searchChooseOther')}
          </button>
        )}
      </div>
      {folder.kind === 'none' && <p class="muted">{t('searchZipHint')}</p>}
      {progress && (
        <p class="muted">
          {t('searchReading', [
            String(progress.done),
            String(progress.total),
            String(progress.notes),
          ])}
        </p>
      )}
      {error && <p class="error">{error}</p>}

      {notes && (
        <>
          <div class="query">
            <input
              type="search"
              value={query}
              placeholder={t('searchPlaceholder', String(notes.length))}
              aria-label={t('searchTitle')}
              autoFocus
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <select
              aria-label={t('searchPlatform')}
              value={filters.platform ?? ''}
              onChange={(e) =>
                update({ platform: (e.currentTarget.value || null) as Platform | null })
              }
            >
              <option value="">{t('searchAllPlatforms')}</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABEL[p]}
                </option>
              ))}
            </select>
            <select
              aria-label={t('searchWho')}
              value={filters.role ?? ''}
              onChange={(e) =>
                update({ role: (e.currentTarget.value || null) as 'user' | 'assistant' | null })
              }
            >
              <option value="">{t('searchEveryone')}</option>
              <option value="user">{t('messagesMine')}</option>
              <option value="assistant">{t('messagesReplies')}</option>
            </select>
            <input
              type="text"
              value={filters.project ?? ''}
              placeholder={t('searchProject')}
              aria-label={t('searchProject')}
              onInput={(e) => update({ project: e.currentTarget.value })}
            />
            <input
              type="date"
              aria-label={t('searchFrom')}
              title={t('searchFrom')}
              value={filters.from ?? ''}
              onInput={(e) => update({ from: e.currentTarget.value })}
            />
            <input
              type="date"
              aria-label={t('searchTo')}
              title={t('searchTo')}
              value={filters.to ?? ''}
              onInput={(e) => update({ to: e.currentTarget.value })}
            />
          </div>
          {query.trim() && (
            <p class="muted">
              {result.total
                ? t('searchFound', [String(result.total), String(chats)])
                : t('searchNothing')}
              {result.total > result.hits.length &&
                ` ${t('searchFirst', String(result.hits.length))}`}
            </p>
          )}
          <div class="layout">
            <ul class="hits">
              {result.hits.map((hit) => (
                <li
                  key={`${hit.note.key}#${hit.message}`}
                  class={shown?.hit === hit ? 'open' : ''}
                  onClick={() => void open(hit)}
                >
                  <div class="title">{hit.note.title || t('untitledChat')}</div>
                  <div class="meta muted">
                    {[
                      hit.note.platform ? PLATFORM_LABEL[hit.note.platform] : null,
                      hit.note.created?.slice(0, 10),
                      hit.note.project,
                      hit.note.messages[hit.message]?.role === 'user' ? t('mdUser') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <p class="snippet">
                    {hit.snippet.map((part, i) =>
                      part.match ? <mark key={i}>{part.text}</mark> : part.text,
                    )}
                  </p>
                </li>
              ))}
            </ul>
            {shown && (
              <section class="viewer">
                <header>
                  <p class="muted">{displayPath(shown.hit.note.key)}</p>
                  {shown.hit.note.url && /^https:\/\//.test(shown.hit.note.url) && (
                    <a href={shown.hit.note.url} target="_blank" rel="noreferrer">
                      {t(
                        'searchOpenChat',
                        shown.hit.note.platform ? PLATFORM_LABEL[shown.hit.note.platform] : '',
                      )}
                    </a>
                  )}
                </header>
                <iframe
                  ref={frame}
                  // The note is shown as a document of its own: no scripts, nothing sent.
                  sandbox="allow-same-origin"
                  srcDoc={shown.html}
                  title={shown.hit.note.title}
                  onLoad={() =>
                    frame.current &&
                    showMessage(frame.current, shown.hit.message, queryTerms(query))
                  }
                />
              </section>
            )}
          </div>
        </>
      )}
    </main>
  );
}
