# Changelog

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

## 0.2.24 — 2026-08-10

### Changed

- Replaced native browser tooltips with faster, VS Code-themed tooltips throughout Better Source Control.

### Fixed

- Prevented commit graph metadata and timestamps from being clipped at the right edge.

## 0.2.23 — 2026-08-10

### Changed

- Kept the Commit Graph visible as a persistent bottom bar that expands on click and collapses without losing its selected repository or loaded history.
- Made expanded commit descriptions smaller and added spacing before their metadata.
- Added spacing between commit metadata and its changed-file list.
- Tightened repository-row action spacing.

## 0.2.22 — 2026-08-10

### Added

- Added per-repository loading indicators for commits and other asynchronous Git operations.
- Added **Pop Stash…** with VS Code's native stash picker.

### Changed

- Prevented duplicate repository actions while an operation is running.
- Added more left spacing to the Commit Graph title.

## 0.2.21 — 2026-08-10

### Added

- Added a Better Source Control log channel and a **Show Output** command.
- Added **Pull from…** to each repository action menu with VS Code's native remote and branch picker.
- Added contextual Continue and Abort controls while a merge or rebase is in progress.

### Fixed

- Fixed an invalid generated webview script that could leave repositories stuck loading.
- Replaced silent repository-loading failures with a visible error and diagnostic log entry.

## 0.2.20 — 2026-08-10

### Fixed

- Removed the duplicated commit subject from expanded graph details while preserving message bodies.

## 0.2.19 — 2026-08-10

### Changed

- Reduced clean-repository checkmarks to match the visual size of repository carets.

## 0.2.18 — 2026-08-10

### Fixed

- Kept expanded commit details clear of multi-lane graph tracks.

## 0.2.17 — 2026-08-10

### Fixed

- Continued active graph lanes through expanded commit details.
- Matched graph track colors and geometry to VS Code's native Source Control Graph.
- Flattened commit-message settings to Provider, Model, and Reasoning Effort.
- Added subtle section backgrounds and a clickable commit ID with a copy tooltip.
- Added a compact right inset across repository commit controls, headers, and file rows.

## 0.2.16 — 2026-08-10

### Changed

- Added compact spacing between expanded commit messages and their metadata.

## 0.2.15 — 2026-08-10

### Added

- Added an **Amend Commit Message** action for the current commit that preserves staged changes.

### Changed

- Grouped repository and commit actions into compact menu sections.

## 0.2.14 — 2026-08-10

### Fixed

- Loaded initial-commit details through an explicit empty-tree range instead of relying on VS Code's private empty-tree cache.

## 0.2.13 — 2026-08-10

### Fixed

- Added a compact inset to the Commit Graph header, filter, rows, details, and pagination control.
- Loaded commit files and diffs from the commit's parent instead of the current working tree.

## 0.2.12 — 2026-08-10

### Added

- A guarded **Rollback to This Commit** graph action for ancestors of the current local branch, with Soft, Mixed, and Hard reset modes.

## 0.2.11 — 2026-08-10

### Fixed

- Removed the misleading hover target and color change from informational ref pills.

## 0.2.10 — 2026-08-10

### Changed

- Right-aligned commit authors beside branch/tag pills and timestamps.

## 0.2.9 — 2026-08-10

### Fixed

- Placed the Open Changes action beside the commit message and the menu action at the far end of the row without hover shifts.
- Added native tooltips to icon buttons.

## 0.2.8 — 2026-08-10

### Changed

- Compact Commit Graph timestamps to values such as `5h`, `3d`, and `2mo`, with the full date available on hover.

## 0.2.7 — 2026-08-10

### Fixed

- Prevented commit rows from shifting when their hover actions appear.

## 0.2.6 — 2026-08-10

### Fixed

- Kept commit-file diff stats and the hover file action together at the far right of each row.

## 0.2.5 — 2026-08-10

### Fixed

- Made the Commit Graph resize handle easier and more reliable to drag.
- Restored a compact inset and aligned vertical guide for expanded commit details.
- Kept commit-file diff stats stable by reserving the trailing file-action slot until hover.

## 0.2.4 — 2026-08-10

### Fixed

- Corrected the visual alignment of the Commit Graph refresh icon.

## 0.2.3 — 2026-08-10

### Added

- A draggable, keyboard-accessible resize handle for the integrated Commit Graph.
- Collapsible Staged and Changes groups.

### Fixed

- Selecting an expanded commit again now collapses its details.
- Commit-detail file rows open the commit diff, while the file action opens the full snapshot at that commit.
- Removed remaining left and horizontal spacing from the Commit Graph.
- Removed the legacy native Graph section from Better Source Control.

### Changed

- VSIX files are ignored and local installation now packages into the system temporary directory and deletes the artifact after installation.

## 0.2.2 — 2026-08-10

### Fixed

- Corrected remote branch-base reference normalization so repository commit graphs load successfully.
- Removed the webview's inherited horizontal padding and restored the old native Graph view to Source Control.

### Added

- The repository name in the Commit Graph header now opens a repository picker.

## 0.2.1 — 2026-08-10

### Added

- A repository-specific commit graph embedded at the bottom of Better Source Control, with colored merge lanes, branch/tag badges, filtering, commit details, file diffs, pagination, refresh, reveal-current, and close controls.
- Commit actions for opening changes, detached checkout, branch/tag creation, cherry-pick, comparisons, and copying commit hashes or messages.

### Changed

- Replaced the moved VS Code Source Control Graph with a graph that always opens for the repository selected in Better Source Control.

## 0.2.0 — 2026-08-10

### Added

- Dedicated **Better Source Control** Activity Bar experience for multi-repository workspaces.
- Expandable repository rows with inline commit messages, branch switching, pull, push, stash, and pop-stash actions.
- Staged and unstaged file groups with list/tree layouts, status badges, line-change totals, open, diff, stage, unstage, and confirmed discard actions.
- Repository file-count badges, incoming/outgoing commit indicators, clean-state icons, drag-and-drop ordering, and expand/collapse-all controls.
- Automatic staging when committing without staged files.
- Generated commit messages through locally authenticated Codex or Claude Code CLIs, with provider-aware model selection and Low/Medium/High reasoning controls.
- Optional remembered `--no-verify` controls for supported Git operations.
- Native Git Graph placement below the repository view.

### Changed

- Renamed the extension to **Better Source Control** and added a new Marketplace icon.
- Improved repository loading reliability and deferred expensive file statistics for a faster initial render.
- Restyled the view to follow VS Code colors, spacing, badges, tooltips, and interaction patterns.
