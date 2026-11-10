import { CodedError } from '../shared/errors';
import { HttpError, type FetchLike } from '../util/http';

/**
 * Obsidian's Local REST API plugin (github.com/coddingtonbear/obsidian-local-rest-api),
 * as far as writing a chat into a vault needs it. Paths are relative to the vault
 * root. The key goes only to the address the user typed.
 */
export class ObsidianRest {
  private readonly base: string;

  constructor(
    url: string,
    private readonly key: string,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.base = url.trim().replace(/\/+$/, '');
  }

  /** `/vault/<path>` with each segment encoded on its own, as the plugin wants. */
  private vaultUrl(path: string): string {
    return `${this.base}/vault/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  /**
   * A request with the key. No answer at all means Obsidian is closed, the plugin
   * is off, or Chrome refused its certificate (it comes from the plugin's own
   * authority); a 401 means the key is wrong.
   */
  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${this.key}`,
        },
      });
    } catch (error) {
      throw new CodedError(
        'obsidian-offline',
        `No answer from ${this.base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401) {
      throw new CodedError('obsidian-key', `The Local REST API refused the key (${this.base})`);
    }
    return response;
  }

  /** Throws unless the plugin answers and takes the key. */
  async check(): Promise<void> {
    const response = await this.call(`${this.base}/`);
    if (!response.ok) throw new HttpError(response.status, this.base);
    const body = (await response.json().catch(() => null)) as { authenticated?: unknown } | null;
    if (body?.authenticated !== true) {
      throw new CodedError('obsidian-key', `The Local REST API refused the key (${this.base})`);
    }
  }

  /** A text file of the vault; null when it is not there. */
  async readText(path: string): Promise<string | null> {
    const response = await this.call(this.vaultUrl(path), {
      headers: { accept: 'text/markdown' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new HttpError(response.status, this.vaultUrl(path));
    return response.text();
  }

  /**
   * The vault's `.obsidian/app.json`. The plugin refuses its configuration folder
   * (403) unless the user allowed it; then the extension's own settings stand in.
   */
  async readConfig(): Promise<string | null> {
    try {
      return await this.readText('.obsidian/app.json');
    } catch (error) {
      if (error instanceof HttpError) return null;
      throw error;
    }
  }

  /** Creates or replaces a file; any bytes. */
  async write(path: string, body: Blob): Promise<void> {
    const response = await this.call(this.vaultUrl(path), {
      method: 'PUT',
      headers: { 'content-type': body.type || 'application/octet-stream' },
      body,
    });
    if (!response.ok) throw new HttpError(response.status, this.vaultUrl(path));
  }

  /** Deletes a file (into Obsidian's trash, as the user's settings say); a missing one is fine. */
  async remove(path: string): Promise<void> {
    const response = await this.call(this.vaultUrl(path), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new HttpError(response.status, this.vaultUrl(path));
    }
  }

  /** Shows a note in Obsidian. */
  async open(path: string): Promise<void> {
    const url = `${this.base}/open/${path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await this.call(url, { method: 'POST' });
    if (!response.ok) throw new HttpError(response.status, url);
  }
}

/** The host permission an address needs: the port is not part of a match pattern. */
export function originPattern(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url.trim());
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return `${protocol}//${hostname}/*`;
  } catch {
    return null;
  }
}
