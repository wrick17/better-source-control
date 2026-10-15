'use strict';

const path = require('node:path');

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

function formatChangeStats(files, insertions, deletions) {
  return files ? `${files} +${insertions} -${deletions}` : '';
}

function statusBadge(status) {
  if (status >= 12 && status <= 18) return '!';
  if (status === 7) return 'U';
  if (status === 8) return 'I';
  if ([1, 9].includes(status)) return 'A';
  if ([2, 6].includes(status)) return 'D';
  if ([3, 10].includes(status)) return 'R';
  if (status === 4) return 'C';
  return 'M';
}

function buildFileTree(files) {
  const root = [];

  for (const file of files) {
    const parts = file.relativePath.split(path.sep);
    let children = root;
    let relativePath = '';

    for (const name of parts.slice(0, -1)) {
      relativePath = path.join(relativePath, name);
      let folder = children.find((node) => node.type === 'folder' && node.name === name);
      if (!folder) {
        folder = { type: 'folder', name, relativePath, children: [] };
        children.push(folder);
      }
      children = folder.children;
    }
    children.push(file);
  }

  const sort = (nodes) => nodes
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
    .map((node) => node.type === 'folder' ? { ...node, children: sort(node.children) } : node);
  return sort(root);
}

module.exports = {
  buildFileTree,
  changedFileCount,
  formatChangeStats,
  statusBadge,
};
