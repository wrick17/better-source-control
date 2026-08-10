'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { changedFileCount, countTextLines, formatDescription } = require('../stats');

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
});
