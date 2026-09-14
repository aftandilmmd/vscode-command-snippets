import { Emitter } from './emitter';
import {
  Group,
  HistoryEntry,
  MAX_HISTORY,
  Snippet,
  SortKey,
  STORAGE_KEY,
  StoreData,
  emptyData
} from './types';

/**
 * Shape of `vscode.Memento` limited to what the store needs, so the store can be
 * unit-tested with a plain in-memory object.
 */
export interface StateStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface NewSnippetInput {
  name: string;
  command: string;
  description?: string;
  groupId?: string;
}

export interface SnippetPatch {
  name?: string;
  command?: string;
  description?: string;
  groupId?: string;
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** Case-insensitive match over name, command and description. */
export function matchesQuery(snippet: Snippet, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return true;
  }
  return (
    snippet.name.toLowerCase().includes(q) ||
    snippet.command.toLowerCase().includes(q) ||
    (snippet.description ?? '').toLowerCase().includes(q)
  );
}

export function filterSnippets(snippets: readonly Snippet[], query: string): Snippet[] {
  return snippets.filter((snippet) => matchesQuery(snippet, query));
}

/** Stable sort; entries without the sort field fall to the bottom. */
export function sortSnippets(snippets: readonly Snippet[], sort: SortKey): Snippet[] {
  const copy = [...snippets];
  switch (sort) {
    case 'name-asc':
      return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    case 'name-desc':
      return copy.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: 'base' }));
    case 'created':
      return copy.sort((a, b) => b.createdAt - a.createdAt);
    case 'updated':
      return copy.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'lastRun':
      return copy.sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0));
  }
}

/** Normalises anything read from disk or global state into a valid `StoreData`. */
export function normalize(raw: unknown): StoreData {
  const data = emptyData();
  if (typeof raw !== 'object' || raw === null) {
    return data;
  }
  const candidate = raw as Partial<StoreData>;
  const groupIds = new Set<string>();

  if (Array.isArray(candidate.groups)) {
    for (const group of candidate.groups) {
      if (!group || typeof group.id !== 'string' || typeof group.name !== 'string') {
        continue;
      }
      groupIds.add(group.id);
      data.groups.push({
        id: group.id,
        name: group.name,
        createdAt: typeof group.createdAt === 'number' ? group.createdAt : Date.now()
      });
    }
  }

  if (Array.isArray(candidate.snippets)) {
    for (const snippet of candidate.snippets) {
      if (!snippet || typeof snippet.id !== 'string' || typeof snippet.command !== 'string') {
        continue;
      }
      const createdAt = typeof snippet.createdAt === 'number' ? snippet.createdAt : Date.now();
      data.snippets.push({
        id: snippet.id,
        name: typeof snippet.name === 'string' && snippet.name !== '' ? snippet.name : snippet.command,
        command: snippet.command,
        description: typeof snippet.description === 'string' ? snippet.description : undefined,
        // Drop references to groups that do not exist -> the snippet becomes Ungrouped.
        groupId: typeof snippet.groupId === 'string' && groupIds.has(snippet.groupId) ? snippet.groupId : undefined,
        createdAt,
        updatedAt: typeof snippet.updatedAt === 'number' ? snippet.updatedAt : createdAt,
        lastRunAt: typeof snippet.lastRunAt === 'number' ? snippet.lastRunAt : undefined
      });
    }
  }

  if (Array.isArray(candidate.history)) {
    for (const entry of candidate.history) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.command !== 'string') {
        continue;
      }
      data.history.push({
        id: entry.id,
        snippetId: typeof entry.snippetId === 'string' ? entry.snippetId : undefined,
        snippetName: typeof entry.snippetName === 'string' ? entry.snippetName : entry.command,
        command: entry.command,
        ranAt: typeof entry.ranAt === 'number' ? entry.ranAt : Date.now()
      });
    }
    data.history.sort((a, b) => b.ranAt - a.ranAt);
    data.history = data.history.slice(0, MAX_HISTORY);
  }

  return data;
}

/** Single source of truth for snippets, groups and history. */
export class Store {
  private data: StoreData;
  private readonly changed = new Emitter<StoreData>();

  constructor(private readonly storage: StateStorage) {
    this.data = normalize(this.storage.get<StoreData>(STORAGE_KEY));
  }

  readonly onDidChange = (listener: (data: StoreData) => void) => this.changed.on(listener);

  getData(): StoreData {
    return this.data;
  }

  getSnippet(id: string): Snippet | undefined {
    return this.data.snippets.find((snippet) => snippet.id === id);
  }

  getGroup(id: string): Group | undefined {
    return this.data.groups.find((group) => group.id === id);
  }

  // --- snippets ---------------------------------------------------------

  async addSnippet(input: NewSnippetInput): Promise<Snippet> {
    const now = Date.now();
    const snippet: Snippet = {
      id: newId(),
      name: input.name.trim() === '' ? input.command.trim() : input.name.trim(),
      command: input.command.trim(),
      description: input.description?.trim() || undefined,
      groupId: input.groupId && this.getGroup(input.groupId) ? input.groupId : undefined,
      createdAt: now,
      updatedAt: now
    };
    this.data.snippets.push(snippet);
    await this.persist();
    return snippet;
  }

  async updateSnippet(id: string, patch: SnippetPatch): Promise<void> {
    const snippet = this.getSnippet(id);
    if (!snippet) {
      return;
    }
    if (patch.name !== undefined) {
      snippet.name = patch.name.trim() === '' ? snippet.name : patch.name.trim();
    }
    if (patch.command !== undefined && patch.command.trim() !== '') {
      snippet.command = patch.command.trim();
    }
    if (patch.description !== undefined) {
      snippet.description = patch.description.trim() || undefined;
    }
    if (patch.groupId !== undefined) {
      snippet.groupId = this.resolveGroupId(patch.groupId);
    }
    snippet.updatedAt = Date.now();
    await this.persist();
  }

  async deleteSnippet(id: string): Promise<void> {
    const before = this.data.snippets.length;
    this.data.snippets = this.data.snippets.filter((snippet) => snippet.id !== id);
    if (this.data.snippets.length !== before) {
      await this.persist();
    }
  }

  /** Moves a snippet to `groupId`; an unknown or empty id moves it to Ungrouped. */
  async moveSnippet(id: string, groupId: string | undefined): Promise<void> {
    const snippet = this.getSnippet(id);
    if (!snippet) {
      return;
    }
    snippet.groupId = this.resolveGroupId(groupId);
    snippet.updatedAt = Date.now();
    await this.persist();
  }

  private resolveGroupId(groupId: string | undefined): string | undefined {
    if (!groupId || groupId === '') {
      return undefined;
    }
    return this.getGroup(groupId) ? groupId : undefined;
  }

  // --- groups -----------------------------------------------------------

  async addGroup(name: string): Promise<Group> {
    const group: Group = { id: newId(), name: name.trim(), createdAt: Date.now() };
    this.data.groups.push(group);
    await this.persist();
    return group;
  }

  async renameGroup(id: string, name: string): Promise<void> {
    const group = this.getGroup(id);
    if (!group || name.trim() === '') {
      return;
    }
    group.name = name.trim();
    await this.persist();
  }

  /** Deleting a group moves its snippets to Ungrouped rather than deleting them. */
  async deleteGroup(id: string): Promise<void> {
    if (!this.getGroup(id)) {
      return;
    }
    this.data.groups = this.data.groups.filter((group) => group.id !== id);
    const now = Date.now();
    for (const snippet of this.data.snippets) {
      if (snippet.groupId === id) {
        snippet.groupId = undefined;
        snippet.updatedAt = now;
      }
    }
    await this.persist();
  }

  // --- history ----------------------------------------------------------

  async addHistory(snippet: Pick<Snippet, 'command'> & { id?: string; name: string }): Promise<void> {
    const entry: HistoryEntry = {
      id: newId(),
      snippetId: snippet.id,
      snippetName: snippet.name,
      command: snippet.command,
      ranAt: Date.now()
    };
    this.data.history.unshift(entry);
    if (this.data.history.length > MAX_HISTORY) {
      this.data.history.length = MAX_HISTORY;
    }
    if (snippet.id) {
      const existing = this.getSnippet(snippet.id);
      if (existing) {
        existing.lastRunAt = entry.ranAt;
      }
    }
    await this.persist();
  }

  async clearHistory(): Promise<void> {
    this.data.history = [];
    await this.persist();
  }

  // --- import / export --------------------------------------------------

  exportData(): StoreData {
    return this.data;
  }

  /** Ids present in both the current data and `incoming`. */
  findConflicts(incoming: StoreData): { snippets: number; groups: number } {
    const snippetIds = new Set(this.data.snippets.map((snippet) => snippet.id));
    const groupIds = new Set(this.data.groups.map((group) => group.id));
    return {
      snippets: incoming.snippets.filter((snippet) => snippetIds.has(snippet.id)).length,
      groups: incoming.groups.filter((group) => groupIds.has(group.id)).length
    };
  }

  /** Merges `incoming` by id. Existing entries are kept unless `overwrite` is set. */
  async importData(incoming: StoreData, overwrite: boolean): Promise<void> {
    for (const group of incoming.groups) {
      const index = this.data.groups.findIndex((existing) => existing.id === group.id);
      if (index === -1) {
        this.data.groups.push(group);
      } else if (overwrite) {
        this.data.groups[index] = group;
      }
    }
    for (const snippet of incoming.snippets) {
      const index = this.data.snippets.findIndex((existing) => existing.id === snippet.id);
      if (index === -1) {
        this.data.snippets.push(snippet);
      } else if (overwrite) {
        this.data.snippets[index] = snippet;
      }
    }
    const historyIds = new Set(this.data.history.map((entry) => entry.id));
    for (const entry of incoming.history) {
      if (!historyIds.has(entry.id)) {
        this.data.history.push(entry);
      }
    }
    this.data.history.sort((a, b) => b.ranAt - a.ranAt);
    this.data.history = this.data.history.slice(0, MAX_HISTORY);
    // Re-run normalisation so imported snippets never point at missing groups.
    this.data = normalize(this.data);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.storage.update(STORAGE_KEY, this.data);
    this.changed.fire(this.data);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
