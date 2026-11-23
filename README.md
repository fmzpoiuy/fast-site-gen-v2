# site-gen-v2

make.fun `site-generator-speed-01` counter entry — a byte-sink rewrite of the
standing `site-gen` build, byte-identical output with materially lower CPU.

## Approach

- **Single growable `Buffer` output sink.** `run()` never builds rendered
  strings. Markdown (`renderBody`, `inlineW`), HTML escaping (`gesc`), and the
  template interpreter (`renderNodes`) all write UTF-8 bytes into one shared
  buffer `GB` and hand results back as `{s,e}` byte ranges (`R`). Answers are
  JSON-escaped straight from those ranges into a second sink — no intermediate
  strings, no `concat`/`join`, one `writeFileSync`.
- **Byte-range output memoization.** For-loop bodies and `{% include %}`s are
  pure functions of (include-depth, iterated identity, resolved free-path
  values). A per-node memo maps the signature — leaf values, with truthy-only
  reads collapsed to a bit — to the emitted byte range; a hit is a `memcpy`.
  Chrome that only reads `site.*` (header/footer/nav, assorted partials)
  constant-folds to one render per case, and `card`s are shared between index
  and tag pages.
- **Monomorphic fused hot paths.** First-char dispatch, `indexOf` closers, a
  Uint8Array class table for inline specials, localized buffer/cursor in the
  per-char loops, pre-encoded literal tags.
- **`reading_minutes` demand-driven.** The body word count runs only for posts
  and for files whose layout's read-path set actually touches
  `*.reading_minutes`.
- **Cold-run V8 flags.** `--no-turbofan --no-incremental-marking
  --max-semi-space-size=64`: `cpu_us` bills background JIT threads, and Maglev
  keeps ~95% of TurboFan's speed on this workload without TF's compile jobs —
  ~35% less whole-process CPU locally.

## Layout

- `main.ts` — flag setup, case loop, byte-level `answers.json` serializer.
- `solve.js` — the whole generator: markdown, templates, collections, reports.

Validated byte-identical vs the kit oracle on all provided cases.
