# Changelog

## 1.1.1 — 2026-09-23

### Fixed

- Preserve the remote name for branches containing slashes, fixing Auto commit graph loading and base-branch comparisons.

## 1.1.0 — 2026-09-23

### Added

- Native branch picker, Publish Branch, stash review/apply, and worktree creation.
- Copy Commit Remote Link for GitHub commits and single-parent commit reverts.
- Cherry-pick and revert recovery, persisted commit drafts, custom AI model IDs, and opt-in bounded untracked-file prompt contents.
- Cross-platform test workflow, F5 launch configuration, and an isolated VS Code host smoke test.

### Fixed

- Revalidate branch, commit, and operation state before destructive or history-changing actions; reset to the freshly fetched commit.
- Restrict AI conflict staging to resolved text, tighten Claude permissions, and wait for cancellation before releasing repository activity.
- Batch line statistics, bound untracked reads, and indicate unavailable counts.
- Preserve typing focus and selection during updates; ignore stale graph results and align comparison diff endpoints.
- Correct collapsed graph title alignment, disconnected graph lanes, and nested keyboard actions.

## 1.0.9 — 2026-08-24

### Fixed

- Released failed Git operations before their error notifications are dismissed.

## 1.0.8 — 2026-08-12

### Added

- Added **Open Changes on Remote** to commit actions.
- Made commit authors open their linked GitHub profiles.

### Changed

- Delayed the first tooltip by one second while keeping direct tooltip-to-tooltip transitions immediate.
- Moved **Open Changes** into expanded commit details, kept it visible, and aligned it with the commit date column.

## 1.0.7 — 2026-08-12

### Fixed

- Kept the commit graph's scroll position when opening commit details.

## 1.0.6 — 2026-08-12

### Fixed

- Kept repository line statistics visible while updated values are calculated.

## 1.0.5 — 2026-08-12

### Fixed

- Prevented overlapping repository refreshes from exhausting the VS Code extension host's file descriptors.

## 1.0.4 — 2026-08-11

### Fixed

- Aligned the changelog with the versions actually released to the Visual Studio Marketplace.

## 1.0.3 — 2026-08-11

### Added

- Added a global **Fetch All Repositories** button.
- Added start, completion, duplicate-suppression, failure, and individual Git API, VS Code command, Git executable, and AI CLI invocation logs to the **Better Source Control** Output channel.

## 1.0.2 — 2026-08-11

### Added

- Added **Resolve all conflicts with AI** for active merges and rebases, using the globally selected Codex or Claude Code model.

### Changed

- Replaced the blocked Continue action with AI conflict resolution, then restored Continue automatically after all resolved paths are staged.
- Renamed the global AI command to **Configure AI**, with one shared provider and separate model and reasoning controls for commit-message generation and conflict resolution.
- Added merge and rebase progress icons beside repository names, including collapsed repositories.

### Fixed

- Displayed conflicted files with a **!** status instead of **M**, leaving **C** for copied files.
- Added **!** to repository file-count badges while merge conflicts remain.
- Opened content conflicts through VS Code's native Git editor route, matching its filename, full-file view, and **Resolve in Merge Editor** action.
- Blocked every repository-row interaction while a Git operation loader is active.
- Kept repositories expandable during an active merge or rebase even after every file change is discarded, preserving Continue and Abort controls.
- Kept filenames visible while truncating long directory paths with a full-path tooltip.

## 1.0.1 — 2026-08-11

### Added

- Added a guarded **Reset Branch to Origin** repository action that fetches the current branch and replaces its local commits and tracked changes with `origin/<branch>`.

### Fixed

- Closed repository and commit menus when focus moves outside the Better Source Control panel.
- Made the expanded Commit Graph header collapse the graph when clicked while preserving its repository and toolbar actions.

## 1.0.0 — 2026-08-10

### Added

- First stable release of Better Source Control.
- Multi-repository staging, commits, Git operations, change statistics, and a repository-specific commit graph in one dedicated view.
- Local commit-message generation through Codex CLI or Claude Code CLI.

### Changed

- Replaced Git Change Stats with a complete VS Code-native source control workflow and dedicated Activity Bar experience.

## 0.1.0 — 2026-08-10

### Added

- Initial Git Change Stats release with repository change counts, line additions and deletions, branch names, and a manual refresh command for multi-root VS Code workspaces.
