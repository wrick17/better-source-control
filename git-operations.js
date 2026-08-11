'use strict';

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');

const execGit = promisify(execFile);
let log;

function setLog(value) {
  log = value;
}

function logInvocation(repository, invocation) {
  log?.info?.(`[${path.basename(repository.rootUri.fsPath)}] > ${invocation}`);
}

function callApi(repository, method, ...args) {
  const values = args.map((value) => JSON.stringify(value)).join(', ');
  logInvocation(repository, `Git API repository.${method}(${values})`);
  return repository[method](...args);
}

function runVsCodeCommand(repository, command, ...args) {
  logInvocation(repository, `VS Code command ${command}`);
  return vscode.commands.executeCommand(command, ...args);
}

function exec(repository, gitPath, args, options = {}) {
  logInvocation(repository, [gitPath, ...args].map((value) => JSON.stringify(value)).join(' '));
  return execGit(gitPath, args, { cwd: repository.rootUri.fsPath, ...options });
}

async function run(repository, title, action) {
  if (!repository) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title },
      action,
    );
    return true;
  } catch (error) {
    log?.error(`[${path.basename(repository.rootUri.fsPath)}] ${title} failed.`, error);
    await vscode.window.showErrorMessage(
      `${title} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function pull(repository) {
  return run(repository, 'Pulling changes', () => callApi(repository, 'pull'));
}

function fetch(repository) {
  return run(repository, 'Fetching changes', () => callApi(repository, 'fetch'));
}

function pullFrom(repository, { noVerify = false, gitPath } = {}) {
  if (!noVerify) {
    return run(repository, 'Pulling from branch', () =>
      runVsCodeCommand(repository, 'git.pullFrom', repository.rootUri));
  }
  return run(repository, 'Pulling from branch', async () => {
    const remotes = repository.state.remotes.filter((remote) => remote.fetchUrl);
    if (!remotes.length) throw new Error('No remotes are configured.');
    const remote = remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(
      remotes.map((item) => ({ label: item.name, description: item.fetchUrl, remote: item })),
      { title: 'Pull from', placeHolder: 'Select a remote' },
    ).then((item) => item?.remote);
    if (!remote) return;
    const refs = await callApi(repository, 'getRefs', { pattern: `refs/remotes/${remote.name}/` });
    const picked = await vscode.window.showQuickPick(
      refs.filter((ref) => ref.name).map((ref) => ({ label: ref.name, ref })),
      { title: `Pull from ${remote.name}`, placeHolder: 'Select a branch' },
    );
    if (!picked) return;
    const branch = picked.ref.name.slice(remote.name.length + 1);
    await callApi(repository, 'fetch', remote.name, branch);
    await runGit(repository, gitPath, ['merge', '--no-edit', '--no-verify', 'FETCH_HEAD']);
  });
}

async function runGit(repository, gitPath, args, options = {}) {
  if (!gitPath) throw new Error('Git executable unavailable.');
  try {
    await exec(repository, gitPath, args, options);
  } finally {
    await callApi(repository, 'status');
  }
}

async function operationState(repository, { gitPath } = {}) {
  if (repository.state.rebaseCommit) return 'rebase';
  if (repository.state.mergeChanges.length) return 'merge';
  if (!gitPath) return;
  try {
    await exec(repository, gitPath, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    return 'merge';
  } catch (error) {
    if (error?.code === 1) return;
    throw error;
  }
}

async function continueOperation(repository, operation, message, options = {}) {
  if (await operationState(repository, options) !== operation) return false;
  if (operation === 'merge') {
    if (repository.state.mergeChanges.length) {
      await vscode.window.showWarningMessage('Resolve all merge conflicts before continuing.');
      return false;
    }
    const value = message?.trim();
    if (!value) return false;
    return run(repository, 'Continuing merge', () =>
      callApi(repository, 'commit', value, { noVerify: options.noVerify ?? false }));
  }
  return run(repository, 'Continuing rebase', () =>
    callApi(repository, 'commit', repository.state.rebaseCommit.message, {}));
}

async function abortOperation(repository, operation, options = {}) {
  if (await operationState(repository, options) !== operation) return false;
  const action = `Abort ${operation[0].toUpperCase()}${operation.slice(1)}`;
  const picked = await vscode.window.showWarningMessage(
    `${action}? This restores the repository to its state before the ${operation}.`,
    { modal: true },
    action,
  );
  if (picked !== action) return false;
  return run(repository, `Aborting ${operation}`, () => operation === 'merge'
    ? callApi(repository, 'mergeAbort')
    : runGit(repository, options.gitPath, ['rebase', '--abort']));
}

function pullMerge(repository, { noVerify = false, gitPath } = {}) {
  return run(repository, 'Pulling changes with merge', async () => {
    if (!noVerify) return callApi(repository, 'pull');
    await callApi(repository, 'fetch');
    await runGit(repository, gitPath, ['merge', '--no-edit', '--no-verify', '@{upstream}']);
  });
}

function pullRebase(repository, { noVerify = false, gitPath } = {}) {
  return run(repository, 'Pulling changes with rebase', async () => {
    if (!noVerify) {
      return runVsCodeCommand(repository, 'git.pullRebase', repository.rootUri);
    }
    await callApi(repository, 'fetch');
    await runGit(repository, gitPath, ['rebase', '--no-verify', '@{upstream}']);
  });
}

function push(repository, { noVerify = false, gitPath } = {}) {
  return run(repository, 'Pushing changes', () => noVerify
    ? runGit(repository, gitPath, ['push', '--no-verify'])
    : callApi(repository, 'push'));
}

async function resetToOrigin(repository, { gitPath } = {}) {
  if (!repository) return;
  const branch = repository.state.HEAD?.name;
  if (!branch) {
    await vscode.window.showInformationMessage('Check out a local branch before resetting to origin.');
    return false;
  }
  if (!repository.state.remotes.some((remote) => remote.name === 'origin' && remote.fetchUrl)) {
    await vscode.window.showInformationMessage('This repository has no origin fetch remote.');
    return false;
  }
  if (repository.state.rebaseCommit || repository.state.mergeChanges.length) {
    await vscode.window.showInformationMessage('Finish or abort the current merge or rebase before resetting to origin.');
    return false;
  }
  const action = 'Reset Branch to Origin';
  const confirmed = await vscode.window.showWarningMessage(
    `Reset ${branch} to origin/${branch}?`,
    {
      modal: true,
      detail: `This fetches origin, then permanently discards local commits and tracked changes not present on origin/${branch}. Untracked files may also be overwritten.`,
    },
    action,
  );
  if (confirmed !== action) return false;
  if (repository.state.HEAD?.name !== branch) {
    await vscode.window.showInformationMessage('The current branch changed before it could be reset.');
    return false;
  }
  return run(repository, `Resetting ${branch} to origin`, async () => {
    await callApi(repository, 'fetch', 'origin', branch);
    await runGit(repository, gitPath, ['reset', '--hard', `refs/remotes/origin/${branch}`]);
  });
}

function checkoutDetached(repository, ref) {
  return run(repository, 'Checking out commit', () => callApi(repository, 'checkout', ref));
}

function createBranchFromCommit(repository, name, ref) {
  return run(repository, `Creating branch ${name}`, () =>
    callApi(repository, 'createBranch', name, true, ref));
}

function createTagFromCommit(repository, name, ref) {
  return run(repository, `Creating tag ${name}`, () => callApi(repository, 'tag', name, '', ref));
}

function cherryPick(repository, ref, { gitPath } = {}) {
  return run(repository, 'Cherry-picking commit', () =>
    runGit(repository, gitPath, ['cherry-pick', ref]),
  );
}

function amendMessage(repository, message, { noVerify = false, gitPath } = {}) {
  const value = message?.trim();
  if (!value) return false;
  const args = ['commit', '--amend', '--only', '-m', value];
  if (noVerify) args.push('--no-verify');
  return run(repository, 'Amending commit message', () => runGit(repository, gitPath, args));
}

async function emptyTreeHash(repository, { gitPath } = {}) {
  if (!gitPath) throw new Error('Git executable unavailable.');
  const { stdout } = await exec(repository, gitPath, ['hash-object', '-t', 'tree', os.devNull]);
  const hash = stdout.trim();
  if (!hash) throw new Error('Unable to resolve the empty Git tree.');
  return hash;
}

function rollback(repository, ref, mode, { gitPath } = {}) {
  if (!['soft', 'mixed', 'hard'].includes(mode)) return false;
  return run(repository, 'Rolling back branch', () =>
    runGit(repository, gitPath, ['reset', `--${mode}`, ref]),
  );
}

function stash(repository) {
  return run(repository, 'Stashing changes', () =>
    callApi(repository, 'createStash', { includeUntracked: true }));
}

function popStash(repository) {
  return run(repository, 'Popping latest stash', () => callApi(repository, 'popStash'));
}

function popStashSelected(repository) {
  return run(repository, 'Popping stash', () =>
    runVsCodeCommand(repository, 'git.stashPop', repository.rootUri));
}

function stage(repository, filePath) {
  return stageAll(repository, [filePath]);
}

function unstage(repository, filePath) {
  return run(repository, 'Unstaging file', () => callApi(repository, 'revert', [filePath]));
}

function stageAll(repository, filePaths) {
  return run(repository, filePaths.length === 1 ? 'Staging file' : 'Staging all changes', () =>
    callApi(repository, 'add', filePaths));
}

function unstageAll(repository) {
  return run(repository, 'Unstaging all changes', () => callApi(repository, 'revert', []));
}

async function discard(repository, filePath) {
  const label = path.relative(repository.rootUri.fsPath, filePath);
  const discardLabel = 'Discard Changes';
  const choice = await vscode.window.showWarningMessage(
    `Discard changes in ${label}?`,
    { modal: true, detail: 'This cannot be undone.' },
    discardLabel,
  );
  if (choice === discardLabel) {
    await run(repository, 'Discarding changes', () => callApi(repository, 'clean', [filePath]));
  }
}

async function discardAll(repository, kind, filePaths) {
  if (!repository || !filePaths.length) return false;
  const staged = kind === 'staged';
  const label = staged ? 'Discard All Staged Changes' : 'Discard All Changes';
  const choice = await vscode.window.showWarningMessage(
    staged ? 'Discard all changes in staged files?' : 'Discard all unstaged changes?',
    {
      modal: true,
      detail: staged
        ? 'This also discards any unstaged edits in the same files and cannot be undone.'
        : 'Untracked files may be permanently deleted. This cannot be undone.',
    },
    label,
  );
  if (choice !== label) return false;
  return run(repository, label, async () => {
    if (staged) await callApi(repository, 'revert', filePaths);
    await callApi(repository, 'clean', filePaths);
  });
}

async function commit(repository, message, { noVerify = false } = {}) {
  if (!repository) return;
  const value = message?.trim();
  if (!value) return false;
  return run(repository, 'Committing changes', async () => {
    if (!repository.state.indexChanges.length) {
      const paths = [...new Set([
        ...repository.state.mergeChanges,
        ...repository.state.workingTreeChanges,
        ...repository.state.untrackedChanges,
      ].map((change) => change.uri.fsPath))];
      if (!paths.length) throw new Error('No changes to commit.');
      await callApi(repository, 'add', paths);
    }
    await callApi(repository, 'commit', value, { noVerify });
  });
}

async function pickBranch(repository) {
  if (!repository) return;
  const current = repository.state.HEAD?.name;
  const refs = await callApi(repository, 'getBranches', { remote: false });
  const branches = [...new Set(refs.map((ref) => ref.name).filter(Boolean))].sort();
  const picked = await vscode.window.showQuickPick(
    branches.map((name) => ({ label: name, description: name === current ? 'current' : undefined })),
    { title: 'Switch Branch', placeHolder: current ?? 'Select a branch' },
  );
  if (picked && picked.label !== current) {
    await run(repository, `Switching to ${picked.label}`, () =>
      callApi(repository, 'checkout', picked.label));
  }
}

module.exports = {
  abortOperation,
  amendMessage,
  checkoutDetached,
  cherryPick,
  commit,
  continueOperation,
  createBranchFromCommit,
  createTagFromCommit,
  discard,
  discardAll,
  emptyTreeHash,
  fetch,
  operationState,
  pickBranch,
  popStash,
  popStashSelected,
  pull,
  pullFrom,
  pullMerge,
  pullRebase,
  push,
  resetToOrigin,
  rollback,
  setLog,
  stage,
  stageAll,
  stash,
  unstage,
  unstageAll,
};
