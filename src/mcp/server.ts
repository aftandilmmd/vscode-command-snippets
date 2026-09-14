import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FileStorage, globalDataPath } from '../storage/fileStorage';
import { Store, filterSnippets, sortSnippets } from '../store';
import { Snippet, SnippetSource, SortKey } from '../types';
import { resolveWorkspaceFile } from './paths';
import { requestRun } from './runBridge';
import { readRuntime, runAllowed } from './runtime';

const SORT_KEYS = ['name-asc', 'name-desc', 'created', 'updated', 'lastRun'] as const;

const globalDoc = new FileStorage(globalDataPath(), 0);
const workspaceFile = resolveWorkspaceFile(process.argv, process.env, process.cwd());
const workspaceDoc = workspaceFile ? new FileStorage(workspaceFile, 0) : undefined;
const store = new Store(globalDoc, workspaceDoc);

/** Both files may have changed since the last call — this process is not their only writer. */
function fresh(): Store {
  store.reload();
  return store;
}

async function flush(): Promise<void> {
  await globalDoc.flush();
  await workspaceDoc?.flush();
}

/** Shape handed back to the model: flat, quotable, no internals. */
function describe(snippet: Snippet): Record<string, unknown> {
  return {
    id: snippet.id,
    name: snippet.name,
    command: snippet.command,
    description: snippet.description,
    group: snippet.groupId ? store.getGroup(snippet.groupId)?.name : undefined,
    groupId: snippet.groupId,
    scope: snippet.source ?? 'global',
    createdAt: new Date(snippet.createdAt).toISOString(),
    updatedAt: new Date(snippet.updatedAt).toISOString(),
    lastRunAt: snippet.lastRunAt ? new Date(snippet.lastRunAt).toISOString() : undefined
  };
}

function ok(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const scopeSchema = z
  .enum(['global', 'workspace'])
  .describe('Which file to write to: "global" (~/.command-snippets/data.json) or "workspace" (this project\'s .vscode/command-snippets.json).');

const server = new McpServer(
  { name: 'command-snippets', version: '1.0.0' },
  {
    instructions:
      'Manages the user\'s saved terminal commands ("snippets") for the Command Snippets VS Code extension. ' +
      'Snippets live either globally or in the current project. Read snippets://all for the full list in one shot. ' +
      'Creating and editing snippets never executes anything.'
  }
);

server.registerResource(
  'all-snippets',
  'snippets://all',
  {
    title: 'All snippets',
    description: 'Every snippet and group, global and project, as JSON.',
    mimeType: 'application/json'
  },
  async (uri) => {
    const data = fresh().getData();
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              workspaceFile: workspaceFile ?? null,
              groups: data.groups.map((group) => ({
                id: group.id,
                name: group.name,
                scope: group.source ?? 'global'
              })),
              snippets: data.snippets.map(describe)
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.registerTool(
  'list_snippets',
  {
    title: 'List snippets',
    description: 'Lists saved snippets, optionally filtered by text, group or scope.',
    inputSchema: {
      query: z.string().optional().describe('Case-insensitive match over name, command and description.'),
      groupId: z.string().optional(),
      scope: z.enum(['global', 'workspace']).optional(),
      sort: z.enum(SORT_KEYS).optional().describe('Default: name-asc.')
    },
    annotations: { readOnlyHint: true }
  },
  async ({ query, groupId, scope, sort }) => {
    let snippets = fresh().getData().snippets;
    if (query) {
      snippets = filterSnippets(snippets, query);
    }
    if (groupId) {
      snippets = snippets.filter((snippet) => snippet.groupId === groupId);
    }
    if (scope) {
      snippets = snippets.filter((snippet) => (snippet.source ?? 'global') === scope);
    }
    const sorted = sortSnippets(snippets, (sort ?? 'name-asc') as SortKey);
    return ok({ count: sorted.length, snippets: sorted.map(describe) });
  }
);

server.registerTool(
  'get_snippet',
  {
    title: 'Get snippet',
    description: 'Returns one snippet by id.',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true }
  },
  async ({ id }) => {
    const snippet = fresh().getSnippet(id);
    return snippet ? ok(describe(snippet)) : fail(`No snippet with id ${id}.`);
  }
);

server.registerTool(
  'create_snippet',
  {
    title: 'Create snippet',
    description: 'Saves a new snippet. Does not run anything.',
    inputSchema: {
      name: z.string().describe('Short label shown in the sidebar.'),
      command: z.string().describe('The shell command to save.'),
      description: z.string().optional(),
      groupId: z.string().optional(),
      scope: scopeSchema.optional()
    }
  },
  async ({ name, command, description, groupId, scope }) => {
    if (scope === 'workspace' && !workspaceDoc) {
      return fail('No project file is available here. Run the server from inside the project, or use scope "global".');
    }
    const created = await fresh().addSnippet({
      name,
      command,
      description,
      groupId,
      source: scope as SnippetSource | undefined
    });
    await flush();
    return ok(describe(created));
  }
);

server.registerTool(
  'update_snippet',
  {
    title: 'Update snippet',
    description: 'Changes fields of an existing snippet. Omitted fields are left alone.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      command: z.string().optional(),
      description: z.string().optional(),
      groupId: z.string().optional().describe('Empty string moves the snippet to Ungrouped.'),
      scope: scopeSchema.optional().describe('Moves the snippet to the other file, keeping its id.')
    }
  },
  async ({ id, name, command, description, groupId, scope }) => {
    const store = fresh();
    if (!store.getSnippet(id)) {
      return fail(`No snippet with id ${id}.`);
    }
    await store.updateSnippet(id, {
      name,
      command,
      description,
      groupId,
      source: scope as SnippetSource | undefined
    });
    await flush();
    const updated = store.getSnippet(id);
    return updated ? ok(describe(updated)) : fail(`Snippet ${id} disappeared while updating.`);
  }
);

server.registerTool(
  'delete_snippet',
  {
    title: 'Delete snippet',
    description: 'Deletes one snippet permanently.',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true }
  },
  async ({ id }) => {
    const store = fresh();
    const snippet = store.getSnippet(id);
    if (!snippet) {
      return fail(`No snippet with id ${id}.`);
    }
    await store.deleteSnippet(id);
    await flush();
    return ok({ deleted: id, name: snippet.name });
  }
);

server.registerTool(
  'move_snippet',
  {
    title: 'Move snippet',
    description: 'Moves a snippet to another group and/or between the global and project files.',
    inputSchema: {
      id: z.string(),
      groupId: z.string().optional().describe('Omit or pass an empty string for Ungrouped.'),
      scope: scopeSchema.optional()
    }
  },
  async ({ id, groupId, scope }) => {
    const store = fresh();
    if (!store.getSnippet(id)) {
      return fail(`No snippet with id ${id}.`);
    }
    await store.moveSnippet(id, groupId || undefined, scope as SnippetSource | undefined);
    await flush();
    const moved = store.getSnippet(id);
    return moved ? ok(describe(moved)) : fail(`Snippet ${id} disappeared while moving.`);
  }
);

server.registerTool(
  'list_groups',
  {
    title: 'List groups',
    description: 'Lists snippet groups with their scope and snippet count.',
    annotations: { readOnlyHint: true }
  },
  async () => {
    const data = fresh().getData();
    return ok({
      groups: data.groups.map((group) => ({
        id: group.id,
        name: group.name,
        scope: group.source ?? 'global',
        snippets: data.snippets.filter((snippet) => snippet.groupId === group.id).length
      }))
    });
  }
);

server.registerTool(
  'create_group',
  {
    title: 'Create group',
    description: 'Creates a snippet group.',
    inputSchema: { name: z.string(), scope: scopeSchema.optional() }
  },
  async ({ name, scope }) => {
    if (scope === 'workspace' && !workspaceDoc) {
      return fail('No project file is available here. Use scope "global".');
    }
    const group = await fresh().addGroup(name, scope as SnippetSource | undefined);
    await flush();
    return ok({ id: group.id, name: group.name, scope: group.source ?? 'global' });
  }
);

server.registerTool(
  'rename_group',
  {
    title: 'Rename group',
    description: 'Renames a group.',
    inputSchema: { id: z.string(), name: z.string() }
  },
  async ({ id, name }) => {
    const store = fresh();
    if (!store.getGroup(id)) {
      return fail(`No group with id ${id}.`);
    }
    await store.renameGroup(id, name);
    await flush();
    return ok({ id, name });
  }
);

server.registerTool(
  'delete_group',
  {
    title: 'Delete group',
    description: 'Deletes a group. Its snippets are kept and become Ungrouped.',
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true }
  },
  async ({ id }) => {
    const store = fresh();
    const group = store.getGroup(id);
    if (!group) {
      return fail(`No group with id ${id}.`);
    }
    await store.deleteGroup(id);
    await flush();
    return ok({ deleted: id, name: group.name, snippetsKept: true });
  }
);

server.registerTool(
  'get_history',
  {
    title: 'Get run history',
    description: 'Recent snippet runs, newest first.',
    inputSchema: { limit: z.number().int().min(1).max(500).optional().describe('Default 20.') },
    annotations: { readOnlyHint: true }
  },
  async ({ limit }) => {
    const history = fresh().getData().history.slice(0, limit ?? 20);
    return ok({
      count: history.length,
      history: history.map((entry) => ({
        id: entry.id,
        snippetId: entry.snippetId,
        name: entry.snippetName,
        command: entry.command,
        ranAt: new Date(entry.ranAt).toISOString()
      }))
    });
  }
);

// Registered only when VS Code is running AND the user turned on commandSnippets.mcp.allowRun.
// It takes a snippet id, never a free-form command, and every run still needs a click in VS Code.
if (runAllowed()) {
  server.registerTool(
    'run_snippet',
    {
      title: 'Run snippet',
      description:
        'Asks VS Code to run a saved snippet in its terminal. The user must confirm the run in VS Code; ' +
        'only snippets that already exist can be run.',
      inputSchema: { id: z.string().describe('Id of an existing snippet.') },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ id }) => {
      const snippet = fresh().getSnippet(id);
      if (!snippet) {
        return fail(`No snippet with id ${id}.`);
      }
      if (!runAllowed()) {
        return fail('VS Code is no longer accepting run requests.');
      }
      const result = await requestRun(id, { client: 'mcp' });
      if (result.status === 'ran') {
        return ok({ ran: id, name: snippet.name, command: snippet.command });
      }
      if (result.status === 'denied') {
        return fail(`The user declined to run "${snippet.name}".`);
      }
      return fail(result.message ?? 'The run could not be completed.');
    }
  );
}

async function main(): Promise<void> {
  const runtime = readRuntime();
  // stderr is the only channel that will not corrupt the stdio protocol.
  console.error(
    `[command-snippets] global=${globalDataPath()} workspace=${workspaceFile ?? 'none'} ` +
      `vscode=${runtime ? `running (allowRun=${runtime.allowRun})` : 'not running'}`
  );
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error('[command-snippets] fatal:', error);
  process.exit(1);
});
