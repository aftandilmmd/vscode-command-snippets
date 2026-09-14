import * as assert from 'assert';
import { StateStorage, Store, filterSnippets, normalize, sortSnippets } from '../store';
import { MAX_HISTORY, Snippet, STORAGE_KEY, StoreData } from '../types';

class MemoryStorage implements StateStorage {
  private values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    // Round-trip through JSON the way globalState does, so tests catch
    // anything that would not survive persistence.
    this.values.set(key, JSON.parse(JSON.stringify(value)));
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
    const store = new Store(new MemoryStorage());
    const group = await store.addGroup('Build');
    const created = await store.addSnippet({ name: 'Build', command: 'npm run build' });
    assert.strictEqual(created.groupId, undefined);

    await store.moveSnippet(created.id, group.id);
    assert.strictEqual(store.getSnippet(created.id)?.groupId, group.id);

    await store.moveSnippet(created.id, undefined);
    assert.strictEqual(store.getSnippet(created.id)?.groupId, undefined);
  });

  it('ignores a move to an unknown group and falls back to Ungrouped', async () => {
    const store = new Store(new MemoryStorage());
    const group = await store.addGroup('Build');
    const created = await store.addSnippet({ name: 'Build', command: 'npm run build', groupId: group.id });

    await store.moveSnippet(created.id, 'does-not-exist');
    assert.strictEqual(store.getSnippet(created.id)?.groupId, undefined);
  });

  it('deleting a group keeps its snippets and ungroups them', async () => {
    const store = new Store(new MemoryStorage());
    const group = await store.addGroup('Build');
    const kept = await store.addSnippet({ name: 'Build', command: 'npm run build', groupId: group.id });

    await store.deleteGroup(group.id);
    assert.strictEqual(store.getData().groups.length, 0);
    assert.strictEqual(store.getData().snippets.length, 1);
    assert.strictEqual(store.getSnippet(kept.id)?.groupId, undefined);
  });

  it('emits a change event on every mutation', async () => {
    const store = new Store(new MemoryStorage());
    let fired = 0;
    store.onDidChange(() => void fired++);
    await store.addGroup('Build');
    await store.addSnippet({ name: 'Build', command: 'npm run build' });
    assert.strictEqual(fired, 2);
  });
});

describe('Store: history', () => {
  it('records runs newest first and stamps lastRunAt', async () => {
    const store = new Store(new MemoryStorage());
    const created = await store.addSnippet({ name: 'Test', command: 'npm test' });

    await store.addHistory({ id: created.id, name: created.name, command: created.command });
    await store.addHistory({ name: 'ad hoc', command: 'ls -la' });

    const history = store.getData().history;
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].command, 'ls -la');
    assert.ok((store.getSnippet(created.id)?.lastRunAt ?? 0) > 0);
  });

  it('caps history at MAX_HISTORY entries', async () => {
    const store = new Store(new MemoryStorage());
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      await store.addHistory({ name: `run ${i}`, command: `echo ${i}` });
    }
    assert.strictEqual(store.getData().history.length, MAX_HISTORY);
    assert.strictEqual(store.getData().history[0].command, `echo ${MAX_HISTORY + 9}`);
  });

  it('clears history', async () => {
    const store = new Store(new MemoryStorage());
    await store.addHistory({ name: 'run', command: 'echo hi' });
    await store.clearHistory();
    assert.strictEqual(store.getData().history.length, 0);
  });
});

describe('Store: persistence and import', () => {
  it('reloads persisted data from storage', async () => {
    const storage = new MemoryStorage();
    const first = new Store(storage);
    const group = await first.addGroup('Build');
    await first.addSnippet({ name: 'Build', command: 'npm run build', groupId: group.id });

    const second = new Store(storage);
    assert.strictEqual(second.getData().snippets.length, 1);
    assert.strictEqual(second.getData().snippets[0].groupId, group.id);
    assert.ok(storage.get<StoreData>(STORAGE_KEY));
  });

  it('merges an import by id and keeps existing entries unless overwriting', async () => {
    const store = new Store(new MemoryStorage());
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
