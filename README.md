<div align="center">

# Command Snippets

**Stop retyping the same commands. Save them once, run them with one click.**

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/aftandilmmd.command-snippets?color=0F172A&label=marketplace)](https://marketplace.visualstudio.com/items?itemName=aftandilmmd.command-snippets)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/aftandilmmd.command-snippets?color=0F172A)](https://marketplace.visualstudio.com/items?itemName=aftandilmmd.command-snippets)
[![License](https://img.shields.io/badge/license-MIT-0F172A)](LICENSE)

</div>

---

That deploy command with four flags. The one docker incantation that actually works. The test
filter you rebuild from memory every single time.

Put them in the sidebar. Hit ▶.

## What you get

**One click to run.** Every snippet runs in a dedicated terminal that gets reused, not respawned.
Close it and the next run brings it back.

**Groups that make sense.** Build, deploy, database — collapsible sections, drag a snippet to
another group from the row. Delete a group and your snippets survive as *Ungrouped*.

**Find it instantly.** Live search across name, command and description. Sort by name, newest,
recently edited or recently run.

**Never lose a command again.** Everything you run lands in **History** with a relative timestamp.
Re-run it, or save that ad-hoc one-liner as a proper snippet.

**Keyboard first.** `Cmd+Alt+R` / `Ctrl+Alt+R` opens a QuickPick of every snippet, most recently
used first.

**Share with your team.** Project snippets live in `.vscode/command-snippets.json`. Commit it and
your teammates get the same commands on clone.

**Your AI agent can manage them.** Ships with an MCP server — see below.

## Quick start

1. Click the terminal icon in the Activity Bar.
2. **＋ → New snippet**, paste your command, save.
3. Hover the row and hit ▶. That's it.

## Let your AI agent handle it

> *"add a snippet for running the e2e tests against staging"*

Command Snippets bundles an MCP server, so Claude Code, Cursor, Claude Desktop or any MCP client
can list, create, edit, group and delete your snippets — and the sidebar updates the moment they
do.

Setup is one command, no paths to find: Command Palette → **Command Snippets: Set Up AI Client
(MCP)…** → pick your client. It writes the entry into Cursor, Claude Desktop or Windsurf for you,
or runs the `claude` CLI for Claude Code.

Doing it by hand is one line too:

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

In VS Code itself there is nothing to configure at all: Copilot agent mode picks up
`#commandSnippets`, `#newCommandSnippet`, `#updateCommandSnippet` and `#deleteCommandSnippet`
automatically.

### About letting a model touch your terminal

Writing snippets is harmless. Running them is not, so that half is locked down:

- `run_snippet` **does not exist** unless you flip `commandSnippets.mcp.allowRun` on *and* VS Code
  is open. An agent cannot call a tool it never sees.
- No tool anywhere accepts a free-form command string — only the id of a snippet **you** already
  saved. Prompt injection has nothing to execute.
- Every run still asks you first, showing the exact command. Say no and the agent is told.

## Your data stays yours

Plain JSON, on your disk, editable by hand:

| File | What's in it |
| --- | --- |
| `~/.command-snippets/data.json` | Your global snippets, groups and history |
| `<project>/.vscode/command-snippets.json` | Project snippets — commit them, share them |

Both files are watched, so an edit in your editor (or by an agent, or from `git pull`) shows up in
the sidebar immediately. Export and import as JSON any time.

## Commands & settings

| Command | Keybinding |
| --- | --- |
| Run Snippet | `Cmd+Alt+R` / `Ctrl+Alt+R` |
| New Snippet · New Group · Refresh | — |
| Export Data… · Import Data… · Open Data File | — |
| Set Up AI Client (MCP)… · Copy MCP Server Config | — |

| Setting | Default | |
| --- | --- | --- |
| `commandSnippets.workspaceFile.enabled` | `true` | Keep project snippets in `.vscode/command-snippets.json` |
| `commandSnippets.mcp.allowRun` | `false` | Let an agent *ask* to run a snippet (you still confirm) |

## Contributing

```bash
npm install
npm run watch     # rebuild on change
npm test          # unit + MCP integration tests
npm run package   # typecheck + production bundle
```

Then press <kbd>F5</kbd> for an Extension Development Host.

| Path | |
| --- | --- |
| `src/store.ts` | State, dual-source routing, sort/filter/move logic |
| `src/storage/` | Atomic JSON files + one-time migration |
| `src/snippetsViewProvider.ts` | Webview view and its typed message bridge |
| `src/mcp/server.ts` | The bundled stdio MCP server |
| `src/runRequests.ts` | VS Code side of the agent run handshake |
| `media/` | Webview JS/CSS — no frameworks, themed with `--vscode-*` variables |

Issues and PRs welcome: [github.com/aftandilmmd/vscode-command-snippets](https://github.com/aftandilmmd/vscode-command-snippets)

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

MIT
