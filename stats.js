'use strict';

function countTextLines(bytes) {
  if (!bytes.length || bytes.includes(0)) return 0;

  let lines = bytes[bytes.length - 1] === 10 ? 0 : 1;
  for (const byte of bytes) if (byte === 10) lines++;
  return lines;
}

function changedFileCount(state) {
  const uris = new Set();
  for (const group of [
    state.mergeChanges,
    state.indexChanges,
    state.workingTreeChanges,
    state.untrackedChanges,
  ]) {
    for (const change of group ?? []) uris.add(change.uri.toString());
  }
  return uris.size;
}

function formatDescription(files, insertions, deletions, branch) {
  const dirty = files > 0 ? '*' : '';
  return `(${files}${dirty} : +${insertions} -${deletions})  ${branch}${dirty}`;
}

module.exports = { changedFileCount, countTextLines, formatDescription };
