import { useEffect, useState } from 'preact/hooks';
import { t } from '../../shared/i18n';
import { send } from '../../shared/messages';
import { loadFolderHandle, requestFolderAccess, saveFolderHandle } from '../../sinks/folder-handle';
import { pickExportFolder } from '../common';
import '../styles.css';
import './page.css';

/**
 * A small window for "Save to folder…": Chrome opens its folder picker only from
 * an extension page and on a click, and a popup closes as soon as the picker
 * takes the focus. The chosen folder is kept (it is the settings' "folder you
 * choose"), and the chat of tab `?tab=` is saved into it; the chat page's panel
 * shows how it goes.
 */
export function PickFolder() {
  const query = new URLSearchParams(location.search);
  const tabId = Number(query.get('tab'));
  const files = query.get('files');
  const [last, setLast] = useState<FileSystemDirectoryHandle | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');

  useEffect(() => {
    void loadFolderHandle().then(setLast, () => setLast(null));
  }, []);

  const start = async (handle: FileSystemDirectoryHandle) => {
    if ((await requestFolderAccess(handle)) !== 'granted') {
      setError(t('error_folder_permission'));
      return;
    }
    await saveFolderHandle(handle);
    // Chrome takes the folder access back once no extension page is open (the
    // offscreen document does not count), so this window stays until the chat is
    // written. The chat page's panel shows the result.
    setSaving(handle.name);
    await send('background', 'export:to-folder', {
      tabId,
      ...(files === null ? {} : { withFiles: files === '1' }),
    }).catch(() => undefined);
    window.close();
  };

  const choose = async () => {
    setError('');
    const picked = await pickExportFolder();
    if (picked === 'closed') return;
    if (picked) return setError(picked);
    const handle = await loadFolderHandle();
    if (handle) await start(handle);
  };

  return (
    <main class="pick">
      <h1>{t('pickFolderTitle')}</h1>
      <p class="muted">{t('pickFolderHint')}</p>
      {saving ? (
        <p>{t('pickFolderSaving', saving)}</p>
      ) : (
        <div class="buttons">
          <button type="button" class="primary" onClick={() => void choose()}>
            {t('pickFolderChoose')}
          </button>
          {last && (
            <button type="button" onClick={() => void start(last)}>
              {t('pickFolderLast', last.name)}
            </button>
          )}
        </div>
      )}
      {error && <p class="error">{error}</p>}
    </main>
  );
}
