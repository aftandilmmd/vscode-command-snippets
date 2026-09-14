# Command Snippets

Keep your reusable terminal commands in the VS Code sidebar, organise them into groups, and run
them in the integrated terminal with one click.

## Features

- **Sidebar panel** with two tabs: **Snippets** and **History**.
- **Snippets**: create, edit, delete (with confirmation), copy, and run.
- **Groups**: create, rename, delete. Deleting a group moves its snippets to *Ungrouped* — it never
  deletes them. Groups render as collapsible sections and the collapse state is remembered.
- **Move** a snippet to another group from the row's ➜ button.
- **Search** filters by name, command and description while you type (case-insensitive).
- **Sort** by name (A–Z / Z–A), created date, last updated, or last run.
- **Run** (▶) sends the command to a dedicated terminal named `Command Snippets`. The terminal is
  reused when it is still alive and recreated if you close it.
- **Command Palette**: `Command Snippets: Run Snippet` (`Ctrl+Alt+R` / `Cmd+Alt+R`) opens a QuickPick
  of every snippet, most recently run first.
- **History**: newest first, relative times ("2 min ago") with the full timestamp on hover, per-entry
  **Re-run**, **Save as snippet** and **Copy**, plus **Clear history**. Capped at 500 entries.
- **Export / Import** the whole dataset as JSON. Import merges by id and asks before overwriting.

## Usage

1. Click the terminal icon in the Activity Bar to open **Command Snippets**.
2. **New snippet** → give it a name, the command, an optional description and a group → **Save**.
3. Hover a snippet row and press ▶ to run it (or double-click the row).
4. Switch to **History** to re-run anything you ran before.

All data lives in `context.globalState` under `commandSnippets.data.v1`, so snippets follow you
across workspaces.

## Commands

| Command | Id | Default keybinding |
| --- | --- | --- |
| Run Snippet | `commandSnippets.run` | `Ctrl+Alt+R` / `Cmd+Alt+R` |
| New Snippet | `commandSnippets.newSnippet` | — |
| New Group | `commandSnippets.newGroup` | — |
| Refresh | `commandSnippets.refresh` | — |
| Export Data… | `commandSnippets.export` | — |
| Import Data… | `commandSnippets.import` | — |

## Development

```bash
npm install
npm run compile     # bundle with esbuild into dist/
npm run watch       # rebuild on change
npm test            # unit tests for the store (Mocha)
npm run package     # typecheck + production bundle
npm run vsce        # build a .vsix
```

Then press <kbd>F5</kbd> in VS Code to launch the Extension Development Host.

### Layout

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Activation and command registration |
| `src/store.ts` | Typed state, persistence, change events, sort/filter/move logic |
| `src/snippetsViewProvider.ts` | `WebviewViewProvider` and the typed message bridge |
| `src/runner.ts` | Runs snippets and records history |
| `src/terminal.ts` | Dedicated terminal management |
| `src/messages.ts` | Message union + runtime validation of webview messages |
| `media/` | Webview `main.js` / `main.css` (no frameworks) |

The webview runs under a strict CSP with a per-render nonce, and every piece of user content is
rendered with `textContent`, never `innerHTML`.

## License

MIT
