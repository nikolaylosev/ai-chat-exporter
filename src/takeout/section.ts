import { escapeLinkText, linkTarget } from '../render/markdown';
import {
  localMinute,
  SECTION_END,
  SECTION_START,
  withoutSection,
  type ChatCompletion,
} from './complete';

/**
 * The "From Google Takeout" section at the end of a chat's note: the files
 * Gemini's history left out, then the prompts the chat does not show, each with
 * its answer and files. Markdown notes get it as Markdown, HTML notes as HTML
 * before `</body>`; a section an earlier run wrote is replaced.
 */

export interface SectionLabels {
  heading: string;
  /** Says where the section comes from; gets the date it was added. */
  intro: (date: string) => string;
  files: string;
  user: string;
  assistant: string;
  attachments: string;
  /** For a file Takeout names but does not hold. */
  notInTakeout: string;
}

const BLOCKS = new Set([
  'P',
  'DIV',
  'LI',
  'TR',
  'PRE',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'TABLE',
]);

/** Takeout's answer HTML as text: paragraphs and list items on their own lines. */
export function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    if (el.tagName === 'BR') {
      out.push('\n');
      return;
    }
    const block = BLOCKS.has(el.tagName);
    if (block) out.push('\n');
    if (el.tagName === 'LI') out.push('- ');
    el.childNodes.forEach(walk);
    // A list item ends at the next one: no blank line between items.
    if (block && el.tagName !== 'LI') out.push('\n');
  };
  doc.body.childNodes.forEach(walk);
  return (
    out
      .join('')
      // An item whose text is a paragraph: the text on the item's line.
      .replace(/^- \n+/gm, '- ')
      .replace(/[ \t]+\n/g, '\n')
      // No blank line between the items of a list.
      .replace(/^(- [^\n]*)\n\n(?=- )/gm, '$1\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

const minute = (iso: string, timeZone?: string) => localMinute(new Date(iso), timeZone);
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function markdownSection(
  c: ChatCompletion,
  labels: SectionLabels,
  date: string,
  timeZone?: string,
): string {
  const parts = [SECTION_START, `## ${labels.heading}`, labels.intro(date)];
  const link = (path: string) => `[${escapeLinkText(nameOf(path))}](${linkTarget(path)})`;
  if (c.files.length) {
    parts.push(
      `### ${labels.files}`,
      c.files.map((f) => `- ${minute(f.time, timeZone)} · ${link(f.path)}`).join('\n'),
    );
  }
  for (const p of c.prompts) {
    const user = [`### ${labels.user} · ${minute(p.time, timeZone)}`];
    if (p.text) user.push(p.text);
    if (p.links.length) {
      user.push(
        `**${labels.attachments}:**\n` +
          p.links
            .map((l) =>
              l.path ? `- ${link(l.path)}` : `- ${l.takeoutName} (${labels.notInTakeout})`,
            )
            .join('\n'),
      );
    }
    parts.push(user.join('\n\n'));
    const answer = htmlText(p.answer);
    if (answer) parts.push(`### ${labels.assistant} · ${minute(p.time, timeZone)}\n\n${answer}`);
  }
  parts.push(SECTION_END);
  return parts.join('\n\n');
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

export function htmlSection(
  c: ChatCompletion,
  labels: SectionLabels,
  date: string,
  timeZone?: string,
): string {
  const link = (path: string) =>
    `<a href="${escapeHtml(linkTarget(path))}">${escapeHtml(nameOf(path))}</a>`;
  const parts = [
    SECTION_START,
    '<section class="takeout">',
    `<h2>${escapeHtml(labels.heading)}</h2>`,
    paragraphs(labels.intro(date)),
  ];
  if (c.files.length) {
    parts.push(
      `<h3>${escapeHtml(labels.files)}</h3><ul>${c.files.map((f) => `<li>${minute(f.time, timeZone)} · ${link(f.path)}</li>`).join('')}</ul>`,
    );
  }
  for (const p of c.prompts) {
    parts.push(`<h3>${escapeHtml(labels.user)} · ${minute(p.time, timeZone)}</h3>`);
    if (p.text) parts.push(paragraphs(p.text));
    if (p.links.length) {
      parts.push(
        `<p><strong>${escapeHtml(labels.attachments)}:</strong></p><ul>${p.links
          .map(
            (l) =>
              `<li>${l.path ? link(l.path) : `${escapeHtml(l.takeoutName)} (${escapeHtml(labels.notInTakeout)})`}</li>`,
          )
          .join('')}</ul>`,
      );
    }
    const answer = htmlText(p.answer);
    if (answer)
      parts.push(
        `<h3>${escapeHtml(labels.assistant)} · ${minute(p.time, timeZone)}</h3>${paragraphs(answer)}`,
      );
  }
  parts.push('</section>', SECTION_END);
  return parts.join('\n');
}

/** The note with the section in place of an earlier one: at the end, or before `</body>`. */
export function withSection(text: string, section: string, format: 'markdown' | 'html'): string {
  const base = withoutSection(text);
  if (format === 'markdown') return `${base.replace(/\s+$/, '')}\n\n${section}\n`;
  const at = base.lastIndexOf('</body>');
  return at < 0 ? `${base}${section}\n` : `${base.slice(0, at)}${section}\n${base.slice(at)}`;
}

/** Writes the section into each Markdown and HTML note of the chat. */
export async function writeSections(
  c: ChatCompletion,
  labels: SectionLabels,
  date: string,
  timeZone?: string,
): Promise<void> {
  for (const note of c.chat.notes) {
    if (note.format !== 'markdown' && note.format !== 'html') continue;
    const handle = await c.chat.dir.getFileHandle(note.name);
    const text = await (await handle.getFile()).text();
    const section =
      note.format === 'markdown'
        ? markdownSection(c, labels, date, timeZone)
        : htmlSection(c, labels, date, timeZone);
    const writable = await handle.createWritable();
    await writable.write(withSection(text, section, note.format));
    await writable.close();
  }
}

export interface ReportLabels {
  title: string;
  /** Gets the date, the number of chats, files and prompts. */
  summary: (date: string, chats: number, files: number, prompts: number) => string;
  /** One chat's line: files and prompts added. */
  chat: (files: number, prompts: number) => string;
  /** Says that a JSON or Word note got the files only. */
  filesOnly: string;
}

/** Files copied into a chat: those of the prompts it shows and of those it does not. */
export const filesAdded = (c: ChatCompletion) =>
  c.files.length +
  new Set(c.prompts.flatMap((p) => p.links.flatMap((l) => (l.path ? [l.path] : [])))).size;

/** The report in `_reports/`: each chat with a link to its note and what it got. */
export function reportMarkdown(
  completions: readonly ChatCompletion[],
  labels: ReportLabels,
  date: string,
): string {
  const files = completions.reduce((n, c) => n + filesAdded(c), 0);
  const prompts = completions.reduce((n, c) => n + c.prompts.length, 0);
  const lines = completions.map((c) => {
    const note = c.chat.notes.find((n) => n.format === 'markdown') ?? c.chat.notes[0];
    const target = note ? linkTarget(`../${c.chat.path}${note.name}`) : '';
    const onlyFiles = !c.chat.notes.some((n) => n.format === 'markdown' || n.format === 'html');
    return `- [${escapeLinkText(c.chat.title || c.chat.id)}](${target}): ${labels.chat(filesAdded(c), c.prompts.length)}${onlyFiles ? ` (${labels.filesOnly})` : ''}`;
  });
  return `# ${labels.title}\n\n${labels.summary(date, completions.length, files, prompts)}\n\n${lines.join('\n')}\n`;
}

/** Writes the report as `_reports/takeout-<date and time>.md`; gives its name. */
export async function writeReport(
  root: FileSystemDirectoryHandle,
  text: string,
  stamp: string,
): Promise<string> {
  const reports = await root.getDirectoryHandle('_reports', { create: true });
  const name = `takeout-${stamp}.md`;
  const writable = await (await reports.getFileHandle(name, { create: true })).createWritable();
  await writable.write(text);
  await writable.close();
  return name;
}
