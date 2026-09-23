'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const {
  aiSelection,
  cleanOutput,
  cliArgs,
  effortOptions,
  hasConflictMarkers,
  modelOptions,
  normalizeModel,
} = require('../ai-commit');
Module._load = originalLoad;

test('builds provider-safe CLI arguments and cleans a generated subject', () => {
  assert.deepEqual(cliArgs('codex', 'gpt-5.6-sol', 'high'), {
    command: 'codex',
    args: ['exec', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', '-'],
  });
  assert.deepEqual(cliArgs('claude', 'sonnet', 'high').args.slice(-4), ['--model', 'sonnet', '--effort', 'high']);
  assert.deepEqual(
    cliArgs('codex', 'gpt-5.6-sol', 'high', true).args.slice(0, 9),
    ['--ask-for-approval', 'never', 'exec', '--ephemeral', '--sandbox', 'workspace-write', '--color', 'never', '--model'],
  );
  const writableClaude = cliArgs('claude', 'sonnet', 'high', true).args;
  assert.ok(writableClaude.includes('--restricted'));
  assert.ok(writableClaude.includes('dontAsk'));
  assert.ok(writableClaude.includes('Read,Edit,Write,Glob,Grep,Bash'));
  assert.ok(!writableClaude.some((arg) => arg.includes('Bash(git *)')));
  assert.equal(hasConflictMarkers(Buffer.from('<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n')), true);
  assert.equal(hasConflictMarkers(Buffer.from('heading\n=======\ncontent\n')), false);
  assert.equal(cleanOutput('```text\n"feat: generate commit messages"\n```'), 'feat: generate commit messages');
  assert.throws(() => cliArgs('codex', '', 'xhigh'), /does not support/);
});

test('filters models and effort levels by provider', () => {
  const values = (provider) => modelOptions(provider).map(([value]) => value);
  assert.deepEqual(values('claude'), ['', 'opus', 'sonnet', 'haiku']);
  assert.ok(values('codex').every((value) => !['opus', 'sonnet', 'haiku'].includes(value)));
  assert.equal(normalizeModel('claude', 'claude-custom-1'), 'claude-custom-1');
  assert.equal(normalizeModel('codex', ' gpt-custom-1 '), 'gpt-custom-1');
  assert.deepEqual(cliArgs('codex', 'gpt-custom-1', 'medium').args.slice(-5),
    ['--model', 'gpt-custom-1', '-c', 'model_reasoning_effort="medium"', '-']);
  assert.deepEqual(effortOptions('claude', 'sonnet'), ['low', 'medium', 'high']);
  assert.deepEqual(effortOptions('codex', 'gpt-5.6-sol'), ['low', 'medium', 'high']);
});

function loadWithCli(vscode, spawn) {
  const filename = require.resolve('../ai-commit');
  delete require.cache[filename];
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'node:child_process') return { spawn };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(filename);
  } finally {
    Module._load = originalLoad;
  }
}

function fakeCli(onPrompt) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  child.stdin = {
    on() {},
    end(prompt) {
      queueMicrotask(async () => {
        try {
          await onPrompt(prompt);
          child.emit('close', 0);
        } catch (error) {
          child.emit('error', error);
        }
      });
    },
  };
  return child;
}

function fakeVscode({ warning = () => undefined, error = () => undefined,
  includeUntrackedContent = false } = {}) {
  return {
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'includeUntrackedContent'
      ? includeUntrackedContent : fallback }) },
    window: {
      withProgress: (_options, callback) => callback(undefined, {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      }),
      showWarningMessage: warning,
      showErrorMessage: error,
    },
    ProgressLocation: { Notification: 1 },
  };
}

test('only stages changed, resolved text conflicts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-ai-'));
  try {
    const file = path.join(root, 'case.txt');
    const uri = { fsPath: file, toString: () => `file://${file}` };
    const change = { uri };
    const state = { mergeChanges: [change], HEAD: { commit: 'abc', name: 'main' } };
    const added = [];
    const repository = {
      rootUri: { fsPath: root },
      state,
      status: async () => {},
      add: async (paths) => { added.push(...paths); state.mergeChanges = []; },
    };
    const pendingWarning = () => new Promise(() => {});
    const marked = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> incoming\n';
    const scenarios = [
      { name: 'unchanged binary', before: Buffer.from([0, 1]), after: null, stages: false },
      { name: 'missing delete conflict', before: null, after: null, stages: false },
      { name: 'resolved text', before: marked, after: 'combined\n', stages: true },
      { name: 'partial marker', before: marked, after: '<<<<<<< leftover\ncombined\n', stages: false },
      { name: 'unchanged text', before: marked, after: null, stages: false },
    ];
    for (const scenario of scenarios) {
      state.mergeChanges = [change];
      added.length = 0;
      if (scenario.before === null) await fs.rm(file, { force: true });
      else await fs.writeFile(file, scenario.before);
      const child = fakeCli(async () => {
        if (scenario.after !== null) await fs.writeFile(file, scenario.after);
      });
      const ai = loadWithCli(fakeVscode({ warning: pendingWarning }), () => child);
      const result = await ai.resolveConflicts(repository);
      assert.equal(result, scenario.stages, scenario.name);
      assert.deepEqual(added, scenario.stages ? [file] : [], scenario.name);
    }

    state.mergeChanges = [change];
    added.length = 0;
    await fs.writeFile(file, marked);
    const target = path.join(root, 'outside.txt');
    await fs.writeFile(target, 'combined\n');
    const child = fakeCli(async () => {
      await fs.rm(file);
      await fs.symlink(target, file);
    });
    const ai = loadWithCli(fakeVscode({ warning: pendingWarning }), () => child);
    assert.equal(await ai.resolveConflicts(repository), false);
    assert.deepEqual(added, []);

    state.mergeChanges = [change];
    added.length = 0;
    await fs.rm(file);
    await fs.writeFile(file, marked);
    const changedHead = fakeCli(async () => {
      await fs.writeFile(file, 'combined\n');
      state.HEAD.commit = 'def';
    });
    const guardedAi = loadWithCli(fakeVscode(), () => changedHead);
    assert.equal(await guardedAi.resolveConflicts(repository), false);
    assert.deepEqual(added, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cancellation stops the process group and waits for exit', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-ai-'));
  try {
    const file = path.join(root, 'case.txt');
    await fs.writeFile(file, '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> incoming\n');
    const change = { uri: { fsPath: file, toString: () => `file://${file}` } };
    let cancel;
    let cancelled = false;
    let launched;
    const started = new Promise((resolve) => { launched = resolve; });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on() {}, end() { launched(); } };
    child.pid = 43210;
    child.kill = () => assert.fail('child-only kill must not be used');
    const kills = [];
    const originalKill = process.kill;
    process.kill = (pid, signal) => { kills.push([pid, signal]); return true; };
    const vscode = fakeVscode();
    vscode.window.withProgress = (_options, callback) => callback(undefined, {
      get isCancellationRequested() { return cancelled; },
      onCancellationRequested: (handler) => { cancel = handler; return { dispose() {} }; },
    });
    let spawnOptions;
    const ai = loadWithCli(vscode, (_command, _args, options) => {
      spawnOptions = options;
      return child;
    });
    let statusCount = 0;
    const repository = {
      rootUri: { fsPath: root },
      state: { mergeChanges: [change], HEAD: { commit: 'abc', name: 'main' } },
      status: async () => { statusCount += 1; },
      add: async () => assert.fail('cancellation must not stage'),
    };
    try {
      let settled = false;
      const result = ai.resolveConflicts(repository).then((value) => { settled = true; return value; });
      await started;
      cancelled = true;
      cancel();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(statusCount, 1);
      assert.equal(spawnOptions.detached, true);
      assert.deepEqual(kills, [[-43210, 'SIGTERM']]);
      child.emit('close', null);
      assert.equal(await result, false);
      assert.equal(statusCount, 2);
      assert.deepEqual(kills, [[-43210, 'SIGTERM'], [-43210, 'SIGKILL']]);
    } finally {
      process.kill = originalKill;
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('untracked content is opt-in and bounded; diff failure is reported', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bsc-ai-'));
  try {
    const file = path.join(root, 'new.txt');
    await fs.writeFile(file, `useful text\n${'x'.repeat(20_000)}\nTAIL`);
    const change = { status: 7, uri: { fsPath: file, toString: () => `file://${file}` } };
    const repository = {
      rootUri: { fsPath: root },
      state: { indexChanges: [], mergeChanges: [], workingTreeChanges: [change], untrackedChanges: [] },
      diff: async () => '',
    };
    let prompt;
    const child = fakeCli(async (value) => {
      prompt = value;
      child.stdout.emit('data', 'feat: add useful text');
    });
    const defaultAi = loadWithCli(fakeVscode(), () => child);
    assert.equal(await defaultAi.generateCommitMessage(repository), 'feat: add useful text');
    assert.match(prompt, /Files:\n- new\.txt/);
    assert.doesNotMatch(prompt, /useful text/);

    const optedInAi = loadWithCli(fakeVscode({ includeUntrackedContent: true }), () => child);
    assert.equal(await optedInAi.generateCommitMessage(repository), 'feat: add useful text');
    assert.match(prompt, /Untracked new\.txt:\nuseful text/);
    assert.doesNotMatch(prompt, /TAIL/);
    assert.ok(prompt.length < 9_000);

    repository.state.indexChanges = [change];
    repository.diff = async (staged) => {
      assert.equal(staged, true);
      return 'diff --git a/new.txt b/new.txt\n+staged content';
    };
    assert.equal(await optedInAi.generateCommitMessage(repository), 'feat: add useful text');
    assert.match(prompt, /\+staged content/);
    assert.doesNotMatch(prompt, /Untracked new\.txt/);

    let notification;
    repository.diff = async () => { throw new Error('diff failed'); };
    const failedAi = loadWithCli(fakeVscode({
      error: (message) => { notification = message; return new Promise(() => {}); },
    }), () => assert.fail('diff failure must not spawn AI'));
    assert.equal(await failedAi.generateCommitMessage(repository), undefined);
    assert.match(notification, /diff failed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('keeps commit and conflict model controls separate', () => {
  const values = {
    provider: 'codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'low',
    conflictModel: 'gpt-5.6-sol',
    conflictReasoningEffort: 'high',
  };
  const configuration = { get: (key, fallback) => values[key] ?? fallback };

  assert.deepEqual(aiSelection(configuration), {
    provider: 'codex', model: 'gpt-5.6-luna', effort: 'low',
  });
  assert.deepEqual(aiSelection(configuration, true), {
    provider: 'codex', model: 'gpt-5.6-sol', effort: 'high',
  });
});
