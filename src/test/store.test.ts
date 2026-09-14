import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileStorage } from '../storage/fileStorage';
import { migrateFromGlobalState } from '../storage/migrate';
import { DocStorage, StateStorage, Store, filterSnippets, normalize, sortSnippets } from '../store';
import { MAX_HISTORY, Snippet, StoreData } from '../types';

/** In-memory stand-in for a JSON file on disk. */
class MemoryDoc implements DocStorage {
  saves = 0;
  private text: string | undefined;

  constructor(initial?: unknown) {
    this.text = initial === undefined ? undefined : JSON.stringify(initial);
  }

  load(): unknown {
    return this.text === undefined ? undefined : JSON.parse(this.text);
  }

  async save(data: unknown): Promise<void> {
    this.saves++;
    // Round-trip through JSON the way a file does, so tests catch anything that would
    // not survive persistence.
    this.text = JSON.stringify(data);
  }

  /** Raw contents as they would sit in the file. */
  raw(): { snippets: Snippet[]; groups: { id: string; name: string }[] } | undefined {
    return this.text === undefined ? undefined : JSON.parse(this.text);
  }
}

function snippet(partial: Partial<Snippet> & { name: string }): Snippet {
  return {
    id: partial.id ?? partial.name,
    name: partial.name,
    command: partial.command ?? `echo ${partial.name}`,
    description: partial.description,
    groupId: partial.groupId,
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    lastRunAt: partial.lastRunAt
  };
}

describe('sortSnippets', () => {
  const items = [
    snippet({ name: 'beta', createdAt: 2, updatedAt: 5, lastRunAt: 1 }),
    snippet({ name: 'Alpha', createdAt: 3, updatedAt: 1 }),
    snippet({ name: 'gamma', createdAt: 1, updatedAt: 9, lastRunAt: 7 })
  ];

  it('sorts by name A-Z, case-insensitively', () => {
    assert.deepStrictEqual(
      sortSnippets(items, 'name-asc').map((item) => item.name),
      ['Alpha', 'beta', 'gamma']
    );
  });

  it('sorts by name Z-A', () => {
    assert.deepStrictEqual(
      sortSnippets(items, 'name-desc').map((item) => item.name),
      ['gamma', 'beta', 'Alpha']
    );
  });

  it('sorts by created date, newest first', () => {
    assert.deepStrictEqual(
      sortSnippets(items, 'created').map((item) => item.name),
      ['Alpha', 'beta', 'gamma']
    );
  });

  it('sorts by last updated, newest first', () => {
    assert.deepStrictEqual(
      sortSnippets(items, 'updated').map((item) => item.name),
      ['gamma', 'beta', 'Alpha']
    );
  });

  it('sorts by last run and pushes never-run snippets to the bottom', () => {
    assert.deepStrictEqual(
      sortSnippets(items, 'lastRun').map((item) => item.name),
      ['gamma', 'beta', 'Alpha']
    );
  });

  it('does not mutate the input array', () => {
    const input = [snippet({ name: 'b' }), snippet({ name: 'a' })];
    sortSnippets(input, 'name-asc');
    assert.deepStrictEqual(input.map((item) => item.name), ['b', 'a']);
  });
});

describe('filterSnippets', () => {
  const items = [
    snippet({ name: 'Run tests', command: 'npm test', description: 'unit suite' }),
    snippet({ name: 'Build', command: 'npm run build' }),
    snippet({ name: 'Deploy', command: 'fly deploy', description: 'Production push' })
  ];

  it('returns everything for an empty query', () => {
    assert.strictEqual(filterSnippets(items, '   ').length, 3);
  });

  it('matches the name case-insensitively', () => {
    assert.deepStrictEqual(filterSnippets(items, 'DEPLOY').map((item) => item.name), ['Deploy']);
  });

  it('matches the command', () => {
    assert.deepStrictEqual(filterSnippets(items, 'npm run').map((item) => item.name), ['Build']);
  });

  it('matches the description', () => {
    assert.deepStrictEqual(filterSnippets(items, 'production').map((item) => item.name), ['Deploy']);
  });

  it('returns nothing when there is no match', () => {
    assert.strictEqual(filterSnippets(items, 'nope').length, 0);
  });
});

describe('Store: groups and moving', () => {
  it('moves a snippet between groups', async () => {
    const store = new Store(new MemoryDoc());
    const group = await store.addGroup('Build');
    const created = await store.addSnippet({ name: 'Build', command: 'npm run build' });
    assert.strictEqual(created.groupId, undefined);

    await store.moveSnippet(created.id, group.id);
    assert.strictEqual(store.getSnippet(created.id)?.groupId, group.id);

    await store.moveSnippet(created.id, undefined);
    assert.strictEqual(store.getSnippet(created.id)?.groupId, undefined);
  });

  it('ignores a move to an unknown group and falls back to Ungrouped', async () => {
    const store = new Store(new MemoryDoc());
    const group = await store.addGroup('Build');
    const created = await store.addSnippet({ name: 'Build', command: 'npm run build', groupId: group.id });

    await store.moveSnippet(created.id, 'does-not-exist');
    assert.strictEqual(store.getSnippet(created.id)?.groupId, undefined);
  });

  it('deleting a group keeps its snippets and ungroups them', async () => {
    const store = new Store(new MemoryDoc());
    const group = await store.addGroup('Build');
    const kept = await store.addSnippet({ name: 'Build', command: 'npm run build', groupId: group.id });

    await store.deleteGroup(group.id);
    assert.strictEqual(store.getData().groups.length, 0);
    assert.strictEqual(store.getData().snippets.length, 1);
    assert.strictEqual(store.getSnippet(kept.id)?.groupId, undefined);
  });

  it('emits a change event on every mutation', async () => {
    const store = new Store(new MemoryDoc());
    let fired = 0;
    store.onDidChange(() => void fired++);
    await store.addGroup('Build');
    await store.addSnippet({ name: 'Build', command: 'npm run build' });
    assert.strictEqual(fired, 2);
  });
});

describe('Store: global and project sources', () => {
  const twoSources = (): { store: Store; global: MemoryDoc; workspace: MemoryDoc } => {
    const global = new MemoryDoc();
    const workspace = new MemoryDoc();
    return { store: new Store(global, workspace), global, workspace };
  };

  it('writes each snippet to the file its scope names', async () => {
    const { store, global, workspace } = twoSources();
    await store.addSnippet({ name: 'Global', command: 'echo g' });
    await store.addSnippet({ name: 'Project', command: 'echo p', source: 'workspace' });

    assert.deepStrictEqual(global.raw()?.snippets.map((item) => item.name), ['Global']);
    assert.deepStrictEqual(workspace.raw()?.snippets.map((item) => item.name), ['Project']);
  });

  it('merges both files into one view and tags each record with its source', async () => {
    const { store } = twoSources();
    await store.addSnippet({ name: 'Global', command: 'echo g' });
    await store.addSnippet({ name: 'Project', command: 'echo p', source: 'workspace' });

    const merged = store.getData().snippets;
    assert.strictEqual(merged.length, 2);
    assert.deepStrictEqual(
      merged.map((item) => `${item.name}:${item.source}`).sort(),
      ['Global:global', 'Project:workspace']
    );
  });

  it('never writes the runtime source field to disk', async () => {
    const { store, global } = twoSources();
    await store.addGroup('Build');
    await store.addSnippet({ name: 'Global', command: 'echo g' });

    const raw = global.raw();
    assert.ok(raw);
    assert.ok(!('source' in (raw.snippets[0] as object)));
    assert.ok(!('source' in (raw.groups[0] as object)));
  });

  it('keeps the id when a snippet moves to the other file', async () => {
    const { store, global, workspace } = twoSources();
    const created = await store.addSnippet({ name: 'Move me', command: 'echo m' });

    await store.moveSnippet(created.id, undefined, 'workspace');

    assert.strictEqual(store.getSnippet(created.id)?.source, 'workspace');
    assert.strictEqual(global.raw()?.snippets.length, 0);
    assert.deepStrictEqual(workspace.raw()?.snippets.map((item) => item.id), [created.id]);
  });

  it('moves a snippet across files when the target group lives there', async () => {
    const { store } = twoSources();
    const projectGroup = await store.addGroup('Project build', 'workspace');
    const created = await store.addSnippet({ name: 'Move me', command: 'echo m' });

    await store.moveSnippet(created.id, projectGroup.id);

    const moved = store.getSnippet(created.id);
    assert.strictEqual(moved?.source, 'workspace');
    assert.strictEqual(moved?.groupId, projectGroup.id);
  });

  it('refuses to put a global snippet into a project group', async () => {
    const { store } = twoSources();
    const projectGroup = await store.addGroup('Project build', 'workspace');
    // An explicit global scope wins over the group, which then does not apply.
    const created = await store.addSnippet({
      name: 'Global',
      command: 'echo g',
      groupId: projectGroup.id,
      source: 'global'
    });

    assert.strictEqual(created.source, 'global');
    assert.strictEqual(created.groupId, undefined);
  });

  it('falls back to global when there is no project file', async () => {
    const store = new Store(new MemoryDoc());
    const created = await store.addSnippet({ name: 'Project', command: 'echo p', source: 'workspace' });
    assert.strictEqual(created.source, 'global');
    assert.strictEqual(store.hasWorkspace, false);
  });

  it('deleting a project group only touches the project file', async () => {
    const { store, global, workspace } = twoSources();
    const globalGroup = await store.addGroup('Shared name');
    const projectGroup = await store.addGroup('Shared name', 'workspace');
    await store.addSnippet({ name: 'G', command: 'echo g', groupId: globalGroup.id });
    const projectSnippet = await store.addSnippet({
      name: 'P',
      command: 'echo p',
      groupId: projectGroup.id,
      source: 'workspace'
    });

    await store.deleteGroup(projectGroup.id);

    assert.strictEqual(global.raw()?.groups.length, 1);
    assert.strictEqual(workspace.raw()?.groups.length, 0);
    assert.strictEqual(store.getSnippet(projectSnippet.id)?.groupId, undefined);
    assert.strictEqual(store.getData().snippets.length, 2);
  });

  it('reload picks up an external edit to either file', async () => {
    const global = new MemoryDoc();
    const workspace = new MemoryDoc();
    const store = new Store(global, workspace);
    let fired = 0;
    store.onDidChange(() => void fired++);

    await workspace.save({
      version: 1,
      groups: [],
      snippets: [{ id: 'x', name: 'Added outside', command: 'echo x', createdAt: 1, updatedAt: 1 }]
    });
    store.reload();

    assert.strictEqual(store.getSnippet('x')?.name, 'Added outside');
    assert.strictEqual(store.getSnippet('x')?.source, 'workspace');
    assert.strictEqual(fired, 1);
  });

  it('drops the project document when the folder closes', async () => {
    const { store } = twoSources();
    await store.addSnippet({ name: 'Project', command: 'echo p', source: 'workspace' });
    assert.strictEqual(store.getData().snippets.length, 1);

    store.setWorkspaceDoc(undefined);
    assert.strictEqual(store.hasWorkspace, false);
    assert.strictEqual(store.getData().snippets.length, 0);
  });
});

describe('Store: history', () => {
  it('records runs newest first and stamps lastRunAt', async () => {
    const store = new Store(new MemoryDoc());
    const created = await store.addSnippet({ name: 'Test', command: 'npm test' });

    await store.addHistory({ id: created.id, name: created.name, command: created.command });
    await store.addHistory({ name: 'ad hoc', command: 'ls -la' });

    const history = store.getData().history;
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].command, 'ls -la');
    assert.ok((store.getSnippet(created.id)?.lastRunAt ?? 0) > 0);
  });

  it('keeps history in the global file even for a project snippet', async () => {
    const global = new MemoryDoc();
    const workspace = new MemoryDoc();
    const store = new Store(global, workspace);
    const created = await store.addSnippet({ name: 'P', command: 'echo p', source: 'workspace' });

    await store.addHistory({ id: created.id, name: created.name, command: created.command });

    const globalRaw = global.raw() as unknown as StoreData;
    assert.strictEqual(globalRaw.history.length, 1);
    assert.ok(!('history' in (workspace.raw() as object)));
    // lastRunAt still lands on the project snippet.
    assert.ok((workspace.raw()?.snippets[0].lastRunAt ?? 0) > 0);
  });

  it('caps history at MAX_HISTORY entries', async () => {
    const store = new Store(new MemoryDoc());
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      await store.addHistory({ name: `run ${i}`, command: `echo ${i}` });
    }
    assert.strictEqual(store.getData().history.length, MAX_HISTORY);
    assert.strictEqual(store.getData().history[0].command, `echo ${MAX_HISTORY + 9}`);
  });

  it('clears history', async () => {
    const store = new Store(new MemoryDoc());
    await store.addHistory({ name: 'run', command: 'echo hi' });
    await store.clearHistory();
    assert.strictEqual(store.getData().history.length, 0);
  });
});

describe('Store: persistence and import', () => {
  it('reloads persisted data from storage', async () => {
    const doc = new MemoryDoc();
    const first = new Store(doc);
    const group = await first.addGroup('Build');
    await first.addSnippet({ name: 'Build', command: 'npm run build', groupId: group.id });

    const second = new Store(doc);
    assert.strictEqual(second.getData().snippets.length, 1);
    assert.strictEqual(second.getData().snippets[0].groupId, group.id);
  });

  it('merges an import by id and keeps existing entries unless overwriting', async () => {
    const store = new Store(new MemoryDoc());
    const created = await store.addSnippet({ name: 'Original', command: 'echo original' });

    const incoming = normalize({
      version: 1,
      groups: [],
      history: [],
      snippets: [
        { id: created.id, name: 'Replaced', command: 'echo replaced', createdAt: 1, updatedAt: 1 },
        { id: 'new-one', name: 'Fresh', command: 'echo fresh', createdAt: 1, updatedAt: 1 }
      ]
    });

    assert.deepStrictEqual(store.findConflicts(incoming), { snippets: 1, groups: 0 });

    await store.importData(incoming, false);
    assert.strictEqual(store.getSnippet(created.id)?.name, 'Original');
    assert.strictEqual(store.getData().snippets.length, 2);

    await store.importData(incoming, true);
    assert.strictEqual(store.getSnippet(created.id)?.name, 'Replaced');
    assert.strictEqual(store.getData().snippets.length, 2);
  });

  it('an import that overwrites a project snippet writes it back to the project file', async () => {
    const global = new MemoryDoc();
    const workspace = new MemoryDoc();
    const store = new Store(global, workspace);
    const created = await store.addSnippet({ name: 'Project', command: 'echo p', source: 'workspace' });

    await store.importData(
      normalize({
        version: 1,
        groups: [],
        history: [],
        snippets: [{ id: created.id, name: 'Renamed', command: 'echo p', createdAt: 1, updatedAt: 2 }]
      }),
      true
    );

    assert.strictEqual(store.getSnippet(created.id)?.source, 'workspace');
    assert.deepStrictEqual(workspace.raw()?.snippets.map((item) => item.name), ['Renamed']);
    assert.strictEqual(global.raw()?.snippets.length, 0);
  });

  it('normalises junk and drops references to missing groups', () => {
    const data = normalize({
      version: 1,
      snippets: [
        { id: 'a', name: 'A', command: 'echo a', groupId: 'ghost', createdAt: 5 },
        { id: 'b', command: 'echo b', createdAt: 5, updatedAt: 5 },
        { name: 'no id', command: 'echo c' },
        null
      ],
      groups: [{ id: 'g', name: 'Real', createdAt: 1 }, { name: 'no id' }],
      history: 'not an array'
    });

    assert.strictEqual(data.groups.length, 1);
    assert.strictEqual(data.snippets.length, 2);
    assert.strictEqual(data.snippets[0].groupId, undefined);
    // A snippet without a name falls back to its command.
    assert.strictEqual(data.snippets[1].name, 'echo b');
    assert.strictEqual(data.snippets[0].updatedAt, 5);
    assert.deepStrictEqual(data.history, []);
  });
});

describe('migrateFromGlobalState', () => {
  class MemoryState implements StateStorage {
    private values = new Map<string, unknown>();

    constructor(seed?: Record<string, unknown>) {
      for (const [key, value] of Object.entries(seed ?? {})) {
        this.values.set(key, value);
      }
    }

    get<T>(key: string): T | undefined {
      return this.values.get(key) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        this.values.delete(key);
      } else {
        this.values.set(key, value);
      }
    }
  }

  const legacy = {
    'commandSnippets.data.v1': {
      version: 1,
      groups: [],
      history: [],
      snippets: [{ id: 'a', name: 'Legacy', command: 'echo legacy', createdAt: 1, updatedAt: 1 }]
    }
  };

  it('moves legacy state into the data file exactly once', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cs-migrate-'));
    const target = new FileStorage(path.join(dir, 'data.json'), 0);
    const state = new MemoryState(legacy);

    const first = await migrateFromGlobalState(state, target);
    assert.strictEqual(first.migrated, true);
    assert.strictEqual(first.snippets, 1);

    const store = new Store(target);
    assert.deepStrictEqual(store.getData().snippets.map((item) => item.name), ['Legacy']);

    // Second activation: nothing left to migrate, and nothing duplicated.
    const second = await migrateFromGlobalState(state, target);
    assert.strictEqual(second.migrated, false);
    assert.strictEqual(new Store(target).getData().snippets.length, 1);

    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});

describe('FileStorage', () => {
  it('round-trips data and survives a corrupt file', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cs-file-'));
    const file = path.join(dir, 'data.json');
    const doc = new FileStorage(file, 0);

    const store = new Store(doc);
    await store.addSnippet({ name: 'Persisted', command: 'echo p' });
    await doc.flush();

    assert.deepStrictEqual(new Store(new FileStorage(file, 0)).getData().snippets.map((s) => s.name), [
      'Persisted'
    ]);

    // A hand-edit that breaks the JSON must not throw, and must not destroy the file.
    await fs.promises.writeFile(file, '{ not json', 'utf8');
    const recovered = new Store(new FileStorage(file, 0));
    assert.strictEqual(recovered.getData().snippets.length, 0);
    const backups = (await fs.promises.readdir(dir)).filter((name) => name.includes('.corrupt-'));
    assert.strictEqual(backups.length, 1);

    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});
