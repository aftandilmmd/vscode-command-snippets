import * as vscode from 'vscode';

export const TERMINAL_NAME = 'Command Snippets';

/** Owns the single dedicated terminal the extension runs snippets in. */
export class TerminalManager implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === this.terminal) {
          // The user killed our terminal: forget it so the next run creates a new one.
          this.terminal = undefined;
        }
      })
    );
  }

  /** Reuses the dedicated terminal when it is still alive, otherwise creates it. */
  private resolveTerminal(): vscode.Terminal {
    if (this.terminal && this.terminal.exitStatus === undefined) {
      return this.terminal;
    }
    const existing = vscode.window.terminals.find(
      (candidate) => candidate.name === TERMINAL_NAME && candidate.exitStatus === undefined
    );
    this.terminal = existing ?? vscode.window.createTerminal({ name: TERMINAL_NAME });
    return this.terminal;
  }

  run(command: string): void {
    const terminal = this.resolveTerminal();
    terminal.show(true);
    terminal.sendText(command, true);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
