// Windows autostart backend.
//
// Both long-running sidecars are installed into the per-user Startup folder as
// a .cmd file plus a one-line hidden .vbs launcher. `watch` needs a restart
// loop inside the .cmd (the production-proven `:loop` / `ping -n 6` pattern):
// killing the node child alone would let the wrapper respawn it, which is why
// stopWatch() must terminate the cmd.exe wrapper with `/T`.
//
// Paths use path.win32 explicitly (not the host `path`) so the templates are
// stable when rendered/tested from a non-Windows host.
import { win32 as winPath } from 'node:path';
import {
  runQuietly,
  type AutostartDeps,
  type AutostartStrategy,
  type GeneratedFile,
  type SetupConfig
} from './types.js';

const WATCH_CMD = 'taskboard-watch.cmd';
const WATCH_VBS = 'taskboard-watch.vbs';
const OPENCODE_CMD = 'taskboard-opencode-serve.cmd';
const OPENCODE_VBS = 'taskboard-opencode-serve.vbs';

const EOL = '\r\n';

export function startupDir(deps: AutostartDeps): string {
  const appData = deps.env.APPDATA ?? winPath.join(deps.homedir(), 'AppData', 'Roaming');
  return winPath.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function logsDir(deps: AutostartDeps): string {
  const localAppData = deps.env.LOCALAPPDATA ?? winPath.join(deps.homedir(), 'AppData', 'Local');
  return winPath.join(localAppData, 'taskboard', 'logs');
}

/** ~/.env is read by node at every (re)start; the token is never baked in. */
const envFile = (config: SetupConfig): string => winPath.join(config.repoRoot, '.env');

const cliEntry = (config: SetupConfig): string =>
  winPath.join(config.repoRoot, 'apps', 'cli', 'dist', 'cli.js');

/**
 * Exact production pattern: crash-restart loop around the watch sidecar.
 * `TASKBOARD_URL` is not secret; `TASKBOARD_TOKEN` stays in .env.
 */
export function watchCmdContent(config: SetupConfig): string {
  return [
    '@echo off',
    'setlocal',
    `set TASKBOARD_URL=${config.boardUrl}`,
    ':loop',
    `"${config.nodeExecPath}" --env-file-if-exists="${envFile(config)}" `
      + `"${cliEntry(config)}" watch --opencode ${config.opencodeUrl} `
      + '>> "%LOCALAPPDATA%\\taskboard\\logs\\watch.log" 2>&1',
    'ping -n 6 127.0.0.1 >nul',
    'goto loop',
    ''
  ].join(EOL);
}

/**
 * `call` is required so a batch-file launcher (npm installs opencode.cmd)
 * returns control instead of transferring it; executables accept `call` too.
 */
export function opencodeCmdContent(config: SetupConfig): string {
  return [
    '@echo off',
    'setlocal',
    `call "${config.opencodeCommand}" serve --hostname 0.0.0.0 --port ${config.opencodePort} `
      + '>> "%LOCALAPPDATA%\\taskboard\\logs\\opencode-serve.log" 2>&1',
    ''
  ].join(EOL);
}

/** Hidden launcher: window style 0, do not wait. */
export function hiddenLauncherContent(cmdPath: string): string {
  return `CreateObject("WScript.Shell").Run Chr(34) & "${cmdPath}" & Chr(34), 0, False${EOL}`;
}

export function buildWindowsPaths(deps: AutostartDeps): string[] {
  const dir = startupDir(deps);
  return [
    winPath.join(dir, WATCH_CMD),
    winPath.join(dir, WATCH_VBS),
    winPath.join(dir, OPENCODE_CMD),
    winPath.join(dir, OPENCODE_VBS)
  ];
}

export function buildWindowsFiles(config: SetupConfig, deps: AutostartDeps): GeneratedFile[] {
  const files = buildWindowsPaths(deps);
  const watchCmd = files[0]!;
  const watchVbs = files[1]!;
  const opencodeCmd = files[2]!;
  const opencodeVbs = files[3]!;
  return [
    { path: watchCmd, content: watchCmdContent(config) },
    { path: watchVbs, content: hiddenLauncherContent(watchCmd) },
    { path: opencodeCmd, content: opencodeCmdContent(config) },
    { path: opencodeVbs, content: hiddenLauncherContent(opencodeCmd) }
  ];
}

interface WindowsProcess {
  pid: number;
  commandLine: string;
}

/**
 * Enumerate candidate processes without adding a dependency. PowerShell is
 * already present on every supported Windows version; `-Compress` keeps the
 * payload small and ConvertTo-Json returns an object (not an array) for a
 * single row, so both shapes are normalised.
 */
async function listWindowsProcesses(deps: AutostartDeps): Promise<WindowsProcess[]> {
  const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='cmd.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
  const result = await runQuietly(deps, 'powershell', ['-NoProfile', '-Command', script]);
  if (result.code !== 0 || result.stdout.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: WindowsProcess[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const pid = typeof record.ProcessId === 'number' ? record.ProcessId : Number(record.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({
      pid,
      commandLine: typeof record.CommandLine === 'string' ? record.CommandLine : ''
    });
  }
  return out;
}

const isWatchNodeLine = (line: string): boolean =>
  line.includes('cli.js" watch')
  || line.includes('cli.js watch')
  || /cli\.js["']?\s+watch/.test(line);

const isOpencodeLine = (line: string): boolean =>
  /taskboard-opencode-serve\.cmd/i.test(line)
  || /opencode(?:\.(?:exe|cmd))?["']?\s+serve/i.test(line)
  || /opencode\.exe/i.test(line);

async function taskkill(deps: AutostartDeps, args: readonly string[]): Promise<void> {
  await runQuietly(deps, 'taskkill', args);
}

export async function stopWatchWin32(deps: AutostartDeps): Promise<void> {
  const processes = await listWindowsProcesses(deps);
  // Wrappers must die FIRST and with /T: killing only node lets cmd's :loop
  // respawn it five seconds later.
  const wrappers = processes.filter(proc => /taskboard-watch\.cmd/i.test(proc.commandLine));
  const nodes = processes.filter(proc => isWatchNodeLine(proc.commandLine));
  const killed = new Set<number>();
  for (const proc of wrappers) {
    killed.add(proc.pid);
    await taskkill(deps, ['/PID', String(proc.pid), '/T', '/F']);
  }
  for (const proc of nodes) {
    if (killed.has(proc.pid)) continue;
    await taskkill(deps, ['/PID', String(proc.pid), '/T', '/F']);
  }
}

export async function stopOpencodeWin32(deps: AutostartDeps): Promise<void> {
  const processes = await listWindowsProcesses(deps);
  const matched = processes.filter(proc => isOpencodeLine(proc.commandLine));
  const killed = new Set<number>();
  for (const proc of matched) {
    killed.add(proc.pid);
    await taskkill(deps, ['/PID', String(proc.pid), '/T', '/F']);
  }
  // Second sweep: opencode.exe may be outside the node.exe/cmd.exe filter
  // (or its command line may be truncated by WMI permissions).
  await taskkill(deps, ['/IM', 'opencode.exe', '/T', '/F']);
}

export const win32Strategy: AutostartStrategy = {
  platform: 'win32',
  buildFiles: buildWindowsFiles,
  async register(config, deps) {
    const files = buildWindowsFiles(config, deps);
    deps.mkdir(startupDir(deps));
    deps.mkdir(logsDir(deps));
    for (const file of files) deps.writeFile(file.path, file.content);
    return files;
  },
  async unregister(deps) {
    await stopWatchWin32(deps);
    await stopOpencodeWin32(deps);
    const files = buildWindowsPaths(deps);
    for (const file of files) deps.deleteFile(file);
    return files;
  },
  stopWatch: stopWatchWin32,
  stopOpencode: stopOpencodeWin32
};
