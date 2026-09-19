/**
 * Git provenance capture.
 *
 * Every execution/evidence/finding schema already has an optional `git` field
 * (common.schema.json#gitRef), but nothing ever populated it automatically -- it existed
 * only as agent-suppliable input, which no field trial ever supplied. That is why
 * `reproducibility` (execution.git?.commit && environment && command) was structurally 0
 * in every trial, and why a rendered report's footer once claimed traceability to a
 * commit it never named.
 *
 * Auto-detected, never required: the repository under test may not be a git repository at
 * all (a fresh scaffold, a zip export, a non-VCS deliverable), and testing it is still
 * legitimate. Every git invocation here fails closed to `undefined`/`null` on any error --
 * wrong directory, git not installed, not a repository, zero commits yet -- rather than
 * throwing. "We could not detect git provenance" must never itself become a reason
 * testing cannot start.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
}

/**
 * Best-effort "owner/repo"-shaped short name from the `origin` remote, matching the
 * convention already used across this codebase's own examples (`"acme/shop"`). Returns
 * the raw remote URL if it doesn't match that shape, and null if there is no remote at
 * all -- distinct from "not a git repo", which the caller handles separately.
 */
function shortRepoName(cwd) {
  let url;
  try {
    url = git(['remote', 'get-url', 'origin'], cwd);
  } catch {
    return null;
  }
  // https://github.com/owner/repo.git , git@github.com:owner/repo.git , https://host/owner/repo
  const m = /[/:]([^/:]+\/[^/:]+?)(?:\.git)?\/?$/.exec(url);
  return m ? m[1] : url;
}

/**
 * @param {string} [cwd] Directory to inspect. Defaults to the process's own working
 *   directory -- this system's own stated convention is that it is always the repository
 *   under test.
 * @returns {null | {repository: string, branch?: string, commit?: string, dirty?: boolean}}
 *   `null` when this is not a git repository at all (or git itself is unavailable) --
 *   never a partially-filled object standing in for "nothing detected". `repository` is
 *   required by the schema whenever a git object is present, so a repo with no `origin`
 *   remote falls back to its own directory name rather than omitting a required field.
 */
export function captureGitInfo(cwd = process.cwd()) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
  } catch {
    return null; // not a git repository (or git is not installed) -- nothing to capture
  }

  const info = {};

  const remoteName = shortRepoName(cwd);
  info.repository = remoteName ?? path.basename(path.resolve(cwd));

  // Each independently optional: a fresh repository can have a remote and a branch but
  // zero commits yet (no HEAD), and none of these absences should suppress the others.
  try { info.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd); } catch { /* detached or no commits yet */ }
  try { info.commit = git(['rev-parse', 'HEAD'], cwd); } catch { /* no commits yet */ }
  try { info.dirty = git(['status', '--porcelain'], cwd).length > 0; } catch { /* leave unset */ }

  return info;
}

/**
 * `explicit` always wins when the caller actually supplied it -- including an explicit
 * `null`, which is how a skill says "no git context for this specific record" even though
 * the session has one (evidence about a non-git-tracked artifact; a target outside the
 * session's own repository). Only a genuinely OMITTED argument (`undefined`) falls back to
 * the session's own captured git info, then to nothing. This is why the three call sites
 * (execution.start, evidence.add, defects.create) must destructure `git` with no default
 * of its own -- a `git = null` default would make "omitted" and "explicitly null"
 * indistinguishable by the time this function ever saw the value.
 */
export function inheritedGit(explicit, session) {
  return explicit !== undefined ? explicit : (session?.git ?? null);
}
