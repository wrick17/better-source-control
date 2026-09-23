'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { execGitCommand } = require('./git-operations');

const MAX_FILE_BYTES = 1024 * 1024;
const ZERO = { insertions: 0, deletions: 0 };

function parseNumstat(bytes) {
  const files = Object.create(null);
  const records = bytes.toString('utf8').split('\0');
  for (let i = 0; i < records.length - 1; i++) {
    const record = records[i];
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(record);
    if (!match) throw new Error('Invalid Git numstat output.');
    let name = match[3];
    if (!name) {
      if (!records[i + 1] || !records[i + 2]) throw new Error('Invalid Git rename output.');
      name = records[i + 2];
      i += 2;
    }
    if (!name || (match[1] === '-') !== (match[2] === '-')) {
      throw new Error('Invalid Git numstat output.');
    }
    files[name.split('/').join(path.sep)] = match[1] === '-'
      ? ZERO
      : { insertions: Number(match[1]), deletions: Number(match[2]) };
  }
  if (records.at(-1) !== '') throw new Error('Truncated Git numstat output.');
  return files;
}

async function countUntracked(filePath) {
  const entry = await fs.lstat(filePath);
  if (!entry.isFile() || entry.size > MAX_FILE_BYTES) return;
  const file = await fs.open(filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) return;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let lines = 0;
    let lastByte = 10;
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (!bytesRead) return;
      for (let i = 0; i < bytesRead; i++) {
        if (chunk[i] === 0) return ZERO;
        if (chunk[i] === 10) lines++;
      }
      lastByte = chunk[bytesRead - 1];
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return;
    return { insertions: lines + (position && lastByte !== 10 ? 1 : 0), deletions: 0 };
  } finally {
    await file.close();
  }
}

async function collectStats(repository, { gitPath } = {}) {
  const root = repository.rootUri.fsPath;
  const files = { staged: Object.create(null), unstaged: Object.create(null) };
  let incomplete = false;
  if (!gitPath) return { insertions: 0, deletions: 0, files, incomplete: true };

  for (const [kind, args] of [
    ['staged', ['diff', '--cached', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--']],
    ['unstaged', ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--']],
  ]) {
    try {
      const { stdout } = await execGitCommand(repository, gitPath, args, {
        encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
      });
      files[kind] = parseNumstat(stdout);
    } catch {
      incomplete = true;
    }
  }

  const untracked = new Map();
  for (const change of [
    ...(repository.state.untrackedChanges ?? []),
    ...(repository.state.workingTreeChanges ?? []),
    ...(repository.state.mergeChanges ?? []),
  ]) {
    if (change.status !== 7) continue;
    const relativePath = path.relative(root, change.uri.fsPath);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      incomplete = true;
      continue;
    }
    untracked.set(relativePath, change.uri.fsPath);
  }
  for (const [relativePath, filePath] of untracked) {
    try {
      const count = await countUntracked(filePath);
      if (count) files.unstaged[relativePath] = count;
      else incomplete = true;
    } catch {
      incomplete = true;
    }
  }

  let insertions = 0;
  let deletions = 0;
  for (const kind of ['staged', 'unstaged']) {
    for (const count of Object.values(files[kind])) {
      insertions += count.insertions;
      deletions += count.deletions;
    }
  }
  return { insertions, deletions, files, incomplete };
}

module.exports = { collectStats, parseNumstat };
