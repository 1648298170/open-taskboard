// T4-23: task templates — a CLI-local convenience read from
// <dataDir>/templates.json with shape { [name]: { title?, description?,
// labels?, priority?, status?, branch? } }. No server/MCP surface: the file
// is read per invocation, so editing (or creating) it takes effect on the
// very next command without restarting anything.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from './registry.js';

/** Fields a template may prefill on `issue create`; explicit flags always win. */
export interface TemplateFields {
  title?: string;
  description?: string;
  labels?: string;
  priority?: string;
  status?: string;
  branch?: string;
}

/** Same data-dir resolution order as serve: TASKBOARD_DATA_DIR || '.data'. */
export const templatesDataDir = (): string => process.env.TASKBOARD_DATA_DIR || '.data';

export const templatesFile = (): string => join(templatesDataDir(), 'templates.json');

/** Load all templates; a missing file is simply an empty template set. */
export function loadTemplates(): Record<string, TemplateFields> {
  const file = templatesFile();
  if (!existsSync(file)) return {};
  // Windows 用户常用 PowerShell 写 JSON（UTF-8 with BOM）——容忍 BOM 头
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`error: ${file} must contain a JSON object mapping template names to fields`);
    process.exit(1);
  }
  return parsed as Record<string, TemplateFields>;
}

/**
 * Look up one template; a missing file or missing name exits 1 with
 * `template not found: NAME (available: a, b)` (or a create-hint when the
 * template set is empty).
 */
export function resolveTemplate(name: string): TemplateFields {
  const templates = loadTemplates();
  const template = templates[name];
  if (template === undefined) {
    const names = Object.keys(templates);
    const hint = names.length ? `available: ${names.join(', ')}` : `no templates — create ${templatesFile()}`;
    console.error(`error: template not found: ${name} (${hint})`);
    process.exit(1);
  }
  return template;
}

export const templatesCommand: Command = {
  summary: 'List available issue templates (from <dataDir>/templates.json)',
  usage: 'templates',
  async run() {
    const templates = loadTemplates();
    const names = Object.keys(templates);
    if (!names.length) { console.log(`no templates — create ${templatesFile()}`); return; }
    for (const name of names) {
      const fields = Object.entries(templates[name] ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
      console.log(`${name}  ${fields}`);
    }
  }
};
