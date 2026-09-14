/** Data model shared by the extension host, the store, the MCP server and the webview. */

/**
 * Which file a snippet or group lives in. Derived from the file it was read from and
 * never written to disk.
 */
export type SnippetSource = 'global' | 'workspace';

export interface Snippet {
  id: string;
  name: string;
  command: string;
  description?: string;
  /** `undefined` means "Ungrouped". Always points at a group in the same source. */
  groupId?: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms of the last run, used by the "last run" sort. */
  lastRunAt?: number;
  /** Runtime only — stripped before writing. */
  source?: SnippetSource;
}

export interface Group {
  id: string;
  name: string;
  createdAt: number;
  /** Runtime only — stripped before writing. */
  source?: SnippetSource;
}

export interface HistoryEntry {
  id: string;
  /** Absent when the snippet was deleted after running, or for ad-hoc commands. */
  snippetId?: string;
  snippetName: string;
  command: string;
  ranAt: number;
}

/** Contents of the global data file, and the merged view the UI renders. */
export interface StoreData {
  version: 1;
  snippets: Snippet[];
  groups: Group[];
  history: HistoryEntry[];
}

/** Contents of the per-project file. History is deliberately global-only — it must not be committed. */
export interface WorkspaceData {
  version: 1;
  snippets: Snippet[];
  groups: Group[];
}

export type SortKey = 'name-asc' | 'name-desc' | 'created' | 'updated' | 'lastRun';

export const UNGROUPED_ID = '__ungrouped__';

/** Legacy `globalState` key, still read once by the migration. */
export const STORAGE_KEY = 'commandSnippets.data.v1';

export const MIGRATED_KEY = 'commandSnippets.migrated.v1';

export const MAX_HISTORY = 500;

/** `~/.command-snippets` — the home of the global data file and the run request queue. */
export const GLOBAL_DIR_NAME = '.command-snippets';
export const GLOBAL_DATA_FILE = 'data.json';
export const RUNTIME_FILE = 'runtime.json';
export const RUNS_DIR = 'runs';

/** Path of the per-project file, relative to the workspace root. */
export const WORKSPACE_FILE_RELATIVE = '.vscode/command-snippets.json';

export function emptyData(): StoreData {
  return { version: 1, snippets: [], groups: [], history: [] };
}

export function emptyWorkspaceData(): WorkspaceData {
  return { version: 1, snippets: [], groups: [] };
}
