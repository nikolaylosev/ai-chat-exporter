export type FileSource =
  /** Downloaded by the browser with the user's cookies. */
  | { kind: 'url'; url: string }
  /** Only usable inside one context; a Blob never crosses extension messaging. */
  | { kind: 'blob'; blob: Blob }
  | { kind: 'text'; text: string; mime: string };

/**
 * A destination for exported files. Sinks know nothing about platforms.
 * Paths are relative to the sink's root, use `/`, and are already sanitized.
 */
export interface ExportSink {
  readonly id: string;
  writeText(path: string, content: string): Promise<void>;
  writeFile(path: string, source: FileSource): Promise<void>;
}
