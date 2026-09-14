# command-snippets-mcp

MCP server for the [Command Snippets](https://marketplace.visualstudio.com/items?itemName=aftandilmmd.command-snippets)
VS Code extension. It lets any MCP client manage your saved terminal commands.

```bash
claude mcp add command-snippets -- npx -y command-snippets-mcp
```

```jsonc
// Cursor: ~/.cursor/mcp.json — Claude Desktop: claude_desktop_config.json
{
  "mcpServers": {
    "command-snippets": { "command": "npx", "args": ["-y", "command-snippets-mcp"] }
  }
}
```

It reads and writes the same files the extension uses — `~/.command-snippets/data.json` and, for
project snippets, `.vscode/command-snippets.json` — so it works whether or not VS Code is running.
The extension is not required, but installing it gives you the sidebar for the same data.

## Tools

`list_snippets`, `get_snippet`, `create_snippet`, `update_snippet`, `delete_snippet`,
`move_snippet`, `list_groups`, `create_group`, `rename_group`, `delete_group`, `get_history`.
The `snippets://all` resource returns everything in one read.

## Running commands

`run_snippet` exists only when VS Code is running *and* `commandSnippets.mcp.allowRun` is enabled
in its settings. It accepts the id of a snippet you already saved — never a free-form command —
and every run must be confirmed in VS Code. Nothing here can execute an arbitrary command.

## Project file discovery

The project file is found from the working directory, or from `--workspace <dir>` /
`COMMAND_SNIPPETS_WORKSPACE`.

MIT
