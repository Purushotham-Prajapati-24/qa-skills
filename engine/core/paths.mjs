/**
 * Path resolution for the Autonomous Software Testing (AST) system.
 *
 * Every persistent artefact lives under a single state root so that the whole
 * agent memory can be inspected, diffed, committed or deleted as one unit.
 *
 * Resolution order for the state root:
 *   1. --state <dir>            (explicit CLI flag, highest precedence)
 *   2. $AST_STATE_DIR           (environment, useful for CI matrix runs)
 *   3. <package root>/state when the runtime lives inside the project, else
 *      <project root>/.testing-state (user-scope and plugin installs: see defaultStateRoot)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root of this package (the directory holding package.json). */
export const PACKAGE_ROOT = path.resolve(HERE, '..', '..');

let override = null;

/** Set by the CLI when `--state <dir>` is supplied. */
export function setStateRoot(dir) {
  override = dir ? path.resolve(dir) : null;
}

const projectRoots = new Map();

/** The repository the agent is testing: the git top level of the working directory, or the directory itself. */
export function projectRoot(cwd = process.cwd()) {
  if (!projectRoots.has(cwd)) {
    let root = cwd;
    try {
      root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || cwd;
    } catch { /* not a git repository */ }
    projectRoots.set(cwd, path.resolve(root));
  }
  return projectRoots.get(cwd);
}

// Compare real, canonical paths. The same directory can be spelled differently: Windows 8.3
// short names (C:\Users\RUNNER~1 from os.tmpdir() vs C:/Users/runneradmin from git), drive-letter
// case, macOS /var vs /private/var, symlinks. A string comparison called an in-project runtime
// "outside" and moved its state.
const canonical = (p) => {
  let real = path.resolve(p);
  try { real = fs.realpathSync.native(real); } catch { /* not created yet: compare as given */ }
  return process.platform === 'win32' ? real.toLowerCase() : real;
};

const isInside = (child, parent) => {
  const rel = path.relative(canonical(parent), canonical(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Where state lives when nothing says otherwise. A runtime installed INSIDE the project
 * (`.claude/ast`, or this source repository) keeps state beside itself, as before. A runtime
 * shared across projects -- a user-scope install in ~/.claude/ast, or a plugin in Claude Code's
 * versioned plugin cache -- must not: every project would share one session, and a plugin
 * update (a new cache directory) would silently lose it. Those default to
 * `<project root>/.testing-state`.
 */
export function defaultStateRoot(cwd = process.cwd()) {
  const project = projectRoot(cwd);
  return isInside(PACKAGE_ROOT, project) ? path.join(PACKAGE_ROOT, 'state') : path.join(project, '.testing-state');
}

/** True when state resolved to the implicit `<project>/.testing-state` (not a flag, env var or in-project runtime). */
export function isImplicitProjectState() {
  return !override && !process.env.AST_STATE_DIR && path.basename(defaultStateRoot()) === '.testing-state';
}

export function stateRoot() {
  if (override) return override;
  if (process.env.AST_STATE_DIR) return path.resolve(process.env.AST_STATE_DIR);
  return defaultStateRoot();
}

/** Canonical layout of the state directory. Kept in one place on purpose. */
export const LAYOUT = {
  counters: 'counters.json',
  profile: 'repository-profile.json',
  applicability: 'applicability.json',
  planCommitments: 'plan-commitments.json',
  authoredBaseline: 'authored-baseline.json',
  stopGate: 'stop-gate.json',
  session: 'testing-state.json',
  capabilities: 'capabilities-probe.json',
  decisions: 'decisions',
  executions: 'executions',
  evidence: 'evidence',
  findings: 'findings',
  uncertainties: 'uncertainties',
  reports: 'reports',
  ledger: 'external-writes',
  history: 'history',
  logs: 'telemetry',
  plans: 'plans',
};

export function p(...segments) {
  return path.join(stateRoot(), ...segments);
}

/** Directory for a named collection, e.g. dir('decisions'). */
export function dir(name) {
  const rel = LAYOUT[name];
  if (!rel) throw new Error(`Unknown state collection: ${name}`);
  return p(rel);
}

/** Absolute path of the JSON schema for a given artefact kind. */
export function schemaPath(name) {
  return path.join(PACKAGE_ROOT, 'schemas', `${name}.schema.json`);
}
