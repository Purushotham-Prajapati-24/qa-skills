/**
 * Path resolution for the Autonomous Software Testing (AST) system.
 *
 * Every persistent artefact lives under a single state root so that the whole
 * agent memory can be inspected, diffed, committed or deleted as one unit.
 *
 * Resolution order for the state root:
 *   1. --state <dir>            (explicit CLI flag, highest precedence)
 *   2. $AST_STATE_DIR           (environment, useful for CI matrix runs)
 *   3. <package root>/state     (default)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root of this package (the directory holding package.json). */
export const PACKAGE_ROOT = path.resolve(HERE, '..', '..');

let override = null;

/** Set by the CLI when `--state <dir>` is supplied. */
export function setStateRoot(dir) {
  override = dir ? path.resolve(dir) : null;
}

export function stateRoot() {
  if (override) return override;
  if (process.env.AST_STATE_DIR) return path.resolve(process.env.AST_STATE_DIR);
  return path.join(PACKAGE_ROOT, 'state');
}

/** Canonical layout of the state directory. Kept in one place on purpose. */
export const LAYOUT = {
  counters: 'counters.json',
  profile: 'repository-profile.json',
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
