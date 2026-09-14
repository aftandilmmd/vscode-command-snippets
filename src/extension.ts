import * as path from 'path';
import * as vscode from 'vscode';
import { SnippetRunner } from './runner';
import { SnippetsViewProvider } from './snippetsViewProvider';
import { FileStorage, globalDataPath, workspaceDataPath } from './storage/fileStorage';
import { migrateFromGlobalState } from './storage/migrate';
import { registerLanguageModelTools } from './lmTools';
import { registerMcpServerProvider } from './mcpProvider';
import { mcpConfigJson, setUpMcpClient } from './mcpSetup';
import { RunRequestService } from './runRequests';
import { Store, normalize } from './store';
import { TerminalManager } from './terminal';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const globalDoc = new FileStorage(globalDataPath());
  const migration = await migrateFromGlobalState(context.globalState, globalDoc);

  let workspaceDoc = createWorkspaceDoc();
  const store = new Store(globalDoc, workspaceDoc);
  const terminals = new TerminalManager();
  const runner = new SnippetRunner(store, terminals);
  const provider = new SnippetsViewProvider(context, store, runner);
  const runRequests = new RunRequestService(store, runner, context.extension.packageJSON.version ?? '0.0.0');
  void runRequests.start();

  // External edits (a hand-edit, a git pull, or an AI agent writing the file) reload the store.
  const watchGlobal = watchFile(globalDoc, () => store.reload());
  let watchWorkspace = workspaceDoc ? watchFile(workspaceDoc, () => store.reload()) : undefined;

  const rewire = (): void => {
    watchWorkspace?.dispose();
    workspaceDoc = createWorkspaceDoc();
    store.setWorkspaceDoc(workspaceDoc);
    watchWorkspace = workspaceDoc ? watchFile(workspaceDoc, () => store.reload()) : undefined;
  };

  const mcpProvider = registerMcpServerProvider(context);
  if (mcpProvider) {
    context.subscriptions.push(mcpProvider);
  }
  context.subscriptions.push(...registerLanguageModelTools(store));

  context.subscriptions.push(
    store,
    terminals,
    provider,
    runRequests,
    watchGlobal,
    { dispose: () => watchWorkspace?.dispose() },
    { dispose: () => void globalDoc.flush() },
    vscode.workspace.onDidChangeWorkspaceFolders(rewire),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('commandSnippets.workspaceFile.enabled')) {
        rewire();
      }
    }),
    vscode.window.registerWebviewViewProvider(SnippetsViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('commandSnippets.run', () => quickPickRun(store, runner)),
    vscode.commands.registerCommand('commandSnippets.newSnippet', () => provider.focusNewSnippet()),
    vscode.commands.registerCommand('commandSnippets.newGroup', () => provider.focusNewGroup()),
    vscode.commands.registerCommand('commandSnippets.refresh', () => {
      store.reload();
      provider.refresh();
    }),
    vscode.commands.registerCommand('commandSnippets.export', () => exportData(store)),
    vscode.commands.registerCommand('commandSnippets.import', () => importData(store)),
    vscode.commands.registerCommand('commandSnippets.openDataFile', () => openDataFile(globalDoc.filePath)),
    vscode.commands.registerCommand('commandSnippets.setupMcp', () => setUpMcpClient()),
    vscode.commands.registerCommand('commandSnippets.copyMcpConfig', () => copyMcpConfig(context))
  );

  if (migration.migrated) {
    void vscode.window.showInformationMessage(
      `Command Snippets: moved ${migration.snippets} snippet(s) into ${tildify(globalDoc.filePath)}.`
    );
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}

/** The project document, when a folder is open and the feature is enabled. */
function createWorkspaceDoc(): FileStorage | undefined {
  const enabled = vscode.workspace
    .getConfiguration('commandSnippets')
    .get<boolean>('workspaceFile.enabled', true);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!enabled || !folder || folder.uri.scheme !== 'file') {
    return undefined;
  }
  return new FileStorage(workspaceDataPath(folder.uri.fsPath));
}

/** Watches one file, ignoring the events caused by our own writes. */
function watchFile(doc: FileStorage, onExternalChange: () => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(doc.filePath)), path.basename(doc.filePath))
  );
  const handle = async (uri: vscode.Uri): Promise<void> => {
    let text = '';
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      // Deleted — fall through and reload, which yields empty data for that document.
    }
    if (doc.isOwnWrite(text)) {
      return;
    }
    onExternalChange();
  };
  watcher.onDidChange((uri) => void handle(uri));
  watcher.onDidCreate((uri) => void handle(uri));
  watcher.onDidDelete(() => onExternalChange());
  return watcher;
}

function tildify(filePath: string): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  return home && filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

async function openDataFile(filePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document);
}

/** Hands the user a ready-to-paste MCP client config. */
async function copyMcpConfig(context: vscode.ExtensionContext): Promise<void> {
  await vscode.env.clipboard.writeText(mcpConfigJson());
  const answer = await vscode.window.showInformationMessage(
    'MCP config copied. It uses "npx -y command-snippets-mcp", so there is no path to keep in sync.',
    'Set up a client for me',
    'Copy bundled server path'
  );
  if (answer === 'Set up a client for me') {
    await setUpMcpClient();
    return;
  }
  if (answer === 'Copy bundled server path') {
    // Escape hatch for machines without npm access.
    const serverPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.js').fsPath;
    await vscode.env.clipboard.writeText(serverPath);
    void vscode.window.setStatusBarMessage('Command Snippets: server path copied', 2000);
  }
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
