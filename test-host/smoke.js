'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const git = require('../git-operations');
const { RepositoryViewProvider, openDiff } = require('../extension');

async function run() {
  const root = process.env.BSC_SMOKE_REPO;
  assert.ok(root, 'BSC_SMOKE_REPO is required');
  const extension = vscode.extensions.getExtension('wrick17.git-change-stats');
  assert.ok(extension, 'Better Source Control extension was not loaded');
  const builtInGit = vscode.extensions.getExtension('vscode.git');
  assert.ok(builtInGit, 'Built-in Git extension is unavailable');
  const gitExports = await builtInGit.activate();
  assert.equal(gitExports.enabled, true, 'Built-in Git extension is disabled');
  await extension.activate();
  assert.equal(extension.isActive, true);
  assert.ok((await vscode.commands.getCommands(true)).includes('gitChangeStats.refresh'), 'Extension did not register its refresh command');

  const api = gitExports.getAPI(1);
  let repository;
  for (let attempt = 0; attempt < 100; attempt++) {
    repository = api.repositories.find((item) => item.rootUri.fsPath === root);
    if (repository) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(repository, 'Git API did not open the temporary repository');
  await repository.status();
  assert.equal(repository.state.HEAD.commit, process.env.BSC_SMOKE_INITIAL_HEAD);
  assert.equal(repository.state.workingTreeChanges.length, 0);

  const file = path.join(root, 'sample.txt');
  fs.writeFileSync(file, 'after\n');
  await repository.status();
  const change = repository.state.workingTreeChanges.find((item) => item.uri.fsPath === file);
  assert.ok(change, 'Git API did not report the edit');
  await openDiff(api, repository, 'unstaged', change);
  assert.ok(vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
    tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.fsPath === file)),
  'Diff editor did not open for the edited file');
  assert.equal(await git.stage(repository, file), true);
  await repository.status();
  assert.ok(repository.state.indexChanges.some((item) => item.uri.fsPath === file));
  assert.equal(await git.commit(repository, 'Smoke test commit'), true);
  await repository.status();
  assert.notEqual(repository.state.HEAD.commit, process.env.BSC_SMOKE_INITIAL_HEAD);
  assert.equal(repository.state.indexChanges.length, 0);

  const context = {
    globalState: { get: (_, fallback) => fallback },
    workspaceState: { get: (_, fallback) => fallback },
  };
  const provider = new RepositoryViewProvider(api, context, { info() {}, warn() {}, error() {} });
  const messages = [];
  provider.view = { webview: { postMessage: async (message) => { messages.push(message); } } };
  try {
    assert.equal(await git.commit(repository, '   '), false);
    await provider.receiveMessage({
      type: 'commit', message: '   ', repositoryId: root,
    });
    assert.equal(provider.busyRepositories.has(root), false);
    assert.deepEqual(messages.filter((message) => message.type === 'busy').map((message) => message.busy), [true, false]);
  } finally {
    provider.dispose();
  }
  fs.writeFileSync(process.env.BSC_SMOKE_RESULT, 'passed\n');
  console.log('Extension-host smoke passed: activation, status, diff, stage, commit, rejected operation.');
}

module.exports = { run };
