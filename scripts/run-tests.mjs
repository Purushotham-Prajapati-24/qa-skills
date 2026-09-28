#!/usr/bin/env node
// `npm test`: runs tests/*.test.mjs by explicit file list. `node --test "tests/*.test.mjs"`
// needs Node >= 21 to expand the glob itself; package.json supports Node >= 20.6.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = fs.readdirSync(path.join(root, 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join('tests', f));

const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
