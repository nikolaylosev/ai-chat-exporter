import type { RawMessage } from './schema';

/**
 * Artifacts are files the model writes in its sandbox and publishes with the
 * `Artifact` tool (docs/platforms-claude.md, section 7). This module reads the
 * conversation itself: which file was published where, and what the file
 * contained at that moment, rebuilt from the write and edit tool calls.
 */

export interface ArtifactPublication {
  /** Message that published this version. */
  messageId: string;
  /** Sandbox path of the published file. */
  filePath: string;
  /** `https://claude.ai/artifact/<shortId>`, when the tool result names it. */
  url: string | null;
  /** Version id such as `1791882915-2e7b`, when the tool result names it. */
  versionId: string | null;
  /** File content rebuilt from the conversation; null when an edit could not be replayed. */
  content: string | null;
}

type Input = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

// Tool names and input keys: cloud-session chats use Write/Edit, older chats create_file/str_replace.
function writeOf(name: string, input: Input): { path: string; content: string } | null {
  if (name !== 'Write' && name !== 'create_file') return null;
  const path = str(input.file_path) ?? str(input.path);
  const content = str(input.content) ?? str(input.file_text);
  return path !== undefined && content !== undefined ? { path, content } : null;
}

function editOf(
  name: string,
  input: Input,
): { path: string; oldText: string; newText: string; all: boolean } | null {
  if (name !== 'Edit' && name !== 'str_replace') return null;
  const path = str(input.file_path) ?? str(input.path);
  const oldText = str(input.old_string) ?? str(input.old_str);
  const newText = str(input.new_string) ?? str(input.new_str) ?? '';
  if (path === undefined || oldText === undefined) return null;
  return { path, oldText, newText, all: input.replace_all === true };
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/;
const VERSION_ID = /version id ([0-9]+-[0-9a-z]+)/i;

function resultText(block: Record<string, unknown>): string {
  const content = Array.isArray(block.content) ? (block.content as Record<string, unknown>[]) : [];
  return content
    .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('\n');
}

/** Publications in the given messages, oldest first. Pass the messages in conversation order. */
export function findArtifactPublications(messages: RawMessage[]): ArtifactPublication[] {
  const files = new Map<string, string | null>();
  const pending = new Map<string, { messageId: string; filePath: string }>();
  const publications: ArtifactPublication[] = [];

  for (const message of messages) {
    for (const raw of message.content) {
      const block = raw as Record<string, unknown>;
      const name = str(block.name) ?? '';
      if (raw.type === 'tool_use') {
        const input = (block.input ?? {}) as Input;
        const write = writeOf(name, input);
        if (write) files.set(write.path, write.content);
        const edit = editOf(name, input);
        if (edit) {
          const current = files.get(edit.path);
          files.set(
            edit.path,
            typeof current === 'string' && current.includes(edit.oldText)
              ? edit.all
                ? current.split(edit.oldText).join(edit.newText)
                : current.replace(edit.oldText, () => edit.newText)
              : null,
          );
        }
        const filePath = name === 'Artifact' ? str(input.file_path) : undefined;
        if (filePath && typeof block.id === 'string') {
          pending.set(block.id, { messageId: message.uuid, filePath });
        }
      } else if (raw.type === 'tool_result' && name === 'Artifact') {
        const call = pending.get(str(block.tool_use_id) ?? '');
        if (!call || block.is_error === true) continue;
        const text = resultText(block);
        publications.push({
          ...call,
          url: ARTIFACT_URL.exec(text)?.[0] ?? null,
          versionId: VERSION_ID.exec(text)?.[1] ?? null,
          content: files.get(call.filePath) ?? null,
        });
      }
    }
  }
  return publications;
}

/** Keeps the newest publication of each artifact, or all of them. */
export function selectPublications(
  publications: ArtifactPublication[],
  versions: 'latest' | 'all',
): ArtifactPublication[] {
  if (versions === 'all') return publications;
  const latest = new Map<string, ArtifactPublication>();
  for (const p of publications) latest.set(p.url ?? p.filePath, p);
  return [...latest.values()];
}

/** `Exporter Test` → `exporter-test`. Keeps letters and digits of any script. */
export function slugify(text: string): string {
  return (
    text
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'artifact'
  );
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * File name for one artifact file: `artifact-<title>.<ext>`, with `-v<n>` when all
 * versions are kept, and the file's own path when the artifact has several files.
 */
export function artifactFileName(args: {
  title: string | null;
  sandboxPath: string;
  /** Path inside the published artifact, e.g. `index.html`; null for a rebuilt file. */
  filePath: string | null;
  isMainFile: boolean;
  version: number | null;
}): string {
  const base = `artifact-${slugify(args.title ?? stemOf(args.sandboxPath))}`;
  const version = args.version !== null ? `-v${args.version}` : '';
  if (args.isMainFile || args.filePath === null) {
    const ext = (args.filePath && extensionOf(args.filePath)) || extensionOf(args.sandboxPath);
    return `${base}${version}${ext}`;
  }
  const inner = args.filePath.replace(/\//g, '-');
  return `${base}${version}-${inner}`;
}

const TEXT_TYPES = /^text\/|json|xml|javascript|ecmascript|svg|markdown|yaml|csv/i;

/** Text files are fetched as text so Chrome cannot change their extension by MIME type. */
export function isTextContentType(contentType: string | null | undefined): boolean {
  return contentType == null || TEXT_TYPES.test(contentType);
}
