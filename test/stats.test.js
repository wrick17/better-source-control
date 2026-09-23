'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const {
  buildFileTree,
  changedFileCount,
  countTextLines,
  formatChangeStats,
  formatDescription,
  statusBadge,
} = require('../stats');

test('counts and formats repository changes', () => {
  const uri = (value) => ({ toString: () => value });
  const state = {
    indexChanges: [{ uri: uri('file:///a') }],
    workingTreeChanges: [{ uri: uri('file:///a') }, { uri: uri('file:///b') }],
    untrackedChanges: [{ uri: uri('file:///c') }],
  };

  assert.equal(changedFileCount(state), 3);
  assert.equal(countTextLines(Buffer.from('one\ntwo\n')), 2);
  assert.equal(countTextLines(Buffer.from([0, 1, 2])), 0);
  assert.equal(formatDescription(3, 21, 4, 'dev'), '(3* : +21 -4)  dev*');
  assert.equal(formatChangeStats(3, 21, 4), '3 +21 -4');
  assert.equal(formatChangeStats(0, 0, 0), '');
});

test('maps Git statuses and builds a sorted file tree', () => {
  assert.equal(statusBadge(1), 'A');
  assert.equal(statusBadge(6), 'D');
  assert.equal(statusBadge(5), 'M');
  assert.equal(statusBadge(18), '!');

  const files = [
    { type: 'file', name: 'z.js', relativePath: path.join('src', 'z.js') },
    { type: 'file', name: 'a.js', relativePath: path.join('src', 'components', 'a.js') },
    { type: 'file', name: 'README.md', relativePath: 'README.md' },
  ];
  const tree = buildFileTree(files);

  assert.deepEqual(tree.map((node) => node.name), ['src', 'README.md']);
  assert.deepEqual(tree[0].children.map((node) => node.name), ['components', 'z.js']);
});
