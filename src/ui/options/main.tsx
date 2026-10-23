import { render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../shared/i18n';
import { errorMessage } from '../../shared/logger';
import { send } from '../../shared/messages';
import { loadSettings, saveSettings, type Settings } from '../../shared/settings';
import {
  folderAccess,
  loadFolderHandle,
  requestFolderAccess,
  saveFolderHandle,
  type FolderAccess,
} from '../../sinks/folder-handle';
import { openShortcutSettings, useShortcut } from '../common';
import '../styles.css';
import './options.css';

type BooleanKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

function Check(props: {
  settings: Settings;
  name: BooleanKey;
  label: string;
  hint?: string;
  update: (patch: Partial<Settings>) => void;
}) {
  return (
    <label class="check">
      <input
        type="checkbox"
        checked={props.settings[props.name]}
        onChange={(e) => props.update({ [props.name]: e.currentTarget.checked })}
      />
      <span>
        {props.label}
        {props.hint && <small class="hint">{props.hint}</small>}
      </span>
    </label>
  );
}

function Select<
  K extends
    'toolCallDetail' | 'claudeBranches' | 'artifactVersions' | 'onFolderExists' | 'writeReport',
>(props: {
  settings: Settings;
  name: K;
  label: string;
  options: [Settings[K], string][];
  disabled?: boolean;
  update: (patch: Partial<Settings>) => void;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <select
        value={props.settings[props.name]}
        disabled={props.disabled}
        onChange={(e) => props.update({ [props.name]: e.currentTarget.value })}
      >
        {props.options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

interface FolderState {
  name: string | null;
  access: FolderAccess;
  error?: string;
}

async function readFolder(): Promise<FolderState> {
  const handle = await loadFolderHandle();
  return { name: handle?.name ?? null, access: await folderAccess(handle) };
}

/** The folder for the `folder` destination: picked once, kept in IndexedDB. */
function FolderPicker({ onChosen }: { onChosen: () => void }) {
  const [folder, setFolder] = useState<FolderState | null>(null);
  const reload = () => void readFolder().then(setFolder, () => setFolder(null));
  useEffect(reload, []);

  const choose = async () => {
    try {
      const handle = await window.showDirectoryPicker({
        id: 'export-folder',
        mode: 'readwrite',
        startIn: 'documents',
      });
      await saveFolderHandle(handle);
      onChosen();
      reload();
    } catch (error) {
      // The user closed the picker.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setFolder((current) => ({
        name: current?.name ?? null,
        access: current?.access ?? 'not-chosen',
        error: t('optionsFolderError', errorMessage(error)),
      }));
    }
  };

  const grant = async () => {
    await requestFolderAccess(await loadFolderHandle()).catch(() => undefined);
    reload();
  };

  if (!folder) return null;
  return (
    <div class="folder">
      <p>{folder.name ? t('optionsFolderChosen', folder.name) : t('optionsFolderNotChosen')}</p>
      {folder.access === 'prompt' && (
        <p class="warn">
          {t('optionsFolderNeedsAccess')}{' '}
          <button type="button" class="link" onClick={() => void grant()}>
            {t('optionsGrantAccess')}
          </button>
        </p>
      )}
      {folder.access === 'denied' && <p class="warn">{t('optionsFolderDenied')}</p>}
      {folder.error && <p class="error">{folder.error}</p>}
      <p>
        <button type="button" onClick={() => void choose()}>
          {folder.name ? t('optionsChangeFolder') : t('optionsChooseFolder')}
        </button>
      </p>
      <small class="hint">{t('optionsFolderPickerHint')}</small>
    </div>
  );
}

/** How many conversations the export registry remembers, and a button to forget them. */
function RegistryControl() {
  const [count, setCount] = useState<number | null>(null);
  const reload = () =>
    void send('background', 'registry:count', {}).then(
      ({ count }) => setCount(count),
      () => setCount(null),
    );
  useEffect(reload, []);
  return (
    <div class="field">
      <p>
        {count === null ? t('optionsRegistry') : t('optionsRegistryCount', String(count))}{' '}
        <button
          type="button"
          disabled={!count}
          onClick={() => {
            if (!confirm(t('optionsRegistryConfirm'))) return;
            void send('background', 'registry:clear', {}).then(reload);
          }}
        >
          {t('optionsRegistryClear')}
        </button>
      </p>
      <small class="hint">{t('optionsRegistryHint')}</small>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Options() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  const shortcut = useShortcut();

  useEffect(() => {
    document.title = t('optionsTitle');
    void loadSettings().then(setSettings);
  }, []);

  const update = (patch: Partial<Settings>) => {
    void saveSettings(patch).then((next) => {
      setSettings(next);
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1500);
    });
  };

  if (!settings) return null;
  const common = { settings, update };

  return (
    <main>
      <h1>{t('optionsTitle')}</h1>

      <Section title={t('optionsSectionSaving')}>
        <fieldset class="choice">
          <legend>{t('optionsDestination')}</legend>
          <label class="check">
            <input
              type="radio"
              name="destination"
              checked={settings.destination === 'downloads'}
              onChange={() => update({ destination: 'downloads' })}
            />
            <span>{t('optionsDestinationDownloads')}</span>
          </label>
          <label class="check">
            <input
              type="radio"
              name="destination"
              checked={settings.destination === 'folder'}
              onChange={() => update({ destination: 'folder' })}
            />
            <span>
              {t('optionsDestinationFolder')}
              <small class="hint">{t('optionsDestinationFolderHint')}</small>
            </span>
          </label>
        </fieldset>
        {settings.destination === 'folder' ? (
          <FolderPicker onChosen={() => update({ destination: 'folder' })} />
        ) : (
          <label class="field">
            <span>{t('optionsRootFolder')}</span>
            <input
              type="text"
              value={settings.rootFolder}
              placeholder="AI Chats"
              onChange={(e) => update({ rootFolder: e.currentTarget.value })}
            />
            <small class="hint">{t('optionsRootFolderHint')}</small>
          </label>
        )}
        <Check
          {...common}
          name="includePlatformInFolderName"
          label={t('optionsIncludePlatform')}
          hint={t('optionsIncludePlatformHint')}
        />
      </Section>

      <Section title={t('optionsSectionContent')}>
        <Select
          {...common}
          name="artifactVersions"
          label={t('optionsArtifactVersions')}
          disabled={!settings.saveAttachments}
          options={[
            ['latest', t('optionsArtifactVersionsLatest')],
            ['all', t('optionsArtifactVersionsAll')],
          ]}
        />
        <Check {...common} name="saveThinking" label={t('optionsSaveThinking')} />
        <Check
          {...common}
          name="saveToolCalls"
          label={t('optionsSaveToolCalls')}
          hint={t('optionsSaveToolCallsHint')}
        />
        <Select
          {...common}
          name="toolCallDetail"
          label={t('optionsToolCallDetail')}
          disabled={!settings.saveToolCalls}
          options={[
            ['compact', t('optionsToolCallDetailCompact')],
            ['full', t('optionsToolCallDetailFull')],
          ]}
        />
        <Select
          {...common}
          name="claudeBranches"
          label={t('optionsClaudeBranches')}
          options={[
            ['active', t('optionsClaudeBranchesActive')],
            ['all', t('optionsClaudeBranchesAll')],
          ]}
        />
      </Section>

      <Section title={t('optionsSectionBulk')}>
        <Select
          {...common}
          name="onFolderExists"
          label={t('optionsFolderExists')}
          options={[
            ['copy', t('optionsFolderExistsCopy')],
            ['overwrite', t('optionsFolderExistsOverwrite')],
          ]}
        />
        <Check
          {...common}
          name="skipUnchanged"
          label={t('optionsSkipUnchanged')}
          hint={t('optionsSkipUnchangedHint')}
        />
        <label class="field">
          <span>{t('optionsDelay')}</span>
          <input
            type="number"
            min={0}
            step={100}
            value={settings.delayBetweenChatsMs}
            onChange={(e) => {
              const value = Number(e.currentTarget.value);
              if (Number.isFinite(value) && value >= 0) update({ delayBetweenChatsMs: value });
            }}
          />
          <small class="hint">{t('optionsDelayHint')}</small>
        </label>
        <Select
          {...common}
          name="writeReport"
          label={t('optionsReport')}
          options={[
            ['on-errors', t('optionsReportOnErrors')],
            ['always', t('optionsReportAlways')],
            ['never', t('optionsReportNever')],
          ]}
        />
        <RegistryControl />
      </Section>

      <Section title={t('optionsSectionShortcut')}>
        <p>
          {shortcut === undefined
            ? ''
            : shortcut
              ? t('optionsShortcutCurrent', shortcut)
              : t('popupShortcutNotSet')}
        </p>
        <p>
          <button type="button" onClick={openShortcutSettings}>
            {t('optionsShortcutChange')}
          </button>
        </p>
        <Check {...common} name="showNotifications" label={t('optionsShowNotifications')} />
        <Check
          {...common}
          name="showPageButton"
          label={t('optionsShowPageButton')}
          hint={t('optionsShowPageButtonHint')}
        />
      </Section>

      <p class="muted">{t('optionsMoreLater')}</p>
      <p class="ok saved" aria-live="polite">
        {saved ? t('optionsSaved') : ''}
      </p>
    </main>
  );
}

render(<Options />, document.getElementById('app')!);
