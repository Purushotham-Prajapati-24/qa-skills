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
import { readJson, updateJson } from '../core/fsjson.mjs';
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

const PROBE_FALLBACK = () => ({ version: REG.version, checked_at: null, providers: {}, declared: {} });

/**
 * Record an agent-declared provider availability.
 *
 * Folds the same value straight into `providers` -- the thing `resolve()`
 * actually reads -- instead of only recording it in `declared` and waiting for
 * the next `probe()` to copy it across. Without this, a declaration reports
 * success and changes nothing until a second, undocumented command runs.
 */
export function declare(provider, available, note = '') {
  if (!REG.providers[provider]) {
    throw new Error(`Unknown provider "${provider}". Known: ${PROVIDERS.join(', ')}`);
  }
  const db = updateJson(probeFile(), (current) => {
    const declared_at = new Date().toISOString();
    current.declared[provider] = { available: Boolean(available), note, declared_at };
    current.providers[provider] = {
      available: Boolean(available),
      method: 'agent-declared',
      detail: note || `declared at ${declared_at}`,
    };
    return current;
  }, PROBE_FALLBACK());
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
 *
 * The shell-outs happen BEFORE the lock, not inside it. Five command probes with a 15s
 * timeout each can outlast any sane staleness deadline, and a probe that holds the
 * registry lock that long blocks -- or, before the lock grew ownership tokens, silently
 * lost -- a concurrent `caps declare`. Only the merge needs to be serialised, and the
 * agent-declared entries are re-read from `current.declared` inside the lock so a
 * declaration that lands mid-probe survives instead of being overwritten by a snapshot
 * taken before it.
 */
export function probe({ now = new Date() } = {}) {
  const probed = {};
  for (const [name, def] of Object.entries(REG.providers)) {
    switch (def.probe.type) {
      case 'always':
        probed[name] = { available: true, method: 'always', detail: def.notes ?? '' };
        break;
      case 'command': {
        const r = runProbe(def.probe.command);
        probed[name] = { available: r.available, method: `command: ${def.probe.command}`, detail: r.detail };
        break;
      }
      case 'env': {
        const missing = def.probe.vars.filter((v) => !process.env[v]);
        probed[name] = {
          available: missing.length === 0,
          method: `env: ${def.probe.vars.join(', ')}`,
          detail: missing.length ? `missing: ${missing.join(', ')}` : 'all variables present',
        };
        break;
      }
      case 'agent-declared':
        probed[name] = null; // resolved under the lock, from the freshest `declared`
        break;
      default:
        probed[name] = { available: null, method: 'unknown', detail: `unsupported probe type ${def.probe.type}` };
    }
  }

  const db = updateJson(probeFile(), (current) => {
    const results = {};

    for (const name of Object.keys(REG.providers)) {
      if (probed[name]) {
        results[name] = probed[name];
        continue;
      }
      const declared = current.declared[name];
      results[name] = declared
        ? { available: declared.available, method: 'agent-declared', detail: declared.note || `declared at ${declared.declared_at}` }
        : { available: null, method: 'agent-declared', detail: 'NOT DECLARED -- treat as unavailable until the agent confirms the tools are in its tool list.' };
    }

    current.providers = results;
    current.checked_at = now.toISOString();
    current.version = REG.version;
    return current;
  }, PROBE_FALLBACK());

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

  // A credential or connector being present is not the same as there being code to drive
  // it. Resolving `true` for a verb like this and stopping there is the exact gap
  // PROGRESS.md names: the agent sees "available", and under time pressure may hand-roll
  // the call or, worse, infer the answer from somewhere else and report it as if this
  // system produced it.
  const system = verb.split('.')[0];
  const manualOnlyNote = REG.manual_only_systems?.[system] ?? null;

  return {
    verb,
    available: Boolean(chosen),
    provider: chosen?.provider ?? null,
    candidates,
    write: Boolean(def.write),
    authorization: def.authorization ?? (def.write ? 'explicit' : 'none'),
    idempotency: def.idempotency ?? null,
    description: def.description ?? '',
    executable: manualOnlyNote ? false : null,
    reason: chosen
      ? `Resolved to "${chosen.provider}" (${chosen.detail}).${
          manualOnlyNote
            ? ` No executable adapter exists for "${system}" -- ${manualOnlyNote} Perform this call by hand${
                def.write ? ' and record the outcome with `ast write record`' : ''
              }; do not treat "available" as "there is code that will do this for you".`
            : ''
        }`
      : `No available provider. Tried: ${candidates.map((c) => `${c.provider}=${c.available === null ? 'unknown' : c.available}`).join(', ')}. Report this capability as unavailable; do not simulate it.`,
  };
}

export function registry() {
  return REG;
}
