'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { layoutGraph, markRollbackTargets } = require('../graph');

test('keeps colored merge lanes separate until their parent commit', () => {
  const rows = layoutGraph([
    { hash: 'a', parents: ['b', 'c'] },
    { hash: 'b', parents: ['d'] },
    { hash: 'c', parents: ['d'] },
    { hash: 'd', parents: [] },
  ]);

  assert.deepEqual(rows.map(({ lane, color, input, output }) => ({ lane, color, input, output })), [
    { lane: 0, color: 0, input: [], output: [{ hash: 'b', color: 0 }, { hash: 'c', color: 1 }] },
    { lane: 0, color: 0, input: [{ hash: 'b', color: 0 }, { hash: 'c', color: 1 }], output: [{ hash: 'd', color: 0 }, { hash: 'c', color: 1 }] },
    { lane: 1, color: 1, input: [{ hash: 'd', color: 0 }, { hash: 'c', color: 1 }], output: [{ hash: 'd', color: 0 }, { hash: 'd', color: 1 }] },
    { lane: 0, color: 0, input: [{ hash: 'd', color: 0 }, { hash: 'd', color: 1 }], output: [] },
  ]);
});

test('only marks loaded ancestors of HEAD as rollback targets', () => {
  const commits = markRollbackTargets([
    { hash: 'head', parents: ['parent'] },
    { hash: 'parent', parents: ['root'] },
    { hash: 'root', parents: [] },
    { hash: 'other', parents: [] },
  ], 'head');

  assert.deepEqual(
    commits.map(({ hash, canRollback }) => [hash, canRollback]),
    [['head', false], ['parent', true], ['root', true], ['other', false]],
  );
});
