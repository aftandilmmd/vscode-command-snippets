import { SnippetSource, SortKey, StoreData } from './types';

/** Messages sent from the webview to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'run'; snippetId: string }
  | { type: 'runCommand'; snippetName: string; command: string }
  | {
      type: 'createSnippet';
      name: string;
      command: string;
      description: string;
      groupId: string;
      source: SnippetSource;
    }
  | {
      type: 'updateSnippet';
      id: string;
      name: string;
      command: string;
      description: string;
      groupId: string;
      source: SnippetSource;
    }
  | { type: 'deleteSnippet'; id: string }
  | { type: 'moveSnippet'; id: string; groupId: string }
  | { type: 'createGroup'; name: string; source: SnippetSource }
  | { type: 'renameGroup'; id: string; name: string }
  | { type: 'deleteGroup'; id: string }
  | { type: 'saveHistoryEntry'; historyId: string }
  | { type: 'clearHistory' }
  | { type: 'copyCommand'; command: string }
  | { type: 'persistUi'; query: string; sort: SortKey; tab: 'snippets' | 'history'; collapsed: string[] };

/** Messages sent from the extension host to the webview. */
export type HostMessage =
  | { type: 'state'; data: StoreData; ui: UiState; hasWorkspace: boolean }
  | { type: 'focusNewSnippet' }
  | { type: 'focusNewGroup' }
  | { type: 'notice'; text: string };

export interface UiState {
  query: string;
  sort: SortKey;
  tab: 'snippets' | 'history';
  collapsed: string[];
}

export const DEFAULT_UI: UiState = { query: '', sort: 'name-asc', tab: 'snippets', collapsed: [] };

const SORT_KEYS: readonly SortKey[] = ['name-asc', 'name-desc', 'created', 'updated', 'lastRun'];

function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value);
}

function toSource(value: unknown): SnippetSource {
  return value === 'workspace' ? 'workspace' : 'global';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Runtime validation of anything arriving from the webview — no `any` shortcuts. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const message = raw as Record<string, unknown>;
  const str = (key: string): string => (typeof message[key] === 'string' ? (message[key] as string) : '');

  switch (message['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'run':
      return typeof message['snippetId'] === 'string' ? { type: 'run', snippetId: message['snippetId'] } : undefined;
    case 'runCommand':
      return str('command') === ''
        ? undefined
        : { type: 'runCommand', snippetName: str('snippetName'), command: str('command') };
    case 'createSnippet':
      return str('command') === ''
        ? undefined
        : {
            type: 'createSnippet',
            name: str('name'),
            command: str('command'),
            description: str('description'),
            groupId: str('groupId'),
            source: toSource(message['source'])
          };
    case 'updateSnippet':
      return str('id') === ''
        ? undefined
        : {
            type: 'updateSnippet',
            id: str('id'),
            name: str('name'),
            command: str('command'),
            description: str('description'),
            groupId: str('groupId'),
            source: toSource(message['source'])
          };
    case 'deleteSnippet':
      return str('id') === '' ? undefined : { type: 'deleteSnippet', id: str('id') };
    case 'moveSnippet':
      return str('id') === '' ? undefined : { type: 'moveSnippet', id: str('id'), groupId: str('groupId') };
    case 'createGroup':
      return str('name') === ''
        ? undefined
        : { type: 'createGroup', name: str('name'), source: toSource(message['source']) };
    case 'renameGroup':
      return str('id') === '' ? undefined : { type: 'renameGroup', id: str('id'), name: str('name') };
    case 'deleteGroup':
      return str('id') === '' ? undefined : { type: 'deleteGroup', id: str('id') };
    case 'saveHistoryEntry':
      return str('historyId') === '' ? undefined : { type: 'saveHistoryEntry', historyId: str('historyId') };
    case 'clearHistory':
      return { type: 'clearHistory' };
    case 'copyCommand':
      return str('command') === '' ? undefined : { type: 'copyCommand', command: str('command') };
    case 'persistUi':
      return {
        type: 'persistUi',
        query: str('query'),
        sort: isSortKey(message['sort']) ? message['sort'] : DEFAULT_UI.sort,
        tab: message['tab'] === 'history' ? 'history' : 'snippets',
        collapsed: isStringArray(message['collapsed']) ? message['collapsed'] : []
      };
    default:
      return undefined;
  }
}
