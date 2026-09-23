'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const load = Module._load;
let collectStats;
let parseNumstat;
try {
  Module._load = (request, parent, isMain) => request === 'vscode'
    ? {}
    : load(request, parent, isMain);
  ({ collectStats, parseNumstat } = require('../repository-stats'));
} finally {
  Module._load = load;
}

test('parses NUL-separated paths and takes the destination of a rename', () => {
  const files = parseNumstat(Buffer.from('2\t1\tfile\tname.txt\0' +
    '0\t0\t\0old.txt\0new.txt\0' + '-\t-\tbinary.dat\0'));
  assert.deepEqual(files['file\tname.txt'], { insertions: 2, deletions: 1 });
  assert.deepEqual(files['new.txt'], { insertions: 0, deletions: 0 });
  assert.equal(files['old.txt'], undefined);
  assert.deepEqual(files['binary.dat'], { insertions: 0, deletions: 0 });
  assert.throws(() => parseNumstat(Buffer.from('1\t0\tmissing-terminator')));
});

test('collects staged, unstaged and untracked counts in two Git diffs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-stats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  const write = (name, value) => fs.writeFileSync(path.join(root, name), value);
  const change = (name, status) => ({ status, uri: { fsPath: path.join(root, name) } });

  git('init', '-q');
  write('tracked.txt', 'base\n');
  write('old.txt', 'rename\n');
  write('binary.dat', Buffer.from([0, 1, 2]));
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');

  write('tracked.txt', 'base\nstaged\n');
  write('binary.dat', Buffer.from([0, 1, 2, 3]));
  fs.renameSync(path.join(root, 'old.txt'), path.join(root, 'new.txt'));
  git('add', '-A');
  write('tracked.txt', 'base\nstaged\nunstaged\n');
  write('untracked.txt', 'one\ntwo');
  write('untracked.bin', Buffer.from([0, 1, 2]));
  write('separate.txt', 'alone\n');
  write('intent.txt', 'intent\n');
  git('add', '-N', 'intent.txt');

  const untracked = [
    change('untracked.txt', 7),
    change('untracked.bin', 7),
    change('separate.txt', 7),
  ];
  const repository = {
    rootUri: { fsPath: root },
    state: {
      indexChanges: [change('tracked.txt', 0), change('new.txt', 3), change('binary.dat', 0)],
      workingTreeChanges: [change('tracked.txt', 5), change('intent.txt', 9), untracked[0], untracked[1]],
      untrackedChanges: [untracked[0], untracked[2]],
      mergeChanges: [],
    },
  };

  const stats = await collectStats(repository, { gitPath: 'git' });
  assert.equal(stats.incomplete, false);
  assert.equal(stats.insertions, 6);
  assert.equal(stats.deletions, 0);
  assert.deepEqual(stats.files.staged['tracked.txt'], { insertions: 1, deletions: 0 });
  assert.deepEqual(stats.files.staged['new.txt'], { insertions: 0, deletions: 0 });
  assert.deepEqual(stats.files.staged['binary.dat'], { insertions: 0, deletions: 0 });
  assert.deepEqual(stats.files.unstaged['tracked.txt'], { insertions: 1, deletions: 0 });
  assert.deepEqual(stats.files.unstaged['intent.txt'], { insertions: 1, deletions: 0 });
  assert.deepEqual(stats.files.unstaged['untracked.txt'], { insertions: 2, deletions: 0 });
  assert.deepEqual(stats.files.unstaged['untracked.bin'], { insertions: 0, deletions: 0 });
  assert.deepEqual(stats.files.unstaged['separate.txt'], { insertions: 1, deletions: 0 });

  write('too-large.txt', 'x'.repeat(1024 * 1024 + 1));
  fs.symlinkSync('tracked.txt', path.join(root, 'link.txt'));
  repository.state.untrackedChanges = [change('too-large.txt', 7), change('link.txt', 7)];
  repository.state.workingTreeChanges = [change('tracked.txt', 5), change('intent.txt', 9), change('too-large.txt', 7)];
  const partial = await collectStats(repository, { gitPath: 'git' });
  assert.equal(partial.incomplete, true);
  assert.equal(partial.files.unstaged['too-large.txt'], undefined);
  assert.equal(partial.files.unstaged['link.txt'], undefined);
  assert.equal(partial.insertions, 3);

  const unavailable = await collectStats(repository, { gitPath: '/missing/git' });
  assert.equal(unavailable.incomplete, true);
  assert.equal(unavailable.files.staged['tracked.txt'], undefined);
});
