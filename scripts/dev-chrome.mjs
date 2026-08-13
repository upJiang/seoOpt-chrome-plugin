import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const profileDirectory = resolve(projectRoot, '.chrome-dev-profile');
const lockPath = resolve(profileDirectory, 'seo-opt-wxt.lock');
const wxtBinary = resolve(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wxt.cmd' : 'wxt');
const manualChrome = process.env.SEO_OPT_MANUAL_CHROME === '1';

mkdirSync(profileDirectory, { recursive: true });

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwnerPid() {
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    return Number(lock.pid);
  } catch {
    return null;
  }
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function stopExistingService() {
  const ownerPid = readOwnerPid();
  if (!ownerPid || !processIsRunning(ownerPid)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // There is no active lock to remove.
    }
    console.log('\n没有正在运行的 SEO优化开发服务。\n');
    return;
  }

  process.kill(ownerPid, 'SIGTERM');
  for (let attempt = 0; attempt < 50 && processIsRunning(ownerPid); attempt += 1) {
    await delay(100);
  }
  if (processIsRunning(ownerPid)) throw new Error(`开发服务 PID ${ownerPid} 未能在 5 秒内停止。`);
  console.log(`\n已停止 SEO优化开发服务（PID ${ownerPid}）。\n`);
}

function acquireLock() {
  try {
    const descriptor = openSync(lockPath, 'wx');
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(descriptor);
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const ownerPid = readOwnerPid();
    if (ownerPid && processIsRunning(ownerPid)) {
      console.log(`\nSEO优化开发服务已在运行（PID ${ownerPid}）。`);
      console.log('直接使用已加载开发扩展的 Chrome；保存代码后会自动更新。');
      console.log(`需要接管时运行 npm run ${manualChrome ? 'dev:chrome:manual:restart' : 'dev:chrome:restart'}，停止时运行 npm run dev:chrome:stop。\n`);
      return false;
    }
    unlinkSync(lockPath);
    return acquireLock();
  }
}

const command = process.argv[2];
if (command === '--stop') {
  await stopExistingService();
  process.exit(0);
}
if (command === '--restart') await stopExistingService();
if (!acquireLock()) process.exit(0);

let cleaned = false;
function releaseLock() {
  if (cleaned) return;
  cleaned = true;
  try {
    if (readOwnerPid() === process.pid) unlinkSync(lockPath);
  } catch {
    // A stale lock is removed automatically on the next start.
  }
}

const args = ['-b', 'chrome'];
if (process.env.SEO_OPT_WXT_DEBUG === '1') args.push('--debug');

const child = spawn(wxtBinary, args, {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  });
}

child.on('error', (error) => {
  releaseLock();
  console.error(`无法启动 WXT：${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  releaseLock();
  process.exitCode = code ?? (signal ? 0 : 1);
});

process.on('exit', releaseLock);
