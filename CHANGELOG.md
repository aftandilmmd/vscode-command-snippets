# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-14

First release.

### Added

- Sidebar panel with **Snippets** and **History** tabs, driven by a single webview view.
- Snippet management: create, edit, copy, delete (with confirmation) and run in a dedicated
  `Command Snippets` terminal that is reused when alive and recreated when closed.
- Groups as collapsible sections, with rename, delete (snippets move to *Ungrouped* rather than
  being deleted) and a per-row move picker.
- Live search across name, command and description, plus sorting by name, created date, last
  updated and last run.
- History of every run, newest first, with relative timestamps, re-run, save-as-snippet, copy and
  clear. Capped at 500 entries.
- `Command Snippets: Run Snippet` QuickPick, bound to `Ctrl+Alt+R` / `Cmd+Alt+R`.
- Export and import of the whole dataset as JSON; import merges by id and asks before overwriting.
- Storage in plain JSON files that can be edited by hand and are watched for external changes:
  `~/.command-snippets/data.json` globally and `.vscode/command-snippets.json` per project, so a
  team can commit its shared snippets. Data from earlier builds is migrated out of `globalState`
  automatically.
- A bundled stdio MCP server (`dist/mcp-server.js`) that lets Claude Code, Cursor, Claude Desktop
  and other MCP clients list, create, edit, group and delete snippets, plus a `snippets://all`
  resource. `Command Snippets: Copy MCP Server Config` puts a ready-made config on the clipboard.
- Language Model Tools and an MCP server definition provider, so Copilot agent mode can manage
  snippets inside VS Code without any configuration.

### Security

- Agents can never execute an arbitrary command. `run_snippet` is registered only while VS Code is
  running and `commandSnippets.mcp.allowRun` is enabled, it accepts nothing but the id of an
  existing snippet, and every run requires an explicit confirmation in VS Code.
- The webview runs under a strict CSP with a per-render nonce and renders all user content with
  `textContent`.

[Unreleased]: https://github.com/aftandilmmd/vscode-command-snippets/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aftandilmmd/vscode-command-snippets/releases/tag/v1.0.0
