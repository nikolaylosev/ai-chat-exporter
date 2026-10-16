import type { Platform } from '../shared/platform';
import type { Attachment, ConversationSummary } from './conversation';

export interface ProjectSummary {
  id: string;
  platform: Platform;
  name: string;
  description: string;
  /** ISO 8601; null if the platform does not provide it. */
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
  /** Knowledge base files, when the list says. */
  knowledgeCount?: number;
}

/** A Claude Project: instructions, knowledge base and its chats. */
export interface Project extends ProjectSummary {
  instructions: string;
  /** Knowledge base files: text documents and uploaded binaries. */
  knowledge: Attachment[];
  /** The project's chats, newest first. */
  conversations: ConversationSummary[];
}
