# Privacy policy

CodingCat AI Chat Exporter is a Chrome extension that saves your conversations from claude.ai, gemini.google.com, grok.com and chatgpt.com to your own computer. This policy says what it does with your data. In short: everything stays on your computer.

## What the extension reads

When you ask it to export, the extension reads, from the service you are signed in to:

- your conversations: messages, their dates, the model's answers, thinking, searches and tool calls;
- the files in them: your uploads, files the model created, images;
- your projects (Gemini notebooks): their names, instructions, files and chats;
- the list of your conversations and projects, to show them on the export page.

It reads them through your existing session on that service, with the same requests the service's own web page makes. It does not ask for, read or store your passwords. The access token some services require is kept in memory only while the extension works, and is never saved or logged.

## Where your data goes

- **Only to your computer.** Notes and files are saved into your Downloads folder, into a folder you choose, or into a .zip archive there. With **Copy**, the note goes to your clipboard.
- **Nowhere else.** The extension has no server. It does not send your conversations, files, account details or anything about how you use it to the developer or to anyone else. There is no analytics, tracking or advertising.
- The extension talks only to the services above, their file hosts (lh3.googleusercontent.com, lh3.google.com, contribution.usercontent.google.com, assets.grok.com) and Gemini's script hosts (www.gstatic.com, gemini.gstatic.com, read as text only), all listed in its permissions.

## What the extension stores in Chrome

In Chrome's extension storage, on your computer only:

- your settings;
- the state of a running export, so it can continue after Chrome restarts its background process;
- a record of what was exported (chat ids, update times, folder and file names), to skip unchanged chats and to tidy a chat's folder when it is saved again;
- for Gemini, the chats found by search, to show them again on your next visit.

If you save into a folder you chose, the extension keeps Chrome's handle to that folder, so it can write there again; Chrome asks you before it does. You can clear the record in the extension's settings, and uninstalling the extension removes all of it.

## Sharing and sale

Your data is not sold, not shared, not used for advertising or credit decisions, and not used for anything except the export you asked for.

## Changes and contact

Changes to this policy are published in this file, in the extension's [repository](https://github.com/nikolaylosev/ai-chat-exporter). Questions: open an [issue](https://github.com/nikolaylosev/ai-chat-exporter/issues), or report a security problem privately through the repository's Security tab.
