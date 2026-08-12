'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const gitExecCalls = [];
let execFileImpl = async (file, args, options) => {
  gitExecCalls.push([file, args, options]);
  return { stdout: args[0] === 'hash-object' ? 'empty-tree\n' : '', stderr: '' };
};
const fakeExecFile = () => {};
fakeExecFile[Symbol.for('nodejs.util.promisify.custom')] = (...args) => execFileImpl(...args);
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'node:child_process') {
    return { execFile: fakeExecFile };
  }
  if (request === 'vscode') {
    return {
      ProgressLocation: { Window: 1 },
      commands: { executeCommand: async (...args) => vscodeCommandCalls.push(args) },
      window: {
        withProgress: async (_, action) => action(),
        showErrorMessage: async () => {},
        showInformationMessage: async () => {},
        showQuickPick: async (items) => items[0],
        showWarningMessage: async (...args) => args.at(-1),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const vscodeCommandCalls = [];
const {
  abortOperation,
  amendMessage,
  checkoutDetached,
  cherryPick,
  commit,
  continueOperation,
  createBranchFromCommit,
  createTagFromCommit,
  discardAll,
  emptyTreeHash,
  fetch,
  operationState,
  popStashSelected,
  pullMerge,
  pullFrom,
  pullRebase,
  push,
  resetToOrigin,
  rollback,
  setLog,
} = require('../git-operations');
Module._load = originalLoad;

test('commit stages all only when the index is empty and never commits after a stage failure', async () => {
  const change = (fsPath) => ({ uri: { fsPath } });
  const repository = (indexChanges = [], add = async () => {}) => {
    const calls = [];
    return {
      calls,
      state: {
        indexChanges,
        mergeChanges: [],
        workingTreeChanges: [change('/repo/a.js')],
        untrackedChanges: [change('/repo/b.js')],
      },
      add: async (paths) => { calls.push(['add', paths]); await add(); },
      commit: async (message, options) => calls.push(['commit', message, options]),
    };
  };

  const unstaged = repository();
  assert.equal(await commit(unstaged, 'feat: add files'), true);
  assert.deepEqual(unstaged.calls, [
    ['add', ['/repo/a.js', '/repo/b.js']],
    ['commit', 'feat: add files', { noVerify: false }],
  ]);

  const staged = repository([change('/repo/a.js')]);
  assert.equal(await commit(staged, 'fix: staged only'), true);
  assert.deepEqual(staged.calls, [['commit', 'fix: staged only', { noVerify: false }]]);

  const failed = repository([], async () => { throw new Error('conflict'); });
  assert.equal(await commit(failed, 'fix: conflict'), false);
  assert.deepEqual(failed.calls, [['add', ['/repo/a.js', '/repo/b.js']]]);
});

test('commit passes the remembered no-verify choice to the Git API', async () => {
  const calls = [];
  const repository = {
    state: { indexChanges: [{}] },
    commit: async (...args) => calls.push(args),
  };

  assert.equal(await commit(repository, 'fix: skip hooks', { noVerify: true }), true);
  assert.deepEqual(calls, [['fix: skip hooks', { noVerify: true }]]);
});

test('pull and push use native APIs normally and shell-free no-verify fallbacks', async () => {
  gitExecCalls.length = 0;
  vscodeCommandCalls.length = 0;
  const calls = [];
  const rootUri = { fsPath: '/repo' };
  const repository = {
    rootUri,
    fetch: async () => calls.push('fetch'),
    pull: async () => calls.push('pull'),
    push: async () => calls.push('push'),
    status: async () => calls.push('status'),
  };

  assert.equal(await pullMerge(repository), true);
  assert.equal(await pullRebase(repository), true);
  assert.equal(await pullFrom(repository), true);
  assert.equal(await push(repository), true);
  assert.deepEqual(calls, ['pull', 'push']);
  assert.deepEqual(vscodeCommandCalls, [
    ['git.pullRebase', rootUri],
    ['git.pullFrom', rootUri],
  ]);

  calls.length = 0;
  assert.equal(await pullMerge(repository, { noVerify: true, gitPath: '/git' }), true);
  assert.equal(await pullRebase(repository, { noVerify: true, gitPath: '/git' }), true);
  assert.equal(await push(repository, { noVerify: true, gitPath: '/git' }), true);
  assert.deepEqual(calls, ['fetch', 'status', 'fetch', 'status', 'status']);
  assert.deepEqual(gitExecCalls, [
    ['/git', ['merge', '--no-edit', '--no-verify', '@{upstream}'], { cwd: '/repo' }],
    ['/git', ['rebase', '--no-verify', '@{upstream}'], { cwd: '/repo' }],
    ['/git', ['push', '--no-verify'], { cwd: '/repo' }],
  ]);
});

test('fetch uses the native repository API', async () => {
  const calls = [];
  const logs = [];
  setLog({ info: (message) => logs.push(message) });
  try {
    assert.equal(await fetch({
      rootUri: { fsPath: '/workspace/repo' },
      fetch: async () => calls.push('fetch'),
    }), true);
    assert.deepEqual(calls, ['fetch']);
    assert.deepEqual(logs, ['[repo] > Git API repository.fetch()']);
  } finally {
    setLog(undefined);
  }
});

test('serializes direct Git processes', async () => {
  let active = 0;
  let maxActive = 0;
  const original = execFileImpl;
  execFileImpl = async () => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise(setImmediate);
    active -= 1;
    return { stdout: '', stderr: '' };
  };
  const repository = (fsPath) => ({
    rootUri: { fsPath },
    state: { mergeChanges: [] },
  });

  try {
    await Promise.all([
      operationState(repository('/a'), { gitPath: '/git' }),
      operationState(repository('/b'), { gitPath: '/git' }),
    ]);
    assert.equal(maxActive, 1);
  } finally {
    execFileImpl = original;
  }
});

test('logs native operation failures to the extension output', async () => {
  const errors = [];
  setLog({ error: (...args) => errors.push(args) });
  try {
    const repository = {
      rootUri: { fsPath: '/workspace/repo' },
      fetch: async () => { throw new Error('offline'); },
    };
    assert.equal(await fetch(repository), false);
    assert.match(errors[0][0], /\[repo\] Fetching changes failed\./);
    assert.match(errors[0][1].message, /offline/);
  } finally {
    setLog(undefined);
  }
});

test('pull from preserves no-verify while using the selected remote branch', async () => {
  gitExecCalls.length = 0;
  const calls = [];
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: { remotes: [{ name: 'origin', fetchUrl: 'git@example/repo.git' }] },
    getRefs: async () => [{ name: 'origin/main' }],
    fetch: async (...args) => calls.push(['fetch', ...args]),
    status: async () => calls.push(['status']),
  };

  assert.equal(await pullFrom(repository, { noVerify: true, gitPath: '/git' }), true);
  assert.deepEqual(calls, [['fetch', 'origin', 'main'], ['status']]);
  assert.deepEqual(gitExecCalls[0][1], ['merge', '--no-edit', '--no-verify', 'FETCH_HEAD']);
});

test('opens VS Code\'s stash picker for pop stash', async () => {
  vscodeCommandCalls.length = 0;
  const repository = { rootUri: { fsPath: '/repo' } };
  assert.equal(await popStashSelected(repository), true);
  assert.deepEqual(vscodeCommandCalls, [['git.stashPop', repository.rootUri]]);
});

test('reset to origin fetches and hard-resets the current local branch after confirmation', async () => {
  gitExecCalls.length = 0;
  const calls = [];
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: {
      HEAD: { name: 'feature' },
      mergeChanges: [],
      rebaseCommit: { hash: 'rebasing' },
      remotes: [{ name: 'origin', fetchUrl: 'git@example/repo.git' }],
    },
    fetch: async (...args) => calls.push(['fetch', ...args]),
    status: async () => calls.push(['status']),
  };

  assert.equal(await resetToOrigin(repository, { gitPath: '/git' }), false);
  repository.state.rebaseCommit = undefined;
  assert.equal(await resetToOrigin(repository, { gitPath: '/git' }), true);
  assert.deepEqual(calls, [['fetch', 'origin', 'feature'], ['status']]);
  assert.deepEqual(gitExecCalls.at(-1), [
    '/git',
    ['reset', '--hard', 'refs/remotes/origin/feature'],
    { cwd: '/repo' },
  ]);
});

test('continues and aborts the active merge or rebase', async () => {
  gitExecCalls.length = 0;
  const calls = [];
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: { rebaseCommit: { hash: 'abc', message: 'fix: rebased' }, mergeChanges: [] },
    commit: async (...args) => calls.push(['commit', ...args]),
    mergeAbort: async () => calls.push(['mergeAbort']),
    status: async () => calls.push(['status']),
  };

  assert.equal(await operationState(repository, { gitPath: '/git' }), 'rebase');
  assert.equal(await continueOperation(repository, 'rebase', '', { gitPath: '/git' }), true);
  assert.equal(await abortOperation(repository, 'rebase', { gitPath: '/git' }), true);
  assert.deepEqual(calls[0], ['commit', 'fix: rebased', {}]);
  assert.deepEqual(gitExecCalls.map(([, args]) => args), [['rebase', '--abort']]);

  repository.state.rebaseCommit = undefined;
  assert.equal(await operationState(repository, { gitPath: '/git' }), 'merge');
  assert.equal(await continueOperation(repository, 'merge', 'Merge branch', { gitPath: '/git' }), true);
  assert.deepEqual(calls.at(-1), ['commit', 'Merge branch', { noVerify: false }]);
});

test('graph commit actions use native APIs and shell-free cherry-pick', async () => {
  gitExecCalls.length = 0;
  const calls = [];
  const repository = {
    rootUri: { fsPath: '/repo' },
    checkout: async (...args) => calls.push(['checkout', ...args]),
    createBranch: async (...args) => calls.push(['createBranch', ...args]),
    tag: async (...args) => calls.push(['tag', ...args]),
    status: async () => calls.push(['status']),
  };

  assert.equal(await checkoutDetached(repository, 'abc123'), true);
  assert.equal(await createBranchFromCommit(repository, 'feature', 'abc123'), true);
  assert.equal(await createTagFromCommit(repository, 'v1.0.0', 'abc123'), true);
  assert.equal(await cherryPick(repository, 'abc123', { gitPath: '/git' }), true);
  assert.equal(await amendMessage(repository, 'fix: clearer subject', { gitPath: '/git' }), true);
  assert.equal(await amendMessage(repository, 'fix: skip hooks', { gitPath: '/git', noVerify: true }), true);
  assert.equal(await amendMessage(repository, '   ', { gitPath: '/git' }), false);
  assert.equal(await emptyTreeHash(repository, { gitPath: '/git' }), 'empty-tree');
  assert.equal(await rollback(repository, 'abc123', 'mixed', { gitPath: '/git' }), true);
  assert.equal(await rollback(repository, 'abc123', 'invalid', { gitPath: '/git' }), false);
  assert.deepEqual(calls, [
    ['checkout', 'abc123'],
    ['createBranch', 'feature', true, 'abc123'],
    ['tag', 'v1.0.0', '', 'abc123'],
    ['status'],
    ['status'],
    ['status'],
    ['status'],
  ]);
  assert.deepEqual(gitExecCalls, [
    ['/git', ['cherry-pick', 'abc123'], { cwd: '/repo' }],
    ['/git', ['commit', '--amend', '--only', '-m', 'fix: clearer subject'], { cwd: '/repo' }],
    ['/git', ['commit', '--amend', '--only', '-m', 'fix: skip hooks', '--no-verify'], { cwd: '/repo' }],
    ['/git', ['hash-object', '-t', 'tree', require('node:os').devNull], { cwd: '/repo' }],
    ['/git', ['reset', '--mixed', 'abc123'], { cwd: '/repo' }],
  ]);
});

test('discard all unstages staged paths before discarding them', async () => {
  const calls = [];
  const repository = {
    revert: async (paths) => calls.push(['revert', paths]),
    clean: async (paths) => calls.push(['clean', paths]),
  };
  const paths = ['/repo/a.js', '/repo/b.js'];

  assert.equal(await discardAll(repository, 'staged', paths), true);
  assert.deepEqual(calls, [['revert', paths], ['clean', paths]]);

  calls.length = 0;
  assert.equal(await discardAll(repository, 'unstaged', paths), true);
  assert.deepEqual(calls, [['clean', paths]]);
});
