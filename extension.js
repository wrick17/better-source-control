'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { changedFileCount, countTextLines, formatDescription } = require('./stats');

const VIEW_ID = 'gitChangeStats.repositories';

class RepositoryStatsProvider {
  constructor(api) {
    this.api = api;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.repositoryListeners = [];
    this.apiListeners = [
      api.onDidOpenRepository(() => this.syncRepositories()),
      api.onDidCloseRepository(() => this.syncRepositories()),
    ];
    this.syncRepositories();
  }

  syncRepositories() {
    this.repositoryListeners.splice(0).forEach((listener) => listener.dispose());
    this.repositoryListeners.push(
      ...this.api.repositories.map((repository) =>
        repository.state.onDidChange(() => this.scheduleRefresh()),
      ),
    );
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.emitter.fire(), 150);
  }

  refresh() {
    clearTimeout(this.refreshTimer);
    this.emitter.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren() {
    return Promise.all(
      [...this.api.repositories]
        .sort((a, b) => path.basename(a.rootUri.fsPath).localeCompare(path.basename(b.rootUri.fsPath)))
        .map((repository) => this.createItem(repository)),
    );
  }

  async createItem(repository) {
    const name = path.basename(repository.rootUri.fsPath);
    const branch = repository.state.HEAD?.name ?? 'detached';

    try {
      const tracked = await repository.diffWithHEADShortStats().catch(() => ({
        insertions: 0,
        deletions: 0,
      }));
      const untracked = [...new Map(
        (repository.state.untrackedChanges ?? []).map((change) => [change.uri.toString(), change.uri]),
      ).values()];
      const untrackedInsertions = (
        await Promise.all(
          untracked.map((uri) =>
            vscode.workspace.fs.readFile(uri).then(countTextLines, () => 0),
          ),
        )
      ).reduce((total, lines) => total + lines, 0);
      const files = changedFileCount(repository.state);
      const insertions = tracked.insertions + untrackedInsertions;
      const deletions = tracked.deletions;
      const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);

      item.description = formatDescription(files, insertions, deletions, branch);
      item.iconPath = new vscode.ThemeIcon('repo');
      item.resourceUri = repository.rootUri;
      item.tooltip = new vscode.MarkdownString(
        `**${name}**\n\nBranch: \`${branch}\`  \nChanged files: **${files}**  \nAdditions: **+${insertions}**  \nDeletions: **-${deletions}**`,
      );
      return item;
    } catch (error) {
      const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
      item.description = `${branch} — stats unavailable`;
      item.iconPath = new vscode.ThemeIcon('warning');
      item.tooltip = error instanceof Error ? error.message : String(error);
      return item;
    }
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    this.repositoryListeners.splice(0).forEach((listener) => listener.dispose());
    this.apiListeners.forEach((listener) => listener.dispose());
    this.emitter.dispose();
  }
}

async function activate(context) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  const emptyProvider = { getTreeItem: (item) => item, getChildren: () => [] };

  if (!gitExtension) {
    context.subscriptions.push(vscode.window.registerTreeDataProvider(VIEW_ID, emptyProvider));
    return;
  }

  const git = await gitExtension.activate();
  if (!git.enabled) {
    context.subscriptions.push(vscode.window.registerTreeDataProvider(VIEW_ID, emptyProvider));
    return;
  }

  const provider = new RepositoryStatsProvider(git.getAPI(1));
  await vscode.commands.executeCommand('setContext', 'gitChangeStats.available', true);
  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider(VIEW_ID, provider),
    vscode.commands.registerCommand('gitChangeStats.refresh', () => provider.refresh()),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
