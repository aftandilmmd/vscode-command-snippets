import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runsDir } from '../mcp/paths';
import { RunRequest, readJson, requestRun, resultPath, sweepStaleRuns, writeRunResult } from '../mcp/runBridge';
import { runAllowed } from '../mcp/runtime';
import { GLOBAL_DIR_NAME, RUNTIME_FILE } from '../types';

describe('run handshake', function () {
  this.timeout(10000);

  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cs-run-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  const writeRuntime = async (patch: Record<string, unknown>): Promise<void> => {
    await fs.promises.mkdir(path.join(home, GLOBAL_DIR_NAME), { recursive: true });
    await fs.promises.writeFile(
      path.join(home, GLOBAL_DIR_NAME, RUNTIME_FILE),
      JSON.stringify({ allowRun: true, version: '1.0.0', pid: 1, lastSeen: Date.now(), ...patch }),
      'utf8'
    );
  };

  it('treats a missing or stale runtime file as "runs not allowed"', async () => {
    assert.strictEqual(runAllowed(), false);

    await writeRuntime({ lastSeen: Date.now() - 120_000 });
    assert.strictEqual(runAllowed(), false);

    await writeRuntime({ allowRun: false });
    assert.strictEqual(runAllowed(), false);

    await writeRuntime({});
    assert.strictEqual(runAllowed(), true);
  });

  it('resolves once VS Code writes the result, and cleans both files up', async () => {
    const answering = (async () => {
      // Stand in for the extension: wait for the request, then approve it.
      for (let i = 0; i < 50; i++) {
        let entries: string[] = [];
        try {
          entries = await fs.promises.readdir(runsDir());
        } catch {
          entries = [];
        }
        const pending = entries.find((name) => !name.endsWith('.result.json') && name.endsWith('.json'));
        if (pending) {
          const request = readJson<RunRequest>(path.join(runsDir(), pending));
          assert.ok(request);
          assert.strictEqual(request.snippetId, 'snippet-1');
          await writeRunResult({ id: request.id, status: 'ran', at: Date.now() });
          return request.id;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('no run request appeared');
    })();

    const result = await requestRun('snippet-1', { timeoutMs: 5000, pollMs: 20 });
    const id = await answering;

    assert.strictEqual(result.status, 'ran');
    assert.strictEqual(fs.existsSync(resultPath(id)), false);
    assert.deepStrictEqual(await fs.promises.readdir(runsDir()), []);
  });

  it('times out with a clear message when nobody answers', async () => {
    const result = await requestRun('snippet-1', { timeoutMs: 300, pollMs: 50 });
    assert.strictEqual(result.status, 'error');
    assert.match(result.message ?? '', /did not answer/);
    // The abandoned request must not pile up.
    assert.deepStrictEqual(await fs.promises.readdir(runsDir()), []);
  });

  it('sweeps requests left behind by a crashed process', async () => {
    await fs.promises.mkdir(runsDir(), { recursive: true });
    const stale = path.join(runsDir(), 'stale.json');
    await fs.promises.writeFile(stale, '{}', 'utf8');
    const old = Date.now() - 10 * 60_000;
    await fs.promises.utimes(stale, old / 1000, old / 1000);

    await sweepStaleRuns();
    assert.strictEqual(fs.existsSync(stale), false);
  });
});
