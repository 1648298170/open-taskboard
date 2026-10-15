// Minimal `--key value` / `--flag` argument parser shared by all commands.
export interface Flags { [k: string]: string | boolean }

export function parseFlags(args: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {}; const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else rest.push(arg);
  }
  return { flags, rest };
}
