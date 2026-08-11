'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const vscode = require('vscode');
const {
  buildFileTree,
  changedFileCount,
  countTextLines,
  formatChangeStats,
  statusBadge,
} = require('./stats');
const git = require('./git-operations');
const ai = require('./ai-commit');
const { layoutGraph, markRollbackTargets } = require('./graph');

const VIEW_ID = 'gitChangeStats.repositories';
const GRAPH_PAGE_SIZE = 50;
const BUSY_MESSAGE_TYPES = new Set([
  'operation', 'commit', 'continueOperation', 'abortOperation', 'branch',
  'stage', 'unstage', 'stageAll', 'unstageAll', 'discard', 'discardAll',
  'graphCheckout', 'graphCreateBranch', 'graphCreateTag', 'graphCherryPick',
  'graphAmendMessage', 'graphRollback',
]);

function busyLabel(message) {
  if (message.type === 'commit') return 'Committing changes';
  if (message.type === 'continueOperation') return `Continuing ${message.operation}`;
  if (message.type === 'abortOperation') return `Aborting ${message.operation}`;
  if (message.type === 'operation') {
    return {
      pullMerge: 'Pulling changes',
      pullRebase: 'Pulling with rebase',
      pullFrom: 'Pulling from branch',
      push: 'Pushing changes',
      resetToOrigin: 'Resetting branch to origin',
      stash: 'Stashing changes',
      popStash: 'Popping latest stash',
      popStashSelected: 'Popping stash',
    }[message.operation] ?? 'Running Git operation';
  }
  return 'Updating repository';
}

class RepositoryViewProvider {
  constructor(api, context, log) {
    this.api = api;
    this.context = context;
    this.log = log;
    this.viewMode = context.globalState.get('gitChangeStats.viewMode', 'list');
    this.expanded = new Set();
    this.expansionTouched = new Set();
    this.noVerify = new Set(context.workspaceState.get('gitChangeStats.noVerifyRepositories', []));
    this.repositoryOrder = context.workspaceState.get('gitChangeStats.repositoryOrder', []);
    this.stats = new Map();
    this.dirtyStats = new Set();
    this.generating = new Set();
    this.busyRepositories = new Set();
    this.graph = undefined;
    this.repositoryListeners = [];
    this.apiListeners = [
      api.onDidOpenRepository(() => this.syncRepositories()),
      api.onDidCloseRepository(() => this.syncRepositories()),
      api.onDidChangeState(() => this.syncRepositories()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gitChangeStats.showNoVerifyButton')) this.refresh();
      }),
    ];
    this.syncRepositories();
  }

  resolveWebviewView(view) {
    this.view = view;
    this.log?.info('Repository view resolved.');
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.onDidReceiveMessage((message) => this.receiveMessage(message));
    view.onDidChangeVisibility(() => view.visible && this.refresh());
    view.webview.html = html();
  }

  async receiveMessage(message) {
    const tracked = message.repositoryId && BUSY_MESSAGE_TYPES.has(message.type);
    if (tracked && this.busyRepositories.has(message.repositoryId)) return;
    if (tracked) {
      this.busyRepositories.add(message.repositoryId);
      await this.view?.webview.postMessage({
        type: 'busy',
        repositoryId: message.repositoryId,
        busy: true,
        label: busyLabel(message),
      });
    }
    try {
      await this.handleMessage(message);
    } catch (error) {
      this.log?.error(`Failed to handle ${message.type}.`, error);
      await vscode.window.showErrorMessage(
        `Better Source Control failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (tracked) {
        this.busyRepositories.delete(message.repositoryId);
        await this.view?.webview.postMessage({
          type: 'busy',
          repositoryId: message.repositoryId,
          busy: false,
        });
      }
    }
  }

  syncRepositories() {
    this.repositoryListeners.splice(0).forEach((listener) => listener.dispose());
    const openIds = new Set(this.api.repositories.map((repository) => repository.rootUri.fsPath));
    if (this.graph && !openIds.has(this.graph.repositoryId)) {
      this.graph = undefined;
      this.postGraph();
    }
    for (const id of this.stats.keys()) if (!openIds.has(id)) this.stats.delete(id);
    for (const id of this.dirtyStats) if (!openIds.has(id)) this.dirtyStats.delete(id);
    this.repositoryListeners.push(
      ...this.api.repositories.map((repository) =>
        repository.state.onDidChange(() => {
          const id = repository.rootUri.fsPath;
          this.stats.delete(id);
          this.dirtyStats.add(id);
          if (this.graph?.repositoryId === id) {
            this.graph.outdated = true;
            this.postGraph();
          }
          this.scheduleRefresh();
        }),
      ),
    );
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 150);
  }

  async refresh() {
    clearTimeout(this.refreshTimer);
    if (!this.view) return;
    const refreshId = this.refreshId = (this.refreshId ?? 0) + 1;
    if (this.api.state !== 'initialized') {
      await this.view.webview.postMessage({ type: 'render', loading: true, repositories: [] });
      return;
    }
    const ranks = new Map(this.repositoryOrder.map((id, index) => [id, index]));
    const openRepositories = [...this.api.repositories].sort((a, b) => {
      const aRank = ranks.get(a.rootUri.fsPath) ?? Number.MAX_SAFE_INTEGER;
      const bRank = ranks.get(b.rootUri.fsPath) ?? Number.MAX_SAFE_INTEGER;
      return aRank - bRank || repositoryName(a).localeCompare(repositoryName(b));
    });
    if (openRepositories.length === 1) {
      const [repository] = openRepositories;
      const id = repository.rootUri.fsPath;
      if (changedFileCount(repository.state) && !this.expansionTouched.has(id)) this.expanded.add(id);
    }
    let repositories;
    try {
      repositories = await Promise.all(
        openRepositories.map((repository) => this.repositoryData(repository)),
      );
    } catch (error) {
      this.log?.error('Failed to load repositories.', error);
      if (refreshId === this.refreshId) {
        await this.view.webview.postMessage({
          type: 'render',
          loading: false,
          repositories: [],
          error: 'Unable to load repositories. See Better Source Control in the Output panel.',
        });
      }
      return;
    }
    if (refreshId !== this.refreshId) return;
    await this.view.webview.postMessage({
      type: 'render',
      loading: false,
      repositories,
      expanded: [...this.expanded],
      viewMode: this.viewMode,
    });
    this.scheduleStats(openRepositories);
  }

  scheduleStats(repositories) {
    for (const repository of repositories) {
      const id = repository.rootUri.fsPath;
      if (changedFileCount(repository.state) && !this.stats.has(id) && this.statsInFlight !== id) {
        this.dirtyStats.add(id);
      }
    }
    if (this.statsWorker || !this.dirtyStats.size) return;
    this.statsWorker = this.updateStats().finally(() => {
      this.statsWorker = undefined;
      if (this.dirtyStats.size) this.scheduleStats([]);
    });
  }

  async updateStats() {
    while (this.dirtyStats.size) {
      const id = this.dirtyStats.values().next().value;
      this.dirtyStats.delete(id);
      const repository = this.repository(id);
      if (!repository || !changedFileCount(repository.state)) continue;
      this.statsInFlight = id;
      const stats = await this.computeStats(repository);
      this.statsInFlight = undefined;
      if (this.dirtyStats.has(id)) continue;
      this.stats.set(id, stats);
      await this.view?.webview.postMessage({
        type: 'stats',
        repositoryId: id,
        statsLabel: formatChangeStats(changedFileCount(repository.state), stats.insertions, stats.deletions),
        ...stats,
      });
    }
  }

  async setViewMode(mode) {
    this.viewMode = mode;
    await this.context.globalState.update('gitChangeStats.viewMode', mode);
    await vscode.commands.executeCommand('setContext', 'gitChangeStats.viewMode', mode);
    await this.refresh();
  }

  async expandAll() {
    for (const repository of this.api.repositories) {
      const id = repository.rootUri.fsPath;
      this.expansionTouched.add(id);
      if (changedFileCount(repository.state)) this.expanded.add(id);
    }
    await this.refresh();
  }

  async collapseAll() {
    for (const repository of this.api.repositories) this.expansionTouched.add(repository.rootUri.fsPath);
    this.expanded.clear();
    await this.refresh();
  }

  async reorder(repositoryId, targetId, before) {
    const ids = [...this.api.repositories].map((repository) => repository.rootUri.fsPath);
    if (!ids.includes(repositoryId) || !ids.includes(targetId) || repositoryId === targetId) return;
    const ordered = [...ids].sort((a, b) => {
      const aIndex = this.repositoryOrder.indexOf(a);
      const bIndex = this.repositoryOrder.indexOf(b);
      return (aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex)
        - (bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex)
        || repositoryName(this.repository(a)).localeCompare(repositoryName(this.repository(b)));
    });
    ordered.splice(ordered.indexOf(repositoryId), 1);
    const targetIndex = ordered.indexOf(targetId) + (before ? 0 : 1);
    ordered.splice(targetIndex, 0, repositoryId);
    this.repositoryOrder = ordered;
    await this.context.workspaceState.update('gitChangeStats.repositoryOrder', ordered);
    await this.refresh();
  }

  async toggleNoVerify(repositoryId) {
    this.noVerify.has(repositoryId) ? this.noVerify.delete(repositoryId) : this.noVerify.add(repositoryId);
    await this.context.workspaceState.update('gitChangeStats.noVerifyRepositories', [...this.noVerify]);
    await this.refresh();
  }

  repository(id) {
    return this.api.repositories.find((repository) => repository.rootUri.fsPath === id);
  }

  async postGraph() {
    await this.view?.webview.postMessage({ type: 'graph', graph: this.graph });
  }

  async showGraph(repository) {
    if (this.graph?.repositoryId === repository.rootUri.fsPath) {
      this.graph.collapsed = false;
      await this.postGraph();
      return;
    }
    this.graph = {
      repositoryId: repository.rootUri.fsPath,
      repositoryName: repositoryName(repository),
      scope: { kind: 'auto', label: 'Auto' },
      limit: GRAPH_PAGE_SIZE,
      loading: true,
      collapsed: false,
      commits: [],
      refs: [],
    };
    await this.postGraph();
    await this.loadGraph();
  }

  async graphRefNames(repository, refs) {
    if (this.graph.scope.kind === 'all') return refs.map(fullRefName).filter(Boolean);
    if (this.graph.scope.kind === 'ref') return [this.graph.scope.ref];
    const head = repository.state.HEAD;
    if (!head?.name) return head?.commit ? [head.commit] : undefined;
    const names = [`refs/heads/${head.name}`];
    if (head.upstream) names.push(`refs/remotes/${head.upstream.remote}/${head.upstream.name}`);
    const base = await repository.getBranchBase(head.name).catch(() => undefined);
    const baseName = base && fullRefName(base);
    if (baseName) names.push(baseName);
    return [...new Set(names)];
  }

  async loadGraph() {
    const graph = this.graph;
    const repository = graph && this.repository(graph.repositoryId);
    if (!graph || !repository) {
      this.graph = undefined;
      await this.postGraph();
      return;
    }
    const requestId = this.graphRequestId = (this.graphRequestId ?? 0) + 1;
    graph.loading = true;
    graph.error = undefined;
    await this.postGraph();
    try {
      const refs = await repository.getRefs({ sort: 'committerdate' });
      if (!repository.state.HEAD?.commit) {
        graph.commits = [];
        graph.refs = [];
        graph.hasMore = false;
        graph.loading = false;
        graph.outdated = false;
        await this.postGraph();
        return;
      }
      const refNames = await this.graphRefNames(repository, refs);
      const result = await repository.log({
        maxEntries: graph.limit + 1,
        refNames,
        shortStats: true,
      });
      if (requestId !== this.graphRequestId || this.graph !== graph) return;
      const commits = result.slice(0, graph.limit).map((commit) => ({
        hash: commit.hash,
        subject: commit.message.split(/\r?\n/, 1)[0],
        message: commit.message,
        parents: commit.parents,
        author: commit.authorName || commit.authorEmail || 'Unknown author',
        date: commit.authorDate?.toISOString?.() ?? commit.commitDate?.toISOString?.(),
        files: commit.shortStat?.files ?? 0,
        insertions: commit.shortStat?.insertions ?? 0,
        deletions: commit.shortStat?.deletions ?? 0,
      }));
      graph.head = repository.state.HEAD?.commit;
      const laidOut = layoutGraph(commits);
      graph.commits = repository.state.HEAD?.name
        ? markRollbackTargets(laidOut, graph.head)
        : laidOut;
      graph.refs = refs
        .filter((ref) => ref.name && ref.commit)
        .map((ref) => ({
          name: ref.name,
          commit: ref.commit,
          type: ref.type === 0 ? 'branch' : ref.type === 1 ? 'remote' : 'tag',
          current: ref.type === 0 && ref.name === repository.state.HEAD?.name,
        }));
      graph.hasMore = result.length > graph.limit;
      graph.loading = false;
      graph.outdated = false;
      await this.postGraph();
    } catch (error) {
      if (requestId !== this.graphRequestId || this.graph !== graph) return;
      graph.loading = false;
      graph.error = error instanceof Error ? error.message : String(error);
      await this.postGraph();
    }
  }

  graphCommit(hash) {
    return this.graph?.commits.find((commit) => commit.hash === hash);
  }

  async selectGraphScope(repository) {
    const refs = await repository.getRefs({ sort: 'committerdate' });
    const choices = [
      { label: 'Auto', description: 'Current branch, upstream, and branch base', value: { kind: 'auto', label: 'Auto' } },
      { label: 'All References', description: 'All branches and tags', value: { kind: 'all', label: 'All' } },
      ...refs.filter((ref) => ref.name).map((ref) => ({
        label: ref.name,
        description: ref.type === 0 ? 'Local branch' : ref.type === 1 ? 'Remote branch' : 'Tag',
        value: { kind: 'ref', label: ref.name, ref: fullRefName(ref) },
      })),
    ];
    const picked = await vscode.window.showQuickPick(choices, {
      title: `Filter ${repositoryName(repository)} Commit Graph`,
      placeHolder: this.graph?.scope.label,
    });
    if (!picked || this.graph?.repositoryId !== repository.rootUri.fsPath) return;
    this.graph.scope = picked.value;
    this.graph.limit = GRAPH_PAGE_SIZE;
    this.graph.selectedHash = undefined;
    this.graph.details = undefined;
    await this.loadGraph();
  }

  async selectGraphRepository() {
    const picked = await vscode.window.showQuickPick(
      this.api.repositories.map((repository) => ({
        label: repositoryName(repository),
        description: repository.state.HEAD?.name ?? 'detached HEAD',
        repository,
      })),
      {
        title: 'Choose Repository for Commit Graph',
        placeHolder: this.graph?.repositoryName,
      },
    );
    if (picked) await this.showGraph(picked.repository);
  }

  async selectGraphCommit(repository, hash) {
    const commit = this.graphCommit(hash);
    if (!commit) return;
    if (this.graph.selectedHash === hash) {
      this.graph.selectedHash = undefined;
      this.graph.details = undefined;
      await this.postGraph();
      return;
    }
    this.graph.selectedHash = hash;
    this.graph.details = { loading: true, hash };
    await this.postGraph();
    try {
      const parent = commit.parents[0];
      const changes = parent
        ? await repository.diffBetweenWithStats(parent, hash)
        : await repository.diffBetweenWithStats2(
          `${await git.emptyTreeHash(repository, { gitPath: this.api.git.path })}..${hash}`,
        );
      if (this.graph?.selectedHash !== hash) return;
      this.graph.details = {
        hash,
        files: changes.map((change) => {
          const relativePath = path.relative(repository.rootUri.fsPath, change.uri.fsPath);
          const badge = statusBadge(change.status);
          return {
            uri: change.uri.toString(),
            originalUri: change.originalUri.toString(),
            renameUri: change.renameUri?.toString(),
            name: path.basename(relativePath),
            directory: path.dirname(relativePath),
            badge,
            canOpen: badge !== 'D',
            insertions: change.insertions,
            deletions: change.deletions,
          };
        }),
      };
    } catch (error) {
      this.graph.details = {
        hash,
        error: error instanceof Error ? error.message : String(error),
        files: [],
      };
    }
    await this.postGraph();
  }

  async compareGraphCommit(repository, commit, mode) {
    let ref;
    if (mode === 'remote') {
      const upstream = repository.state.HEAD?.upstream;
      ref = upstream && `refs/remotes/${upstream.remote}/${upstream.name}`;
    } else if (mode === 'base') {
      const base = repository.state.HEAD?.name
        ? await repository.getBranchBase(repository.state.HEAD.name)
        : undefined;
      ref = base && fullRefName(base);
    } else {
      const refs = await repository.getRefs({ sort: 'committerdate' });
      const picked = await vscode.window.showQuickPick(
        refs.filter((item) => item.name && item.commit !== commit.hash).map((item) => ({
          label: item.name,
          description: item.type === 2 ? 'Tag' : item.type === 1 ? 'Remote branch' : 'Local branch',
          ref: fullRefName(item),
        })),
        { title: `Compare ${commit.hash.slice(0, 8)} With…` },
      );
      ref = picked?.ref;
    }
    if (!ref) {
      await vscode.window.showInformationMessage('No comparison reference is available.');
      return;
    }
    const changes = await repository.diffBetweenWithStats(ref, commit.hash);
    const picked = await vscode.window.showQuickPick(changes.map((change) => ({
      label: path.relative(repository.rootUri.fsPath, change.uri.fsPath),
      description: `+${change.insertions} −${change.deletions}`,
      change,
    })), { title: `Changes Between ${ref.replace(/^refs\/(heads|remotes|tags)\//, '')} and ${commit.hash.slice(0, 8)}` });
    if (!picked) return;
    await vscode.commands.executeCommand(
      'vscode.diff',
      this.api.toGitUri(picked.change.uri, ref),
      this.api.toGitUri(picked.change.uri, commit.hash),
      `${picked.label} (${ref.replace(/^refs\/(heads|remotes|tags)\//, '')} ↔ ${commit.hash.slice(0, 8)})`,
    );
  }

  async rollbackGraphCommit(repository, commit) {
    const head = repository.state.HEAD;
    if (repository.state.rebaseCommit || repository.state.mergeChanges.length) {
      await vscode.window.showInformationMessage('Finish or abort the current merge or rebase before rolling back.');
      return;
    }
    let mergeBase;
    try {
      mergeBase = head?.name && head.commit
        ? await repository.getMergeBase(head.commit, commit.hash)
        : undefined;
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Unable to verify the rollback target: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!head?.name || !head.commit || head.commit === commit.hash || mergeBase !== commit.hash) {
      await vscode.window.showInformationMessage('This commit is not an ancestor of the current local branch.');
      return;
    }
    const picked = await vscode.window.showQuickPick([
      { label: 'Soft', description: 'Keep later changes staged.', mode: 'soft' },
      { label: 'Mixed', description: 'Keep later changes unstaged.', mode: 'mixed' },
      { label: 'Hard', description: 'Discard all tracked working-tree and staged changes.', mode: 'hard' },
    ], {
      title: `Rollback ${head.name} to ${commit.hash.slice(0, 8)}`,
      placeHolder: 'Choose how to preserve changes after this commit',
    });
    if (!picked) return;
    const action = picked.mode === 'hard' ? 'Rollback and Discard' : 'Rollback';
    const confirmed = await vscode.window.showWarningMessage(
      `Rollback ${head.name} to ${commit.hash.slice(0, 8)}?`,
      {
        modal: true,
        detail: picked.mode === 'hard'
          ? 'Hard reset permanently discards tracked working-tree and staged changes and may remove obstructing untracked files. Later commits leave this branch.'
          : `${picked.label} reset keeps later changes ${picked.mode === 'soft' ? 'staged' : 'unstaged'}. Later commits leave this branch.`,
      },
      action,
    );
    if (confirmed === action
      && await git.rollback(repository, commit.hash, picked.mode, { gitPath: this.api.git.path })) {
      await this.loadGraph();
    }
  }

  async amendGraphCommitMessage(repository, commit) {
    const head = repository.state.HEAD;
    if (!head?.commit || head.commit !== commit.hash) {
      await vscode.window.showInformationMessage('Only the current commit message can be amended.');
      return;
    }
    if (repository.state.rebaseCommit || repository.state.mergeChanges.length) {
      await vscode.window.showInformationMessage('Finish or abort the current merge or rebase before amending.');
      return;
    }
    const message = await vscode.window.showInputBox({
      title: `Amend Commit Message (${commit.hash.slice(0, 8)})`,
      prompt: 'Rewrites the current commit without including staged changes.',
      value: commit.message,
      valueSelection: [0, commit.message.length],
      validateInput: (value) => value.trim() ? undefined : 'Enter a commit message.',
    });
    if (!message?.trim()) return;
    if (head.upstream && !head.ahead) {
      const action = 'Amend Published Commit';
      const confirmed = await vscode.window.showWarningMessage(
        `Amend ${head.name ?? 'HEAD'} after it may have been published?`,
        { modal: true, detail: 'This rewrites commit history and may require a force push.' },
        action,
      );
      if (confirmed !== action) return;
    }
    if (repository.state.HEAD?.commit !== commit.hash) {
      await vscode.window.showInformationMessage('HEAD changed before the commit could be amended.');
      return;
    }
    const noVerify = vscode.workspace.getConfiguration('gitChangeStats')
      .get('showNoVerifyButton', false) && this.noVerify.has(repository.rootUri.fsPath);
    if (await git.amendMessage(repository, message, { noVerify, gitPath: this.api.git.path })) {
      this.graph.selectedHash = undefined;
      this.graph.details = undefined;
      await this.loadGraph();
    }
  }

  async handleMessage(message) {
    if (message.type === 'ready') {
      await this.refresh();
      await this.postGraph();
      return;
    }
    const repository = this.repository(message.repositoryId);
    if (message.type === 'toggle') {
      this.expansionTouched.add(message.repositoryId);
      this.expanded.has(message.repositoryId)
        ? this.expanded.delete(message.repositoryId)
        : this.expanded.add(message.repositoryId);
      await this.refresh();
      return;
    }
    if (message.type === 'refresh') {
      await this.refresh();
      return;
    }
    if (message.type === 'reorder') {
      await this.reorder(message.repositoryId, message.targetId, message.before);
      return;
    }
    if (message.type === 'closeGraph') {
      if (this.graph) this.graph.collapsed = true;
      await this.postGraph();
      return;
    }
    if (message.type === 'expandGraph') {
      if (this.graph) {
        this.graph.collapsed = false;
        await this.postGraph();
      } else if (this.api.repositories.length) {
        await this.showGraph(this.api.repositories[0]);
      }
      return;
    }
    if (!repository) return;

    if (message.type === 'toggleNoVerify') {
      await this.toggleNoVerify(message.repositoryId);
      return;
    }
    if (message.type === 'showGraph') {
      await this.showGraph(repository);
      return;
    }
    if (this.graph?.repositoryId === message.repositoryId) {
      const commit = this.graphCommit(message.hash);
      if (message.type === 'graphRepository') {
        await this.selectGraphRepository();
        return;
      }
      if (message.type === 'graphScope') {
        await this.selectGraphScope(repository);
        return;
      }
      if (message.type === 'graphRefresh') {
        await this.loadGraph();
        return;
      }
      if (message.type === 'graphLoadMore') {
        this.graph.limit += GRAPH_PAGE_SIZE;
        await this.loadGraph();
        return;
      }
      if (message.type === 'graphSelect' && commit) {
        await this.selectGraphCommit(repository, commit.hash);
        return;
      }
      if (message.type === 'graphOpen' && commit) {
        await vscode.commands.executeCommand('git.viewCommit', repository.rootUri, commit.hash);
        return;
      }
      if (message.type === 'graphCopyHash' && commit) {
        await vscode.env.clipboard.writeText(commit.hash);
        return;
      }
      if (message.type === 'graphCopyMessage' && commit) {
        await vscode.env.clipboard.writeText(commit.message);
        return;
      }
      if (message.type === 'graphCheckout' && commit) {
        const action = 'Checkout Detached';
        const picked = await vscode.window.showWarningMessage(
          `Check out ${commit.hash.slice(0, 8)} in detached HEAD mode?`,
          { modal: true },
          action,
        );
        if (picked === action && await git.checkoutDetached(repository, commit.hash)) await this.loadGraph();
        return;
      }
      if (message.type === 'graphCreateBranch' && commit) {
        const name = await vscode.window.showInputBox({
          title: `Create Branch from ${commit.hash.slice(0, 8)}`,
          prompt: 'Branch name',
          validateInput: (value) => value.trim() ? undefined : 'Enter a branch name.',
        });
        if (name && await git.createBranchFromCommit(repository, name.trim(), commit.hash)) await this.loadGraph();
        return;
      }
      if (message.type === 'graphCreateTag' && commit) {
        const name = await vscode.window.showInputBox({
          title: `Create Tag at ${commit.hash.slice(0, 8)}`,
          prompt: 'Tag name',
          validateInput: (value) => value.trim() ? undefined : 'Enter a tag name.',
        });
        if (name && await git.createTagFromCommit(repository, name.trim(), commit.hash)) await this.loadGraph();
        return;
      }
      if (message.type === 'graphCherryPick' && commit) {
        const action = 'Cherry Pick';
        const picked = await vscode.window.showWarningMessage(
          `Cherry-pick ${commit.hash.slice(0, 8)} onto ${repository.state.HEAD?.name ?? 'HEAD'}?`,
          { modal: true, detail: commit.subject },
          action,
        );
        if (picked === action && await git.cherryPick(repository, commit.hash, { gitPath: this.api.git.path })) {
          await this.loadGraph();
        }
        return;
      }
      if (message.type === 'graphAmendMessage' && commit?.hash === this.graph.head) {
        await this.amendGraphCommitMessage(repository, commit);
        return;
      }
      if (message.type === 'graphRollback' && commit?.canRollback) {
        await this.rollbackGraphCommit(repository, commit);
        return;
      }
      if (message.type === 'graphCompare' && commit
        && ['remote', 'base', 'ref'].includes(message.mode)) {
        try {
          await this.compareGraphCommit(repository, commit, message.mode);
        } catch (error) {
          await vscode.window.showErrorMessage(
            `Unable to compare commits: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      if ((message.type === 'graphFileDiff' || message.type === 'graphFileOpen') && commit) {
        const file = this.graph.details?.hash === commit.hash
          && this.graph.details.files?.find((item) => item.uri === message.uri);
        if (!file) return;
        const uri = vscode.Uri.parse(file.renameUri ?? file.uri);
        try {
          if (message.type === 'graphFileOpen') {
            if (file.canOpen) {
              await vscode.commands.executeCommand(
                'vscode.open',
                this.api.toGitUri(uri, commit.hash),
                { preview: false },
              );
            }
            return;
          }
          const original = vscode.Uri.parse(file.originalUri);
          const parent = commit.parents[0];
          const left = file.badge === 'A' || !parent
            ? emptyUri(original)
            : this.api.toGitUri(original, parent);
          const right = file.badge === 'D'
            ? emptyUri(uri)
            : this.api.toGitUri(uri, commit.hash);
          await vscode.commands.executeCommand(
            'vscode.diff',
            left,
            right,
            `${file.name} (${commit.hash.slice(0, 8)})`,
          );
        } catch (error) {
          await vscode.window.showErrorMessage(
            `Unable to open ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
    }
    const operationOptions = {
      noVerify: vscode.workspace.getConfiguration('gitChangeStats')
        .get('showNoVerifyButton', false) && this.noVerify.has(message.repositoryId),
      gitPath: this.api.git.path,
    };
    if (message.type === 'continueOperation' && ['merge', 'rebase'].includes(message.operation)) {
      await git.continueOperation(repository, message.operation, message.message, operationOptions);
    } else if (message.type === 'abortOperation' && ['merge', 'rebase'].includes(message.operation)) {
      await git.abortOperation(repository, message.operation, operationOptions);
    } else if (message.type === 'operation' && ['pullMerge', 'pullRebase', 'pullFrom', 'push', 'resetToOrigin', 'stash', 'popStashSelected', 'popStash'].includes(message.operation)) {
      await git[message.operation](repository, operationOptions);
    } else if (message.type === 'commit') {
      if (await git.commit(repository, message.message, operationOptions)) {
        await this.view?.webview.postMessage({
          type: 'committed',
          repositoryId: message.repositoryId,
        });
      }
    } else if (message.type === 'generateMessage') {
      if (this.generating.has(message.repositoryId)) return;
      this.generating.add(message.repositoryId);
      await this.view?.webview.postMessage({
        type: 'aiState',
        repositoryId: message.repositoryId,
        generating: true,
      });
      try {
        const generatedMessage = await ai.generateCommitMessage(repository);
        if (generatedMessage) {
          await this.view?.webview.postMessage({
            type: 'generatedMessage',
            repositoryId: message.repositoryId,
            message: generatedMessage,
          });
        }
      } catch (error) {
        await vscode.window.showErrorMessage(
          `Commit message generation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.generating.delete(message.repositoryId);
        await this.view?.webview.postMessage({
          type: 'aiState',
          repositoryId: message.repositoryId,
          generating: false,
        });
      }
      return;
    } else if (message.type === 'branch') {
      await git.pickBranch(repository);
    } else if (message.type === 'stage' || message.type === 'unstage') {
      const change = findChange(repository, message.kind, message.uri);
      if (change) await git[message.type](repository, change.uri.fsPath);
    } else if (message.type === 'stageAll' || message.type === 'unstageAll') {
      const kind = message.type === 'stageAll' ? 'unstaged' : 'staged';
      const paths = uniqueChanges(changesFor(repository, kind)).map((change) => change.uri.fsPath);
      if (paths.length) {
        await (message.type === 'stageAll'
          ? git.stageAll(repository, paths)
          : git.unstageAll(repository));
      }
    } else if (message.type === 'discard') {
      const change = findChange(repository, 'unstaged', message.uri);
      if (change) await git.discard(repository, change.uri.fsPath);
    } else if (message.type === 'discardAll') {
      const paths = uniqueChanges(changesFor(repository, message.kind))
        .map((change) => change.uri.fsPath);
      await git.discardAll(repository, message.kind, paths);
    } else if (message.type === 'open') {
      const change = findChange(repository, message.kind, message.uri);
      if (change) await openFile(change);
    } else if (message.type === 'openAll') {
      const command = message.kind === 'staged' ? 'git.viewStagedChanges' : 'git.viewChanges';
      await vscode.commands.executeCommand(command, repository.rootUri);
    } else if (message.type === 'diff') {
      const change = findChange(repository, message.kind, message.uri);
      if (change) await openDiff(this.api, repository, message.kind, change);
    }
    await this.refresh();
  }

  async repositoryData(repository) {
    const stats = this.stats.get(repository.rootUri.fsPath);
    const isExpanded = this.expanded.has(repository.rootUri.fsPath);
    const files = changedFileCount(repository.state);
    const operation = isExpanded && files
      ? await git.operationState(repository, { gitPath: this.api.git.path })
      : undefined;
    const stagedFiles = isExpanded
      ? await this.fileData(repository, 'staged', repository.state.indexChanges)
      : [];
    const workingFiles = isExpanded
      ? await this.fileData(repository, 'unstaged', [
          ...repository.state.mergeChanges,
          ...repository.state.workingTreeChanges,
          ...repository.state.untrackedChanges,
        ])
      : [];

    const showNoVerifyButton = vscode.workspace.getConfiguration('gitChangeStats')
      .get('showNoVerifyButton', false);
    return {
      id: repository.rootUri.fsPath,
      name: repositoryName(repository),
      branch: repository.state.HEAD?.name ?? 'detached HEAD',
      ahead: repository.state.HEAD?.ahead ?? 0,
      behind: repository.state.HEAD?.behind ?? 0,
      files,
      statsLabel: stats ? formatChangeStats(files, stats.insertions, stats.deletions) : files ? String(files) : '',
      statsReady: Boolean(stats),
      insertions: stats?.insertions ?? 0,
      deletions: stats?.deletions ?? 0,
      stagedCount: uniqueChanges(repository.state.indexChanges).length,
      showNoVerifyButton,
      noVerify: showNoVerifyButton && this.noVerify.has(repository.rootUri.fsPath),
      operation,
      operationBlocked: operation === 'merge' && repository.state.mergeChanges.length > 0,
      operationMessage: operation === 'rebase'
        ? repository.state.rebaseCommit?.message ?? ''
        : operation === 'merge' ? repository.inputBox.value : '',
      staged: this.viewMode === 'tree' ? buildFileTree(stagedFiles) : stagedFiles,
      unstaged: this.viewMode === 'tree' ? buildFileTree(workingFiles) : workingFiles,
    };
  }

  async computeStats(repository) {
    const [working, staged] = await Promise.all([
      repository.diffWithHEADShortStats().catch(emptyStats),
      repository.diffIndexWithHEADShortStats().catch(emptyStats),
    ]);
    const untrackedInsertions = (
      await Promise.all(
        uniqueChanges(repository.state.untrackedChanges).map((change) =>
          vscode.workspace.fs.readFile(change.uri).then(countTextLines, () => 0),
        ),
      )
    ).reduce((total, lines) => total + lines, 0);
    return {
      insertions: working.insertions + staged.insertions + untrackedInsertions,
      deletions: working.deletions + staged.deletions,
    };
  }

  async fileData(repository, kind, changes) {
    return Promise.all(
      uniqueChanges(changes)
        .sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath))
        .map(async (change) => {
          const relativePath = path.relative(repository.rootUri.fsPath, change.uri.fsPath);
          let stats = emptyStats();
          if (kind === 'unstaged' && repository.state.untrackedChanges.some(sameUri(change))) {
            stats = await vscode.workspace.fs.readFile(change.uri)
              .then((bytes) => ({ insertions: countTextLines(bytes), deletions: 0 }))
              .catch(emptyStats);
          } else {
            const method = kind === 'staged' ? 'diffIndexWithHEADShortStats' : 'diffWithHEADShortStats';
            stats = await repository[method](relativePath).catch(emptyStats);
          }
          const badge = statusBadge(change.status);
          return {
            type: 'file',
            uri: change.uri.toString(),
            relativePath,
            name: path.basename(relativePath),
            directory: path.dirname(relativePath),
            badge,
            canOpen: badge !== 'D',
            canDiscard: kind === 'unstaged' && !repository.state.mergeChanges.some(sameUri(change)),
            insertions: stats.insertions,
            deletions: stats.deletions,
          };
        }),
    );
  }

  dispose() {
    clearTimeout(this.refreshTimer);
    this.repositoryListeners.splice(0).forEach((listener) => listener.dispose());
    this.apiListeners.forEach((listener) => listener.dispose());
  }
}

function repositoryName(repository) {
  return path.basename(repository.rootUri.fsPath);
}

function fullRefName(ref) {
  if (!ref?.name) return undefined;
  return ref.type === 0
    ? `refs/heads/${ref.name}`
    : ref.type === 1
      ? `refs/remotes/${ref.name.includes('/') || !ref.remote ? ref.name : `${ref.remote}/${ref.name}`}`
      : `refs/tags/${ref.name}`;
}

function emptyStats() {
  return { insertions: 0, deletions: 0 };
}

function sameUri(target) {
  const value = target.uri.toString();
  return (change) => change.uri.toString() === value;
}

function uniqueChanges(changes = []) {
  return [...new Map(changes.map((change) => [change.uri.toString(), change])).values()];
}

function findChange(repository, kind, uri) {
  return changesFor(repository, kind).find((change) => change.uri.toString() === uri);
}

function changesFor(repository, kind) {
  if (kind === 'staged') return repository.state.indexChanges;
  if (kind === 'unstaged') {
    return [
      ...repository.state.mergeChanges,
      ...repository.state.workingTreeChanges,
      ...repository.state.untrackedChanges,
    ];
  }
  return [];
}

function emptyUri(uri) {
  return vscode.Uri.from({ scheme: 'git-change-stats-empty', path: uri.path });
}

function openDiff(api, repository, kind, change) {
  const badge = statusBadge(change.status);
  const originalUri = change.originalUri ?? change.uri;
  const renamedUri = change.renameUri ?? change.uri;
  const relativePath = path.relative(repository.rootUri.fsPath, change.uri.fsPath);
  let left;
  let right;

  if (kind === 'staged') {
    left = badge === 'A' ? emptyUri(originalUri) : api.toGitUri(originalUri, 'HEAD');
    right = badge === 'D' ? emptyUri(renamedUri) : api.toGitUri(renamedUri, '');
  } else {
    left = badge === 'A' ? emptyUri(originalUri) : api.toGitUri(originalUri, '~');
    right = badge === 'D' ? emptyUri(renamedUri) : renamedUri;
  }

  const label = kind === 'staged' ? 'Staged Changes' : 'Working Tree Changes';
  return vscode.commands.executeCommand('vscode.diff', left, right, `${relativePath} (${label})`);
}

function openFile(change) {
  if (statusBadge(change.status) === 'D') return;
  return vscode.commands.executeCommand('vscode.open', change.uri, { preview: false });
}

function html() {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    body { height: 100vh; display: flex; flex-direction: column; margin: 0; padding: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 13px var(--vscode-font-family); }
    button, input, textarea { font: inherit; }
    button { color: inherit; }
    #repositories { min-height: 0; flex: 1 1 auto; overflow: auto; }
    .empty { padding: 24px 16px; color: var(--vscode-descriptionForeground); text-align: center; }
    .repo { border-block: 1px solid transparent; }
    .repo.expanded { border-block-color: var(--vscode-sideBarSectionHeader-border, var(--vscode-panelSection-border)); }
    .repo-row { height: 22px; display: flex; align-items: center; gap: 4px; padding: 0; cursor: pointer; }
    .expanded > .repo-row { background: var(--vscode-list-inactiveSelectionBackground); }
    .repo-row:hover { background: var(--vscode-list-hoverBackground); }
    .repo.drop-before { border-top-color: var(--vscode-focusBorder); }
    .repo.drop-after { border-bottom-color: var(--vscode-focusBorder); }
    .repo-row:focus-visible { outline: 1px solid var(--vscode-list-focusOutline); outline-offset: -1px; }
    .repo.clean .repo-row { cursor: default; }
    .icon { width: 13px; height: 13px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .chevron { width: 14px; height: 14px; flex: none; color: var(--vscode-icon-foreground); transition: transform 100ms ease; }
    .clean-indicator { width: 12px; height: 12px; margin: 1px; color: var(--vscode-gitDecoration-addedResourceForeground); transform: translateY(1px); }
    .expanded .chevron { transform: rotate(90deg); }
    .repo-name { min-width: 40px; flex: 0 1 auto; margin-right: 4px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .repo-sync { display: flex; align-items: center; gap: 3px; flex: none; color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
    .sync-count { display: flex; align-items: center; gap: 1px; }
    .sync-count .icon { width: 11px; height: 11px; }
    .repo-meta { min-width: 0; display: flex; align-items: center; gap: 4px; margin-left: auto; flex: 0 1 auto; }
    .repo-stats { min-width: 0; display: flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); overflow: hidden; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .repo-file-count { min-width: 18px; height: 18px; display: grid; place-items: center; padding: 0 5px; border-radius: 9px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; }
    .branch { max-width: 110px; height: 18px; padding: 0 5px; border: 0; border-radius: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); cursor: pointer; color: var(--vscode-descriptionForeground); }
    .branch:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .actions { display: flex; margin-left: auto; flex: none; }
    .repo-actions { position: relative; margin-left: 0; }
    .repo-actions .icon-button { width: 18px; }
    .repo-actions .icon { width: 12px; height: 12px; }
    .no-verify.active { color: var(--vscode-gitDecoration-modifiedResourceForeground); background: var(--vscode-toolbar-hoverBackground); }
    .icon-button { position: relative; width: 20px; height: 20px; display: grid; place-items: center; padding: 2px; border: 0; border-radius: var(--vscode-cornerRadius-medium, 4px); background: transparent; cursor: pointer; }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .custom-tooltip { position: fixed; z-index: 100; max-width: min(420px, calc(100vw - 8px)); padding: 3px 6px; border: 1px solid var(--vscode-editorHoverWidget-border, transparent); border-radius: 3px; color: var(--vscode-editorHoverWidget-foreground); background: var(--vscode-editorHoverWidget-background); box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent); font-size: 12px; font-weight: 400; line-height: 16px; opacity: 0; overflow-wrap: anywhere; pointer-events: none; white-space: pre-wrap; transition: opacity 50ms; }
    .custom-tooltip.visible { opacity: 1; }
    .repo-menu { position: fixed; inset: auto; min-width: 148px; margin: 0; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent)); border-radius: var(--vscode-cornerRadius-medium, 4px); color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent); }
    .repo-menu::backdrop { background: transparent; }
    .menu-item { width: 100%; height: 24px; display: flex; align-items: center; padding: 0 6px; border: 0; border-radius: 3px; color: inherit; background: transparent; cursor: pointer; text-align: left; }
    .menu-item:hover, .menu-item:focus-visible { outline: none; color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); }
    .menu-separator { height: 1px; margin: 4px 6px; background: var(--vscode-menu-separatorBackground, var(--vscode-menu-border, var(--vscode-widget-border, transparent))); }
    .details { margin-left: 0; padding: 2px 4px 4px 5px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); }
    .commit { display: grid; grid-template-columns: minmax(0, 1fr) 28px 28px; gap: 4px; margin: 2px 0 6px; }
    textarea { width: 100%; min-height: 28px; max-height: 78px; resize: vertical; padding: 4px 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; outline: none; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
    textarea:focus { border-color: var(--vscode-focusBorder); }
    .commit-button { display: grid; place-items: center; padding: 2px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .commit-button:hover { background: var(--vscode-button-hoverBackground); }
    .commit-button:disabled { cursor: default; opacity: .45; }
    .ai-button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .ai-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .spinning { animation: spin 900ms linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .group + .group { margin-top: 4px; }
    .group-title { height: 22px; display: flex; align-items: center; gap: 5px; color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); font-weight: 700; cursor: pointer; }
    .group-title:focus-visible { outline: 1px solid var(--vscode-list-focusOutline); outline-offset: -1px; }
    .group-chevron { transition: transform 100ms ease; }
    .group-chevron.open { transform: rotate(90deg); }
    .count { min-width: 18px; height: 18px; display: grid; place-items: center; padding: 0 5px; border-radius: 9px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .file, .folder { height: 22px; display: flex; align-items: center; gap: 4px; padding: 0; }
    .file { cursor: pointer; }
    .file:hover, .folder:hover { background: var(--vscode-list-hoverBackground); }
    .badge { width: 18px; flex: none; text-align: center; font-size: 11px; font-weight: 700; }
    .badge-A, .add { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .badge-D, .del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .badge-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .badge-R { color: var(--vscode-gitDecoration-renamedResourceForeground); }
    .badge-C { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-dir { min-width: 0; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stats { display: flex; gap: 5px; margin-left: auto; flex: none; font-size: 11px; font-variant-numeric: tabular-nums; }
    .file-actions { display: none; margin-left: auto; }
    .file:hover .file-actions, .file:focus-within .file-actions { display: flex; }
    .file:hover .stats, .file:focus-within .stats { margin-left: 0; }
    .tree { margin-left: 14px; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); padding-left: 5px; }
    .folder { color: var(--vscode-descriptionForeground); }
    .graph-panel { min-height: 160px; flex: 0 0 clamp(220px, 45vh, 520px); display: flex; flex-direction: column; border-top: 1px solid var(--vscode-panelSection-border, var(--vscode-sideBarSectionHeader-border)); background: var(--vscode-sideBar-background); }
    .graph-panel.collapsed { min-height: 28px; flex-basis: 28px !important; }
    .graph-resizer { position: relative; height: 7px; flex: none; cursor: row-resize; touch-action: none; }
    .graph-resizer::after { position: absolute; inset: 3px 0 auto; height: 1px; background: var(--vscode-panelSection-border, var(--vscode-sideBarSectionHeader-border)); content: ''; }
    .graph-resizer:hover::after, .graph-resizer:focus-visible::after { height: 2px; background: var(--vscode-focusBorder); }
    .graph-resizer:focus-visible { outline: none; }
    .graph-header { min-height: 28px; display: flex; align-items: center; gap: 4px; padding: 0 4px 0 8px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent); }
    .graph-header.collapsed { cursor: pointer; }
    .graph-header.collapsed:focus-visible { outline: 1px solid var(--vscode-list-focusOutline); outline-offset: -1px; }
    .graph-title { flex: none; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .graph-repo { min-width: 0; height: 22px; padding: 0 4px; border: 0; border-radius: 3px; overflow: hidden; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; text-overflow: ellipsis; white-space: nowrap; }
    .graph-repo:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .graph-outdated { padding: 1px 4px; border-radius: 3px; color: var(--vscode-editorWarning-foreground); font-size: 10px; text-transform: uppercase; }
    .graph-scope { max-width: 110px; height: 20px; padding: 0 6px; border: 0; border-radius: 10px; overflow: hidden; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); cursor: pointer; text-overflow: ellipsis; white-space: nowrap; }
    .graph-scope:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .graph-toolbar { display: flex; align-items: center; margin-left: auto; }
    .graph-search { width: calc(100% - 8px); height: 22px; margin: 4px; padding: 2px 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; outline: none; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
    .graph-search:focus { border-color: var(--vscode-focusBorder); }
    .graph-status { padding: 16px; color: var(--vscode-descriptionForeground); text-align: center; }
    .graph-list { min-height: 0; flex: 1; overflow: auto; }
    .graph-item { position: relative; }
    .graph-row { width: 100%; height: 22px; display: flex; align-items: center; gap: 5px; padding: 0 4px; border: 0; border-radius: 0; overflow: hidden; background: transparent; cursor: default; text-align: left; }
    .graph-row:hover { background: var(--vscode-list-hoverBackground); }
    .graph-row.selected { color: var(--vscode-list-inactiveSelectionForeground); background: var(--vscode-list-inactiveSelectionBackground); }
    .graph-row:focus-visible { outline: 1px solid var(--vscode-list-focusOutline); outline-offset: -1px; }
    .graph-lanes { height: 22px; flex: none; overflow: visible; }
    .graph-subject { min-width: 40px; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .graph-author, .graph-date { min-width: 0; overflow: hidden; color: var(--vscode-descriptionForeground); text-overflow: ellipsis; white-space: nowrap; }
    .graph-author { max-width: 105px; flex: 1 1 105px; }
    .graph-date { min-width: max-content; flex: none; font-size: 11px; }
    .graph-commit-meta { min-width: 0; display: flex; flex: 0 1 auto; align-items: center; gap: 5px; margin-left: auto; }
    .graph-refs { min-width: 0; display: flex; flex: 1 1 auto; gap: 3px; overflow: hidden; }
    .graph-ref { min-width: 0; max-width: 110px; flex: 0 1 auto; padding: 0 5px; border-radius: 8px; overflow: hidden; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 10px; line-height: 16px; pointer-events: none; text-overflow: ellipsis; user-select: none; white-space: nowrap; }
    .graph-ref.remote { color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 20%, transparent); }
    .graph-ref.tag { color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 20%, transparent); }
    .graph-ref.current { outline: 1px solid var(--vscode-focusBorder); }
    .graph-inline-action, .graph-menu-action { width: 20px; display: flex; flex: none; visibility: hidden; }
    .graph-row:hover .graph-inline-action, .graph-row:focus-within .graph-inline-action,
    .graph-row:hover .graph-menu-action, .graph-row:focus-within .graph-menu-action { visibility: visible; }
    .graph-lane-extensions { position: absolute; inset: 22px 0 0; pointer-events: none; }
    .graph-lane-extension { position: absolute; inset-block: 0; width: 1px; transform: translateX(-.5px); }
    .graph-details { margin: 0 4px 0 15px; padding: 4px 5px 8px 8px; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); }
    .graph-detail-head { display: flex; align-items: center; gap: 5px; min-height: 22px; }
    .graph-message { min-width: 0; flex: 1; color: var(--vscode-foreground); font-size: 12px; line-height: 16px; white-space: pre-wrap; }
    .graph-meta { font-size: 11px; }
    .graph-detail-head + .graph-meta { margin-top: 4px; }
    .graph-hash { padding: 0; border: 0; color: inherit; background: transparent; cursor: pointer; font: inherit; }
    .graph-hash:hover { color: var(--vscode-foreground); text-decoration: underline; }
    .graph-file { height: 22px; display: flex; align-items: center; gap: 4px; color: var(--vscode-foreground); cursor: pointer; }
    .graph-meta + .graph-file { margin-top: 3px; }
    .graph-file:hover { background: var(--vscode-list-hoverBackground); }
    .graph-file .file-actions { width: 20px; display: flex; margin-left: 0; visibility: hidden; }
    .graph-file:hover .file-actions, .graph-file:focus-within .file-actions { visibility: visible; }
    .graph-load { width: calc(100% - 8px); height: 24px; margin: 4px 4px 8px; border: 0; border-radius: 3px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
    .graph-load:hover { background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <main id="repositories"><div class="empty">Loading repositories…</div></main>
  <section id="graph" class="graph-panel collapsed" aria-label="Commit Graph"></section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('repositories');
    const graphRoot = document.getElementById('graph');
    let model = { loading: true, repositories: [], expanded: [], viewMode: 'list' };
    let graph;
    let graphQuery = '';
    let graphHeight = vscode.getState()?.graphHeight;
    const messages = new Map();
    const generating = new Set();
    const busy = new Map();
    const collapsedGroups = new Set();
    let draggedRepositoryId;
    let suppressToggleUntil = 0;
    // Lucide icon nodes: https://lucide.dev
    const ICONS = {
      pull: [['path', { d: 'M12 17V3' }], ['path', { d: 'm6 11 6 6 6-6' }], ['path', { d: 'M19 21H5' }]],
      push: [['path', { d: 'm18 9-6-6-6 6' }], ['path', { d: 'M12 3v14' }], ['path', { d: 'M5 21h14' }]],
      stash: [['rect', { width: '20', height: '5', x: '2', y: '3', rx: '1' }], ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' }], ['path', { d: 'M10 12h4' }]],
      pop: [['rect', { width: '20', height: '5', x: '2', y: '3', rx: '1' }], ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h2' }], ['path', { d: 'M20 8v11a2 2 0 0 1-2 2h-2' }], ['path', { d: 'm9 15 3-3 3 3' }], ['path', { d: 'M12 12v9' }]],
      check: [['path', { d: 'M20 6 9 17l-5-5' }]],
      add: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
      remove: [['path', { d: 'M5 12h14' }]],
      file: [['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }], ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }]],
      files: [['path', { d: 'M15 2h-4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8' }], ['path', { d: 'M16.706 2.706A2.4 2.4 0 0 0 15 2v5a1 1 0 0 0 1 1h5a2.4 2.4 0 0 0-.706-1.706z' }], ['path', { d: 'M5 7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 1.732-1' }]],
      undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11' }]],
      chevron: [['path', { d: 'm9 18 6-6-6-6' }]],
      down: [['path', { d: 'm6 9 6 6 6-6' }]],
      folder: [['path', { d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2' }]],
      sparkles: [['path', { d: 'm12 3-1.9 4.8a2 2 0 0 1-1.1 1.1L4.2 11 9 12.9a2 2 0 0 1 1.1 1.1l1.9 4.8 1.9-4.8a2 2 0 0 1 1.1-1.1l4.8-1.9L15 9.1a2 2 0 0 1-1.1-1.1z' }], ['path', { d: 'M5 3v4' }], ['path', { d: 'M7 5H3' }], ['path', { d: 'M19 17v4' }], ['path', { d: 'M21 19h-4' }]],
      loader: [['path', { d: 'M21 12a9 9 0 1 1-6.22-8.56' }]],
      more: [['circle', { cx: '12', cy: '5', r: '1' }], ['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '12', cy: '19', r: '1' }]],
      noVerify: [['path', { d: 'M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z' }], ['path', { d: 'm4.2 4.2 15.6 15.6' }]],
      refresh: [['path', { d: 'M21 12a9 9 0 0 1-15.22 6.56L3 16' }], ['path', { d: 'M3 21v-5h5' }], ['path', { d: 'M3 12a9 9 0 0 1 15.22-6.56L21 8' }], ['path', { d: 'M16 8h5V3' }]],
      close: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
      target: [['circle', { cx: '12', cy: '12', r: '8' }], ['circle', { cx: '12', cy: '12', r: '3' }]],
      play: [['path', { d: 'm7 4 13 8-13 8z' }]],
      abort: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'm9 9 6 6' }], ['path', { d: 'm15 9-6 6' }]],
    };

    window.addEventListener('message', ({ data }) => {
      if (data.type === 'stats') {
        const repository = model.repositories.find(({ id }) => id === data.repositoryId);
        if (!repository) return;
        Object.assign(repository, data, { statsReady: true });
      } else if (data.type === 'render') {
        model = data;
      } else if (data.type === 'generatedMessage') {
        messages.set(data.repositoryId, data.message);
      } else if (data.type === 'committed') {
        messages.delete(data.repositoryId);
      } else if (data.type === 'aiState') {
        data.generating ? generating.add(data.repositoryId) : generating.delete(data.repositoryId);
      } else if (data.type === 'busy') {
        data.busy ? busy.set(data.repositoryId, data.label) : busy.delete(data.repositoryId);
      } else if (data.type === 'graph') {
        if (graph?.repositoryId !== data.graph?.repositoryId) graphQuery = '';
        graph = data.graph;
        renderGraph();
        return;
      } else {
        return;
      }
      render();
    });

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    const tooltip = el('div', 'custom-tooltip');
    tooltip.id = 'better-source-control-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    document.body.append(tooltip);
    let tooltipTarget;
    let tooltipTimer;

    function hideTooltip() {
      clearTimeout(tooltipTimer);
      if (tooltipTarget?.getAttribute('aria-describedby') === tooltip.id) {
        tooltipTarget.removeAttribute('aria-describedby');
      }
      tooltipTarget = undefined;
      tooltip.classList.remove('visible');
    }

    function showTooltip(target) {
      hideTooltip();
      if (!target?.dataset.tooltip || target.getAttribute('aria-expanded') === 'true') return;
      tooltipTarget = target;
      tooltipTimer = setTimeout(() => {
        if (tooltipTarget !== target || !target.isConnected) return;
        tooltip.textContent = target.dataset.tooltip;
        target.setAttribute('aria-describedby', tooltip.id);
        tooltip.classList.add('visible');
        const anchor = target.getBoundingClientRect();
        const bounds = tooltip.getBoundingClientRect();
        tooltip.style.left = Math.max(4, Math.min(
          anchor.left + (anchor.width - bounds.width) / 2,
          innerWidth - bounds.width - 4,
        )) + 'px';
        tooltip.style.top = Math.max(4, anchor.bottom + bounds.height + 4 <= innerHeight
          ? anchor.bottom + 4
          : anchor.top - bounds.height - 4) + 'px';
      }, 75);
    }

    document.addEventListener('pointerover', (event) => {
      const target = event.target.closest?.('[data-tooltip]');
      if (target && !target.contains(event.relatedTarget)) showTooltip(target);
    });
    document.addEventListener('pointerout', (event) => {
      if (tooltipTarget && !tooltipTarget.contains(event.relatedTarget)) hideTooltip();
    });
    document.addEventListener('focusin', (event) => showTooltip(event.target.closest?.('[data-tooltip]')));
    document.addEventListener('focusout', hideTooltip);
    document.addEventListener('pointerdown', hideTooltip);
    addEventListener('scroll', hideTooltip, true);
    addEventListener('resize', hideTooltip);
    addEventListener('blur', () => document.querySelectorAll('.repo-menu:popover-open').forEach((menu) => menu.hidePopover()));

    function icon(name, className = 'icon', title) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.classList.add(...className.split(' '));
      if (title) {
        svg.dataset.tooltip = title;
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', title);
      } else {
        svg.setAttribute('aria-hidden', 'true');
      }
      for (const [tag, attributes] of ICONS[name]) {
        const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
        svg.append(child);
      }
      return svg;
    }

    function button(content, title, click, className = 'icon-button') {
      const node = el('button', className);
      node.append(className === 'branch' ? document.createTextNode(content) : icon(content));
      node.type = 'button';
      node.dataset.tooltip = title;
      node.setAttribute('aria-label', title);
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        click();
      });
      return node;
    }

    function menuItem(label, click) {
      const node = el('button', 'menu-item', label);
      node.type = 'button';
      node.setAttribute('role', 'menuitem');
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        click();
      });
      return node;
    }

    function menuSeparator() {
      const node = el('div', 'menu-separator');
      node.setAttribute('role', 'separator');
      return node;
    }

    function render() {
      hideTooltip();
      root.replaceChildren();
      if (model.loading) {
        root.append(el('div', 'empty', 'Loading repositories…'));
        return;
      }
      if (model.error) {
        root.append(el('div', 'empty', model.error));
        return;
      }
      if (!model.repositories.length) {
        root.append(el('div', 'empty', 'No repositories found'));
        return;
      }
      model.repositories.forEach((repository) => root.append(renderRepository(repository)));
    }

    function clearDropIndicators() {
      root.querySelectorAll('.drop-before, .drop-after').forEach((node) =>
        node.classList.remove('drop-before', 'drop-after'));
    }

    function clearDropState() {
      draggedRepositoryId = undefined;
      clearDropIndicators();
    }

    function renderRepository(repository) {
      const expanded = model.expanded.includes(repository.id);
      const progressLabel = busy.get(repository.id);
      const section = el('section', 'repo' + (expanded ? ' expanded' : '') + (repository.files ? '' : ' clean'));
      const row = el('div', 'repo-row');
      row.draggable = true;
      row.addEventListener('dragstart', (event) => {
        if (event.target.closest('button')) {
          event.preventDefault();
          return;
        }
        draggedRepositoryId = repository.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', repository.id);
      });
      row.addEventListener('dragend', clearDropState);
      section.addEventListener('dragover', (event) => {
        if (!draggedRepositoryId || draggedRepositoryId === repository.id) return;
        event.preventDefault();
        clearDropIndicators();
        section.classList.add(event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2 ? 'drop-before' : 'drop-after');
      });
      section.addEventListener('drop', (event) => {
        if (!draggedRepositoryId || draggedRepositoryId === repository.id) return;
        event.preventDefault();
        suppressToggleUntil = Date.now() + 250;
        vscode.postMessage({
          type: 'reorder',
          repositoryId: draggedRepositoryId,
          targetId: repository.id,
          before: section.classList.contains('drop-before'),
        });
        clearDropState();
      });
      if (repository.files) {
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-expanded', String(expanded));
        row.addEventListener('click', () => {
          if (Date.now() < suppressToggleUntil) return;
          post('toggle', repository);
        });
        row.addEventListener('keydown', (event) => {
          if (event.target !== row) return;
          if (event.key === 'Enter' || event.key === ' ') post('toggle', repository);
        });
      }
      row.append(
        repository.files
          ? icon('chevron', 'icon chevron', (expanded ? 'Collapse ' : 'Expand ') + repository.name)
          : icon('check', 'icon clean-indicator', repository.name + ' is clean'),
        el('span', 'repo-name', repository.name),
      );
      if (repository.behind || repository.ahead) {
        const sync = el('span', 'repo-sync');
        if (repository.behind) {
          const incoming = el('span', 'sync-count');
          incoming.append(icon('pull', 'icon', repository.behind + ' incoming commits'), document.createTextNode(repository.behind));
          sync.append(incoming);
        }
        if (repository.ahead) {
          const outgoing = el('span', 'sync-count');
          outgoing.append(icon('push', 'icon', repository.ahead + ' outgoing commits'), document.createTextNode(repository.ahead));
          sync.append(outgoing);
        }
        row.append(sync);
      }
      const meta = el('span', 'repo-meta');
      const branch = button(repository.branch, 'Switch branch', () => post('branch', repository), 'branch');
      if (repository.files) {
        const stats = el('span', 'repo-stats');
        stats.dataset.tooltip = repository.statsLabel;
        stats.append(el('span', 'repo-file-count', String(repository.files)));
        if (repository.statsReady) {
          stats.append(
            el('span', 'add', '+' + repository.insertions),
            el('span', 'del', '-' + repository.deletions),
          );
        }
        meta.append(stats);
      }
      meta.append(branch);

      const actions = el('span', 'actions repo-actions');
      const menu = el('div', 'repo-menu');
      menu.setAttribute('popover', 'auto');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', repository.name + ' actions');
      const execute = (name) => {
        menu.hidePopover();
        operation(repository, name);
      };
      menu.append(
        menuItem('Show Commit Graph', () => {
          menu.hidePopover();
          post('showGraph', repository);
        }),
        menuSeparator(),
        menuItem('Pull and Merge', () => execute('pullMerge')),
        menuItem('Pull and Rebase', () => execute('pullRebase')),
        menuItem('Pull from…', () => execute('pullFrom')),
        menuItem('Push', () => execute('push')),
        menuSeparator(),
        menuItem('Reset Branch to Origin', () => execute('resetToOrigin')),
        menuSeparator(),
        menuItem('Stash Changes', () => execute('stash')),
        menuItem('Pop Stash…', () => execute('popStashSelected')),
        menuItem('Pop Latest Stash', () => execute('popStash')),
      );
      const more = button(progressLabel ? 'loader' : 'more', progressLabel || 'More actions', () => {
        if (menu.matches(':popover-open')) {
          menu.hidePopover();
          return;
        }
        menu.showPopover();
        menu.firstElementChild?.focus();
        const trigger = more.getBoundingClientRect();
        const top = trigger.bottom + menu.offsetHeight <= innerHeight
          ? trigger.bottom
          : trigger.top - menu.offsetHeight;
        menu.style.top = Math.max(2, top) + 'px';
        menu.style.left = Math.max(2, Math.min(
          trigger.right - menu.offsetWidth,
          innerWidth - menu.offsetWidth - 2,
        )) + 'px';
      });
      if (progressLabel) more.querySelector('svg').classList.add('spinning');
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      menu.addEventListener('toggle', () => {
        more.setAttribute('aria-expanded', String(menu.matches(':popover-open')));
      });
      menu.addEventListener('keydown', (event) => {
        const items = [...menu.querySelectorAll('.menu-item')];
        const current = items.indexOf(document.activeElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          menu.hidePopover();
          more.focus();
          return;
        }
        if (event.key === 'Tab') {
          menu.hidePopover();
          return;
        }
        const next = event.key === 'ArrowDown'
          ? (current + 1) % items.length
          : event.key === 'ArrowUp'
            ? (current - 1 + items.length) % items.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : -1;
        if (next >= 0) {
          event.preventDefault();
          items[next].focus();
        }
      });
      if (repository.showNoVerifyButton) {
        const noVerify = button(
          'noVerify',
          'No Verify',
          () => post('toggleNoVerify', repository),
          'icon-button no-verify' + (repository.noVerify ? ' active' : ''),
        );
        noVerify.setAttribute('aria-pressed', String(repository.noVerify));
        actions.append(noVerify);
      }
      actions.append(
        button('pull', 'Pull and Merge', () => operation(repository, 'pullMerge')),
        button('push', 'Push', () => operation(repository, 'push')),
        more,
        menu,
      );
      row.append(meta, actions);
      section.append(row);
      if (expanded && repository.files) section.append(renderDetails(repository));
      if (progressLabel) {
        section.querySelectorAll('button, textarea').forEach((node) => { node.disabled = true; });
      }
      return section;
    }

    function renderDetails(repository) {
      const details = el('div', 'details');
      const commit = el('div', 'commit');
      const progressLabel = busy.get(repository.id);
      const input = el('textarea');
      input.rows = 1;
      input.placeholder = repository.operation
        ? repository.operation[0].toUpperCase() + repository.operation.slice(1) + ' commit message'
        : repository.stagedCount
        ? 'Commit message (' + repository.stagedCount + ' staged)'
        : 'Commit message (stages all ' + repository.files + ' changes)';
      input.value = messages.has(repository.id)
        ? messages.get(repository.id)
        : repository.operationMessage || '';
      input.addEventListener('input', () => {
        messages.set(repository.id, input.value);
      });
      input.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit();
      });
      if (repository.operation === 'rebase') input.disabled = true;
      if (repository.operation) {
        const operationTitle = repository.operation[0].toUpperCase() + repository.operation.slice(1);
        const resume = button(
          progressLabel ? 'loader' : 'play',
          progressLabel || (repository.operationBlocked
            ? 'Resolve all conflicts before continuing merge'
            : 'Continue ' + repository.operation),
          () => vscode.postMessage({
            type: 'continueOperation',
            repositoryId: repository.id,
            operation: repository.operation,
            message: input.value,
          }),
          'commit-button',
        );
        if (progressLabel) resume.querySelector('svg').classList.add('spinning');
        resume.disabled = repository.operationBlocked
          || repository.operation === 'merge' && !input.value.trim();
        input.addEventListener('input', () => {
          resume.disabled = repository.operationBlocked
            || repository.operation === 'merge' && !input.value.trim();
        });
        commit.append(
          input,
          resume,
          button(
            'abort',
            'Abort ' + repository.operation,
            () => vscode.postMessage({
              type: 'abortOperation',
              repositoryId: repository.id,
              operation: repository.operation,
            }),
            'commit-button',
          ),
        );
        details.append(commit);
        if (countFiles(repository.staged)) details.append(renderGroup(repository, 'staged', 'Staged'));
        if (countFiles(repository.unstaged)) details.append(renderGroup(repository, 'unstaged', 'Changes'));
        return details;
      }
      const isGenerating = generating.has(repository.id);
      const generate = button(
        isGenerating ? 'loader' : 'sparkles',
        isGenerating ? 'Generating commit message' : 'Generate commit message',
        () => post('generateMessage', repository),
        'commit-button ai-button',
      );
      generate.disabled = isGenerating;
      if (isGenerating) generate.querySelector('svg').classList.add('spinning');
      const check = button(
        progressLabel ? 'loader' : 'check',
        progressLabel || (repository.stagedCount ? 'Commit staged changes' : 'Stage all changes and commit'),
        submit,
        'commit-button',
      );
      if (progressLabel) check.querySelector('svg').classList.add('spinning');
      check.disabled = Boolean(progressLabel) || !input.value.trim();
      input.addEventListener('input', () => {
        check.disabled = Boolean(progressLabel) || !input.value.trim();
      });
      function submit() {
        const message = input.value.trim();
        if (!message) return;
        vscode.postMessage({ type: 'commit', repositoryId: repository.id, message });
      }
      commit.append(input, generate, check);
      details.append(commit);
      if (countFiles(repository.staged)) details.append(renderGroup(repository, 'staged', 'Staged'));
      if (countFiles(repository.unstaged)) details.append(renderGroup(repository, 'unstaged', 'Changes'));
      return details;
    }

    function renderGroup(repository, kind, title) {
      const group = el('section', 'group');
      const heading = el('div', 'group-title');
      const nodes = repository[kind];
      const key = repository.id + ':' + kind;
      const collapsed = collapsedGroups.has(key);
      heading.tabIndex = 0;
      heading.setAttribute('role', 'button');
      heading.setAttribute('aria-expanded', String(!collapsed));
      const toggle = () => {
        collapsed ? collapsedGroups.delete(key) : collapsedGroups.add(key);
        render();
      };
      heading.addEventListener('click', (event) => {
        if (!event.target.closest('button')) toggle();
      });
      heading.addEventListener('keydown', (event) => {
        if (event.target === heading && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          toggle();
        }
      });
      const actions = el('span', 'actions');
      actions.append(
        button('files', 'Open ' + title, () => groupPost('openAll', repository, kind)),
        button(
          'undo',
          kind === 'staged' ? 'Discard All Staged Changes' : 'Discard All Changes',
          () => groupPost('discardAll', repository, kind),
        ),
        button(
          kind === 'staged' ? 'remove' : 'add',
          kind === 'staged' ? 'Unstage All Changes' : 'Stage All Changes',
          () => groupPost(kind === 'staged' ? 'unstageAll' : 'stageAll', repository, kind),
        ),
      );
      heading.append(
        icon('chevron', 'icon group-chevron' + (collapsed ? '' : ' open'), (collapsed ? 'Expand ' : 'Collapse ') + title),
        el('span', '', title),
        actions,
        el('span', 'count', String(countFiles(nodes))),
      );
      group.append(heading);
      if (!collapsed) nodes.forEach((node) => group.append(renderNode(repository, kind, node, 0)));
      return group;
    }

    function renderNode(repository, kind, node, depth) {
      if (node.type === 'folder') {
        const wrapper = el('div', depth ? 'tree' : '');
        const folder = el('div', 'folder');
        folder.append(icon('down', 'icon', 'Folder expanded'), icon('folder', 'icon', 'Folder ' + node.name), document.createTextNode(node.name));
        wrapper.append(folder);
        const children = el('div', 'tree');
        node.children.forEach((child) => children.append(renderNode(repository, kind, child, depth + 1)));
        wrapper.append(children);
        return wrapper;
      }

      const file = el('div', 'file');
      file.tabIndex = 0;
      file.addEventListener('click', () => filePost('diff', repository, kind, node));
      file.addEventListener('keydown', (event) => event.key === 'Enter' && filePost('diff', repository, kind, node));
      const badge = el('span', 'badge badge-' + node.badge, node.badge);
      badge.dataset.tooltip = ({ A: 'Added', D: 'Deleted', M: 'Modified', R: 'Renamed', C: 'Copied' })[node.badge];
      file.append(badge, el('span', 'file-name', node.name));
      if (model.viewMode === 'list' && node.directory !== '.') file.append(el('span', 'file-dir', node.directory));
      const stats = el('span', 'stats');
      stats.append(el('span', 'add', '+' + node.insertions), el('span', 'del', '−' + node.deletions));
      const actions = el('span', 'file-actions');
      if (node.canOpen) {
        actions.append(button('file', 'Open File', () => filePost('open', repository, kind, node)));
      }
      if (node.canDiscard) {
        actions.append(button('undo', 'Discard Changes', () => filePost('discard', repository, kind, node)));
      }
      actions.append(button(
        kind === 'staged' ? 'remove' : 'add',
        kind === 'staged' ? 'Unstage Changes' : 'Stage Changes',
        () => filePost(kind === 'staged' ? 'unstage' : 'stage', repository, kind, node),
      ));
      file.append(actions, stats);
      return file;
    }

    function renderGraph() {
      hideTooltip();
      graphRoot.replaceChildren();
      const collapsed = !graph || graph.collapsed;
      graphRoot.classList.toggle('collapsed', collapsed);
      if (collapsed) {
        const header = el('header', 'graph-header collapsed');
        header.tabIndex = 0;
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', 'false');
        header.setAttribute('aria-label', 'Expand commit graph');
        header.append(
          icon('chevron', 'icon chevron'),
          el('span', 'graph-title', 'Commit Graph'),
        );
        if (graph) header.append(el('span', 'graph-repo', '· ' + graph.repositoryName));
        const expand = () => vscode.postMessage({ type: 'expandGraph' });
        header.addEventListener('click', expand);
        header.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          expand();
        });
        graphRoot.append(header);
        return;
      }
      if (graphHeight) graphRoot.style.flexBasis = graphHeight + 'px';

      const resizer = el('div', 'graph-resizer');
      resizer.tabIndex = 0;
      resizer.setAttribute('role', 'separator');
      resizer.setAttribute('aria-label', 'Resize commit graph');
      resizer.setAttribute('aria-orientation', 'horizontal');
      resizer.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        resizer.setPointerCapture(event.pointerId);
        const startY = event.clientY;
        const startHeight = graphRoot.offsetHeight;
        const move = (moveEvent) => setGraphHeight(startHeight + startY - moveEvent.clientY);
        const stop = (upEvent) => {
          if (resizer.hasPointerCapture(upEvent.pointerId)) resizer.releasePointerCapture(upEvent.pointerId);
          resizer.removeEventListener('pointermove', move);
          resizer.removeEventListener('pointerup', stop);
          resizer.removeEventListener('pointercancel', stop);
          vscode.setState({ ...vscode.getState(), graphHeight });
        };
        resizer.addEventListener('pointermove', move);
        resizer.addEventListener('pointerup', stop);
        resizer.addEventListener('pointercancel', stop);
      });
      resizer.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        setGraphHeight(graphRoot.offsetHeight + (event.key === 'ArrowUp' ? 20 : -20));
        vscode.setState({ ...vscode.getState(), graphHeight });
      });

      const header = el('header', 'graph-header');
      header.addEventListener('click', (event) => {
        if (!event.target.closest('button')) graphPost('closeGraph');
      });
      header.append(el('span', 'graph-title', 'Commit Graph'));
      const repository = el('button', 'graph-repo', '· ' + graph.repositoryName);
      repository.type = 'button';
      repository.dataset.tooltip = 'Choose repository';
      repository.setAttribute('aria-label', 'Choose repository. Current repository: ' + graph.repositoryName);
      repository.addEventListener('click', () => graphPost('graphRepository'));
      header.append(repository);
      if (graph.outdated) header.append(el('span', 'graph-outdated', 'Outdated'));
      const toolbar = el('span', 'graph-toolbar');
      const scope = el('button', 'graph-scope', graph.scope.label);
      scope.type = 'button';
      scope.dataset.tooltip = 'Filter commit graph';
      scope.setAttribute('aria-label', 'Filter commit graph. Current filter: ' + graph.scope.label);
      scope.addEventListener('click', () => graphPost('graphScope'));
      toolbar.append(
        scope,
        button('target', 'Reveal current commit', revealGraphHead),
        button('refresh', 'Refresh commit graph', () => graphPost('graphRefresh')),
        button('close', 'Collapse commit graph', () => graphPost('closeGraph')),
      );
      header.append(toolbar);
      const search = el('input', 'graph-search');
      search.type = 'search';
      search.placeholder = 'Filter commits by message, author, ref, or hash';
      search.value = graphQuery;
      search.setAttribute('aria-label', 'Filter commits');
      const list = el('div', 'graph-list');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', graph.repositoryName + ' commit history');
      list.setAttribute('aria-busy', String(graph.loading));
      search.addEventListener('input', () => {
        graphQuery = search.value;
        renderGraphList(list);
      });
      graphRoot.append(resizer, header, search, list);
      renderGraphList(list);
    }

    function setGraphHeight(value) {
      graphHeight = Math.round(Math.max(160, Math.min(Math.max(160, innerHeight - 140), value)));
      graphRoot.style.flexBasis = graphHeight + 'px';
      graphRoot.querySelector('.graph-resizer')?.setAttribute('aria-valuenow', String(graphHeight));
    }

    function renderGraphList(list) {
      list.replaceChildren();
      if (graph.error) {
        list.append(el('div', 'graph-status', 'Unable to load commits: ' + graph.error));
        return;
      }
      if (graph.loading && !graph.commits.length) {
        list.append(el('div', 'graph-status', 'Loading commit graph…'));
        return;
      }
      const query = graphQuery.trim().toLocaleLowerCase();
      const refsByCommit = new Map();
      for (const ref of graph.refs) {
        const values = refsByCommit.get(ref.commit) || [];
        values.push(ref);
        refsByCommit.set(ref.commit, values);
      }
      const commits = graph.commits.filter((commit) => {
        if (!query) return true;
        const refs = (refsByCommit.get(commit.hash) || []).map((ref) => ref.name).join(' ');
        return (commit.subject + ' ' + commit.author + ' ' + commit.hash + ' ' + refs)
          .toLocaleLowerCase().includes(query);
      });
      if (!commits.length) {
        list.append(el('div', 'graph-status', query ? 'No matching commits' : 'No commits found'));
        return;
      }
      commits.forEach((commit) => {
        list.append(renderGraphCommit(commit, refsByCommit.get(commit.hash) || []));
      });
      if (graph.loading) list.append(el('div', 'graph-status', 'Refreshing commit graph…'));
      if (!query && graph.hasMore && !graph.loading) {
        const load = el('button', 'graph-load', 'Load More Commits');
        load.type = 'button';
        load.addEventListener('click', () => graphPost('graphLoadMore'));
        list.append(load);
      }
    }

    function renderGraphCommit(commit, refs) {
      const item = el('div', 'graph-item');
      const row = el('div', 'graph-row' + (graph.selectedHash === commit.hash ? ' selected' : ''));
      row.tabIndex = graph.selectedHash === commit.hash ? 0 : -1;
      row.dataset.hash = commit.hash;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(graph.selectedHash === commit.hash));
      row.setAttribute(
        'aria-label',
        commit.subject + ', ' + commit.author
          + (refs.length ? ', references ' + refs.map((ref) => ref.name).join(', ') : '')
          + ', ' + relativeDate(commit.date),
      );
      row.addEventListener('click', (event) => {
        if (!event.target.closest('button')) graphPost('graphSelect', commit);
      });
      row.addEventListener('dblclick', () => graphPost('graphOpen', commit));
      row.addEventListener('keydown', (event) => {
        const rows = [...graphRoot.querySelectorAll('.graph-row')];
        const index = rows.indexOf(row);
        const target = event.key === 'ArrowDown' ? rows[index + 1]
          : event.key === 'ArrowUp' ? rows[index - 1]
            : event.key === 'Home' ? rows[0]
              : event.key === 'End' ? rows.at(-1) : undefined;
        if (target) {
          event.preventDefault();
          row.tabIndex = -1;
          target.tabIndex = 0;
          target.focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          graphPost('graphSelect', commit);
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          showGraphMenu(menu, more, row.getBoundingClientRect());
        }
      });
      const lane = graphSvg(commit);
      const subject = el('span', 'graph-subject', commit.subject);
      subject.dataset.tooltip = commit.message;
      const openAction = el('span', 'graph-inline-action');
      openAction.append(button('files', 'Open commit changes', () => graphPost('graphOpen', commit)));
      row.append(lane, subject, openAction);
      const meta = el('span', 'graph-commit-meta');
      meta.append(el('span', 'graph-author', commit.author));
      if (refs.length) {
        const badges = el('span', 'graph-refs');
        refs.slice(0, 3).forEach((ref) => {
          const badge = el('span', 'graph-ref ' + ref.type + (ref.current ? ' current' : ''), ref.name);
          badges.append(badge);
        });
        if (refs.length > 3) badges.dataset.tooltip = refs.map((ref) => ref.name).join(', ');
        meta.append(badges);
      }
      const date = el('time', 'graph-date', relativeDate(commit.date));
      date.dateTime = commit.date || '';
      date.dataset.tooltip = formatDate(commit.date);
      meta.append(date);
      row.append(meta);
      const menuAction = el('span', 'graph-menu-action');
      const menu = graphMenu(commit);
      const more = button('more', 'More commit actions', () => showGraphMenu(menu, more));
      menu.graphTrigger = more;
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      menu.addEventListener('toggle', () => {
        more.setAttribute('aria-expanded', String(menu.matches(':popover-open')));
      });
      menuAction.append(more, menu);
      row.append(menuAction);
      item.append(row);
      if (graph.selectedHash === commit.hash) {
        const extensions = el('div', 'graph-lane-extensions');
        commit.output.forEach((lane, index) => {
          const line = el('span', 'graph-lane-extension');
          line.style.left = (15 + index * 11) + 'px';
          line.style.backgroundColor = graphColor(lane.color);
          extensions.append(line);
        });
        item.append(extensions, renderGraphDetails(commit));
      }
      return item;
    }

    function graphSvg(commit) {
      const width = 11 * (commit.laneCount + 1);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add('graph-lanes');
      svg.setAttribute('width', width);
      svg.setAttribute('viewBox', '0 0 ' + width + ' 22');
      svg.setAttribute('aria-hidden', 'true');
      const x = (lane) => 11 * (lane + 1);
      const path = (d, color) => {
        const pathNode = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathNode.setAttribute('d', d);
        pathNode.setAttribute('fill', 'none');
        pathNode.setAttribute('stroke', graphColor(color));
        pathNode.setAttribute('stroke-width', '1');
        pathNode.setAttribute('stroke-linecap', 'round');
        svg.append(pathNode);
      };
      let outputIndex = 0;
      commit.input.forEach((input, index) => {
        if (input.hash === commit.hash) {
          if (index !== commit.lane) {
            path('M' + x(index) + ' 0V6Q' + x(index) + ' 11 ' + (x(index) - 5) + ' 11H' + x(commit.lane), input.color);
          } else {
            outputIndex++;
          }
        } else if (commit.output[outputIndex]?.hash === input.hash) {
          const to = outputIndex++;
          path(index === to
            ? 'M' + x(index) + ' 0V22'
            : 'M' + x(index) + ' 0V6Q' + x(index) + ' 11 ' + (x(index) - 5) + ' 11H' + (x(to) + 5) + 'Q' + x(to) + ' 11 ' + x(to) + ' 16V22', input.color);
        }
      });
      for (let index = 1; index < commit.parents.length; index++) {
        let parentIndex = -1;
        for (let lane = commit.output.length - 1; lane >= 0; lane--) {
          if (commit.output[lane].hash === commit.parents[index]) {
            parentIndex = lane;
            break;
          }
        }
        if (parentIndex !== -1) {
          path('M' + x(commit.lane) + ' 11H' + (x(parentIndex) - 11)
            + 'Q' + x(parentIndex) + ' 11 ' + x(parentIndex) + ' 22', commit.output[parentIndex].color);
        }
      }
      const input = commit.input[commit.lane];
      if (input?.hash === commit.hash) path('M' + x(commit.lane) + ' 0V11', input.color);
      if (commit.parents.length) path('M' + x(commit.lane) + ' 11V22', commit.color);
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      node.setAttribute('cx', x(commit.lane));
      node.setAttribute('cy', '11');
      node.setAttribute('r', graph.head === commit.hash ? '4.5' : commit.parents.length > 1 ? '3.5' : '3');
      node.setAttribute('fill', graph.head === commit.hash ? 'var(--vscode-sideBar-background)' : graphColor(commit.color));
      node.setAttribute('stroke', graphColor(commit.color));
      node.setAttribute('stroke-width', graph.head === commit.hash ? '2' : '1');
      svg.append(node);
      return svg;
    }

    function graphColor(index) {
      const colors = [
        'var(--vscode-scmGraph-historyItemRefColor, var(--vscode-charts-blue, #4daafc))',
        'var(--vscode-scmGraph-foreground1, #FFB000)',
        'var(--vscode-scmGraph-foreground2, #DC267F)',
        'var(--vscode-scmGraph-foreground3, #994F00)',
        'var(--vscode-scmGraph-foreground4, #40B0A6)',
        'var(--vscode-scmGraph-foreground5, #B66DFF)',
      ];
      return colors[index % colors.length];
    }

    function renderGraphDetails(commit) {
      const details = el('div', 'graph-details');
      details.style.marginLeft = (4 + 11 * (commit.laneCount + 1)) + 'px';
      const meta = el('div', 'graph-meta');
      const hash = el('button', 'graph-hash', commit.hash.slice(0, 12));
      hash.type = 'button';
      hash.dataset.tooltip = 'Copy commit ID';
      hash.setAttribute('aria-label', 'Copy commit ID');
      hash.addEventListener('click', () => graphPost('graphCopyHash', commit));
      meta.append(
        hash,
        document.createTextNode(' · ' + commit.author + ' · ' + formatDate(commit.date)
          + (commit.files ? ' · ' + commit.files + ' files · +' + commit.insertions + ' −' + commit.deletions : '')),
      );
      const body = commit.message.split(/\\r?\\n/).slice(1).join('\\n').trim();
      if (body) {
        const head = el('div', 'graph-detail-head');
        head.append(
          el('span', 'graph-message', body),
          button('files', 'Open all commit changes', () => graphPost('graphOpen', commit)),
        );
        details.append(head);
      }
      details.append(meta);
      const data = graph.details;
      if (!data || data.hash !== commit.hash || data.loading) {
        details.append(el('div', 'graph-meta', 'Loading changed files…'));
      } else if (data.error) {
        details.append(el('div', 'graph-meta', data.error));
      } else if (!data.files.length) {
        details.append(el('div', 'graph-meta', 'No changed files'));
      } else {
        data.files.forEach((file) => {
          const row = el('div', 'graph-file');
          row.tabIndex = 0;
          row.dataset.tooltip = 'Open changes from this commit';
          row.addEventListener('click', (event) => {
            if (!event.target.closest('button')) graphFilePost('graphFileDiff', commit, file);
          });
          row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') graphFilePost('graphFileDiff', commit, file);
          });
          row.append(
            el('span', 'badge badge-' + file.badge, file.badge),
            el('span', 'file-name', file.name),
          );
          if (file.directory !== '.') row.append(el('span', 'file-dir', file.directory));
          const fileActions = el('span', 'file-actions');
          if (file.canOpen) {
            fileActions.append(button('file', 'Open file at this commit', () => graphFilePost('graphFileOpen', commit, file)));
          }
          const stats = el('span', 'stats');
          stats.append(el('span', 'add', '+' + file.insertions), el('span', 'del', '−' + file.deletions));
          row.append(stats, fileActions);
          details.append(row);
        });
      }
      return details;
    }

    function graphMenu(commit) {
      const menu = el('div', 'repo-menu');
      menu.setAttribute('popover', 'auto');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Actions for commit ' + commit.hash.slice(0, 8));
      const action = (type, extra) => () => {
        menu.hidePopover();
        graphPost(type, commit, extra);
      };
      const rewrite = [menuItem('Cherry Pick', action('graphCherryPick'))];
      if (commit.hash === graph.head) {
        rewrite.push(menuItem('Amend Commit Message…', action('graphAmendMessage')));
      }
      if (commit.canRollback) {
        rewrite.push(menuItem('Rollback to This Commit…', action('graphRollback')));
      }
      menu.append(
        menuItem('Open Changes', action('graphOpen')),
        menuSeparator(),
        menuItem('Checkout Detached', action('graphCheckout')),
        menuItem('Create Branch from Commit…', action('graphCreateBranch')),
        menuItem('Create Tag from Commit…', action('graphCreateTag')),
        menuSeparator(),
        ...rewrite,
        menuSeparator(),
        menuItem('Compare with Remote', action('graphCompare', { mode: 'remote' })),
        menuItem('Compare with Merge Base', action('graphCompare', { mode: 'base' })),
        menuItem('Compare with Ref…', action('graphCompare', { mode: 'ref' })),
        menuSeparator(),
        menuItem('Copy Commit Hash', action('graphCopyHash')),
        menuItem('Copy Commit Message', action('graphCopyMessage')),
      );
      menu.addEventListener('keydown', (event) => {
        const items = [...menu.querySelectorAll('.menu-item')];
        const current = items.indexOf(document.activeElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          menu.hidePopover();
          menu.graphTrigger?.focus();
          return;
        }
        if (event.key === 'Tab') {
          menu.hidePopover();
          return;
        }
        const next = event.key === 'ArrowDown'
          ? (current + 1) % items.length
          : event.key === 'ArrowUp'
            ? (current - 1 + items.length) % items.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
        if (next >= 0) {
          event.preventDefault();
          items[next].focus();
        }
      });
      return menu;
    }

    function showGraphMenu(menu, trigger, rect) {
      if (menu.matches(':popover-open')) {
        menu.hidePopover();
        return;
      }
      menu.showPopover();
      menu.firstElementChild?.focus();
      const anchor = rect || trigger.getBoundingClientRect();
      const top = anchor.bottom + menu.offsetHeight <= innerHeight
        ? anchor.bottom
        : anchor.top - menu.offsetHeight;
      menu.style.top = Math.max(2, top) + 'px';
      menu.style.left = Math.max(2, Math.min(anchor.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 2)) + 'px';
    }

    function revealGraphHead() {
      graphRoot.querySelector('[data-hash="' + CSS.escape(graph.head || '') + '"]')
        ?.scrollIntoView({ block: 'center' });
    }

    function relativeDate(value) {
      if (!value) return '';
      const seconds = Math.abs((new Date(value).getTime() - Date.now()) / 1000);
      const units = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
      const [unit, size] = units.find(([, amount]) => seconds >= amount) || ['s', 1];
      return Math.max(1, Math.round(seconds / size)) + unit;
    }

    function formatDate(value) {
      return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Unknown date';
    }

    function graphPost(type, commit, extra = {}) {
      vscode.postMessage({
        type,
        repositoryId: graph.repositoryId,
        hash: commit?.hash,
        ...extra,
      });
    }

    function graphFilePost(type, commit, file) {
      graphPost(type, commit, { uri: file.uri });
    }

    function countFiles(nodes) {
      return nodes.reduce((total, node) => total + (node.type === 'folder' ? countFiles(node.children) : 1), 0);
    }

    function post(type, repository) {
      vscode.postMessage({ type, repositoryId: repository.id });
    }

    function operation(repository, operation) {
      vscode.postMessage({ type: 'operation', repositoryId: repository.id, operation });
    }

    function groupPost(type, repository, kind) {
      vscode.postMessage({ type, repositoryId: repository.id, kind });
    }

    function filePost(type, repository, kind, file) {
      vscode.postMessage({ type, repositoryId: repository.id, kind, uri: file.uri });
    }

    renderGraph();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

async function activate(context) {
  const log = vscode.window.createOutputChannel('Better Source Control', { log: true });
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('gitChangeStats.showOutput', () => log.show()),
  );
  log.info(`Activating Better Source Control ${context.extension.packageJSON.version}.`);
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    log.error('VS Code Git extension is unavailable.');
    return;
  }
  const extension = await gitExtension.activate();
  if (!extension.enabled) {
    log.warn('VS Code Git extension is disabled.');
    return;
  }

  await ai.normalizeConfiguration();
  if (!context.globalState.get('gitChangeStats.nativeGraphRemoved', false)) {
    try {
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes('workbench.scm.history.removeView')) {
        await vscode.commands.executeCommand('workbench.scm.history.removeView');
      } else {
        await vscode.commands.executeCommand('vscode.moveViews', {
          viewIds: ['workbench.scm.history'],
          destinationId: 'workbench.view.scm',
        });
      }
      await context.globalState.update('gitChangeStats.nativeGraphRemoved', true);
    } catch {
      // Older VS Code builds can ignore this one-time migration.
    }
  }
  const api = extension.getAPI(1);
  log.info(`Git API state: ${api.state}; repositories: ${api.repositories.length}.`);
  const provider = new RepositoryViewProvider(api, context, log);
  await vscode.commands.executeCommand('setContext', 'gitChangeStats.available', true);
  await vscode.commands.executeCommand('setContext', 'gitChangeStats.viewMode', provider.viewMode);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider('git-change-stats-empty', {
      provideTextDocumentContent: () => '',
    }),
    vscode.commands.registerCommand('gitChangeStats.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('gitChangeStats.listView', () => provider.setViewMode('list')),
    vscode.commands.registerCommand('gitChangeStats.treeView', () => provider.setViewMode('tree')),
    vscode.commands.registerCommand('gitChangeStats.expandAll', () => provider.expandAll()),
    vscode.commands.registerCommand('gitChangeStats.collapseAll', () => provider.collapseAll()),
    vscode.commands.registerCommand('gitChangeStats.configureAI', () => ai.configureAI()),
    vscode.commands.registerCommand('gitChangeStats.openSettings', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:wrick17.git-change-stats',
      )),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, fullRefName, html, RepositoryViewProvider };
