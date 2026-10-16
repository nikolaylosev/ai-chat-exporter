import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json' with { type: 'json' };

const icons = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

// Permissions are added phase by phase, only when code starts using them.
// Each one is justified in README.md.
export default defineManifest({
  manifest_version: 3,
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  default_locale: 'en',
  version: pkg.version,
  icons,
  action: {
    default_popup: 'src/ui/popup/index.html',
    default_icon: icons,
  },
  options_ui: {
    page: 'src/ui/options/index.html',
    open_in_tab: true,
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: [
    'downloads',
    'storage',
    'offscreen',
    'activeTab',
    'scripting',
    'notifications',
    // The popup copies a chat's Markdown once the chat is read, which can outlast the click.
    'clipboardWrite',
  ],
  // Gemini files come from Google's content hosts, Grok files from assets.grok.com;
  // they are fetched there only when saving into a chosen folder or a ZIP
  // (chrome.downloads needs no permission).
  host_permissions: [
    'https://claude.ai/*',
    'https://gemini.google.com/*',
    'https://lh3.googleusercontent.com/*',
    // lh3.googleusercontent.com redirects some images here (`/rd-gg/…`).
    'https://lh3.google.com/*',
    'https://contribution.usercontent.google.com/*',
    // Gemini's scripts, read only to find its search query again if it is renamed.
    'https://www.gstatic.com/*',
    'https://gemini.gstatic.com/*',
    'https://grok.com/*',
    'https://assets.grok.com/*',
    // ChatGPT's signed file links are on chatgpt.com itself.
    'https://chatgpt.com/*',
  ],
  content_scripts: [
    {
      matches: ['https://claude.ai/*'],
      js: ['src/content/claude.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://gemini.google.com/*'],
      js: ['src/content/gemini.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://grok.com/*'],
      js: ['src/content/grok.ts'],
      run_at: 'document_idle',
    },
    {
      matches: ['https://chatgpt.com/*'],
      js: ['src/content/chatgpt.ts'],
      run_at: 'document_idle',
    },
  ],
  commands: {
    'export-current-chat': {
      suggested_key: { default: 'Alt+Shift+S', mac: 'Alt+Shift+S' },
      description: '__MSG_commandExportCurrent__',
    },
  },
  minimum_chrome_version: '120',
});
