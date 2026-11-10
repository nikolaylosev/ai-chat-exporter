import type { Attachment } from '../model/conversation';
import { isImagePath, vaultSafeName, type VaultRules } from '../obsidian/vault';
import { vaultBase, vaultLink } from './conversation-export';
import type { Project } from '../model/project';
import { escapeLinkText, linkTarget, yaml } from '../render/markdown';
import { PLATFORM_LABEL, type Platform } from '../shared/platform';
import { exportRootFolder, type Settings } from '../shared/settings';
import { isoWithOffset } from '../util/dates';
import {
  fitFileNames,
  MIN_TITLE_LENGTH,
  PATH_BUDGET,
  sanitizeRelativeDir,
  sanitizeSegment,
  uniqueFileNames,
} from '../util/filename';

/**
 * A Claude Project or a Gemini notebook on disk (docs/ARCHITECTURE.md, section 8):
 *
 *   Projects/<Name> (Claude)/        Notebooks/<Name> (Gemini)/
 *     <Name> (Claude).md               <Name> (Gemini).md      description, files, chats
 *     knowledge/                       sources/                files in their original format
 *     chats/                           chats/                  its chats, "with chats"
 */

export const CHATS_DIR = 'chats';

/** Where a platform's projects go and what they are called. */
export function projectKind(platform: Platform) {
  return platform === 'gemini'
    ? { dir: 'Notebooks', filesDir: 'sources', type: 'notebook', filesKey: 'sources' }
    : { dir: 'Projects', filesDir: 'knowledge', type: 'project', filesKey: 'knowledge_files' };
}

export interface PlannedKnowledgeFile {
  attachment: Attachment;
  /** Relative to the project note: `knowledge/<name>`. */
  link: string;
  /** Relative to the export root. */
  path: string;
}

export interface ProjectPlan {
  root: string[];
  /** Project folder relative to the export root: `Projects/<Name> (Claude)`. */
  folderPath: string;
  markdownPath: string;
  knowledge: PlannedKnowledgeFile[];
  /** The vault the project is written into, if any. */
  vault?: VaultRules;
}

/** `<Name> (Claude)`, shortened to leave room for files and chat folders inside. */
export function projectFolderName(
  name: string,
  settings: Settings,
  fallback: string,
  platform: Platform = 'claude',
): string {
  const label = settings.includePlatformInFolderName ? ` (${PLATFORM_LABEL[platform]})` : '';
  return `${sanitizeSegment(name, fallback, 60)}${label}`;
}

export function planProjectExport(
  project: Pick<Project, 'name' | 'knowledge'> & { platform?: Platform },
  settings: Settings,
  fallbackName: string,
  vault?: VaultRules,
): ProjectPlan {
  const platform = project.platform ?? 'claude';
  const { dir, filesDir } = projectKind(platform);
  const root = sanitizeRelativeDir(exportRootFolder(settings));
  // In a vault, names keep clear of what breaks a wikilink.
  const named = (name: string) => (vault ? vaultSafeName(name) : name);
  const folder = projectFolderName(named(project.name), settings, fallbackName, platform);
  const folderPath = [...vaultBase(settings, platform, vault), dir, folder].join('/');
  const used = (root.length ? root.join('/').length + 1 : 0) + folderPath.length + 1;
  const room = Math.max(MIN_TITLE_LENGTH, PATH_BUDGET - used - filesDir.length - 1);
  let names = uniqueFileNames(project.knowledge.map((a) => named(a.name)));
  if (names.some((n) => n.length > room))
    names = fitFileNames(
      project.knowledge.map((a) => named(a.name)),
      room,
    );
  return {
    root,
    folderPath,
    markdownPath: `${folderPath}/${folder}.md`,
    knowledge: project.knowledge.map((attachment, i) => {
      const link = `${filesDir}/${names[i] ?? attachment.id}`;
      return { attachment, link, path: `${folderPath}/${link}` };
    }),
    ...(vault ? { vault } : {}),
  };
}

/** The plan in another folder (`<Name> (Claude) (2)`); the note is renamed with it. */
export function moveProject(plan: ProjectPlan, folderPath: string): ProjectPlan {
  if (folderPath === plan.folderPath) return plan;
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return {
    ...plan,
    folderPath,
    markdownPath: `${folderPath}/${base(folderPath)}.md`,
    knowledge: plan.knowledge.map((f) => ({ ...f, path: `${folderPath}/${f.link}` })),
  };
}

/** Folders inside the export root where the project's chats go. */
export function chatParents(plan: ProjectPlan): string[] {
  return [...plan.folderPath.split('/'), CHATS_DIR];
}

/**
 * What the project note shows. Kept in the job state between the knowledge files
 * and the last chat, so it holds no file contents.
 */
export interface ProjectNote {
  /** Missing in job states saved before notebooks: Claude. */
  platform?: Platform;
  id: string;
  name: string;
  description: string;
  instructions: string;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** `info`: listed only, as the platform keeps the file without a download. */
  knowledge: { name: string; link?: string; error?: string; info?: string }[];
  /** `link` relative to the note when the chat was saved with the project. */
  chats: { id: string; title: string; url: string; link?: string; error?: string }[];
}

export interface ProjectLabels {
  untitled: string;
  untitledChat: string;
  description: string;
  instructions: string;
  knowledge: string;
  chats: string;
  noKnowledge: string;
  noChats: string;
  fileFailed: (reason: string) => string;
  chatFailed: (reason: string) => string;
  /** Where the files listed by name only can be found, given the note. */
  filesElsewhere?: (note: ProjectNote) => string;
}

/** A project note in a vault: where it is, the vault's rules, and its keep line. */
export interface ProjectVault {
  rules: VaultRules;
  /** The note's path from the vault root. */
  markdownPath: string;
  keepLine: string;
  myNotes: string;
}

/**
 * A link from the project note to a file or a chat note (`target` relative to the
 * project folder), in the vault's style when the note is in one.
 */
function projectLink(text: string, target: string, vault?: ProjectVault): string {
  if (!vault) return `[${escapeLinkText(text)}](${linkTarget(target)})`;
  const folder = vault.markdownPath.slice(0, vault.markdownPath.lastIndexOf('/'));
  const path = `${folder}/${target}`;
  const link = vaultLink(path, vault.markdownPath, vault.rules);
  if (vault.rules.wiki) {
    // A note is named without its extension; an image is shown, as in a chat's note.
    if (isImagePath(path)) return `![[${link}]]`;
    return `[[${link.replace(/\.md$/, '')}|${text.replace(/[|\]]/g, ' ')}]]`;
  }
  return `${isImagePath(path) ? '!' : ''}[${escapeLinkText(text)}](${linkTarget(link)})`;
}

export function renderProjectMarkdown(
  note: ProjectNote,
  labels: ProjectLabels,
  exportedAt: Date,
  timeZone?: string,
  vault?: ProjectVault,
): string {
  const date = (iso: string | null) => (iso ? isoWithOffset(iso, timeZone) : 'null');
  const name = note.name || labels.untitled;
  const platform = note.platform ?? 'claude';
  const { type, filesKey } = projectKind(platform);
  const fields: [string, string][] = [
    ['title', yaml(name)],
    ['platform', platform],
    ['type', type],
    [`${type}_id`, yaml(note.id)],
    ['url', yaml(note.url)],
    ['created', date(note.createdAt)],
    ['updated', date(note.updatedAt)],
    ['exported', isoWithOffset(exportedAt, timeZone)],
    [filesKey, String(note.knowledge.length)],
    ['chats', String(note.chats.length)],
    ['tags', `[ai-${type}, ${platform}]`],
  ];
  const knowledge = note.knowledge.length
    ? note.knowledge.map((f) =>
        f.link
          ? `- ${projectLink(f.name, f.link, vault)}`
          : f.info
            ? `- ${f.name} — ${f.info}`
            : `- ⚠️ ${f.name} — ${labels.fileFailed(f.error ?? '')}`,
      )
    : [labels.noKnowledge];
  if (labels.filesElsewhere && note.knowledge.some((f) => f.info))
    knowledge.push('', labels.filesElsewhere(note));
  const chats = note.chats.length
    ? note.chats.map((c) => {
        const text = c.title || labels.untitledChat;
        const title = escapeLinkText(text);
        if (c.link) return `- ${projectLink(text, c.link, vault)}`;
        if (c.error) return `- ⚠️ ${title} — ${labels.chatFailed(c.error)}`;
        return `- [${title}](${c.url})`;
      })
    : [labels.noChats];

  const sections = [
    ['---', ...fields.map(([k, v]) => `${k}: ${v}`), '---'].join('\n'),
    `# ${name}`,
    ...(note.description.trim() ? [`## ${labels.description}\n\n${note.description.trim()}`] : []),
    ...(note.instructions.trim()
      ? [`## ${labels.instructions}\n\n${note.instructions.trim()}`]
      : []),
    `## ${labels.knowledge}\n\n${knowledge.join('\n')}`,
    `## ${labels.chats}\n\n${chats.join('\n')}`,
    ...(vault ? [`## ${vault.myNotes}`, vault.keepLine] : []),
  ];
  return `${sections.join('\n\n')}\n`;
}
