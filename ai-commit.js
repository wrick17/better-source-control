'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const MAX_INPUT = 500_000;
const MAX_OUTPUT = 64_000;
const TIMEOUT_MS = 120_000;
const MODELS = {
  codex: [
    ['', 'Provider default'],
    ['gpt-5.6', 'GPT-5.6 Sol'],
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

async function generateCommitMessage(repository) {
  const configuration = vscode.workspace.getConfiguration('gitChangeStats');
  const provider = configuration.get('provider', 'codex');
  const model = normalizeModel(provider, configuration.get('model', ''));
  const effort = normalizeEffort(provider, model, configuration.get('reasoningEffort', 'medium'));
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

async function configureAI() {
  const configuration = vscode.workspace.getConfiguration('gitChangeStats');
  const currentProvider = configuration.get('provider', 'codex');
  const provider = await vscode.window.showQuickPick([
    { label: 'Codex', value: 'codex', picked: currentProvider === 'codex' },
    { label: 'Claude Code', value: 'claude', picked: currentProvider === 'claude' },
  ], { title: 'Better Source Control: Provider' });
  if (!provider) return;

  const currentModel = normalizeModel(provider.value, configuration.get('model', ''));
  const model = await vscode.window.showQuickPick(
    modelOptions(provider.value).map(([value, label]) => ({
      label,
      description: value || 'default',
      value,
      picked: value === currentModel,
    })),
    { title: 'Better Source Control: Model' },
  );
  if (!model) return;

  const currentEffort = normalizeEffort(
    provider.value,
    model.value,
    configuration.get('reasoningEffort', 'medium'),
  );
  const effort = await vscode.window.showQuickPick(
    effortOptions(provider.value, model.value).map((value) => ({
      label: value,
      value,
      picked: value === currentEffort,
    })),
    { title: 'Better Source Control: Reasoning Effort' },
  );
  if (!effort) return;

  await configuration.update('provider', provider.value, vscode.ConfigurationTarget.Global);
  await configuration.update('model', model.value, vscode.ConfigurationTarget.Global);
  await configuration.update('reasoningEffort', effort.value, vscode.ConfigurationTarget.Global);
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
  const effort = configuration.get('reasoningEffort', 'medium');
  if (['low', 'medium', 'high'].includes(effort)) return;
  const inspected = configuration.inspect('reasoningEffort');
  const target = inspected?.workspaceFolderValue !== undefined
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : inspected?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await configuration.update('reasoningEffort', 'medium', target);
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

function cliArgs(provider, model, effort) {
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
        '--tools', '',
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
      'exec',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--color', 'never',
      ...(model ? ['--model', model] : []),
      '-c', `model_reasoning_effort="${effort}"`,
      '-',
    ],
  };
}

function runCli(provider, model, effort, prompt, cwd, token) {
  const { command, args } = cliArgs(provider, model, effort);
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
    const timeout = setTimeout(() => stop(new Error('The selected CLI timed out.')), TIMEOUT_MS);
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
  cleanOutput,
  cliArgs,
  configureAI,
  effortOptions,
  generateCommitMessage,
  modelOptions,
  normalizeEffort,
  normalizeConfiguration,
  normalizeModel,
};
