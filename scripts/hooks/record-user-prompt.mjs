#!/usr/bin/env node
/**
 * UserPromptSubmit hook: record what the user actually said into the active testing session.
 *
 * A hold the agent attributes to the user ("you said 30 minutes, so the rest is deferred")
 * only counts toward the coverage floors when the user's words can be found. Recording them
 * here, from the prompt Claude Code really received, means the agent does not get to be the
 * only witness to what the user authorised.
 *
 * Silent and fail-open: no output, exit 0 on any error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STALE_MS = 12 * 60 * 60 * 1000;

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const { setStateRoot, stateRoot } = await import(pathToFileURL(path.join(ROOT, 'engine', 'core', 'paths.mjs')).href);
  const stateDir = stateRoot();
  const sessionFile = path.join(stateDir, 'testing-state.json');
  if (prompt && fs.existsSync(sessionFile)) {
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8').replace(/^﻿/, ''));
    if (Date.now() - new Date(session.updated_at).getTime() <= STALE_MS) {
      setStateRoot(stateDir);
      const state = await import(pathToFileURL(path.join(ROOT, 'engine', 'state-engine', 'index.mjs')).href);
      state.recordUserStatement(prompt, { source: 'hook' });
    }
  }
} catch {
  // Fail open.
}
process.exit(0);
