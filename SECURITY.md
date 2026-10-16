# Security policy

The extension runs with your signed-in sessions on claude.ai, gemini.google.com, grok.com and chatgpt.com, so a flaw in it could expose your conversations. Please report one privately.

## Reporting a vulnerability

Use [Report a vulnerability](https://github.com/nikolaylosev/ai-chat-exporter/security/advisories/new) on the Security tab. Do not open a public issue for it.

Please include:

- the version of the extension (see `chrome://extensions`) and of Chrome;
- what an attacker could do, and the steps to reproduce it.

Do not send real conversation content, access tokens or cookies; a description or a made-up example is enough.

## Supported versions

Only the latest release is fixed. Install updates from the [Releases](https://github.com/nikolaylosev/ai-chat-exporter/releases) page.

## Scope

In scope: the extension's code in this repository, for example a request to a host outside its permissions, data sent anywhere other than your own disk, or a page being able to talk to the extension.

Out of scope: the AI services themselves, and changes on their side that stop the extension from working (report those as an ordinary bug).
