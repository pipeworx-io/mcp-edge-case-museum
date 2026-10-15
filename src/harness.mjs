#!/usr/bin/env node
/**
 * Edge Case Museum repro harness (fleet #3034).
 *
 * Every exhibit in src/exhibits/<category>/<id>.json
 * carries one or more `repros`. A repro is either
 *   { language: "python" | "javascript", code, expected_output, verified_with }
 * which this harness EXECUTES, or
 *   { language, status: "documented", note, source }
 * which it never claims to have run.
 *
 * The rule the museum exists on: no expected_output is typed from memory.
 * It is captured from a run (--capture), and every later run asserts it.
 *
 * Runtimes: python repros run as `python3 <file>.py`; javascript repros run
 * as `node <file>.mjs` (ES module: use `import`, not `require`). Each runs in
 * its own empty temp directory with a fixed environment (TZ=UTC,
 * LC_ALL=en_US.UTF-8, PYTHONHASHSEED=0) so the output does not depend on the
 * machine's clock zone or locale unless the repro sets them itself.
 *
 * Output: src/verified.json maps "<exhibit id>:<language>" to the sha256 of
 * (code, expected_output) and the runtime that produced it. The bake script
 * (src/bake.mjs) refuses to ship any executable
 * repro whose hash is not in that file, so an edited repro that was never
 * re-run cannot reach the pack.
 *
 * Usage:
 *   node src/harness.mjs                 check every repro; exit 1 on any mismatch
 *   node src/harness.mjs --capture       fill in expected_output where it is missing
 *   node src/harness.mjs --recapture     overwrite expected_output from the run (review the diff!)
 *   node src/harness.mjs --only <id>     restrict to exhibits whose id contains <id>
 *   node src/harness.mjs --category <c>  restrict to one category directory
 *   node src/harness.mjs --dir <path>    exhibits root (default: the pack's src/exhibits)
 *   node src/harness.mjs --no-write      do not touch verified.json (used by the red-path test)
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <pack>/src/harness.mjs, both in the Pipeworx monorepo (mcps/edge-case-museum) and in the
// standalone repo, so every path is relative to the pack root rather than to any repository root.
const PACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = PACK;
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
const DIR = path.resolve(opt('--dir') ?? path.join(PACK, 'src/exhibits'));
const VERIFIED = path.join(path.dirname(DIR), 'verified.json');
const CAPTURE = flag('--capture') || flag('--recapture');
const RECAPTURE = flag('--recapture');
const ONLY = opt('--only');
const CATEGORY = opt('--category');
const NO_WRITE = flag('--no-write');
const CONCURRENCY = Number(opt('--jobs') ?? Math.max(2, Math.min(8, os.cpus().length)));
const TIMEOUT_MS = 15_000;

export const CATEGORIES = ['unicode', 'datetime', 'float-money', 'sorting', 'filenames', 'parsing', 'integers', 'names-addresses'];
export const RUNNABLE = { python: { cmd: 'python3', ext: '.py' }, javascript: { cmd: 'node', ext: '.mjs' } };

export function reproHash(code, expected) {
  return createHash('sha256').update(String(code)).update('\0').update(String(expected)).digest('hex');
}

/** Trailing whitespace on each line and trailing blank lines are not part of the claim. */
export function normalizeOutput(s) {
  return String(s)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function runtimeVersion(lang) {
  if (lang !== 'python') return `Node.js ${process.version}`;
  try {
    return execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'python3 unavailable'; // python repros will then fail loudly as crashes, never pass
  }
}

/** Write exhibits into a fresh temp tree (<tmp>/exhibits/<category>/<id>.json) and return its root. Used by the red-path test. */
export function writeExhibitTree(exhibits) {
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'ecm-tree-')), 'exhibits');
  for (const ex of exhibits) {
    const dir = path.join(root, ex.category);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${ex.id}.json`), JSON.stringify(ex, null, 2));
  }
  return root;
}

export function loadExhibits(dir = DIR) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const cat of readdirSync(dir).sort()) {
    const cdir = path.join(dir, cat);
    if (!statSync(cdir).isDirectory()) continue;
    for (const f of readdirSync(cdir).sort()) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(cdir, f);
      let ex;
      try {
        ex = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        out.push({ file, dirCategory: cat, parseError: e.message });
        continue;
      }
      out.push({ file, dirCategory: cat, ex });
    }
  }
  return out;
}

const RELATIONS = new Set(['equal', 'not_equal', 'returns', 'no_crash', 'raises']);

/** Structural validation. Returns a list of problems (empty = valid). */
export function validateExhibit({ file, dirCategory, ex, parseError }) {
  const where = path.relative(ROOT, file);
  if (parseError) return [`${where}: invalid JSON (${parseError})`];
  const errs = [];
  const str = (k) => {
    if (typeof ex[k] !== 'string' || !ex[k].trim()) errs.push(`${where}: "${k}" must be a non-empty string`);
  };
  for (const k of ['id', 'title', 'category', 'assumption', 'what_goes_wrong', 'why', 'fix']) str(k);
  if (ex.id && path.basename(file, '.json') !== ex.id) errs.push(`${where}: file name must equal id (${ex.id})`);
  if (ex.id && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(ex.id)) errs.push(`${where}: id must be kebab-case`);
  if (!CATEGORIES.includes(ex.category)) errs.push(`${where}: category "${ex.category}" not one of ${CATEGORIES.join(', ')}`);
  if (ex.category !== dirCategory) errs.push(`${where}: category "${ex.category}" does not match its directory "${dirCategory}"`);
  if (!ex.input || typeof ex.input.display !== 'string' || !ex.input.display) errs.push(`${where}: input.display (exact value, with escapes) is required`);
  if (!Array.isArray(ex.affects) || !ex.affects.length) errs.push(`${where}: affects must list at least one stack`);
  if (!Array.isArray(ex.tags) || ex.tags.length < 2) errs.push(`${where}: tags must have at least two retrieval contexts`);
  if (!Array.isArray(ex.sources) || !ex.sources.length) errs.push(`${where}: at least one source is required`);
  for (const s of ex.sources ?? []) if (!s || typeof s.title !== 'string' || !/^https?:\/\//.test(s.url ?? '')) errs.push(`${where}: every source needs a title and an http(s) url`);
  if (!Array.isArray(ex.related)) errs.push(`${where}: related must be an array (may be empty)`);
  if (!Array.isArray(ex.repros) || !ex.repros.length) errs.push(`${where}: at least one repro is required`);
  const langs = new Set();
  for (const r of ex.repros ?? []) {
    if (!r || typeof r.language !== 'string') {
      errs.push(`${where}: repro without language`);
      continue;
    }
    if (langs.has(r.language)) errs.push(`${where}: two repros for ${r.language}`);
    langs.add(r.language);
    if (r.status === 'documented') {
      if (typeof r.note !== 'string' || !r.note) errs.push(`${where}: documented ${r.language} repro needs a note`);
      if (!/^https?:\/\//.test(r.source ?? '')) errs.push(`${where}: documented ${r.language} repro needs a source url`);
      continue;
    }
    if (!RUNNABLE[r.language]) errs.push(`${where}: ${r.language} repro is not executable here; mark it status:"documented" with a note and source`);
    if (typeof r.code !== 'string' || !r.code.trim()) errs.push(`${where}: ${r.language} repro has no code`);
  }
  if (!langs.has('python') && !langs.has('javascript')) errs.push(`${where}: needs at least one executable python or javascript repro`);
  for (const t of ex.test_cases ?? []) {
    if (!RELATIONS.has(t.relation)) errs.push(`${where}: test_case relation "${t.relation}" not one of ${[...RELATIONS].join(', ')}`);
    if (!Array.isArray(t.inputs) || !t.inputs.length) errs.push(`${where}: test_case needs inputs[]`);
    if ((t.relation === 'equal' || t.relation === 'not_equal') && t.inputs?.length !== 2) errs.push(`${where}: ${t.relation} test_case needs exactly two inputs`);
    if (t.relation === 'returns' && !('expected' in t)) errs.push(`${where}: returns test_case needs expected`);
  }
  return errs;
}

function runOne(lang, code) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ecm-'));
  const file = path.join(dir, `repro${RUNNABLE[lang].ext}`);
  writeFileSync(file, code);
  return new Promise((resolve) => {
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      TZ: 'UTC',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      PYTHONHASHSEED: '0',
      PYTHONIOENCODING: 'utf-8',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONWARNINGS: 'ignore',
      NODE_NO_WARNINGS: '1',
    };
    const child = spawn(RUNNABLE[lang].cmd, [file], { cwd: dir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ exit: code, signal, stdout, stderr });
    });
  });
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        results[k] = await fn(items[k]);
      }
    }),
  );
  return results;
}

export async function runHarness({ dir = DIR, capture = CAPTURE, recapture = RECAPTURE, only = ONLY, category = CATEGORY, write = !NO_WRITE, log = console.log } = {}) {
  const verifiedPath = path.join(path.dirname(dir), 'verified.json');
  const loaded = loadExhibits(dir).filter((e) => (!only || e.ex?.id?.includes(only)) && (!category || e.dirCategory === category));
  const problems = [];
  for (const e of loaded) problems.push(...validateExhibit(e));
  const ids = new Set();
  for (const e of loaded) {
    if (!e.ex) continue;
    if (ids.has(e.ex.id)) problems.push(`duplicate exhibit id ${e.ex.id}`);
    ids.add(e.ex.id);
  }
  const versions = { python: runtimeVersion('python'), javascript: runtimeVersion('javascript') };
  const jobs = [];
  for (const e of loaded) {
    if (!e.ex) continue;
    for (const r of e.ex.repros ?? []) if (r.status !== 'documented' && RUNNABLE[r.language] && typeof r.code === 'string') jobs.push({ e, r });
  }
  const results = await pool(jobs, CONCURRENCY, async ({ e, r }) => ({ e, r, run: await runOne(r.language, r.code) }));

  let passed = 0;
  let failed = 0;
  let captured = 0;
  const failures = [];
  const dirty = new Set();
  const verified = existsSync(verifiedPath) ? JSON.parse(readFileSync(verifiedPath, 'utf8')) : {};
  const entries = verified.repros ?? {};
  for (const { e, r, run } of results) {
    const key = `${e.ex.id}:${r.language}`;
    const actual = normalizeOutput(run.stdout);
    const crashed = run.exit !== 0 || run.signal;
    if (crashed) {
      failed++;
      failures.push({ key, file: e.file, reason: `exited ${run.signal ?? run.exit}`, stderr: run.stderr.trim().split('\n').slice(-4).join('\n') });
      delete entries[key];
      continue;
    }
    if (!actual) {
      failed++;
      failures.push({ key, file: e.file, reason: 'printed nothing (a repro must print what it demonstrates)' });
      delete entries[key];
      continue;
    }
    if (capture && (recapture || typeof r.expected_output !== 'string')) {
      if (r.expected_output !== actual || r.verified_with !== versions[r.language]) {
        r.expected_output = actual;
        r.verified_with = versions[r.language];
        dirty.add(e);
        captured++;
      }
    }
    if (typeof r.expected_output !== 'string') {
      failed++;
      failures.push({ key, file: e.file, reason: 'no expected_output (run with --capture)' });
      delete entries[key];
      continue;
    }
    if (normalizeOutput(r.expected_output) === actual) {
      passed++;
      if (r.verified_with !== versions[r.language]) {
        // Same output on a different runtime: record which runtime last confirmed it.
        r.verified_with = versions[r.language];
        dirty.add(e);
      }
      entries[key] = { sha256: reproHash(r.code, normalizeOutput(r.expected_output)), verified_with: versions[r.language] };
    } else {
      failed++;
      failures.push({ key, file: e.file, reason: 'output differs', expected: normalizeOutput(r.expected_output), actual });
      delete entries[key];
    }
  }
  // Prune verified entries for repros that no longer exist (only on a full run).
  if (!only && !category) {
    const live = new Set(jobs.map(({ e, r }) => `${e.ex.id}:${r.language}`));
    for (const k of Object.keys(entries)) if (!live.has(k)) delete entries[k];
  }
  if (write) {
    for (const e of dirty) writeFileSync(e.file, JSON.stringify(e.ex, null, 2) + '\n');
    const sorted = Object.fromEntries(Object.keys(entries).sort().map((k) => [k, entries[k]]));
    writeFileSync(
      verifiedPath,
      JSON.stringify({ _comment: 'GENERATED by src/harness.mjs. One row per executed repro that matched its expected_output; the bake refuses any repro not listed here with the same hash.', runtimes: versions, repros: sorted }, null, 2) + '\n',
    );
  }

  const documented = loaded.reduce((n, e) => n + (e.ex?.repros ?? []).filter((r) => r.status === 'documented').length, 0);
  const byCat = {};
  for (const e of loaded) if (e.ex) byCat[e.ex.category] = (byCat[e.ex.category] ?? 0) + 1;
  for (const p of problems) log(`SCHEMA  ${p}`);
  for (const f of failures) {
    log(`FAIL    ${f.key}  (${path.relative(ROOT, f.file)}): ${f.reason}`);
    if (f.stderr) log(`        stderr: ${f.stderr.replace(/\n/g, '\n                ')}`);
    if (f.expected !== undefined) {
      log(`        expected: ${JSON.stringify(f.expected)}`);
      log(`        actual:   ${JSON.stringify(f.actual)}`);
    }
  }
  log(`exhibits: ${loaded.length} (${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  log(`repros executed: ${results.length}  passed: ${passed}  failed: ${failed}  documented (not executed): ${documented}${capture ? `  captured: ${captured}` : ''}`);
  log(`runtimes: ${versions.python} · ${versions.javascript}`);
  const ok = failed === 0 && problems.length === 0;
  log(ok ? 'HARNESS GREEN' : `HARNESS RED (${failed} failing repro(s), ${problems.length} schema problem(s))`);
  return { ok, passed, failed, problems, failures, exhibits: loaded.length, byCat };
}

// realpath on both sides: through a symlinked path (macOS /tmp -> /private/tmp) a plain
// path.resolve comparison never matched, so the harness ran NOTHING and exited 0 -- green unrun.
const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (process.argv[1] && isMain()) {
  const r = await runHarness();
  process.exit(r.ok ? 0 : 1);
}
