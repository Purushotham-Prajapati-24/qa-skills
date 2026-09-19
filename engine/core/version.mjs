/**
 * Single source of truth for versions stamped onto every artefact.
 *
 * SYSTEM_VERSION tracks the whole skill system (semver, see CHANGELOG.md).
 * The schema versions are separate: a schema only bumps when its shape changes,
 * so old records stay readable and `ast validate` can tell you which migration
 * you owe.
 */
import { readJson } from './fsjson.mjs';
import path from 'node:path';
import { PACKAGE_ROOT } from './paths.mjs';

const pkg = readJson(path.join(PACKAGE_ROOT, 'package.json'));

export const SYSTEM_VERSION = pkg.version;
export const ENGINE_VERSION = pkg.version;

/** Version of each persisted document shape. Bump on breaking field changes. */
export const DOC_VERSIONS = {
  'repository-profile': '1.0.0',
  'testing-plan': '1.0.0',
  'session-state': '1.0.0',
  // 1.2.0: added optional `digest` (see reporting-engine's verify()), optional `grade` on
  // each evidence_index entry (see evidence-engine's anchored/asserted grading), and
  // optional `impact`/`blocking`/`raised_by_execution` on each uncertainty_details entry
  // (backs the "Unblock these" section). All additive; 1.2.0 has not shipped in a release
  // yet, so each landed under the same bump rather than churning the version for a shape
  // no released build ever printed.
  report: '1.2.0',
};

/** Stamp used on every persisted record. */
export function provenance({ sessionId, skillName = 'testing-orchestrator', by = 'agent', now = new Date() } = {}) {
  const prov = {
    skill_version: SYSTEM_VERSION,
    skill_name: skillName,
    engine_version: ENGINE_VERSION,
    created_at: now.toISOString(),
    created_by: by,
  };
  if (sessionId) prov.session_id = sessionId;
  return prov;
}
