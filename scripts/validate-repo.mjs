#!/usr/bin/env node
/**
 * Repository self-check.
 *
 * Validates the things a test suite cannot: that the documentation links resolve, that
 * every skill referenced by the catalog exists, that every capability a skill asks for is
 * declared, and that no skill hard-codes an MCP tool name.
 *
 * That last check is the important one. The entire integration design rests on skills
 * reasoning in capability verbs; one hard-coded `mcp__github__create_issue` in a markdown
 * file quietly reintroduces the coupling the registry exists to remove.
 *
 *   node scripts/validate-repo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const warnings = [];
const stats = {};

// CRLF is normalised, not tolerated case by case. On Windows with core.autocrlf the whole
// tree is CRLF, and every check below that anchors on "\n" -- frontmatter, line counts,
// fenced blocks -- reported a false problem on every file. 80 spurious problems is the same
// as no check at all, because nobody reads the 81st.
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const readJson = (p) => JSON.parse(read(p));
const exists = (p) => fs.existsSync(path.join(ROOT, p));

function walk(dir, filter) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel, filter));
    else if (filter(entry.name)) out.push(rel);
  }
  return out;
}

/* ------------------------------------------------- 1. skills and frontmatter */

const skillFiles = walk('skills', (n) => n === 'SKILL.md');
stats.skills = skillFiles.length;
const skillNames = new Set();

for (const file of skillFiles) {
  const text = read(file);
  if (!text.startsWith('---\n')) {
    problems.push(`${file}: frontmatter must start on line 1, or the whole file is treated as content`);
    continue;
  }
  const end = text.indexOf('\n---', 4);
  if (end === -1) {
    problems.push(`${file}: unterminated frontmatter`);
    continue;
  }
  const fm = text.slice(4, end);
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim();

  if (!name) problems.push(`${file}: missing "name"`);
  else {
    if (!/^[a-z0-9-]+$/.test(name)) problems.push(`${file}: name "${name}" should be kebab-case`);
    const dirName = path.basename(path.dirname(file));
    if (name !== dirName) problems.push(`${file}: name "${name}" does not match its directory "${dirName}"`);
    skillNames.add(name);
  }

  if (!description) {
    problems.push(`${file}: missing "description" — Claude uses it to decide when to invoke the skill`);
  } else {
    const whenToUse = /^when_to_use:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? '';
    const combined = description.length + whenToUse.length;
    // Verified against code.claude.com/docs/en/skills: description + when_to_use are
    // truncated at 1,536 characters in listings.
    if (combined > 1536) {
      problems.push(`${file}: description + when_to_use is ${combined} chars, over the 1536 listing cap`);
    }
  }

  const lines = text.split('\n').length;
  // The docs recommend keeping SKILL.md under 500 lines and moving detail into
  // supporting files that load only when needed.
  if (lines > 500) warnings.push(`${file}: ${lines} lines — over the recommended 500; move detail into supporting files`);
}

/* ------------------------------------------- 2. markdown links resolve on disk */

const mdFiles = walk('.', (n) => n.endsWith('.md')).filter((f) => !f.includes('node_modules') && !f.startsWith('state/'));
stats.markdown = mdFiles.length;
let linkCount = 0;

for (const file of mdFiles) {
  const text = read(file);
  const dir = path.posix.dirname(file);
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].split('#')[0].trim();
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    if (target.includes('{{')) continue; // template placeholder
    linkCount += 1;
    const resolved = path.posix.normalize(path.posix.join(dir, target));
    if (!exists(resolved)) problems.push(`${file}: broken link -> ${target} (resolved ${resolved})`);
  }
}
stats.links_checked = linkCount;

/* ------------------------------------- 3. no hard-coded MCP tool names in skills */

for (const file of walk('skills', (n) => n.endsWith('.md')).concat(walk('agents', (n) => n.endsWith('.md')))) {
  const text = read(file);
  for (const m of text.matchAll(/\bmcp__[a-z0-9_]+__[a-z0-9_]+/gi)) {
    problems.push(`${file}: hard-codes MCP tool name "${m[0]}" — skills must reason in capability verbs (see engine/capability-registry)`);
  }
}

/* ------------------------------- 4. catalog skill references point at real skills */

const catalog = readJson('engine/applicability-engine/catalog.json');
for (const [category, def] of Object.entries(catalog.categories)) {
  if (def.skill && !skillNames.has(def.skill)) {
    problems.push(`catalog.json: category "${category}" delegates to unknown skill "${def.skill}"`);
  }
  if (def.capability) {
    const caps = readJson('engine/capability-registry/capabilities.json');
    if (!caps.capabilities[def.capability]) {
      problems.push(`catalog.json: category "${category}" requires undeclared capability "${def.capability}"`);
    }
  }
}
stats.categories = Object.keys(catalog.categories).length;

/* ----------------------------------- 5. capability registry internal consistency */

const caps = readJson('engine/capability-registry/capabilities.json');
for (const [verb, def] of Object.entries(caps.capabilities)) {
  for (const provider of def.providers) {
    if (!caps.providers[provider]) problems.push(`capabilities.json: verb "${verb}" names unknown provider "${provider}"`);
  }
  if (def.write && !def.authorization) {
    problems.push(`capabilities.json: write verb "${verb}" has no authorization level`);
  }
}
stats.capabilities = Object.keys(caps.capabilities).length;

/* ---------------------------- 6. browser matrix method capabilities are declared */

const matrix = readJson('engine/browser-decision/matrix.json');
for (const [id, def] of Object.entries(matrix.methods)) {
  if (def.capability && !caps.capabilities[def.capability]) {
    problems.push(`browser matrix: method "${id}" requires undeclared capability "${def.capability}"`);
  }
  for (const factor of Object.keys(def.affinity ?? {})) {
    if (!matrix.factors[factor]) problems.push(`browser matrix: method "${id}" uses undeclared factor "${factor}"`);
  }
}
for (const rule of matrix.hard_rules) {
  for (const m of rule.forbid) {
    if (!matrix.methods[m]) problems.push(`browser matrix: hard rule "${rule.id}" forbids unknown method "${m}"`);
  }
}

/* --------------------------------- 7. risk profiles cover every declared factor */

const weights = readJson('engine/risk-engine/weights.json');
for (const [name, profile] of Object.entries(weights.profiles)) {
  for (const factor of Object.keys(weights.factors)) {
    if (profile.weights[factor] === undefined) {
      warnings.push(`risk profile "${name}" does not weight factor "${factor}" — it will never be scored under this profile`);
    }
  }
  for (const factor of Object.keys(profile.weights)) {
    if (!weights.factors[factor]) problems.push(`risk profile "${name}" weights undeclared factor "${factor}"`);
  }
}

/* ------------------------------------------------- 8. every schema loads cleanly */

const { loadSchema } = await import('../engine/schema/validate.mjs');
const schemaFiles = walk('schemas', (n) => n.endsWith('.schema.json'));
stats.schemas = schemaFiles.length;
for (const file of schemaFiles) {
  const name = path.basename(file).replace(/\.schema\.json$/, '');
  try {
    loadSchema(name);
  } catch (err) {
    problems.push(`${file}: ${err.message}`);
  }
}

/* ------------------------------------------ 9. authorization policy completeness */

const policy = readJson('engine/authorization/policy.json');
for (const [action, def] of Object.entries(policy.actions)) {
  if (!policy.levels[def.level]) problems.push(`policy.json: action "${action}" uses undefined level "${def.level}"`);
}
for (const [verb, def] of Object.entries(caps.capabilities)) {
  if (def.write && def.authorization !== 'workspace-only' && !policy.actions[verb]) {
    warnings.push(`capabilities.json declares write verb "${verb}" with no matching entry in authorization policy.json — it will be denied by default`);
  }
}

/* ---------------------------------------- 10. version and count drift in the docs */

// Every number below was wrong at least once, in more than one file, because nothing
// checked it. A claim a reader can verify in ten seconds is worse than no claim when it is
// stale -- it makes the honest documents look unmaintained.

const VERSION = readJson('package.json').version;
stats.version = VERSION;

for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
  const body = read(f);
  if (!body.includes(`"version": "${VERSION}"`)) {
    problems.push(`${f}: version disagrees with package.json (${VERSION})`);
  }
}

// A hard-coded x.y.z in our own prose is the drift source. Exempt the places a version
// number is deliberately not the current one: the changelog is historical, templates and
// examples carry placeholder provenance, and the benchmark app is the thing under test
// rather than our documentation.
const OURS = (f) => !['CHANGELOG.md', 'docs/versioning.md', 'templates/', 'examples/', 'integrations/', 'evaluation/', 'sample-ecommerce-app/', 'state/']
  .some((e) => f === e || f.startsWith(e));

for (const f of mdFiles.filter(OURS)) {
  for (const m of read(f).matchAll(/\bv?(0\.\d+\.\d+)\b/g)) {
    if (m[1] !== VERSION) problems.push(`${f}: mentions version ${m[1]}, but package.json says ${VERSION}`);
  }
}

// Test count, counted statically so this check never has to run the suite.
//
// Anchored to the documented command, not to the words "N tests". This repository talks
// about other projects' suites constantly -- a walkthrough cites the target app's 211
// tests, PROGRESS cites the 29 covering the GitHub adapter -- and a looser pattern flags
// every one of them.
const testCount = walk('tests', (n) => n.endsWith('.test.mjs'))
  .reduce((a, f) => a + (read(f).match(/^test\(/gm) ?? []).length, 0);
stats.tests = testCount;
for (const f of mdFiles.filter(OURS)) {
  for (const line of read(f).split('\n')) {
    if (!line.includes('tests/*.test.mjs')) continue;
    const m = /(\d+)\s*(?:tests|passed)/.exec(line);
    if (m && Number(m[1]) !== testCount) {
      problems.push(`${f}: claims ${m[1]} tests next to the suite command, but tests/ defines ${testCount}`);
    }
  }
}

// Category count, claimed in engine docstrings as well as prose.
const categoryCount = Object.keys(catalog.categories).length;
for (const f of [...mdFiles, 'engine/applicability-engine/index.mjs']) {
  for (const m of read(f).matchAll(/(\d+)\s+test categories/g)) {
    if (Number(m[1]) !== categoryCount) {
      problems.push(`${f}: claims ${m[1]} test categories, but the catalog defines ${categoryCount}`);
    }
  }
}

/* ------------------------------------------------------------------- report */

console.log(`autonomous-software-testing — repository self-check\n`);
console.log(`  version           ${stats.version}`);
console.log(`  tests defined     ${stats.tests}`);
console.log(`  skills            ${stats.skills}`);
console.log(`  markdown files    ${stats.markdown}`);
console.log(`  links checked     ${stats.links_checked}`);
console.log(`  schemas           ${stats.schemas}`);
console.log(`  test categories   ${stats.categories}`);
console.log(`  capabilities      ${stats.capabilities}\n`);

if (warnings.length) {
  console.log(`${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ~ ${w}`);
  console.log('');
}

if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log(`  x ${p}`);
  process.exitCode = 1;
} else {
  console.log('No problems found.');
}
