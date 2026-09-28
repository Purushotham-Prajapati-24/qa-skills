/**
 * Minimal JUnit XML reader (node --test --test-reporter=junit, Playwright, Jest, pytest,
 * Vitest all emit it). Zero dependencies on purpose: it reads <testcase> elements and
 * their <failure>/<error>/<skipped> children, which is all a per-test status needs.
 */

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

function decode(s) {
  return String(s ?? '').replace(/&(lt|gt|quot|apos|amp);/g, (m) => ENTITIES[m]);
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[3] ?? m[4]);
  return out;
}

/** @returns {Array<{name, suite, status, duration_ms, message}>} test-result-shaped records */
export function parseJUnit(xml) {
  const text = String(xml ?? '');
  if (!/<testsuites?\b|<testcase\b/.test(text)) {
    throw new Error('Not a JUnit XML document: no <testsuite(s)> or <testcase> element found.');
  }
  const results = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of text.matchAll(re)) {
    const a = attrs(m[1]);
    const body = m[3] ?? '';
    let status = 'PASSED';
    let message;
    const fail = body.match(/<(failure|error)\b([^>]*)/);
    if (fail || a.failure !== undefined) {
      status = fail?.[1] === 'error' ? 'INCONCLUSIVE' : 'FAILED';
      message = attrs(fail?.[2] ?? '').message ?? a.failure;
    } else if (/<skipped\b/.test(body)) {
      status = 'SKIPPED';
    }
    const seconds = Number(a.time);
    results.push({
      name: a.name ?? '(unnamed test)',
      ...(a.classname ? { suite: a.classname } : {}),
      status,
      ...(Number.isFinite(seconds) ? { duration_ms: Math.round(seconds * 1000) } : {}),
      ...(message ? { message: message.slice(0, 500) } : {}),
    });
  }
  return results;
}
