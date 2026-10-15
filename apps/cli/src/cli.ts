#!/usr/bin/env node
// taskctl-style CLI for open-taskboard. Talks to the HTTP service.
// Thin entry: argv → registry → dispatch → central error handling.
import { parseFlags } from './flags.js';
import { HELP } from './help.js';
import { api, base } from './http.js';
import { registry } from './commands/registry.js';

async function main(): Promise<void> {
  let [cmd, sub, ...args] = process.argv.slice(2);
  if (sub && sub.startsWith('--')) { args.unshift(sub); sub = undefined; }
  const { flags, rest } = parseFlags(args);

  if (!cmd || cmd === 'help' || flags.help) { console.log(HELP); return; }

  const key = `${cmd} ${sub ?? ''}`.trim();
  let command = registry[key];
  if (!command && sub !== undefined) {
    const bare = registry[cmd];
    if (bare?.bare) command = bare;
  }
  if (!command) {
    console.error(`unknown command: ${cmd} ${sub ?? ''}`);
    console.log(HELP);
    process.exit(1);
  }
  await command.run({ api, base, flags, rest });
}

main().catch(e => {
  const cause = (e as TypeError).cause as NodeJS.ErrnoException | undefined;
  if (e instanceof TypeError && /fetch failed/i.test(e.message)
    && (cause === undefined || cause.code === 'ECONNREFUSED')) {
    console.error(`error: 无法连接 taskboard 服务 (${base()})`);
    console.error('  请先运行 `taskboard serve`，或用 TASKBOARD_URL 指向已运行的服务');
  } else {
    console.error(e);
  }
  process.exit(1);
});
