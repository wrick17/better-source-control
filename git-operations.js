'use strict';

const vscode = require('vscode');

/**
 * Shows a toast notification to the user
 * @param {string} message - Toast message
 * @param {'info'|'warning'|'error'} level - Notification level
 */
async function showNotification(message, level = 'info') {
  const methods = {
    info: 'showInformationMessage',
    warning: 'showWarningMessage',
    error: 'showErrorMessage',
  };
  return vscode.window[methods[level]](message);
}

/**
 * Executes a git command in a repository
 * @param {import('vscode').Repository} repo - VS Code Repository object
 * @param {string[]} args - Git command arguments
 * @returns {Promise<string>} - Command output
 */
async function executeGit(repo, args) {
  try {
    const output = await repo.inputBox.run(args.join(' '));
    return output || '';
  } catch (error) {
    throw new Error(`Git error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Pull changes from remote
 * @param {import('vscode').Repository} repo - VS Code Repository object
 */
async function pullRepo(repo) {
  const progress = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Pulling changes...' },
    async () => {
      try {
        await repo.pull();
        await showNotification('Pull successful', 'info');
        return true;
      } catch (error) {
        await showNotification(`Pull failed: ${error.message}`, 'error');
        return false;
      }
    },
  );
  return progress;
}

/**
 * Push changes to remote
 * @param {import('vscode').Repository} repo - VS Code Repository object
 */
async function pushRepo(repo) {
  const progress = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Pushing changes...' },
    async () => {
      try {
        await repo.push();
        await showNotification('Push successful', 'info');
        return true;
      } catch (error) {
        await showNotification(`Push failed: ${error.message}`, 'error');
        return false;
      }
    },
  );
  return progress;
}

/**
 * Stash untracked and staged changes
 * @param {import('vscode').Repository} repo - VS Code Repository object
 */
async function stashRepo(repo) {
  const progress = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Stashing changes...' },
    async () => {
      try {
        await repo.inputBox.run('stash');
        await showNotification('Changes stashed', 'info');
        return true;
      } catch (error) {
        await showNotification(`Stash failed: ${error.message}`, 'error');
        return false;
      }
    },
  );
  return progress;
}

/**
 * List available stashes
 * @param {import('vscode').Repository} repo - VS Code Repository object
 * @returns {Promise<string[]>} - Array of stash descriptions
 */
async function listStashes(repo) {
  try {
    const output = await repo.inputBox.run('stash list');
    return output
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => line.trim());
  } catch (error) {
    return [];
  }
}

/**
 * Pop a stash by index (show picker if not specified)
 * @param {import('vscode').Repository} repo - VS Code Repository object
 * @param {number} [stashIndex] - Optional stash index (0-based)
 */
async function popStash(repo, stashIndex) {
  try {
    let targetIndex = stashIndex;

    if (targetIndex === undefined) {
      const stashes = await listStashes(repo);
      if (stashes.length === 0) {
        await showNotification('No stashes available', 'warning');
        return false;
      }

      const picked = await vscode.window.showQuickPick(stashes, {
        placeHolder: 'Select a stash to pop',
      });

      if (!picked) return false;

      targetIndex = stashes.indexOf(picked);
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Popping stash...' },
      async () => {
        await repo.inputBox.run(`stash pop stash@{${targetIndex}}`);
      },
    );

    await showNotification('Stash popped successfully', 'info');
    return true;
  } catch (error) {
    await showNotification(`Stash pop failed: ${error.message}`, 'error');
    return false;
  }
}

/**
 * Get diff for generating commit message
 * @param {import('vscode').Repository} repo - VS Code Repository object
 * @returns {Promise<string>} - Diff output
 */
async function getDiff(repo) {
  try {
    return await repo.inputBox.run('diff --cached');
  } catch {
    return '';
  }
}

/**
 * Generate commit message using vscode.lm (on-device LLM)
 * @param {import('vscode').Repository} repo - VS Code Repository object
 * @param {string} diff - Git diff output
 * @returns {Promise<string|null>} - Generated commit message or null if unavailable
 */
async function generateCommitMessage(repo, diff) {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4' });
    if (!models.length) return null;

    const messages = [
      vscode.LanguageModelChatMessage.User(
        `Generate a concise, conventional commit message (format: "type: subject") for this git diff:\n\n${diff}\n\nRespond with only the commit message, no explanation.`,
      ),
    ];

    const chatResponse = await models[0].sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

    let fullResponse = '';
    for await (const chunk of chatResponse.text) {
      fullResponse += chunk;
    }

    return fullResponse.trim();
  } catch {
    return null;
  }
}

/**
 * Commit changes with message
 * @param {import('vscode').Repository} repo - VS Code Repository object
 * @param {string} message - Commit message
 * @param {boolean} [useAI] - Try to generate message with AI if not provided
 */
async function commitRepo(repo, message, useAI = false) {
  const progress = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Committing changes...' },
    async () => {
      try {
        let commitMessage = message;

        if (!commitMessage && useAI) {
          const diff = await getDiff(repo);
          if (diff) {
            const generated = await generateCommitMessage(repo, diff);
            if (generated) {
              commitMessage = generated;
            }
          }
        }

        if (!commitMessage) {
          const input = await vscode.window.showInputBox({
            prompt: 'Enter commit message',
            validateInput: (val) => (val.trim() ? null : 'Message cannot be empty'),
          });

          if (!input) return false;
          commitMessage = input;
        }

        await repo.commit(commitMessage);
        await showNotification('Commit successful', 'info');
        return true;
      } catch (error) {
        await showNotification(`Commit failed: ${error.message}`, 'error');
        return false;
      }
    },
  );
  return progress;
}

/**
 * List branches in repository
 * @param {import('vscode').Repository} repo - VS Code Repository object
 * @returns {Promise<string[]>} - Array of branch names
 */
async function listBranches(repo) {
  try {
    const output = await repo.inputBox.run('branch -a');
    return output
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => line.replace(/^\*\s+/, '').trim());
  } catch {
    return [];
  }
}

/**
 * Checkout a branch
 * @param {import('vscode').Repository} repo - VS Code Repository object
 * @param {string} [branchName] - Branch name (shows picker if not provided)
 */
async function checkoutBranch(repo, branchName) {
  try {
    let targetBranch = branchName;

    if (!targetBranch) {
      const branches = await listBranches(repo);
      if (branches.length === 0) {
        await showNotification('No branches found', 'warning');
        return false;
      }

      targetBranch = await vscode.window.showQuickPick(branches, {
        placeHolder: 'Select branch to checkout',
      });

      if (!targetBranch) return false;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking out ${targetBranch}...` },
      async () => {
        await repo.inputBox.run(`checkout ${targetBranch}`);
      },
    );

    await showNotification(`Checked out: ${targetBranch}`, 'info');
    return true;
  } catch (error) {
    await showNotification(`Checkout failed: ${error.message}`, 'error');
    return false;
  }
}

/**
 * Get file changes with detailed info
 * @param {import('vscode').Repository} repo - VS Code Repository object
 * @returns {Promise<Array>} - Array of { uri, type, addedLines, deletedLines }
 */
async function getFileChanges(repo) {
  try {
    const changes = [];
    const allChanges = [
      ...(repo.state.indexChanges ?? []),
      ...(repo.state.workingTreeChanges ?? []),
      ...(repo.state.untrackedChanges ?? []),
    ];

    const seenUris = new Set();

    for (const change of allChanges) {
      const uriStr = change.uri.toString();
      if (seenUris.has(uriStr)) continue;
      seenUris.add(uriStr);

      try {
        // Get diff stats for this file
        const stats = await repo.inputBox.run(`diff --stat ${change.uri.fsPath}`);
        const match = stats.match(/(\d+)\s+insertion|(\d+)\s+deletion/g);

        const addedLines = match
          ? parseInt(match.find((m) => m.includes('insertion'))?.match(/\d+/)[0] ?? 0)
          : 0;
        const deletedLines = match
          ? parseInt(match.find((m) => m.includes('deletion'))?.match(/\d+/)[0] ?? 0)
          : 0;

        changes.push({
          uri: change.uri,
          type: getChangeType(change),
          addedLines,
          deletedLines,
        });
      } catch {
        // If diff fails, add basic info
        changes.push({
          uri: change.uri,
          type: getChangeType(change),
          addedLines: 0,
          deletedLines: 0,
        });
      }
    }

    return changes;
  } catch (error) {
    return [];
  }
}

/**
 * Determine change type from status code
 * @param {import('vscode').Change} change - Change object
 * @returns {string} - 'added'|'modified'|'deleted'|'renamed'|'untracked'
 */
function getChangeType(change) {
  const statusMap = {
    // IndexStatus and WorkingTreeStatus values
    0: 'untracked',
    1: 'modified',
    2: 'added',
    4: 'deleted',
    8: 'renamed',
    16: 'copied',
    32: 'unmodified',
    64: 'type-changed',
    128: 'unmerged',
    256: 'unknown',
    512: 'ignored',
  };
  return statusMap[change.status] || 'unknown';
}

module.exports = {
  pullRepo,
  pushRepo,
  stashRepo,
  popStash,
  commitRepo,
  generateCommitMessage,
  listBranches,
  checkoutBranch,
  getFileChanges,
  showNotification,
};
