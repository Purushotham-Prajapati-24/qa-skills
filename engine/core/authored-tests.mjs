/**
 * Authored-test detection.
 *
 * Agents write tests and then leave them on hold ("drafted so it is ready either way"). A
 * test that never ran proves nothing, so `validate --final` needs to know which test files
 * were written during the session -- without asking the agent, which would be self-report.
 *
 * At session start, every test file in the repository under test is content-hashed into a
 * baseline. At check time, any test file that is new or whose content differs from the
 * baseline was authored this session. Content hashes, not mtimes: touching a file does not
 * make it "new", and back-dating one does not hide it. Works with or without git (git only
 * makes enumeration faster and respects .gitignore).
 *
 * Every function fails closed -- an unreadable tree yields "nothing detected", never a throw.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const CODE_EXT = /\.(c?m?[jt]sx?|py|go|rb|java|kt|cs|php|rs|feature|robot)$/i;
const TEST_NAME = /([._-](test|spec|e2e|cy)\.[a-z0-9]+$)|(^test_[^/]+\.py$)|(_test\.(go|py|rb)$)|(Tests?\.(java|kt|cs)$)/i;
const TEST_DIR = /(^|\/)(__tests__|tests?|e2e|specs?|cypress|playwright|integration-tests?)\//i;
const IGNORED_DIR = /(^|\/)(node_modules|\.git|dist|build|coverage|test-results|playwright-report|\.testing-state|\.claude|vendor|target|\.venv|venv|__pycache__)\//i;
const MAX_FILES = 20000;
const MAX_BYTES = 5 * 1024 * 1024;

export function isTestFile(rel) {
  const f = rel.replace(/\\/g, '/');
  if (IGNORED_DIR.test(`/${f}`) || !CODE_EXT.test(f)) return false;
  return TEST_NAME.test(path.posix.basename(f)) || TEST_DIR.test(f);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
}

function gitRoot(cwd) {
  try { return git(['rev-parse', '--show-toplevel'], cwd).trim(); } catch { return null; }
}

/** Repository-relative candidate paths: git-aware when possible, a bounded walk otherwise. */
function listFiles(root, viaGit) {
  if (viaGit) {
    const out = new Set();
    for (const args of [['ls-files'], ['ls-files', '--others', '--exclude-standard']]) {
      try { git(args, root).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((n) => out.add(n)); } catch { /* ignore */ }
    }
    return [...out];
  }
  const out = [];
  const walk = (rel, depth) => {
    if (out.length >= MAX_FILES || depth > 12) return;
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!IGNORED_DIR.test(`/${child}/`)) walk(child, depth + 1);
      } else if (ent.isFile()) {
        out.push(child);
      }
    }
  };
  walk('', 0);
  return out;
}

function hashFile(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Content-hash every test file under the repository containing `cwd`.
 * @returns {{root: string, via: 'git'|'walk', files: Record<string,string>}}
 */
export function snapshotTestFiles({ cwd = process.cwd(), excludeDir = null } = {}) {
  const groot = gitRoot(cwd);
  const root = path.resolve(groot ?? cwd);
  const excluded = excludeDir ? path.resolve(excludeDir) : null;
  const files = {};
  for (const rel of listFiles(root, Boolean(groot))) {
    const norm = rel.replace(/\\/g, '/');
    if (!isTestFile(norm)) continue;
    const abs = path.join(root, norm);
    if (excluded && path.resolve(abs).startsWith(excluded + path.sep)) continue;
    const h = hashFile(abs);
    if (h) files[norm] = h;
  }
  return { root, via: groot ? 'git' : 'walk', files };
}

/**
 * Test files authored this session: new or changed relative to the baseline snapshot.
 * Without a usable baseline (an older session, or a check run from a different repository),
 * falls back to "changed relative to git and modified after the session began".
 * @returns {null | string[]} null only when nothing can be determined.
 */
export function authoredTestFiles({ cwd = process.cwd(), baseline = null, since = null, baseCommit = null, excludeDir = null }) {
  const now = snapshotTestFiles({ cwd, excludeDir });
  if (baseline?.root && path.resolve(baseline.root) === now.root) {
    return Object.keys(now.files).filter((f) => baseline.files?.[f] !== now.files[f]).sort();
  }
  if (!since) return null;
  const sinceMs = new Date(since).getTime();
  const changed = new Set();
  if (now.via === 'git') {
    try { git(['ls-files', '--others', '--exclude-standard'], now.root).split(/\r?\n/).filter(Boolean).forEach((n) => changed.add(n.trim())); } catch { /* ignore */ }
    try { git(['diff', '--name-only', baseCommit || 'HEAD'], now.root).split(/\r?\n/).filter(Boolean).forEach((n) => changed.add(n.trim())); } catch { /* ignore */ }
  } else {
    Object.keys(now.files).forEach((f) => changed.add(f));
  }
  return [...changed]
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => now.files[f])
    .filter((f) => {
      try { return fs.statSync(path.join(now.root, f)).mtimeMs >= sinceMs; } catch { return false; }
    })
    .sort();
}

/**
 * Did this execution run `file`? The command line naming it, or a per-test result from it, is
 * proof. A `test_files` declaration alone is accepted only when it names a single file (a
 * whole-suite command like `npm test` that ran the one test just written). A batch declaration
 * is not proof that each listed file ran -- only that the agent said so.
 */
export function executionRanFile(e, file) {
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/^\.\//, '');
  const f = norm(file);
  const base = path.posix.basename(f);
  if (e.command && (norm(e.command).includes(f) || norm(e.command).includes(base))) return true;
  if ((e.test_results ?? []).some((t) => t.file && norm(t.file).endsWith(base))) return true;
  const declared = (e.test_files ?? []).map(norm);
  return declared.length === 1 && (declared[0] === f || declared[0].endsWith(`/${f}`) || f.endsWith(`/${declared[0]}`));
}
