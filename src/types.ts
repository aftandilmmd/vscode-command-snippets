/** Data model shared by the extension host, the store and the webview. */

export interface Snippet {
  id: string;
  name: string;
  command: string;
  description?: string;
  /** `undefined` means "Ungrouped". */
  groupId?: string;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms of the last run, used by the "last run" sort. */
  lastRunAt?: number;
}

export interface Group {
  id: string;
  name: string;
  createdAt: number;
}

export interface HistoryEntry {
  id: string;
  /** Absent when the snippet was deleted after running, or for ad-hoc commands. */
  snippetId?: string;
  snippetName: string;
  command: string;
  ranAt: number;
}

export interface StoreData {
  version: 1;
  snippets: Snippet[];
  groups: Group[];
  history: HistoryEntry[];
}

export type SortKey = 'name-asc' | 'name-desc' | 'created' | 'updated' | 'lastRun';

export const UNGROUPED_ID = '__ungrouped__';

export const STORAGE_KEY = 'commandSnippets.data.v1';

export const MAX_HISTORY = 500;

export function emptyData(): StoreData {
  return { version: 1, snippets: [], groups: [], history: [] };
}
