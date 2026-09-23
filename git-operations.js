'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const vscode = require('vscode');

const execGit = promisify(execFile);
const EXEC_TIMEOUT_MS = 300_000;
let execQueue = Promise.resolve();
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

function queueGit(action) {
  const result = execQueue.then(action);
  execQueue = result.catch(() => {});
  return result;
}

function execNow(repository, gitPath, args, options = {}) {
  if (!gitPath) throw new Error('Git executable unavailable.');
  const invocation = [gitPath, ...args].map((value) => JSON.stringify(value)).join(' ');
  logInvocation(repository, invocation);
  return execGit(gitPath, args, {
    cwd: repository.rootUri.fsPath,
    ...options,
    timeout: Math.min(options.timeout > 0 ? options.timeout : EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MS),
    killSignal: 'SIGKILL',
  });
}

function execGitCommand(repository, gitPath, args, options = {}) {
  // ponytail: one process at a time; add a small pool only if large workspaces prove this too slow.
  return queueGit(() => execNow(repository, gitPath, args, options));
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
    void vscode.window.showErrorMessage(
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
    await execGitCommand(repository, gitPath, args, options);
  } finally {
    await callApi(repository, 'status');
  }
}

async function operationState(repository, { gitPath } = {}) {
  if (repository.state.rebaseCommit) return 'rebase';
  if (!gitPath) return;
  const gitDir = (await execGitCommand(repository, gitPath, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  for (const [marker, operation] of [
    ['REBASE_HEAD', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['MERGE_HEAD', 'merge'],
  ]) {
    if (await readOperationMarker(gitDir, marker)) return operation;
  }
}

async function readOperationMarker(gitDir, marker) {
  try {
    return (await fs.readFile(path.join(gitDir, marker), 'utf8')).trim() || undefined;
  } catch (error) {
    if (error?.code === 'ENOENT') return;
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
  if (operation === 'rebase') return run(repository, 'Continuing rebase', () =>
    repository.state.rebaseCommit
      ? callApi(repository, 'commit', repository.state.rebaseCommit.message, {})
      : runGit(repository, options.gitPath, ['rebase', '--continue']));
  if (operation === 'cherry-pick' || operation === 'revert') return run(repository, `Continuing ${operation}`, () =>
    runGit(repository, options.gitPath, [operation, '--continue']));
  return false;
}

async function abortOperation(repository, operation, options = {}) {
  if (await operationState(repository, options) !== operation) return false;
  const { gitPath } = options;
  let expected;
  try {
    expected = await queueGit(() => readOperationIdentity(repository, gitPath, operation));
  } catch (error) {
    log?.error(`[${path.basename(repository.rootUri.fsPath)}] Checking ${operation} failed.`, error);
    void vscode.window.showErrorMessage(
      `Checking ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
  const action = `Abort ${operation[0].toUpperCase()}${operation.slice(1)}`;
  const picked = await vscode.window.showWarningMessage(
    `${action}? This restores the repository to its state before the ${operation}.`,
    { modal: true },
    action,
  );
  if (picked !== action) return false;
  return run(repository, `Aborting ${operation}`, async () => {
    try {
      await queueGit(async () => {
        const actual = await readOperationIdentity(repository, gitPath, operation);
        if (actual.branch !== expected.branch || actual.head !== expected.head
          || actual.marker !== expected.marker || actual.rebaseCommit !== expected.rebaseCommit) {
          throw new Error('The Git operation changed during confirmation.');
        }
        if (operation === 'merge') await callApi(repository, 'mergeAbort');
        else await execNow(repository, gitPath, [operation, '--abort']);
      });
    } finally {
      await callApi(repository, 'status');
    }
  });
}

async function readOperationIdentity(repository, gitPath, operation) {
  if (!gitPath) throw new Error('Git executable unavailable.');
  const gitDir = (await execNow(repository, gitPath, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  const markerName = {
    merge: 'MERGE_HEAD', rebase: 'REBASE_HEAD',
    'cherry-pick': 'CHERRY_PICK_HEAD', revert: 'REVERT_HEAD',
  }[operation];
  const marker = await readOperationMarker(gitDir, markerName);
  const rebaseCommit = operation === 'rebase' ? repository.state.rebaseCommit?.hash : undefined;
  if (!marker && !rebaseCommit) throw new Error(`The ${operation} is no longer active.`);
  const head = (await execNow(repository, gitPath, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  let branch;
  try {
    branch = (await execNow(repository, gitPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  return { head, branch, marker, rebaseCommit };
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

async function publish(repository, { noVerify = false, gitPath } = {}) {
  if (!repository) return;
  const head = repository.state.HEAD;
  if (!head?.name || !head.commit) {
    await vscode.window.showInformationMessage('Check out a committed local branch before publishing.');
    return false;
  }
  if (head.upstream) {
    await vscode.window.showInformationMessage('This branch already has an upstream. Use Push instead.');
    return false;
  }
  const remotes = repository.state.remotes.filter((remote) => remote.pushUrl);
  if (!remotes.length) {
    await vscode.window.showInformationMessage('Configure a push remote before publishing.');
    return false;
  }
  const remote = remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(
    remotes.map((item) => ({ label: item.name, description: item.pushUrl, remote: item })),
    { title: 'Publish Branch', placeHolder: 'Select a remote' },
  ).then((item) => item?.remote);
  if (!remote) return false;
  return run(repository, `Publishing ${head.name}`, async () => {
    if (repository.state.HEAD?.name !== head.name || repository.state.HEAD?.commit !== head.commit) {
      throw new Error('The current branch or commit changed before publishing.');
    }
    if (noVerify) {
      if (!gitPath) throw new Error('Git executable unavailable.');
      try {
        await queueGit(async () => {
          await assertExpectedHead(repository, gitPath, head);
          await assertNoOperation(repository, gitPath);
          await execNow(repository, gitPath,
            ['push', '--no-verify', '--set-upstream', remote.name, `HEAD:refs/heads/${head.name}`]);
        });
      } finally {
        await callApi(repository, 'status');
      }
    } else {
      await callApi(repository, 'push', remote.name, head.name, true);
      await callApi(repository, 'status');
    }
    const branch = await callApi(repository, 'getBranch', head.name);
    if (branch?.upstream?.remote !== remote.name || branch.upstream.name !== head.name) {
      throw new Error(`Push completed, but ${head.name} is not tracking ${remote.name}/${head.name}.`);
    }
  });
}

async function resetToOrigin(repository, { gitPath } = {}) {
  if (!repository) return;
  const { name: branch, commit } = repository.state.HEAD ?? {};
  if (!branch) {
    await vscode.window.showInformationMessage('Check out a local branch before resetting to origin.');
    return false;
  }
  if (!commit) {
    await vscode.window.showInformationMessage('The current branch has no commit to reset.');
    return false;
  }
  if (!repository.state.remotes.some((remote) => remote.name === 'origin' && remote.fetchUrl)) {
    await vscode.window.showInformationMessage('This repository has no origin fetch remote.');
    return false;
  }
  if (repository.state.mergeChanges.length || await operationState(repository, { gitPath })) {
    await vscode.window.showInformationMessage('Finish the current Git operation or resolve conflicts before resetting to origin.');
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
  return run(repository, `Resetting ${branch} to origin`, async () => {
    if (!gitPath) throw new Error('Git executable unavailable.');
    try {
      await queueGit(async () => {
        await assertExpectedHead(repository, gitPath, { name: branch, commit });
        await assertNoOperation(repository, gitPath);
        await execNow(repository, gitPath, ['fetch', 'origin', `refs/heads/${branch}`]);
        const fetched = (await execNow(repository, gitPath,
          ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).stdout.trim();
        if (!/^[0-9a-f]{40,64}$/.test(fetched)) throw new Error('Fetched commit could not be verified.');
        await assertExpectedHead(repository, gitPath, { name: branch, commit });
        await assertNoOperation(repository, gitPath);
        await execNow(repository, gitPath, ['reset', '--hard', fetched]);
      });
    } finally {
      await callApi(repository, 'status');
    }
  });
}

async function assertExpectedHead(repository, gitPath, expectedHead) {
  if (!expectedHead?.commit) throw new Error('Expected commit is required.');
  let branch;
  try {
    branch = (await execNow(repository, gitPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  const commit = (await execNow(repository, gitPath, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  if (branch !== expectedHead.name || commit !== expectedHead.commit) {
    throw new Error('The current branch or commit changed before the operation.');
  }
}

async function assertNoOperation(repository, gitPath) {
  if (repository.state.rebaseCommit || repository.state.mergeChanges.length) {
    throw new Error('Finish the current Git operation or resolve conflicts first.');
  }
  const gitDir = (await execNow(repository, gitPath, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  for (const marker of ['REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_HEAD']) {
    if (await readOperationMarker(gitDir, marker)) {
      throw new Error('Finish the current Git operation first.');
    }
  }
  const { stdout } = await execNow(repository, gitPath, ['ls-files', '-u']);
  if (stdout.length) throw new Error('Resolve unmerged files before continuing.');
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

function cherryPick(repository, ref, { gitPath, expectedHead } = {}) {
  return run(repository, 'Cherry-picking commit', () =>
    runGuardedGit(repository, gitPath, ['cherry-pick', ref], expectedHead),
  );
}

function amendMessage(repository, message, { noVerify = false, gitPath, expectedHead } = {}) {
  const value = message?.trim();
  if (!value) return false;
  const args = ['commit', '--amend', '--only', '-m', value];
  if (noVerify) args.push('--no-verify');
  return run(repository, 'Amending commit message', () =>
    runGuardedGit(repository, gitPath, args, expectedHead));
}

async function runGuardedGit(repository, gitPath, args, expectedHead) {
  if (!gitPath) throw new Error('Git executable unavailable.');
  try {
    await queueGit(async () => {
      await assertExpectedHead(repository, gitPath, expectedHead);
      await assertNoOperation(repository, gitPath);
      await execNow(repository, gitPath, args);
    });
  } finally {
    await callApi(repository, 'status');
  }
}

async function emptyTreeHash(repository, { gitPath } = {}) {
  if (!gitPath) throw new Error('Git executable unavailable.');
  const { stdout } = await execGitCommand(repository, gitPath, ['hash-object', '-t', 'tree', '/dev/null']);
  const hash = stdout.trim();
  if (!hash) throw new Error('Unable to resolve the empty Git tree.');
  return hash;
}

function rollback(repository, ref, mode, { gitPath, expectedHead } = {}) {
  if (!['soft', 'mixed', 'hard'].includes(mode) || !/^[0-9a-f]{40,64}$/.test(ref)
    || !expectedHead?.name) return false;
  return run(repository, 'Rolling back branch', async () => {
    if (!gitPath) throw new Error('Git executable unavailable.');
    try {
      await queueGit(async () => {
        await assertExpectedHead(repository, gitPath, expectedHead);
        await assertNoOperation(repository, gitPath);
        const ancestor = (await execNow(repository, gitPath, ['merge-base', 'HEAD', ref])).stdout.trim();
        if (ancestor !== ref) throw new Error('The selected commit is no longer an ancestor of HEAD.');
        await execNow(repository, gitPath, ['reset', `--${mode}`, ref]);
      });
    } finally {
      await callApi(repository, 'status');
    }
  });
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

function viewStash(repository) {
  return run(repository, 'Viewing stash', () =>
    runVsCodeCommand(repository, 'git.stashView', repository.rootUri));
}

function applyStash(repository) {
  return run(repository, 'Applying stash', () =>
    runVsCodeCommand(repository, 'git.stashApply', repository.rootUri));
}

function createWorktree(repository) {
  return run(repository, 'Creating worktree', () =>
    runVsCodeCommand(repository, 'git.createWorktree', repository.rootUri));
}

function revertCommit(repository, ref, { gitPath, expectedHead } = {}) {
  if (!/^[0-9a-f]{40,64}$/.test(ref)) return false;
  return run(repository, 'Reverting commit', async () => {
    if (!gitPath) throw new Error('Git executable unavailable.');
    try {
      await queueGit(async () => {
        await assertExpectedHead(repository, gitPath, expectedHead);
        await assertNoOperation(repository, gitPath);
        const { stdout } = await execNow(repository, gitPath, ['rev-list', '--parents', '-n', '1', ref]);
        if (stdout.trim().split(/\s+/).length !== 2) {
          throw new Error('Only single-parent commits can be reverted.');
        }
        await execNow(repository, gitPath, ['revert', '--no-edit', ref]);
      });
    } finally {
      await callApi(repository, 'status');
    }
  });
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

function pickBranch(repository) {
  return run(repository, 'Switching branch', () =>
    runVsCodeCommand(repository, 'git.checkout', repository.rootUri));
}

module.exports = {
  abortOperation,
  applyStash,
  amendMessage,
  checkoutDetached,
  cherryPick,
  commit,
  continueOperation,
  createBranchFromCommit,
  createTagFromCommit,
  createWorktree,
  discard,
  discardAll,
  emptyTreeHash,
  execGitCommand,
  fetch,
  operationState,
  pickBranch,
  popStash,
  popStashSelected,
  publish,
  pull,
  pullFrom,
  pullMerge,
  pullRebase,
  push,
  resetToOrigin,
  revertCommit,
  rollback,
  setLog,
  stage,
  stageAll,
  stash,
  unstage,
  unstageAll,
  viewStash,
};
