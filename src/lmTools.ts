import * as vscode from 'vscode';
import { SnippetSource, SortKey } from './types';
import { Store, filterSnippets, sortSnippets } from './store';

/**
 * The in-editor half of the AI integration: the same CRUD the MCP server exposes, registered
 * as Language Model Tools so Copilot agent mode can use it without any MCP setup.
 *
 * Running a snippet is deliberately absent here too — an agent may write snippets, never execute
 * them unattended.
 */

interface ListInput {
  query?: string;
  scope?: SnippetSource;
  sort?: SortKey;
}

interface CreateInput {
  name: string;
  command: string;
  description?: string;
  groupName?: string;
  scope?: SnippetSource;
}

interface UpdateInput {
  id: string;
  name?: string;
  command?: string;
  description?: string;
  groupName?: string;
  scope?: SnippetSource;
}

interface DeleteInput {
  id: string;
}

function text(payload: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))
  ]);
}

function summarize(store: Store, id: string): Record<string, unknown> {
  const snippet = store.getSnippet(id);
  if (!snippet) {
    return { id, missing: true };
  }
  return {
    id: snippet.id,
    name: snippet.name,
    command: snippet.command,
    description: snippet.description,
    group: snippet.groupId ? store.getGroup(snippet.groupId)?.name : undefined,
    scope: snippet.source ?? 'global'
  };
}

/** Resolves a group by name within a source, creating it when it does not exist yet. */
async function groupIdByName(
  store: Store,
  name: string | undefined,
  source: SnippetSource
): Promise<string | undefined> {
  if (!name || name.trim() === '') {
    return undefined;
  }
  const existing = store
    .getData()
    .groups.find(
      (group) =>
        (group.source ?? 'global') === source && group.name.toLowerCase() === name.trim().toLowerCase()
    );
  if (existing) {
    return existing.id;
  }
  return (await store.addGroup(name, source)).id;
}

export function registerLanguageModelTools(store: Store): vscode.Disposable[] {
  if (!vscode.lm || typeof vscode.lm.registerTool !== 'function') {
    return [];
  }

  return [
    vscode.lm.registerTool<ListInput>('commandSnippets_list', {
      async invoke(options) {
        const { query, scope, sort } = options.input;
        let snippets = store.getData().snippets;
        if (query) {
          snippets = filterSnippets(snippets, query);
        }
        if (scope) {
          snippets = snippets.filter((snippet) => (snippet.source ?? 'global') === scope);
        }
        const ordered = sortSnippets(snippets, sort ?? 'name-asc');
        return text({
          count: ordered.length,
          snippets: ordered.map((snippet) => summarize(store, snippet.id))
        });
      }
    }),

    vscode.lm.registerTool<CreateInput>('commandSnippets_create', {
      async invoke(options) {
        const { name, command, description, groupName, scope } = options.input;
        if (!command || command.trim() === '') {
          return text({ error: 'A command is required.' });
        }
        const source: SnippetSource = scope === 'workspace' && store.hasWorkspace ? 'workspace' : 'global';
        const groupId = await groupIdByName(store, groupName, source);
        const created = await store.addSnippet({ name, command, description, groupId, source });
        return text({ created: summarize(store, created.id) });
      }
    }),

    vscode.lm.registerTool<UpdateInput>('commandSnippets_update', {
      async invoke(options) {
        const { id, name, command, description, groupName, scope } = options.input;
        const snippet = store.getSnippet(id);
        if (!snippet) {
          return text({ error: `No snippet with id ${id}.` });
        }
        const source: SnippetSource =
          scope === 'workspace' && store.hasWorkspace ? 'workspace' : scope === 'global' ? 'global' : snippet.source ?? 'global';
        const groupId = groupName === undefined ? undefined : await groupIdByName(store, groupName, source);
        await store.updateSnippet(id, {
          name,
          command,
          description,
          groupId: groupName === undefined ? undefined : groupId ?? '',
          source
        });
        return text({ updated: summarize(store, id) });
      }
    }),

    vscode.lm.registerTool<DeleteInput>('commandSnippets_delete', {
      prepareInvocation(options) {
        const snippet = store.getSnippet(options.input.id);
        return {
          invocationMessage: `Deleting snippet "${snippet?.name ?? options.input.id}"`,
          confirmationMessages: {
            title: 'Delete snippet',
            message: new vscode.MarkdownString(
              `Delete **${snippet?.name ?? options.input.id}**?\n\n\`${snippet?.command ?? ''}\``
            )
          }
        };
      },
      async invoke(options) {
        const snippet = store.getSnippet(options.input.id);
        if (!snippet) {
          return text({ error: `No snippet with id ${options.input.id}.` });
        }
        await store.deleteSnippet(options.input.id);
        return text({ deleted: options.input.id, name: snippet.name });
      }
    })
  ];
}
