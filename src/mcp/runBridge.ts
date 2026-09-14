import * as fs from 'fs';
import * as path from 'path';
import { runsDir } from './paths';

export interface RunRequest {
  id: string;
  snippetId: string;
  requestedAt: number;
  client?: string;
}

export interface RunResult {
  id: string;
  status: 'ran' | 'denied' | 'error';
  message?: string;
  at: number;
}

export const RUN_TIMEOUT_MS = 30_000;
/** Requests and results older than this are swept on the next pass. */
export const RUN_TTL_MS = 5 * 60_000;

export function requestPath(id: string): string {
  return path.join(runsDir(), `${id}.json`);
}

export function resultPath(id: string): string {
  return path.join(runsDir(), `${id}.result.json`);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, file);
}

export async function writeRunRequest(request: RunRequest): Promise<void> {
  await writeJson(requestPath(request.id), request);
}

export async function writeRunResult(result: RunResult): Promise<void> {
  await writeJson(resultPath(result.id), result);
}

/** Removes the request/result pair for one run. */
export async function clearRun(id: string): Promise<void> {
  await Promise.all(
    [requestPath(id), resultPath(id)].map((file) => fs.promises.rm(file, { force: true }))
  );
}

/** Drops anything left behind by a crashed process or an unanswered prompt. */
export async function sweepStaleRuns(now = Date.now(), ttlMs = RUN_TTL_MS): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(runsDir());
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (name) => {
      const file = path.join(runsDir(), name);
      try {
        const stat = await fs.promises.stat(file);
        if (now - stat.mtimeMs > ttlMs) {
          await fs.promises.rm(file, { force: true });
        }
      } catch {
        // Raced with another process; nothing to do.
      }
    })
  );
}

/**
 * Asks the extension to run a snippet and waits for its answer.
 *
 * This is the MCP side of the handshake: the agent never executes anything itself, it only
 * leaves a request that a human has to approve inside VS Code.
 */
export async function requestRun(
  snippetId: string,
  options: { client?: string; timeoutMs?: number; pollMs?: number } = {}
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 200;
  const id = globalThis.crypto.randomUUID();

  await sweepStaleRuns();
  await writeRunRequest({ id, snippetId, requestedAt: Date.now(), client: options.client });

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const result = readJson<RunResult>(resultPath(id));
      if (result) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return {
      id,
      status: 'error',
      message: 'VS Code did not answer within 30s. Is the Command Snippets sidebar still open?',
      at: Date.now()
    };
  } finally {
    await clearRun(id);
  }
}
