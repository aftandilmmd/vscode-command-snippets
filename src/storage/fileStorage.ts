import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocStorage } from '../store';
import { GLOBAL_DATA_FILE, GLOBAL_DIR_NAME, WORKSPACE_FILE_RELATIVE } from '../types';

/** `~/.command-snippets` */
export function globalDir(): string {
  return path.join(os.homedir(), GLOBAL_DIR_NAME);
}

/** `~/.command-snippets/data.json` */
export function globalDataPath(): string {
  return path.join(globalDir(), GLOBAL_DATA_FILE);
}

/** `<workspace>/.vscode/command-snippets.json` */
export function workspaceDataPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ...WORKSPACE_FILE_RELATIVE.split('/'));
}

/**
 * A JSON document on disk.
 *
 * Writes go to a temp file that is then renamed, so a reader never sees a half-written
 * file, and consecutive writes are coalesced. A file that fails to parse is moved aside
 * rather than overwritten, so a hand-edit typo never silently destroys data.
 */
export class FileStorage implements DocStorage {
  private pending: unknown;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  /** Serialised form of the last content we wrote ourselves, to ignore our own file events. */
  private lastWritten: string | undefined;

  constructor(readonly filePath: string, private readonly debounceMs = 200) {}

  load(): unknown {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return undefined;
    }
    if (text.trim() === '') {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.filePath, backup);
        console.error(`[Command Snippets] ${this.filePath} is not valid JSON; copied to ${backup}`);
      } catch (error) {
        console.error(`[Command Snippets] could not back up ${this.filePath}:`, error);
      }
      return undefined;
    }
  }

  async save(data: unknown): Promise<void> {
    this.pending = data;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.inFlight = new Promise<void>((resolve, reject) => {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.writeNow(this.pending).then(resolve, reject);
      }, this.debounceMs);
    });
    return this.inFlight;
  }

  /** Writes any debounced content immediately. Call before the extension shuts down. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.writeNow(this.pending);
      return;
    }
    await this.inFlight;
  }

  /** True when `text` is exactly what we last wrote — i.e. a file event we caused ourselves. */
  isOwnWrite(text: string): boolean {
    return this.lastWritten !== undefined && this.lastWritten === text;
  }

  private async writeNow(data: unknown): Promise<void> {
    const text = `${JSON.stringify(data, null, 2)}\n`;
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.tmp`);
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, this.filePath);
    this.lastWritten = text;
  }
}
