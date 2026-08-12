'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const load = Module._load;
const executedCommands = [];
let mergeEditor = false;
let fullRefName;
let RepositoryViewProvider;
let html;
let git;
let openDiff;
try {
  Module._load = (request, parent, isMain) =>
    request === 'vscode'
      ? {
          commands: { executeCommand: async (...args) => executedCommands.push(args) },
          window: { showErrorMessage: async () => {} },
          workspace: { getConfiguration: (section) => ({
            get: (key, fallback) => section === 'git' && key === 'mergeEditor'
              ? mergeEditor
              : fallback,
          }) },
        }
      : load(request, parent, isMain);
  ({ fullRefName, html, openDiff, RepositoryViewProvider } = require('../extension'));
  git = require('../git-operations');
} finally {
  Module._load = load;
}

test('waits for the Git API before rendering repositories', async () => {
  const posts = [];
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { state: 'uninitialized', repositories: [] },
    dirtyStats: new Set(),
    expanded: new Set(),
    expansionTouched: new Set(),
    noVerify: new Set(),
    repositoryOrder: [],
    stats: new Map(),
    viewMode: 'list',
    view: { webview: { postMessage: async (message) => posts.push(message) } },
  });

  await provider.refresh();
  assert.equal(posts.at(-1).loading, true);

  provider.api = {
    state: 'initialized',
    repositories: [{
      rootUri: { fsPath: '/repo' },
      state: {
        HEAD: { name: 'main' },
        indexChanges: [],
        mergeChanges: [],
        untrackedChanges: [],
        workingTreeChanges: [],
      },
    }],
  };
  await provider.refresh();

  assert.equal(posts.at(-1).loading, false);
  assert.equal(posts.at(-1).repositories[0].name, 'repo');
});

test('generates valid webview JavaScript', () => {
  const markup = html();
  const script = markup.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(script, /\.title\s*=/);
  assert.match(markup, /\.custom-tooltip \{/);
  assert.match(markup, /\.file-name \{ flex: none; \}/);
  assert.match(markup, /directory\.dataset\.tooltip = (node|file)\.directory/);
  assert.match(markup, /Resolve all conflicts with AI/);
  assert.match(markup, /type: 'resolveConflicts'/);
  assert.match(markup, /\? 'Conflicted'/);
  assert.match(markup, /repository\.hasConflicts \? '!' : ''/);
  assert.match(markup, /icon\(repository\.operation, 'icon repo-operation'/);
  assert.match(markup, /expanded && repository\.expandable/);
  assert.match(markup, /section\.inert = Boolean\(progressLabel\)/);
  assert.match(markup, /section\.setAttribute\('aria-busy'/);
  assert.match(markup, /\.graph-date \{ min-width: max-content;/);
  assert.match(markup, /if \(scrollTop !== undefined\) list\.scrollTop = scrollTop;/);
});

test('exposes separate AI controls with a shared provider', () => {
  const properties = require('../package.json').contributes.configuration.properties;
  assert.ok(properties['gitChangeStats.provider']);
  assert.ok(properties['gitChangeStats.model']);
  assert.ok(properties['gitChangeStats.reasoningEffort']);
  assert.ok(properties['gitChangeStats.conflictModel']);
  assert.ok(properties['gitChangeStats.conflictReasoningEffort']);
});

test('opens content conflicts through the native Git editor route', async () => {
  const uri = { fsPath: '/repo/conflict.js' };
  const repository = { rootUri: { fsPath: '/repo' } };
  executedCommands.length = 0;

  await openDiff({}, repository, 'unstaged', { status: 18, uri });
  assert.deepEqual(executedCommands.pop(), ['vscode.open', uri, { override: false }]);

  mergeEditor = true;
  await openDiff({}, repository, 'unstaged', { status: 18, uri });
  assert.deepEqual(executedCommands.pop(), ['git.openMergeEditor', uri]);
  mergeEditor = false;
});

test('shows one repository loader and suppresses duplicate async actions', async () => {
  const posts = [];
  const logs = [];
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    busyRepositories: new Set(),
    log: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
    view: { webview: { postMessage: async (message) => posts.push(message) } },
    handleMessage: async () => { calls += 1; await gate; },
  });
  const message = { type: 'commit', repositoryId: '/repo' };

  const first = provider.receiveMessage(message);
  await new Promise(setImmediate);
  await provider.receiveMessage(message);
  release();
  await first;

  assert.equal(calls, 1);
  assert.deepEqual(posts.map(({ busy }) => busy), [true, false]);
  assert.match(logs[0], /\[repo\] Committing changes started\./);
  assert.match(logs[1], /ignored because another operation is running\./);
  assert.match(logs[2], /\[repo\] Committing changes finished in \d+ ms\./);
});

test('blocks merge and rebase continuation only while conflicts remain', async () => {
  const change = { uri: { fsPath: '/repo/conflict.js', toString: () => 'file:///repo/conflict.js' } };
  const repository = {
    rootUri: { fsPath: '/repo' },
    inputBox: { value: '' },
    state: {
      HEAD: { name: 'feature' },
      indexChanges: [change],
      mergeChanges: [change],
      untrackedChanges: [],
      workingTreeChanges: [],
    },
  };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { git: { path: '/git' } },
    expanded: new Set(),
    stats: new Map(),
    viewMode: 'list',
    fileData: async () => [],
  });
  const operationState = git.operationState;
  git.operationState = async () => 'rebase';
  try {
    const conflicted = await provider.repositoryData(repository);
    assert.equal(conflicted.operation, 'rebase');
    assert.equal(conflicted.hasConflicts, true);
    assert.equal(conflicted.operationBlocked, true);
    repository.state.mergeChanges = [];
    repository.state.indexChanges = [];
    const resolved = await provider.repositoryData(repository);
    assert.equal(resolved.files, 0);
    assert.equal(resolved.operation, 'rebase');
    assert.equal(resolved.expandable, true);
    assert.equal(resolved.hasConflicts, false);
    assert.equal(resolved.operationBlocked, false);
  } finally {
    git.operationState = operationState;
  }
});

test('collapses and re-expands the graph without discarding its repository', async () => {
  const posts = [];
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { repositories: [] },
    graph: {
      repositoryId: '/repo',
      repositoryName: 'repo',
      collapsed: false,
      commits: [{ hash: 'abc' }],
      details: { hash: 'abc', files: [] },
    },
    view: { webview: { postMessage: async (message) => posts.push(message) } },
  });

  await provider.handleMessage({ type: 'closeGraph' });
  assert.equal(provider.graph.collapsed, true);
  await provider.handleMessage({ type: 'expandGraph' });
  assert.equal(provider.graph.collapsed, false);
  assert.equal(provider.graph.commits[0].hash, 'abc');
  assert.equal(provider.graph.details.hash, 'abc');
  assert.equal(posts.length, 2);
});

test('reports repository loading failures instead of leaving the view loading', async () => {
  const posts = [];
  const errors = [];
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: {
      state: 'initialized',
      repositories: [{ rootUri: { fsPath: '/repo' }, state: {} }],
    },
    dirtyStats: new Set(),
    expanded: new Set(),
    expansionTouched: new Set(),
    noVerify: new Set(),
    repositoryOrder: [],
    stats: new Map(),
    viewMode: 'list',
    view: { webview: { postMessage: async (message) => posts.push(message) } },
    repositoryData: async () => { throw new Error('broken repository'); },
    log: { error: (...args) => errors.push(args) },
  });

  await provider.refresh();

  assert.equal(posts.at(-1).loading, false);
  assert.match(posts.at(-1).error, /Output panel/);
  assert.equal(errors.length, 1);
});

test('keeps the last completed stats visible while refreshing them', () => {
  let stateChanged;
  const stats = { insertions: 12, deletions: 3 };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: {
      repositories: [{
        rootUri: { fsPath: '/repo' },
        state: { onDidChange: (listener) => {
          stateChanged = listener;
          return { dispose() {} };
        } },
      }],
    },
    dirtyStats: new Set(),
    repositoryListeners: [],
    scheduleRefresh() {},
    stats: new Map([['/repo', stats]]),
  });

  provider.syncRepositories();
  stateChanged();

  assert.equal(provider.stats.get('/repo'), stats);
  assert.equal(provider.dirtyStats.has('/repo'), true);
});

test('stops a superseded repository refresh', async () => {
  const repository = (fsPath) => ({ rootUri: { fsPath }, state: {} });
  const calls = [];
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: {
      state: 'initialized',
      repositories: [repository('/a'), repository('/b')],
    },
    expanded: new Set(),
    expansionTouched: new Set(),
    repositoryOrder: [],
    view: { webview: { postMessage: async () => {} } },
    repositoryData: async ({ rootUri }) => {
      calls.push(rootUri.fsPath);
      provider.refreshId += 1;
      return {};
    },
  });

  await provider.refresh();

  assert.deepEqual(calls, ['/a']);
});

test('reorders repositories and remembers the workspace order', async () => {
  const saved = [];
  const repository = (fsPath) => ({ rootUri: { fsPath } });
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { repositories: [repository('/b'), repository('/a'), repository('/c')] },
    context: { workspaceState: { update: async (_, value) => saved.push(value) } },
    repositoryOrder: [],
    refresh: async () => {},
  });

  await provider.reorder('/c', '/a', true);

  assert.deepEqual(provider.repositoryOrder, ['/c', '/a', '/b']);
  assert.deepEqual(saved, [['/c', '/a', '/b']]);
});

test('builds valid fully qualified remote references', () => {
  assert.equal(
    fullRefName({ type: 1, name: 'master', remote: 'origin' }),
    'refs/remotes/origin/master',
  );
  assert.equal(
    fullRefName({ type: 1, name: 'origin/master', remote: 'origin' }),
    'refs/remotes/origin/master',
  );
});

test('loads commit details from its parent instead of the working tree', async () => {
  const calls = [];
  const commit = { hash: 'child', parents: ['parent'] };
  const root = { hash: 'root', parents: [] };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { git: { path: '/git' } },
    graph: { commits: [commit, root] },
    postGraph: async () => {},
  });
  const repository = {
    diffBetweenWithStats: async (...args) => { calls.push(args); return []; },
    diffBetweenWithStats2: async (...args) => { calls.push(args); return []; },
  };

  await provider.selectGraphCommit(repository, commit.hash);
  const emptyTreeHash = git.emptyTreeHash;
  git.emptyTreeHash = async () => 'empty';
  try {
    await provider.selectGraphCommit(repository, root.hash);
  } finally {
    git.emptyTreeHash = emptyTreeHash;
  }

  assert.deepEqual(calls, [['parent', 'child'], ['empty..root']]);
});
