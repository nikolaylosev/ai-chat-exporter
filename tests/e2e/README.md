# Stands (end-to-end tests)

Each stand runs the built extension in Chrome for Testing against a fake platform: a local HTTPS server answers as claude.ai, chatgpt.com, gemini.google.com or grok.com from `tests/fixtures/`, and Chrome is pointed at it with `--host-resolver-rules`. The extension is driven over the DevTools protocol the way a user would: a chat tab and the shortcut's export, or the export page and its buttons. Each scenario asserts what was saved: names, bytes, folders, the job's counts, what the page shows.

```sh
npm run e2e                 # every scenario
npm run e2e -- gemini list  # scenarios whose name contains "gemini" or "list"
```

Needs Chrome for Testing (`npx playwright install chromium`, or `CHROME_PATH=/path/to/chrome`) and `openssl` for a throwaway certificate. The extension is built into a temporary folder, never into `dist/`. The stands are not part of CI, which has no Chrome; run them before a release. All of them take about ten minutes.

| Scenario            | What it checks                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-bulk`       | Five Claude chats: uploads, files the model made and a published artifact byte for byte, every branch; a project with its knowledge base and chat; HTML and JSON notes; the project again without files |
| `chatgpt-current`   | Six ChatGPT chats: each with files as one .zip, one without as its note alone; uploads, a generated image and a file made by code byte for byte; the token only on API requests                         |
| `chatgpt-bulk`      | The export page: history over two pages, archived and project chats; one ZIP; a file that never arrives brings its chats back on the next run, the rest are skipped as unchanged                        |
| `downloads-dropped` | A dropped connection while a chat's files are fetched: a file cut twice is fetched again; one that never arrives is marked as failed                                                                    |
| `slow-file`         | A file whose server answers late is saved, and the export goes on                                                                                                                                       |
| `expired-link`      | An expired signed link is asked again, into Downloads (.zip) and into a chosen folder                                                                                                                   |
| `folder-rewrite`    | Into a chosen folder: a chat that missed a file completes its folder; a complete one makes a copy; overwriting deletes a file the chat no longer has                                                    |
| `bulk-to-folder`    | The folder destination: the chats selected on the export page with their files in the chosen folder, nothing in Downloads                                                                               |
| `page-button`       | The button on a chat page: its menu saves with files (.zip) or text only, copies; Escape closes it; hidden off a chat and by the setting                                                                |
| `gemini-current`    | Gemini chats, documents byte for byte, a generated image, a Gem's name                                                                                                                                  |
| `gemini-images`     | A re-encoded png saved as `.jpg` in the chat's .zip, fetched once                                                                                                                                       |
| `gemini-search`     | Search results appear as they come, are remembered after a reload, and can be forgotten                                                                                                                 |
| `gemini-notebook`   | A notebook from the Notebooks tab: its sources listed by name, its four chats in `chats/`                                                                                                               |
| `list-stop`         | A slow list stopped halfway keeps what it read; "Load the whole list" brings the rest                                                                                                                   |
| `grok-current`      | Grok chats; uploads and a generated image from assets.grok.com byte for byte                                                                                                                            |

The Claude stand has no sandbox or timeline stream: chats whose files are only in the sandbox are covered by unit tests on recorded responses.
