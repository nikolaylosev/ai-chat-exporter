import type { RenderLabels } from '../../src/render/markdown';

/** English labels shared by renderer tests. */
export const LABELS: RenderLabels = {
  user: 'User',
  assistant: 'Claude',
  untitled: 'Untitled',
  thinking: 'Thinking',
  webSearch: (q) => `Web search: “${q}”`,
  noResults: 'No results',
  tools: (n) => `Tools (${n})`,
  toolError: 'error',
  attachments: 'Attachments',
  attachmentFailed: (r) => `could not download: ${r}`,
  extractedOnly: 'extracted text only',
  extractedPartial: 'beginning of the extracted text only',
  rebuiltFromChat: 'rebuilt from the chat',
  recompressed: 're-encoded by the service',
  otherBranches: 'Other branches',
  unreadable: (kind) => `A part of this message could not be read (${kind})`,
  branch: (n, fork) =>
    fork === null
      ? `Branch ${n}, from the start`
      : fork.branch === 1
        ? `Branch ${n}, after message ${fork.position}`
        : `Branch ${n}, after message ${fork.position} of branch ${fork.branch}`,
  selection: (chosen, total) => `${chosen} of the chat's ${total} messages`,
};
