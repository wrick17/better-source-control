'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {
    ProgressLocation: { Window: 1 },
    commands: { executeCommand: async () => {} },
    window: {
      withProgress: async (_, action) => action(),
      showErrorMessage: async () => {},
      showInformationMessage: async () => {},
      showWarningMessage: async (...args) => args.at(-1),
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { abortOperation, cherryPick, emptyTreeHash, operationState, publish, resetToOrigin, revertCommit, rollback } = require('../git-operations');
Module._load = originalLoad;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
Object.assign(process.env, gitEnv);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  return { dir, repo };
}

function repository(repo, remotes = []) {
  const state = {
    HEAD: { name: git(repo, 'branch', '--show-current'), commit: git(repo, 'rev-parse', 'HEAD') },
    mergeChanges: [], rebaseCommit: undefined, remotes,
  };
  return {
    rootUri: { fsPath: repo }, state,
    status: async () => {
      state.HEAD = { name: git(repo, 'branch', '--show-current'), commit: git(repo, 'rev-parse', 'HEAD') };
      state.mergeChanges = git(repo, 'ls-files', '-u') ? [{}] : [];
    },
  };
}

test('linked worktree cherry-pick conflict is classified and abortable', async (t) => {
  const { dir, repo } = setup(t);
  git(repo, 'checkout', '-qb', 'topic');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'topic\n');
  git(repo, 'commit', '-qam', 'topic');
  const topic = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'main\n');
  git(repo, 'commit', '-qam', 'main');
  const head = git(repo, 'rev-parse', 'HEAD');
  const linked = path.join(dir, 'linked');
  git(repo, 'worktree', 'add', '-qb', 'linked', linked, 'main');
  const target = repository(linked);

  assert.equal(await cherryPick(target, topic, { gitPath: 'git', expectedHead: target.state.HEAD }), false);
  assert.equal(await operationState(target, { gitPath: 'git' }), 'cherry-pick');
  assert.equal(await abortOperation(target, 'cherry-pick', { gitPath: 'git' }), true);
  assert.equal(await operationState(target, { gitPath: 'git' }), undefined);
  assert.equal(git(linked, 'rev-parse', 'HEAD'), head);
  assert.equal(git(linked, 'status', '--porcelain'), '');
});

test('a branch named MERGE_HEAD is not mistaken for an active merge', async (t) => {
  const { repo } = setup(t);
  git(repo, 'branch', 'MERGE_HEAD');
  assert.equal(git(repo, 'rev-parse', '--verify', 'MERGE_HEAD'), git(repo, 'rev-parse', 'HEAD'));
  const target = repository(repo);
  assert.equal(await operationState(target, { gitPath: 'git' }), undefined);
});

test('Git resolves the empty tree through its own null path', async (t) => {
  const { repo } = setup(t);
  assert.match(await emptyTreeHash(repository(repo), { gitPath: 'git' }), /^[a-f0-9]{40,64}$/);
});

test('reset uses freshly fetched FETCH_HEAD despite a stale tracking ref', async (t) => {
  const { dir, repo } = setup(t);
  const bare = path.join(dir, 'remote.git');
  fs.mkdirSync(bare);
  git(bare, 'init', '-q', '--bare');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  const base = git(repo, 'rev-parse', 'HEAD');
  const peer = path.join(dir, 'peer');
  git(dir, 'clone', '-q', bare, peer);
  fs.writeFileSync(path.join(peer, 'remote.txt'), 'remote\n');
  git(peer, 'add', '.');
  git(peer, 'commit', '-qm', 'remote');
  const remoteHead = git(peer, 'rev-parse', 'HEAD');
  git(peer, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(repo, 'local.txt'), 'local\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'local');
  git(repo, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/custom/origin/*');
  git(repo, 'update-ref', 'refs/remotes/origin/main', base);
  const target = repository(repo, [{ name: 'origin', fetchUrl: bare }]);

  assert.equal(await resetToOrigin(target, { gitPath: 'git' }), true);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), remoteHead);
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/main'), base);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('no-verify publish creates the remote branch and tracks it', async (t) => {
  const { dir, repo } = setup(t);
  const bare = path.join(dir, 'remote.git');
  fs.mkdirSync(bare);
  git(bare, 'init', '-q', '--bare');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'checkout', '-qb', 'feature');
  const target = repository(repo, [{ name: 'origin', pushUrl: bare }]);
  target.getBranch = async (name) => ({ upstream: {
    remote: git(repo, 'config', `branch.${name}.remote`),
    name: git(repo, 'config', `branch.${name}.merge`).replace('refs/heads/', ''),
  } });

  assert.equal(await publish(target, { noVerify: true, gitPath: 'git' }), true);
  assert.equal(git(repo, 'ls-remote', '--heads', 'origin', 'feature').split('\t')[0],
    git(repo, 'rev-parse', 'HEAD'));
  assert.equal(git(repo, 'config', 'branch.feature.remote'), 'origin');
});

test('rollback refuses changed HEAD, and revert preserves published history', async (t) => {
  const { repo } = setup(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'next.txt'), 'next\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'next');
  const next = git(repo, 'rev-parse', 'HEAD');
  const target = repository(repo);
  assert.equal(await rollback(target, base, 'hard', {
    gitPath: 'git', expectedHead: { name: 'main', commit: base },
  }), false);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), next);
  assert.equal(await revertCommit(target, next, { gitPath: 'git', expectedHead: target.state.HEAD }), true);
  assert.notEqual(git(repo, 'rev-parse', 'HEAD'), next);
  assert.equal(git(repo, 'merge-base', '--is-ancestor', next, 'HEAD'), '');
  assert.equal(fs.existsSync(path.join(repo, 'next.txt')), false);
});

test('conflicting revert exposes revert recovery and leaves HEAD intact after abort', async (t) => {
  const { repo } = setup(t);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'first\n');
  git(repo, 'commit', '-qam', 'first');
  const first = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'second\n');
  git(repo, 'commit', '-qam', 'second');
  const head = git(repo, 'rev-parse', 'HEAD');
  const target = repository(repo);

  assert.equal(await revertCommit(target, first, { gitPath: 'git', expectedHead: target.state.HEAD }), false);
  assert.equal(await operationState(target, { gitPath: 'git' }), 'revert');
  assert.equal(await abortOperation(target, 'revert', { gitPath: 'git' }), true);
  assert.equal(await operationState(target, { gitPath: 'git' }), undefined);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});
