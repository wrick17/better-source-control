'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const {
  cleanOutput,
  cliArgs,
  effortOptions,
  modelOptions,
  normalizeModel,
} = require('../ai-commit');
Module._load = originalLoad;

test('builds provider-safe CLI arguments and cleans a generated subject', () => {
  assert.deepEqual(cliArgs('codex', 'gpt-5.6', 'high'), {
    command: 'codex',
    args: ['exec', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--model', 'gpt-5.6', '-c', 'model_reasoning_effort="high"', '-'],
  });
  assert.deepEqual(cliArgs('claude', 'sonnet', 'high').args.slice(-4), ['--model', 'sonnet', '--effort', 'high']);
  assert.equal(cleanOutput('```text\n"feat: generate commit messages"\n```'), 'feat: generate commit messages');
  assert.throws(() => cliArgs('codex', '', 'xhigh'), /does not support/);
});

test('filters models and effort levels by provider', () => {
  const values = (provider) => modelOptions(provider).map(([value]) => value);
  assert.deepEqual(values('claude'), ['', 'opus', 'sonnet', 'haiku']);
  assert.ok(values('codex').every((value) => !['opus', 'sonnet', 'haiku'].includes(value)));
  assert.equal(normalizeModel('claude', 'gpt-5.6'), '');
  assert.equal(normalizeModel('codex', 'sonnet'), '');
  assert.deepEqual(effortOptions('claude', 'sonnet'), ['low', 'medium', 'high']);
  assert.deepEqual(effortOptions('codex', 'gpt-5.6'), ['low', 'medium', 'high']);
});
