import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runsDir, runtimePath } from './mcp/paths';
import {
  RUN_TTL_MS,
  RunRequest,
  clearRun,
  readJson,
  requestPath,
  sweepStaleRuns,
  writeRunResult
} from './mcp/runBridge';
import { RuntimeInfo } from './mcp/runtime';
import { SnippetRunner } from './runner';
import { Store } from './store';

const HEARTBEAT_MS = 10_000;

/**
 * The VS Code half of the MCP run handshake.
 *
 * It advertises the extension in `runtime.json` (the only thing that lets the MCP server
 * expose `run_snippet` at all), watches for run requests, and never runs anything without
 * an explicit confirmation from the user.
 */
export class RunRequestService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly handled = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly runner: SnippetRunner,
    private readonly version: string
  ) {}

  async start(): Promise<void> {
    await fs.promises.mkdir(runsDir(), { recursive: true });
    await sweepStaleRuns();
    await this.writeRuntime();

    this.heartbeat = setInterval(() => void this.writeRuntime(), HEARTBEAT_MS);
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('commandSnippets.mcp.allowRun')) {
          void this.writeRuntime();
        }
      })
    );

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(runsDir()), '*.json')
    );
    watcher.onDidCreate((uri) => void this.handleFile(uri.fsPath));
    watcher.onDidChange((uri) => void this.handleFile(uri.fsPath));
    this.disposables.push(watcher);

    // Anything that landed while VS Code was starting up.
    await this.scan();
  }

  private get allowRun(): boolean {
    return vscode.workspace.getConfiguration('commandSnippets').get<boolean>('mcp.allowRun', false);
  }

  private async writeRuntime(): Promise<void> {
    const info: RuntimeInfo = {
      allowRun: this.allowRun,
      version: this.version,
      pid: process.pid,
      lastSeen: Date.now()
    };
    try {
      await fs.promises.mkdir(path.dirname(runtimePath()), { recursive: true });
      await fs.promises.writeFile(runtimePath(), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.error('[Command Snippets] could not write runtime.json:', error);
    }
  }

  private async scan(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(runsDir());
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.endsWith('.result.json') || !name.endsWith('.json')) {
        continue;
      }
      await this.handleFile(path.join(runsDir(), name));
    }
  }

  private async handleFile(filePath: string): Promise<void> {
    if (filePath.endsWith('.result.json')) {
      return;
    }
    const request = readJson<RunRequest>(filePath);
    if (!request || typeof request.id !== 'string' || typeof request.snippetId !== 'string') {
      return;
    }
    if (this.handled.has(request.id)) {
      return;
    }
    this.handled.add(request.id);

    // A request nobody answered in time is dead; do not surprise the user with an old prompt.
    if (Date.now() - request.requestedAt > RUN_TTL_MS) {
      await clearRun(request.id);
      return;
    }

    if (!this.allowRun) {
      await writeRunResult({
        id: request.id,
        status: 'denied',
        message: 'Agent runs are turned off (commandSnippets.mcp.allowRun).',
        at: Date.now()
      });
      return;
    }

    this.store.reload();
    const snippet = this.store.getSnippet(request.snippetId);
    if (!snippet) {
      await writeRunResult({
        id: request.id,
        status: 'error',
        message: `No snippet with id ${request.snippetId}.`,
        at: Date.now()
      });
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `An AI agent wants to run the snippet "${snippet.name}" in your terminal.`,
      { modal: true, detail: snippet.command },
      'Run'
    );

    if (answer !== 'Run') {
      await writeRunResult({
        id: request.id,
        status: 'denied',
        message: 'The user declined the run.',
        at: Date.now()
      });
      return;
    }

    const ran = await this.runner.runSnippet(snippet.id);
    await writeRunResult({
      id: request.id,
      status: ran ? 'ran' : 'error',
      message: ran ? undefined : 'The snippet could not be run.',
      at: Date.now()
    });
  }

  /** Convenience for tests and callers that want the request path. */
  static requestPathFor(id: string): string {
    return requestPath(id);
  }

  dispose(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    // Tell any MCP server that VS Code is gone, rather than letting it wait for a stale heartbeat.
    try {
      fs.rmSync(runtimePath(), { force: true });
    } catch {
      // Best effort during shutdown.
    }
  }
}
