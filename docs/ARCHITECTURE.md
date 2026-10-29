# Architecture

CodingCat AI Chat Exporter is a Chrome extension (Manifest V3) that saves conversations from **claude.ai**, **gemini.google.com**, **grok.com** and **chatgpt.com** to the local disk. Each conversation becomes a folder with a Markdown file and all of its attachments in their original formats. Projects are exported with their instructions, files and chats on every platform (Gemini's are its notebooks).

This document describes how the extension is built and why. It is meant for anyone who reads or changes the code.

> **Status:** all four platforms are built; version 1.0 is being stabilized. This document describes the code as it is. What each platform's internal API returns is recorded, from real traffic, in [`platforms-claude.md`](platforms-claude.md), [`platforms-gemini.md`](platforms-gemini.md), [`platforms-grok.md`](platforms-grok.md) and [`platforms-chatgpt.md`](platforms-chatgpt.md).

## Contents

1. [Scope](#1-scope)
2. [Design principles](#2-design-principles)
3. [Source layout](#3-source-layout)
4. [Runtime contexts and data flow](#4-runtime-contexts-and-data-flow)
5. [Core interfaces](#5-core-interfaces)
6. [Data model](#6-data-model)
7. [Platform adapters](#7-platform-adapters)
8. [Output layout and naming](#8-output-layout-and-naming)
9. [Markdown format](#9-markdown-format)
10. [Export queue](#10-export-queue)
11. [Manifest V3 constraints](#11-manifest-v3-constraints)
12. [Error handling](#12-error-handling)
13. [Permissions and privacy](#13-permissions-and-privacy)
14. [Extending: Obsidian sinks](#14-extending-obsidian-sinks)
15. [Tech stack](#15-tech-stack)
16. [Decision log](#16-decision-log)

## 1. Scope

### In version 1.0

- Export the current conversation, all conversations, or a selected set (search, date filter, checkboxes).
- Save the conversation text as Markdown and every file from the conversation: user uploads, model-generated files, artifacts, images.
- Save into Chrome's Downloads folder (a chat with files, and any bulk export, as one ZIP archive; a note alone as one file) or into a folder the user picks (separate files).
- Export projects of Claude, ChatGPT and Grok: instructions, the project's own files and all its chats.
- Export Gemini notebooks with all their chats; their sources are listed by name.
- Show progress, allow cancellation, and write an error report for bulk exports.
- A keyboard shortcut (`Alt+Shift+S`, `Option+Shift+S` on macOS) exports the current chat.
- A settings page.
- Platforms: claude.ai, gemini.google.com, grok.com and chatgpt.com.

### Not in version 1.0

- Export to Obsidian (designed now, built after the stabilization of 1.0, see [section 14](#14-extending-obsidian-sinks)).
- Perplexity and other platforms.
- Grok inside x.com: its chats were not visible on grok.com during discovery.
- Downloading the sources of Gemini notebooks: they live in NotebookLM, which Gemini gives no download for.
- ChatGPT's custom GPTs. A chat's GPT is not named in the frontmatter yet.
- Browsers other than Chrome.
- Scheduled background sync.
- Chrome Web Store publishing. The build is installed as an unpacked extension.

## 2. Design principles

1. **Adapters do not know where data goes. Sinks do not know where data comes from.** An adapter turns a platform into a normalized `Conversation`. A sink writes paths and files. The core connects them. A new platform or a new destination is one new module, with no changes to the core.
2. **Platform code stays in `src/adapters/<platform>/`.** Nothing outside that folder knows about a platform's endpoints or formats. All four platforms are read through the APIs their web apps use, so there are no CSS selectors to maintain; if a platform ever has to be read from the page, its selectors go into one `selectors.ts` in its folder.
3. **Validate what the platform returns, and fail small.** The internal APIs are undocumented and change without notice. Every response is parsed with a zod schema. The conversation needs only ids; anything else that is missing or odd is filled in or skipped (a message of an unknown role, a malformed file entry). A content block in an unexpected shape becomes a ⚠️ line in the note instead of failing the chat. When the conversation itself cannot be read, the error names the platform and the field, and the UI shows that field, so a report can be acted on.
4. **Never guess the platform format.** Parsers are written against real, anonymized responses stored in `tests/fixtures/`.
5. **One failure does not stop the rest.** A failed attachment does not stop its chat. A failed chat does not stop a bulk export.
6. **No external servers.** No analytics, no telemetry. The extension talks only to the hosts listed in `host_permissions`.

## 3. Source layout

```
src/
  manifest.ts               MV3 manifest, built by CRXJS
  background/               service worker
    queue.ts                bulk export queue; state persisted in chrome.storage.session
    index.ts                entry point: message handlers, keyboard command, job resume
    export-current.ts       export of the open chat: badge, panel or notification; chosen messages
    outline.ts              a chat's messages as the messages page lists them (pure)
    export-conversation.ts  one conversation: sink choice, registry, write
    tabs.ts                 content script injection, background platform tab for bulk work
    report.ts               bulk export report (pure)
    project-export.ts       project folder plan and project note (pure)
    project-job.ts          a project in a bulk job: knowledge files, its chats, the note
    write-conversation.ts   files first (a few at a time), then the Markdown; stops on folder-wide errors
    conversation-export.ts  Conversation + settings -> folder plan and Markdown (pure)
    labels.ts               Markdown labels in the UI language
    downloader.ts           wraps chrome.downloads, tracks completion, Save As heuristic
    registry.ts             export registry and issued folder names
    offscreen-client.ts     creates the offscreen document on demand; blob URLs, folder and ZIP calls
  offscreen/                offscreen document: blob URLs, writes into the chosen folder, builds ZIPs
    word-notes.ts           Word notes: keeps the images a note embeds, then makes the document
  content/
    claude.ts               content script for claude.ai (isolated world)
    panel.tsx               result panel on the chat page after the keyboard shortcut
    page-button.tsx         button in the corner of a chat page with a menu: with files, text only, copy
    gemini.ts               content script for gemini.google.com (isolated world)
    common.ts               shared by the content scripts: error codes, liveness check
    grok.ts                 content script for grok.com (isolated world)
    chatgpt.ts              content script for chatgpt.com (isolated world)
  adapters/
    types.ts                PlatformAdapter interface
    errors.ts               PlatformFormatError (the field that changed), PlatformBusyError
    claude/
      api.ts                REST client (organizations, conversation, project)
      schema.ts             zod schemas, PlatformFormatError
      normalize.ts          raw conversation -> model: branches, blocks, attachments
      urls.ts               conversation id from a chat URL
      adapter.ts            PlatformAdapter for claude.ai
    gemini/
      batchexecute.ts       client: tokens from the /app page, retries, response parsing
      parse.ts              readers for the positional arrays of history, list and Gems
      normalize.ts          turns -> model: Markdown cleanup, uploads, generated images
      urls.ts               conversation id, Gem and account prefix from a URL
      adapter.ts            PlatformAdapter for gemini.google.com
    grok/
      schema.ts             zod schemas: only ids are strict, other fields fall back to empty
      normalize.ts          response tree -> model: visible branch, cards, steps, files
      urls.ts               conversation id and ?rid from a URL
      adapter.ts            PlatformAdapter for grok.com: list, tree, responses
    chatgpt/
      schema.ts             zod schemas: ids and the tree are strict, other fields fall back
      normalize.ts          mapping tree -> model: turns, branches, tools, files
      text.ts               answer cleanup: citations, entities, file marks, sandbox links
      canvas.ts             canvas files: writing blocks, older canmore edits replayed
      pacer.ts              gap between API requests, widened after a 429
      urls.ts               conversation id from a URL
      adapter.ts            PlatformAdapter for chatgpt.com: access token, list, signed file links
  model/
    conversation.ts         normalized data model
    project.ts              Claude Project: instructions, knowledge base, chats
  render/
    markdown.ts             Conversation -> Markdown
    html.ts                 the Markdown as an HTML page (marked; the chat's HTML escaped, links checked)
    json.ts                 Conversation -> JSON, without download links
    docx.ts                 the Markdown as a Word document (marked tokens to WordprocessingML, packed by fflate)
  search/                   searching the saved archive (the search page)
    notes.ts                every note format read back into its properties and messages; the text of chats' files
    archive.ts              the search folder walked, .zip exports read inside, notes and files' text kept in IndexedDB
    query.ts                words and "phrases" in every message, with filters, narrowing to chats that also hold (or lack) words, order, hits per filter choice (pure)
  takeout/                  saved Gemini chats completed from Google Takeout (the Takeout page)
    source.ts               Takeout as given: .zip parts read as they stream, the activity JSON, or the unpacked folder
    activity.ts             the activity's prompts: chat, time, text, answer, files
    complete.ts             what each saved chat lacks (prompts, files by name, bytes or image size), the copying
    section.ts              the "From Google Takeout" section of a note, the report
    image-size.ts           width and height from an image's first bytes
  sinks/
    types.ts                ExportSink interface
    downloads-sink.ts       separate files into Downloads (chrome.downloads)
    offscreen-sinks.ts      FolderSink and ZipSink: service worker side, work done in offscreen
    folder-handle.ts        the chosen folder's handle in IndexedDB, access checks
    folder-writer.ts        writes into the chosen folder (File System Access API)
    zip-builder.ts          streaming ZIP archive (fflate)
    source.ts               reads a FileSource into a Blob, failure reasons
  shared/                   code used by every context
    messages.ts             typed messaging between contexts
    errors.ts               CodedError and error codes shown to the user
    settings.ts             settings, defaults, validation (chrome.storage.local)
    job.ts                  bulk export state shared by the worker and the export page
    location.ts             "Saved to …" labels
    platform.ts             platform detection by URL
    list-cache.ts           Gemini's chat list as last read, remembered between visits
    search-cache.ts         chats found by Gemini's search and where it stopped, remembered between visits
    i18n.ts, logger.ts
  util/
    filename.ts             name sanitization and path length budget
    dates.ts                local dates and ISO 8601 with offset
    http.ts                 fetchJson with retries on 429, 5xx and dropped connections
    image-type.ts           image format from the first bytes; re-encoded images renamed
    pool.ts                 runs tasks a few at a time (files of a chat or a project)
  types/                    File System Access declarations missing from TypeScript's DOM library
  ui/                       each page: main.tsx renders it, the component is in its own module
    popup/                  popup.tsx
    takeout/                page.tsx: the folder of saved chats and Takeout chosen, the check, the addition
    export-page/            page.tsx: chats and projects tabs, search, filters, sort, selection, progress
                            takeout.ts: Gemini chat ids from a Google Takeout file (JSON or .zip)
    messages/               page.tsx: one chat's messages to choose from; saves or copies the chosen ones
    search/                 page.tsx: the search folder, the query and filters, hits, the note viewer
    options/
public/
  _locales/en, _locales/ru  UI strings (chrome.i18n), generated by scripts/locales.py
  icons/                    generated by scripts/make-icons.mjs from assets/logo.png (the CodingCat app icon; the 128 one padded for the Chrome Web Store)
tests/                      mirrors src/
  fixtures/                 anonymized real platform responses
```

### Messaging

`chrome.runtime.sendMessage` delivers every message to all extension pages and the service worker at once. `shared/messages.ts` wraps it: each request names a `target` (`background`, `offscreen` or `content`) and a `type`, and the request and response types for each pair are declared in one place. Requests to `content` go to one tab through `sendToTab()` (`chrome.tabs.sendMessage`). A handler that throws sends the error message back, with the error's `code` when it is a `CodedError` (`shared/errors.ts`), and the caller rethrows it. The UI turns codes into localized messages (`error_<code>` in `_locales`).

### Content script injection

Each platform's content script is declared in the manifest, so it loads with every page of its site. Tabs that were open before the extension was installed or reloaded have no live copy. Before each export the service worker pings the tab; if nothing answers, it injects the script with `chrome.scripting.executeScript` and pings again until the script answers (the injected file is a CRXJS loader that imports the real script asynchronously). The script's guard asks a previous copy whether its extension context is still alive instead of trusting a plain flag, so a dead copy left by a reload does not block the new one.

## 4. Runtime contexts and data flow

A Chrome extension runs code in several separate contexts. Each one can do some things and not others, so the work is split between them.

| Context                         | Runs                         | Responsible for                                                                                 |
| ------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Popup                           | while the popup is open      | Detects the platform of the active tab, starts exports                                          |
| Export page                     | an extension tab             | Chat and project lists, selection, progress, cancel                                             |
| Options page                    | an extension tab             | Settings, picking the folder for the `folder` destination                                       |
| Service worker                  | on events, stopped when idle | Queue, rendering, file naming, downloads, registry, badge, notifications, keyboard command      |
| Offscreen document              | created on demand            | Blob URLs, writes into the chosen folder, ZIP archives (the service worker can do none of them) |
| Content script (isolated world) | inside each platform's pages | Runs the platform adapter: same-origin API calls with the user's session                        |

### Exporting one conversation

```
popup / keyboard shortcut
        │  "export current chat"
        ▼
service worker ──── chrome.tabs.sendMessage ────► content script
        ▲                                            │ adapter.getConversation(id)
        │                                            │ (same-origin API requests)
        └──────── normalized Conversation (JSON) ────┘
        │
        │ plan paths (folder name, unique attachment names, path budget)
        │ render Markdown
        ▼
ExportSink, chosen by the destination and exportsAsZip (settings.ts)
        DownloadsSink (Downloads, separate files)
        ├─ writeText(.md)  → offscreen document → blob URL → chrome.downloads
        └─ writeFile(url)  → chrome.downloads (browser fetches with user cookies)
        FolderSink (chosen folder, separate files)
        └─ write*          → offscreen document → fetch with cookies → File System Access
        ZipSink (Downloads or chosen folder, one archive)
        ├─ write*          → offscreen document → fetch with cookies → fflate
        └─ finish()        → blob URL → chrome.downloads, or into the chosen folder
```

The content script returns plain JSON. Binary files never cross the message channel: an attachment is passed as a URL that `chrome.downloads` or the offscreen document fetches with the user's cookies, or as text when the platform only exposes text (artifacts, extracted document text). The offscreen document is an extension page with host permission for the platforms and their file hosts, so its `fetch` sends the session cookies and is not limited by CORS. Where a platform needs more than cookies for its API (ChatGPT's access token), the adapter resolves each file to a signed link while it reads the conversation, so files still travel as plain URLs.

### Destinations

- **Downloads.** One `chrome.downloads` call per export: a chat with files, a bulk export or a project goes as one ZIP (below), a chat's note alone as one file. So with Chrome's "Ask where to save each file" on, it asks once. Separate files into Downloads are not offered: Chrome writes them only inside Downloads and asks about each one elsewhere (decision 68).
- **A folder the user picks.** The options page calls `showDirectoryPicker()`; the handle is stored in IndexedDB, which every extension page and the offscreen document share. Files are written with `createWritable()`, so no Save As dialog ever appears. A browser without the File System Access API (Brave unless `brave://flags/#file-system-access-api` is on) cannot use this destination: `canUseFolders()` is false, the settings page says so and keeps the option off, and an export that still asks for the folder stops with `folder-unsupported`. Write access is checked when an export starts. When it has lapsed (Chrome may ask again after a restart), the popup asks for it from the click on "Save this chat".
- **ZIP archive** (Downloads: always for a chat with files and for a bulk export; `exportsAsZip`). The archive is named after the conversation folder and holds that folder, so unpacking gives the usual layout. Already compressed formats (images, pdf, Office files, archives) are stored; text is deflated. In Downloads it is one download, so Chrome asks where to save at most once. A bulk export puts all its conversations into one archive, `<Platform> - <YYYY-MM-DD HH-mm>.zip`, with the report inside. There is no ZIP setting: the destination decides (`exportsAsZip`).

### Bulk export

The export page asks the service worker for a platform tab (`platform:tab`): an open one if there is any, otherwise one the worker opens in the background. A tab it opens is ready when the content script answers, not when Chrome reports the page `complete`: a heavy web app in a background tab may report that very late or never. If the script does not answer within a minute, the tab is closed and the page says the site did not open. The page then asks that tab for the list itself and tells the worker when it is done, so a tab the worker opened is closed. The page talks to the tab directly because a long list (Gemini, several minutes) would keep one service worker event open, and Chrome ends a worker whose event takes more than five minutes. While a slow list loads, the content script reports how many chats it has read (`list:progress`), and the page offers to stop: `conversations:list-stop` ends the loading after the current page, and the list comes back marked as stopped by the user, with the chats read so far (the newest); and an adapter can return the list marked incomplete when the platform stops answering (Gemini past about 1,000 chats: status 13, a server error or a dropped connection on a deep page). The page has a platform switch (Claude, Gemini, Grok, ChatGPT; `?platform=` keeps it in the address) and opens on the platform of the tab the popup was opened from. The page then sends a job (conversation ids with titles and update times) to the worker. The queue processes one conversation at a time, as described in [section 10](#10-export-queue). The page follows the job through `chrome.storage.onChanged`. Closing the popup or the export page does not stop the job.

For every platform the adapter runs in a platform tab: an open one, or one the extension opens in the background and closes afterwards.

## 5. Core interfaces

```ts
interface PlatformAdapter {
  platform: 'claude' | 'gemini' | 'grok' | 'chatgpt';
  getCurrentConversationId(): string | null;
  // onProgress: chats read so far, for a list that loads slowly
  listConversations(onProgress?: (loaded: number) => void): Promise<ConversationList>;
  getConversation(
    id: string,
    options?: { artifactVersions: 'latest' | 'all' },
  ): Promise<Conversation>;
}

interface ConversationList {
  conversations: ConversationSummary[];
  incomplete?: { loaded: number }; // the platform stopped answering partway (Gemini)
}

interface ExportSink {
  id: string; // 'downloads' | 'folder' | 'zip' | 'obsidian-rest'
  writeText(path: string, content: string): Promise<void>;
  writeFile(path: string, source: FileSource): Promise<void>;
}

type FileSource =
  | { kind: 'url'; url: string } // downloaded by the browser with the user's cookies
  | { kind: 'blob'; blob: Blob } // only within one context; never sent over messaging
  | { kind: 'text'; text: string; mime: string };
```

`path` is always relative to the export root: the configured subfolder of Downloads, or the chosen folder itself. Sinks receive final, already sanitized paths. The one exception is the conversation folder: a sink may pick a free name for it (`prepareFolder`) before anything is written, and the plan is moved there. A sink also has `finish()`, which closes an archive and reports where the export was saved, and `abort()`, which drops a half-written archive.

Every adapter has project methods (`listProjects`, `getProject` with instructions, the project's files and chats, `getCurrentProject`); Gemini's projects are its notebooks. Gemini adds `searchConversations` for chats past the end of its list, which is not part of the shared interface because the other platforms have no equivalent.

## 6. Data model

`model/conversation.ts`, abridged:

```ts
interface ConversationSummary {
  id: string;
  platform: 'claude' | 'gemini' | 'grok' | 'chatgpt';
  title: string;
  createdAt: string | null; // ISO 8601; null if the platform does not provide it
  updatedAt: string | null;
  url: string;
  project?: string; // Claude or ChatGPT project, Grok project, Gemini Gem or notebook
  foundBySearch?: boolean; // Gemini: found by search past the end of the list
  archived?: boolean; // ChatGPT
}

interface Conversation extends ConversationSummary {
  model?: string;
  messages: Message[]; // the branch the user sees, root first
  branches: { forkAfterMessageId: string | null; messages: Message[] }[];
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  createdAt: string | null;
  blocks: Block[]; // text, thinking, tool-call, web-search, unreadable
  attachments: Attachment[];
}

interface Attachment {
  id: string;
  name: string; // original file name
  mime?: string;
  size?: number;
  origin: 'user-upload' | 'model-generated' | 'artifact' | 'image' | 'project-knowledge';
  source: FileSource | null; // null: cannot be downloaded, only mentioned
  note?:
    // shown next to the file in the note
    | 'extracted-text-only' // only the text the platform extracted
    | 'extracted-text-partial' // only the beginning of it (ChatGPT)
    | 'rebuilt-from-chat' // an artifact or canvas rebuilt from the model's edits
    | 'unavailable'
    | 'recompressed'; // re-encoded by the platform (Gemini images)
  unavailableReason?: string; // the platform's own words, when it gives them
}
```

A tool call carries its name, input, output and the input's language (`python`, `json`, or plain text).

## 7. Platform adapters

### Claude

The content script on claude.ai calls the internal REST API the web app exposes. Requests are same-origin, so the user's session cookies apply and no credentials are handled by the extension. Endpoints and response formats are recorded in [`docs/platforms-claude.md`](platforms-claude.md); the main ones:

- `GET /api/organizations/{org}/chat_conversations_v2?limit=&offset=` for the conversation list (`has_more` paging; pages overlap by five chats and the first page is read again at the end, as for ChatGPT, see below);
- `GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true` for one conversation with every branch;
- `GET /api/organizations/{org}/files/{uuid}/contents` for the original bytes of uploads and generated files.

The web app itself reads conversations through a Connect RPC service with binary protobuf. The extension does not use it: the REST JSON carries the same data and has a stable, readable shape.

Claude has two generations of chats. Newer chats run as cloud sessions (`workspace_session_id` is set); older ones do not. The adapter handles both:

| Data                  | Session chats                                                                                                | Older chats                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| User uploads          | `files[]` → `/files/{uuid}/contents`                                                                         | same; the legacy `attachments[]` has extracted text only                         |
| Model-generated files | `SendUserFile` result `file_deliveries[]` → `/files/{uuid}/contents`                                         | `present_files` result `local_resource.file_path` → `wiggle/download-file?path=` |
| Artifacts             | session's `external_metadata.artifacts[]` → frame metadata → `_src` file, read as text by the content script | rebuilt from the model's `create_file` / `str_replace` calls                     |

Rules:

- **Branches.** A conversation is a tree (edits and regenerations create branches). By default the active branch is exported, walking from `current_leaf_message_uuid` up to the root. Exporting all branches is an option. Service messages such as the `prepare_session` step are skipped.
- **Uploaded documents.** Originals are downloaded. Only the legacy `attachments[]` entries, which never had a binary, are saved as `<name>.extracted.txt` and marked as such in the Markdown and the report.
- **Artifacts** are published pages with versions (`adapters/claude/artifacts.ts`). The adapter finds every `Artifact` publication in the visible branch and attaches it to the message that published it. For session chats the conversation is looked up in the list to get `workspace_session_id` (every list page read is remembered; for a chat older than the first six pages the organization's whole list is read once, so a bulk export does not search the list again for each chat), the session names the artifact uuid, and the content script reads each file from `https://{id}.frame.claudeusercontent.com/_f/{version}/_src/{path}?__frame_t=<token>` (the domain answers claude.ai with CORS). If that fails, or the chat has no session, the file is rebuilt by replaying the model's write and edit calls on it and marked "rebuilt from the chat"; if an edit cannot be replayed, it is listed as unavailable. Names are `artifact-<title>.<ext>`, with `-v<n>` when all versions are kept. The latest version by default; all versions as an option.
- **Model-generated files** (docx, pptx, xlsx, pdf, zip) are downloaded by file uuid or sandbox path, as in the table.
- **Projects.** `projects_v2` lists them; `/projects/{id}` has the description and the instructions (`prompt_template`). The knowledge base comes in two parts: text files as documents with their full content (`/docs`, saved under their own name), and binaries (`/files`, downloaded byte for byte through `/files/{uuid}/contents`). `/projects/{id}/conversations_v2` lists the project's chats. The popup finds the project of the open page from the URL, or of the open chat from its `project_uuid`.

#### Exporting a project

A project is an item of a bulk job, like a conversation, so it has the same progress, cancel, resume and report. The job first writes the knowledge files into `knowledge/`. It then puts the project's chats into the queue right after the project, each one going into the project's `chats/` (registry key `<chat>@<project>`, so a chat saved on its own is a separate record). The project note links to those chats, so it is written after the last one; until then, what it shows (no file contents) waits in the job state. After a cancel or a stop, the note is still written, and chats that were not reached keep their claude.ai links. A single project saved as ZIP gets an archive named after it.

### Gemini

Discovery ([`docs/platforms-gemini.md`](platforms-gemini.md)) showed that Gemini can be read through its API, so the DOM strategy of the specification is dropped.

- **Requests.** The content script calls `batchexecute` on gemini.google.com with the user's cookies, as the web app does. The `at`, `bl` and `f.sid` values come from the HTML of `/app`; the `at` token is a session secret and is never stored or logged.
- **List.** `MaZiqc`, in pages of 100 linked by a token; pinned chats first, a chat seen twice kept once. A deep page costs Gemini more the deeper it is, whatever its size, so the pages are as big as Gemini allows and a failed one is asked again as it is. The export page remembers the list in `chrome.storage.local` (`shared/list-cache.ts`) and sends the remembered chats with their update times (`conversations:list` `known`): the adapter stops after the first page that holds one of them, not pinned, with the same update time, since every chat after it is older and unchanged (a changed chat moves to the top), and marks the list `reachedKnown`. The page then puts the remembered chats it did not reach after the ones read, so chats that fell past the depth Gemini answers stay listed. "Read the whole list again", "Try again" and "Load the whole list" read it all, or, once a Google Takeout file was added, down to a day before its newest record (`conversations:list` `until`, `takeoutUntil:<platform>`): the older chats came from Takeout; a list read to its end replaces the memory, so chats deleted since go. The bulk export keeps the memory current like the search's (below), and a chat it found gone is not shown again. The list has the last update time; the creation date is the time of the oldest turn, so the export page filters Gemini chats by the update date and has no Created column.
- **History.** `hNvQHb`, 10 turns per page, newest first. Replies are Markdown; `[cite: N]` markers and the image placeholder are removed or replaced when rendering. Only the visible branch is kept by Gemini.
- **Files.** Uploaded documents download byte for byte from `contribution.usercontent.google.com`. Uploaded and generated images come from `lh3.googleusercontent.com` (needs host permission; generated images at full size with `=s0`; uploaded images are re-encoded, which the note says, and may come back in another format: before the files are planned, the first bytes of each re-encoded image are read in the offscreen document and the name gets the real extension, `photo.png` → `photo.jpg`; `util/image-type.ts`. For a folder or a ZIP, written from the offscreen document too, the whole image is downloaded at that point and kept for the write, so it is fetched once).
- **Canvas** documents now live in Google Docs; the note links to them. **Gems** are named from `CNgdBe`.
- **Search for older chats.** The list stops at about 1,000 chats. On the export page, "Find more chats with Gemini search" runs the web app's own search (GraphQL `searchHistory`, 20 chats per query) with common words and then with the words of the chats it finds, titles and snippets, the words of chats outside the list first, until new chats almost stop appearing (fewer than 5 in 50 queries), 1,500 queries, or Stop (`adapters/gemini/search.ts`). Chats found this way join the table marked "found by search" as each query finds them (`search:progress` carries them), so a stop or a failure keeps what was found, and export like the others; their update time is the newest matching snippet's. The export page remembers them in `chrome.storage.local` (`shared/search-cache.ts`), shows them again on the next visit, and a new search looks only for chats it has not seen; the page also keeps where the search stopped (the words asked, the 3,000 best words not asked yet, every chat it came across; sent with the progress every 20 queries and with the result), and the next search goes on from there (`conversations:search` `resume`). From the chats the search came across, the page shows how much of the history it has covered: the share of listed chats it met, and the older chats likely there at that share (`searchCoverage`, after 30 listed chats; rather a lower bound: checked against Google Takeout on a large account, the search had met a smaller share of the older chats than of the listed ones, and the count came out about a sixth low). "Forget the found ones" clears both. A line above the table says where its chats come from: the list, the search, and chats exported before that neither has, taken from the registry (`registry:chats`, the title read from the folder name) and marked "saved before"; a "Source" filter shows the chats of one of them, chats from Takeout included (`chatSource` in `ui/export-page/filter.ts`). The bulk export keeps the memory current: a chat Gemini no longer has (the `chat-not-found` error) is forgotten, and a saved one gets its present title and, for a chat found by search, the chat's own update time instead of its snippet's, so it shows as saved and "skip unchanged chats" skips it next time; the page follows these changes. The query signature is known, and looked up again in the web app's scripts if Gemini renames it, reading only scripts served from gemini.google.com and the web app's script hosts, `gemini.gstatic.com` (signed in) and `www.gstatic.com` (signed out), which are in the host permissions and answer the page with CORS.
- **Chats from Google Takeout.** The search still misses some chats. Google Takeout's My Activity for Gemini Apps, as JSON, has one record per prompt, and each links to its chat (`https://gemini.google.com/app/<id>`), however old. "Add chats from Google Takeout…" takes that file or the Takeout .zip (only the entries whose path names Gemini are unpacked, as the file is read, with fflate) and reads the ids on the page (`ui/export-page/takeout.ts`); nothing is sent anywhere. The ids the table does not have go to the Gemini tab 20 at a time (`conversations:lookup`), which asks for each chat's list entry, four at a time (`MaZiqc` with the chat's id in the filter, as `getConversation` does): its title, update time and Gem. A chat with no entry was deleted and is left out. Once Gemini refuses one past the request's own retries, the rest are asked one at a time with a pause after each batch, and the refused ones are asked again at the end after 30 s, 1 and 2 minutes (`lookupAll`); those still refused are counted, to be asked again when the file is added again. The hint links to Takeout with My Activity chosen (`/settings/takeout/custom/my_activity`). Once chats from Takeout are in the table, the coverage estimate is no longer shown and the search's hint says it is needed only for chats started after the Takeout file. The chats found join the table marked "from Takeout", are remembered with the search's (`shared/search-cache.ts`, so the bulk export keeps them current the same way and "Forget the found ones" clears them too), and the line above the table counts them apart.
- **Completing saved chats from Takeout.** Takeout logs every prompt, also those the chat no longer shows (Gemini keeps the visible branch only, so a prompt edited or answered again is gone from it), and keeps files Gemini's history leaves out: a video shown as one frame, some PDFs and audio. The Takeout page (`ui/takeout/`, linked from Gemini's tab of the export page, and from a Gemini export's report when files are missing) takes the folder of saved chats (write access) and Takeout: its .zip, with every part, or the unpacked folder. "Check" reads both and writes nothing; "Add them" writes (`takeout/complete.ts`).
  - Each folder holding a Gemini note is a saved chat: its id from the note's address, the minutes of its user messages, and the files its note links to (outside the Takeout section; for a JSON or Word note, all of `files/`).
  - A Takeout prompt with no user message of its chat within a minute of its time is missing. Times are compared at the note's own UTC offset, read from its `created` (the computer it was saved on), so a different time zone here, or a note saved elsewhere, does not make every prompt look missing; if most still do, the page warns before adding. The prompt's text is its record's title without the word nearly every title starts with ("Prompted" in English, another word in other languages). A Takeout file of the chat's prompts is missing when the chat has no file of that name (Takeout adds `-<16 hex>`), of the same bytes, or, for an image, of the same pixel size: Gemini gives images re-encoded, so an image's bytes differ from Takeout's copy.
  - The missing files are copied into the chat's `files/`, under a free name; a file already there with the same bytes is reused, so a second run copies nothing. Markdown and HTML notes get a "From Google Takeout" section at the end (before `</body>` in HTML), between two HTML comments, replaced on the next run: the files of prompts the chat shows, with their time, then each missing prompt with its text, its files and the answer as text. JSON and Word notes get the files only.
  - Takeout is read as it streams: the activity in one pass, then only the files wanted in a second, so a gigabyte archive is never held whole. A report goes into the folder's `_reports/takeout-<date>.md`. A re-export of the chat rewrites the note without the section; running the page again puts it back.
- **Notebooks.** Gemini's notebooks are exported like Claude's projects, through the same bulk-job item and `project-export.ts` (`projectKind`): `CNgdBe` with the filter `[2]` lists them, `HcT8bb` gives the title, dates and sources, `MaZiqc` with the notebook in its filter lists the chats. A notebook goes to `Notebooks/<Name> (Gemini)/` with its chats, like every project. Sources cannot be downloaded (they live in NotebookLM): the note lists them by name with a line saying why and a link to the notebook in NotebookLM, and they do not count as failed files. The popup finds the notebook from the `/notebook/<uuid>` URL, or in a notebook's chat from its list entry; a notebook chat's `project` is the notebook's name, from the list entry's index 7 as for Gems.

### Grok

Discovery ([`docs/platforms-grok.md`](platforms-grok.md)) confirmed a plain JSON REST API, so the adapter works like Claude's: same-origin `fetch` from the content script with the user's cookies, zod schemas.

- **List** `GET /rest/app-chat/conversations` with a page token; each chat has `createTime` and `modifyTime`.
- **Conversation** `conversations_v2/{id}` for the title, dates and project, `response-node` for the tree and `load-responses` (up to 100 ids per call) for the messages: Markdown, model, reasoning steps, search results, uploads and image cards.
- **Branches.** A regenerated answer is a sibling in the tree. The visible branch follows `?rid=` of the open page to the answer it names, and the newest child everywhere else; the other branches are exported as for Claude (the "Branches" setting covers both).
- **Answers.** `<grok:render>` card tags are removed from the Markdown: a generated image and a file the model made (`rendered_file_card`) become attachments, citations are dropped, any other card is noted as a part that could not be read. Reasoning steps become a thinking block (headers in bold). Search results become a web search block.
- **Files** from `assets.grok.com` by key, byte for byte, with cookies (CORS allows grok.com): `fileAttachmentAssetMetadata` first (name, type, size, whether the model made it), then upload metadata and image cards it does not cover. Generated images at full size.
- **Bulk export.** The list comes 60 chats per page with a token, each with `createTime` and `modifyTime`, so the export page shows both dates and filters by creation like Claude. The list gives no project, so after it the projects (`/rest/workspaces`) and each project's chats (`workspaceId=`) are read to fill the project column; a failure there only logs a warning. The queue, ZIP, report and "skip unchanged" work as for the other platforms.
- **Projects** are exported like Claude's: the files from `/rest/assets?workspaceId=` (keys on assets.grok.com), the chats from the list with `workspaceId=`, the instructions when Grok gives them (none was seen). A project's chat opens at `/project/<id>?chat=<id>`, which the popup reads as a chat; on a project page or in its chat the popup offers the project.
- **Scope:** grok.com only.

### ChatGPT

Discovery ([`docs/platforms-chatgpt.md`](platforms-chatgpt.md)) found a JSON REST API under `/backend-api/`, so the adapter works like Claude's and Grok's: same-origin `fetch` from the content script, zod schemas.

- **Token.** Every call needs `Authorization: Bearer <accessToken>` from `GET /api/auth/session` (cookies only). The adapter asks for it once per content script, keeps the promise in memory, asks again once after a `401`, and never stores or logs it. A session without a token is a `401` ("sign in"), because the list would otherwise answer `200` with no items.
- **List** `GET /backend-api/conversations?offset&limit=100&order=updated`, paged until a short page (`total` is not a count). Offset pages shift when chats change during the read: a chat deleted or archived meanwhile moves the rest up, so pages overlap by five chats; a chat updated meanwhile moves to the top, so the first page is read again at the end. After the history comes the same list with `is_archived=true` (marked "archived" on the export page), then the chats of each project, which the history leaves out: projects from `gizmos/snorlax/sidebar`, their chats from `gizmos/{id}/conversations` by cursor, with the project's name in the project column. Project entries are read loosely, and a failure there only logs a warning. Dates are ISO (seconds are read too); the export page filters by creation, like Claude.
- **Conversation** `GET /backend-api/conversation/{id}`: a `mapping` tree with `current_node` (dates in seconds). The path from the root to `current_node` is what the page shows. Its visible nodes are grouped into turns: a user message, then everything up to the next user message is one assistant message (tool calls, tool results, reasoning, the answer). The other leaves become branches, each starting after the last turn it shares with what was already exported; a branch that forks inside a turn repeats that turn. System messages, the user's custom instructions and nodes marked `is_visually_hidden_from_conversation` (extracted file text) are left out.
- **Turn content.** `thoughts` become one thinking block, `reasoning_recap` ("Worked for 10s") is dropped. A `code` call to `python` is a tool call whose input is shown as Python and whose output is the next `execution_output`. Calls to `web.run` are not shown; the search results of the tool's answer (`search_result_groups`) become a web search block, with the query when the call names one. Calls to other tools are tool calls by recipient, except the image tool's empty `{"skipped_mainline":true}`. Any other content type is noted as unreadable.
- **Answers** (`text.ts`). `<FileCite>` is dropped, `<Cite refs={…}>` becomes links to the results it names (`search1` is `ref_index` 1 of the turn's results; the turn number in the ref does not match), `<Entity>` becomes its `value`. Older answers carry the same marks as private-use characters (`\ue200cite\ue202turn0search0\ue201`): those that `content_references` describe are replaced by the reference's text or links, the rest are read the same way. A `[text](sandbox:/mnt/data/x)` link keeps only its text; the file is an attachment. A rich answer's layout (`<row>`, `<box>`, `<text>`, `<icon/>`, `<button>`, outside code blocks) is flattened to its text, and the files its buttons download (`"sandbox:…"`) are attachments too.
- **Files.** Every file is fetched through a signed link that the adapter asks for while reading the conversation: `files/download/{file_id}` for uploads (`metadata.attachments`, and image parts not listed there) and images (`image_asset_pointer`; a generated image is named after `image_gen_title`), `interpreter/download` with the answer's message id and the path for a file made by code. The link is on chatgpt.com and needs no token, so it goes to the sinks as an ordinary URL. Its lifetime is unknown: if a link is refused when the file is written (401, 403, 404, 410), the writer asks the tab once for a new one (`conversation:file-link`; the adapter keeps where the files of its last few conversations come from). A file ChatGPT no longer has (`status: "error"` or an HTTP error other than `401`/`403`) is marked unavailable and does not stop the export.
- **Canvas** (`canvas.ts`). A `<WritingBlock>` is replaced in the answer by the block's content from `metadata.writing_blocks` (the user's edits are only there), code in a fence, and saved as `canvas-<title>.md` (or the code's extension). Older chats made canvases with `canmore.create_textdoc` and `canmore.update_textdoc` calls; their documents are rebuilt by replaying the edits (regex replacements, applied to the newest document) and saved as "rebuilt from the chat", the newest version or every version (`-v<n>`) as the artifact versions setting says. No such chat was available to check this.
- **Bulk export** goes through the queue as for the other platforms. ChatGPT's conversation has a later update time than its list entry (by seconds), so the registry keeps the list's time for "skip unchanged" (for every platform: it is what the next list is compared with).
- **Files ChatGPT no longer gives.** A long pasted text (`is_big_paste`) and old uploads answer 404. When the model read the file, its text is in a hidden tool message (`Use ref_id "turn<N>file<M>"`, lines marked `[L<n>]`, cut at 16,384 characters); that text is saved as `<name>.extracted.txt`, marked "extracted text only" or, when cut, "only the beginning". Files a tool attached to its result (`container.open_image`) are saved with the answer.
- **Rate limit.** ChatGPT answers 429 to a run of quick requests and sends no `Retry-After`. The adapter keeps 0.5 s between its API requests (`pacer.ts`), doubles that gap after each 429 up to 16 s and halves it again after 20 calm answers; a refused request waits 15, 30, 60 and 120 s. A 429 that outlasts that (on any platform) is the `rate-limited` error, which stops a bulk export: the next run with "skip unchanged" goes on from there. A 429 while asking for a file link is never taken for a missing file.
- **Projects** are exported like Claude's: `gizmos/{id}` gives the name, description, instructions and the project's own files (signed links through `files/download` without a conversation; their shape is unverified), `gizmos/{id}/conversations` the chats. A project chat's note names its project (from its `gizmo_id`). The popup finds the project from `/g/g-p-…/` in the URL, or from the open chat's `gizmo_id`.
- **Temporary chats** are not in the list; "Save this chat" on the open page saves one. Custom GPTs are not exported.

## 8. Output layout and naming

```
Downloads/
  AI Chats/                                      configurable; empty = Downloads root
    <Title> - <YYYY-MM-DD> (Claude)/
      <Title> - <YYYY-MM-DD> (Claude).md
      files/
        report.pdf
        image.png
        image-2.png
        artifact-landing-page.html
    <Title> - <YYYY-MM-DD> (Gemini)/
    <Title> - <YYYY-MM-DD> (Grok)/
    <Title> - <YYYY-MM-DD> (ChatGPT)/
    Projects/
      <Project name> (Claude)/                   also (ChatGPT) and (Grok)
        <Project name> (Claude).md               description, instructions, file and chat links
        knowledge/
        chats/                                   the project's chats
          <Title> - <YYYY-MM-DD> (Claude)/
    Notebooks/
      <Notebook name> (Gemini)/
        <Notebook name> (Gemini).md              sources by name, chat links
        chats/
          <Title> - <YYYY-MM-DD> (Gemini)/
    _reports/
      export-report-<YYYY-MM-DD-HHmm>.md
```

The Markdown file has the same name as its folder, so note names stay unique and readable in Obsidian.

### Folder name

`<Title> - <YYYY-MM-DD> (<Platform>)`, where the date is the conversation's **creation date** in the user's local time zone. If the platform has no creation date, the first message date is used, then the export date (recorded as `created_source: export` in the frontmatter).

### Sanitization (`util/filename.ts`)

- Replace `\ / : * ? " < > |` and control characters with `_`.
- Collapse repeated spaces; trim spaces and dots at both ends.
- Limit the title to 80 characters, at a word boundary when possible.
- Append `_` to Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`LPT9`).
- An empty title becomes a fixed placeholder.
- Keep Cyrillic, emoji and other Unicode characters.

### Path length budget

Windows limits full paths to 260 characters. The longest relative path in a job (from the Downloads folder, including `Projects/…/chats/` and `files/<name>`) must not exceed **180 characters**. If it does, the title is shortened further at a word boundary. If that is not enough, attachment names are shortened while keeping their extensions.

### Unique names

- **Attachments.** Names in `files/` are made unique within a chat **before** downloading, so links in the Markdown always match the saved files: `image.png`, `image-2.png`, `image-3.png`. Comparison is case-insensitive.
- **Folders.** Two different chats with the same name get ` (2)`, ` (3)` after the platform: `Notes - 2026-10-13 (Claude) (2)`, and the note inside is renamed with its folder, so note names stay unique in Obsidian. Links inside the note are relative and do not change. Who picks the suffix depends on the destination: the registry for Downloads (`chrome.downloads` cannot help: its `uniquify` mode renames individual files, `name (1).md`, not folders), the file system for a chosen folder, and the set of folders already in the archive for a bulk ZIP.

### Export registry

The extension cannot read the Downloads folder. `chrome.storage.local` keeps:

- one record per exported conversation, keyed by platform and id: `{ updatedAt, exportedAt, destination, folder, missingFiles? }`;
- every folder name the extension has issued in Downloads, lower-cased.

The registry drives folder suffixes in Downloads, the "overwrite" mode (a conversation exported before to the same kind of destination goes back into its recorded folder, even if its title changed; so does one whose earlier export missed files, whatever the mode, so that folder is completed instead of copied), and the optional "skip unchanged chats" mode for bulk exports (same `updatedAt` as recorded, and no `missingFiles`: files that did not arrive for a passing reason, a dropped connection, 429 or 5xx, so the next export tries the chat again; files the platform does not provide or refuses, 403 and 404, do not count, or the chat would be exported again every time). Read-modify-write steps are serialized, because a bulk job and a shortcut export can overlap. If the user deletes a folder by hand, the registry does not know, and the next export still gets a suffix. The registry also keeps the files each export wrote (not for a ZIP): when a later export writes the same folder again, files the chat no longer has are deleted, from the chosen folder through its handle and from Downloads through Chrome's download history (only downloads this extension made). The options page has a button to clear the registry.

The export page reads the registry too (`registry:chats`: the latest export of each chat, saved alone or in a project, with the files it missed) and filters the list by it: not saved yet, changed since saved, saved and unchanged (`savedStatus` in `ui/export-page/filter.ts`). A chat counts as saved the way "skip unchanged chats" decides: its latest export has the chat's update time and every file. The page reads the registry again a second after it changes, so the counts follow a running export. The page remembers the list's sort and its choices (saved status, source, project) for each platform in `chrome.storage.local` (`exportFilter:<platform>`), not the search box or the dates; a remembered project the list no longer has is dropped.

## 9. Markdown format

The output targets Obsidian but stays plain Markdown.

- YAML frontmatter with `title`, `platform`, `conversation_id`, `url`, `created`, `updated`, `created_source`, `exported`, `model`, `project`, `message_count`, `attachments`, `tags`. Obsidian reads it as Properties.
- One `##` heading per message: role and local time.
- Model replies keep the platform's original Markdown (code blocks with languages, tables, lists, `$…$` / `$$…$$` math); all four platforms give Markdown. Platform marks that mean nothing outside its page are removed or replaced: Gemini's `[cite: N]`, Grok's `<grok:render>` cards, ChatGPT's `<Cite>`, `<Entity>`, `<FileCite>` and `<WritingBlock>`.
- A code fence a message leaves open (a reply that stopped inside a code block) is closed at the end of the message's text (`closeFences`); left open, it would turn the rest of the note into code. The archive search, reading notes saved before this, ends such a fence at the next message heading with its time or at a section heading of the note.
- Thinking, web search results and tool calls become collapsible Obsidian callouts (`> [!note]-`, `> [!info]-`, `> [!abstract]-`). Each type can be turned off in settings.
- Attachments are relative links into `files/`, with a note when the file is not the original (extracted text, rebuilt, re-encoded). An attachment that could not be saved is listed as `⚠️ name — <reason>`.
- Other branches follow the main one under "Other branches", each saying where it forks.

Rendering is a pure function from `Conversation` and settings to a string, so it is fully covered by fixture tests.

## 10. Export queue

The queue lives in the service worker.

- **One conversation written at a time.** While it is written, the next one is read (`readAhead`), so its request does not wait for the files of the current one. Not ahead of a project (it adds its chats first) or of a chat that "skip unchanged" will skip.
- **Files a few at a time:** up to four files of a chat or a project are fetched at once (`util/pool.ts`); the note lists them in the chat's order whatever order they arrive in. Into Downloads as separate files, one at a time, since the Save As guess reads the downloads in turn. API requests stay paced: ChatGPT's file links go through its `Pacer` one after another.
- **Delay between conversations:** 800 ms by default, configurable. A chat read ahead waits it out before its request, counted from the end of the previous read.
- **Retries:** on HTTP 429, 5xx and dropped connections, exponential backoff, up to 3 retries (1, 2, 4 s; ChatGPT waits 15, 30, 60 and 120 s after a 429), then the error goes to the report. Files are retried the same way ([section 12](#12-error-handling)).
- **Cancellation:** the current conversation finishes; the rest do not start.
- **Persistence:** Chrome stops an idle service worker after about 30 seconds. The job state (items with their status, settings at the start, the background tab, an open archive's id and folders) is saved to `chrome.storage.session` after each conversation, and the queue resumes from there when the worker starts again. An open ZIP archive lives on in the offscreen document. Verified on the test stand: a worker stopped in the middle of a job finished it after it was woken.
- **The worker stays awake during a job.** Chrome stops a service worker after 30 seconds without extension events, and a job can wait that long for a slow chat or for a large archive to be finished and downloaded. While a job runs, the queue calls `chrome.runtime.getPlatformInfo` every 20 seconds, which resets that timer. If the worker is stopped anyway, the job resumes; closing an archive is safe to repeat, because the offscreen document keeps the last few finished archives and gives a repeated close the same file (seen 2026-10-15: a Grok export started over after the close was retried and the archive was already gone).
- **Split and recoverable ZIP:** a bulk archive is kept in the offscreen document's memory and saved in parts of about 500 MB (`… (part 2).zip`), so memory stays bounded. If the document is closed or created again while a part is open (the extension was reloaded, or its process ran out of memory), the part is gone: the queue puts everything that went into it back into the queue (a project with its chats), gives back its folder names, and starts the part again under the same name. Up to three times per job; then the job stops. Verified on the test stand by closing the offscreen document in the middle of a 40-chat export: all 40 chats ended up in the archive.
- **Stopping:** a signed-out user, a rate limit that outlasted the retries, a Save As dialog, a cancelled archive dialog and problems with the chosen folder stop the whole job, because every remaining conversation would fail the same way. Other failures mark one conversation and the job goes on.
- **Skip unchanged:** a chat is skipped when its list update time equals the recorded one and the earlier export missed no file it could have saved ([registry](#export-registry)).
- **Report:** `_reports/export-report-<YYYY-MM-DD-HHmm>.md` in the export root (inside the archive for ZIP), when something failed or always, as set. It lists errors, conversations saved with missing files, skipped ones, ones not reached, and links to every saved note.
- **Progress** is shown on the export page (counters, the current conversation, a status column) and on the extension badge (…, then ✓ or !). A system notification reports the end of a bulk export.
- **Keyboard shortcut:** a panel on the chat page shows progress, the result and where it went. Pages without the content script get a system notification instead. Both can be turned off.
- **Duplicate trigger:** pressing the shortcut again while the same chat is exporting is ignored.

## 11. Manifest V3 constraints

| Constraint                                                                                                                   | How it is handled                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome.downloads` is not available in content scripts                                                                       | All downloads go through the service worker                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The service worker has no `URL.createObjectURL`                                                                              | The offscreen document creates blob URLs for generated `.md` files and ZIP archives and revokes each one after its download finishes                                                                                                                                                                                                                                                                                                                                      |
| Platform APIs need the user's cookies                                                                                        | Calls run in the content script, same-origin                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `chrome.runtime.sendMessage` serializes to JSON                                                                              | No binaries over messaging; files are passed as URLs or text                                                                                                                                                                                                                                                                                                                                                                                                              |
| `chrome.downloads.download({ filename })` accepts only paths relative to Downloads, without `..`                             | Paths are built and validated by `util/filename.ts`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The service worker is stopped when idle                                                                                      | Queue state is persisted, see [section 10](#10-export-queue)                                                                                                                                                                                                                                                                                                                                                                                                              |
| Chrome changes a downloaded file's extension to match a known MIME type (a `.jsx` served as `text/plain` is saved as `.txt`) | Text the extension writes (Markdown, artifacts) goes through a blob of type `application/octet-stream`, which Chrome leaves alone. Files downloaded by URL keep their names because the platforms serve them without a conflicting type                                                                                                                                                                                                                                   |
| "Ask where to save each file" turns every download into a dialog, and no API reports this setting                            | Heuristic on the downloads of an export: a file saved in another folder than asked, or a download that gets bytes but no file name past a timeout, means a dialog (a name Chrome changed, or a slow server, does not). Then stop (`save-dialog`; a cancelled download is `download-cancelled`) and say so in grey, not as an error. Into Downloads, a chat with files and any bulk export are one ZIP, so Chrome asks at most once; a chosen folder has no dialogs at all |

## 12. Error handling

- A failed attachment: the chat is still saved; the problem is marked in the Markdown and in the report.
- A dropped connection (while sending, or while reading a slow answer such as a deep page of Gemini's list) or a 429/5xx is tried again after 1, 2 and 4 s: API requests (`fetchJson`, Gemini's `batchexecute`), files fetched by the extension (folder, ZIP) and Chrome downloads (`downloadWithRetry`; an interrupted item is cancelled, which deletes its partial file, so the next try keeps the name).
- Chrome resumes an interrupted download by itself, but then picks the file name again and forgets the one the extension asked for (the file lands in Downloads as `content`; Chrome for Testing 1248). An `onDeterminingFilename` listener names again every download the extension started and leaves all others alone. The names are mirrored into `chrome.storage.session`, so a worker that Chrome stopped in the middle of a download still names it when Chrome resumes it (checked on the stand: without the copy the file came back as `content`).
- A failed chat: the bulk export continues; the chat is listed in the report.
- Not signed in or session expired: a clear message, and the export stops.
- A chat that is no longer on the platform (deleted): `chat-not-found`, said as such, not as a changed format.
- Rate limited (429 after all retries): a clear message, and a bulk export stops; started again later, "skip unchanged" continues where it stopped.
- Platform format changed (schema validation failed): an error with the platform and field name and a hint to update the extension.
- The report is written to `_reports/` when there were errors (configurable). Skips by "skip unchanged chats" are intended and do not trigger it on their own.
- Every error is logged to the service worker console with the `[ai-chat-exporter]` prefix.

## 13. Permissions and privacy

- `permissions` are added phase by phase, only when code starts using them. Current set: `downloads`, `storage`, `offscreen`, `activeTab`, `scripting`, `notifications`, `clipboardWrite` (the popup copies a chat's Markdown once the worker has read the chat, which can take longer than a click's activation lasts; the page button's copy goes through the offscreen document, created with the `CLIPBOARD` reason as well as `BLOBS`). `tabs` is not needed: `activeTab` and the platforms' host permissions give access to the tab URL. The README lists each permission with the reason.
- `commands` for the keyboard shortcut. Users can rebind it in `chrome://extensions/shortcuts`; the options page shows the current binding.
- `host_permissions`: `https://claude.ai/*`, `https://gemini.google.com/*`, and Gemini's file hosts `https://lh3.googleusercontent.com/*`, `https://lh3.google.com/*` (where the first one redirects some images) and `https://contribution.usercontent.google.com/*`, Gemini's script hosts `https://www.gstatic.com/*` and `https://gemini.gstatic.com/*` (read only to find the search query again, see [Gemini](#gemini)), `https://grok.com/*` with its file host `https://assets.grok.com/*`, and `https://chatgpt.com/*`, whose signed file links are on the same host. The file hosts are needed only when the offscreen document fetches files for a chosen folder or a ZIP, since `chrome.downloads` needs no permission. The list is kept minimal and each entry is justified in the README.
- No external servers. All data stays on the user's machine.
- Test fixtures contain only anonymized data: message text, names, emails and organization ids are replaced.

## 14. Extending: Obsidian sinks

The Obsidian phase (after the stabilization of 1.0) adds new `ExportSink` implementations without changing adapters, rendering or the queue:

- **ObsidianRestSink** writes through the Local REST API plugin (`PUT /vault/{path}`, API key in settings). It needs Obsidian to be running.
- **Writing into the vault folder** already works: pick the vault (or a folder inside it) as the destination. `FolderSink` writes through the File System Access API and works with Obsidian closed. The Obsidian phase adds the vault-specific options below on top of it.

Planned Obsidian options: a target folder inside the vault, attachments next to the note or in the vault's attachment folder, wikilinks (`![[file.pdf]]`), and updating a note when its chat changes.

## 15. Tech stack

| Tool                                                            | Purpose                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| TypeScript (strict)                                             | All code                                                                |
| Vite + [CRXJS](https://github.com/crxjs/chrome-extension-tools) | Build; manifest in TypeScript; hot reload for popup and content scripts |
| Preact                                                          | Popup, export page, options page                                        |
| zod                                                             | Runtime validation of platform responses                                |
| fflate                                                          | ZIP archives, streamed into Blob parts; small and without dependencies  |
| Vitest                                                          | Unit tests on fixtures; table tests for name sanitization               |
| happy-dom, @testing-library/preact                              | Tests of the export page and the popup (development only)               |
| ESLint + Prettier                                               | Linting and formatting                                                  |

Every new dependency is justified in its commit message.

## 16. Decision log

| #   | Decision                                                                                                                       | Reason                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Export into a `Downloads/AI Chats/` subfolder (configurable)                                                                   | Keeps exports together; `chrome.downloads` can only write under Downloads                                                                                                          |
| 2   | Platform name in the folder name                                                                                               | The same title can exist on both platforms                                                                                                                                         |
| 3   | Export Claude Projects (instructions, knowledge files, optional chats)                                                         | Project context is part of the conversation history                                                                                                                                |
| 4   | Keyboard shortcut for the current chat                                                                                         | Fast single-chat export without the popup                                                                                                                                          |
| 5   | Folder suffix chosen from the registry                                                                                         | `uniquify` renames files, not folders                                                                                                                                              |
| 6   | Attachment names deduplicated before download                                                                                  | Markdown links must match saved files                                                                                                                                              |
| 7   | Path length budget of 180 characters                                                                                           | Windows 260-character path limit                                                                                                                                                   |
| 8   | `.extracted.txt` when the original upload is unavailable                                                                       | Claude may expose only extracted text for documents                                                                                                                                |
| 9   | Vite + CRXJS                                                                                                                   | TypeScript manifest and hot reload with little build code                                                                                                                          |
| 10  | Preact                                                                                                                         | The export page has a stateful table; Preact is about 4 KB                                                                                                                         |
| 11  | Heuristic detection of the "ask where to save" setting                                                                         | No API exposes it                                                                                                                                                                  |
| 12  | Queue state in `chrome.storage.session`                                                                                        | The service worker is stopped when idle                                                                                                                                            |
| 13  | No MAIN-world script for Gemini                                                                                                | Discovery showed `batchexecute` can be called directly; intercepting the page is not needed                                                                                        |
| 14  | APIs for every platform: REST for Claude, Grok and ChatGPT, `batchexecute` for Gemini                                          | Replies come as Markdown with dates and models; reading the page would be slower and break on every redesign                                                                       |
| 15  | Offscreen blob URLs only, no data URL path                                                                                     | One code path for every size; data URLs would need a size limit                                                                                                                    |
| 16  | UI strings through `chrome.i18n`, English default, Russian included                                                            | Public project; Chrome picks the language from the browser                                                                                                                         |
| 17  | Settings in `chrome.storage.local`, validated on every read                                                                    | Old or corrupted stored values fall back to defaults instead of breaking                                                                                                           |
| 18  | TypeScript 6.0, not 7.x                                                                                                        | typescript-eslint supports TypeScript below 6.1                                                                                                                                    |
| 19  | Tool calls in Markdown: one collapsed callout per answer, one line per call; full input and output as an option                | Session chats make dozens of tool calls; a callout per call would bury the answer                                                                                                  |
| 20  | Other Claude branches rendered after the main branch, each labelled with where it forks                                        | Readable in Obsidian; the main branch stays the note's body                                                                                                                        |
| 21  | UI strings generated from `scripts/locales.py` with Chrome placeholders (`$ARG1$`)                                             | One source for both languages; the documented substitution format                                                                                                                  |
| 22  | Host permission for claude.ai granted now                                                                                      | Reliable script injection and tab URL access; the content script already needs the site                                                                                            |
| 23  | Files with a URL are downloaded by `chrome.downloads` directly                                                                 | Verified: it sends the claude.ai session cookie (SameSite=Lax) and interrupts on HTTP errors instead of saving an error page                                                       |
| 24  | Artifact text read by the content script, saved through an `application/octet-stream` blob                                     | Keeps the artifact's extension; no host permission for the artifact domain is needed                                                                                               |
| 25  | Artifacts of chats without a session rebuilt from write and edit calls                                                         | No API maps an older chat's artifact link to its id; the chat itself has the content                                                                                               |
| 26  | Files first, Markdown last; a probable Save As dialog stops the export                                                         | Links in the note point only at files that exist; the user is not asked once per file                                                                                              |
| 27  | A chosen folder as a destination, written from the offscreen document                                                          | No Save As dialogs whatever Chrome's settings; the service worker has no File System Access, the offscreen document does                                                           |
| 28  | ZIP as an option in either destination, built with fflate                                                                      | One download instead of one per file; also the format for bulk exports                                                                                                             |
| 29  | Per-file failures in the offscreen document come back as a reason, folder-wide ones as a `CodedError`                          | Error classes do not survive messaging; a missing folder or lost access must stop the export, a missing file must not                                                              |
| 30  | Bulk work in a platform tab, opened in the background when none is open                                                        | The adapter's requests stay the web app's own; artifact sources need the claude.ai origin                                                                                          |
| 31  | Job state in `chrome.storage.session`, followed by pages through `storage.onChanged`                                           | Survives a worker restart; no extra message channel for progress                                                                                                                   |
| 32  | A note renamed with its folder on ` (2)`                                                                                       | Note names stay unique in Obsidian                                                                                                                                                 |
| 33  | Panel on the chat page for the keyboard shortcut                                                                               | Shows progress, result and the ZIP choice where the user is; a notification only where there is no content script                                                                  |
| 34  | An `onDeterminingFilename` listener only to keep our names when Chrome resumes a download                                      | Chrome forgets the requested name on resume; a suggestion does not stop MIME-based renaming, so text still goes as octet-stream                                                    |
| 35  | A project is a job item; its chats are queued after it and its note is written last                                            | One progress, cancel, resume and report for everything; the note can link to the chats' final folders                                                                              |
| 36  | Project notes link to chats with relative Markdown links, not wikilinks                                                        | They work in Obsidian and anywhere else; wikilinks are an Obsidian-phase option                                                                                                    |
| 37  | Lenient parsing: only ids are required; unreadable blocks become a ⚠️ line                                                     | A new block type or a missing field should cost one block, not the chat; real exports failed on such chats                                                                         |
| 38  | Bulk ZIP in 500 MB parts, a lost part exported again                                                                           | The archive lives in the offscreen document's memory, which a reload or a crash takes away                                                                                         |
| 39  | Gemini history from `hNvQHb`, creation date from the oldest turn                                                               | The list has only the last update time                                                                                                                                             |
| 40  | Gemini Canvas saved as a link to its Google Docs document                                                                      | Canvas now lives in Drive; downloading it would need Drive access                                                                                                                  |
| 41  | Grok files from `assets.grok.com` by key                                                                                       | Verified byte for byte, images included                                                                                                                                            |
| 42  | Gemini chats filtered by the update date on the export page                                                                    | Gemini's list has no creation date; reading every history for it would cost a request per chat                                                                                     |
| 43  | Grok's visible branch from `?rid=`, else the newest answer                                                                     | The page shows the newest answer by default and the one in `?rid=` when the user switched                                                                                          |
| 44  | Unknown Grok cards noted as unreadable, not dropped silently                                                                   | Grok Studio and other cards were not available for discovery; the note tells the user something is missing                                                                         |
| 45  | ChatGPT in version 1.0, before stabilization; Obsidian after it                                                                | The owner's order: a fourth platform first, then one stabilization pass over all four                                                                                              |
| 46  | ChatGPT through `/backend-api/` with the session's access token, kept in memory only                                           | The API answers only with the token; without it the list is silently empty                                                                                                         |
| 47  | ChatGPT canvas content from `metadata.writing_blocks`, not the answer text                                                     | The user's edits in the canvas change only the metadata                                                                                                                            |
| 48  | Gemini chats past the end of the list found through Gemini's own search                                                        | The list stops at about 800 chats; search covers the whole history, 20 chats per query                                                                                             |
| 49  | Re-encoded images renamed after their first bytes                                                                              | Gemini returns a `.png` upload as a JPEG; the file should open as what it is                                                                                                       |
| 50  | Dropped connections retried like server errors, for requests, files and Chrome downloads                                       | Long exports over a weak connection lost chats and files that answered fine a minute later                                                                                         |
| 51  | The registry keeps the list's update time and the number of files that did not arrive                                          | ChatGPT's list and conversation times differ; a chat that missed files must not be skipped as unchanged                                                                            |
| 52  | ChatGPT files it no longer gives saved from the text the model read                                                            | A long paste is never given as a file (404), but its text, cut at 16,384 characters, is in the chat                                                                                |
| 53  | A rate limit that outlasts the retries stops a bulk export                                                                     | Asking again at once prolongs the limit; a later run with "skip unchanged" continues                                                                                               |
| 54  | A chat whose earlier export missed files goes back into that folder, overwriting                                               | The earlier folder is incomplete; a `(2)` copy next to it would leave two halves                                                                                                   |
| 55  | ChatGPT's API requests paced by the adapter, the gap widened after a 429                                                       | The limit is reached by a run of requests; spacing them costs less than minutes of retries                                                                                         |
| 56  | A refused file link asked again once from the tab                                                                              | ChatGPT's signed links have an unknown lifetime, and a chat's files are written one after another                                                                                  |
| 57  | Re-encoded images for a folder or a ZIP downloaded once, while their type is read                                              | Both are written from the offscreen document, which can keep the file until the write                                                                                              |
| 58  | Files an earlier export wrote and the chat no longer has are deleted when the folder is written again                          | A renamed or removed file would otherwise stay next to the new ones                                                                                                                |
| 59  | Page and popup tested with happy-dom and @testing-library/preact                                                               | The export page holds most of the user-facing logic; stands alone were slow to catch regressions                                                                                   |
| 60  | Gemini notebooks exported as projects, always with their chats; sources listed by name                                         | The service gives no download for a source; a notebook without its chats would be an empty note                                                                                    |
| 61  | Gemini's script hosts in the permissions, to find a renamed search query                                                       | The web app's scripts moved to gstatic.com; without them the repair found nothing                                                                                                  |
| 62  | ChatGPT and Grok projects exported like Claude's, with the project names on their chats                                        | Both services keep project chats and their files; Grok's list does not name a chat's project                                                                                       |
| 63  | A project always goes with its chats; the popup has no "Save all chats"                                                        | The chats are what a project holds; "Select all" on the export page does the same                                                                                                  |
| 64  | "Save with files" next to .zip; a small Copy button next to Save in the popup                                                  | A choice made per export, not once in the settings; a chat is often wanted as text                                                                                                 |
| 65  | HTML and JSON notes besides Markdown; HTML made from the Markdown with marked                                                  | Asked for by users of other exporters; one source of layout, printing gives PDF                                                                                                    |
| 66  | A floating button with a menu on chat pages, not one inside the site's toolbar                                                 | Sites change their layout; the menu says what a click saves, unlike a bare button                                                                                                  |
| 67  | "Save to a folder…" (one chat) and "To a folder…" (export page); removed, see 69                                               | chrome.downloads writes only inside Downloads; elsewhere Chrome asks about each file                                                                                               |
| 68  | Into Downloads, a chat with files and any bulk export as one ZIP; no ZIP setting                                               | One download, so Chrome asks at most once; separate files go to a chosen folder                                                                                                    |
| 69  | The chosen folder only as the settings' destination, no "Save to a folder…" buttons                                            | Fewer buttons; with one ZIP into Downloads, Chrome asks at most once, so the buttons were no longer needed to get around it                                                        |
| 70  | Up to four files at once, and the next chat read while the current one is written                                              | Files came one after another, and a bulk export waited for each chat's files before asking for the next chat                                                                       |
| 71  | A Word (.docx) note made in the offscreen document from the Markdown, with the chat's images inside                            | The images are there already (written into the folder or the ZIP from there), so they are not fetched twice; png, jpg and gif only, which every Word shows                         |
| 72  | Chosen messages on an extension page fed by the adapter, saved as a copy the registry does not record                          | No page selectors on four sites; a partial copy must not count as the chat's export for "skip unchanged" or overwriting                                                            |
| 73  | The chosen folder only where the browser has the File System Access API, checked, with Brave's flag named                      | Brave turns the API off by default; without a check the folder option failed with an unclear error                                                                                 |
| 74  | Archive search over a folder the user picks (read only), .zip exports read inside, no index but a cache of each message's text | Exports into Downloads are zips, so the export folder alone would leave most archives out; scanning tens of megabytes of text is fast and finds any part of a word in any language |
