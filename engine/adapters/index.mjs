/**
 * Adapter registry.
 *
 * The orchestrator asks for a system by name; it never imports an adapter module
 * directly. Adding a provider means adding a row here and a capability binding -- no skill
 * changes, which is the same indirection principle as the capability registry itself.
 */
import { createGitHubAdapter, preflight as githubPreflight } from './github.mjs';
import { listTickets, readTicket, completeWrite, TICKET_TTL_MS, OUTCOME } from './base.mjs';

const FACTORIES = {
  github: createGitHubAdapter,
};

const PREFLIGHTS = {
  github: githubPreflight,
};

export const SYSTEMS = Object.keys(FACTORIES);

export function getAdapter(system, options = {}) {
  const factory = FACTORIES[system];
  if (!factory) {
    throw new Error(`No adapter for "${system}". Available: ${SYSTEMS.join(', ')}. Jira and Google Docs have written contracts under integrations/ but no executable module yet -- see PROGRESS.md.`);
  }
  return factory(options);
}

export async function preflight(system, options = {}) {
  const fn = PREFLIGHTS[system];
  if (!fn) throw new Error(`No preflight for "${system}".`);
  return fn(options);
}

/** Pending delegated writes, so a session can find work it left half-done. */
export function pending({ now = new Date() } = {}) {
  return listTickets().map((t) => ({
    ...t,
    expired: new Date(t.expires_at) < now,
  }));
}

export { readTicket, completeWrite, TICKET_TTL_MS, OUTCOME };
