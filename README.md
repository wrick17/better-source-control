# Better Source Control

A dedicated VS Code view for every Git repository in a workspace. It includes:

- Repository-level Pull, Push, Stash, and Pop Stash actions
- Staged and working-tree groups with per-file stage/unstage actions
- Modified, added, deleted, renamed, and copied badges
- Per-file and per-repository added/deleted line counts
- Global list/tree layout toggle
- File diffs, branch switching, and staged commits
- Automatic staging when committing with no staged changes
- Commit-message generation through a locally authenticated Codex or Claude Code CLI
- An integrated, repository-specific commit graph with merge lanes, refs, commit details, diffs, filtering, and local history actions

Open **Better Source Control** from the Activity Bar. Each repository row has its own Git actions; select the row to reveal its commit box, staged changes, and working-tree changes. Select a branch name to switch branches and a file to open its diff.

The built-in Git extension must remain enabled because Better Source Control uses its official repository API. VS Code does not let extensions hide the built-in Source Control container, but you can right-click the Activity Bar and hide **Source Control** after installing this replacement view.

Use **Better Source Control: Configure AI** for one global provider plus separate model and reasoning controls for commit messages and conflict resolution. An empty model uses the selected CLI's default.

## Install locally

```sh
bun run install:local
```

Reload VS Code after installation.

## Develop

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

```sh
bun test
```
