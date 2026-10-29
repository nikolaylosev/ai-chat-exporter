import type {
  Conversation,
  ConversationList,
  ConversationOptions,
  ConversationSummary,
} from '../model/conversation';
import type { Project, ProjectSummary } from '../model/project';
import type { SweepState } from '../adapters/gemini/search';
import { errorCode, type ErrorCode } from './errors';
import { errorMessage, log } from './logger';
import type { TransferableSource } from '../sinks/source';
import type { Platform } from './platform';

/** A file of a chat that was not saved, and why. */
export interface FileFailure {
  name: string;
  reason: string;
}

/** Failures kept per chat in results and job state; the count is always complete. */
export const MAX_LISTED_FAILURES = 50;

/**
 * Typed messaging between extension contexts.
 *
 * chrome.runtime.sendMessage delivers a message to every extension page and the
 * service worker at once, so each request names its `target`, and each context
 * handles only its own requests. Payloads must be JSON-serializable: no Blobs.
 * Requests to `content` go to one tab with chrome.tabs.sendMessage (sendToTab).
 * An error's `code` (CodedError) is passed through to the caller.
 */

/** Where the export went: `path` is relative to Downloads or to the chosen folder, or absolute. */
export type SavedLocation =
  | { kind: 'downloads'; path: string }
  | { kind: 'folder'; folder: string; path: string }
  | { kind: 'absolute'; path: string }
  /** A conversation inside an archive that is still being built (bulk export). */
  | { kind: 'archive'; archive: string; path: string };

/** Result of writing one file in the offscreen document; per-file failures are not exceptions. */
export type WriteReply =
  /** `size`: bytes of the archive so far, when the file went into one. */
  { ok: true; size?: number } | { ok: false; reason: string };

export type ExportResult =
  | {
      ok: true;
      title: string;
      messageCount: number;
      /** Files saved into `files/`. */
      attachmentCount: number;
      /** Files that could not be saved; marked with ⚠️ in the Markdown. */
      failedAttachmentCount: number;
      /** Their names and reasons, at most MAX_LISTED_FAILURES. */
      failures?: FileFailure[];
      /** The Markdown file, or the archive when saving as ZIP. */
      location: SavedLocation;
    }
  | { ok: false; code: ErrorCode; message: string };

/** The open chat's note, without its files, for the clipboard. */
export type CopyResult =
  | { ok: true; title: string; messageCount: number; markdown: string }
  | { ok: false; code: ErrorCode; message: string };

/** A chat's messages, for choosing which to save (the messages page). */
export interface ChatOutline {
  title: string;
  platform: Platform;
  messages: {
    id: string;
    role: 'user' | 'assistant';
    createdAt: string | null;
    /** The start of its text, without Markdown marks. */
    preview: string;
    /** Names of its files. */
    files: string[];
  }[];
}

/** What the panel on a chat page shows after the keyboard shortcut. */
export type PanelView =
  | { state: 'running'; copying?: boolean; files?: { done: number; total: number } }
  | { state: 'result'; result: ExportResult }
  | { state: 'copied'; messageCount: number };

export interface JobStartItem {
  kind?: 'conversation' | 'project';
  id: string;
  title: string;
  updatedAt: string | null;
  /** A project: export its chats too. */
  withChats?: boolean;
}

type Empty = Record<string, never>;

interface Contract {
  background: {
    'export:current': { request: { tabId: number }; response: ExportResult };
    'export:copy': { request: { tabId: number }; response: CopyResult };
    /** The page button: the chat of the tab that asks, as the shortcut saves it. */
    'export:this-tab': { request: { withFiles?: boolean }; response: ExportResult };
    /** Opens the messages page for a tab's chat (the asking tab's by default). */
    'messages:open': { request: { tabId?: number }; response: null };
    /** For that page: the messages of the chat in `tabId`. */
    'messages:list': { request: { tabId: number }; response: ChatOutline };
    /** The chosen messages of that chat, saved; `withFiles` as the page's checkbox says. */
    'messages:export': {
      request: { tabId: number; ids: string[]; withFiles: boolean };
      response: ExportResult;
    };
    /** The chosen messages as Markdown, for the page to put on the clipboard. */
    'messages:copy': { request: { tabId: number; ids: string[] }; response: CopyResult };
    /** The page button's Copy: the asking tab's chat onto the clipboard. */
    'copy:this-tab': { request: Record<string, never>; response: CopyResult };
    /**
     * A platform tab with the content script ready, opened in the background if none
     * is open. The caller talks to it directly: a long list (Gemini, minutes) must not
     * keep a service worker event open, which Chrome ends after five minutes.
     */
    'platform:tab': {
      request: { platform: Platform };
      response: { tabId: number; opened: boolean };
    };
    /** Closes a tab from `platform:tab` if the extension opened it. */
    'platform:tab-done': { request: { tabId: number; opened: boolean }; response: null };
    'projects:list': { request: { platform: Platform }; response: ProjectSummary[] };
    /** The project of a tab's page or chat, injecting the content script if needed. */
    'project:of-tab': {
      request: { tabId: number };
      response: { id: string; name: string } | null;
    };
    'job:start': { request: { platform: Platform; items: JobStartItem[] }; response: null };
    'job:cancel': { request: Empty; response: null };
    'registry:count': { request: Empty; response: { count: number } };
    /** The platform's chats the registry has, with the title read from each folder. */
    'registry:chats': {
      request: { platform: Platform };
      response: { id: string; title: string; updatedAt: string | null; missingFiles?: number }[];
    };
    'registry:clear': { request: Empty; response: null };
    /** Pages a content script cannot open itself. */
    'open:options': { request: Empty; response: null };
  };
  content: {
    ping: { request: Empty; response: { platform: Platform } };
    /** `known`: chat ids with update times the page has from before (Gemini reads only what is newer). */
    'conversations:list': {
      /** `until`: stop at chats last updated before then (ISO 8601); see the adapters. */
      request: { known?: [string, string | null][]; until?: string };
      response: ConversationList;
    };
    /**
     * A new download link for a file of a conversation read before, when the first
     * one stopped working (ChatGPT's signed links); null when there is none.
     */
    'conversation:file-link': {
      request: { conversationId: string; attachmentId: string };
      response: { url: string | null };
    };
    /** Ends a running `conversations:list` after its current page, with what it read. */
    'conversations:list-stop': { request: Empty; response: null };
    /**
     * Chats beyond the list, found through the platform's search (Gemini). Runs for
     * minutes; progress comes as `ui` `search:progress`, `conversations:search-stop`
     * ends it early with what was found.
     */
    'conversations:search': {
      /** `resume`: where an earlier search stopped, to go on from there. */
      request: { knownIds: string[]; resume?: SweepState };
      response: {
        conversations: ConversationSummary[];
        queries: number;
        end: 'exhausted' | 'stalled' | 'limit' | 'stopped';
        state: SweepState;
      };
    };
    'conversations:search-stop': { request: Empty; response: null };
    /**
     * Chats by id, with their titles and dates (Gemini: ids from Google Takeout).
     * `missing` are no longer on the platform; `failed` could not be read now.
     * `atOnce`: how many requests at a time (fewer when the platform refuses).
     */
    'conversations:lookup': {
      request: { ids: string[]; atOnce?: number };
      response: { conversations: ConversationSummary[]; missing: string[]; failed: string[] };
    };
    'projects:list': { request: Empty; response: ProjectSummary[] };
    'project:get': { request: { id: string }; response: Project };
    /** The project of the open page or chat, if any. */
    'project:current': { request: Empty; response: { id: string; name: string } | null };
    'panel:show': { request: PanelView; response: null };
    'conversation:current-id': { request: Empty; response: { id: string | null } };
    'conversation:get': {
      request: { id: string; options: ConversationOptions };
      response: Conversation;
    };
  };
  offscreen: {
    'blob:create': { request: { text: string; mime: string }; response: { url: string } };
    'docx:create': { request: { markdown: string; title: string }; response: { url: string } };
    'clipboard:write': { request: { text: string }; response: null };
    'blob:revoke': { request: { url: string }; response: null };
    /** Checks the chosen folder; picks a free `name (2)` unless overwriting. */
    'folder:prepare': {
      request: { folderPath: string; overwrite: boolean };
      response: { folder: string; folderPath: string };
    };
    'folder:write': { request: { path: string; source: TransferableSource }; response: WriteReply };
    'folder:remove': { request: { path: string }; response: WriteReply };
    'zip:open': { request: Empty; response: { id: string } };
    'zip:add': {
      request: { id: string; path: string; source: TransferableSource };
      response: WriteReply;
    };
    /** Finishes the archive as a blob URL for chrome.downloads. */
    'zip:close-to-url': { request: { id: string }; response: { url: string } };
    /** Finishes the archive into the chosen folder; picks a free name unless overwriting. */
    'zip:close-to-folder': {
      request: { id: string; path: string; overwrite: boolean };
      response: { folder: string; path: string };
    };
    'zip:discard': { request: { id: string }; response: null };
    /** The image type of the file at a URL, from its first bytes; null if unknown or unreadable. */
    /** With `keep`, the file is downloaded whole and kept for the folder or ZIP write. */
    'file:sniff': { request: { url: string; keep: boolean }; response: { mime: string | null } };
  };
  /** Extension pages: the export page follows a long chat list while it loads. */
  ui: {
    'list:progress': { request: { platform: Platform; loaded: number }; response: null };
    'search:progress': {
      /** `conversations`: the chats the latest query found, not seen before. */
      request: {
        platform: Platform;
        found: number;
        queries: number;
        conversations: ConversationSummary[];
        /** Now and then: where the search is, so a closed page can go on from there. */
        state?: SweepState;
      };
      response: null;
    };
  };
}

type Target = keyof Contract;
type TypeOf<T extends Target> = keyof Contract[T] & string;
type RequestOf<T extends Target, K extends TypeOf<T>> = Contract[T][K] extends { request: infer R }
  ? R
  : never;
type ResponseOf<T extends Target, K extends TypeOf<T>> = Contract[T][K] extends {
  response: infer R;
}
  ? R
  : never;

interface Envelope {
  target: Target;
  type: string;
  payload: unknown;
}

type Reply<R> = { ok: true; value: R } | { ok: false; error: string; code?: ErrorCode };

function unwrap<R>(reply: Reply<R> | undefined, what: string): R {
  if (!reply) throw new Error(`No handler for ${what}`);
  if (!reply.ok)
    throw Object.assign(new Error(reply.error), reply.code ? { code: reply.code } : {});
  return reply.value;
}

export async function send<T extends Exclude<Target, 'content'>, K extends TypeOf<T>>(
  target: T,
  type: K,
  payload: RequestOf<T, K>,
): Promise<ResponseOf<T, K>> {
  const envelope: Envelope = { target, type, payload };
  const reply = await chrome.runtime.sendMessage<Envelope, Reply<ResponseOf<T, K>> | undefined>(
    envelope,
  );
  return unwrap(reply, `${target}:${type}`);
}

export async function sendToTab<K extends TypeOf<'content'>>(
  tabId: number,
  type: K,
  payload: RequestOf<'content', K>,
): Promise<ResponseOf<'content', K>> {
  const envelope: Envelope = { target: 'content', type, payload };
  const reply = await chrome.tabs.sendMessage<
    Envelope,
    Reply<ResponseOf<'content', K>> | undefined
  >(tabId, envelope);
  return unwrap(reply, `content:${type} in tab ${tabId}`);
}

export type Handlers<T extends Target> = {
  [K in TypeOf<T>]: (
    payload: RequestOf<T, K>,
    sender: chrome.runtime.MessageSender,
  ) => Promise<ResponseOf<T, K>> | ResponseOf<T, K>;
};

function isEnvelope(message: unknown): message is Envelope {
  return (
    typeof message === 'object' &&
    message !== null &&
    'target' in message &&
    'type' in message &&
    typeof (message as Envelope).type === 'string'
  );
}

export function handle<T extends Target>(target: T, handlers: Handlers<T>): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isEnvelope(message) || message.target !== target) return false;
    const handler = (handlers as Record<string, Handlers<T>[TypeOf<T>]>)[message.type];
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(message.payload as never, sender))
      .then(
        (value) => sendResponse({ ok: true, value } satisfies Reply<unknown>),
        (error: unknown) => {
          log.error(`${target}:${message.type} failed`, error);
          const code = errorCode(error);
          sendResponse({
            ok: false,
            error: errorMessage(error),
            ...(code !== 'failed' ? { code } : {}),
          } satisfies Reply<unknown>);
        },
      );
    return true; // keep the channel open for the async response
  });
}
