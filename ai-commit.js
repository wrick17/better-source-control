'use strict';

const { spawn } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const MAX_INPUT = 500_000;
const MAX_OUTPUT = 64_000;
const TIMEOUT_MS = 120_000;
const RESOLVE_TIMEOUT_MS = 600_000;
const MODELS = {
  codex: [
    ['', 'Provider default'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['gpt-5.6-terra', 'GPT-5.6 Terra'],
    ['gpt-5.6-luna', 'GPT-5.6 Luna'],
    ['gpt-5.5', 'GPT-5.5'],
    ['gpt-5.4', 'GPT-5.4'],
  ],
  claude: [
    ['', 'Provider default'],
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['haiku', 'Haiku'],
  ],
};
const EFFORTS = {
  codex: ['low', 'medium', 'high'],
  claude: ['low', 'medium', 'high'],
};
let log;

function setLog(value) {
  log = value;
}

function logApi(repository, method, ...args) {
  const values = args.map((value) => JSON.stringify(value)).join(', ');
  log?.info(`[${path.basename(repository.rootUri.fsPath)}] > Git API repository.${method}(${values})`);
}

async function generateCommitMessage(repository) {
  const configuration = vscode.workspace.getConfiguration('gitChangeStats');
  const { provider, model, effort } = aiSelection(configuration);
  let prompt;
  try {
    prompt = await buildPrompt(repository);
  } catch (error) {
    await vscode.window.showErrorMessage(
      `Commit message generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Generating commit message with ${provider === 'claude' ? 'Claude Code' : 'Codex'}`,
      cancellable: true,
    },
    async (_, token) => {
      try {
        return cleanOutput(await runCli(provider, model, effort, prompt, repository.rootUri.fsPath, token));
      } catch (error) {
        if (!token.isCancellationRequested) {
          await vscode.window.showErrorMessage(
            `Commit message generation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  );
}

async function resolveConflicts(repository) {
  const conflicts = [...new Map(repository.state.mergeChanges.map((change) => [
    change.uri.toString(),
    change,
  ])).values()];
  const files = conflicts.map((change) => path.relative(
    repository.rootUri.fsPath,
    change.uri.fsPath,
  ));
  if (!files.length) return true;

  const configuration = vscode.workspace.getConfiguration('gitChangeStats');
  const { provider, model, effort } = aiSelection(configuration, true);
  const prompt = [
    'Resolve every Git conflict in this repository.',
    'Read and follow any applicable AGENTS.md or CLAUDE.md instructions.',
    'Inspect the base, current, and incoming changes and preserve both sides\' intended behavior.',
    'Remove all conflict markers and finish any required file deletions. Do not stage files; Better Source Control will stage the resolved conflict paths after you finish.',
    'Do not commit, continue, skip, or abort the merge or rebase. Do not modify unrelated files.',
    `Conflicted paths:\n${files.map((file) => `- ${file}`).join('\n')}`,
  ].join('\n\n');

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Resolving conflicts with ${provider === 'claude' ? 'Claude Code' : 'Codex'}`,
      cancellable: true,
    },
    async (_, token) => {
      try {
        await runCli(provider, model, effort, prompt, repository.rootUri.fsPath, token, {
          writable: true,
          timeoutMs: RESOLVE_TIMEOUT_MS,
        });
        const resolved = [];
        for (const change of conflicts) {
          try {
            if (!hasConflictMarkers(await readFile(change.uri.fsPath))) resolved.push(change.uri.fsPath);
          } catch (error) {
            if (error?.code === 'ENOENT') resolved.push(change.uri.fsPath);
            else throw error;
          }
        }
        if (resolved.length) {
          logApi(repository, 'add', resolved);
          await repository.add(resolved);
        }
        logApi(repository, 'status');
        await repository.status();
        const remaining = repository.state.mergeChanges.length;
        if (remaining) {
          await vscode.window.showWarningMessage(
            `AI resolved some conflicts, but ${remaining} ${remaining === 1 ? 'file still has' : 'files still have'} conflicts.`,
          );
        }
        return remaining === 0;
      } catch (error) {
        logApi(repository, 'status');
        await repository.status().catch(() => {});
        if (!token.isCancellationRequested) {
          await vscode.window.showErrorMessage(
            `Conflict resolution failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return false;
      }
    },
  );
}

function hasConflictMarkers(bytes) {
  if (bytes.includes(0)) return false;
  return /^<<<<<<<(?: .*)?\r?\n[\s\S]*?^=======\r?\n[\s\S]*?^>>>>>>>(?: .*)?$/m.test(bytes.toString());
}

function modelOptions(provider) {
  return MODELS[provider] ?? MODELS.codex;
}

function effortOptions(provider, _model) {
  return EFFORTS[provider] ?? EFFORTS.codex;
}

function normalizeModel(provider, model) {
  const value = model?.trim() ?? '';
  return modelOptions(provider).some(([candidate]) => candidate === value) ? value : '';
}

function normalizeEffort(provider, model, effort) {
  return effortOptions(provider, model).includes(effort) ? effort : 'medium';
}

function aiSelection(configuration, conflict = false) {
  const provider = configuration.get('provider', 'codex');
  const model = normalizeModel(provider, configuration.get(conflict ? 'conflictModel' : 'model', ''));
  const effort = normalizeEffort(
    provider,
    model,
    configuration.get(conflict ? 'conflictReasoningEffort' : 'reasoningEffort', 'medium'),
  );
  return { provider, model, effort };
}

async function configureAI() {
  const configuration = vscode.workspace.getConfiguration('gitChangeStats');
  const control = await vscode.window.showQuickPick([
    { label: 'Provider', description: 'Shared by both AI actions', value: 'provider' },
    { label: 'Commit messages', description: 'Model and reasoning effort', value: 'commit' },
    { label: 'Conflict resolver', description: 'Model and reasoning effort', value: 'conflict' },
  ], { title: 'Better Source Control: Configure AI' });
  if (!control) return;

  const currentProvider = configuration.get('provider', 'codex');
  if (control.value === 'provider') {
    const provider = await vscode.window.showQuickPick([
      { label: 'Codex', value: 'codex', picked: currentProvider === 'codex' },
      { label: 'Claude Code', value: 'claude', picked: currentProvider === 'claude' },
    ], { title: 'Better Source Control: Shared Provider' });
    if (provider) {
      await configuration.update('provider', provider.value, vscode.ConfigurationTarget.Global);
    }
    return;
  }

  const conflict = control.value === 'conflict';
  const modelKey = conflict ? 'conflictModel' : 'model';
  const effortKey = conflict ? 'conflictReasoningEffort' : 'reasoningEffort';
  const title = conflict ? 'Conflict Resolver' : 'Commit Messages';
  const currentModel = normalizeModel(currentProvider, configuration.get(modelKey, ''));
  const model = await vscode.window.showQuickPick(
    modelOptions(currentProvider).map(([value, label]) => ({
      label,
      description: value || 'default',
      value,
      picked: value === currentModel,
    })),
    { title: `Better Source Control: ${title} Model` },
  );
  if (!model) return;

  const currentEffort = normalizeEffort(
    currentProvider,
    model.value,
    configuration.get(effortKey, 'medium'),
  );
  const effort = await vscode.window.showQuickPick(
    effortOptions(currentProvider, model.value).map((value) => ({
      label: value,
      value,
      picked: value === currentEffort,
    })),
    { title: `Better Source Control: ${title} Reasoning Effort` },
  );
  if (!effort) return;

  await configuration.update(modelKey, model.value, vscode.ConfigurationTarget.Global);
  await configuration.update(effortKey, effort.value, vscode.ConfigurationTarget.Global);
}

async function normalizeConfiguration() {
  const configuration = vscode.workspace.getConfiguration('gitChangeStats');
  const legacy = vscode.workspace.getConfiguration('gitChangeStats.ai');
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    const current = configuration.inspect(key);
    if ([current?.workspaceFolderValue, current?.workspaceValue, current?.globalValue]
      .some((value) => value !== undefined)) continue;
    const previous = legacy.inspect(key);
    const entry = [
      [previous?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
      [previous?.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [previous?.globalValue, vscode.ConfigurationTarget.Global],
    ].find(([value]) => value !== undefined);
    if (entry) {
      await configuration.update(key, entry[0], entry[1]);
      await legacy.update(key, undefined, entry[1]);
    }
  }
  for (const key of ['reasoningEffort', 'conflictReasoningEffort']) {
    if (['low', 'medium', 'high'].includes(configuration.get(key, 'medium'))) continue;
    const inspected = configuration.inspect(key);
    const target = inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await configuration.update(key, 'medium', target);
  }
}

async function buildPrompt(repository) {
  const staged = repository.state.indexChanges.length > 0;
  const changes = staged
    ? repository.state.indexChanges
    : [
        ...repository.state.mergeChanges,
        ...repository.state.workingTreeChanges,
        ...repository.state.untrackedChanges,
      ];
  const files = [...new Set(changes.map((change) => path.relative(
    repository.rootUri.fsPath,
    change.uri.fsPath,
  )))];
  if (!files.length) throw new Error('No changes are available for a commit message.');
  logApi(repository, 'diff', staged);
  const patch = await repository.diff(staged).catch(() => '');
  const context = `Files:\n${files.map((file) => `- ${file}`).join('\n')}\n\nPatch:\n${patch}`;
  const clipped = context.length > MAX_INPUT
    ? `${context.slice(0, MAX_INPUT)}\n\n[Diff truncated]`
    : context;

  return [
    'Generate one concise Git commit subject for the changes below.',
    'Use Conventional Commits when the change clearly fits one.',
    'Return only the subject line, with no quotes, markdown, explanation, or trailing period.',
    clipped,
  ].join('\n\n');
}

function cliArgs(provider, model, effort, writable = false) {
  if (provider === 'claude') {
    if (!['low', 'medium', 'high'].includes(effort)) {
      throw new Error(`Claude Code does not support ${effort} effort.`);
    }
    return {
      command: 'claude',
      args: [
        '-p',
        '--output-format', 'text',
        '--safe-mode',
        '--no-session-persistence',
        '--no-chrome',
        ...(writable
          ? [
              '--permission-mode', 'dontAsk',
              '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
              '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(git *)',
            ]
          : ['--tools', '']),
        '--disallowedTools', 'mcp__*',
        ...(model ? ['--model', model] : []),
        '--effort', effort,
      ],
    };
  }
  if (provider !== 'codex') throw new Error(`Unknown provider: ${provider}`);
  if (!['low', 'medium', 'high'].includes(effort)) {
    throw new Error(`Codex does not support ${effort} reasoning effort.`);
  }
  return {
    command: 'codex',
    args: [
      ...(writable ? ['--ask-for-approval', 'never'] : []),
      'exec',
      '--ephemeral',
      '--sandbox', writable ? 'workspace-write' : 'read-only',
      '--color', 'never',
      ...(model ? ['--model', model] : []),
      '-c', `model_reasoning_effort="${effort}"`,
      '-',
    ],
  };
}

function runCli(provider, model, effort, prompt, cwd, token, {
  writable = false,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const { command, args } = cliArgs(provider, model, effort, writable);
  const invocation = [command, ...args].map((value) => JSON.stringify(value)).join(' ');
  log?.info(`[${path.basename(cwd)}] > spawn ${invocation}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer;
    const timeout = setTimeout(() => stop(new Error('The selected CLI timed out.')), timeoutMs);
    const cancellation = token.onCancellationRequested(() => stop(new Error('Generation cancelled.')));

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      cancellation.dispose();
      callback(value);
    }

    function stop(error) {
      if (settled) return;
      child.kill('SIGTERM');
      finish(reject, error);
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref?.();
    }

    child.on('error', (error) => finish(
      reject,
      error.code === 'ENOENT'
        ? new Error(`${command} was not found on VS Code's PATH.`)
        : error,
    ));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) stop(new Error('The selected CLI returned too much output.'));
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on('close', (code) => {
      if (code === 0) finish(resolve, stdout);
      else finish(reject, new Error(stderr.trim().split(/\r?\n/).pop() || `${command} exited with code ${code}.`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function cleanOutput(output) {
  const value = output
    .trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()
    .replace(/^["'`](.*)["'`]$/, '$1');
  if (!value) throw new Error('The selected CLI returned an empty message.');
  return value.slice(0, 500);
}

module.exports = {
  aiSelection,
  cleanOutput,
  cliArgs,
  configureAI,
  effortOptions,
  generateCommitMessage,
  hasConflictMarkers,
  modelOptions,
  normalizeEffort,
  normalizeConfiguration,
  normalizeModel,
  resolveConflicts,
  setLog,
};
