import * as fs from 'fs';
import { StateStorage, normalize } from '../store';
import { MIGRATED_KEY, STORAGE_KEY, StoreData } from '../types';
import { FileStorage } from './fileStorage';

export interface MigrationResult {
  migrated: boolean;
  snippets: number;
}

/**
 * Moves data written by earlier versions out of `globalState` and into
 * `~/.command-snippets/data.json`. Runs at most once, and never overwrites an existing
 * data file — if one is already there, it wins and the old state is simply dropped.
 */
export async function migrateFromGlobalState(
  state: StateStorage,
  target: FileStorage
): Promise<MigrationResult> {
  if (state.get<boolean>(MIGRATED_KEY) === true) {
    return { migrated: false, snippets: 0 };
  }

  const legacy = state.get<StoreData>(STORAGE_KEY);
  const data = normalize(legacy);
  const hasLegacyData = data.snippets.length > 0 || data.groups.length > 0 || data.history.length > 0;

  if (hasLegacyData && !fs.existsSync(target.filePath)) {
    await target.save({
      version: 1,
      snippets: data.snippets.map(({ source: _source, ...rest }) => rest),
      groups: data.groups.map(({ source: _source, ...rest }) => rest),
      history: data.history
    });
    await target.flush();
  }

  await state.update(STORAGE_KEY, undefined);
  await state.update(MIGRATED_KEY, true);
  return { migrated: hasLegacyData, snippets: data.snippets.length };
}
