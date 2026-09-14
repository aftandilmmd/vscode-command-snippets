import { Store } from './store';
import { TerminalManager } from './terminal';

/** Runs snippets in the dedicated terminal and records them in history. */
export class SnippetRunner {
  constructor(private readonly store: Store, private readonly terminals: TerminalManager) {}

  async runSnippet(id: string): Promise<boolean> {
    const snippet = this.store.getSnippet(id);
    if (!snippet) {
      return false;
    }
    this.terminals.run(snippet.command);
    await this.store.addHistory({ id: snippet.id, name: snippet.name, command: snippet.command });
    return true;
  }

  /** Runs a command that is not (or no longer) backed by a snippet, e.g. a history re-run. */
  async runAdHoc(name: string, command: string): Promise<void> {
    this.terminals.run(command);
    await this.store.addHistory({ name: name === '' ? command : name, command });
  }
}
