import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const productName = manifest.build?.productName ?? manifest.productName ?? manifest.name;
const releaseRoot = path.resolve(projectRoot, manifest.build?.directories?.output ?? 'release');
const platform = process.platform;
const architecture = process.arch;
const marker = 'OVERHULL_SMOKE_OK';
const timeoutMs = 60_000;

async function findExecutable() {
  let candidates;
  if (platform === 'win32') {
    const folder = architecture === 'x64' ? 'win-unpacked' : `win-${architecture}-unpacked`;
    const name = manifest.build?.win?.executableName ?? manifest.build?.executableName ?? productName;
    candidates = [path.join(folder, `${name}.exe`)];
  } else if (platform === 'darwin') {
    const folder = architecture === 'x64' ? 'mac' : `mac-${architecture}`;
    candidates = [folder, 'mac-universal'].map((directory) =>
      path.join(directory, `${productName}.app`, 'Contents', 'MacOS', productName),
    );
  } else if (platform === 'linux') {
    const folder = architecture === 'x64' ? 'linux-unpacked' : `linux-${architecture}-unpacked`;
    const name =
      manifest.build?.linux?.executableName ?? manifest.build?.executableName ?? manifest.name.toLowerCase();
    candidates = [path.join(folder, name)];
  } else {
    throw new Error(`Packaged smoke tests do not support ${platform}/${architecture}.`);
  }
  for (const candidate of candidates) {
    const executable = path.resolve(releaseRoot, candidate);
    if ((await fs.stat(executable).catch(() => undefined))?.isFile()) return executable;
  }
  throw new Error(
    `No native unpacked app found for ${platform}/${architecture}. Run pnpm package:dir first. Expected: ${candidates.map((candidate) => path.join(releaseRoot, candidate)).join(' or ')}`,
  );
}

let child;
let closed = false;
let temporaryDirectory;
let terminating;
let interrupted;

function stopOwnedProcess() {
  if (terminating) return terminating;
  if (!child?.pid || closed) return Promise.resolve();
  const pid = child.pid;
  terminating = new Promise((resolve) => {
    if (platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const finish = () => {
        clearTimeout(timer);
        if (!closed) child?.kill();
        resolve();
      };
      const timer = setTimeout(() => {
        killer.kill();
        finish();
      }, 5_000);
      killer.once('error', finish);
      killer.once('close', finish);
      return;
    }
    // detached creates a process group containing only this spawned app and its children.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* The app may already have exited. */
      }
      resolve();
    }, 3_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return terminating;
}

const onSignal = (signal) => {
  interrupted = signal;
  void stopOwnedProcess();
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

try {
  const executable = await findExecutable();
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'overhull-package-smoke-'));
  if (interrupted) throw new Error(`Packaged smoke test interrupted by ${interrupted}.`);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  let output = '';
  let sawMarker = false;
  let timedOut = false;
  let startupError;
  child = spawn(executable, [`--user-data-dir=${temporaryDirectory}`, '--smoke-test'], {
    cwd: path.dirname(executable),
    env: environment,
    windowsHide: true,
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    output = (output + chunk.toString()).slice(-65_536);
    if (new RegExp(`^${marker}\\s*$`, 'm').test(output)) sawMarker = true;
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      void stopOwnedProcess().then(() => resolve({ code: null, signal: null }));
    }, timeoutMs);
    child.once('error', (error) => {
      startupError = error;
    });
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  if (interrupted) throw new Error(`Packaged smoke test interrupted by ${interrupted}.`);
  if (startupError) throw startupError;
  if (timedOut)
    throw new Error(
      `Packaged app did not finish its smoke test within ${timeoutMs / 1000} seconds.\n${output}`,
    );
  if (result.code !== 0 || !sawMarker)
    throw new Error(
      `Packaged app smoke test failed: exit=${result.code}, signal=${result.signal ?? 'none'}, renderer/preload marker=${sawMarker}.\n${output}`,
    );
  console.log(`Packaged smoke passed (${platform}/${architecture}): ${executable}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = interrupted ? 130 : 1;
} finally {
  await stopOwnedProcess();
  if (temporaryDirectory) {
    // Remove only the directory created by this process, never release artifacts or user profiles.
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temporaryDirectory));
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      path.dirname(relative) !== '.' ||
      !path.basename(relative).startsWith('overhull-package-smoke-')
    )
      throw new Error('Refusing to clean an unexpected smoke-test directory.');
    await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
}
