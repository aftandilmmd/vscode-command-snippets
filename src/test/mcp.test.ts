import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GLOBAL_DIR_NAME, RUNTIME_FILE, WORKSPACE_FILE_RELATIVE } from '../types';

const serverPath = path.resolve(__dirname, '..', '..', 'dist', 'mcp-server.js');

interface ToolText {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** Parses the JSON payload our tools return as their single text block. */
function payload(result: unknown): Record<string, unknown> {
  const text = (result as ToolText).content[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('MCP server', function () {
  this.timeout(20000);

  let home: string;
  let project: string;
  let client: Client;
  let transport: StdioClientTransport;

  const connect = async (): Promise<void> => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: project,
      env: { ...process.env, HOME: home, USERPROFILE: home } as Record<string, string>,
      stderr: 'ignore'
    });
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
  };

  beforeEach(async () => {
    home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cs-mcp-home-'));
    project = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cs-mcp-project-'));
    // A `.vscode` folder alone is not enough; the walk looks for the project file or a repo root.
    await fs.promises.mkdir(path.join(project, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await client?.close();
    await fs.promises.rm(home, { recursive: true, force: true });
    await fs.promises.rm(project, { recursive: true, force: true });
  });

  it('creates, lists and deletes snippets through tools', async () => {
    await connect();

    const created = payload(
      await client.callTool({ name: 'create_snippet', arguments: { name: 'Tests', command: 'npm test' } })
    );
    assert.strictEqual(created['name'], 'Tests');
    assert.strictEqual(created['scope'], 'global');

    const listed = payload(await client.callTool({ name: 'list_snippets', arguments: {} }));
    assert.strictEqual(listed['count'], 1);

    const filtered = payload(await client.callTool({ name: 'list_snippets', arguments: { query: 'nope' } }));
    assert.strictEqual(filtered['count'], 0);

    // The write really landed in the file the extension reads.
    const dataFile = path.join(home, GLOBAL_DIR_NAME, 'data.json');
    const onDisk = JSON.parse(await fs.promises.readFile(dataFile, 'utf8'));
    assert.strictEqual(onDisk.snippets.length, 1);
    assert.ok(!('source' in onDisk.snippets[0]));

    const deleted = payload(
      await client.callTool({ name: 'delete_snippet', arguments: { id: created['id'] } })
    );
    assert.strictEqual(deleted['deleted'], created['id']);
  });

  it('writes project snippets into the project file it discovered', async () => {
    await connect();

    const created = payload(
      await client.callTool({
        name: 'create_snippet',
        arguments: { name: 'Project', command: 'echo p', scope: 'workspace' }
      })
    );
    assert.strictEqual(created['scope'], 'workspace');

    const projectFile = path.join(project, ...WORKSPACE_FILE_RELATIVE.split('/'));
    const onDisk = JSON.parse(await fs.promises.readFile(projectFile, 'utf8'));
    assert.deepStrictEqual(
      onDisk.snippets.map((item: { name: string }) => item.name),
      ['Project']
    );
  });

  it('reports a missing snippet as an error instead of inventing one', async () => {
    await connect();
    const result = (await client.callTool({ name: 'get_snippet', arguments: { id: 'nope' } })) as ToolText;
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text ?? '', /No snippet with id nope/);
  });

  it('hides run_snippet when VS Code is not advertising allowRun', async () => {
    await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes('create_snippet'));
    assert.ok(!names.includes('run_snippet'), 'run_snippet must not exist without an explicit opt-in');
  });

  it('exposes run_snippet only once the extension says runs are allowed', async () => {
    await fs.promises.mkdir(path.join(home, GLOBAL_DIR_NAME), { recursive: true });
    await fs.promises.writeFile(
      path.join(home, GLOBAL_DIR_NAME, RUNTIME_FILE),
      JSON.stringify({ allowRun: true, version: '1.0.0', pid: 1, lastSeen: Date.now() }),
      'utf8'
    );

    await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('run_snippet'));
  });

  it('ignores a stale heartbeat from a VS Code that is gone', async () => {
    await fs.promises.mkdir(path.join(home, GLOBAL_DIR_NAME), { recursive: true });
    await fs.promises.writeFile(
      path.join(home, GLOBAL_DIR_NAME, RUNTIME_FILE),
      JSON.stringify({ allowRun: true, version: '1.0.0', pid: 1, lastSeen: Date.now() - 120_000 }),
      'utf8'
    );

    await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes('run_snippet'));
  });

  it('serves the whole list as one resource', async () => {
    await connect();
    await client.callTool({ name: 'create_snippet', arguments: { name: 'Tests', command: 'npm test' } });

    const resource = await client.readResource({ uri: 'snippets://all' });
    const first = resource.contents[0] as { text?: string };
    const body = JSON.parse(first.text ?? '{}');
    assert.strictEqual(body.snippets.length, 1);
    assert.strictEqual(body.snippets[0].name, 'Tests');
  });
});
