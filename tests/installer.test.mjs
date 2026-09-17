import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');

function install(target, args = []) {
  return execFileSync(process.execPath, [INSTALLER, ...args], { cwd: target, encoding: 'utf8', timeout: 120_000 });
}

function freshRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ast-inst-${label}-`));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"someone-elses-app"}');
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function everyMarkdown(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function everyFile(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walk(q);
      else out.push(q);
    }
  };
  walk(dir);
  return out;
}

test('a dry run writes nothing', () => {
  const dir = freshRepo('dry');
  const out = install(dir, ['--dry-run']);
  assert.match(out, /DRY RUN/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'a dry run must not create .claude');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a project install lands skills, agents and a runnable runtime', () => {
  const dir = freshRepo('project');
  const out = install(dir);

  assert.equal(fs.readdirSync(path.join(dir, '.claude/skills')).length, 21);
  assert.equal(fs.readdirSync(path.join(dir, '.claude/agents')).length, 4);
  assert.ok(fs.existsSync(path.join(dir, '.claude/ast/bin/ast.mjs')));
  assert.match(out, /verified {2}CLI runs/);

  // The installed CLI has to work from the TARGET repository, not from the source.
  const version = JSON.parse(execFileSync(process.execPath, ['.claude/ast/bin/ast.mjs', 'version'], { cwd: dir, encoding: 'utf8' }));
  assert.match(version.system, /^\d+\.\d+\.\d+$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no installed skill still points at the source layout', () => {
  const dir = freshRepo('rewrite');
  install(dir);
  // Two source-only forms. `node bin/ast.mjs` is the historical one. The CLAUDE_PLUGIN_ROOT
  // form is correct under a plugin install, where Claude Code substitutes it -- but nothing
  // substitutes it here, so it would expand to nothing and run `node /bin/ast.mjs`.
  // A miss here fails the first time the agent runs a command, which is a confusing
  // place to discover an installer bug.
  const files = [...everyMarkdown(path.join(dir, '.claude/skills')), ...everyMarkdown(path.join(dir, '.claude/agents'))];
  const stale = files.filter((f) => {
    const body = fs.readFileSync(f, 'utf8');
    return body.includes('node bin/ast.mjs') || body.includes('CLAUDE_PLUGIN_ROOT');
  }).map((f) => path.relative(dir, f));
  assert.deepEqual(stale, []);

  // ...and the rewrite actually landed, rather than there being nothing to rewrite.
  const rewritten = files.filter((f) => fs.readFileSync(f, 'utf8').includes('node .claude/ast/bin/ast.mjs'));
  assert.ok(rewritten.length > 10, `expected the CLI path to be rewritten in many skills, got ${rewritten.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every link in an installed skill resolves on disk', () => {
  const dir = freshRepo('links');
  install(dir);
  const broken = [];
  let checked = 0;
  for (const f of [...everyMarkdown(path.join(dir, '.claude/skills')), ...everyMarkdown(path.join(dir, '.claude/agents'))]) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0].trim();
      if (!target || /^(https?:|mailto:)/.test(target) || target.includes('{{')) continue;
      checked += 1;
      if (!fs.existsSync(path.resolve(path.dirname(f), target))) broken.push(`${path.relative(dir, f)} -> ${target}`);
    }
  }
  assert.ok(checked > 10, `expected links to check, found ${checked}`);
  assert.deepEqual(broken, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a user-scope install rewrites the CLI path to an absolute one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-inst-home-'));
  const dir = freshRepo('userscope');
  install(dir, ['--target', home, '--only', 'unit-testing']);

  const skill = fs.readFileSync(path.join(home, '.claude/skills/unit-testing/SKILL.md'), 'utf8');
  // A user-scope install is shared across projects, so a repo-relative path cannot work.
  assert.ok(!skill.includes('node .claude/ast/bin/ast.mjs'), 'must not use a repo-relative path');
  assert.match(skill, /node "[^"]*\.claude\/ast\/bin\/ast\.mjs"/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a second install refuses rather than silently overwriting', () => {
  const dir = freshRepo('collide');
  install(dir);
  assert.throws(
    () => install(dir),
    (err) => /Already installed/.test(err.stdout ?? '') && err.status === 1,
    'a re-install without --force must exit non-zero and say why',
  );
  assert.doesNotThrow(() => install(dir, ['--force']));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the runtime carries everything the CLI needs to run offline', () => {
  const dir = freshRepo('runtime');
  install(dir);
  const ast = path.join(dir, '.claude/ast');
  for (const needed of ['engine', 'schemas', 'evaluation', 'templates', 'docs', 'integrations', 'package.json']) {
    assert.ok(fs.existsSync(path.join(ast, needed)), `runtime is missing ${needed}`);
  }
  // The benchmark exercises the decision engines and needs evaluation/ plus every schema.
  const evalOut = JSON.parse(execFileSync(process.execPath, ['.claude/ast/bin/ast.mjs', 'eval', 'run'], { cwd: dir, encoding: 'utf8' }));
  assert.equal(evalOut.score, 1, 'the benchmark must pass from an installed copy');
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The benchmark answer key names every seeded defect by file, line and reproduction. An
 * agent that can read it does not have to detect anything, so an installed runtime -- which
 * sits inside the working tree of the agent being measured -- must not contain it.
 */
test('the benchmark answer key is not copied into an installed runtime', () => {
  const dir = freshRepo('answer-key');
  install(dir);

  const evaluation = path.join(dir, '.claude', 'ast', 'evaluation');
  assert.ok(fs.existsSync(evaluation), 'the rest of evaluation/ still installs, so doc links keep resolving');
  assert.ok(fs.existsSync(path.join(evaluation, 'README.md')), 'docs/installation.md links to evaluation/README.md');
  assert.equal(
    fs.existsSync(path.join(evaluation, 'benchmark-app')),
    false,
    'benchmark-app/ (the answer key) must not reach the agent being scored',
  );

  const leaked = everyFile(path.join(dir, '.claude')).filter((f) => path.basename(f) === 'answer-key.json');
  assert.deepEqual(leaked, [], 'no answer key anywhere under .claude, by any route');

  fs.rmSync(dir, { recursive: true, force: true });
});
