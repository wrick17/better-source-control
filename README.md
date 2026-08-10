# Git Change Stats

Shows one compact row per Git repository in a multi-root VS Code workspace:

```text
adminshell  (8* : +271 -32)  dev*
ai          (2* : +21 -3)    master*
```

Open **Source Control** and expand **Repository Change Stats**. The view refreshes when VS Code's built-in Git extension detects a status change; the refresh button forces an immediate update.

Tracked line totals come from VS Code's Git API. Untracked text files count as additions; untracked binary files count only toward changed files.

## Install locally

```sh
bun run package
code --install-extension git-change-stats-0.1.0.vsix
```

Reload VS Code after installation.

## Develop

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

```sh
bun test
```
