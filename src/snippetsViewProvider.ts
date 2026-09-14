import * as vscode from 'vscode';
import { DEFAULT_UI, HostMessage, UiState, parseWebviewMessage } from './messages';
import { SnippetRunner } from './runner';
import { Store } from './store';

const UI_STATE_KEY = 'commandSnippets.ui.v1';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class SnippetsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'commandSnippets.view';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly runner: SnippetRunner
  ) {
    this.disposables.push(this.store.onDidChange(() => this.postState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage(
      (raw: unknown) => void this.handleMessage(raw),
      undefined,
      this.disposables
    );

    view.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables
    );
  }

  /** Reveals the view and asks the webview to open the "new snippet" form. */
  async focusNewSnippet(): Promise<void> {
    await this.reveal();
    this.post({ type: 'focusNewSnippet' });
  }

  async focusNewGroup(): Promise<void> {
    await this.reveal();
    this.post({ type: 'focusNewGroup' });
  }

  refresh(): void {
    this.postState();
  }

  private async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    await vscode.commands.executeCommand('commandSnippets.view.focus');
  }

  private getUi(): UiState {
    return this.context.globalState.get<UiState>(UI_STATE_KEY) ?? DEFAULT_UI;
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private postState(): void {
    this.post({
      type: 'state',
      data: this.store.getData(),
      ui: this.getUi(),
      hasWorkspace: this.store.hasWorkspace
    });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      return;
    }

    switch (message.type) {
      case 'ready':
        this.postState();
        return;

      case 'run': {
        const ok = await this.runner.runSnippet(message.snippetId);
        if (!ok) {
          void vscode.window.showWarningMessage('That snippet no longer exists.');
        }
        return;
      }

      case 'runCommand':
        await this.runner.runAdHoc(message.snippetName, message.command);
        return;

      case 'createSnippet':
        await this.store.addSnippet({
          name: message.name,
          command: message.command,
          description: message.description,
          groupId: message.groupId || undefined,
          source: message.source
        });
        return;

      case 'updateSnippet':
        await this.store.updateSnippet(message.id, {
          name: message.name,
          command: message.command,
          description: message.description,
          groupId: message.groupId,
          source: message.source
        });
        return;

      case 'deleteSnippet': {
        const snippet = this.store.getSnippet(message.id);
        if (!snippet) {
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          `Delete snippet "${snippet.name}"?`,
          { modal: true },
          'Delete'
        );
        if (answer === 'Delete') {
          await this.store.deleteSnippet(message.id);
        }
        return;
      }

      case 'moveSnippet':
        await this.store.moveSnippet(message.id, message.groupId || undefined);
        return;

      case 'createGroup':
        await this.store.addGroup(message.name, message.source);
        return;

      case 'renameGroup':
        await this.store.renameGroup(message.id, message.name);
        return;

      case 'deleteGroup': {
        const group = this.store.getGroup(message.id);
        if (!group) {
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          `Delete group "${group.name}"? Its snippets move to Ungrouped.`,
          { modal: true },
          'Delete Group'
        );
        if (answer === 'Delete Group') {
          await this.store.deleteGroup(message.id);
        }
        return;
      }

      case 'saveHistoryEntry': {
        const entry = this.store.getData().history.find((item) => item.id === message.historyId);
        if (!entry) {
          return;
        }
        const name = await vscode.window.showInputBox({
          title: 'Save as snippet',
          prompt: 'Name for the new snippet',
          value: entry.snippetName
        });
        if (name === undefined) {
          return;
        }
        await this.store.addSnippet({ name, command: entry.command });
        void vscode.window.showInformationMessage(`Saved snippet "${name || entry.command}".`);
        return;
      }

      case 'clearHistory': {
        const answer = await vscode.window.showWarningMessage(
          'Clear the whole run history?',
          { modal: true },
          'Clear History'
        );
        if (answer === 'Clear History') {
          await this.store.clearHistory();
        }
        return;
      }

      case 'copyCommand':
        await vscode.env.clipboard.writeText(message.command);
        void vscode.window.setStatusBarMessage('Command Snippets: command copied', 2000);
        return;

      case 'persistUi':
        await this.context.globalState.update(UI_STATE_KEY, {
          query: message.query,
          sort: message.sort,
          tab: message.tab,
          collapsed: message.collapsed
        } satisfies UiState);
        return;
    }
  }

  private render(webview: vscode.Webview): string {
    const media = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));

    const scriptUri = media('main.js');
    const styleUri = media('main.css');
    const codiconUri = media('codicon.css');
    const csp = nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${csp}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Command Snippets</title>
</head>
<body>
  <div class="tabs" role="tablist">
    <button class="tab" id="tab-snippets" role="tab" data-tab="snippets">
      <span class="codicon codicon-symbol-snippet"></span> Snippets
    </button>
    <button class="tab" id="tab-history" role="tab" data-tab="history">
      <span class="codicon codicon-history"></span> History
    </button>
  </div>

  <section id="panel-snippets" class="panel">
    <div class="toolbar">
      <div class="search">
        <span class="codicon codicon-search"></span>
        <input id="search" type="search" placeholder="Search snippets" aria-label="Search snippets" />
      </div>
      <select id="sort" aria-label="Sort snippets">
        <option value="name-asc">Name A–Z</option>
        <option value="name-desc">Name Z–A</option>
        <option value="created">Newest created</option>
        <option value="updated">Last updated</option>
        <option value="lastRun">Last run</option>
      </select>
      <div class="new-menu">
        <button id="new-toggle" class="btn primary" aria-haspopup="true" aria-expanded="false" title="New">
          <span class="codicon codicon-add"></span>
          <span class="codicon codicon-chevron-down"></span>
        </button>
        <div id="new-dropdown" class="dropdown" role="menu" hidden>
          <button type="button" id="new-snippet" class="dropdown-item" role="menuitem">
            <span class="codicon codicon-add"></span> New snippet
          </button>
          <button type="button" id="new-group" class="dropdown-item" role="menuitem">
            <span class="codicon codicon-new-folder"></span> New group
          </button>
        </div>
      </div>
    </div>

    <form id="snippet-form" class="form" hidden>
      <h3 id="form-title">New snippet</h3>
      <input type="hidden" id="form-id" />
      <label for="form-name">Name</label>
      <input id="form-name" type="text" placeholder="Run tests" />
      <label for="form-command">Command</label>
      <textarea id="form-command" rows="2" placeholder="npm test" required></textarea>
      <label for="form-description">Description</label>
      <input id="form-description" type="text" placeholder="Optional" />
      <label for="form-scope" id="form-scope-label">Scope</label>
      <select id="form-scope">
        <option value="global">Global (all projects)</option>
        <option value="workspace">This project</option>
      </select>
      <label for="form-group">Group</label>
      <select id="form-group"></select>
      <div class="form-actions">
        <button type="submit" class="btn primary">Save</button>
        <button type="button" id="form-cancel" class="btn">Cancel</button>
      </div>
    </form>

    <form id="group-form" class="form" hidden>
      <h3>New group</h3>
      <label for="group-name">Group name</label>
      <input id="group-name" type="text" placeholder="Build" required />
      <label for="group-scope" id="group-scope-label">Scope</label>
      <select id="group-scope">
        <option value="global">Global (all projects)</option>
        <option value="workspace">This project</option>
      </select>
      <div class="form-actions">
        <button type="submit" class="btn primary">Create</button>
        <button type="button" id="group-cancel" class="btn">Cancel</button>
      </div>
    </form>

    <div id="snippet-list" class="list"></div>
  </section>

  <section id="panel-history" class="panel" hidden>
    <div class="toolbar">
      <button id="clear-history" class="btn"><span class="codicon codicon-trash"></span> Clear history</button>
    </div>
    <div id="history-list" class="list"></div>
  </section>

  <script nonce="${csp}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
