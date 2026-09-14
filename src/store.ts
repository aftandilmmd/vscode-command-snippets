import { Emitter } from './emitter';
import {
  Group,
  HistoryEntry,
  MAX_HISTORY,
  Snippet,
  SnippetSource,
  SortKey,
  StoreData,
  WorkspaceData,
  emptyData,
  emptyWorkspaceData
} from './types';

/**
 * Shape of `vscode.Memento` limited to what the migration needs, so nothing in this
 * module has to import `vscode`.
 */
export interface StateStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * One JSON document on disk. `load` is synchronous because both files are tiny and the
 * store needs its data the moment it is constructed.
 */
export interface DocStorage {
  load(): unknown;
  save(data: unknown): Promise<void>;
}

export interface NewSnippetInput {
  name: string;
  command: string;
  description?: string;
  groupId?: string;
  source?: SnippetSource;
}

export interface SnippetPatch {
  name?: string;
  command?: string;
  description?: string;
  groupId?: string;
  source?: SnippetSource;
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

function normalizeGroups(raw: unknown, source: SnippetSource): { groups: Group[]; ids: Set<string> } {
  const groups: Group[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(raw)) {
    return { groups, ids };
  }
  for (const group of raw) {
    if (!group || typeof group.id !== 'string' || typeof group.name !== 'string') {
      continue;
    }
    ids.add(group.id);
    groups.push({
      id: group.id,
      name: group.name,
      createdAt: typeof group.createdAt === 'number' ? group.createdAt : Date.now(),
      source
    });
  }
  return { groups, ids };
}

function normalizeSnippets(raw: unknown, groupIds: Set<string>, source: SnippetSource): Snippet[] {
  const snippets: Snippet[] = [];
  if (!Array.isArray(raw)) {
    return snippets;
  }
  for (const snippet of raw) {
    if (!snippet || typeof snippet.id !== 'string' || typeof snippet.command !== 'string') {
      continue;
    }
    const createdAt = typeof snippet.createdAt === 'number' ? snippet.createdAt : Date.now();
    snippets.push({
      id: snippet.id,
      name: typeof snippet.name === 'string' && snippet.name !== '' ? snippet.name : snippet.command,
      command: snippet.command,
      description: typeof snippet.description === 'string' ? snippet.description : undefined,
      // Drop references to groups that do not exist in this file -> the snippet becomes Ungrouped.
      groupId: typeof snippet.groupId === 'string' && groupIds.has(snippet.groupId) ? snippet.groupId : undefined,
      createdAt,
      updatedAt: typeof snippet.updatedAt === 'number' ? snippet.updatedAt : createdAt,
      lastRunAt: typeof snippet.lastRunAt === 'number' ? snippet.lastRunAt : undefined,
      source
    });
  }
  return snippets;
}

/** Normalises anything read from the global file (or legacy global state) into valid data. */
export function normalize(raw: unknown, source: SnippetSource = 'global'): StoreData {
  const data = emptyData();
  if (typeof raw !== 'object' || raw === null) {
    return data;
  }
  const candidate = raw as Partial<StoreData>;
  const { groups, ids } = normalizeGroups(candidate.groups, source);
  data.groups = groups;
  data.snippets = normalizeSnippets(candidate.snippets, ids, source);

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

/** Normalises the per-project file. Any `history` it carries is ignored. */
export function normalizeWorkspace(raw: unknown): WorkspaceData {
  const data = emptyWorkspaceData();
  if (typeof raw !== 'object' || raw === null) {
    return data;
  }
  const candidate = raw as Partial<WorkspaceData>;
  const { groups, ids } = normalizeGroups(candidate.groups, 'workspace');
  data.groups = groups;
  data.snippets = normalizeSnippets(candidate.snippets, ids, 'workspace');
  return data;
}

/** Removes runtime-only fields so `source` never lands in a file. */
function forDisk<T extends { source?: SnippetSource }>(items: readonly T[]): Omit<T, 'source'>[] {
  return items.map((item) => {
    const copy = { ...item };
    delete copy.source;
    return copy;
  });
}

/**
 * Single source of truth for snippets, groups and history.
 *
 * Data lives in up to two documents: a global one (always present) and an optional
 * per-project one. Reads return the merged view; writes are routed back to the document
 * the record belongs to.
 */
export class Store {
  private globalData: StoreData;
  private workspaceData: WorkspaceData | undefined;
  private merged: StoreData = emptyData();
  private readonly changed = new Emitter<StoreData>();

  constructor(
    private readonly globalDoc: DocStorage,
    private workspaceDoc: DocStorage | undefined = undefined
  ) {
    this.globalData = normalize(this.globalDoc.load());
    this.workspaceData = this.workspaceDoc ? normalizeWorkspace(this.workspaceDoc.load()) : undefined;
    this.rebuild();
  }

  readonly onDidChange = (listener: (data: StoreData) => void) => this.changed.on(listener);

  /** True when a per-project file is available to write to. */
  get hasWorkspace(): boolean {
    return this.workspaceDoc !== undefined;
  }

  /** Re-reads both documents, e.g. after an external edit or an MCP write. */
  reload(): void {
    this.globalData = normalize(this.globalDoc.load());
    this.workspaceData = this.workspaceDoc ? normalizeWorkspace(this.workspaceDoc.load()) : undefined;
    this.rebuild();
    this.changed.fire(this.merged);
  }

  /** Attaches or detaches the per-project document (the open folder changed). */
  setWorkspaceDoc(doc: DocStorage | undefined): void {
    this.workspaceDoc = doc;
    this.workspaceData = doc ? normalizeWorkspace(doc.load()) : undefined;
    this.rebuild();
    this.changed.fire(this.merged);
  }

  private rebuild(): void {
    this.merged = {
      version: 1,
      snippets: [...this.globalData.snippets, ...(this.workspaceData?.snippets ?? [])],
      groups: [...this.globalData.groups, ...(this.workspaceData?.groups ?? [])],
      history: this.globalData.history
    };
  }

  getData(): StoreData {
    return this.merged;
  }

  getSnippet(id: string): Snippet | undefined {
    return this.merged.snippets.find((snippet) => snippet.id === id);
  }

  getGroup(id: string): Group | undefined {
    return this.merged.groups.find((group) => group.id === id);
  }

  /** The document a source writes to, or `undefined` when that source is unavailable. */
  private docFor(source: SnippetSource): { snippets: Snippet[]; groups: Group[] } | undefined {
    if (source === 'workspace') {
      return this.workspaceDoc ? this.workspaceData : undefined;
    }
    return this.globalData;
  }

  /** Falls back to `global` when the per-project file is not available. */
  private resolveSource(source: SnippetSource | undefined): SnippetSource {
    return source === 'workspace' && this.workspaceDoc ? 'workspace' : 'global';
  }

  /** A group id is only valid for a snippet living in the same source. */
  private resolveGroupId(groupId: string | undefined, source: SnippetSource): string | undefined {
    if (!groupId || groupId === '') {
      return undefined;
    }
    const group = this.getGroup(groupId);
    return group && group.source === source ? groupId : undefined;
  }

  // --- snippets ---------------------------------------------------------

  async addSnippet(input: NewSnippetInput): Promise<Snippet> {
    // An explicit source wins; otherwise the target group decides; otherwise global.
    const groupSource = input.groupId ? this.getGroup(input.groupId)?.source : undefined;
    const source = this.resolveSource(input.source ?? groupSource);
    const now = Date.now();
    const snippet: Snippet = {
      id: newId(),
      name: input.name.trim() === '' ? input.command.trim() : input.name.trim(),
      command: input.command.trim(),
      description: input.description?.trim() || undefined,
      groupId: this.resolveGroupId(input.groupId, source),
      createdAt: now,
      updatedAt: now,
      source
    };
    const doc = this.docFor(source);
    if (!doc) {
      throw new Error(`Cannot write to the "${source}" store.`);
    }
    doc.snippets.push(snippet);
    await this.persist(source);
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
    snippet.updatedAt = Date.now();

    const currentSource = snippet.source ?? 'global';
    // The group may live in the other source, which implies moving the snippet there.
    const groupSource = patch.groupId ? this.getGroup(patch.groupId)?.source : undefined;
    const targetSource = this.resolveSource(patch.source ?? groupSource ?? currentSource);

    if (targetSource !== currentSource) {
      await this.relocate(snippet, targetSource, patch.groupId);
      return;
    }
    if (patch.groupId !== undefined) {
      snippet.groupId = this.resolveGroupId(patch.groupId, currentSource);
    }
    await this.persist(currentSource);
  }

  async deleteSnippet(id: string): Promise<void> {
    const snippet = this.getSnippet(id);
    if (!snippet) {
      return;
    }
    const source = snippet.source ?? 'global';
    const doc = this.docFor(source);
    if (!doc) {
      return;
    }
    this.writeBackSnippets(
      source,
      doc.snippets.filter((item) => item.id !== id)
    );
    await this.persist(source);
  }

  /**
   * Moves a snippet to `groupId`, and to another source when the group lives there or a
   * source is given explicitly. An unknown or empty group id means "Ungrouped".
   */
  async moveSnippet(id: string, groupId: string | undefined, source?: SnippetSource): Promise<void> {
    const snippet = this.getSnippet(id);
    if (!snippet) {
      return;
    }
    const currentSource = snippet.source ?? 'global';
    const groupSource = groupId ? this.getGroup(groupId)?.source : undefined;
    const targetSource = this.resolveSource(source ?? groupSource ?? currentSource);

    if (targetSource !== currentSource) {
      await this.relocate(snippet, targetSource, groupId);
      return;
    }
    snippet.groupId = this.resolveGroupId(groupId, currentSource);
    snippet.updatedAt = Date.now();
    await this.persist(currentSource);
  }

  /** Moves a snippet between files, keeping its id. */
  private async relocate(snippet: Snippet, target: SnippetSource, groupId: string | undefined): Promise<void> {
    const from = snippet.source ?? 'global';
    const fromDoc = this.docFor(from);
    const toDoc = this.docFor(target);
    if (!fromDoc || !toDoc) {
      return;
    }
    this.writeBackSnippets(
      from,
      fromDoc.snippets.filter((item) => item.id !== snippet.id)
    );
    snippet.source = target;
    snippet.groupId = this.resolveGroupId(groupId, target);
    snippet.updatedAt = Date.now();
    toDoc.snippets.push(snippet);
    await this.persist(from, target);
  }

  private writeBackSnippets(source: SnippetSource, snippets: Snippet[]): void {
    if (source === 'workspace' && this.workspaceData) {
      this.workspaceData.snippets = snippets;
    } else {
      this.globalData.snippets = snippets;
    }
  }

  private writeBackGroups(source: SnippetSource, groups: Group[]): void {
    if (source === 'workspace' && this.workspaceData) {
      this.workspaceData.groups = groups;
    } else {
      this.globalData.groups = groups;
    }
  }

  // --- groups -----------------------------------------------------------

  async addGroup(name: string, source?: SnippetSource): Promise<Group> {
    const target = this.resolveSource(source);
    const doc = this.docFor(target);
    if (!doc) {
      throw new Error(`Cannot write to the "${target}" store.`);
    }
    const group: Group = { id: newId(), name: name.trim(), createdAt: Date.now(), source: target };
    doc.groups.push(group);
    await this.persist(target);
    return group;
  }

  async renameGroup(id: string, name: string): Promise<void> {
    const group = this.getGroup(id);
    if (!group || name.trim() === '') {
      return;
    }
    group.name = name.trim();
    await this.persist(group.source ?? 'global');
  }

  /** Deleting a group moves its snippets to Ungrouped rather than deleting them. */
  async deleteGroup(id: string): Promise<void> {
    const group = this.getGroup(id);
    if (!group) {
      return;
    }
    const source = group.source ?? 'global';
    const doc = this.docFor(source);
    if (!doc) {
      return;
    }
    this.writeBackGroups(
      source,
      doc.groups.filter((item) => item.id !== id)
    );
    const now = Date.now();
    for (const snippet of doc.snippets) {
      if (snippet.groupId === id) {
        snippet.groupId = undefined;
        snippet.updatedAt = now;
      }
    }
    await this.persist(source);
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
    this.globalData.history.unshift(entry);
    if (this.globalData.history.length > MAX_HISTORY) {
      this.globalData.history.length = MAX_HISTORY;
    }

    const sources: SnippetSource[] = ['global'];
    if (snippet.id) {
      const existing = this.getSnippet(snippet.id);
      if (existing) {
        existing.lastRunAt = entry.ranAt;
        const source = existing.source ?? 'global';
        if (source !== 'global') {
          sources.push(source);
        }
      }
    }
    await this.persist(...sources);
  }

  async clearHistory(): Promise<void> {
    this.globalData.history = [];
    await this.persist('global');
  }

  // --- import / export --------------------------------------------------

  /** Exports the merged view, so an export carries project snippets too. */
  exportData(): StoreData {
    return this.merged;
  }

  /** Ids present both in the current data and in `incoming`. */
  findConflicts(incoming: StoreData): { snippets: number; groups: number } {
    const snippetIds = new Set(this.merged.snippets.map((snippet) => snippet.id));
    const groupIds = new Set(this.merged.groups.map((group) => group.id));
    return {
      snippets: incoming.snippets.filter((snippet) => snippetIds.has(snippet.id)).length,
      groups: incoming.groups.filter((group) => groupIds.has(group.id)).length
    };
  }

  /**
   * Merges `incoming` into the global document by id. Existing entries are kept unless
   * `overwrite` is set. Records that already exist in the project file are updated there.
   */
  async importData(incoming: StoreData, overwrite: boolean): Promise<void> {
    const touched = new Set<SnippetSource>(['global']);

    for (const group of incoming.groups) {
      const existing = this.getGroup(group.id);
      if (!existing) {
        this.globalData.groups.push({ ...group, source: 'global' });
      } else if (overwrite) {
        Object.assign(existing, group, { source: existing.source });
        touched.add(existing.source ?? 'global');
      }
    }

    for (const snippet of incoming.snippets) {
      const existing = this.getSnippet(snippet.id);
      if (!existing) {
        this.globalData.snippets.push({ ...snippet, source: 'global' });
      } else if (overwrite) {
        Object.assign(existing, snippet, { source: existing.source });
        touched.add(existing.source ?? 'global');
      }
    }

    const historyIds = new Set(this.globalData.history.map((entry) => entry.id));
    for (const entry of incoming.history) {
      if (!historyIds.has(entry.id)) {
        this.globalData.history.push(entry);
      }
    }
    this.globalData.history.sort((a, b) => b.ranAt - a.ranAt);
    this.globalData.history = this.globalData.history.slice(0, MAX_HISTORY);

    // Re-run normalisation so imported snippets never point at a group in the other file.
    this.globalData = normalize(this.toDisk(this.globalData));
    await this.persist(...touched);
  }

  private toDisk(data: StoreData): StoreData {
    return {
      version: 1,
      snippets: forDisk(data.snippets) as Snippet[],
      groups: forDisk(data.groups) as Group[],
      history: data.history
    };
  }

  private async persist(...sources: SnippetSource[]): Promise<void> {
    const unique = new Set(sources);
    if (unique.has('global')) {
      await this.globalDoc.save(this.toDisk(this.globalData));
    }
    if (unique.has('workspace') && this.workspaceDoc && this.workspaceData) {
      await this.workspaceDoc.save({
        version: 1,
        snippets: forDisk(this.workspaceData.snippets),
        groups: forDisk(this.workspaceData.groups)
      });
    }
    this.rebuild();
    this.changed.fire(this.merged);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
