'use strict';

function layoutGraph(commits) {
  const lanes = [];
  let nextColor = 0;
  const color = () => {
    const value = nextColor;
    nextColor = nextColor === 5 ? 1 : nextColor + 1;
    return value;
  };

  return commits.map((commit) => {
    const input = lanes.map((node) => ({ ...node }));
    const output = [];
    const parents = commit.parents ?? [];
    let firstParentAdded = false;
    for (const node of input) {
      if (node.hash === commit.hash) {
        if (parents.length && !firstParentAdded) {
          output.push({ hash: parents[0], color: node.color });
          firstParentAdded = true;
        }
      } else {
        output.push({ ...node });
      }
    }
    if (parents.length) {
      for (let index = firstParentAdded ? 1 : 0; index < parents.length; index++) {
        output.push({ hash: parents[index], color: color() });
      }
    }
    lanes.splice(0, lanes.length, ...output);
    const inputIndex = input.findIndex((node) => node.hash === commit.hash);
    const lane = inputIndex === -1 ? input.length : inputIndex;
    const commitColor = input[lane]?.color ?? output[lane]?.color ?? color();
    return {
      ...commit,
      lane,
      color: commitColor,
      input,
      output,
      laneCount: Math.max(input.length, output.length, 1),
    };
  });
}

function markRollbackTargets(commits, head) {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const ancestors = new Set();
  const pending = [head];
  while (pending.length) {
    const hash = pending.pop();
    if (!hash || ancestors.has(hash)) continue;
    ancestors.add(hash);
    pending.push(...(byHash.get(hash)?.parents ?? []));
  }
  return commits.map((commit) => ({
    ...commit,
    canRollback: commit.hash !== head && ancestors.has(commit.hash),
  }));
}

module.exports = { layoutGraph, markRollbackTargets };
