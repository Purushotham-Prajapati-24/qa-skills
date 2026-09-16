import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setStateRoot } from '../engine/core/paths.mjs';

/** Point the state engine at a throwaway directory for the duration of a test file. */
export function useTempState(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ast-${label}-`));
  setStateRoot(dir);
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** A minimal but schema-valid repository profile for tests. */
export function sampleProfile() {
  return {
    profile_version: '1.0.0',
    generated_at: new Date().toISOString(),
    repository: { root: 'C:/tmp/demo', name: 'demo-shop' },
    architecture: { frontend: { present: true, stack: ['react'] }, backend: { present: true, stack: ['express'] } },
    technologies: [
      { name: 'react', kind: 'framework', confidence: 0.95, epistemic_class: 'observed', evidence: ['package.json:dependencies.react'] },
      { name: 'postgres', kind: 'database', confidence: 0.9, epistemic_class: 'observed', evidence: ['docker-compose.yml:services.db'] },
      { name: 'npm', kind: 'package-manager', confidence: 1, epistemic_class: 'observed', evidence: ['package-lock.json'] },
    ],
    apis: [{ kind: 'rest', route_count: 14, auth_required: true }],
    testing_frameworks: [{ name: 'vitest', levels: ['unit'], run_command: 'npm test', verified_runnable: false }],
    critical_components: [{ name: 'checkout', why: 'revenue path', business_criticality: 'critical', data_sensitivity: 'financial' }],
    external_dependencies: [{ name: 'stripe', kind: 'payment', reachable_in_test_env: 'mocked', side_effects: 'irreversible' }],
    gaps: ['No coverage report was produced; coverage figures are file counts only.'],
    provenance: { skill_version: '0.5.0', created_at: new Date().toISOString(), created_by: 'agent' },
  };
}
