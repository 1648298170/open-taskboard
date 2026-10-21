// Autostart tests. Every filesystem/process side effect goes through the
// injected AutostartDeps fake, so no real Startup folder, LaunchAgents
// directory, or process is touched.
//
// Import registry first: it spreads the command tables and keeps the same
// module-load order the CLI entry uses (see commands.test.ts for the TDZ note).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registry } from '../src/commands/registry.js';
import { optionsFromFlags, runSetup } from '../src/commands/setup.js';
import {
  buildWindowsFiles,
  startupDir,
  win32Strategy
} from '../src/autostart/win32.js';
import {
  darwinStrategy,
  opencodePlist,
  watchPlist
} from '../src/autostart/darwin.js';
import { resolveOpencodeCommand, selectStrategy } from '../src/autostart/index.js';
import type {
  AutostartDeps,
  ExecResult,
  SetupConfig
} from '../src/autostart/types.js';

interface Fake {
  deps: AutostartDeps;
  files: Map<string, string>;
  mkdirs: string[];
  deleted: string[];
  execs: Array<{ command: string; args: string[] }>;
}

type ExecImpl = (command: string, args: readonly string[]) => Promise<ExecResult>;

const fakeDeps = (
  overrides: Partial<AutostartDeps> = {},
  execImpl?: ExecImpl
): Fake => {
  const files = new Map<string, string>();
  const mkdirs: string[] = [];
  const deleted: string[] = [];
  const execs: Array<{ command: string; args: string[] }> = [];
  const deps: AutostartDeps = {
    writeFile: (file, content) => { files.set(file, content); },
    mkdir: dir => { mkdirs.push(dir); },
    deleteFile: file => { deleted.push(file); files.delete(file); },
    exec: async (command, args) => {
      execs.push({ command, args: [...args] });
      return execImpl
        ? execImpl(command, args)
        : { code: 0, stdout: '', stderr: '' };
    },
    homedir: () => 'C:\\Users\\tester',
    platform: 'win32',
    nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
    nodeVersion: '22.22.2',
    repoRoot: 'C:\\repo',
    uid: 501,
    env: {
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local'
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
  return { deps, files, mkdirs, deleted, execs };
};

const winConfig: SetupConfig = {
  boardUrl: 'http://127.0.0.1:47824',
  opencodeUrl: 'http://127.0.0.1:4096',
  opencodePort: 4096,
  opencodeCommand: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\opencode.cmd',
  repoRoot: 'C:\\repo',
  nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe'
};

const darwinConfig: SetupConfig = {
  boardUrl: 'http://127.0.0.1:47824',
  opencodeUrl: 'http://127.0.0.1:4096',
  opencodePort: 4096,
  opencodeCommand: '/opt/homebrew/bin/opencode',
  repoRoot: '/repo',
  nodeExecPath: '/usr/local/bin/node'
};

const macDeps = (overrides: Partial<AutostartDeps> = {}, execImpl?: ExecImpl): Fake =>
  fakeDeps({
    platform: 'darwin',
    homedir: () => '/Users/tester',
    nodeExecPath: '/usr/local/bin/node',
    repoRoot: '/repo',
    env: {},
    ...overrides
  }, execImpl);

const quiet = async (fn: () => Promise<void>): Promise<{ logs: string[]; errs: string[] }> => {
  const logs: string[] = [];
  const errs: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { errs.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return { logs, errs };
};

describe('win32 templates', () => {
  it('watch cmd is the crash-restart loop with absolute paths and no token', () => {
    const fake = fakeDeps();
    const files = buildWindowsFiles(winConfig, fake.deps);
    assert.equal(files.length, 4);
    assert.deepEqual(files.map(file => file.path), [
      'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\taskboard-watch.cmd',
      'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\taskboard-watch.vbs',
      'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\taskboard-opencode-serve.cmd',
      'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\taskboard-opencode-serve.vbs'
    ]);
    assert.equal(files[0]!.path, `${startupDir(fake.deps)}\\taskboard-watch.cmd`);

    const watch = files[0]!.content;
    assert.match(watch, /^@echo off\r\n/);
    assert.ok(watch.includes('set TASKBOARD_URL=http://127.0.0.1:47824'));
    assert.ok(watch.includes(':loop'));
    assert.ok(watch.includes(
      '"C:\\Program Files\\nodejs\\node.exe" '
      + '--env-file-if-exists="C:\\repo\\.env" '
      + '"C:\\repo\\apps\\cli\\dist\\cli.js" watch --opencode http://127.0.0.1:4096'
    ));
    assert.ok(watch.includes('ping -n 6 127.0.0.1 >nul'));
    assert.ok(watch.includes('goto loop'));
    assert.ok(!watch.includes('TASKBOARD_TOKEN'), 'token must stay in .env');
  });

  it('vbs launchers are hidden one-liners pointing at the matching cmd', () => {
    const fake = fakeDeps();
    const files = buildWindowsFiles(winConfig, fake.deps);
    assert.equal(
      files[1]!.content,
      `CreateObject("WScript.Shell").Run Chr(34) & "${files[0]!.path}" & Chr(34), 0, False\r\n`
    );
    assert.equal(
      files[3]!.content,
      `CreateObject("WScript.Shell").Run Chr(34) & "${files[2]!.path}" & Chr(34), 0, False\r\n`
    );
  });

  it('opencode cmd uses the resolved launcher and configured port', () => {
    const fake = fakeDeps();
    const opencode = buildWindowsFiles(winConfig, fake.deps)[2]!.content;
    assert.ok(opencode.includes(
      'call "C:\\Users\\tester\\AppData\\Roaming\\npm\\opencode.cmd" '
      + 'serve --hostname 0.0.0.0 --port 4096'
    ));
    assert.ok(!opencode.includes('TASKBOARD_TOKEN'));
  });
});

describe('generated file content', () => {
  it('is ASCII-only on both platforms (English templates)', () => {
    for (const file of buildWindowsFiles(winConfig, fakeDeps().deps)) {
      assert.match(file.content, /^[\x00-\x7F]*$/);
    }
    for (const file of darwinStrategy.buildFiles(darwinConfig, macDeps().deps)) {
      assert.match(file.content, /^[\x00-\x7F]*$/);
    }
  });
});

describe('darwin templates', () => {
  it('watch plist carries launchd keys, absolute args, and log paths', () => {
    const fake = macDeps();
    const files = darwinStrategy.buildFiles(darwinConfig, fake.deps);
    assert.deepEqual(files.map(file => file.path), [
      '/Users/tester/Library/LaunchAgents/com.taskboard.watch.plist',
      '/Users/tester/Library/LaunchAgents/com.taskboard.opencode-serve.plist'
    ]);

    const plist = files[0]!.content;
    assert.ok(plist.includes('<key>Label</key>\n  <string>com.taskboard.watch</string>'));
    assert.ok(plist.includes('<key>ProgramArguments</key>'));
    assert.ok(plist.includes('<string>/usr/local/bin/node</string>'));
    assert.ok(plist.includes('<string>--env-file-if-exists=/repo/.env</string>'));
    assert.ok(plist.includes('<string>/repo/apps/cli/dist/cli.js</string>'));
    assert.ok(plist.includes('<string>watch</string>'));
    assert.ok(plist.includes('<string>--opencode</string>'));
    assert.ok(plist.includes('<string>http://127.0.0.1:4096</string>'));
    assert.ok(plist.includes('<key>EnvironmentVariables</key>'));
    assert.ok(plist.includes('<key>TASKBOARD_URL</key>\n    <string>http://127.0.0.1:47824</string>'));
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.ok(plist.includes('<string>/Users/tester/.taskboard/logs/watch.out.log</string>'));
    assert.ok(plist.includes('<string>/Users/tester/.taskboard/logs/watch.err.log</string>'));
    assert.ok(!plist.includes('TASKBOARD_TOKEN'), 'token must stay in .env');
  });

  it('opencode plist launches the resolved serve command', () => {
    const fake = macDeps();
    const plist = opencodePlist(darwinConfig, fake.deps);
    assert.ok(plist.includes('<string>/opt/homebrew/bin/opencode</string>'));
    assert.ok(plist.includes('<string>serve</string>'));
    assert.ok(plist.includes('<string>--hostname</string>'));
    assert.ok(plist.includes('<string>0.0.0.0</string>'));
    assert.ok(plist.includes('<string>4096</string>'));
    assert.ok(plist.includes('/Users/tester/.taskboard/logs/opencode-serve.out.log'));
  });

  it('is deterministic given the same injected paths', () => {
    const fake = macDeps();
    assert.equal(watchPlist(darwinConfig, fake.deps), watchPlist(darwinConfig, fake.deps));
    assert.equal(
      opencodePlist(darwinConfig, fake.deps),
      opencodePlist(darwinConfig, fake.deps)
    );
  });
});

describe('register / unregister', () => {
  it('win32 writes four files and removes exactly those four', async () => {
    const fake = fakeDeps();
    const written = await win32Strategy.register(winConfig, fake.deps);
    assert.equal(fake.files.size, 4);
    assert.deepEqual([...fake.files.keys()], written.map(file => file.path));
    assert.ok(fake.mkdirs.includes(startupDir(fake.deps)));

    fake.deleted.length = 0;
    const removed = await win32Strategy.unregister(fake.deps);
    assert.equal(removed.length, 4);
    assert.deepEqual(fake.deleted, removed);
    assert.equal(fake.files.size, 0);
  });

  it('darwin loads two plists and unloads/deletes both', async () => {
    const fake = macDeps();
    const written = await darwinStrategy.register(darwinConfig, fake.deps);
    assert.equal(fake.files.size, 2);
    assert.deepEqual([...fake.files.keys()], written.map(file => file.path));
    assert.ok(fake.execs.some(call =>
      call.command === 'launchctl' && call.args[0] === 'load' && call.args[1] === '-w'
    ));

    fake.deleted.length = 0;
    const removed = await darwinStrategy.unregister(fake.deps);
    assert.deepEqual(fake.deleted, removed);
    assert.equal(fake.files.size, 0);
    assert.ok(fake.execs.some(call =>
      call.command === 'launchctl' && call.args[0] === 'unload'
    ));
  });
});

describe('version gate and platform dispatch', () => {
  it('rejects Node < 22.9 before writing anything', async () => {
    const fake = fakeDeps({ nodeVersion: '22.8.9' });
    await assert.rejects(
      () => runSetup({}, fake.deps),
      /Node\.js >= 22\.9 is required for --env-file-if-exists/
    );
    assert.equal(fake.files.size, 0);
    assert.equal(fake.mkdirs.length, 0);
    assert.equal(fake.execs.length, 0, 'gate must fire before opencode lookup');
  });

  it('rejects unsupported platforms with a clear message', async () => {
    const fake = fakeDeps({ platform: 'linux' });
    await assert.rejects(
      () => runSetup({}, fake.deps),
      /setup: platform not supported yet \(win32\/darwin only\)/
    );
    assert.equal(fake.files.size, 0);
    assert.throws(
      () => selectStrategy('linux'),
      /platform not supported yet \(win32\/darwin only\)/
    );
  });
});

describe('--print', () => {
  it('prints templates without writing or creating directories', async () => {
    const fake = fakeDeps();
    const { logs } = await quiet(() => runSetup({ print: true }, fake.deps));
    assert.equal(fake.files.size, 0);
    assert.equal(fake.mkdirs.length, 0);
    const output = logs.join('\n');
    assert.match(output, /=== .*taskboard-watch\.cmd ===/);
    assert.match(output, /:loop/);
    assert.match(output, /nothing was written \(4 files\)/);
  });
});

describe('stop helpers on win32', () => {
  it('kills the cmd.exe wrapper with /T before the node child', async () => {
    const payload = JSON.stringify([
      {
        ProcessId: 111,
        CommandLine: 'C:\\Windows\\system32\\cmd.exe /c ""C:\\Startup\\taskboard-watch.cmd" "'
      },
      {
        ProcessId: 222,
        CommandLine: '"C:\\Program Files\\nodejs\\node.exe" '
          + '"C:\\repo\\apps\\cli\\dist\\cli.js" watch --opencode http://127.0.0.1:4096'
      }
    ]);
    const fake = fakeDeps({}, async command => command === 'powershell'
      ? { code: 0, stdout: payload, stderr: '' }
      : { code: 0, stdout: '', stderr: '' });

    await win32Strategy.stopWatch(fake.deps);
    const kills = fake.execs.filter(call => call.command === 'taskkill');
    assert.deepEqual(kills.map(call => call.args), [
      ['/PID', '111', '/T', '/F'],
      ['/PID', '222', '/T', '/F']
    ]);
  });

  it('kills matched opencode processes and sweeps opencode.exe', async () => {
    const payload = JSON.stringify([
      {
        ProcessId: 444,
        CommandLine: 'C:\\Windows\\system32\\cmd.exe /c ""C:\\Startup\\taskboard-opencode-serve.cmd" "'
      },
      {
        ProcessId: 333,
        CommandLine: '"C:\\Users\\tester\\opencode.exe" serve --port 4096'
      }
    ]);
    const fake = fakeDeps({}, async command => command === 'powershell'
      ? { code: 0, stdout: payload, stderr: '' }
      : { code: 0, stdout: '', stderr: '' });

    await win32Strategy.stopOpencode(fake.deps);
    const kills = fake.execs.filter(call => call.command === 'taskkill');
    assert.ok(kills.some(call => call.args.join(' ') === '/PID 444 /T /F'));
    assert.ok(kills.some(call => call.args.join(' ') === '/PID 333 /T /F'));
    assert.ok(kills.some(call => call.args.join(' ') === '/IM opencode.exe /T /F'));
  });
});

describe('stop helpers on darwin', () => {
  it('boots out the label and falls back to unload, then pkills the sidecar', async () => {
    const fake = macDeps({}, async (command, args) => {
      if (command === 'launchctl' && args[0] === 'bootout') {
        return { code: 1, stdout: '', stderr: 'not found' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    await darwinStrategy.stopWatch(fake.deps);
    assert.ok(fake.execs.some(call =>
      call.command === 'launchctl'
      && call.args[0] === 'bootout'
      && call.args[1] === 'gui/501/com.taskboard.watch'
    ));
    assert.ok(fake.execs.some(call =>
      call.command === 'launchctl'
      && call.args[0] === 'unload'
      && call.args[1] === '/Users/tester/Library/LaunchAgents/com.taskboard.watch.plist'
    ));
    assert.ok(fake.execs.some(call =>
      call.command === 'pkill' && call.args[1] === 'cli.js.? watch'
    ));
  });
});

describe('opencode launcher resolution', () => {
  it('prefers a stable .cmd over ephemeral fnm multishell shims', async () => {
    const fake = fakeDeps({}, async command => command === 'where'
      ? {
          code: 0,
          stderr: '',
          stdout: 'C:\\Users\\t\\AppData\\Local\\fnm_multishells\\1_2\\opencode\r\n'
            + 'C:\\Users\\t\\AppData\\Local\\fnm_multishells\\1_2\\opencode.cmd\r\n'
            + 'D:\\Apps\\node\\opencode.cmd\r\n'
        }
      : { code: 0, stdout: '', stderr: '' });
    assert.equal(
      await resolveOpencodeCommand(fake.deps),
      'D:\\Apps\\node\\opencode.cmd'
    );
  });

  it('falls back to a bare opencode when lookup fails', async () => {
    const fake = fakeDeps({}, async () => ({ code: 1, stdout: '', stderr: '' }));
    assert.equal(await resolveOpencodeCommand(fake.deps), 'opencode');
  });
});

describe('command registration', () => {
  it('exposes setup, stop-watch, and stop-opencode', () => {
    assert.ok(registry.setup);
    assert.ok(registry['stop-watch']);
    assert.ok(registry['stop-opencode']);
  });

  it('maps flags to setup options', () => {
    assert.deepEqual(
      optionsFromFlags({
        'opencode-url': 'http://127.0.0.1:4097',
        'board-url': 'http://127.0.0.1:47824',
        unregister: true,
        print: true
      }),
      {
        opencodeUrl: 'http://127.0.0.1:4097',
        boardUrl: 'http://127.0.0.1:47824',
        unregister: true,
        print: true
      }
    );
  });
});
