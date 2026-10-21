// macOS autostart backend: per-user launchd LaunchAgents.
//
// launchd provides the crash-restart loop natively (KeepAlive=true), so the
// Windows :loop pattern has no plist equivalent. Logs live under
// ~/.taskboard/logs, which is created at registration time.
//
// Paths use path.posix explicitly so templates stay stable when rendered from
// a Windows host during tests.
import { posix as posixPath } from 'node:path';
import {
  runQuietly,
  xmlEscape,
  type AutostartDeps,
  type AutostartStrategy,
  type GeneratedFile,
  type SetupConfig
} from './types.js';

export const WATCH_LABEL = 'com.taskboard.watch';
export const OPENCODE_LABEL = 'com.taskboard.opencode-serve';

export function launchAgentsDir(deps: AutostartDeps): string {
  return posixPath.join(deps.homedir(), 'Library', 'LaunchAgents');
}

export function logsDir(deps: AutostartDeps): string {
  return posixPath.join(deps.homedir(), '.taskboard', 'logs');
}

export function watchPlistPath(deps: AutostartDeps): string {
  return posixPath.join(launchAgentsDir(deps), `${WATCH_LABEL}.plist`);
}

export function opencodePlistPath(deps: AutostartDeps): string {
  return posixPath.join(launchAgentsDir(deps), `${OPENCODE_LABEL}.plist`);
}

interface PlistOptions {
  label: string;
  programArguments: string[];
  boardUrl: string;
  stdoutPath: string;
  stderrPath: string;
}

function renderPlist(options: PlistOptions): string {
  const argumentLines = options.programArguments
    .map(arg => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(options.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argumentLines,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>TASKBOARD_URL</key>',
    `    <string>${xmlEscape(options.boardUrl)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(options.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(options.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n');
}

/** The token is supplied by --env-file-if-exists at every launch, never here. */
export function watchPlist(config: SetupConfig, deps: AutostartDeps): string {
  return renderPlist({
    label: WATCH_LABEL,
    programArguments: [
      config.nodeExecPath,
      `--env-file-if-exists=${posixPath.join(config.repoRoot, '.env')}`,
      posixPath.join(config.repoRoot, 'apps', 'cli', 'dist', 'cli.js'),
      'watch',
      '--opencode',
      config.opencodeUrl
    ],
    boardUrl: config.boardUrl,
    stdoutPath: posixPath.join(logsDir(deps), 'watch.out.log'),
    stderrPath: posixPath.join(logsDir(deps), 'watch.err.log')
  });
}

export function opencodePlist(config: SetupConfig, deps: AutostartDeps): string {
  return renderPlist({
    label: OPENCODE_LABEL,
    programArguments: [
      config.opencodeCommand,
      'serve',
      '--hostname',
      '0.0.0.0',
      '--port',
      String(config.opencodePort)
    ],
    boardUrl: config.boardUrl,
    stdoutPath: posixPath.join(logsDir(deps), 'opencode-serve.out.log'),
    stderrPath: posixPath.join(logsDir(deps), 'opencode-serve.err.log')
  });
}

export function buildDarwinPaths(deps: AutostartDeps): string[] {
  return [watchPlistPath(deps), opencodePlistPath(deps)];
}

export function buildDarwinFiles(config: SetupConfig, deps: AutostartDeps): GeneratedFile[] {
  return [
    { path: watchPlistPath(deps), content: watchPlist(config, deps) },
    { path: opencodePlistPath(deps), content: opencodePlist(config, deps) }
  ];
}

/**
 * `bootout` is the modern stop; fall back to `unload` for older launchd.
 * Both are best-effort because stopping a service that is not loaded is a
 * normal no-op.
 */
async function bootout(deps: AutostartDeps, label: string, plistPath: string): Promise<void> {
  const result = await runQuietly(deps, 'launchctl', ['bootout', `gui/${deps.uid}/${label}`]);
  if (result.code !== 0) await runQuietly(deps, 'launchctl', ['unload', plistPath]);
}

export async function stopWatchDarwin(deps: AutostartDeps): Promise<void> {
  await bootout(deps, WATCH_LABEL, watchPlistPath(deps));
  // `.?` matches the closing quote in `cli.js" watch` as well as a plain space.
  await runQuietly(deps, 'pkill', ['-f', 'cli.js.? watch']);
}

export async function stopOpencodeDarwin(deps: AutostartDeps): Promise<void> {
  await bootout(deps, OPENCODE_LABEL, opencodePlistPath(deps));
  await runQuietly(deps, 'pkill', ['-f', 'opencode serve']);
}

export const darwinStrategy: AutostartStrategy = {
  platform: 'darwin',
  buildFiles: buildDarwinFiles,
  async register(config, deps) {
    const files = buildDarwinFiles(config, deps);
    deps.mkdir(launchAgentsDir(deps));
    deps.mkdir(logsDir(deps));
    for (const file of files) {
      deps.writeFile(file.path, file.content);
      // Unload first so re-running setup after a config change activates the
      // rewritten plist instead of keeping the old arguments loaded.
      await runQuietly(deps, 'launchctl', ['unload', file.path]);
      const loaded = await runQuietly(deps, 'launchctl', ['load', '-w', file.path]);
      if (loaded.code !== 0) {
        throw new Error(
          `setup: launchctl load failed for ${file.path}: `
          + `${loaded.stderr.trim() || `exit ${loaded.code}`}`
        );
      }
    }
    return files;
  },
  async unregister(deps) {
    const files = buildDarwinPaths(deps);
    for (const file of files) {
      await runQuietly(deps, 'launchctl', ['unload', file]);
      deps.deleteFile(file);
    }
    return files;
  },
  stopWatch: stopWatchDarwin,
  stopOpencode: stopOpencodeDarwin
};
