import * as vscode from 'vscode';
import { SnippetRunner } from './runner';
import { SnippetsViewProvider } from './snippetsViewProvider';
import { Store, normalize } from './store';
import { TerminalManager } from './terminal';

export function activate(context: vscode.ExtensionContext): void {
  const store = new Store(context.globalState);
  const terminals = new TerminalManager();
  const runner = new SnippetRunner(store, terminals);
  const provider = new SnippetsViewProvider(context, store, runner);

  context.subscriptions.push(
    store,
    terminals,
    provider,
    vscode.window.registerWebviewViewProvider(SnippetsViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('commandSnippets.run', () => quickPickRun(store, runner)),
    vscode.commands.registerCommand('commandSnippets.newSnippet', () => provider.focusNewSnippet()),
    vscode.commands.registerCommand('commandSnippets.newGroup', () => provider.focusNewGroup()),
    vscode.commands.registerCommand('commandSnippets.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('commandSnippets.export', () => exportData(store)),
    vscode.commands.registerCommand('commandSnippets.import', () => importData(store))
  );
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

interface SnippetPick extends vscode.QuickPickItem {
  snippetId: string;
}

async function quickPickRun(store: Store, runner: SnippetRunner): Promise<void> {
  const { snippets, groups } = store.getData();
  if (snippets.length === 0) {
    void vscode.window.showInformationMessage('No snippets yet. Create one from the Command Snippets sidebar.');
    return;
  }
  const groupName = (id: string | undefined): string =>
    groups.find((group) => group.id === id)?.name ?? 'Ungrouped';

  const items: SnippetPick[] = snippets
    .slice()
    .sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.name.localeCompare(b.name))
    .map((snippet) => ({
      label: snippet.name,
      description: snippet.command,
      detail: snippet.description ? `${groupName(snippet.groupId)} — ${snippet.description}` : groupName(snippet.groupId),
      snippetId: snippet.id
    }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Run Command Snippet',
    placeHolder: 'Pick a snippet to run in the terminal',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (picked) {
    await runner.runSnippet(picked.snippetId);
  }
}

async function exportData(store: Store): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    title: 'Export Command Snippets',
    saveLabel: 'Export',
    filters: { JSON: ['json'] },
    defaultUri: vscode.Uri.file('command-snippets.json')
  });
  if (!target) {
    return;
  }
  const json = JSON.stringify(store.exportData(), null, 2);
  await vscode.workspace.fs.writeFile(target, Buffer.from(json, 'utf8'));
  void vscode.window.showInformationMessage(`Exported ${store.getData().snippets.length} snippets.`);
}

async function importData(store: Store): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Import Command Snippets',
    openLabel: 'Import',
    canSelectMany: false,
    filters: { JSON: ['json'] }
  });
  const file = picked?.[0];
  if (!file) {
    return;
  }

  let incoming;
  try {
    const bytes = await vscode.workspace.fs.readFile(file);
    incoming = normalize(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not read that file: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  if (incoming.snippets.length === 0 && incoming.groups.length === 0) {
    void vscode.window.showWarningMessage('That file contains no snippets or groups.');
    return;
  }

  let overwrite = false;
  const conflicts = store.findConflicts(incoming);
  if (conflicts.snippets > 0 || conflicts.groups > 0) {
    const answer = await vscode.window.showWarningMessage(
      `${conflicts.snippets} snippet(s) and ${conflicts.groups} group(s) already exist with the same id. Overwrite them?`,
      { modal: true },
      'Overwrite',
      'Keep Existing'
    );
    if (answer === undefined) {
      return;
    }
    overwrite = answer === 'Overwrite';
  }

  await store.importData(incoming, overwrite);
  void vscode.window.showInformationMessage(
    `Imported ${incoming.snippets.length} snippet(s) and ${incoming.groups.length} group(s).`
  );
}
