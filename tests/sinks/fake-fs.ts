/** In-memory stand-in for FileSystemDirectoryHandle, enough for FolderWriter. */
export class FakeDirectory {
  readonly files = new Map<string, Blob>();
  readonly dirs = new Map<string, FakeDirectory>();
  permission: PermissionState = 'granted';
  /** Set to simulate a folder that was deleted or moved. */
  gone = false;

  constructor(readonly name: string) {}

  private check(): void {
    if (this.gone) throw new DOMException('gone', 'NotFoundError');
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    this.check();
    if (this.files.has(name)) throw new DOMException(name, 'TypeMismatchError');
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options.create) throw new DOMException(name, 'NotFoundError');
      dir = new FakeDirectory(name);
      this.dirs.set(name, dir);
    }
    return Promise.resolve(dir);
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}) {
    this.check();
    if (this.dirs.has(name)) throw new DOMException(name, 'TypeMismatchError');
    if (!this.files.has(name) && !options.create) throw new DOMException(name, 'NotFoundError');
    const files = this.files;
    return Promise.resolve({
      createWritable: () => {
        const parts: Blob[] = [];
        return Promise.resolve({
          write: (data: Blob) => Promise.resolve(void parts.push(data)),
          close: () => Promise.resolve(void files.set(name, new Blob(parts))),
          abort: () => Promise.resolve(),
        });
      },
    });
  }

  queryPermission() {
    return Promise.resolve(this.permission);
  }

  keys() {
    this.check();
    return [...this.files.keys(), ...this.dirs.keys()][Symbol.iterator]();
  }

  asHandle(): FileSystemDirectoryHandle {
    return this as unknown as FileSystemDirectoryHandle;
  }

  /** Text of a file at a `/`-separated path. */
  async read(path: string): Promise<string | undefined> {
    const segments = path.split('/');
    const name = segments.pop()!;
    const dir = segments.reduce<FakeDirectory | undefined>((d, seg) => d?.dirs.get(seg), this);
    return dir?.files.get(name)?.text();
  }
}
