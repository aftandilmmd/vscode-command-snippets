import * as vscode from 'vscode';

export const MCP_PROVIDER_ID = 'commandSnippets.mcp';

/**
 * Tells VS Code about the MCP server bundled with this extension, so Copilot picks it up
 * without the user writing any config. Other clients (Claude Code, Cursor, …) still use
 * `Command Snippets: Copy MCP Server Config`.
 */
export function registerMcpServerProvider(context: vscode.ExtensionContext): vscode.Disposable | undefined {
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
    return undefined;
  }

  const serverPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.js').fsPath;
  const version = String(context.extension.packageJSON.version ?? '0.0.0');

  return vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    provideMcpServerDefinitions() {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const definition = new vscode.McpStdioServerDefinition(
        'Command Snippets',
        // The editor's own Node, so the server does not depend on what is on PATH.
        process.execPath,
        [serverPath],
        {},
        version
      );
      // Lets the server find this project's .vscode/command-snippets.json.
      definition.cwd = folder?.uri;
      return [definition];
    }
  });
}
