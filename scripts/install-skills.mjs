#!/usr/bin/env node
/**
 * Install the skills into a `.claude/skills` directory, for people who use project or
 * personal skills rather than the plugin.
 *
 *   node scripts/install-skills.mjs --target /path/to/repo/.claude/skills
 *   node scripts/install-skills.mjs --target ~/.claude/skills --link
 *   node scripts/install-skills.mjs --target ... --only browser-testing,unit-testing
 *   node scripts/install-skills.mjs --target ... --dry-run
 *
 * --link creates symlinks, so edits in this checkout take effect immediately. That is what
 * you want while developing. Copies are what you want when shipping to a team that will not
 * have this checkout. On Windows, symlinks may need Developer Mode or an elevated shell;
 * the script falls back to copying and says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, 'skills');

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const [k, inline] = argv[i].slice(2).split('=');
    if (inline !== undefined) flags[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags[k] = argv[i + 1]; i += 1; }
    else flags[k] = true;
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

if (!flags.target || flags.help) {
  console.log(`Install autonomous-software-testing skills.

  --target <dir>   Destination, e.g. /repo/.claude/skills or ~/.claude/skills  (required)
  --link           Symlink instead of copy (edits here take effect immediately)
  --only a,b,c     Install only these skills
  --force          Overwrite existing destinations
  --dry-run        Print what would happen and stop

Note: this installs SKILLS ONLY. Subagents (agents/), hooks (hooks/) and MCP config
(.mcp.json) come with the plugin install path. See docs/installation.md.`);
  process.exit(flags.help ? 0 : 1);
}

const target = path.resolve(String(flags.target).replace(/^~(?=$|[/\\])/, os.homedir()));
const only = flags.only ? String(flags.only).split(',').map((s) => s.trim()) : null;

const available = fs
  .readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS, d.name, 'SKILL.md')))
  .map((d) => d.name);

const selected = only ? available.filter((n) => only.includes(n)) : available;

if (only) {
  const missing = only.filter((n) => !available.includes(n));
  if (missing.length) {
    console.error(`Unknown skill(s): ${missing.join(', ')}`);
    console.error(`Available: ${available.join(', ')}`);
    process.exit(1);
  }
}

console.log(`Installing ${selected.length} skill(s) into ${target}${flags.link ? ' (symlinked)' : ''}${flags['dry-run'] ? ' [dry run]' : ''}\n`);

if (!flags['dry-run']) fs.mkdirSync(target, { recursive: true });

let installed = 0;
let skipped = 0;
let fellBack = false;

for (const name of selected) {
  const src = path.join(SKILLS, name);
  const dest = path.join(target, name);

  if (fs.existsSync(dest)) {
    if (!flags.force) {
      console.log(`  skip    ${name}  (already exists — pass --force to overwrite)`);
      skipped += 1;
      continue;
    }
    if (!flags['dry-run']) fs.rmSync(dest, { recursive: true, force: true });
  }

  if (flags['dry-run']) {
    console.log(`  would   ${name}`);
    installed += 1;
    continue;
  }

  if (flags.link) {
    try {
      fs.symlinkSync(src, dest, 'junction');
      console.log(`  link    ${name}`);
      installed += 1;
      continue;
    } catch (err) {
      if (!fellBack) {
        console.log(`  note    symlink failed (${err.code}); falling back to copying. On Windows this usually needs Developer Mode or an elevated shell.`);
        fellBack = true;
      }
    }
  }

  fs.cpSync(src, dest, { recursive: true });
  console.log(`  copy    ${name}`);
  installed += 1;
}

console.log(`\n${installed} installed, ${skipped} skipped.`);

if (installed && !flags['dry-run']) {
  console.log(`
The skills reference \`node bin/ast.mjs\` for all bookkeeping. Keep this checkout in place
and either run the CLI from here, or set AST_STATE_DIR so state lands where you want it:

  export AST_STATE_DIR=/path/to/your/repo/.testing-state

Then:  node ${path.relative(process.cwd(), path.join(ROOT, 'bin', 'ast.mjs'))} init`);
}
