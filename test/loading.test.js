'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const load = Module._load;
const executedCommands = [];
const openedExternal = [];
const authenticationRequests = [];
const clipboardWrites = [];
const informationMessages = [];
let mergeEditor = false;
let quickPickIndex = 0;
let warningHandler;
let errorHandler;
let fullRefName;
let githubRepository;
let RepositoryViewProvider;
let html;
let git;
let ai;
let openDiff;
try {
  Module._load = (request, parent, isMain) =>
    request === 'vscode'
      ? {
          authentication: {
            getSession: async (...args) => {
              authenticationRequests.push(args);
              return { accessToken: 'token' };
            },
          },
          commands: { executeCommand: async (...args) => executedCommands.push(args) },
          env: {
            clipboard: { writeText: async (value) => clipboardWrites.push(value) },
            openExternal: async (uri) => openedExternal.push(uri.toString()),
          },
          Uri: {
            parse: (value) => ({ toString: () => value }),
            from: (value) => value,
          },
          window: {
            showErrorMessage: (...args) => errorHandler?.(...args),
            showInformationMessage: async (value) => informationMessages.push(value),
            showQuickPick: async (choices) => choices[quickPickIndex],
            showWarningMessage: async (...args) => warningHandler?.(...args),
          },
          workspace: { getConfiguration: (section) => ({
            get: (key, fallback) => section === 'git' && key === 'mergeEditor'
              ? mergeEditor
              : fallback,
          }) },
        }
      : load(request, parent, isMain);
  ({ fullRefName, githubRepository, html, openDiff, RepositoryViewProvider } = require('../extension'));
  git = require('../git-operations');
  ai = require('../ai-commit');
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
  assert.match(markup, /delay = tooltip\.classList\.contains\('visible'\) \? 0 : 1000/);
  assert.match(markup, /const nextTarget = event\.relatedTarget\?\.closest\?\.\('\[data-tooltip\]'\)/);
  assert.match(markup, /\.file-name \{ flex: none; \}/);
  assert.match(markup, /directory\.dataset\.tooltip = (node|file)\.directory/);
  assert.match(markup, /Resolve text conflicts with AI/);
  assert.match(markup, /type: 'resolveConflicts'/);
  assert.match(markup, /\? 'Conflicted'/);
  assert.match(markup, /repository\.hasConflicts \? '!' : ''/);
  assert.match(markup, /repository\.operation === 'cherry-pick' \? 'cherryPick'/);
  assert.match(markup, /expanded && repository\.expandable/);
  assert.match(markup, /section\.inert = Boolean\(progressLabel\)/);
  assert.match(markup, /section\.setAttribute\('aria-busy'/);
  assert.match(markup, /\.graph-date \{ min-width: max-content;/);
  assert.doesNotMatch(markup, /graph-inline-action/);
  assert.match(markup, /\.graph-meta > \.icon-button \{ flex: none; margin-left: auto; margin-right: 20px; \}/);
  assert.match(markup, /meta\.append\(\s*hash,[\s\S]*?button\('files', 'Open all commit changes'/);
  assert.match(markup, /menuItem\('Open Changes on Remote', action\('graphOpenRemote'\)\)/);
  assert.match(markup, /graphAuthor\(commit, 'graph-author'\)/);
  assert.match(markup, /if \(scrollTop !== undefined\) list\.scrollTop = scrollTop;/);
});

test('resolves GitHub remotes and opens commits and linked author profiles', async () => {
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: {
      HEAD: { upstream: { remote: 'upstream' } },
      remotes: [
        { name: 'origin', fetchUrl: 'https://github.com/fallback/project.git' },
        { name: 'upstream', fetchUrl: 'git@github.com:acme/project.git' },
      ],
    },
  };
  assert.deepEqual(githubRepository(repository), {
    owner: 'acme',
    repo: 'project',
    url: 'https://github.com/acme/project',
  });

  const commit = { hash: 'abc123', author: 'Ada Lovelace' };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { repositories: [repository] },
    graph: { repositoryId: '/repo', commits: [commit] },
  });
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (...args) => {
    request = args;
    return { ok: true, json: async () => ({ author: { html_url: 'https://github.com/ada' } }) };
  };
  openedExternal.length = 0;
  authenticationRequests.length = 0;
  try {
    await provider.handleMessage({ type: 'graphOpenRemote', repositoryId: '/repo', hash: commit.hash });
    await provider.handleMessage({ type: 'graphOpenAuthor', repositoryId: '/repo', hash: commit.hash });
  } finally {
    global.fetch = originalFetch;
  }

  assert.deepEqual(openedExternal, [
    'https://github.com/acme/project/commit/abc123',
    'https://github.com/ada',
  ]);
  assert.deepEqual(authenticationRequests, [['github', ['repo'], { createIfNone: true }]]);
  assert.equal(request[0], 'https://api.github.com/repos/acme/project/commits/abc123');
  assert.equal(request[1].headers.Authorization, 'Bearer token');
});

test('copies the selected GitHub commit link and leaves the clipboard alone without a GitHub remote', async () => {
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: {
      HEAD: { upstream: { remote: 'upstream' } },
      remotes: [
        { name: 'origin', fetchUrl: 'https://github.com/fallback/project.git' },
        { name: 'upstream', fetchUrl: 'git@github.com:acme/project.git' },
      ],
    },
  };
  const commit = { hash: 'abc123' };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { git: {}, repositories: [repository] },
    graph: { repositoryId: '/repo', commits: [commit] },
    refresh: async () => {},
  });
  clipboardWrites.length = 0;
  informationMessages.length = 0;

  await provider.handleMessage({ type: 'graphCopyRemoteLink', repositoryId: '/repo', hash: commit.hash });
  assert.deepEqual(clipboardWrites, ['https://github.com/acme/project/commit/abc123']);

  repository.state.remotes = [{ name: 'origin', fetchUrl: 'https://gitlab.com/acme/project.git' }];
  await provider.handleMessage({ type: 'graphCopyRemoteLink', repositoryId: '/repo', hash: commit.hash });
  assert.deepEqual(clipboardWrites, ['https://github.com/acme/project/commit/abc123']);
  assert.deepEqual(informationMessages, ['This repository has no GitHub remote.']);
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
    dirtyStats: new Set(),
    viewMode: 'list',
    fileData: () => [],
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
    graph: { repositoryId: '/repo', commits: [commit, root] },
    postGraph: async () => {},
  });
  const repository = {
    rootUri: { fsPath: '/repo' },
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

test('ignores failed commit details from an older selection', async () => {
  let rejectOld;
  let resolveNew;
  const repository = {
    rootUri: { fsPath: '/repo' },
    diffBetweenWithStats: (parent) => new Promise((resolve, reject) => {
      if (parent === 'parent-a') rejectOld = reject;
      else resolveNew = resolve;
    }),
  };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    graph: { repositoryId: '/repo', commits: [
      { hash: 'a', parents: ['parent-a'] },
      { hash: 'b', parents: ['parent-b'] },
    ] },
    postGraph: async () => {},
  });

  const old = provider.selectGraphCommit(repository, 'a');
  await Promise.resolve();
  const current = provider.selectGraphCommit(repository, 'b');
  await Promise.resolve();
  resolveNew([]);
  await current;
  rejectOld(new Error('stale failure'));
  await old;

  assert.deepEqual(provider.graph.details, { hash: 'b', files: [] });
});

test('renders changed files from cached batch stats without per-file Git calls', async () => {
  const change = {
    uri: { fsPath: '/repo/file.txt', toString: () => 'file:///repo/file.txt' },
    status: 5,
  };
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: {
      HEAD: { name: 'feature' }, indexChanges: [], mergeChanges: [],
      workingTreeChanges: [change], untrackedChanges: [],
    },
    diffWithHEADShortStats: () => { throw new Error('per-file diff called'); },
  };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { git: { path: '/git' } },
    expanded: new Set(['/repo']), dirtyStats: new Set(), stats: new Map(), viewMode: 'list',
  });
  const operationState = git.operationState;
  git.operationState = async () => undefined;
  try {
    const initial = await provider.repositoryData(repository);
    assert.equal(initial.unstaged[0].insertions, undefined);
    assert.equal(initial.publishable, true);
    provider.stats.set('/repo', {
      insertions: 3, deletions: 1, files: { staged: {}, unstaged: { 'file.txt': { insertions: 3, deletions: 1 } } },
      incomplete: false,
    });
    const complete = await provider.repositoryData(repository);
    assert.deepEqual(
      [complete.unstaged[0].insertions, complete.unstaged[0].deletions],
      [3, 1],
    );
  } finally {
    git.operationState = operationState;
  }
});

test('compares endpoint snapshots and uses original and renamed file paths', async () => {
  const original = { fsPath: '/repo/old.txt' };
  const renamed = { fsPath: '/repo/new.txt' };
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: { HEAD: { upstream: { remote: 'origin', name: 'main' } } },
    diffBetweenWithStats2: async (range) => {
      assert.equal(range, 'refs/remotes/origin/main..target');
      return [{ uri: original, originalUri: original, renameUri: renamed, status: 3,
        insertions: 1, deletions: 1 }];
    },
  };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { toGitUri: (uri, ref) => ({ path: uri.fsPath, ref }) },
  });
  executedCommands.length = 0;
  quickPickIndex = 0;

  await provider.compareGraphCommit(repository, { hash: 'target' }, 'remote');

  assert.deepEqual(executedCommands.at(-1).slice(0, 3), [
    'vscode.diff',
    { path: '/repo/old.txt', ref: 'refs/remotes/origin/main' },
    { path: '/repo/new.txt', ref: 'target' },
  ]);
});

test('rollback rejects a changed branch after confirmation and passes its original HEAD to Git', async () => {
  const commit = { hash: 'ancestor' };
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: { HEAD: { name: 'main', commit: 'head' }, mergeChanges: [] },
    getMergeBase: async () => commit.hash,
  };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { git: { path: '/git' } }, loadGraph: async () => {},
  });
  const operationState = git.operationState;
  const rollback = git.rollback;
  const calls = [];
  git.operationState = async () => undefined;
  git.rollback = async (...args) => { calls.push(args); return true; };
  informationMessages.length = 0;
  quickPickIndex = 0;
  try {
    warningHandler = async () => {
      repository.state.HEAD = { name: 'other', commit: 'other-head' };
      return 'Rollback';
    };
    await provider.rollbackGraphCommit(repository, commit);
    assert.equal(calls.length, 0);
    assert.equal(informationMessages.at(-1), 'HEAD or the Git operation changed before rollback.');

    repository.state.HEAD = { name: 'main', commit: 'head' };
    warningHandler = async () => 'Rollback';
    await provider.rollbackGraphCommit(repository, commit);
    assert.deepEqual(calls[0].slice(1), [
      'ancestor', 'soft', { gitPath: '/git', expectedHead: { name: 'main', commit: 'head' } },
    ]);
  } finally {
    warningHandler = undefined;
    git.operationState = operationState;
    git.rollback = rollback;
  }
});

test('does not apply a graph load after switching repositories', async () => {
  let releaseRefs;
  const repository = {
    rootUri: { fsPath: '/first' }, state: { HEAD: { commit: 'head' } },
    getRefs: () => new Promise((resolve) => { releaseRefs = resolve; }),
    log: () => { throw new Error('stale graph queried commits'); },
  };
  const first = { repositoryId: '/first', scope: { kind: 'all' }, limit: 50, commits: [], refs: [] };
  const second = { repositoryId: '/second', commits: [{ hash: 'current' }] };
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { repositories: [repository] }, graph: first, postGraph: async () => {},
  });
  const load = provider.loadGraph();
  await Promise.resolve();
  provider.graph = second;
  releaseRefs([]);
  await load;
  assert.equal(provider.graph, second);
  assert.deepEqual(second.commits, [{ hash: 'current' }]);
});

test('drops stale batch stats and posts only the later snapshot', async () => {
  const change = { uri: { toString: () => 'file:///repo/file.txt' } };
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: { mergeChanges: [], indexChanges: [], workingTreeChanges: [change], untrackedChanges: [] },
  };
  let resolveOld;
  let resolveNew;
  const posts = [];
  let count = 0;
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { repositories: [repository] }, dirtyStats: new Set(['/repo']), stats: new Map(),
    view: { webview: { postMessage: async (value) => posts.push(value) } },
    computeStats: () => new Promise((resolve) => {
      (count++ ? resolveNew = resolve : resolveOld = resolve);
    }),
  });
  const work = provider.updateStats();
  provider.dirtyStats.add('/repo');
  resolveOld({ insertions: 1, deletions: 0, files: { staged: {}, unstaged: {} } });
  await Promise.resolve();
  resolveNew({ insertions: 2, deletions: 0, files: { staged: {}, unstaged: {} } });
  await work;
  assert.deepEqual(posts.map((value) => value.insertions), [2]);
  assert.equal(provider.stats.get('/repo').insertions, 2);
});

test('generation posts its result and clears activity even while an error toast stays open', async () => {
  const repository = { rootUri: { fsPath: '/repo' } };
  const posts = [];
  const provider = Object.assign(Object.create(RepositoryViewProvider.prototype), {
    api: { git: { path: '/git' }, repositories: [repository] },
    noVerify: new Set(), generating: new Set(),
    view: { webview: { postMessage: async (value) => posts.push(value) } },
  });
  const generate = ai.generateCommitMessage;
  try {
    ai.generateCommitMessage = async () => 'feat: generated';
    await provider.handleMessage({ type: 'generateMessage', repositoryId: '/repo' });
    assert.deepEqual(posts.map(({ type }) => type), ['aiState', 'generatedMessage', 'aiState']);
    assert.equal(posts[1].message, 'feat: generated');
    assert.equal(provider.generating.size, 0);

    posts.length = 0;
    ai.generateCommitMessage = async () => { throw new Error('offline'); };
    errorHandler = () => new Promise(() => {});
    const result = await Promise.race([
      provider.handleMessage({ type: 'generateMessage', repositoryId: '/repo' }).then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    assert.equal(result, 'settled');
    assert.deepEqual(posts.map(({ type }) => type), ['aiState', 'aiState']);
    assert.equal(provider.generating.size, 0);
  } finally {
    ai.generateCommitMessage = generate;
    errorHandler = undefined;
  }
});
