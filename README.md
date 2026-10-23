# CodingCat AI Chat Exporter

A Chrome extension that saves your conversations from **claude.ai**, **gemini.google.com**, **grok.com** and **chatgpt.com** to your computer: the chat as a Markdown file, plus every file from the chat in its original format. Each conversation gets its own folder. Projects can be exported with their instructions, files and chats, and Gemini notebooks with their chats. The output is ready to drop into an Obsidian vault.

> **Status:** in development. Claude works: the current chat, all chats or a selection, and projects, with uploads, files the model created and artifacts. Gemini works: the current chat, all chats or a selection, and notebooks, with uploads and generated images. Grok works: the current chat, all chats or a selection, and projects, with uploads, generated images, files the model created and regenerated answers. ChatGPT works: the current chat, all chats or a selection (archived chats and project chats included), and projects, with uploads, generated images, files made by code, canvas and branches.

> [!IMPORTANT]
> **This is an unofficial, independent project.** It is not affiliated with, endorsed by, or sponsored by Anthropic, Google, xAI or OpenAI. "Claude" is a trademark of Anthropic. "Gemini" is a trademark of Google. "Grok" is a trademark of xAI. "ChatGPT" is a trademark of OpenAI.
>
> The extension reads your conversations through the same undocumented internal interfaces that the claude.ai, gemini.google.com, grok.com and chatgpt.com web apps use. These interfaces can change at any time, which may break the extension.
>
> You are responsible for making sure your use of this extension complies with the terms of service of Claude, Gemini, Grok and ChatGPT. The MIT license covers only the code in this repository. It does not grant any rights to use those services or their interfaces.

## Features

- Export the current chat, all chats, or a selected set (search, date filter, checkboxes).
- Save the conversation as Markdown with YAML frontmatter and collapsible callouts for thinking, web search and tool calls; or as an HTML page (opens in any browser, prints to PDF) or JSON.
- Save every file from the chat: your uploads, files the model generated, artifacts, canvases and images.
- Export projects from Claude, ChatGPT and Grok: instructions, the project's own files and all its chats.
- Export Gemini notebooks with all their chats. Their sources are listed by name: Gemini keeps them in NotebookLM and gives no download for them.
- Progress, cancel, and an error report for bulk exports. A dropped connection or a busy service is tried again, and a chat that missed files is exported again next time.
- Keyboard shortcut for the current chat: `Alt+Shift+S` (`Option+Shift+S` on macOS).

Files are saved to `Downloads/AI Chats/<Title> - <YYYY-MM-DD> (<Platform>)/`.

## Privacy

- Everything stays on your computer. The extension has no server, no analytics and no telemetry.
- It talks only to claude.ai, gemini.google.com, grok.com, chatgpt.com and the file and script domains those sites use.
- It uses your existing browser session. It never sees or stores your password. On ChatGPT it asks the open session for its access token, as the web app does, and keeps it only in memory while the tab is open.
- The full [privacy policy](PRIVACY.md) says what is read, what is stored in Chrome and where it goes.

## Installation

The extension is not in the Chrome Web Store. You load it as an unpacked extension: from a release, from a CI build, or built from source.

**Release.** Open the repository's **Releases**, download `ai-chat-exporter-<version>.zip` from the latest one and unzip it. Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the unzipped folder (the one that contains `manifest.json`).

**CI build** of any branch. Every CI run keeps the built extension for 30 days.

1. Open the repository's **Actions** tab and pick the latest successful **CI** run for the branch you want (`main` for the current version).
2. Under **Artifacts**, download `ai-chat-exporter-<commit>` and unzip it.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the unzipped folder (the one that contains `manifest.json`).

**From source.**

1. Install [Node.js](https://nodejs.org/) 22 or later.
2. Build:
   ```sh
   npm ci
   npm run build
   ```
3. Load the `dist` folder as in step 3 above.

**Then, either way:** if Chrome's **Ask where to save each file before downloading** is on (`chrome://settings/downloads`), saving separate files into Downloads opens a dialog for every file. Pick one of these:

- turn that Chrome setting off;
- in the extension settings, save to **a folder you choose**: the extension writes straight into it, with no dialogs;
- tick **Save as .zip** when saving: one download, so at most one dialog.

The extension cannot read Chrome's setting. In the default mode it stops the export at the first dialog, then warns you in the popup until an export succeeds.

To update, replace the folder with a newer build (or pull and run `npm run build` again) and click the reload button on the extension card.

## Usage

- **Save the current chat:** open a conversation on claude.ai, gemini.google.com, grok.com or chatgpt.com, click the extension icon and choose **Save this chat**, use the round button in the bottom right corner of the chat (its menu saves the chat with its files, its text only, or copies it as Markdown), or press `Alt+Shift+S` (`Option+Shift+S` on macOS). After the shortcut, a small panel in the corner of the chat page shows progress, the result and where it was saved. The icon shows ✓ when the file is saved, ! when something went wrong.
- **Save many chats:** in the popup, choose **Choose chats…**. The export page opens on the platform of the open tab, and a switch at the top changes it. It lists every chat with its dates and project (the Gem on Gemini; archived ChatGPT chats are marked; Gemini's list stops at about 800 chats, and **Find more chats with Gemini search** adds older ones through Gemini's own search, which takes several minutes; they appear as they are found and are remembered for the next visit); search, filter by date (creation date on Claude, Grok and ChatGPT, last update on Gemini, whose list has no creation dates), sort, tick the ones you want (or all of them) and click **Save selected**. A long list can be stopped while it loads (**Stop and use these**), to work with the newest chats only. The export goes on in the background if you close the page, and you can cancel it (the chat being saved is finished first). A report in `_reports/` lists anything that failed. If a service keeps refusing because it is asked too often (ChatGPT does this), the export stops with a message; start it again later with **skip unchanged chats** on, and it goes on from where it stopped.
- **Save a project:** on a project page on Claude, ChatGPT or Grok, or in a chat inside a project, click **Save project with its chats** in the popup. It goes to `Projects/<Name> (<Platform>)/`: a note with the description, the instructions and links, the project's files in `knowledge/`, and every chat of the project in `chats/`. **Choose projects…** opens the export page on the Projects tab to save several at once.
- **Save a Gemini notebook:** on a notebook page, click **Save notebook with its chats** in the popup. It goes to `Notebooks/<Name> (Gemini)/`: a note listing the sources by name and linking the chats and the notebook in NotebookLM, and every chat of the notebook in `chats/`. The source files are not saved; open the notebook in NotebookLM to get them. **Choose notebooks…** opens the export page on the Notebooks tab.
- **Save as .zip:** tick it in the popup, on the export page or in the shortcut panel. The choice is remembered. A bulk export makes one archive with all the chats.
- **Save with files:** untick it in the popup or on the export page to save only the notes; each note still lists its files by name, and a project's own files are listed the same way.
- **Copy:** the small button next to **Save this chat** puts the chat's Markdown on the clipboard, with its files listed by name, and saves nothing.
- **Change the shortcut** at `chrome://extensions/shortcuts`. The settings page shows the current one.
- **Files** from the chat go into `files/` next to the note: your uploads in their original format, files the model created, artifacts with their real extension (`artifact-<title>.html`, `.jsx`, `.svg`…) and ChatGPT canvases (`canvas-<title>.md`). When a service keeps only text extracted from a file (a long text pasted into ChatGPT, an old Claude upload), that text is saved as `<name>.extracted.txt` and marked in the note; Gemini's re-encoded images are marked too, and get the extension of their real format. A file that could not be saved is marked ⚠️ in the note with the reason, and the icon shows an orange !.
- **Where to save:** Chrome's Downloads folder (default), or a folder you choose in the settings, for example `Documents/AI Chats` or a folder in your Obsidian vault. Chrome may not let you pick Documents, Downloads or Desktop themselves; create a folder inside them. Chrome may ask again for access to the folder after a restart: click **Save chat** in the popup and allow it.
- **Saving a chat again** makes a new copy, `Chat (2)`, or overwrites the earlier one, as set in the settings. The extension remembers what it saved; the settings page can clear that memory. With **skip unchanged chats**, a bulk export skips chats that have not changed since they were saved, unless a file was missing last time: such a chat is saved again into its earlier folder, which gets the missing files.
- **Settings** (right-click the icon → Options): where to save, folder inside Downloads, platform name in folder names, note format (Markdown, HTML or JSON), the save button on chat pages, artifact versions (latest or all), thinking blocks, web searches and tool calls (one line per call or full input and output), branches in Claude, Grok and ChatGPT (only the one you see, or all), saving a chat again, skipping unchanged chats, pause between chats, the report, the shortcut panel.

## Permissions

| Permission                                                                                                         | Why                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `downloads`                                                                                                        | Save files into your Downloads folder                                                                                                    |
| `storage`                                                                                                          | Keep your settings                                                                                                                       |
| `offscreen`                                                                                                        | Turn generated Markdown and ZIP archives into downloadable files, write into the folder you chose (the background worker can do neither) |
| `activeTab`                                                                                                        | See whether the current tab is Claude, Gemini, Grok or ChatGPT when you open the popup                                                   |
| `scripting`                                                                                                        | Load the site helper into a chat tab that was open before the extension was installed or reloaded                                        |
| `notifications`                                                                                                    | Report the result of a keyboard-shortcut export (can be turned off in settings)                                                          |
| `clipboardWrite`                                                                                                   | Put a chat's Markdown on the clipboard when you press Copy in the popup                                                                  |
| `https://claude.ai/*`                                                                                              | Read your conversations through the same requests the claude.ai web app makes, with your existing session                                |
| `https://gemini.google.com/*`                                                                                      | Read your Gemini conversations through the requests the Gemini web app makes, with your existing session                                 |
| `https://lh3.googleusercontent.com/*`, `https://lh3.google.com/*`, `https://contribution.usercontent.google.com/*` | Fetch images and files from Gemini chats when saving into a folder you chose or as a ZIP                                                 |
| `https://www.gstatic.com/*`, `https://gemini.gstatic.com/*`                                                        | Read the Gemini web app's scripts, only to find its chat search again when Gemini renames it                                             |
| `https://grok.com/*`                                                                                               | Read your Grok conversations through the requests the Grok web app makes, with your existing session                                     |
| `https://assets.grok.com/*`                                                                                        | Fetch files and images from Grok chats when saving into a folder you chose or as a ZIP                                                   |
| `https://chatgpt.com/*`                                                                                            | Read your ChatGPT conversations through the requests the ChatGPT web app makes, with your existing session, and fetch their files        |

More permissions will be added only when a feature needs them, each with its reason here.

## Development

```sh
npm run dev        # build in watch mode with hot reload; load dist/ as above
npm run build      # production build into dist/
npm run check      # type check, lint, format check, tests
npm test           # unit tests only
npm run e2e        # stands: the built extension in Chrome for Testing against fake platforms
npm run icons      # regenerate public/icons from the logo, assets/logo.png
```

The repository runs the same checks and the build on every pull request (GitHub Actions).

**Releasing.** The version lives in `package.json`, and the manifest takes it from there.

1. Raise `version` in `package.json` (and `package-lock.json`, for example with `npm version 0.2.0 --no-git-tag-version`) in a pull request, and merge it.
2. Tag the merge on `main` and push the tag:
   ```sh
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

The **Release** workflow checks that the tag matches `package.json` (Chrome accepts only numbers, `vX.Y.Z`), runs the checks, builds, and publishes a GitHub release with `ai-chat-exporter-<version>.zip` and notes generated from the merged pull requests.

Notes on the build:

- **Vite + CRXJS.** CRXJS builds the manifest from TypeScript (`src/manifest.ts`), bundles every entry point it references, and reloads the popup and content scripts during development. A hand-written Vite config would need the same work done by scripts.
- **Saving generated text.** The background service worker cannot create blob URLs, so an offscreen document (`src/offscreen/`) turns Markdown into a blob URL, `chrome.downloads` saves it, and the URL is revoked afterwards. Files that already have a URL on the platform are downloaded from that URL directly.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the extension is built and why.
- [tests/e2e/README.md](tests/e2e/README.md): the stands, end-to-end tests in Chrome against fake platforms (`npm run e2e`).
- What the extension reads from each platform and how, recorded from real traffic: [Claude](docs/platforms-claude.md), [Gemini](docs/platforms-gemini.md), [Grok](docs/platforms-grok.md), [ChatGPT](docs/platforms-chatgpt.md).

## License

[MIT](LICENSE). See the disclaimer above: the license applies to this code only.
