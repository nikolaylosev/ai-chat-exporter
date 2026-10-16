export type Platform = 'claude' | 'gemini' | 'grok' | 'chatgpt';

export const PLATFORM_LABEL: Record<Platform, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  grok: 'Grok',
  chatgpt: 'ChatGPT',
};

const PLATFORM_HOSTS: Record<string, Platform> = {
  'claude.ai': 'claude',
  'gemini.google.com': 'gemini',
  'grok.com': 'grok',
  'chatgpt.com': 'chatgpt',
};

export function detectPlatform(url: string | undefined): Platform | null {
  if (!url) return null;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return null;
    return PLATFORM_HOSTS[hostname] ?? null;
  } catch {
    return null;
  }
}
