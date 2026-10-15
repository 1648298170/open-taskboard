// One-click dependency cleanup: removes node_modules from the workspace
// root and every workspace package (apps/*, packages/*). Cross-platform.
// Usage: pnpm clean
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const targets = ['node_modules'];
for (const group of ['apps', 'packages']) {
  if (!existsSync(group)) continue;
  for (const name of readdirSync(group, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const dir = join(group, name.name, 'node_modules');
    if (existsSync(dir)) targets.push(dir);
  }
}

for (const dir of targets) {
  console.log(`removing ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`clean done (${targets.length} node_modules removed)`);
