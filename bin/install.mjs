#!/usr/bin/env node
/**
 * Installer. This is what `npx github:<owner>/<repo>` runs.
 *
 *   npx github:Purushotham-Prajapati-24/qa-skills            install into ./.claude
 *   npx github:Purushotham-Prajapati-24/qa-skills --user     install into ~/.claude
 *   npx github:Purushotham-Prajapati-24/qa-skills --dry-run  show the plan, touch nothing
 *
 * Layout it produces:
 *
 *   .claude/
 *     skills/<21 skills>/       where Claude Code looks for skills
 *     agents/<4 agents>.md      where Claude Code looks for subagents
 *     ast/                      the runtime: CLI, engines, schemas, docs, templates
 *
 * The skills are written against the source repository, where the CLI sits at
 * `bin/ast.mjs` and the docs one level up from `skills/`. Neither path exists once the
 * skills are copied somewhere else, so the installer rewrites them. That rewrite is the
 * only reason this is a program rather than a `cp -r`, and it is verified at the end by
 * actually running the installed CLI.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8'));

/** Copied into <claude>/ast. Everything the CLI or a skill link needs at runtime. */
const RUNTIME = ['bin', 'engine', 'schemas', 'evaluation', 'integrations', 'templates', 'docs', 'examples', 'scripts', 'package.json', 'LICENSE'];


/**
 * Paths under RUNTIME that must NOT reach an installed agent, as posix-style paths relative
 * to the source root.
 *
 * The benchmark answer key names every seeded defect by file, line and reproduction. Copying
 * it into .claude/ast puts it inside the working tree of the very agent whose detection rate
 * it is used to measure -- an agent that reads it can score a perfect run by replaying the
 * answers instead of finding anything. It stays in the source repository, where the evaluator
 * runs, and travels no further.
 */
const RUNTIME_EXCLUDE = new Set(['evaluation/benchmark-app']);

/** Repo-root directories a skill may link to. These move under ast/ and must be rewritten. */
const MOVED = ['integrations', 'templates', 'docs', 'examples', 'schemas', 'engine', 'evaluation', 'scripts'];

/* ----------------------------------------------------------------- arguments */

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
const DRY = Boolean(flags['dry-run']);
const USER_SCOPE = Boolean(flags.user || flags.global);

if (flags.help) {
  console.log(`autonomous-software-testing v${pkg.version} — installer

  npx github:Purushotham-Prajapati-24/qa-skills [options]

  --user, --global   Install into ~/.claude (every project) instead of ./.claude
  --target <dir>     Install into a specific directory's .claude
  --only a,b,c       Install only these skills
  --hooks            Also wire the SessionStart and PreToolUse hooks into settings.json
  --force            Overwrite an existing installation
  --dry-run          Print the plan and change nothing
  --help

Installs 21 skills, 4 subagents and the zero-dependency runtime. Requires Node 20.6+.
Nothing else — there are no npm dependencies to fetch.`);
  process.exit(0);
}

const targetRoot = flags.target
  ? path.resolve(String(flags.target).replace(/^~(?=$|[/\\])/, os.homedir()))
  : USER_SCOPE ? os.homedir() : process.cwd();

const claudeDir = path.join(targetRoot, '.claude');
const runtimeDir = path.join(claudeDir, 'ast');
const skillsDir = path.join(claudeDir, 'skills');
const agentsDir = path.join(claudeDir, 'agents');

/**
 * How an installed skill should invoke the CLI.
 *
 * A project install can use a path relative to the repository root, because that is where
 * the agent runs commands from. A user-scope install cannot -- the skills are shared
 * across every project -- so it has to be absolute.
 */
const cliPath = USER_SCOPE || flags.target
  ? `node "${path.join(runtimeDir, 'bin', 'ast.mjs').replace(/\\/g, '/')}"`
  : 'node .claude/ast/bin/ast.mjs';

// How the skills invoke the CLI in source. Claude Code substitutes CLAUDE_PLUGIN_ROOT for a
// plugin install, but nothing substitutes it here -- an installed skill that kept the
// placeholder would expand it to nothing and run `node /bin/ast.mjs`.
const SOURCE_CLI = `node "\${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs"`;

/* -------------------------------------------------------------------- helpers */

const log = (s = '') => console.log(s);
let copied = 0;
let rewritten = 0;

function copyTree(from, to, transform) {
  if (RUNTIME_EXCLUDE.has(path.relative(SOURCE, from).split(path.sep).join('/'))) return;
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    if (!DRY) fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'state') continue;
      copyTree(path.join(from, entry), path.join(to, entry), transform);
    }
    return;
  }
  copied += 1;
  if (DRY) return;
  if (transform && from.endsWith('.md')) {
    const original = fs.readFileSync(from, 'utf8');
    const next = transform(original);
    if (next !== original) rewritten += 1;
    fs.writeFileSync(to, next, 'utf8');
  } else {
    fs.copyFileSync(from, to);
  }
}

/**
 * Rewrite the two things that only make sense inside the source repository.
 *
 * Done with explicit, narrow patterns rather than a broad search-and-replace: a rewrite
 * that silently mangles prose is worse than one that misses a link, because the miss is
 * visible and the mangling is not.
 */
function rewritePaths(text) {
  let out = text.replaceAll(SOURCE_CLI, cliPath).replaceAll('node bin/ast.mjs', cliPath);

  // Links that walk up out of skills/ into a repo-root directory now have to go through
  // ast/, because that is where the runtime landed.
  for (const dir of MOVED) {
    out = out
      .replaceAll(`](../../${dir}/`, `](../../ast/${dir}/`)
      .replaceAll(`](../../../${dir}/`, `](../../../ast/${dir}/`);
  }
  return out;
}

/* ----------------------------------------------------------------------- plan */

const availableSkills = fs
  .readdirSync(path.join(SOURCE, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(SOURCE, 'skills', d.name, 'SKILL.md')))
  .map((d) => d.name);

const only = flags.only ? String(flags.only).split(',').map((s) => s.trim()) : null;
if (only) {
  const unknown = only.filter((n) => !availableSkills.includes(n));
  if (unknown.length) {
    console.error(`Unknown skill(s): ${unknown.join(', ')}\nAvailable: ${availableSkills.join(', ')}`);
    process.exit(1);
  }
}
const selectedSkills = only ? availableSkills.filter((n) => only.includes(n)) : availableSkills;
const agents = fs.existsSync(path.join(SOURCE, 'agents'))
  ? fs.readdirSync(path.join(SOURCE, 'agents')).filter((f) => f.endsWith('.md'))
  : [];

log(`\nautonomous-software-testing v${pkg.version}`);
const scopeLabel = USER_SCOPE ? 'user (every project)' : flags.target ? 'explicit target' : 'project';
log(`  scope     ${scopeLabel}`);
log(`  into      ${claudeDir}`);
log(`  skills    ${selectedSkills.length}`);
log(`  agents    ${agents.length}`);
log(`  CLI       ${cliPath}`);
if (DRY) log('\n  DRY RUN — nothing will be written.');
log();

/* ---------------------------------------------------------------- collisions */

const existing = [runtimeDir, ...selectedSkills.map((s) => path.join(skillsDir, s))].filter((p) => fs.existsSync(p));
if (existing.length && !flags.force && !DRY) {
  log(`Already installed (${existing.length} path(s) exist). Pass --force to overwrite, or --dry-run to see the plan.`);
  log(`  e.g. ${path.relative(targetRoot, existing[0]) || existing[0]}`);
  process.exit(1);
}

/* -------------------------------------------------------------------- install */

if (!DRY) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
}

for (const entry of RUNTIME) {
  const from = path.join(SOURCE, entry);
  if (!fs.existsSync(from)) continue;
  // The runtime keeps its own internal paths, so it is copied verbatim.
  copyTree(from, path.join(runtimeDir, entry), null);
}
log(`  runtime   ${copied} file(s) -> .claude/ast/`);

const beforeSkills = copied;
for (const name of selectedSkills) {
  if (!DRY && fs.existsSync(path.join(skillsDir, name))) fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
  copyTree(path.join(SOURCE, 'skills', name), path.join(skillsDir, name), rewritePaths);
}
log(`  skills    ${copied - beforeSkills} file(s) -> .claude/skills/  (${rewritten} rewritten)`);

if (agents.length) {
  if (!DRY) fs.mkdirSync(agentsDir, { recursive: true });
  for (const a of agents) {
    if (DRY) { copied += 1; continue; }
    fs.writeFileSync(path.join(agentsDir, a), rewritePaths(fs.readFileSync(path.join(SOURCE, 'agents', a), 'utf8')), 'utf8');
    copied += 1;
  }
  log(`  agents    ${agents.length} file(s) -> .claude/agents/`);
}

/* ---------------------------------------------------------------------- hooks */

if (flags.hooks && !DRY) {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, '')) : {};
  settings.hooks ??= {};
  const script = (name) => path.join(runtimeDir, 'scripts', 'hooks', name).replace(/\\/g, '/');
  settings.hooks.SessionStart ??= [];
  settings.hooks.SessionStart.push({
    matcher: 'startup|resume|clear',
    hooks: [{ type: 'command', command: ['node', script('session-start.mjs')], timeout: 15 }],
  });
  settings.hooks.PreToolUse ??= [];
  settings.hooks.PreToolUse.push({
    matcher: 'Bash|PowerShell',
    hooks: [{ type: 'command', command: ['node', script('guard-destructive.mjs')], timeout: 10 }],
  });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  log(`  hooks     wired into ${path.relative(targetRoot, settingsPath)}`);
} else if (flags.hooks) {
  log('  hooks     would be wired into .claude/settings.json');
}

/* --------------------------------------------------------------- gitignore */

if (!USER_SCOPE && !DRY && fs.existsSync(path.join(targetRoot, '.git'))) {
  const gi = path.join(targetRoot, '.gitignore');
  const current = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!current.includes('.claude/ast/state')) {
    const block = `\n# Autonomous Software Testing runtime state (evidence may contain data from what you tested)\n.claude/ast/state/\n`;
    fs.appendFileSync(gi, block, 'utf8');
    log('  gitignore added .claude/ast/state/');
  }
}

/* ------------------------------------------------------------------- verify */

if (DRY) {
  log(`\nDry run complete. ${copied} file(s) would be written.\n`);
  process.exit(0);
}

let verified = false;
try {
  const out = execFileSync(process.execPath, [path.join(runtimeDir, 'bin', 'ast.mjs'), 'version'], { encoding: 'utf8', timeout: 30_000 });
  const parsed = JSON.parse(out);
  verified = parsed.system === pkg.version;
  log(`\n  verified  CLI runs: v${parsed.system} on Node ${parsed.node}`);
} catch (err) {
  log(`\n  WARNING   the installed CLI did not run: ${String(err.message).split('\n')[0]}`);
}

// A skill that still points at the source layout would fail the first time it is used,
// which is a confusing place to discover an installer bug.
const stale = [];
for (const name of selectedSkills) {
  const dir = path.join(skillsDir, name);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      const body = fs.readFileSync(p, 'utf8');
      if (body.includes('node bin/ast.mjs') || body.includes(SOURCE_CLI)) stale.push(path.relative(skillsDir, p));
    }
  };
  walk(dir);
}
if (stale.length) log(`  WARNING   ${stale.length} skill file(s) still reference the source CLI path: ${stale.slice(0, 3).join(', ')}`);

/* --------------------------------------------------------------- next steps */

log(`
Installed ${selectedSkills.length} skills and ${agents.length} subagents.

Next:

  ${cliPath} init
  ${cliPath} caps probe

Then, in Claude Code from ${USER_SCOPE ? 'any project' : 'this repository'}:

  "Test this repository."
  "Test this pull request."
  "Explore the checkout flow for UI bugs and create regression tests."

Docs: .claude/ast/docs/concepts.md  (what a skill, MCP server and hook actually are)
      .claude/ast/README.md
${verified ? '' : '\nThe CLI did not verify. Check that Node is 20.6 or newer: node --version\n'}`);
