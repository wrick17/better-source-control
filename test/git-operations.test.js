'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const gitExecCalls = [];
const firstCommit = 'a'.repeat(40);
const fetchedCommit = 'b'.repeat(40);
const gitRefStates = new Set();
let readMarkerImpl = async (file) => {
  if (gitRefStates.has(path.basename(file))) return `${fetchedCommit}\n`;
  const error = new Error('missing marker');
  error.code = 'ENOENT';
  throw error;
};
let execFileImpl = async (file, args, options) => {
  gitExecCalls.push([file, args, options]);
  if (args[0] === 'rev-parse' && args.includes('--quiet')) {
    if (!gitRefStates.has(args.at(-1))) {
      const error = new Error('missing ref');
      error.code = 1;
      throw error;
    }
  }
  const stdout = args[0] === 'hash-object' ? 'empty-tree\n'
    : args[0] === 'symbolic-ref' ? 'feature\n'
      : args[0] === 'rev-parse' && args.at(-1) === '--absolute-git-dir' ? '/repo/.git\n'
      : args[0] === 'merge-base' ? `${fetchedCommit}\n`
        : args[0] === 'rev-list' ? `${fetchedCommit} ${firstCommit}\n`
          : args[0] === 'rev-parse' && args.at(-1) === 'HEAD' ? `${firstCommit}\n`
            : args[0] === 'rev-parse' && args.at(-1) === 'FETCH_HEAD^{commit}' ? `${fetchedCommit}\n` : '';
  return { stdout, stderr: '' };
};
const fakeExecFile = () => {};
fakeExecFile[Symbol.for('nodejs.util.promisify.custom')] = (...args) => execFileImpl(...args);
const originalLoad = Module._load;
let showErrorMessage = async () => {};
let showWarningMessageImpl = async (...args) => args.at(-1);
Module._load = function load(request, parent, isMain) {
  if (request === 'node:child_process') {
    return { execFile: fakeExecFile };
  }
  if (request === 'node:fs/promises') {
    return { readFile: (...args) => readMarkerImpl(...args) };
  }
  if (request === 'vscode') {
    return {
      ProgressLocation: { Window: 1 },
      commands: { executeCommand: (...args) => executeCommandImpl(...args) },
      window: {
        withProgress: async (_, action) => action(),
        showErrorMessage: (...args) => showErrorMessage(...args),
        showInformationMessage: async () => {},
        showQuickPick: async (items) => items[0],
        showWarningMessage: (...args) => showWarningMessageImpl(...args),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const vscodeCommandCalls = [];
let executeCommandImpl = async (...args) => vscodeCommandCalls.push(args);
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
  execGitCommand,
  fetch,
  operationState,
  pickBranch,
  popStashSelected,
  publish,
  pullMerge,
  pullFrom,
  pullRebase,
  push,
  resetToOrigin,
  rollback,
  revertCommit,
  setLog,
  viewStash,
  applyStash,
  createWorktree,
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
  assert.deepEqual(gitExecCalls.map(([, args]) => args), [
    ['merge', '--no-edit', '--no-verify', '@{upstream}'],
    ['rebase', '--no-verify', '@{upstream}'],
    ['push', '--no-verify'],
  ]);
  assert.ok(gitExecCalls.every(([, , options]) => options.timeout === 300_000 && options.killSignal === 'SIGKILL'));
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

test('releases failed Git operations before the error toast is dismissed', async () => {
  let dismiss;
  showErrorMessage = () => new Promise((resolve) => { dismiss = resolve; });
  let completed = false;
  const operation = push({
    rootUri: { fsPath: '/repo' },
    push: async () => { throw new Error('offline'); },
  }).then(() => { completed = true; });

  try {
    await new Promise(setImmediate);
    assert.equal(completed, true);
  } finally {
    dismiss?.();
    await operation;
    showErrorMessage = async () => {};
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

test('opens native stash review, stash apply, and worktree pickers in the selected repository', async () => {
  vscodeCommandCalls.length = 0;
  const repository = { rootUri: { fsPath: '/workspace/selected' } };
  assert.equal(await viewStash(repository), true);
  assert.equal(await applyStash(repository), true);
  assert.equal(await createWorktree(repository), true);
  assert.deepEqual(vscodeCommandCalls, [
    ['git.stashView', repository.rootUri],
    ['git.stashApply', repository.rootUri],
    ['git.createWorktree', repository.rootUri],
  ]);
});

test('publishes a local branch to the selected remote and verifies upstream', async () => {
  const calls = [];
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: {
      HEAD: { name: 'feature', commit: firstCommit },
      remotes: [{ name: 'origin', pushUrl: 'git@example/repo.git' }],
    },
    push: async (...args) => calls.push(['push', ...args]),
    status: async () => calls.push(['status']),
    getBranch: async (name) => {
      calls.push(['getBranch', name]);
      return { upstream: { remote: 'origin', name: 'feature' } };
    },
  };
  assert.equal(await publish(repository), true);
  assert.deepEqual(calls, [
    ['push', 'origin', 'feature', true], ['status'], ['getBranch', 'feature'],
  ]);
  assert.equal(await publish({ ...repository, state: {
    ...repository.state, HEAD: { ...repository.state.HEAD, upstream: { remote: 'origin', name: 'feature' } },
  } }), false);
});

test('no-verify publish checks live HEAD and uses the selected remote', async () => {
  gitExecCalls.length = 0;
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: {
      HEAD: { name: 'feature', commit: firstCommit }, mergeChanges: [],
      remotes: [{ name: 'origin', pushUrl: 'git@example/repo.git' }],
    },
    status: async () => {},
    getBranch: async () => ({ upstream: { remote: 'origin', name: 'feature' } }),
  };
  assert.equal(await publish(repository, { noVerify: true, gitPath: '/git' }), true);
  assert.deepEqual(gitExecCalls.at(-1)[1], [
    'push', '--no-verify', '--set-upstream', 'origin', 'HEAD:refs/heads/feature',
  ]);
  const original = execFileImpl;
  execFileImpl = async (file, args, options) => args[0] === 'symbolic-ref'
    ? { stdout: 'other\n', stderr: '' } : original(file, args, options);
  try {
    gitExecCalls.length = 0;
    assert.equal(await publish(repository, { noVerify: true, gitPath: '/git' }), false);
    assert.ok(!gitExecCalls.some(([, args]) => args[0] === 'push'));
  } finally {
    execFileImpl = original;
  }
});

test('opens the native branch picker for the selected repository', async () => {
  vscodeCommandCalls.length = 0;
  const repository = { rootUri: { fsPath: '/workspace/selected' } };

  assert.equal(await pickBranch(repository), true);
  assert.deepEqual(vscodeCommandCalls, [['git.checkout', repository.rootUri]]);
  assert.equal(await pickBranch(undefined), undefined);
  assert.deepEqual(vscodeCommandCalls, [['git.checkout', repository.rootUri]]);
});

test('settles when the native branch picker fails', async () => {
  const original = executeCommandImpl;
  executeCommandImpl = async () => { throw new Error('checkout failed'); };
  try {
    assert.equal(await pickBranch({ rootUri: { fsPath: '/repo' } }), false);
  } finally {
    executeCommandImpl = original;
  }
});

test('reset to origin fetches and hard-resets the current local branch after confirmation', async () => {
  gitExecCalls.length = 0;
  const calls = [];
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: {
      HEAD: { name: 'feature', commit: firstCommit },
      mergeChanges: [],
      rebaseCommit: { hash: 'rebasing' },
      remotes: [{ name: 'origin', fetchUrl: 'git@example/repo.git' }],
    },
    status: async () => calls.push(['status']),
  };

  assert.equal(await resetToOrigin(repository, { gitPath: '/git' }), false);
  repository.state.rebaseCommit = undefined;
  assert.equal(await resetToOrigin(repository, { gitPath: '/git' }), true);
  assert.deepEqual(calls, [['status']]);
  assert.ok(gitExecCalls.some(([, args]) => args.join(' ') === 'fetch origin refs/heads/feature'));
  assert.deepEqual(gitExecCalls.at(-1)[1], ['reset', '--hard', fetchedCommit]);
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
  assert.deepEqual(gitExecCalls.at(-1)[1], ['rebase', '--abort']);

  repository.state.rebaseCommit = undefined;
  gitRefStates.add('MERGE_HEAD');
  assert.equal(await operationState(repository, { gitPath: '/git' }), 'merge');
  assert.equal(await continueOperation(repository, 'merge', 'Merge branch', { gitPath: '/git' }), true);
  assert.deepEqual(calls.at(-1), ['commit', 'Merge branch', { noVerify: false }]);
  gitRefStates.clear();
});

test('classifies cherry-pick and revert markers without mistaking stash conflicts for a merge', async () => {
  gitRefStates.clear();
  const repository = {
    rootUri: { fsPath: '/repo' }, state: { mergeChanges: [{}] }, status: async () => {},
  };
  assert.equal(await operationState(repository, { gitPath: '/git' }), undefined);
  for (const [ref, operation] of [
    ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['MERGE_HEAD', 'merge'],
  ]) {
    gitRefStates.add(ref);
    assert.equal(await operationState(repository, { gitPath: '/git' }), operation);
    gitRefStates.delete(ref);
  }
  repository.state.mergeChanges = [];
  gitRefStates.add('CHERRY_PICK_HEAD');
  gitExecCalls.length = 0;
  assert.equal(await continueOperation(repository, 'cherry-pick', '', { gitPath: '/git' }), true);
  assert.equal(await abortOperation(repository, 'cherry-pick', { gitPath: '/git' }), true);
  assert.ok(gitExecCalls.some(([, args]) => args.join(' ') === 'cherry-pick --continue'));
  assert.ok(gitExecCalls.some(([, args]) => args.join(' ') === 'cherry-pick --abort'));
  gitRefStates.clear();
});

test('reset and rollback refuse a changed live HEAD before destructive commands', async () => {
  const repository = {
    rootUri: { fsPath: '/repo' }, state: {
      HEAD: { name: 'feature', commit: firstCommit }, mergeChanges: [],
      remotes: [{ name: 'origin', fetchUrl: 'git@example/repo.git' }],
    }, status: async () => {},
  };
  const original = execFileImpl;
  execFileImpl = async (file, args, options) => args[0] === 'symbolic-ref'
    ? { stdout: 'other\n', stderr: '' } : original(file, args, options);
  try {
    gitExecCalls.length = 0;
    assert.equal(await resetToOrigin(repository, { gitPath: '/git' }), false);
    assert.ok(!gitExecCalls.some(([, args]) => args[0] === 'reset'));
    gitExecCalls.length = 0;
    assert.equal(await rollback(repository, fetchedCommit, 'hard', {
      gitPath: '/git', expectedHead: { name: 'feature', commit: firstCommit },
    }), false);
    assert.ok(!gitExecCalls.some(([, args]) => args[0] === 'reset'));
  } finally {
    execFileImpl = original;
  }
});

test('reset rechecks live HEAD after fetch and refuses a branch switch during fetch', async () => {
  const repository = {
    rootUri: { fsPath: '/repo' }, state: {
      HEAD: { name: 'feature', commit: firstCommit }, mergeChanges: [],
      remotes: [{ name: 'origin', fetchUrl: 'git@example/repo.git' }],
    }, status: async () => {},
  };
  const original = execFileImpl;
  let checks = 0;
  execFileImpl = async (file, args, options) => args[0] === 'symbolic-ref' && ++checks === 2
    ? { stdout: 'other\n', stderr: '' } : original(file, args, options);
  try {
    gitExecCalls.length = 0;
    assert.equal(await resetToOrigin(repository, { gitPath: '/git' }), false);
    assert.equal(checks, 2);
    assert.ok(gitExecCalls.some(([, args]) => args[0] === 'fetch'));
    assert.ok(!gitExecCalls.some(([, args]) => args[0] === 'reset'));
  } finally {
    execFileImpl = original;
  }
});

test('cherry-pick, revert, and amend refuse another branch at the same commit', async () => {
  const repository = {
    rootUri: { fsPath: '/repo' }, state: { mergeChanges: [] }, status: async () => {},
  };
  const expectedHead = { name: 'feature', commit: firstCommit };
  const original = execFileImpl;
  execFileImpl = async (file, args, options) => args[0] === 'symbolic-ref'
    ? { stdout: 'other\n', stderr: '' } : original(file, args, options);
  try {
    gitExecCalls.length = 0;
    assert.equal(await cherryPick(repository, fetchedCommit, { gitPath: '/git', expectedHead }), false);
    assert.equal(await revertCommit(repository, fetchedCommit, { gitPath: '/git', expectedHead }), false);
    assert.equal(await amendMessage(repository, 'new subject', { gitPath: '/git', expectedHead }), false);
    assert.ok(!gitExecCalls.some(([, args]) => ['cherry-pick', 'revert', 'commit'].includes(args[0])));
  } finally {
    execFileImpl = original;
  }
});

test('cherry-pick and amend work at an unchanged detached HEAD', async () => {
  const repository = {
    rootUri: { fsPath: '/repo' }, state: { mergeChanges: [] }, status: async () => {},
  };
  const original = execFileImpl;
  execFileImpl = async (file, args, options) => {
    if (args[0] === 'symbolic-ref') {
      const error = new Error('detached HEAD');
      error.code = 1;
      throw error;
    }
    return original(file, args, options);
  };
  try {
    gitExecCalls.length = 0;
    const expectedHead = { name: undefined, commit: firstCommit };
    assert.equal(await cherryPick(repository, fetchedCommit, { gitPath: '/git', expectedHead }), true);
    assert.equal(await amendMessage(repository, 'detached subject', { gitPath: '/git', expectedHead }), true);
    assert.ok(gitExecCalls.some(([, args]) => args[0] === 'cherry-pick'));
    assert.ok(gitExecCalls.some(([, args]) => args[0] === 'commit'));
  } finally {
    execFileImpl = original;
  }
});

test('abort refuses a different same-type operation after the confirmation dialog', async () => {
  const repository = {
    rootUri: { fsPath: '/repo' }, state: { mergeChanges: [] }, status: async () => {},
  };
  const originalRead = readMarkerImpl;
  const originalWarning = showWarningMessageImpl;
  let marker = fetchedCommit;
  gitRefStates.add('CHERRY_PICK_HEAD');
  readMarkerImpl = async (file) => path.basename(file) === 'CHERRY_PICK_HEAD'
    ? `${marker}\n` : originalRead(file);
  showWarningMessageImpl = async (...args) => {
    marker = 'c'.repeat(40);
    return args.at(-1);
  };
  try {
    gitExecCalls.length = 0;
    assert.equal(await abortOperation(repository, 'cherry-pick', { gitPath: '/git' }), false);
    assert.ok(!gitExecCalls.some(([, args]) => args.join(' ') === 'cherry-pick --abort'));
  } finally {
    gitRefStates.clear();
    readMarkerImpl = originalRead;
    showWarningMessageImpl = originalWarning;
  }
});

test('revert accepts one-parent commits and rejects merge commits', async () => {
  const repository = {
    rootUri: { fsPath: '/repo' }, state: { mergeChanges: [] }, status: async () => {},
  };
  gitExecCalls.length = 0;
  assert.equal(await revertCommit(repository, fetchedCommit, {
    gitPath: '/git', expectedHead: { name: 'feature', commit: firstCommit },
  }), true);
  assert.deepEqual(gitExecCalls.at(-1)[1], ['revert', '--no-edit', fetchedCommit]);
  const original = execFileImpl;
  execFileImpl = async (file, args, options) => args[0] === 'rev-list'
    ? { stdout: `${fetchedCommit} ${firstCommit} ${'c'.repeat(40)}\n`, stderr: '' }
    : original(file, args, options);
  try {
    gitExecCalls.length = 0;
    assert.equal(await revertCommit(repository, fetchedCommit, {
      gitPath: '/git', expectedHead: { name: 'feature', commit: firstCommit },
    }), false);
    assert.ok(!gitExecCalls.some(([, args]) => args[0] === 'revert'));
  } finally {
    execFileImpl = original;
  }
});

test('shared direct runner preserves binary output and bounds subprocess time', async () => {
  const original = execFileImpl;
  execFileImpl = async (_file, _args, options) => {
    assert.equal(options.encoding, 'buffer');
    assert.equal(options.timeout, 300_000);
    return { stdout: Buffer.from([0, 255]), stderr: Buffer.alloc(0) };
  };
  try {
    const result = await execGitCommand({ rootUri: { fsPath: '/repo' } }, '/git', ['status'], {
      encoding: 'buffer', timeout: 600_000,
    });
    assert.deepEqual(result.stdout, Buffer.from([0, 255]));
  } finally {
    execFileImpl = original;
  }
});

test('graph commit actions use native APIs and shell-free cherry-pick', async () => {
  gitExecCalls.length = 0;
  const calls = [];
  const repository = {
    rootUri: { fsPath: '/repo' },
    state: { mergeChanges: [] },
    checkout: async (...args) => calls.push(['checkout', ...args]),
    createBranch: async (...args) => calls.push(['createBranch', ...args]),
    tag: async (...args) => calls.push(['tag', ...args]),
    status: async () => calls.push(['status']),
  };

  assert.equal(await checkoutDetached(repository, 'abc123'), true);
  assert.equal(await createBranchFromCommit(repository, 'feature', 'abc123'), true);
  assert.equal(await createTagFromCommit(repository, 'v1.0.0', 'abc123'), true);
  const guarded = { gitPath: '/git', expectedHead: { name: 'feature', commit: firstCommit } };
  assert.equal(await cherryPick(repository, 'abc123', guarded), true);
  assert.equal(await amendMessage(repository, 'fix: clearer subject', guarded), true);
  assert.equal(await amendMessage(repository, 'fix: skip hooks', { ...guarded, noVerify: true }), true);
  assert.equal(await amendMessage(repository, '   ', { gitPath: '/git' }), false);
  assert.equal(await emptyTreeHash(repository, { gitPath: '/git' }), 'empty-tree');
  assert.deepEqual(gitExecCalls.at(-1)[1], ['hash-object', '-t', 'tree', '/dev/null']);
  assert.equal(await rollback(repository, fetchedCommit, 'mixed', {
    gitPath: '/git', expectedHead: { name: 'feature', commit: firstCommit },
  }), true);
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
  assert.deepEqual(gitExecCalls.at(-1)[1], ['reset', '--mixed', fetchedCommit]);
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
