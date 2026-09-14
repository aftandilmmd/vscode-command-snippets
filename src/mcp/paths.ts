import * as fs from 'fs';
import * as path from 'path';
import { globalDir, workspaceDataPath } from '../storage/fileStorage';
import { RUNS_DIR, RUNTIME_FILE, WORKSPACE_FILE_RELATIVE } from '../types';

export function runtimePath(): string {
  return path.join(globalDir(), RUNTIME_FILE);
}

export function runsDir(): string {
  return path.join(globalDir(), RUNS_DIR);
}

/**
 * Finds the project file the MCP server should use.
 *
 * Order: an explicit `--workspace <dir>` argument, then `COMMAND_SNIPPETS_WORKSPACE`, then a
 * walk up from the working directory looking for an existing project file and, failing that,
 * the nearest repository root.
 */
export function resolveWorkspaceFile(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const flagIndex = argv.indexOf('--workspace');
  const explicit = flagIndex !== -1 ? argv[flagIndex + 1] : env['COMMAND_SNIPPETS_WORKSPACE'];
  if (explicit) {
    return path.isAbsolute(explicit) ? workspaceDataPath(explicit) : workspaceDataPath(path.resolve(cwd, explicit));
  }

  let dir = path.resolve(cwd);
  let repoRoot: string | undefined;
  for (;;) {
    if (fs.existsSync(path.join(dir, ...WORKSPACE_FILE_RELATIVE.split('/')))) {
      return workspaceDataPath(dir);
    }
    if (!repoRoot && fs.existsSync(path.join(dir, '.git'))) {
      repoRoot = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return repoRoot ? workspaceDataPath(repoRoot) : undefined;
}
