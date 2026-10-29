# Chrome Web Store listing

What goes into each field of the listing in the [Chrome Web Store developer console](https://chrome.google.com/webstore/devconsole). The images are made by `node scripts/store-images.mjs` from the real extension on a stand with made-up chats; run it again after a visible change to the popup or the export page.

## Package

Upload `ai-chat-exporter-<version>.zip` from the [release](https://github.com/nikolaylosev/ai-chat-exporter/releases) as it is: `manifest.json` is at its root. Each upload needs a higher version than the last one.

## Store listing tab

| Field                  | Value                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                   | From the package: "CodingCat AI Chat Exporter" (both languages)                                                                                                                  |
| Summary                | From the package: `extDescription` in `scripts/locales.py` (English, Russian) and `LISTING` there for the other languages                                                        |
| Description            | `description.<language>.txt`: en, ru, de, es, fr, pt_BR, ja, zh_CN                                                                                                               |
| Category               | Productivity › Tools (a category is chosen inside a group; Workflow & Planning would be the second choice)                                                                       |
| Language               | English first; then add Russian, German, Spanish, French, Portuguese (Brazil), Japanese and Chinese (Simplified), each with its description                                      |
| Store icon             | `store-icon-128.png`: the package's `icons/icon-128.png`, 96×96 artwork in 16 px of padding with a faint glow                                                                    |
| Screenshots (1280×800) | `screenshot-1-popup.png`, `screenshot-2-choose.png`, `screenshot-3-search.png`, `screenshot-4-progress.png`, `screenshot-5-note.png`, in this order (the store takes up to five) |
| Small promo tile       | `promo-small-440x280.png` (required)                                                                                                                                             |
| Marquee promo tile     | `promo-marquee-1400x560.png` (optional: shown only if the store features the extension)                                                                                          |
| Homepage URL           | https://github.com/nikolaylosev/ai-chat-exporter                                                                                                                                 |
| Support URL            | https://github.com/nikolaylosev/ai-chat-exporter/issues                                                                                                                          |
| Mature content         | No                                                                                                                                                                               |

The screenshots are in English; the same ones serve every language. The interface itself is in English and Russian; in the other languages Chrome shows it in English, and only the name and the summary are translated.

## Privacy practices tab

**Single purpose**

> Exports the user's own conversations from Claude, Gemini, Grok and ChatGPT to the user's computer as Markdown notes, together with the files from those conversations.

**Permission justifications**

| Permission       | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`      | When the user clicks the toolbar button or presses the keyboard shortcut on a chat page, the extension reads which conversation is open in that tab, to export it.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scripting`      | Injects the extension's own content script into a claude.ai, gemini.google.com, grok.com or chatgpt.com tab when the user exports and the tab was opened before the extension was installed or updated. Only code from the extension package is injected.                                                                                                                                                                                                                                                                                                                                           |
| `downloads`      | Saves the exported Markdown notes, the conversations' files and optional .zip archives into the user's Downloads folder, under the names the extension sets. It deletes only files it saved itself, when a chat saved again no longer has them.                                                                                                                                                                                                                                                                                                                                                     |
| `storage`        | Keeps the user's settings, the state of a running export (so it continues after the service worker restarts) and a local record of what was exported (to skip unchanged chats). Nothing is sent anywhere.                                                                                                                                                                                                                                                                                                                                                                                           |
| `offscreen`      | Builds .zip archives, writes files into a folder the user chose (File System Access API), and copies a chat to the clipboard for the button on the chat page, in an offscreen document: the service worker has no DOM for blobs, archives, folder handles or the clipboard.                                                                                                                                                                                                                                                                                                                         |
| `notifications`  | Reports the result when a bulk export finishes, and of a keyboard-shortcut export when it cannot be shown on the page. Can be turned off in the settings.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `clipboardWrite` | The Copy actions (in the popup and in the menu of the button on the chat page) put the open conversation on the clipboard as Markdown. The text is ready only after the conversation has been read, which can take longer than the click's user activation lasts.                                                                                                                                                                                                                                                                                                                                   |
| Host permissions | claude.ai, gemini.google.com, grok.com, chatgpt.com: read the user's own conversations, projects and files through the requests the sites' web apps make, with the user's existing session. lh3.googleusercontent.com, lh3.google.com, contribution.usercontent.google.com: download images and files of Gemini conversations. assets.grok.com: download files of Grok conversations. www.gstatic.com, gemini.gstatic.com: read the Gemini web app's scripts as text (never run them) to find the name of its chat search request when Gemini renames it. No conversation data is sent to any host. |

**Remote code:** "No, I am not using remote code." All code is in the package; Gemini's scripts are only searched as text.

**Data usage**

- Tick **Personal communications** (the conversations) and **Website content** (their text, images and files). Nothing else is read.
- Tick all three certifications: not sold or transferred to third parties, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.
- **Privacy policy URL:** https://github.com/nikolaylosev/ai-chat-exporter/blob/main/PRIVACY.md

## Not here yet

The Distribution tab: visibility (Unlisted first, then Public) and regions (all).
