/**
 * Capability Registry.
 *
 * The whole point: skills ask for `github.create_issue`, not for
 * `mcp__github__create_issue` or `gh issue create`. The binding from verb to
 * provider is data, resolved at runtime, and it degrades honestly -- an
 * unavailable capability comes back as unavailable rather than being faked.
 *
 * Two kinds of probe:
 *   - `command` / `env` / `always` : this module can check them itself.
 *   - `agent-declared`             : only the agent knows whether an MCP tool
 *                                    is in its tool list, so it declares it via
 *                                    `ast caps declare <provider> <true|false>`.
 *                                    Undeclared means UNKNOWN, never "yes".
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, writeJson } from '../core/fsjson.mjs';
import { PACKAGE_ROOT, p, LAYOUT } from '../core/paths.mjs';

const REG = readJson(path.join(PACKAGE_ROOT, 'engine', 'capability-registry', 'capabilities.json'));

export const VERBS = Object.keys(REG.capabilities);
export const PROVIDERS = Object.keys(REG.providers);

function probeFile() {
  return p(LAYOUT.capabilities);
}

function loadProbe() {
  return readJson(probeFile(), { version: REG.version, checked_at: null, providers: {}, declared: {} });
}

/** Record an agent-declared provider availability. */
export function declare(provider, available, note = '') {
  if (!REG.providers[provider]) {
    throw new Error(`Unknown provider "${provider}". Known: ${PROVIDERS.join(', ')}`);
  }
  const db = loadProbe();
  db.declared[provider] = { available: Boolean(available), note, declared_at: new Date().toISOString() };
  writeJson(probeFile(), db);
  return db.declared[provider];
}

function runProbe(command) {
  try {
    const parts = command.split(' ');
    const out = execFileSync(parts[0], parts.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      shell: process.platform === 'win32',
    });
    return { available: true, detail: String(out).trim().split(/\r?\n/)[0].slice(0, 200) };
  } catch (err) {
    return { available: false, detail: (err.stderr || err.message || '').toString().trim().split(/\r?\n/)[0].slice(0, 200) };
  }
}

/**
 * Probe every provider this module can check. Agent-declared providers keep
 * whatever the agent last declared, or come back as `unknown`.
 */
export function probe({ now = new Date() } = {}) {
  const db = loadProbe();
  const results = {};

  for (const [name, def] of Object.entries(REG.providers)) {
    const declared = db.declared[name];
    switch (def.probe.type) {
      case 'always':
        results[name] = { available: true, method: 'always', detail: def.notes ?? '' };
        break;
      case 'command': {
        const r = runProbe(def.probe.command);
        results[name] = { available: r.available, method: `command: ${def.probe.command}`, detail: r.detail };
        break;
      }
      case 'env': {
        const missing = def.probe.vars.filter((v) => !process.env[v]);
        results[name] = {
          available: missing.length === 0,
          method: `env: ${def.probe.vars.join(', ')}`,
          detail: missing.length ? `missing: ${missing.join(', ')}` : 'all variables present',
        };
        break;
      }
      case 'agent-declared':
        results[name] = declared
          ? { available: declared.available, method: 'agent-declared', detail: declared.note || `declared at ${declared.declared_at}` }
          : { available: null, method: 'agent-declared', detail: 'NOT DECLARED -- treat as unavailable until the agent confirms the tools are in its tool list.' };
        break;
      default:
        results[name] = { available: null, method: 'unknown', detail: `unsupported probe type ${def.probe.type}` };
    }
  }

  db.providers = results;
  db.checked_at = now.toISOString();
  db.version = REG.version;
  writeJson(probeFile(), db);
  return resolveAll(db);
}

/** Resolve every capability against the last probe. */
export function resolveAll(db = loadProbe()) {
  const capabilities = {};
  for (const [verb, def] of Object.entries(REG.capabilities)) {
    capabilities[verb] = resolve(verb, db);
  }
  return {
    checked_at: db.checked_at,
    providers: db.providers,
    capabilities,
    available: Object.fromEntries(Object.entries(capabilities).map(([k, v]) => [k, v.available])),
    unavailable: Object.entries(capabilities).filter(([, v]) => !v.available).map(([k]) => k),
  };
}

/**
 * Resolve one capability.
 * @returns {{verb, available, provider, candidates, write, authorization, reason}}
 */
export function resolve(verb, db = loadProbe()) {
  const def = REG.capabilities[verb];
  if (!def) throw new Error(`Unknown capability "${verb}". Known verbs: ${VERBS.join(', ')}`);

  const candidates = def.providers.map((name) => ({
    provider: name,
    available: db.providers?.[name]?.available ?? null,
    detail: db.providers?.[name]?.detail ?? 'not probed',
  }));
  const chosen = candidates.find((c) => c.available === true) ?? null;

  return {
    verb,
    available: Boolean(chosen),
    provider: chosen?.provider ?? null,
    candidates,
    write: Boolean(def.write),
    authorization: def.authorization ?? (def.write ? 'explicit' : 'none'),
    idempotency: def.idempotency ?? null,
    description: def.description ?? '',
    reason: chosen
      ? `Resolved to "${chosen.provider}" (${chosen.detail}).`
      : `No available provider. Tried: ${candidates.map((c) => `${c.provider}=${c.available === null ? 'unknown' : c.available}`).join(', ')}. Report this capability as unavailable; do not simulate it.`,
  };
}

export function registry() {
  return REG;
}
