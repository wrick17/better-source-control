# Changelog

## 1.1.15 — 2026-10-15

### Fixed

- A cancelled Publish Branch picker or a publish that never reaches Git keeps No Verify armed.
- A failed graph amend spends No Verify when no merge, rebase, cherry-pick, or revert is pending, matching other operations.
- Retained hooks keep their original layout, so hooks that use paths relative to `$0` still work during No Verify continuations.
- Non-executable hooks stay disabled during No Verify continuations, as Git itself does.

## 1.1.14 — 2026-10-15

### Changed

- No Verify now applies to one operation: the next commit, continue, abort, pull, push, publish, or amend. It clears after that operation succeeds, or after a failure that leaves no merge, rebase, cherry-pick, or revert pending. Cancelled operations keep it.

### Fixed

- No Verify on rebase, cherry-pick, and revert continuations no longer disables post-commit and other non-verify hooks. Cherry-pick and revert continuations skip only pre-commit and commit-msg, as `git commit --no-verify` does.

## 1.1.13 — 2026-10-15

### Added

- Show a summary after Pull All and Fetch All with how many repositories finished and how many were skipped because they were busy.
- Show an error row for a repository that fails to load while the other repositories keep rendering.

### Changed

- No Verify now applies to one operation: the next commit, continue, pull, push, publish, or amend. It clears after that operation succeeds.
- Repositories appear as their data arrives, with renders throttled to at most one every 100 ms.
- The commit graph author lookup tries public GitHub data first and asks for sign-in only when that lookup fails.

### Fixed

- AI conflict resolution stages files the AI deleted, so the merge or rebase can continue.
- Commit messages no longer corrupt when multi-byte characters split across AI output chunks.
- A superseded refresh no longer overwrites newer repository data.
- Rebase, cherry-pick, revert, and merge continuations honor No Verify.
- Invalid reasoning-effort settings are no longer rewritten on activation.
- A slow Git operation in one repository no longer delays other repositories.
- Git directory lookups are cached during refresh; destructive operations still resolve them fresh.
- Large conflict sets no longer break Git operations.
- Accessibility labels for the commit message box, file rows, and graph resizer.

## 1.1.12 — 2026-10-12

### Fixed

- Render repository details and change groups ahead of expansion, keeping hidden rows ready so the first click only changes visibility.
- Reuse unchanged repository views during refreshes, preserving drafts, focus, and expansion choices.
- Avoid redundant repository refreshes when opening files or diffs.

## 1.1.11 — 2026-10-12

### Added

- Add Pull All Repositories beside Fetch All Repositories in the view header, using each repository's existing pull action and skipping repositories with an operation running.

## 1.1.10 — 2026-10-06

### Fixed

- Show full branch, remote, and tag names in commit graph pill tooltips.
- Give ref pills more room by reducing the author label to half its previous width, with the full author name in a tooltip.
- Reduce the initial tooltip delay to 500 ms.

## 1.1.9 — 2026-10-01

### Added

- Show the total changed-file count on the Better Source Control activity-bar icon, clearing the badge when all repositories are clean.

## 1.1.8 — 2026-10-01

### Changed

- Color filenames by Git state: deleted red, added and untracked green, modified yellow, and conflicted purple in tree, list, and commit details.

## 1.1.7 — 2026-10-01

### Fixed

- Deliver repository and file line counts when the built-in Git API returns fresh repository wrappers, instead of discarding every completed result as stale.

## 1.1.6 — 2026-10-01

### Fixed

- Keep repository and file line counts visible during refreshes, and prevent background counts from rewriting the Git index.
- Show per-file counts for modified files while omitting added, deleted, and untracked file counts. Repository totals include all changes.
- Make tree folders collapsible with mouse and keyboard controls, preserving their state across refreshes.

## 1.1.5 — 2026-10-01

### Changed

- Use installed image file-icon themes for file and folder icons, with generic icons as a fallback.
- Compact single-child folder paths and show changed-line counts immediately before the trailing Git status.
- Show untracked files as U and ignored files as I while preserving untracked-file diff behavior.

## 1.1.4 — 2026-10-01

### Changed

- Remove vertical indentation guides from repository details and the changes tree.

## 1.1.3 — 2026-10-01

### Fixed

- Align file and folder labels, arrows, and indentation guides in the changes tree, with compact 8 px indentation per level.

## 1.1.2 — 2026-09-28

### Added

- Copy Branch Name in each repository's actions menu copies the full current branch name.

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
