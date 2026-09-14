// @ts-check
/* Webview UI for Command Snippets. Vanilla DOM only.
   All user content is rendered with textContent / value, never innerHTML, so
   snippet names and commands cannot inject markup. */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const UNGROUPED = '__ungrouped__';

  /** @type {{ version: 1, snippets: any[], groups: any[], history: any[] }} */
  let data = { version: 1, snippets: [], groups: [], history: [] };
  let ui = { query: '', sort: 'name-asc', tab: 'snippets', collapsed: [] };
  /** @type {string|null} id of the snippet currently being edited */
  let editingId = null;
  /** The first `state` message seeds the UI; later ones must not clobber it. */
  let uiHydrated = false;
  /** False when no folder is open (or the project file is disabled): scope pickers stay hidden. */
  let hasWorkspace = false;

  const el = {
    tabSnippets: /** @type {HTMLButtonElement} */ (document.getElementById('tab-snippets')),
    tabHistory: /** @type {HTMLButtonElement} */ (document.getElementById('tab-history')),
    panelSnippets: /** @type {HTMLElement} */ (document.getElementById('panel-snippets')),
    panelHistory: /** @type {HTMLElement} */ (document.getElementById('panel-history')),
    search: /** @type {HTMLInputElement} */ (document.getElementById('search')),
    sort: /** @type {HTMLSelectElement} */ (document.getElementById('sort')),
    newToggle: /** @type {HTMLButtonElement} */ (document.getElementById('new-toggle')),
    newDropdown: /** @type {HTMLElement} */ (document.getElementById('new-dropdown')),
    newSnippet: /** @type {HTMLButtonElement} */ (document.getElementById('new-snippet')),
    newGroup: /** @type {HTMLButtonElement} */ (document.getElementById('new-group')),
    snippetForm: /** @type {HTMLFormElement} */ (document.getElementById('snippet-form')),
    formTitle: /** @type {HTMLElement} */ (document.getElementById('form-title')),
    formId: /** @type {HTMLInputElement} */ (document.getElementById('form-id')),
    formName: /** @type {HTMLInputElement} */ (document.getElementById('form-name')),
    formCommand: /** @type {HTMLTextAreaElement} */ (document.getElementById('form-command')),
    formDescription: /** @type {HTMLInputElement} */ (document.getElementById('form-description')),
    formScope: /** @type {HTMLSelectElement} */ (document.getElementById('form-scope')),
    formScopeLabel: /** @type {HTMLElement} */ (document.getElementById('form-scope-label')),
    formGroup: /** @type {HTMLSelectElement} */ (document.getElementById('form-group')),
    formCancel: /** @type {HTMLButtonElement} */ (document.getElementById('form-cancel')),
    groupForm: /** @type {HTMLFormElement} */ (document.getElementById('group-form')),
    groupName: /** @type {HTMLInputElement} */ (document.getElementById('group-name')),
    groupScope: /** @type {HTMLSelectElement} */ (document.getElementById('group-scope')),
    groupScopeLabel: /** @type {HTMLElement} */ (document.getElementById('group-scope-label')),
    groupCancel: /** @type {HTMLButtonElement} */ (document.getElementById('group-cancel')),
    snippetList: /** @type {HTMLElement} */ (document.getElementById('snippet-list')),
    historyList: /** @type {HTMLElement} */ (document.getElementById('history-list')),
    clearHistory: /** @type {HTMLButtonElement} */ (document.getElementById('clear-history'))
  };

  // ---------- helpers ----------

  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   */
  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  /**
   * @param {string} codicon
   * @param {string} title
   * @param {() => void} onClick
   */
  function iconButton(codicon, title, onClick) {
    const button = /** @type {HTMLButtonElement} */ (h('button', 'icon-btn'));
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.appendChild(h('span', 'codicon codicon-' + codicon));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  /** @param {number} ts */
  function relativeTime(ts) {
    const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (seconds < 60) {
      return seconds <= 5 ? 'just now' : seconds + ' sec ago';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return minutes + ' min ago';
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    }
    const days = Math.round(hours / 24);
    if (days < 30) {
      return days + (days === 1 ? ' day ago' : ' days ago');
    }
    return new Date(ts).toLocaleDateString();
  }

  /** @param {string} query */
  function matches(snippet, query) {
    const q = query.trim().toLowerCase();
    if (q === '') {
      return true;
    }
    return (
      snippet.name.toLowerCase().indexOf(q) !== -1 ||
      snippet.command.toLowerCase().indexOf(q) !== -1 ||
      (snippet.description || '').toLowerCase().indexOf(q) !== -1
    );
  }

  /** @param {any[]} snippets */
  function sorted(snippets) {
    const copy = snippets.slice();
    switch (ui.sort) {
      case 'name-desc':
        return copy.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: 'base' }));
      case 'created':
        return copy.sort((a, b) => b.createdAt - a.createdAt);
      case 'updated':
        return copy.sort((a, b) => b.updatedAt - a.updatedAt);
      case 'lastRun':
        return copy.sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
      default:
        return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }
  }

  function post(message) {
    vscode.postMessage(message);
  }

  let persistTimer = 0;

  function persistUi() {
    vscode.setState(ui);
    // Debounced: typing in the search box would otherwise write global state per keystroke.
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      post({
        type: 'persistUi',
        query: ui.query,
        sort: ui.sort,
        tab: ui.tab,
        collapsed: ui.collapsed
      });
    }, 250);
  }

  /** @param {string} groupId */
  function isCollapsed(groupId) {
    return ui.collapsed.indexOf(groupId) !== -1;
  }

  /** @param {string} groupId */
  function toggleCollapsed(groupId) {
    const index = ui.collapsed.indexOf(groupId);
    if (index === -1) {
      ui.collapsed.push(groupId);
    } else {
      ui.collapsed.splice(index, 1);
    }
    persistUi();
    renderSnippets();
  }

  // ---------- forms ----------

  /** @param {string} [source] when given, only groups of that source are listed */
  function fillGroupSelect(select, selectedId, source) {
    select.textContent = '';
    const ungrouped = document.createElement('option');
    ungrouped.value = '';
    ungrouped.textContent = 'Ungrouped';
    select.appendChild(ungrouped);

    const byName = (a, b) => a.name.localeCompare(b.name);
    const add = (group, parent) => {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = group.name;
      parent.appendChild(option);
    };

    if (source) {
      data.groups
        .filter((group) => (group.source || 'global') === source)
        .sort(byName)
        .forEach((group) => add(group, select));
    } else {
      // Move picker: both sources, labelled, so a move can also change scope.
      [['global', 'Global'], ['workspace', 'This project']].forEach((pair) => {
        const members = data.groups.filter((group) => (group.source || 'global') === pair[0]).sort(byName);
        if (members.length === 0) {
          return;
        }
        const optgroup = document.createElement('optgroup');
        optgroup.label = pair[1];
        members.forEach((group) => add(group, optgroup));
        select.appendChild(optgroup);
      });
    }
    select.value = selectedId || '';
  }

  /** @param {any} [snippet] */
  function openSnippetForm(snippet) {
    editingId = snippet ? snippet.id : null;
    el.groupForm.hidden = true;
    el.snippetForm.hidden = false;
    el.formTitle.textContent = snippet ? 'Edit snippet' : 'New snippet';
    el.formId.value = snippet ? snippet.id : '';
    el.formName.value = snippet ? snippet.name : '';
    el.formCommand.value = snippet ? snippet.command : '';
    el.formDescription.value = snippet && snippet.description ? snippet.description : '';
    el.formScope.value = (snippet && snippet.source) || 'global';
    fillGroupSelect(el.formGroup, snippet ? snippet.groupId || '' : '', el.formScope.value);
    el.formName.focus();
  }

  function closeSnippetForm() {
    editingId = null;
    el.snippetForm.hidden = true;
    el.snippetForm.reset();
  }

  function openGroupForm() {
    el.snippetForm.hidden = true;
    el.groupForm.hidden = false;
    el.groupName.value = '';
    el.groupScope.value = 'global';
    el.groupName.focus();
  }

  /** Scope pickers only make sense when there is a project file to write to. */
  function applyScopeVisibility() {
    el.formScope.hidden = !hasWorkspace;
    el.formScopeLabel.hidden = !hasWorkspace;
    el.groupScope.hidden = !hasWorkspace;
    el.groupScopeLabel.hidden = !hasWorkspace;
  }

  function closeGroupForm() {
    el.groupForm.hidden = true;
    el.groupForm.reset();
  }

  // ---------- rendering ----------

  function renderSnippetRow(snippet) {
    const row = h('div', 'snippet');

    const main = h('div', 'snippet-main');
    const name = h('div', 'snippet-name');
    name.appendChild(document.createTextNode(snippet.name));
    if (snippet.source === 'workspace') {
      const badge = h('span', 'badge', 'project');
      badge.title = 'Stored in .vscode/command-snippets.json';
      name.appendChild(badge);
    }
    name.title = snippet.name;
    main.appendChild(name);

    const command = h('div', 'snippet-command', snippet.command);
    command.title = snippet.command;
    main.appendChild(command);

    if (snippet.description) {
      const description = h('div', 'snippet-description', snippet.description);
      description.title = snippet.description;
      main.appendChild(description);
    }
    row.appendChild(main);

    const actions = h('div', 'snippet-actions');
    actions.appendChild(
      iconButton('play', 'Run in terminal', () => post({ type: 'run', snippetId: snippet.id }))
    );
    actions.appendChild(iconButton('copy', 'Copy command', () => post({ type: 'copyCommand', command: snippet.command })));
    actions.appendChild(iconButton('edit', 'Edit snippet', () => openSnippetForm(snippet)));
    actions.appendChild(
      iconButton('arrow-right', 'Move to group', () => {
        const select = row.querySelector('.move-select');
        if (select) {
          select.remove();
          return;
        }
        const picker = /** @type {HTMLSelectElement} */ (document.createElement('select'));
        picker.className = 'move-select';
        fillGroupSelect(picker, snippet.groupId || '', undefined);
        picker.addEventListener('change', () => {
          post({ type: 'moveSnippet', id: snippet.id, groupId: picker.value });
        });
        row.appendChild(picker);
        picker.focus();
      })
    );
    actions.appendChild(iconButton('trash', 'Delete snippet', () => post({ type: 'deleteSnippet', id: snippet.id })));
    row.appendChild(actions);

    row.addEventListener('dblclick', () => post({ type: 'run', snippetId: snippet.id }));
    return row;
  }

  function renderGroupSection(group, snippets) {
    const section = h('div', 'group');
    const collapsed = isCollapsed(group.id);

    const header = h('div', 'group-header');
    header.setAttribute('role', 'button');
    header.tabIndex = 0;
    header.appendChild(h('span', 'codicon codicon-chevron-' + (collapsed ? 'right' : 'down')));
    const title = h('span', 'group-title', group.name);
    title.title = group.name;
    header.appendChild(title);
    if (group.source === 'workspace') {
      header.appendChild(h('span', 'badge', 'project'));
    }
    header.appendChild(h('span', 'group-count', String(snippets.length)));

    if (group.id.indexOf(UNGROUPED) !== 0) {
      header.appendChild(
        iconButton('edit', 'Rename group', () => {
          const input = /** @type {HTMLInputElement} */ (document.createElement('input'));
          input.type = 'text';
          input.value = group.name;
          title.replaceWith(input);
          input.focus();
          input.select();
          const commit = () => {
            const value = input.value.trim();
            input.replaceWith(title);
            if (value !== '' && value !== group.name) {
              post({ type: 'renameGroup', id: group.id, name: value });
            }
          };
          input.addEventListener('blur', commit);
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              commit();
            } else if (event.key === 'Escape') {
              input.replaceWith(title);
            }
          });
          input.addEventListener('click', (event) => event.stopPropagation());
        })
      );
      header.appendChild(
        iconButton('trash', 'Delete group', () => post({ type: 'deleteGroup', id: group.id }))
      );
    }

    const toggle = () => toggleCollapsed(group.id);
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
    section.appendChild(header);

    if (!collapsed) {
      if (snippets.length === 0) {
        section.appendChild(h('div', 'empty', 'No snippets here'));
      } else {
        snippets.forEach((snippet) => section.appendChild(renderSnippetRow(snippet)));
      }
    }
    return section;
  }

  function renderSnippets() {
    el.snippetList.textContent = '';
    const visible = data.snippets.filter((snippet) => matches(snippet, ui.query));

    if (data.snippets.length === 0) {
      el.snippetList.appendChild(h('div', 'empty', 'No snippets yet. Click "New snippet" to add one.'));
      return;
    }
    if (visible.length === 0) {
      el.snippetList.appendChild(h('div', 'empty', 'No snippets match your search.'));
      return;
    }

    const groups = data.groups.slice().sort((a, b) => a.name.localeCompare(b.name));
    groups.forEach((group) => {
      const inGroup = sorted(visible.filter((snippet) => snippet.groupId === group.id));
      el.snippetList.appendChild(renderGroupSection(group, inGroup));
    });

    const ungrouped = sorted(visible.filter((snippet) => !snippet.groupId));
    if (hasWorkspace) {
      // Ungrouped splits per source so it stays obvious where a snippet lives.
      const projectUngrouped = ungrouped.filter((snippet) => snippet.source === 'workspace');
      if (projectUngrouped.length > 0) {
        el.snippetList.appendChild(
          renderGroupSection({ id: UNGROUPED + ':workspace', name: 'Ungrouped', source: 'workspace' }, projectUngrouped)
        );
      }
      el.snippetList.appendChild(
        renderGroupSection(
          { id: UNGROUPED, name: 'Ungrouped' },
          ungrouped.filter((snippet) => snippet.source !== 'workspace')
        )
      );
    } else {
      el.snippetList.appendChild(renderGroupSection({ id: UNGROUPED, name: 'Ungrouped' }, ungrouped));
    }
  }

  function renderHistory() {
    el.historyList.textContent = '';
    if (data.history.length === 0) {
      el.historyList.appendChild(h('div', 'empty', 'Nothing has been run yet.'));
      return;
    }
    data.history
      .slice()
      .sort((a, b) => b.ranAt - a.ranAt)
      .forEach((entry) => {
        const row = h('div', 'history-entry');
        const main = h('div', 'snippet-main');

        const name = h('div', 'snippet-name', entry.snippetName);
        name.title = entry.snippetName;
        main.appendChild(name);

        const command = h('div', 'snippet-command', entry.command);
        command.title = entry.command;
        main.appendChild(command);

        const time = h('div', 'history-time', relativeTime(entry.ranAt));
        time.title = new Date(entry.ranAt).toLocaleString();
        main.appendChild(time);
        row.appendChild(main);

        const actions = h('div', 'snippet-actions');
        actions.appendChild(
          iconButton('debug-restart', 'Re-run', () =>
            post({ type: 'runCommand', snippetName: entry.snippetName, command: entry.command })
          )
        );
        actions.appendChild(
          iconButton('save', 'Save as snippet', () => post({ type: 'saveHistoryEntry', historyId: entry.id }))
        );
        actions.appendChild(
          iconButton('copy', 'Copy command', () => post({ type: 'copyCommand', command: entry.command }))
        );
        row.appendChild(actions);
        el.historyList.appendChild(row);
      });
  }

  function renderTabs() {
    const snippetsActive = ui.tab === 'snippets';
    el.tabSnippets.classList.toggle('active', snippetsActive);
    el.tabHistory.classList.toggle('active', !snippetsActive);
    el.panelSnippets.hidden = !snippetsActive;
    el.panelHistory.hidden = snippetsActive;
  }

  function render() {
    renderTabs();
    if (el.search.value !== ui.query) {
      el.search.value = ui.query;
    }
    el.sort.value = ui.sort;
    renderSnippets();
    renderHistory();
    if (!el.snippetForm.hidden && editingId) {
      // Keep the group dropdown of an open edit form in sync with group changes.
      const current = el.formGroup.value;
      fillGroupSelect(el.formGroup, current, el.formScope.value);
    }
  }

  // ---------- events ----------

  el.tabSnippets.addEventListener('click', () => {
    ui.tab = 'snippets';
    persistUi();
    renderTabs();
  });

  el.tabHistory.addEventListener('click', () => {
    ui.tab = 'history';
    persistUi();
    renderTabs();
    renderHistory();
  });

  el.search.addEventListener('input', () => {
    ui.query = el.search.value;
    persistUi();
    renderSnippets();
  });

  el.sort.addEventListener('change', () => {
    ui.sort = el.sort.value;
    persistUi();
    renderSnippets();
  });

  /** @param {boolean} open */
  function setNewMenu(open) {
    el.newDropdown.hidden = !open;
    el.newToggle.setAttribute('aria-expanded', String(open));
  }

  el.formScope.addEventListener('change', () => {
    fillGroupSelect(el.formGroup, '', el.formScope.value);
  });

  el.newToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setNewMenu(el.newDropdown.hidden);
  });

  el.newSnippet.addEventListener('click', () => {
    setNewMenu(false);
    openSnippetForm(undefined);
  });

  el.newGroup.addEventListener('click', () => {
    setNewMenu(false);
    openGroupForm();
  });

  document.addEventListener('click', (event) => {
    if (!el.newDropdown.hidden && !(event.target instanceof Node && el.newDropdown.parentElement.contains(event.target))) {
      setNewMenu(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.newDropdown.hidden) {
      setNewMenu(false);
      el.newToggle.focus();
    }
  });
  el.formCancel.addEventListener('click', closeSnippetForm);
  el.groupCancel.addEventListener('click', closeGroupForm);

  el.snippetForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const command = el.formCommand.value.trim();
    if (command === '') {
      el.formCommand.focus();
      return;
    }
    const payload = {
      name: el.formName.value,
      command: command,
      description: el.formDescription.value,
      groupId: el.formGroup.value,
      source: hasWorkspace ? el.formScope.value : 'global'
    };
    if (editingId) {
      post(Object.assign({ type: 'updateSnippet', id: editingId }, payload));
    } else {
      post(Object.assign({ type: 'createSnippet' }, payload));
    }
    closeSnippetForm();
  });

  el.groupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = el.groupName.value.trim();
    if (name === '') {
      el.groupName.focus();
      return;
    }
    post({ type: 'createGroup', name: name, source: hasWorkspace ? el.groupScope.value : 'global' });
    closeGroupForm();
  });

  el.clearHistory.addEventListener('click', () => post({ type: 'clearHistory' }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'state':
        data = message.data;
        hasWorkspace = message.hasWorkspace === true;
        applyScopeVisibility();
        if (!uiHydrated) {
          // The webview owns UI state once it is live; only seed it on the first push
          // so a store change never resets a search the user is in the middle of typing.
          ui = Object.assign({}, ui, message.ui);
          uiHydrated = true;
        }
        render();
        break;
      case 'focusNewSnippet':
        setNewMenu(false);
        ui.tab = 'snippets';
        renderTabs();
        openSnippetForm(undefined);
        break;
      case 'focusNewGroup':
        setNewMenu(false);
        ui.tab = 'snippets';
        renderTabs();
        openGroupForm();
        break;
      default:
        break;
    }
  });

  const restored = vscode.getState();
  if (restored) {
    ui = Object.assign(ui, restored);
    uiHydrated = true;
  }
  applyScopeVisibility();
  render();
  post({ type: 'ready' });

  // Keep relative timestamps fresh without re-rendering everything.
  setInterval(() => {
    if (ui.tab === 'history') {
      renderHistory();
    }
  }, 30000);
})();
