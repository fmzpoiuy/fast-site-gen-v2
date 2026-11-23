// main.ts — driver: reads /input/cases.json, answers each case with run() from
// solve.js, writes /output/answers.json. Values come back as byte ranges into
// solve.js's growable sink; this file JSON-escapes them into the output sink —
// no intermediate strings, one writeFileSync.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { enableCompileCache } from 'node:module';

try { enableCompileCache(); } catch {}
// cpu_us counts cold-run JIT: Maglev reaches ~95% of TurboFan speed for this
// workload without TF's background-thread compile jobs. Locally this cut
// whole-process CPU ~35% vs the house flag set.
setFlagsFromString(process.env.SG_FLAGS ?? '--no-turbofan --no-incremental-marking --max-semi-space-size=64');

const mod = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: any) => Map<string, { s: number; e: number }>;
  gbuf: () => Uint8Array;
};
const { run, gbuf } = mod;

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- answers.json sink
let JB = Buffer.allocUnsafe(24 << 20);
let JP = 0;
function jneed(k: number) {
  if (JP + k > JB.length) {
    const n = Buffer.allocUnsafe(Math.max(JB.length * 2, JP + k + (1 << 20)));
    n.set(JB.subarray(0, JP));
    JB = n;
  }
}
function jb(c: number) { if (JP >= JB.length) jneed(1); JB[JP++] = c; }
function jstr(s: string) { // UTF-8 of a JS string (keys, JSON.stringify output)
  jneed(s.length * 3);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) { JB[JP++] = c; continue; }
    if (c < 0x800) { JB[JP++] = 0xc0 | (c >> 6); JB[JP++] = 0x80 | (c & 63); continue; }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        JB[JP++] = 0xf0 | (cp >> 18); JB[JP++] = 0x80 | ((cp >> 12) & 63); JB[JP++] = 0x80 | ((cp >> 6) & 63); JB[JP++] = 0x80 | (cp & 63);
        i++; continue;
      }
    }
    JB[JP++] = 0xe0 | (c >> 12); JB[JP++] = 0x80 | ((c >> 6) & 63); JB[JP++] = 0x80 | (c & 63);
  }
}

// JSON string escapes: \" \\ and <0x20 (\b \f \n \r \t else \u00XX)
const JHEX = '0123456789abcdef';
/** write GB[s,e) as a JSON string body (escaping) into JB. */
function jesc(GB: Uint8Array, s: number, e: number) {
  jneed((e - s) * 6 + 8);
  let i = s;
  while (i < e) {
    // clean run: write bytes until an escape candidate
    while (i < e) {
      const c = GB[i];
      if (c === 34 || c === 92 || c < 32) break;
      JB[JP++] = c; i++;
    }
    if (i >= e) break;
    const c = GB[i];
    if (c === 34) { JB[JP++] = 92; JB[JP++] = 34; }
    else if (c === 92) { JB[JP++] = 92; JB[JP++] = 92; }
    else if (c === 10) { JB[JP++] = 92; JB[JP++] = 110; }
    else if (c === 13) { JB[JP++] = 92; JB[JP++] = 114; }
    else if (c === 9) { JB[JP++] = 92; JB[JP++] = 116; }
    else if (c === 8) { JB[JP++] = 92; JB[JP++] = 98; }
    else if (c === 12) { JB[JP++] = 92; JB[JP++] = 102; }
    else { // \u00XX
      JB[JP++] = 92; JB[JP++] = 117; JB[JP++] = 48; JB[JP++] = 48;
      JB[JP++] = JHEX.charCodeAt(c >> 4); JB[JP++] = JHEX.charCodeAt(c & 15);
    }
    i++;
  }
}

const PROF = !!process.env.PROFILE;
const us = () => { const t = process.cpuUsage(); return t.user + t.system; };
const ns = () => Number(process.hrtime.bigint() / 1000n);
const t0 = us();
const h0 = ns();
const raw = readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8');
const t1 = us();
const h1 = ns();
const cases = JSON.parse(raw) as { id: string; input: any }[];
const t2 = us();
const h2 = ns();

// keys are output paths — almost always free of JSON-must-escape chars
const KBAD = /[\\"\x00-\x1f]/;

jb(0x5b); // '['
let first = true;
let tRun = 0;
for (const c of cases) {
  const ta = ns();
  const ans = run(c.input);
  tRun += ns() - ta;
  if (!first) jb(0x2c);
  first = false;
  jb(0x7b); // '{'
  let fk = true;
  const GB = gbuf();
  for (const [k, v] of ans) {
    if (!fk) jb(0x2c);
    fk = false;
    if (KBAD.test(k)) jstr(JSON.stringify(k));
    else { jb(0x22); jstr(k); jb(0x22); }
    jb(0x3a); // ':'
    jb(0x22);
    jesc(GB, v.s, v.e);
    jb(0x22);
  }
  jb(0x7d); // '}'
}
jb(0x5d); // ']'
const t3 = us();
const h3 = ns();
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JB.subarray(0, JP));
const h4 = ns();
const t4 = us();
if (PROF) {
  process.stderr.write(`CPU_TOTAL ${t4}\n`);
  process.stderr.write(`uptime ${Math.round(process.uptime() * 1000)}ms hrtime ${h3 - h0} write ${h4 - h3} read ${h1 - h0} parse ${h2 - h1} run ${tRun} ser ${h3 - h2 - tRun}\n`);
}
