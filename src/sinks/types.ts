export type FileSource =
  /**
   * Downloaded by the browser with the user's cookies. `forNote`: an image the
   * Word note embeds; the offscreen document keeps it until the note is written.
   */
  | { kind: 'url'; url: string; forNote?: boolean }
  /** Only usable inside one context; a Blob never crosses extension messaging. */
  | { kind: 'blob'; blob: Blob }
  | { kind: 'text'; text: string; mime: string }
  /** A Word note, made from its Markdown where its images are (render/docx.ts). */
  | { kind: 'docx'; markdown: string; title: string };

/**
 * A destination for exported files. Sinks know nothing about platforms.
 * Paths are relative to the sink's root, use `/`, and are already sanitized.
 */
export interface ExportSink {
  readonly id: string;
  writeText(path: string, content: string): Promise<void>;
  writeFile(path: string, source: FileSource): Promise<void>;
}

/** The type of a note or report the sinks write as text, by its extension. */
export function textMime(path: string): string {
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.json')) return 'application/json';
  return 'text/markdown';
}
