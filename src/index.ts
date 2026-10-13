interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Edge Case Museum MCP — "Your code works. Except for these wonderfully
 * terrible inputs."
 *
 * Describe what you are implementing ("username uniqueness", "parse a CSV
 * upload", "store an amount of money", "schedule a reminder in the user's
 * timezone") and get back the surprising inputs that break that kind of code:
 * the assumption each one breaks, the exact input, what goes wrong and why,
 * a repro in Python and JavaScript whose output was captured by actually
 * running it, the safer pattern, and the spec or documentation that explains
 * it.
 *
 * Data: a curated collection written for this pack, one JSON file per exhibit
 * (src/exhibits/<category>/<id>.json). Every executable
 * repro's expected_output was produced by src/harness.mjs
 * running it (the runtime is named in `verified_with`); stacks we could not
 * execute are labelled `documented`, with a cited source, never as verified.
 * Some inputs come from the Big List of Naughty Strings (MIT licence,
 * https://github.com/minimaxir/big-list-of-naughty-strings) and are attributed
 * per exhibit.
 *
 * The collection is a generated module (src/ecm-index-data.ts, written by
 * src/bake.mjs) that the gateway injects as
 * `args._bakedIndex` (workers/gateway/src/pack-baked-indexes.json). NEVER
 * value-import that module here; a type-only import is erased.
 *
 * No upstream calls and no model in the request path: retrieval is keyword and
 * tag scoring over the exhibits.
 *
 * Tools:
 *  - edge_cases_find       what you are implementing -> the relevant exhibits, with a repro in your language
 *  - edge_case_get         one exhibit in full: every repro, the why, the fix, sources
 *  - edge_cases_browse     the collection by category or tag
 *  - edge_cases_test_file  a runnable pytest / node:test file of the relevant inputs, pointed at your function
 */

import type { Exhibit, Repro, TestCase } from './ecm-index-data.js';

const CATEGORY_LABELS: Record<string, string> = {
  unicode: 'Unicode: normalization, confusables, invisible characters, case mapping, length',
  datetime: 'Dates and time: DST gaps and overlaps, offsets, leap days and seconds, 2038, week years',
  'float-money': 'Floating point and money: binary fractions, rounding modes, -0, NaN, currency minor units',
  sorting: 'Sorting and comparison: collation, locale, stability, natural order, comparators',
  filenames: 'Filenames and paths: reserved names, traversal, case, length, extensions',
  parsing: 'Parsing: CSV quoting and BOMs, JSON duplicates and big numbers, URLs, email addresses',
  integers: 'Integers: overflow, precision limits, parseInt, division and modulo signs',
  'names-addresses': 'Names and addresses: name order, mononyms, scripts, postal codes, house numbers',
};

// ───────────────────────── baked index ─────────────────────────

interface Index {
  exhibits: Exhibit[];
  byId: Map<string, Exhibit>;
  data_as_of: string;
  runtimes: Record<string, string>;
  idf: Map<string, number>;
  docs: Map<string, { tags: Set<string>; tagTokens: Set<string>; title: Set<string>; body: Set<string>; deep: Set<string> }>;
}

let INDEX: Index | null = null;
let INDEX_SRC: unknown = null;

function ensureIndex(args: Record<string, unknown>): Index {
  const raw = args._bakedIndex as Record<string, unknown> | null | undefined;
  if (INDEX && raw === INDEX_SRC) return INDEX;
  const exhibits = raw?.EXHIBITS as Exhibit[] | undefined;
  const data_as_of = raw?.DATA_AS_OF as string | undefined;
  if (!Array.isArray(exhibits) || exhibits.length < 10 || !data_as_of) {
    // Loud by design: a missing index would otherwise answer "no match" to every question.
    throw new Error(
      `edge-case-museum: collection unavailable (${Array.isArray(exhibits) ? exhibits.length : 'no'} exhibits loaded); ` +
        'the generated index (static-json:baked-index:edge-case-museum) was not injected. Retry; if it persists this is a deploy defect, not an answer.',
    );
  }
  const byId = new Map(exhibits.map((e) => [e.id, e]));
  const docs: Index['docs'] = new Map();
  const df = new Map<string, number>();
  for (const e of exhibits) {
    const tags = new Set(e.tags.map((t) => t.toLowerCase()));
    const tagTokens = new Set(e.tags.flatMap((t) => tokens(t)));
    const title = new Set(tokens(e.title));
    const body = new Set([...tokens(e.assumption), ...tokens(e.what_goes_wrong), ...tokens(e.input.description ?? ''), ...tokens(e.category.replace('-', ' '))]);
    const deep = new Set([...tokens(e.why), ...tokens(e.fix)]);
    docs.set(e.id, { tags, tagTokens, title, body, deep });
    for (const t of new Set([...tagTokens, ...title, ...body, ...deep])) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = exhibits.length;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log(1 + n / c));
  INDEX = { exhibits, byId, data_as_of, runtimes: (raw?.RUNTIMES ?? {}) as Record<string, string>, idf, docs };
  INDEX_SRC = raw;
  return INDEX;
}

// ───────────────────────── text matching ─────────────────────────

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with', 'without', 'is', 'are', 'be', 'by', 'from', 'that', 'this', 'it', 'as', 'at', 'into', 'i', 'we', 'my', 'our', 'their', 'user', 'users', 'need', 'want', 'how', 'what', 'which', 'implement', 'implementing', 'build', 'building', 'write', 'writing', 'handle', 'handling', 'code', 'function', 'some', 'up', 'do', 'make', 'new', 'via', 's']);

function stem(w: string): string {
  if (w.length <= 3) return w;
  return w
    .replace(/ies$/, 'y')
    .replace(/(ations?|ition)$/, '')
    .replace(/(ing|ed|es|s)$/, '')
    .replace(/e$/, '');
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

/** Developer phrasing -> the vocabulary exhibits are tagged with. Values are expanded at half weight. */
const SYNONYMS: Record<string, string[]> = {
  username: ['login', 'uniqueness', 'signup', 'account'],
  handle: ['username'],
  signup: ['username', 'uniqueness', 'login'],
  register: ['username', 'uniqueness', 'signup'],
  unique: ['uniqueness'],
  duplicate: ['uniqueness'],
  dedupe: ['uniqueness'],
  money: ['currency', 'price', 'rounding', 'invoice', 'accounting'],
  amount: ['money', 'currency'],
  price: ['money', 'currency'],
  payment: ['money', 'currency'],
  balance: ['money', 'accounting'],
  total: ['money', 'sum'],
  add: ['sum'],
  cents: ['money', 'currency'],
  dollar: ['money', 'currency'],
  tax: ['money', 'rounding'],
  csv: ['parsing', 'upload', 'spreadsheet'],
  spreadsheet: ['csv'],
  excel: ['csv', 'spreadsheet'],
  import: ['upload', 'parsing'],
  upload: ['filename', 'path'],
  file: ['filename', 'path'],
  json: ['parsing'],
  api: ['json', 'parsing'],
  sort: ['sorting', 'comparison', 'collation'],
  order: ['sorting'],
  alphabetical: ['sorting', 'collation'],
  compare: ['comparison'],
  timezone: ['scheduling', 'dst', 'reminder'],
  zone: ['timezone'],
  schedule: ['scheduling', 'timezone', 'reminder'],
  reminder: ['scheduling', 'timezone'],
  calendar: ['scheduling', 'date'],
  date: ['timestamps', 'date parsing'],
  time: ['timestamps', 'timezone'],
  birthday: ['age calculation', 'date'],
  age: ['age calculation'],
  email: ['validation', 'parsing'],
  name: ['names'],
  person: ['names'],
  address: ['addresses', 'forms'],
  postal: ['addresses'],
  zip: ['addresses'],
  form: ['forms', 'validation'],
  validate: ['validation'],
  id: ['counter', 'json'],
  integer: ['counter', 'id'],
  number: ['parsing', 'integer'],
  url: ['parsing', 'security'],
  link: ['url'],
  path: ['filename', 'security'],
  search: ['normalization', 'comparison'],
  truncate: ['truncation', 'length validation'],
  length: ['length validation', 'truncation'],
  limit: ['length validation'],
  display: ['rendering'],
  slug: ['url', 'normalization'],
};

interface Scored {
  ex: Exhibit;
  score: number;
  matched: string[];
}

function score(idx: Index, context: string): Scored[] {
  const lower = context.toLowerCase();
  const base = tokens(context);
  const weights = new Map<string, number>();
  for (const t of base) weights.set(t, Math.max(weights.get(t) ?? 0, 1));
  for (const w of lower.split(/[^a-z0-9]+/).filter(Boolean)) {
    for (const syn of SYNONYMS[w] ?? SYNONYMS[stem(w)] ?? []) for (const t of tokens(syn)) if (!weights.has(t)) weights.set(t, 0.5);
  }
  const out: Scored[] = [];
  for (const ex of idx.exhibits) {
    const d = idx.docs.get(ex.id)!;
    let s = 0;
    const matched = new Set<string>();
    // A whole tag phrase present in the context is the strongest signal ("date parsing", "csv").
    for (const tag of d.tags) {
      const tt = tokens(tag);
      if (tt.length && tt.every((t) => weights.has(t))) {
        const w = Math.min(...tt.map((t) => weights.get(t)!));
        s += 4 * w * (tt.length > 1 ? 1.5 : 1);
        matched.add(tag);
      }
    }
    for (const [t, w] of weights) {
      const rare = idx.idf.get(t) ?? 0;
      if (!rare) continue;
      if (d.tagTokens.has(t)) s += 1.5 * w * rare;
      if (d.title.has(t)) s += 1.2 * w * rare;
      if (d.body.has(t)) s += 0.6 * w * rare;
      if (d.deep.has(t)) s += 0.2 * w * rare;
    }
    if (s > 0) out.push({ ex, score: s, matched: [...matched] });
  }
  out.sort((a, b) => b.score - a.score || a.ex.id.localeCompare(b.ex.id));
  return out;
}

// ───────────────────────── shaping ─────────────────────────

type Lang = 'python' | 'javascript';

function normLang(v: unknown): Lang | null {
  if (v == null || v === '') return null;
  const s = String(v).toLowerCase().trim();
  if (['python', 'py', 'python3', 'pytest'].includes(s)) return 'python';
  if (['javascript', 'js', 'node', 'nodejs', 'node.js', 'typescript', 'ts', 'ecmascript', 'mjs'].includes(s)) return 'javascript';
  throw new Error(`edge-case-museum: language "${String(v)}" has no executed repros. Use "python" or "javascript" (node and typescript map to javascript).`);
}

function verifiedRepro(ex: Exhibit, lang: Lang): Repro | undefined {
  return ex.repros.find((r) => r.language === lang && r.status === 'verified');
}

function reproOut(r: Repro) {
  return r.status === 'verified'
    ? { language: r.language, status: r.status, code: r.code, expected_output: r.expected_output, verified_with: r.verified_with }
    : { language: r.language, status: r.status, note: r.note, source: r.source };
}

function summary(ex: Exhibit, lang: Lang | null, matched?: string[]) {
  const languages = ex.repros.map((r) => `${r.language}${r.status === 'documented' ? ' (documented)' : ''}`);
  const out: Record<string, unknown> = {
    id: ex.id,
    title: ex.title,
    category: ex.category,
    assumption: ex.assumption,
    input: ex.input.display,
    what_goes_wrong: ex.what_goes_wrong,
    fix: ex.fix,
  };
  if (lang) {
    const r = verifiedRepro(ex, lang);
    out.repro = r ? reproOut(r) : null;
    if (!r) out.repro_note = `No executed ${lang} repro for this exhibit; it has: ${languages.join(', ')}. edge_case_get returns them.`;
  } else {
    const first = ex.repros.find((r) => r.status === 'verified');
    out.repro = first ? reproOut(first) : null;
  }
  out.languages = languages;
  if (matched?.length) out.matched_tags = matched;
  return out;
}

function refineTags(list: Exhibit[], exclude: Set<string>, max = 15): string[] {
  const counts = new Map<string, number>();
  for (const ex of list) for (const t of ex.tags) if (!exclude.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([t]) => t);
}

function provenance(idx: Index) {
  return {
    data_as_of: idx.data_as_of,
    total_exhibits: idx.exhibits.length,
    verification: `expected_output for every "verified" repro was captured by executing it (${Object.values(idx.runtimes).join(', ') || 'see verified_with'}); "documented" repros were not executed and cite their source.`,
    collection: 'Edge Case Museum by Mojibake, creators of Pipeworx (https://pipeworx.io)',
  };
}

// ───────────────────────── test file generation ─────────────────────────

function pyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp <= 0xff) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, '0')}`;
    else out += `\\U${cp.toString(16).padStart(8, '0')}`;
  }
  return out + '"';
}

function toPy(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'string') return pyString(v);
  if (Array.isArray(v)) return `[${v.map(toPy).join(', ')}]`;
  if (typeof v === 'object') return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyString(k)}: ${toPy(x)}`).join(', ')}}`;
  return pyString(String(v));
}

function jsString(s: string): string {
  // Escape every UTF-16 code unit outside printable ASCII, so invisible and bidi characters stay visible in the file.
  let out = "'";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === "'") out += "\\'";
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else out += `\\u${c.toString(16).padStart(4, '0')}`;
  }
  return out + "'";
}

function toJs(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return jsString(v);
  if (Array.isArray(v)) return `[${v.map(toJs).join(', ')}]`;
  if (typeof v === 'object') return `{ ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${jsString(k)}: ${toJs(x)}`).join(', ')} }`;
  return jsString(String(v));
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

interface Case {
  exhibit: string;
  title: string;
  tc: TestCase;
}

function pythonFile(context: string, cases: Case[], idx: Index): string {
  const rows = cases
    .map(
      (c) =>
        `    # ${oneLine(c.title)}\n    pytest.param(${pyString(c.tc.relation)}, ${toPy(c.tc.inputs)}, ${toPy(c.tc.relation === 'returns' ? c.tc.expected : null)}, ${pyString(oneLine(c.tc.note ?? c.title))}, id=${pyString(c.exhibit)}),`,
    )
    .join('\n');
  return `"""Edge-case tests for: ${oneLine(context).replace(/"""/g, "'''")}

Generated by the Edge Case Museum (by Mojibake, creators of Pipeworx: https://pipeworx.io).
Each case is one museum exhibit; edge_case_get({"id": "<case id>"}) explains the
input, what goes wrong, and why. Collection as of ${idx.data_as_of}.

Run:  pytest ${'test_edge_cases.py'}
"""
import pytest


# TODO: point SUBJECT at the function you are testing, for example
#   from myapp.accounts import canonical_username as SUBJECT
def SUBJECT(value):
    # TODO: replace this stub. It returns its input unchanged, so most cases
    # fail until SUBJECT is your real function. That is the point.
    return value


CASES = [
${rows}
]


@pytest.mark.parametrize("relation, inputs, expected, note", CASES)
def test_edge_case(relation, inputs, expected, note):
    if relation == "equal":
        # Both inputs should end up the same after your function (e.g. the same canonical username).
        assert SUBJECT(inputs[0]) == SUBJECT(inputs[1]), note
    elif relation == "not_equal":
        # These must stay distinguishable after your function.
        assert SUBJECT(inputs[0]) != SUBJECT(inputs[1]), note
    elif relation == "returns":
        # TODO: if your function returns a different shape, adapt this comparison.
        assert SUBJECT(inputs[0]) == expected, note
    elif relation == "raises":
        # Your function should reject this input rather than accept it.
        with pytest.raises(Exception):
            SUBJECT(inputs[0])
    elif relation == "no_crash":
        for value in inputs:
            SUBJECT(value)
    else:
        pytest.fail(f"unknown relation {relation!r}")
`;
}

function jsFile(context: string, cases: Case[], idx: Index): string {
  const rows = cases
    .map(
      (c) =>
        `  // ${oneLine(c.title)}\n  { exhibit: ${jsString(c.exhibit)}, relation: ${jsString(c.tc.relation)}, inputs: ${toJs(c.tc.inputs)}, expected: ${toJs(c.tc.relation === 'returns' ? c.tc.expected : null)}, note: ${jsString(oneLine(c.tc.note ?? c.title))} },`,
    )
    .join('\n');
  return `// Edge-case tests for: ${oneLine(context)}
//
// Generated by the Edge Case Museum (by Mojibake, creators of Pipeworx: https://pipeworx.io).
// Each case is one museum exhibit; edge_case_get({ id: "<exhibit>" }) explains the
// input, what goes wrong, and why. Collection as of ${idx.data_as_of}.
//
// Run:  node --test edge-cases.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// TODO: import the function you are testing and use it as subject, for example
//   import { canonicalUsername as subject } from './accounts.js';
function subject(value) {
  // TODO: replace this stub. It returns its input unchanged, so most cases
  // fail until subject is your real function. That is the point.
  return value;
}

const CASES = [
${rows}
];

for (const c of CASES) {
  test(\`\${c.exhibit}: \${c.note}\`, () => {
    switch (c.relation) {
      case 'equal':
        // Both inputs should end up the same after your function.
        assert.deepStrictEqual(subject(c.inputs[0]), subject(c.inputs[1]), c.note);
        break;
      case 'not_equal':
        assert.notDeepStrictEqual(subject(c.inputs[0]), subject(c.inputs[1]), c.note);
        break;
      case 'returns':
        // TODO: if your function returns a different shape, adapt this comparison.
        assert.deepStrictEqual(subject(c.inputs[0]), c.expected, c.note);
        break;
      case 'raises':
        assert.throws(() => subject(c.inputs[0]), undefined, c.note);
        break;
      case 'no_crash':
        for (const v of c.inputs) subject(v);
        break;
      default:
        assert.fail(\`unknown relation \${c.relation}\`);
    }
  });
}
`;
}

// ───────────────────────── tools ─────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'edge_cases_find',
    description:
      'Edge Case Museum: describe what you are implementing in plain words ("username uniqueness", "parse a CSV upload", "store and add up money amounts", "schedule a reminder in the user\'s timezone", "sort customer names") and get the surprising inputs that break that kind of code. Each exhibit gives the assumption it breaks, the exact input with escapes, what goes wrong, the fix, and a repro in your language whose expected_output was captured by actually running it (Python 3 or Node.js). Returns a short form plus refine_tags; use edge_case_get for the full exhibit or edge_cases_test_file for a runnable test file. Curated collection, keyword and tag matching, no upstream calls.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        context: { type: 'string', description: 'What you are implementing, in plain words, e.g. "username uniqueness" or "parse a CSV upload".' },
        language: { type: 'string', enum: ['python', 'javascript'], description: 'Language of the repro to include with each exhibit. "javascript" means Node.js. Omit for the first available repro.' },
        limit: { type: 'number', description: 'Maximum exhibits to return (default 8, max 25).' },
      },
      required: ['context'],
    },
  },
  {
    name: 'edge_case_get',
    description:
      'Edge Case Museum: one exhibit in full by id (from edge_cases_find or edge_cases_browse): the assumption it breaks, the exact input, what goes wrong and why, every repro (executed Python/Node.js repros with their captured output and runtime version; other stacks labelled documented with a source), the fix, related exhibits, cited sources and test inputs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Exhibit id, e.g. "nfc-nfd-same-name-two-accounts".' },
      },
      required: ['id'],
    },
  },
  {
    name: 'edge_cases_browse',
    description:
      'Edge Case Museum: browse the collection. With no arguments, lists the categories (unicode, datetime, float-money, sorting, filenames, parsing, integers, names-addresses) with counts and their most common tags. With category or tag, lists the exhibits in it: id, title, the assumption each breaks, tags and which languages have executed repros.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', enum: ['unicode', 'datetime', 'float-money', 'sorting', 'filenames', 'parsing', 'integers', 'names-addresses'], description: 'Category to list.' },
        tag: { type: 'string', description: 'Tag to list, e.g. "username", "csv", "timezone", "money".' },
      },
    },
  },
  {
    name: 'edge_cases_test_file',
    description:
      'Edge Case Museum: one runnable test file (pytest for python, node:test for javascript) bundling the inputs from the exhibits relevant to what you are implementing, as parametrized cases you point at your own function. The file runs as generated against a stub, with TODO marks where your function goes; each case names its exhibit id so edge_case_get can explain a failure.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        context: { type: 'string', description: 'What you are implementing, e.g. "parse a CSV upload".' },
        language: { type: 'string', enum: ['python', 'javascript'], description: 'python produces a pytest file; javascript produces a node:test file.' },
      },
      required: ['context', 'language'],
    },
  },
];

function requireString(args: Record<string, unknown>, k: string): string {
  const v = args[k];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`edge-case-museum: "${k}" is required (a non-empty string).`);
  return v.trim();
}

function find(args: Record<string, unknown>) {
  const idx = ensureIndex(args);
  const context = requireString(args, 'context');
  const lang = normLang(args.language);
  const limit = Math.max(1, Math.min(25, Math.floor(Number(args.limit ?? 8)) || 8));
  let ranked = score(idx, context);
  if (lang) {
    // An exhibit with no executed repro in the requested language still counts, ranked below those that have one.
    ranked = ranked.map((s) => ({ ...s, score: verifiedRepro(s.ex, lang) ? s.score : s.score * 0.6 })).sort((a, b) => b.score - a.score || a.ex.id.localeCompare(b.ex.id));
  }
  const top = ranked.slice(0, limit);
  const queryTags = new Set(top.flatMap((s) => s.matched));
  if (!top.length) {
    return {
      context,
      count: 0,
      exhibits: [],
      no_match: `No exhibit matched "${context}". Describe the code in terms of what it handles (usernames, money, CSV, timezones, filenames, sorting, names) or browse a category.`,
      categories: Object.keys(CATEGORY_LABELS),
      ...provenance(idx),
    };
  }
  return {
    context,
    language: lang,
    count: top.length,
    more_available: Math.max(0, ranked.length - top.length),
    exhibits: top.map((s) => summary(s.ex, lang, s.matched)),
    refine_tags: refineTags(top.map((s) => s.ex), queryTags),
    next: 'edge_case_get({id}) for the full exhibit and sources; edge_cases_test_file({context, language}) for a runnable test file of these inputs.',
    ...provenance(idx),
  };
}

function get(args: Record<string, unknown>) {
  const idx = ensureIndex(args);
  const id = requireString(args, 'id').toLowerCase();
  const ex = idx.byId.get(id);
  if (!ex) {
    const near = score(idx, id.replace(/-/g, ' ')).slice(0, 5).map((s) => s.ex.id);
    throw new Error(`edge-case-museum: no exhibit with id "${id}".${near.length ? ` Closest: ${near.join(', ')}.` : ''} edge_cases_browse lists every id.`);
  }
  return {
    ...ex,
    repros: ex.repros.map(reproOut),
    related: ex.related.map((r) => ({ id: r, title: idx.byId.get(r)?.title ?? null })),
    category_label: CATEGORY_LABELS[ex.category] ?? ex.category,
    ...provenance(idx),
  };
}

function browse(args: Record<string, unknown>) {
  const idx = ensureIndex(args);
  const category = typeof args.category === 'string' && args.category.trim() ? args.category.trim().toLowerCase() : null;
  const tag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim().toLowerCase() : null;
  if (category && !CATEGORY_LABELS[category]) throw new Error(`edge-case-museum: unknown category "${category}". Categories: ${Object.keys(CATEGORY_LABELS).join(', ')}.`);
  if (!category && !tag) {
    return {
      categories: Object.entries(CATEGORY_LABELS).map(([c, label]) => {
        const list = idx.exhibits.filter((e) => e.category === c);
        return { category: c, label, count: list.length, top_tags: refineTags(list, new Set(), 8), example: list[0] ? { id: list[0].id, title: list[0].title } : null };
      }),
      ...provenance(idx),
    };
  }
  let list = idx.exhibits;
  if (category) list = list.filter((e) => e.category === category);
  if (tag) list = list.filter((e) => e.tags.some((t) => t.toLowerCase() === tag));
  if (!list.length) {
    const all = refineTags(category ? idx.exhibits.filter((e) => e.category === category) : idx.exhibits, new Set(), 40);
    throw new Error(`edge-case-museum: no exhibits with tag "${tag}"${category ? ` in ${category}` : ''}. Tags in use include: ${all.join(', ')}.`);
  }
  return {
    category,
    category_label: category ? CATEGORY_LABELS[category] : null,
    tag,
    count: list.length,
    exhibits: list.map((e) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      assumption: e.assumption,
      tags: e.tags,
      languages: e.repros.map((r) => `${r.language}${r.status === 'documented' ? ' (documented)' : ''}`),
    })),
    ...provenance(idx),
  };
}

function testFile(args: Record<string, unknown>) {
  const idx = ensureIndex(args);
  const context = requireString(args, 'context');
  const lang = normLang(args.language);
  if (!lang) throw new Error('edge-case-museum: "language" is required: "python" (pytest) or "javascript" (node:test).');
  const all = score(idx, context);
  // One test file targets ONE function, so keep to the kind of code the context is about: the categories of
  // the strongest matches, and nothing scoring under half the best match (a CSV parser should not be handed
  // filename cases just because both mention "upload").
  const focus = new Set(all.slice(0, 3).map((s) => s.ex.category));
  const best = all[0]?.score ?? 0;
  const ranked = all.filter((s) => s.ex.test_cases.length && focus.has(s.ex.category) && s.score >= best * 0.5);
  const used = ranked.slice(0, 12);
  if (!used.length) {
    throw new Error(`edge-case-museum: no exhibit relevant to "${context}" carries test inputs yet. Try edge_cases_find to see the relevant exhibits and their repros.`);
  }
  const cases: Case[] = used.flatMap((s) => s.ex.test_cases.map((tc) => ({ exhibit: s.ex.id, title: s.ex.title, tc })));
  const content = lang === 'python' ? pythonFile(context, cases, idx) : jsFile(context, cases, idx);
  return {
    context,
    language: lang,
    framework: lang === 'python' ? 'pytest' : 'node:test',
    filename: lang === 'python' ? 'test_edge_cases.py' : 'edge-cases.test.mjs',
    run: lang === 'python' ? 'pytest test_edge_cases.py' : 'node --test edge-cases.test.mjs',
    cases: cases.length,
    exhibits: used.map((s) => ({ id: s.ex.id, title: s.ex.title })),
    how_to_use: 'Save the file, replace the stub (marked TODO) with your own function, and run it. Against the stub most cases fail by design; each failure names the exhibit id that explains it.',
    content,
    ...provenance(idx),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'edge_cases_find':
      return find(args);
    case 'edge_case_get':
      return get(args);
    case 'edge_cases_browse':
      return browse(args);
    case 'edge_cases_test_file':
      return testFile(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
