'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extension = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'bsc-host-'));
const repository = path.join(temporary, 'repo');
const userData = path.join(temporary, 'user-data');

function hostProcessGroups() {
  if (process.platform === 'win32') return [];
  const processes = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8' });
  return [...new Set(processes.split('\n').filter((line) =>
    line.includes(`--user-data-dir=${userData}`) || line.includes(`--user-data-dir ${userData}`),
  ).map((line) => Number(line.trim().split(/\s+/)[1])))];
}

function stopHost(child, signal) {
  for (const group of hostProcessGroups()) {
    try { process.kill(-group, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* Already exited. */ }
  } else {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

function git(...args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

async function main() {
  fs.mkdirSync(repository);
  git('init', '-q');
  git('config', 'user.name', 'Smoke Test');
  git('config', 'user.email', 'smoke@example.invalid');
  fs.writeFileSync(path.join(repository, 'sample.txt'), 'before\n');
  git('add', 'sample.txt');
  git('commit', '-qm', 'Initial commit');

  const executable = process.env.CODE_EXECUTABLE || 'code';
  const args = [
    '--new-window',
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(temporary, 'extensions')}`,
    `--extensionDevelopmentPath=${extension}`,
    `--extensionTestsPath=${path.join(extension, 'test-host', 'smoke.js')}`,
    '--disable-telemetry',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--wait',
    repository,
  ];
  const child = spawn(executable, args, {
    env: {
      ...process.env,
      BSC_SMOKE_REPO: repository,
      BSC_SMOKE_INITIAL_HEAD: git('rev-parse', 'HEAD'),
      BSC_SMOKE_RESULT: path.join(temporary, 'passed'),
    },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    stopHost(child, 'SIGTERM');
  }, 120_000);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (timedOut) throw new Error('VS Code test host timed out');
    if (signal) throw new Error(`VS Code test host ended with ${signal}`);
    if (code !== 0) throw new Error(`VS Code test host exited with ${code}`);
    if (!fs.existsSync(path.join(temporary, 'passed'))) throw new Error('VS Code exited before the smoke test passed');
    for (let attempt = 0; attempt < 20 && hostProcessGroups().length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (hostProcessGroups().length) throw new Error('VS Code test host left a process running');
    console.log('Extension-host smoke passed.');
  } finally {
    clearTimeout(timeout);
    if (hostProcessGroups().length) {
      stopHost(child, 'SIGKILL');
      for (let attempt = 0; attempt < 20 && hostProcessGroups().length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
