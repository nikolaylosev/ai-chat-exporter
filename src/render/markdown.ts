import type { Attachment, Block, Conversation, Message } from '../model/conversation';
import { isoWithOffset, localDateTime } from '../util/dates';

export interface RenderLabels {
  user: string;
  /** Model name in headings: `Claude`, `Gemini`. */
  assistant: string;
  untitled: string;
  thinking: string;
  webSearch: (query: string) => string;
  noResults: string;
  tools: (count: number) => string;
  toolError: string;
  attachments: string;
  attachmentFailed: (reason: string) => string;
  /** Suffix for a file that holds only text extracted from the original. */
  extractedOnly: string;
  /** The same, when the platform kept only the beginning of that text. */
  extractedPartial: string;
  /** Suffix for an artifact rebuilt from the model's edits instead of the published file. */
  rebuiltFromChat: string;
  /** Suffix for an image the platform keeps re-encoded (full size, not the original bytes). */
  recompressed: string;
  otherBranches: string;
  /** A part of a message the extension could not read; `kind` is the platform's block type. */
  unreadable: (kind: string) => string;
  /**
   * Heading of another branch. `fork` says where it starts: null for the beginning of
   * the conversation, otherwise the 1-based message position in branch `fork.branch`
   * (1 is the main branch).
   */
  branch: (number: number, fork: { branch: number; position: number } | null) => string;
  /** Under the title of a note with chosen messages only: `5 of the chat's 40 messages`. */
  selection: (chosen: number, total: number) => string;
  /** The platform stopped answering partway: the oldest messages are missing. */
  incomplete: string;
}

export interface RenderOptions {
  labels: RenderLabels;
  includeThinking: boolean;
  includeToolCalls: boolean;
  toolCallDetail: 'compact' | 'full';
  includeBranches: boolean;
  exportedAt: Date;
  /** Where `created` comes from (section 8 of docs/ARCHITECTURE.md). */
  createdSource: 'platform' | 'first-message' | 'export';
  /** Saved attachments: id → path relative to the Markdown file, e.g. `files/report.pdf`. */
  attachmentPaths?: ReadonlyMap<string, string>;
  /** Attachments that failed to download: id → reason. */
  attachmentErrors?: ReadonlyMap<string, string>;
  timeZone?: string;
}

/** YAML scalar: JSON strings are valid YAML double-quoted scalars. */
export function yaml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return 'null';
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

function callout(type: string, title: string, body: string): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  return [`> [!${type}]- ${title}`, ...lines.map((l) => (l ? `> ${l}` : '>'))].join('\n');
}

export function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

/** Relative link target that works in Obsidian and CommonMark: spaces and parentheses encoded. */
export function linkTarget(path: string): string {
  return encodeURI(path).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * The text with a code fence it leaves open closed at its end. A model's reply
 * can stop inside a code block; left open, it would turn the rest of the note
 * into code (in Obsidian, and for the archive search reading the note back).
 */
export function closeFences(markdown: string): string {
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const mark = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!mark?.[1]) continue;
    if (!fence) fence = mark[1];
    else if (mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2]?.trim()) {
      fence = null;
    }
  }
  return fence ? `${markdown}\n${fence}` : markdown;
}

/** A fence longer than any backtick run inside the text. */
function fence(text: string, info = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${info}\n${text.replace(/\s+$/, '')}\n${ticks}`;
}

function heading(level: number, message: Message, o: RenderOptions): string {
  const who = message.role === 'user' ? o.labels.user : o.labels.assistant;
  const when = message.createdAt ? ` · ${localDateTime(message.createdAt, o.timeZone)}` : '';
  return `${'#'.repeat(level)} ${who}${when}`;
}

function renderToolCalls(calls: Extract<Block, { type: 'tool-call' }>[], o: RenderOptions): string {
  const lines: string[] = [];
  for (const call of calls) {
    const label = call.label ? `: ${call.label}` : '';
    const error = call.isError ? ` (${o.labels.toolError})` : '';
    if (o.toolCallDetail === 'compact') {
      lines.push(`- **${call.name}**${label}${error}`);
      continue;
    }
    lines.push(`**${call.name}**${label}${error}`, '');
    if (call.input) lines.push(fence(call.input, call.inputLanguage ?? 'json'), '');
    if (call.output) lines.push(fence(call.output), '');
  }
  return callout('abstract', o.labels.tools(calls.length), lines.join('\n'));
}

function renderBlocks(blocks: Block[], o: RenderOptions): string[] {
  const parts: string[] = [];
  const toolCalls = blocks.filter(
    (b): b is Extract<Block, { type: 'tool-call' }> => b.type === 'tool-call',
  );
  let toolsPlaced = false;

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(closeFences(block.markdown.replace(/\s+$/, '')));
        break;
      case 'thinking':
        if (o.includeThinking) parts.push(callout('note', o.labels.thinking, block.markdown));
        break;
      case 'web-search': {
        if (!o.includeToolCalls) break;
        const body = block.results.length
          ? block.results.map((r) => `- [${escapeLinkText(r.title)}](${r.url})`).join('\n')
          : o.labels.noResults;
        parts.push(callout('info', o.labels.webSearch(block.query), body));
        break;
      }
      case 'unreadable':
        parts.push(`> ⚠️ ${o.labels.unreadable(block.kind)}`);
        break;
      case 'tool-call':
        // All tool calls of a message go into one callout, placed where the first one was.
        if (o.includeToolCalls && !toolsPlaced) {
          parts.push(renderToolCalls(toolCalls, o));
          toolsPlaced = true;
        }
        break;
    }
  }
  return parts;
}

function renderAttachments(attachments: Attachment[], o: RenderOptions): string | null {
  if (!attachments.length) return null;
  const lines = attachments.map((a) => {
    const path = o.attachmentPaths?.get(a.id);
    const note =
      a.note === 'extracted-text-only'
        ? ` (${o.labels.extractedOnly})`
        : a.note === 'extracted-text-partial'
          ? ` (${o.labels.extractedPartial})`
          : a.note === 'rebuilt-from-chat'
            ? ` (${o.labels.rebuiltFromChat})`
            : a.note === 'recompressed'
              ? ` (${o.labels.recompressed})`
              : '';
    if (path) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      return `- [${escapeLinkText(name)}](${linkTarget(path)})${note}`;
    }
    const error = o.attachmentErrors?.get(a.id);
    if (error) return `- ⚠️ ${a.name} — ${o.labels.attachmentFailed(error)}`;
    return `- ${a.name}${note}`;
  });
  return `**${o.labels.attachments}:**\n${lines.join('\n')}`;
}

function renderMessage(message: Message, level: number, o: RenderOptions): string {
  const parts = [heading(level, message, o), ...renderBlocks(message.blocks, o)];
  const attachments = renderAttachments(message.attachments, o);
  if (attachments) parts.push(attachments);
  return parts.join('\n\n');
}

function frontmatter(c: Conversation, o: RenderOptions): string {
  const exported = isoWithOffset(o.exportedAt, o.timeZone);
  const created =
    o.createdSource === 'export'
      ? exported
      : c.createdAt
        ? isoWithOffset(c.createdAt, o.timeZone)
        : null;
  const attachmentCount = c.messages.reduce((n, m) => n + m.attachments.length, 0);
  const fields: [string, string][] = [
    ['title', yaml(c.title || o.labels.untitled)],
    ['platform', c.platform],
    ['conversation_id', yaml(c.id)],
    ['url', yaml(c.url)],
    ['created', created ?? 'null'],
    ['updated', c.updatedAt ? isoWithOffset(c.updatedAt, o.timeZone) : 'null'],
    ['created_source', o.createdSource],
    ['exported', exported],
    ['model', yaml(c.model)],
    ['project', yaml(c.project)],
    ['message_count', String(c.messages.length)],
    ...(c.selection ? ([['chosen_from', String(c.selection.total)]] as [string, string][]) : []),
    ['attachments', String(attachmentCount)],
    ['tags', `[ai-chat, ${c.platform}]`],
  ];
  return ['---', ...fields.map(([k, v]) => `${k}: ${v}`), '---'].join('\n');
}

export function renderMarkdown(c: Conversation, o: RenderOptions): string {
  const sections = [frontmatter(c, o), `# ${c.title || o.labels.untitled}`];
  if (c.selection) sections.push(`*${o.labels.selection(c.messages.length, c.selection.total)}*`);
  if (c.incomplete) sections.push(`> ⚠️ ${o.labels.incomplete}`);
  for (const m of c.messages) sections.push(renderMessage(m, 2, o));

  if (o.includeBranches && c.branches.length) {
    sections.push(`## ${o.labels.otherBranches}`);
    // Where each exported message sits: branch number (1 = main) and 1-based position.
    const location = new Map<string, { branch: number; position: number }>();
    c.messages.forEach((m, i) => location.set(m.id, { branch: 1, position: i + 1 }));
    c.branches.forEach((branch, i) => {
      const number = i + 2;
      const fork = branch.forkAfterMessageId
        ? (location.get(branch.forkAfterMessageId) ?? null)
        : null;
      branch.messages.forEach((m, j) =>
        location.set(m.id, { branch: number, position: (fork?.position ?? 0) + j + 1 }),
      );
      sections.push(`### ${o.labels.branch(number, fork)}`);
      for (const m of branch.messages) sections.push(renderMessage(m, 4, o));
    });
  }
  return `${sections.join('\n\n')}\n`;
}
