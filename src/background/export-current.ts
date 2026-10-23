import { errorText } from '../shared/error-text';
import { CodedError, errorCode, isUserOutcome } from '../shared/errors';
import { t } from '../shared/i18n';
import { log } from '../shared/logger';
import { sendToTab, type CopyResult, type ExportResult, type PanelView } from '../shared/messages';
import { detectPlatform } from '../shared/platform';
import { loadSettings, type Settings } from '../shared/settings';
import { planConversationExport, renderConversationExport } from './conversation-export';
import { setBadge as setTabBadge, type BadgeState } from './badge';
import { exportConversation } from './export-conversation';
import { renderLabels } from './labels';
import { registry } from './registry';
import { ensureContentScript } from './tabs';

export type Trigger = 'popup' | 'command';

/** Conversations being exported right now; a repeated trigger for the same one is ignored. */
const running = new Set<string>();

/** The mark on the chat tab's icon: one chat's result stays 5 s. */
function setBadge(tabId: number, state: BadgeState | null): Promise<void> {
  return setTabBadge(state, { tabId, clearAfterMs: 5000 });
}

async function notify(message: string): Promise<void> {
  await chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: t('extName'),
    message,
  });
}

function resultText(result: ExportResult): string {
  if (!result.ok) return result.message;
  return result.failedAttachmentCount
    ? t('notifyPartial', [
        String(result.messageCount),
        String(result.attachmentCount),
        String(result.failedAttachmentCount),
      ])
    : t('notifyDone', [String(result.messageCount), String(result.attachmentCount)]);
}

/**
 * Feedback for a keyboard-shortcut export: a panel on the chat page, or a system
 * notification where the page has no content script.
 */
async function showFeedback(tabId: number, view: PanelView): Promise<boolean> {
  try {
    await sendToTab(tabId, 'panel:show', view);
    return true;
  } catch {
    return false;
  }
}

function failure(error: unknown): ExportResult {
  const code = errorCode(error);
  const result: ExportResult = { ok: false, code, message: errorText(error) };
  if (code === 'save-dialog') result.warning = 'save-dialog-suspected';
  return result;
}

/** The id of the conversation open in a tab, with its content script ready. */
async function openConversationId(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId);
  const platform = detectPlatform(tab.url);
  if (!platform) throw new CodedError('unsupported-page', `Unsupported page: ${tab.url ?? ''}`);
  await ensureContentScript(tabId, platform);
  const { id } = await sendToTab(tabId, 'conversation:current-id', {});
  if (!id) throw new CodedError('not-a-chat', 'The tab is not a conversation page');
  return id;
}

async function runExport(
  tabId: number,
  trigger: Trigger,
  overrides: Partial<Settings>,
): Promise<ExportResult> {
  const id = await openConversationId(tabId);
  if (running.has(id)) throw new CodedError('busy', `Already exporting ${id}`);

  running.add(id);
  try {
    await setBadge(tabId, 'working');
    const settings = { ...(await loadSettings()), ...overrides };
    if (trigger === 'command' && settings.showNotifications) {
      await showFeedback(tabId, { state: 'running' });
    }
    const conversation = await sendToTab(tabId, 'conversation:get', {
      id,
      options: { artifactVersions: settings.artifactVersions },
    });
    const outcome = await exportConversation(conversation, settings, registry, undefined, {
      refreshLink: (attachment) =>
        sendToTab(tabId, 'conversation:file-link', {
          conversationId: conversation.id,
          attachmentId: attachment.id,
        }).then((r) => r.url),
    });
    const result: ExportResult = {
      ok: true,
      title: conversation.title,
      messageCount: conversation.messages.length,
      attachmentCount: outcome.savedFiles,
      failedAttachmentCount: outcome.failedFiles,
      location: outcome.location,
    };
    if (outcome.failures.length) result.failures = outcome.failures;
    log.info('Exported', result);
    return result;
  } finally {
    running.delete(id);
  }
}

/** Exports the conversation open in a tab. Never throws; failures come back as a result. */
/** `overrides` change the settings for this export only, e.g. the page button's "text only". */
export async function exportCurrent(
  tabId: number,
  trigger: Trigger,
  overrides: Partial<Settings> = {},
): Promise<ExportResult> {
  let result: ExportResult;
  try {
    result = await runExport(tabId, trigger, overrides);
  } catch (error) {
    (isUserOutcome(errorCode(error)) ? log.info : log.error)('Export failed', error);
    result = failure(error);
  }

  // A repeated trigger is ignored silently: the first export is still running.
  if (!result.ok && result.code === 'busy') return result;
  // Cancelling the Save As dialog is the user's choice: no mark on the icon.
  const cancelled =
    !result.ok && (result.code === 'save-cancelled' || result.code === 'save-dialog');
  await setBadge(
    tabId,
    cancelled ? null : !result.ok ? 'failed' : result.failedAttachmentCount ? 'partial' : 'done',
  );
  if (trigger === 'command' && (await loadSettings()).showNotifications) {
    const shown = await showFeedback(tabId, { state: 'result', result });
    if (!shown) await notify(resultText(result));
  }
  return result;
}

/**
 * The note of the conversation open in a tab, as it would be saved without its
 * files (they are listed by name), for the popup to put on the clipboard. Never
 * throws; failures come back as a result.
 */
export async function copyCurrent(tabId: number): Promise<CopyResult> {
  try {
    const id = await openConversationId(tabId);
    const settings = { ...(await loadSettings()), saveAttachments: false };
    const conversation = await sendToTab(tabId, 'conversation:get', {
      id,
      options: { artifactVersions: settings.artifactVersions },
    });
    const ctx = { now: new Date(), labels: renderLabels(conversation.platform) };
    const plan = planConversationExport(conversation, settings, ctx);
    return {
      ok: true,
      title: conversation.title,
      messageCount: conversation.messages.length,
      markdown: renderConversationExport(conversation, settings, ctx, plan),
    };
  } catch (error) {
    const code = errorCode(error);
    (isUserOutcome(code) ? log.info : log.error)('Copy failed', error);
    return { ok: false, code, message: errorText(error) };
  }
}
