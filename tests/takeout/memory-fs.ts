/** An in-memory FileSystemDirectoryHandle: enough to read and write a saved archive. */
export class MemoryDir {
  readonly kind = 'directory';
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Map<string, MemoryDir>();

  constructor(readonly name: string) {}

  /** A file at a `/`-separated path, with its folders made as needed. */
  put(path: string, content: string | Uint8Array): this {
    const [first = '', ...rest] = path.split('/');
    if (!rest.length) {
      this.files.set(
        first,
        typeof content === 'string' ? new TextEncoder().encode(content) : content,
      );
    } else {
      let child = this.dirs.get(first);
      if (!child) this.dirs.set(first, (child = new MemoryDir(first)));
      child.put(rest.join('/'), content);
    }
    return this;
  }

  /** The text of a file at a path, or undefined. */
  read(path: string): string | undefined {
    const bytes = this.bytes(path);
    return bytes && new TextDecoder().decode(bytes);
  }

  bytes(path: string): Uint8Array | undefined {
    const [first = '', ...rest] = path.split('/');
    return rest.length ? this.dirs.get(first)?.bytes(rest.join('/')) : this.files.get(first);
  }

  /** Every file path under this folder. */
  paths(prefix = ''): string[] {
    return [
      ...[...this.files.keys()].map((n) => prefix + n),
      ...[...this.dirs].flatMap(([n, d]) => d.paths(`${prefix}${n}/`)),
    ];
  }

  private fileHandle(name: string) {
    const files = this.files;
    return {
      kind: 'file' as const,
      name,
      getFile: () => Promise.resolve(new File([files.get(name) as Uint8Array<ArrayBuffer>], name)),
      createWritable: () => {
        const parts: Uint8Array[] = [];
        return Promise.resolve({
          write: (data: Uint8Array | string) =>
            Promise.resolve(
              void parts.push(typeof data === 'string' ? new TextEncoder().encode(data) : data),
            ),
          close: () => {
            const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for (const p of parts) {
              all.set(p, at);
              at += p.length;
            }
            files.set(name, all);
            return Promise.resolve();
          },
        });
      },
    };
  }

  async *values() {
    for (const dir of [...this.dirs.values()]) yield await Promise.resolve(dir);
    for (const name of [...this.files.keys()]) yield this.fileHandle(name);
  }

  getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options.create) return Promise.reject(new DOMException(name, 'NotFoundError'));
      this.dirs.set(name, (dir = new MemoryDir(name)));
    }
    return Promise.resolve(dir);
  }

  getFileHandle(name: string, options: { create?: boolean } = {}) {
    if (!this.files.has(name)) {
      if (!options.create) return Promise.reject(new DOMException(name, 'NotFoundError'));
      this.files.set(name, new Uint8Array(0));
    }
    return Promise.resolve(this.fileHandle(name));
  }

  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }
}
