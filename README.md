# edge-case-museum

**Your code works. Except for these wonderfully terrible inputs.**

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1863+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

By [Mojibake](https://pipeworx.io), creators of Pipeworx.

Tell it what you are building ("username uniqueness", "parse a CSV upload",
"store and add up money amounts", "schedule a reminder in the user's
timezone") and it hands back the inputs that quietly break that kind of code:
the assumption each one breaks, the exact bytes, what goes wrong, why, the
safer pattern, and a repro in Python and JavaScript whose output came from
actually running it. Then it writes you a test file of those inputs, pointed
at your own function.

## Three exhibits

Every output below was printed by running the code, by the same harness that
checks the whole collection (Python 3.14.2, Node.js v22.22.2).

### 1. One NaN can leave the rest of your list unsorted

`edge_case_get({ id: "nan-in-sort" })`

```python
nan = float("nan")
print(sorted([3, nan, 1]))
```

```
[3, nan, 1]
```

```js
console.log([3, NaN, 1].sort((a, b) => a - b));
```

```
[ 3, NaN, 1 ]
```

Not "NaN ends up somewhere odd". The 3 and the 1 are left out of order. Every
comparison with NaN is false, so the sort sees NaN as equal to everything.
That breaks transitivity (3 "equals" NaN, NaN "equals" 1, so 3 "equals" 1),
and the algorithm concludes the list is already sorted. Python promises
nothing for inconsistent comparisons. ECMAScript makes the order
implementation-defined.

### 2. "01/01/68" is 2068 in Python and 1968 in Node.js

`edge_case_get({ id: "two-digit-year-century-pivot-mismatch" })`

```python
for s in ("01/01/49", "01/01/50", "01/01/68", "01/01/69"):
    print(s, "->", datetime.strptime(s, "%m/%d/%y").year)
```

```
01/01/49 -> 2049
01/01/50 -> 2050
01/01/68 -> 2068
01/01/69 -> 1969
```

```js
for (const s of ['01/01/49', '01/01/50', '01/01/68', '01/01/69'])
  console.log(s, '->', new Date(s).getFullYear());
```

```
01/01/49 -> 2049
01/01/50 -> 1950
01/01/68 -> 1968
01/01/69 -> 1969
```

Python follows the POSIX pivot at 69. V8 pivots at 50. The two agree on every
two-digit year except 50 through 68, where they are a century apart. Test a
handful of dates and you will probably never hit one.

### 3. `Intl` says the Iraqi dinar has no decimals. ISO 4217 says it has three.

`edge_cases_find({ context: "store and add up money amounts", language: "javascript" })`

```js
for (const c of ["USD", "JPY", "BHD", "KWD", "CLF", "IQD", "HUF"]) {
  const digits = new Intl.NumberFormat("en-US", { style: "currency", currency: c })
    .resolvedOptions().maximumFractionDigits;
  console.log(c, digits);
}
```

```
USD 2
JPY 0
BHD 3
KWD 3
CLF 4
IQD 0
HUF 0
```

The first lesson is that `amount * 100` is wrong for JPY (a 100x overcharge)
and for BHD (a 10x undercharge). The second is quieter: the obvious fix,
asking `Intl` how many decimals a currency has, returns CLDR display data, not
ISO 4217. IQD is 3 in ISO 4217 and HUF is 2, and `Intl` reports 0 for both.
Store the exponent your payment processor uses. Don't derive it from a
formatter.

### And then it writes the test

`edge_cases_test_file({ context: "parse a CSV upload", language: "python" })`
returns a pytest file of eight cases from seven CSV exhibits. Pointed at the
parser most of us write first, `list(csv.reader(io.StringIO(text)))`:

```
PASSED test_edge_case[csv-formula-injection-excel]
PASSED test_edge_case[csv-crlf-trailing-blank-line0]
PASSED test_edge_case[csv-crlf-trailing-blank-line1]
PASSED test_edge_case[csv-quoted-field-with-newline]
PASSED test_edge_case[csv-doubled-quote-escaping]
PASSED test_edge_case[csv-quoted-field-with-comma]
FAILED test_edge_case[csv-utf8-bom-first-header]
FAILED test_edge_case[csv-semicolon-delimited-european-excel]
2 failed, 6 passed
```

Two real bugs: the first header comes back as `"﻿name"` from a file saved
as Excel's "CSV UTF-8", and a semicolon-delimited export from a decimal-comma
locale parses as one column. Each failure names the exhibit that explains it.

## What is in it

122 exhibits, every one with at least one repro that was executed:

| Category | Exhibits | For example |
|---|---|---|
| Unicode | 15 | NFC vs NFD usernames, Turkish dotted I, ß case folding, Cyrillic homoglyphs, zero-width characters, Zalgo text |
| Dates and time | 18 | DST gaps and overlaps, Nepal's +05:45, Samoa's missing day, leap seconds, 2038, ISO week years |
| Floating point and money | 17 | `round(2.675, 2)`, `(1.005).toFixed(2)`, banker's rounding, currency minor units, -0 balances |
| Sorting and comparison | 14 | collation vs code points, Swedish å after z, `[10, 9, 1].sort()`, boolean comparators |
| Filenames and paths | 15 | `CON.txt`, trailing dots, `os.path.join` with an absolute part, NTFS streams, 255-byte names |
| Parsing | 15 | CSV quoting and BOMs, JSON duplicate keys and 64-bit ids, WHATWG backslashes, valid emails rejected |
| Integers | 14 | `MAX_SAFE_INTEGER + 1 === MAX_SAFE_INTEGER + 2`, `parseInt(null, 36)`, `-7 % 2` |
| Names and addresses | 14 | particles in surnames, mononyms, `"Null"` as a surname, ZIP codes with leading zeros |

## Tools

- `edge_cases_find({ context, language?, limit? })` — what you are
  implementing, in plain words, to the exhibits that matter for it. Each comes
  with the repro for your language and a `refine_tags` list to narrow down.
- `edge_case_get({ id })` — one exhibit in full: every repro with its captured
  output and runtime version, the why, the fix, related exhibits, sources.
- `edge_cases_browse({ category?, tag? })` — the collection by category
  (`unicode`, `datetime`, `float-money`, `sorting`, `filenames`, `parsing`,
  `integers`, `names-addresses`) or by tag (`username`, `csv`, `money`,
  `timezone`, ...).
- `edge_cases_test_file({ context, language })` — one runnable pytest or
  `node:test` file bundling the relevant inputs as cases. It runs as generated
  against a stub; replace the stub (marked TODO) with your function and the
  failures tell you which exhibit to read.

## Install

### Remote (no setup)

```json
{
  "mcpServers": {
    "edge-case-museum": {
      "url": "https://gateway.pipeworx.io/edge-case-museum/mcp"
    }
  }
}
```

This endpoint also carries the shared Pipeworx tools (`ask_pipeworx`,
`discover_tools`, and friends).

### Local

```json
{
  "mcpServers": {
    "edge-case-museum": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-edge-case-museum"]
    }
  }
}
```

The whole collection ships inside the package. No network calls, no account.

## Auth

Keyless.

## Why trust it

- **No output is typed from memory.** Every Python and JavaScript repro is
  executed by a committed harness, and its `expected_output` is what the run
  printed. `verified_with` names the runtime (for example `Python 3.14.2`,
  `Node.js v22.22.2`), because some of these behaviours change between
  versions and you should know which one we saw.
- **The harness can fail, and has.** Change one character of an expected
  output and the run goes red with the diff. A repro whose code or output was
  edited without re-running it cannot be baked into the pack at all: the bake
  checks a hash the harness recorded.
- **Stacks we did not run are labelled.** Postgres, Windows and macOS filesystem behaviour
  appear as `documented`, with the source that says so, never as verified.
- **Every exhibit cites its spec or docs.** Unicode annexes, RFC sections, the
  ECMAScript spec, IEEE 754 references, ISO 4217, IANA tz, the language docs.
  Written in our own words.

## Data sources

- Exhibits written for this collection by Mojibake, each citing the standard
  or documentation it rests on.
- Some inputs come from the [Big List of Naughty Strings](https://github.com/minimaxir/big-list-of-naughty-strings)
  by Max Woolf (MIT licence); exhibits that use one say so in their sources.
- No real person's name, address or contact detail appears anywhere. The
  names-and-addresses exhibits use invented examples and state facts about
  naming and addressing systems.

## Contribute an exhibit

Add one file, `src/exhibits/CATEGORY/ID.json` (copy any existing exhibit
for the shape), with your repros' `code` but no `expected_output`. Run
`node src/harness.mjs --only ID --capture`: it executes
each repro, writes the real output into your file, and records it. Read what
it captured; if the output does not say what your explanation says, the
explanation is wrong. Then `node src/bake.mjs` and open a pull
request. An exhibit whose repro has not been run by the harness
will not bake.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "edge-case-museum": {
      "url": "https://gateway.pipeworx.io/edge-case-museum/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/edge-case-museum/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1863+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/edge_cases_find \
  -H 'Content-Type: application/json' \
  -d '{"context":"username uniqueness","language":"python"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/edge_cases_find`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-edge-case-museum` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/edge-case-museum/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "edge-case-museum": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-edge-case-museum"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Edge Case Museum data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
