import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * One-click MCP setup.
 *
 * The point is that nobody has to hunt for an extension path: the server is published to npm, so
 * every client gets the same short, version-independent command, and for the file-based clients we
 * merge it into their config ourselves.
 */

const SERVER_KEY = 'command-snippets';
const NPX_ENTRY = { command: 'npx', args: ['-y', 'command-snippets-mcp'] } as const;

interface ClientTarget {
  label: string;
  detail: string;
  /** Config file to merge into, or `undefined` when the client is set up through its CLI. */
  configPath?: string;
  cli?: string;
}

function claudeDesktopConfig(): string | undefined {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return process.env['APPDATA']
        ? path.join(process.env['APPDATA'], 'Claude', 'claude_desktop_config.json')
        : undefined;
    default:
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

function targets(): ClientTarget[] {
  const home = os.homedir();
  const list: ClientTarget[] = [
    {
      label: '$(terminal) Claude Code',
      detail: 'Runs the official claude CLI in a terminal',
      cli: `claude mcp add ${SERVER_KEY} -- ${NPX_ENTRY.command} ${NPX_ENTRY.args.join(' ')}`
    },
    {
      label: '$(edit) Cursor',
      detail: path.join(home, '.cursor', 'mcp.json'),
      configPath: path.join(home, '.cursor', 'mcp.json')
    },
    {
      label: '$(comment-discussion) Claude Desktop',
      detail: claudeDesktopConfig() ?? 'Not available on this platform',
      configPath: claudeDesktopConfig()
    },
    {
      label: '$(wind) Windsurf',
      detail: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json')
    },
    {
      label: '$(clippy) Copy the config to the clipboard',
      detail: 'For any other MCP client'
    }
  ];
  return list.filter((target) => target.detail !== 'Not available on this platform');
}

async function readJsonFile(uri: vscode.Uri): Promise<Record<string, unknown>> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8').trim();
    if (text === '') {
      return {};
    }
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Merges our entry into a client config without disturbing the servers already in it. */
async function writeClientConfig(configPath: string): Promise<'added' | 'updated'> {
  const uri = vscode.Uri.file(configPath);
  const config = await readJsonFile(uri);
  const servers =
    typeof config['mcpServers'] === 'object' && config['mcpServers'] !== null
      ? (config['mcpServers'] as Record<string, unknown>)
      : {};
  const existed = SERVER_KEY in servers;

  servers[SERVER_KEY] = { command: NPX_ENTRY.command, args: [...NPX_ENTRY.args] };
  config['mcpServers'] = servers;

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(configPath)));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));
  return existed ? 'updated' : 'added';
}

export async function setUpMcpClient(): Promise<void> {
  const picked = await vscode.window.showQuickPick(targets(), {
    title: 'Set up Command Snippets for an AI client',
    placeHolder: 'Pick the client you use — VS Code Copilot needs no setup'
  });
  if (!picked) {
    return;
  }

  if (picked.cli) {
    const terminal = vscode.window.createTerminal({ name: 'Command Snippets setup' });
    terminal.show(true);
    terminal.sendText(picked.cli, true);
    return;
  }

  if (!picked.configPath) {
    await vscode.env.clipboard.writeText(
      JSON.stringify({ mcpServers: { [SERVER_KEY]: { ...NPX_ENTRY, args: [...NPX_ENTRY.args] } } }, null, 2)
    );
    void vscode.window.showInformationMessage('MCP config copied to the clipboard.');
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Add Command Snippets to ${picked.label.replace(/^\$\([^)]+\)\s*/, '')}?`,
    { modal: true, detail: `This edits ${picked.configPath}. Other servers in that file are left alone.` },
    'Add'
  );
  if (confirmed !== 'Add') {
    return;
  }

  try {
    const outcome = await writeClientConfig(picked.configPath);
    const answer = await vscode.window.showInformationMessage(
      outcome === 'added'
        ? 'Command Snippets added. Restart the client to pick it up.'
        : 'Command Snippets entry updated. Restart the client to pick it up.',
      'Open config'
    );
    if (answer === 'Open config') {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.configPath));
      await vscode.window.showTextDocument(document);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not write ${picked.configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** The config we hand out, for the plain "copy" command. */
export function mcpConfigJson(): string {
  return JSON.stringify(
    { mcpServers: { [SERVER_KEY]: { command: NPX_ENTRY.command, args: [...NPX_ENTRY.args] } } },
    null,
    2
  );
}
