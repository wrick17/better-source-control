# Better Source Control

A dedicated VS Code view for every Git repository in a workspace. It includes:

- Repository-level Pull, Push, Publish Branch, and stash actions
- Staged and working-tree groups with per-file stage/unstage actions
- Modified, added, deleted, renamed, and copied badges
- Per-file and per-repository added/deleted line counts
- Global list/tree layout toggle
- File diffs, the native branch picker, worktree creation, and staged commits
- Automatic staging when committing with no staged changes
- Commit-message generation through a locally authenticated Codex or Claude Code CLI
- An integrated, repository-specific commit graph with merge lanes, refs, commit details, diffs, filtering, and local history actions

Open **Better Source Control** from the Activity Bar. Each repository row has its own Git actions; select the row to reveal its commit box, staged changes, and working-tree changes. Select a branch name to switch branches and a file to open its diff.

The built-in Git extension must remain enabled because Better Source Control uses its official repository API. VS Code does not let extensions hide the built-in Source Control container, but you can right-click the Activity Bar and hide **Source Control** after installing this replacement view.

Use **Better Source Control: Configure AI** for one global provider plus separate model and reasoning controls for commit messages and conflict resolution. An empty model uses the selected CLI's default.

Generating a message sends the staged diff to the selected AI CLI, or the working-tree diff when nothing is staged. Untracked filenames are included, but their contents are excluded by default. Enable `gitChangeStats.includeUntrackedContent` to include up to 8 KiB per new text file and 64 KiB total; check for secrets before enabling it. Staging a new file includes its diff normally.

Conflict resolution handles marked text conflicts; binary, structural, and ambiguous conflicts remain available for manual resolution. Files containing marker-like lines (for example, a seven-equals Markdown underline) may require manual staging even after resolution. Review the resulting changes before continuing the Git operation. Claude conflict resolution requires Claude Code 2.1.248 or newer for restricted mode; older versions fail without falling back to broader permissions.

Line counts use batched Git diffs. New files are read up to 1 MiB each; oversized, unreadable, or non-regular files show incomplete statistics. Graph filtering searches the loaded history.

## Install locally

```sh
bun run install:local
```

Reload VS Code after installation.

## Develop

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

```sh
bun run test
```

The tests use Node's test runner, including temporary Git repositories. `npm test` is equivalent; running `bun test` directly selects a different runner.

To check activation and Git operations in a real, isolated VS Code Extension Development Host:

```sh
bun run test:host
```

This opens a temporary test window and repository. Set `CODE_EXECUTABLE` to the VS Code CLI path if `code` is not on `PATH`. The test does not install the extension or change your open workspace. CI runs the Node suite on Linux, macOS, and Windows; the host smoke test requires a desktop session.
