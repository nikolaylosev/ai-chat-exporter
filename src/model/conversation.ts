import type { Platform } from '../shared/platform';
import type { FileSource } from '../sinks/types';

export interface ConversationSummary {
  id: string;
  platform: Platform;
  title: string;
  /** ISO 8601; null if the platform does not provide it. */
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
  /** Claude Project or Gemini Gem. */
  project?: string;
  /** Not in the platform's list; found through its search (Gemini, older chats). */
  foundBySearch?: boolean;
  /** Not in the list nor found by search, but exported before: known from the registry. */
  savedBefore?: boolean;
  /** Archived on the platform (ChatGPT): hidden from its history, still exported. */
  archived?: boolean;
}

/**
 * A platform's chat list; `incomplete` when it ends early: the platform stopped
 * answering, or the user stopped the loading (`stopped`).
 */
export interface ConversationList {
  conversations: ConversationSummary[];
  incomplete?: { loaded: number; stopped?: boolean };
  /**
   * The list was read only down to chats the caller already had unchanged
   * (`known`); the older ones are as the caller has them.
   */
  reachedKnown?: boolean;
}

export interface Conversation extends ConversationSummary {
  model?: string;
  /** The branch the user sees, root first. */
  messages: Message[];
  /** Other branches, each starting right after the message it forks from. */
  branches: Branch[];
  /** Only some messages were chosen (selectMessages): how many the chat has. */
  selection?: { total: number };
}

/**
 * The conversation with only the chosen messages of the branch the user sees, in
 * their order, each with its files. Other branches are left out.
 */
export function selectMessages(c: Conversation, ids: readonly string[]): Conversation {
  const chosen = new Set(ids);
  return {
    ...c,
    messages: c.messages.filter((m) => chosen.has(m.id)),
    branches: [],
    selection: { total: c.messages.length },
  };
}

export interface Branch {
  /** The last message shared with an earlier branch; null when it forks at the root. */
  forkAfterMessageId: string | null;
  messages: Message[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  createdAt: string | null;
  blocks: Block[];
  attachments: Attachment[];
}

export type Block =
  | { type: 'text'; markdown: string }
  | { type: 'thinking'; markdown: string }
  | {
      type: 'tool-call';
      name: string;
      /** Short human-readable label shown by the platform, e.g. "Ran a command". */
      label?: string;
      /** Tool input as pretty-printed JSON, or code in `inputLanguage`. */
      input?: string;
      inputLanguage?: string;
      /** Text output of the tool. */
      output?: string;
      isError?: boolean;
    }
  | { type: 'web-search'; query: string; results: { title: string; url: string }[] }
  /** A part of the message the extension could not read; `kind` is the platform's type. */
  | { type: 'unreadable'; kind: string };

export interface Attachment {
  id: string;
  /** Original file name. */
  name: string;
  mime?: string;
  size?: number;
  origin: 'user-upload' | 'model-generated' | 'artifact' | 'image' | 'project-knowledge';
  /** null: cannot be downloaded, only mentioned. */
  source: FileSource | null;
  note?: AttachmentNote;
  /** Why the platform does not provide it, in the platform's words. */
  unavailableReason?: string;
}

/**
 * - `extracted-text-only`: the platform keeps only text extracted from the original.
 * - `extracted-text-partial`: the same, and only the beginning of that text.
 * - `rebuilt-from-chat`: an artifact rebuilt from the model's edits, not the published file.
 * - `unavailable`: nothing can be downloaded (source is null).
 * - `recompressed`: the platform keeps the image re-encoded, at full size but not byte for byte.
 */
export type AttachmentNote =
  | 'extracted-text-only'
  | 'extracted-text-partial'
  | 'rebuilt-from-chat'
  | 'unavailable'
  | 'recompressed';

export interface ConversationOptions {
  artifactVersions: 'latest' | 'all';
}
