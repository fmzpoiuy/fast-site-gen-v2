// solve.js — byte-sink reimplementation of makefun-site 1.0.0's build().
// run(input) returns {path: bytes} rendered into one growable Uint8Array:
// markdown and templates write UTF-8 directly, repeated template fragments
// (for-loops, includes) are memoized as byte ranges. Values are byte ranges
// ({s,e} into gbuf()); the driver JSON-escapes them into answers.json.

// ---------------------------------------------------------------- byte sink

import { Buffer } from 'node:buffer';
let GB = Buffer.allocUnsafe(24 << 20); // the one output sink: content + pages + memos
let GP = 0;
export function gbuf() { return GB; }

function gneed(k) {
  if (GP + k > GB.length) {
    const n = Buffer.allocUnsafe(Math.max(GB.length * 2, GP + k + (1 << 20)));
    n.set(GB.subarray(0, GP));
    GB = n;
  }
}
function gbyte(c) { if (GP >= GB.length) gneed(1); GB[GP++] = c; }
function gascii(s, a, b) { // ASCII-only literals
  gneed(b - a);
  for (let i = a; i < b; i++) GB[GP++] = s.charCodeAt(i);
}
const HEXB = new Uint8Array([92, 117]); // '\u'
const HEXD = new Uint8Array(16);
for (let i = 0; i < 10; i++) HEXD[i] = 48 + i;
for (let i = 0; i < 6; i++) HEXD[10 + i] = 97 + i;

/** write UTF-8 of `c` (code unit); `d` = following code unit for pair check. */
function wmulti(c, d) {
  if (c < 0x800) {
    GB[GP++] = 0xc0 | (c >> 6); GB[GP++] = 0x80 | (c & 63); return 0;
  }
  if (c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
    const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
    GB[GP++] = 0xf0 | (cp >> 18); GB[GP++] = 0x80 | ((cp >> 12) & 63); GB[GP++] = 0x80 | ((cp >> 6) & 63); GB[GP++] = 0x80 | (cp & 63);
    return 1;
  }
  if (c >= 0xd800 && c <= 0xdfff) {
    // lone surrogate: JSON.stringify emits the \uXXXX escape — bytes match that
    GB[GP++] = 92; GB[GP++] = 117;
    GB[GP++] = HEXD[(c >> 12) & 15]; GB[GP++] = HEXD[(c >> 8) & 15]; GB[GP++] = HEXD[(c >> 4) & 15]; GB[GP++] = HEXD[c & 15];
    return 0;
  }
  GB[GP++] = 0xe0 | (c >> 12); GB[GP++] = 0x80 | ((c >> 6) & 63); GB[GP++] = 0x80 | (c & 63);
  return 0;
}

/** write UTF-8 of src[a,b). */
function gstr(src, a, b) {
  gneed((b - a) * 6);
  let i = a;
  while (i < b) {
    const c = src.charCodeAt(i);
    if (c < 0x80) { GB[GP++] = c; i++; continue; }
    i += wmulti(c, i + 1 < b ? src.charCodeAt(i + 1) : 0) + 1;
  }
}

const EB = new Array(64);
EB[34] = new Uint8Array([38, 113, 117, 111, 116, 59]);        // &quot;
EB[38] = new Uint8Array([38, 97, 109, 112, 59]);              // &amp;
EB[39] = new Uint8Array([38, 35, 51, 57, 59]);                // &#39;
EB[60] = new Uint8Array([38, 108, 116, 59]);                  // &lt;
EB[62] = new Uint8Array([38, 103, 116, 59]);                  // &gt;

const BAD = new Uint8Array(64);
for (const c of [34, 38, 39, 60, 62]) BAD[c] = 1;

const EHAS = /[&<>"']/;

/** write src[a,b) with & < > " ' escaped. */
function gesc(src, a, b) {
  if (a === b) return;
  const piece = a === 0 && b === src.length ? src : src.slice(a, b);
  gneed(piece.length * 6 + 16);
  // most spans never hold an escape char — one native scan + native encode
  if (!EHAS.test(piece)) { GP += GB.write(piece, GP); return; }
  const gb = GB;           // reserve >= worst case: GB cannot grow mid-loop
  let p = GP;
  let i = a;
  while (i < b) {
    const c = src.charCodeAt(i);
    if (c < 0x80) {
      if (c < 64 && BAD[c]) { const ent = EB[c]; gb.set(ent, p); p += ent.length; }
      else gb[p++] = c;
      i++; continue;
    }
    GP = p;
    i += wmulti(c, i + 1 < b ? src.charCodeAt(i + 1) : 0) + 1;
    p = GP;
  }
  GP = p;
}
/** write the string escaped (whole). */
function gescs(s) { gesc(s, 0, s.length); }
/** copy GS bytes [s,e) to the write head. */
function gcopy(s, e) {
  const l = e - s;
  gneed(l);
  GB.set(GB.subarray(s, e), GP);
  GP += l;
}
/** write a byte range with & < > " ' escaped (byte-level — specials are ASCII). */
function gescBytes(s, e) {
  gneed((e - s) + 16);
  for (let i = s; i < e; i++) {
    const c = GB[i];
    if (c < 64 && BAD[c]) { const ent = EB[c]; GB.set(ent, GP); GP += ent.length; }
    else GB[GP++] = c;
  }
}

/** Byte range value — stands in for an output string anywhere one is read. */
class R { constructor(s, e) { this.s = s; this.e = e; } }

const TD = new TextDecoder();
function strOfRange(v) { return TD.decode(GB.subarray(v.s, v.e)); }

// ---------------------------------------------------------------- text utils

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SLUG_MAX = 64;

/** The slug of `text` per makefun-site's rule. */
function slugify0(text) {
  // ASCII fast path: NFKD and \p{M} stripping can only matter past 0x7f.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      // a surrogate half or any non-[a-z0-9] char: one "-", only before a keeper
      if (c >= 0xd800 && c <= 0xdbff) i++; // skip the pair's low half too (still a gap)
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

const slugCache = new Map();
function slugify(text) {
  let s = slugCache.get(text);
  if (s === undefined) {
    s = slugify0(text);
    if (slugCache.size < 20000) slugCache.set(text, s);
  }
  return s;
}

/** `slug` made unique against `taken` (a Set; the winner is added). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  // "2026-11-09" -> "9 November 2026"
  const y = date.slice(0, 4);
  const m = +date.slice(5, 7);
  const d = +date.slice(8, 10);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const WS = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS[c] = 1;
function isWs(c) {
  if (c < 128) return WS[c] === 1;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** \S+ run count — the body's words, starting at offset `a`. */
function wordsOf(text, a) {
  const n = text.length;
  let count = 0;
  let inWord = false;
  for (let i = a; i < n; i++) {
    const c = text.charCodeAt(i);
    // c<33: ws iff in the ASCII ws set; 33..159: never ws; >=160: the big check.
    if (c < 33 ? WS[c] === 1 : c > 159 && isWs(c)) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.hasOwn(o, k);

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

const DIRPARTS = new Map();
/** `rel` resolved from `dir`; null when it climbs out of the root. */
function resolvePath(dir, rel) {
  let base = DIRPARTS.get(dir);
  if (base === undefined) { base = dir === '' ? [] : dir.split('/'); DIRPARTS.set(dir, base); }
  const parts = base.slice();
  const n = rel.length;
  let i = 0;
  while (i <= n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    if (j > i) {
      const c0 = rel.charCodeAt(i);
      if (c0 === 46) {
        if (j - i === 2 && rel.charCodeAt(i + 1) === 46) { // '..'
          if (parts.length === 0) return null;
          parts.pop();
        }
        // '.' -> skip
      } else parts.push(rel.slice(i, j));
    }
    i = j + 1;
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const KEY_A_Z = new Uint8Array(128);
for (let c = 97; c <= 122; c++) KEY_A_Z[c] = 1;
KEY_A_Z[95] = 1; // '_'

/** A quoted "..." string value, or its error. */
function stringOf(key, raw, a, z) {
  // raw = src.slice(a,z) — either quoted or bare.
  if (raw.charCodeAt(0) === 34) {
    const n = raw.length;
    if (n < 2 || raw.charCodeAt(n - 1) !== 34) return `key "${key}": a quoted string is not closed`;
    let out = '';
    let run = 1;
    for (let i = 1; i < n - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const nx = raw.charCodeAt(i + 1);
        if ((nx !== 34 && nx !== 92) || i + 1 === n - 1) return `key "${key}": a quoted string holds an escape other than \\" or \\\\`;
        if (i > run) out += raw.slice(run, i);
        out += raw[i + 1];
        i++;
        run = i + 1;
      } else if (c === 34) return `key "${key}": a quoted string holds a stray quote`;
    }
    if (run < n - 1) out += raw.slice(run, n - 1);
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return `key "${key}": a bare string opens on [`;
  return { value: raw };
}

/**
 * Parse front matter of `text` (\n line ends). Returns { data, body } or { error }.
 */
function parseFM(text) {
  const n = text.length;
  // lines[0] === '---' exactly
  if (!(text.charCodeAt(0) === 45 && text.charCodeAt(1) === 45 && text.charCodeAt(2) === 45 && (n === 3 || text.charCodeAt(3) === 10))) {
    return { error: 'no front matter' };
  }
  // find the closing '---' line
  let ls = 4; // start of line 2 (index 1)
  let close = -1;
  {
    let p = ls;
    while (p <= n) {
      let e = text.indexOf('\n', p);
      if (e === -1) e = n;
      if (e - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) { close = p; break; }
      if (e === n) break;
      p = e + 1;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = ls;
  let lineNo = 1;
  while (p < close) {
    const nl = text.indexOf('\n', p);
    const le = nl === -1 || nl > close ? close : nl;
    lineNo++;
    const line = text.slice(p, le);
    // blank [ \t]* or comment '#'
    let allws = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { allws = false; break; }
    }
    if (allws || line.charCodeAt(0) === 35) { p = le + 1; continue; }
    // [a-z_]+ then ':' then (' ' rest | EOL)
    let j = 0;
    const L = line.length;
    while (j < L && KEY_A_Z[line.charCodeAt(j)]) j++;
    if (j === 0 || j >= L || line.charCodeAt(j) !== 58) return { error: `line ${lineNo} is not "key: value"` };
    const key = line.slice(0, j);
    let raw;
    if (j + 1 >= L) {
      raw = '';
    } else {
      if (line.charCodeAt(j + 1) !== 32) return { error: `line ${lineNo} is not "key: value"` };
      let rs = j + 2;
      let re = L;
      while (re > rs && (line.charCodeAt(re - 1) === 32 || line.charCodeAt(re - 1) === 9)) re--;
      raw = line.slice(rs, re);
    }
    // key known?
    if (key !== 'title' && key !== 'date' && key !== 'tags' && key !== 'draft' && key !== 'layout' && key !== 'slug' && key !== 'summary') {
      return { error: `unknown key "${key}"` };
    }
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    // per-key validation
    if (key === 'title' || key === 'summary') {
      const v = stringOf(key, raw, 0, raw.length);
      if (typeof v === 'string') return { error: v };
      data[key] = v.value;
    } else if (key === 'date') {
      let ok = raw.length === 10;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          const c = raw.charCodeAt(i);
          if (i === 4 || i === 7) { if (c !== 45) { ok = false; break; } continue; }
          if (c < 48 || c > 57) { ok = false; break; }
        }
        if (ok) {
          y = +raw.slice(0, 4); mo = +raw.slice(5, 7); d = +raw.slice(8, 10);
          if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
        }
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      data.date = raw;
    } else if (key === 'tags') {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') { data.tags = []; }
      else {
        const tags = inner.split(',').map((t) => t.trim());
        let bad = false;
        for (const t of tags) {
          if (t === '') { bad = true; break; }
          for (let i = 0; i < t.length; i++) {
            const c = t.charCodeAt(i);
            if (c === 34 || c === 91 || c === 93) { bad = true; break; }
          }
          if (bad) break;
        }
        if (bad) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        data.tags = tags;
      }
    } else if (key === 'draft') {
      if (raw === 'true') data.draft = true;
      else if (raw === 'false') data.draft = false;
      else return { error: 'key "draft": true or false' };
    } else if (key === 'layout') {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) { ok = false; break; }
      }
      if (!ok) return { error: 'key "layout": not a template name' };
      data.layout = raw;
    } else { // slug
      let ok = raw.length <= 64;
      if (ok) {
        // ^[a-z0-9]+(?:-[a-z0-9]+)*$
        let i = 0, L2 = raw.length;
        if (L2 === 0) ok = false;
        while (ok && i < L2) {
          let k = 0;
          while (i < L2) {
            const c = raw.charCodeAt(i);
            if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { i++; k++; }
            else break;
          }
          if (k === 0) { ok = false; break; }
          if (i < L2) {
            if (raw.charCodeAt(i) !== 45) { ok = false; break; }
            i++;
            if (i >= L2) { ok = false; break; } // trailing '-'
          }
        }
      }
      if (!ok) return { error: 'key "slug": not a slug' };
      data.slug = raw;
    }
    p = le + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bstart: close + 3 >= n ? n : close + 4 };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

// line types
const T_BLANK = 0, T_FENCE = 1, T_HEAD = 2, T_HR = 3, T_QUOTE = 4, T_BULLET = 5, T_ORDER = 6, T_PARA = 7;

// chars that could open a block: ' ' \t ` # - * > 0-9
const OPENER = new Uint8Array(128);
OPENER[9] = 1; OPENER[32] = 1; OPENER[96] = 1; OPENER[35] = 1;
OPENER[45] = 1; OPENER[42] = 1; OPENER[62] = 1;
for (let c = 48; c <= 57; c++) OPENER[c] = 1;

/** classify line src[ls,le): returns type; for HEAD sets hDepth/hText, ORDER oStart via out array */
function classify(src, ls, le) {
  const len = le - ls;
  if (len === 0) return T_BLANK;
  const c0 = src.charCodeAt(ls);
  if (c0 >= 128 || OPENER[c0] === 0) return T_PARA;
  if (c0 === 32 || c0 === 9) {
    for (let i = ls + 1; i < le; i++) {
      const c = src.charCodeAt(i);
      if (c !== 32 && c !== 9) return T_PARA;
    }
    return T_BLANK;
  }
  if (c0 === 96) { // '`'
    // ^```([A-Za-z0-9_+-]*)[ \t]*$
    if (len >= 3 && src.charCodeAt(ls + 1) === 96 && src.charCodeAt(ls + 2) === 96) {
      let i = ls + 3;
      while (i < le) {
        const c = src.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
        else break;
      }
      let ok = true;
      for (; i < le; i++) {
        const c = src.charCodeAt(i);
        if (c !== 32 && c !== 9) { ok = false; break; }
      }
      if (ok) return T_FENCE;
    }
    return T_PARA;
  }
  if (c0 === 35) { // '#'
    let k = 0;
    while (ls + k < le && src.charCodeAt(ls + k) === 35) k++;
    if (k <= 6 && ls + k < le) {
      const nx = src.charCodeAt(ls + k);
      if (nx === 32 || nx === 9) {
        // text = trim(rest)
        let a = ls + k;
        while (a < le && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
        let b = le;
        while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
        if (b > a) { clsDepth = k; clsA = a; clsB = b; return T_HEAD; }
      }
    }
    return T_PARA;
  }
  if (c0 === 45) { // '-'
    if (len >= 3 && src.charCodeAt(ls + 1) === 45 && src.charCodeAt(ls + 2) === 45) {
      let ok = true;
      for (let i = ls + 3; i < le; i++) {
        const c = src.charCodeAt(i);
        if (c !== 32 && c !== 9) { ok = false; break; }
      }
      if (ok) return T_HR;
    }
    if (len >= 2 && src.charCodeAt(ls + 1) === 32) { clsA = ls + 2; return T_BULLET; }
    return T_PARA;
  }
  if (c0 === 42) { // '*'
    if (len >= 3 && src.charCodeAt(ls + 1) === 42 && src.charCodeAt(ls + 2) === 42) {
      let ok = true;
      for (let i = ls + 3; i < le; i++) {
        const c = src.charCodeAt(i);
        if (c !== 32 && c !== 9) { ok = false; break; }
      }
      if (ok) return T_HR;
    }
    if (len >= 2 && src.charCodeAt(ls + 1) === 32) { clsA = ls + 2; return T_BULLET; }
    return T_PARA;
  }
  if (c0 === 62) return T_QUOTE;
  if (c0 >= 48 && c0 <= 57) {
    let k = 0;
    while (ls + k < le && k <= 9) {
      const c = src.charCodeAt(ls + k);
      if (c >= 48 && c <= 57) k++;
      else break;
    }
    if (k >= 1 && k <= 9 && ls + k + 1 < le && src.charCodeAt(ls + k) === 46 && src.charCodeAt(ls + k + 1) === 32) {
      clsNum = +src.slice(ls, ls + k);
      clsA = ls + k + 2;
      return T_ORDER;
    }
    return T_PARA;
  }
  return T_PARA;
}

let clsDepth = 0, clsA = 0, clsB = 0, clsNum = 0;

/** trim [ \t] at both ends of src[a,b) */
function trimSpan(src, a, b) {
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return b > a ? src.slice(a, b) : '';
}

// ---- inline helpers

// A candidate position j is "escaped" iff the run of backslashes ending at j-1
// has odd length — equivalent to the oracle's left-to-right \x pair skipping.
function escParity(s, j) {
  let k = j - 1;
  while (k >= 0 && s.charCodeAt(k) === 92) k--;
  return (j - 1 - k) & 1; // 1 = escaped
}

function findUnesc2(s, from) { // first unescaped '**'
  let j = s.indexOf('**', from);
  while (j !== -1) {
    if (escParity(s, j) === 0) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}
function findUnesc1(s, from) { // first unescaped ']'
  let j = s.indexOf(']', from);
  while (j !== -1) {
    if (escParity(s, j) === 0) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (escParity(s, j) === 0) {
      if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
      return j;
    }
    j = s.indexOf('*', j + 1);
  }
  return -1;
}

/** env.link(target) — resolve a link target. The (dir,target) resolution is
 * cached; a cached broken result still records a broken-link for THIS source. */
function link(target) {
  const c0 = target.charCodeAt(0);
  const n = target.length;
  // scheme ^[A-Za-z][A-Za-z0-9+.-]*:
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    let j = 1;
    while (j < n) {
      const c = target.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) j++;
      else break;
    }
    if (j < n && target.charCodeAt(j) === 58) return target;
  }
  if (c0 === 47 || c0 === 35) return target; // '/' '#'
  const key = B.dir + '\n' + target;
  const hit = B.linkCache.get(key);
  if (hit !== undefined) {
    if (hit === null) { B.broken.add(`broken-link ${B.srcPath} -> ${target}`); return target; }
    return hit;
  }
  const h = target.indexOf('#');
  const rel = h === -1 ? target : target.slice(0, h);
  const frag = h === -1 ? '' : target.slice(h);
  const path = rel === '' ? null : resolvePath(B.dir, rel);
  let out = null;
  if (path !== null) {
    const s = B.bySource.get(path);
    if (s !== undefined) out = s.url + frag;
    else if (B.staticPaths.has(path)) out = `${B.base}/${path}${frag}`;
  }
  B.linkCache.set(key, out);
  if (out === null) {
    B.broken.add(`broken-link ${B.srcPath} -> ${target}`);
    return target;
  }
  return out;
}

// byte literals for the fused inline writer
function lit(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
const T_PRE_O = lit('<pre><code'), T_PRE_L = lit(' class="language-'), T_PRE_M = lit('">'), T_PRE_C = lit('</code></pre>\n');
const T_HR_B = lit('<hr>\n');
const T_BQ_O = lit('<blockquote>\n'), T_BQ_P = lit('<p>'), T_P_C = lit('</p>\n'), T_BQ_C = lit('</blockquote>\n');
const T_UL_O = lit('<ul>\n'), T_OL_O = lit('<ol>\n'), T_OL_S1 = lit('<ol start="'), T_LI_O = lit('<li>'), T_LI_C = lit('</li>\n');
const T_UL_C = lit('</ul>\n'), T_OL_C = lit('</ol>\n'), T_P_O = lit('<p>');
const T_CODE_O = lit('<code>'), T_CODE_C = lit('</code>');
const T_STR_O = lit('<strong>'), T_STR_C = lit('</strong>'), T_EM_O = lit('<em>'), T_EM_C = lit('</em>');
const T_A_O = lit('<a href="'), T_A_M = lit('">'), T_A_C = lit('</a>');
const T_H_O = lit('<h'), T_H_ID = lit(' id="'), T_H_M = lit('">'), T_H_C = lit('</h'), T_GT_NL = lit('>\n');
const T_HQ_O = lit('"'), T_BQ_EMPTY = lit('<blockquote>\n</blockquote>\n');

function wb(b) { // write a byte literal
  if (GP + b.length > GB.length) gneed(b.length);
  GB.set(b, GP);
  GP += b.length;
}

// inline+escape fused char classes (ASCII): 0 clean, 1 html-escape, 2 \ 3 ` 4 * 5 [
const IT = new Uint8Array(128);
IT[34] = 1; IT[38] = 1; IT[39] = 1; IT[60] = 1; IT[62] = 1;
IT[92] = 2; IT[96] = 3; IT[42] = 4; IT[91] = 5;

/** Render src[a,b) inline into GB — one pass: escapes, constructs, UTF-8. */
function inlineW(s, a, b) {
  gneed((b - a) * 8 + 128);
  const gb = GB;           // reserve >= worst case: GB cannot grow mid-loop
  let p = GP;
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c >= 128) {
      GP = p;
      i += wmulti(c, i + 1 < b ? s.charCodeAt(i + 1) : 0) + 1;
      p = GP;
      continue;
    }
    const t = IT[c];
    if (t === 0) { gb[p++] = c; i++; continue; }
    if (t === 1) { const ent = EB[c]; gb.set(ent, p); p += ent.length; i++; continue; }
    if (t === 2) { // backslash
      if (i + 1 < b && ESCAPABLE[s.charCodeAt(i + 1)]) {
        const e = s.charCodeAt(i + 1);
        if (e < 64 && BAD[e]) { const ent = EB[e]; gb.set(ent, p); p += ent.length; }
        else gb[p++] = e;
        i += 2; continue;
      }
      gb[p++] = 92; i++; continue;
    }
    if (t === 3) { // '`'
      const j = s.indexOf('`', i + 1);
      if (j > i + 1 && j < b) {
        GP = p;
        wb(T_CODE_O);
        gesc(s, i + 1, j);
        wb(T_CODE_C);
        p = GP;
        i = j + 1; continue;
      }
      gb[p++] = 96; i++; continue;
    }
    if (t === 4) { // '*'
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnesc2(s, i + 2);
        if (j > i + 2 && j + 1 < b) {
          GP = p;
          wb(T_STR_O);
          inlineW(s, i + 2, j);
          wb(T_STR_C);
          p = GP;
          i = j + 2; continue;
        }
        gb[p++] = 42; gb[p++] = 42; i += 2; continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1 && j < b) {
        GP = p;
        wb(T_EM_O);
        inlineW(s, i + 1, j);
        wb(T_EM_C);
        p = GP;
        i = j + 1; continue;
      }
      gb[p++] = 42; i++; continue;
    }
    // t === 5: '['
    const k = findUnesc1(s, i + 1);
    const mm = k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 || mm >= b ? '' : s.slice(k + 2, mm);
    let ws = false;
    for (let q = 0; q < target.length; q++) if (isWs(target.charCodeAt(q))) { ws = true; break; }
    if (target !== '' && !ws) {
      GP = p;
      wb(T_A_O);
      gescs(link(target));
      wb(T_A_M);
      inlineW(s, i + 1, k);
      wb(T_A_C);
      p = GP;
      i = mm + 1; continue;
    }
    gb[p++] = 91; i++; continue;
  }
  GP = p;
}

// module build context (single-threaded)
const B = {
  base: '', dir: '', srcPath: '',
  bySource: null, staticPaths: null, broken: null,
  templates: null, linkCache: new Map(),
};

// reused per-source scratch (join consumed before next use)
const LINES = [];
const SPAN_A = [], SPAN_B = [];
const IDS = new Set();

/** renderMarkdown: fused lex+render of src[start,∞). Returns {html, toc, excerpt} (ranges). */
function renderBody(src, start) {
  const n = src.length;
  const ids = IDS;
  ids.clear();
  const toc = [];
  let excerpt = null;
  let ls = start;
  const htmlS = GP;
  while (ls < n) {
    let le = src.indexOf('\n', ls);
    if (le === -1) le = n;
    const t = classify(src, ls, le);
    if (t === T_BLANK) { ls = le + 1; continue; }
    if (t === T_FENCE) {
      const lang = trimSpan(src, ls + 3, le);
      wb(T_PRE_O);
      if (lang !== '') { wb(T_PRE_L); gescs(lang); wb(T_HQ_O); }
      wb(T_GT);
      // find the closing ``` line; the body region is emitted with one gesc
      const bodyStart = le + 1;
      let p = bodyStart;
      let emitEnd = -1, needNl = false;
      while (p <= n) {
        let e = src.indexOf('\n', p);
        if (e === -1) e = n;
        if (e - p >= 3 && src.charCodeAt(p) === 96 && src.charCodeAt(p + 1) === 96 && src.charCodeAt(p + 2) === 96) {
          let ok = true;
          for (let i = p + 3; i < e; i++) {
            const c = src.charCodeAt(i);
            if (c !== 32 && c !== 9) { ok = false; break; }
          }
          if (ok) { emitEnd = p; ls = e + 1; break; }
        }
        if (e === n) { emitEnd = n; needNl = true; ls = n + 1; break; }
        p = e + 1;
      }
      if (emitEnd === -1) { emitEnd = bodyStart; ls = n + 1; } // opener is the last line
      if (emitEnd > bodyStart) {
        gesc(src, bodyStart, emitEnd);
        if (needNl) gbyte(10);
      } else if (needNl) gbyte(10);
      wb(T_PRE_C);
      continue;
    }
    if (t === T_HEAD) {
      const text = src.slice(clsA, clsB);
      const id = uniqueSlug(slugify(text), ids);
      wb(T_H_O); gbyte(48 + clsDepth); wb(T_H_ID); gascii(id, 0, id.length); wb(T_H_M);
      const hs = GP;
      inlineW(src, clsA, clsB);
      const hHtml = new R(hs, GP);
      wb(T_H_C); gbyte(48 + clsDepth); wb(T_GT_NL);
      if (clsDepth === 2 || clsDepth === 3) toc.push({ level: clsDepth, id, html: hHtml });
      ls = le + 1; continue;
    }
    if (t === T_HR) { wb(T_HR_B); ls = le + 1; continue; }
    if (t === T_QUOTE) {
      const body = LINES;
      body.length = 0;
      let p = ls;
      while (p <= n) {
        let e = src.indexOf('\n', p);
        if (e === -1) e = n;
        if (src.charCodeAt(p) !== 62) break;
        let a = p + 1;
        if (a < e && src.charCodeAt(a) === 32) a++;
        const line = trimSpan(src, a, e);
        if (line !== '') body.push(line);
        if (e === n) { p = n + 1; break; }
        p = e + 1;
      }
      ls = p;
      if (body.length === 0) wb(T_BQ_EMPTY);
      else {
        const t = body.length === 1 ? body[0] : body.join('\n');
        wb(T_BQ_O); wb(T_BQ_P); inlineW(t, 0, t.length); wb(T_P_C); wb(T_BQ_C);
      }
      continue;
    }
    if (t === T_BULLET || t === T_ORDER) {
      const ordered = t === T_ORDER;
      const start = ordered ? clsNum : 1;
      const items = [];
      let cur = null;
      let p = ls;
      while (p <= n) {
        let e = src.indexOf('\n', p);
        if (e === -1) e = n;
        // does this line match the same marker?
        let matched = false;
        if (ordered) {
          const tt = classify(src, p, e);
          if (tt === T_ORDER) { cur = [trimSpan(src, clsA, e)]; items.push(cur); matched = true; }
        } else {
          const c0 = src.charCodeAt(p);
          if ((c0 === 45 || c0 === 42) && e - p >= 2 && src.charCodeAt(p + 1) === 32) { cur = [trimSpan(src, p + 2, e)]; items.push(cur); matched = true; }
        }
        if (!matched) {
          // continuation ^ {2,}\S
          if (e - p >= 2 && src.charCodeAt(p) === 32 && src.charCodeAt(p + 1) === 32) {
            // check \S after the spaces
            let a = p + 2;
            while (a < e && src.charCodeAt(a) === 32) a++;
            if (a < e && !isWs(src.charCodeAt(a))) {
              cur.push(trimSpan(src, p, e));
              if (e === n) { p = n + 1; break; }
              p = e + 1; continue;
            }
          }
          break;
        }
        if (e === n) { p = n + 1; break; }
        p = e + 1;
      }
      ls = p;
      if (ordered) {
        if (start !== 1) { const st2 = String(start); wb(T_OL_S1); gascii(st2, 0, st2.length); wb(T_PRE_M); gbyte(10); }
        else wb(T_OL_O);
      } else wb(T_UL_O);
      for (const it of items) {
        const t = it.length === 1 ? it[0] : it.join('\n');
        wb(T_LI_O); inlineW(t, 0, t.length); wb(T_LI_C);
      }
      if (ordered) wb(T_OL_C); else wb(T_UL_C);
      continue;
    }
    // paragraph: accumulate until blank / fence-open / heading / hr (all anchored
    // at the raw line start, so an indented line can only be blank or a para line)
    let a0 = ls, b0 = le;
    while (a0 < b0 && (src.charCodeAt(a0) === 32 || src.charCodeAt(a0) === 9)) a0++;
    while (b0 > a0 && (src.charCodeAt(b0 - 1) === 32 || src.charCodeAt(b0 - 1) === 9)) b0--;
    let clean = a0 === ls && b0 === le;
    let lastB = b0;
    const sa = SPAN_A, sb = SPAN_B;
    sa[0] = a0; sb[0] = b0;
    let cnt = 1;
    let p = le + 1;
    while (p <= n) {
      let e = src.indexOf('\n', p);
      if (e === -1) e = n;
      const c0 = p < e ? src.charCodeAt(p) : 0;
      let a = p;
      if (c0 === 32 || c0 === 9 || e === p) {
        while (a < e && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
        if (a === e) break; // blank
      } else if (c0 === 96) {
        // ^```([A-Za-z0-9_+-]*)[ \t]*$
        if (e - p >= 3 && src.charCodeAt(p + 1) === 96 && src.charCodeAt(p + 2) === 96) {
          let i = p + 3;
          while (i < e) {
            const c = src.charCodeAt(i);
            if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
            else break;
          }
          let ok = true;
          for (; i < e; i++) {
            const c = src.charCodeAt(i);
            if (c !== 32 && c !== 9) { ok = false; break; }
          }
          if (ok) break;
        }
      } else if (c0 === 35) {
        let k = 0;
        while (p + k < e && src.charCodeAt(p + k) === 35) k++;
        if (k <= 6 && p + k < e) {
          const nx = src.charCodeAt(p + k);
          if (nx === 32 || nx === 9) {
            let ha = p + k;
            while (ha < e && (src.charCodeAt(ha) === 32 || src.charCodeAt(ha) === 9)) ha++;
            let hb = e;
            while (hb > ha && (src.charCodeAt(hb - 1) === 32 || src.charCodeAt(hb - 1) === 9)) hb--;
            if (hb > ha) break; // heading ends the para
          }
        }
      } else if (c0 === 45 || c0 === 42) {
        if (e - p >= 3 && src.charCodeAt(p + 1) === c0 && src.charCodeAt(p + 2) === c0) {
          let ok = true;
          for (let i = p + 3; i < e; i++) {
            const c = src.charCodeAt(i);
            if (c !== 32 && c !== 9) { ok = false; break; }
          }
          if (ok) break; // hr ends the para
        }
      }
      // para continuation: trim right side (a already holds the left trim)
      let b = e;
      while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
      if (a !== p || b !== e) clean = false;
      sa[cnt] = a; sb[cnt] = b; cnt++;
      lastB = b;
      if (e === n) { p = n + 1; break; }
      p = e + 1;
    }
    ls = p;
    wb(T_P_O);
    const hs = GP;
    if (clean) inlineW(src, a0, lastB);
    else {
      const body = LINES;
      body.length = 0;
      for (let k = 0; k < cnt; k++) body.push(src.slice(sa[k], sb[k]));
      const t = body.join('\n');
      inlineW(t, 0, t.length);
    }
    if (excerpt === null) excerpt = new R(hs, GP);
    wb(T_P_C);
  }
  return { html: new R(htmlS, GP), toc, excerpt: excerpt ?? new R(GP, GP) };
}
const T_GT = lit('>');

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
class TemplateError extends Error { }
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

// node kinds
const N_TEXT = 1, N_VAR = 2, N_RAW = 3, N_FOR = 4, N_IF = 5, N_INC = 6;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  const p = text.split('.');
  p.safe = !p.some((s) => DANGER.has(s));
  return p;
}

function parseT(name, src) {
  const root = { kind: 0, body: [] };
  const stack = [root];
  let body = root.body;
  let text = '';
  let i = 0;
  const n = src.length;
  const flush = () => { if (text !== '') { body.push({ kind: N_TEXT, bytes: encText(text) }); text = ''; } };
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) { text += src.slice(i); break; }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      flush();
      body.push({ kind: raw ? N_RAW : N_VAR, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    // {% ... %}
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    flush();
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: N_FOR, name: m[1], path: pathOf(name, m[2]), body: [], free: null, memo: new Map() };
      body.push(node); stack.push(node); body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: N_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node); stack.push(node); body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== N_IF || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? N_FOR : N_IF)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 0 ? parent.body : parent.kind === N_FOR ? parent.body : parent.else ?? parent.then;
    } else if ((m = INC_RE.exec(tag)) !== null) {
      body.push({ kind: N_INC, name: m[1], free: null, memo: new Map() });
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  flush();
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind === N_FOR ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** encode a JS string to a fresh Uint8Array (parse-time only — not the sink). */
function encText(s) {
  const b = new Uint8Array(s.length * 3);
  let p = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) { b[p++] = c; continue; }
    if (c < 0x800) { b[p++] = 0xc0 | (c >> 6); b[p++] = 0x80 | (c & 63); continue; }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        b[p++] = 0xf0 | (cp >> 18); b[p++] = 0x80 | ((cp >> 12) & 63); b[p++] = 0x80 | ((cp >> 6) & 63); b[p++] = 0x80 | (cp & 63);
        i++; continue;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) { // lone surrogate — JSON.stringify's \uXXXX
      b[p++] = 92; b[p++] = 117;
      b[p++] = HEXD[(c >> 12) & 15]; b[p++] = HEXD[(c >> 8) & 15]; b[p++] = HEXD[(c >> 4) & 15]; b[p++] = HEXD[c & 15];
      continue;
    }
    b[p++] = 0xe0 | (c >> 12); b[p++] = 0x80 | ((c >> 6) & 63); b[p++] = 0x80 | (c & 63);
  }
  return b.slice(0, p);
}

function lookup(scope, path) {
  let s = scope;
  const p0 = path[0];
  while (s !== null && !hasOwn(s.vars, p0)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[p0];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (v instanceof R) return strOfRange(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let o = '';
    for (let k = 0; k < v.length; k++) { if (k) o += ', '; o += textOf(v[k]); }
    return o;
  }
  return '';
}

function truthy(v) {
  if (v instanceof R) return v.e > v.s;
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const isArr = Array.isArray;

const M = new Map();       // name -> parsed nodes
const READ = new Map();    // name -> sorted array of free head names (or [] )

// The scope chain only ever binds for-vars; a path[0] not in BOUND resolves
// straight on ROOT_VARS — skipping the per-lookup frame walk.
const BOUND = [];
let ROOT_VARS = null;
// Object.prototype's own members — proto-resolve on every container, so paths
// touching them keep the hasOwn walk. Element-type proto props are all methods
// and get caught by the typeof-function guard in the fast path instead.
const DANGER = new Set(['constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
function isBound(p0) {
  for (let i = BOUND.length - 1; i >= 0; i--) if (BOUND[i] === p0) return true;
  return false;
}
/** `path` resolved on the root vars object (lookup's tail, own properties). */
function pathRoot(path) {
  if (!hasOwn(ROOT_VARS, path[0])) return undefined;
  let v = ROOT_VARS[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function pathAt(S, path) {
  if (BOUND.length !== 0 && isBound(path[0])) return lookup(S, path);
  if (path.safe) {
    // plain derefs — SAFE segs can't hit Object.prototype members, and a
    // function result means an element-type proto leaked (our data never
    // holds function-valued own props), which hasOwn would return undefined for
    let v = ROOT_VARS;
    for (let k = 0; k < path.length; k++) {
      if (v === null || v === undefined) return undefined;
      v = v[path[k]];
      if (typeof v === 'function') return undefined;
    }
    return v;
  }
  return pathRoot(path);
}

// ---- output memoization ----------------------------------------------------
// For-loop and include output is a pure function of (D, iterated-array identity,
// the resolved values of the body/template's free head names). We memoize the
// rendered byte range per node; a hit is a memcpy of sink bytes.

const OIDM = new WeakMap();
let OIDN = 0;
function oid(o) {
  let i = OIDM.get(o);
  if (i === undefined) { i = ++OIDN; OIDM.set(o, i); }
  return i;
}
const LOOPIDS = new WeakMap();
let LOOPN = 0;

/** a resolved value's memo-key fragment. */
function frag(v) {
  if (v === null) return '|n';
  if (v === undefined) return '|u';
  const t = typeof v;
  if (t === 'string') return '|s' + v.length + ':' + v;
  if (t === 'number') return '|i' + v;
  if (t === 'boolean') return v ? '|b1' : '|b0';
  const li = LOOPIDS.get(v);
  if (li !== undefined) return '|L' + li + ':' + v.index;
  return '|o' + oid(v);
}

// ---- free-path analysis ----------------------------------------------------
// A subtree's output is a pure function of (D, iterated identity, the resolved
// values of every free path it reads). Signatures key on the resolved leaf
// values — a truthy-only read collapses to a bit — so chrome reading only
// site.* (or an absent `page`) shares one render across all pages.

const USE_T = 0, USE_V = 1, USE_I = 2; // merge precedence i>v>t

function mergeRead(out, a, u) {
  const j = a.join(' ');
  const e = out.get(j);
  if (e === undefined) out.set(j, { a, u });
  else if (u > e.u) e.u = u;
}
function addRead(out, path, u, bound) {
  if (!bound.has(path[0])) mergeRead(out, path, u);
}

/** collect free read paths of a node list under `bound` into Map<key,{a,u}>. */
function readsWalk(nodes, bound, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case N_VAR: case N_RAW: addRead(out, n.path, USE_V, bound); continue;
      case N_IF:
        addRead(out, n.path, USE_T, bound);
        readsWalk(n.then, bound, out);
        if (n.else !== null) readsWalk(n.else, bound, out);
        continue;
      case N_FOR: {
        addRead(out, n.path, USE_I, bound);
        const hadN = bound.has(n.name), hadL = bound.has('loop');
        bound.add(n.name); bound.add('loop');
        readsWalk(n.body, bound, out);
        if (!hadN) bound.delete(n.name);
        if (!hadL) bound.delete('loop');
        continue;
      }
      case N_INC: {
        const r = READ.get(n.name);
        if (r !== undefined) for (const f of r) if (!bound.has(f.a[0])) mergeRead(out, f.a, f.u);
        continue;
      }
    }
  }
}

/** direct (pre-include-fixpoint) reads of a node list; include edges recorded. */
function directReads(nodes, bound, out, edges) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case N_VAR: case N_RAW: addRead(out, n.path, USE_V, bound); continue;
      case N_IF:
        addRead(out, n.path, USE_T, bound);
        directReads(n.then, bound, out, edges);
        if (n.else !== null) directReads(n.else, bound, out, edges);
        continue;
      case N_FOR: {
        addRead(out, n.path, USE_I, bound);
        const hadN = bound.has(n.name), hadL = bound.has('loop');
        bound.add(n.name); bound.add('loop');
        directReads(n.body, bound, out, edges);
        if (!hadN) bound.delete(n.name);
        if (!hadL) bound.delete('loop');
        continue;
      }
      case N_INC: edges.add(n.name); continue;
    }
  }
}

/** annotate all nodes of a parsed tree: free-path lists for N_FOR / N_INC. */
function annotate(nodes, bound) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case N_IF:
        annotate(n.then, bound);
        if (n.else !== null) annotate(n.else, bound);
        continue;
      case N_FOR: {
        const s = new Map();
        const hadN = bound.has(n.name), hadL = bound.has('loop');
        bound.add(n.name); bound.add('loop');
        readsWalk(n.body, bound, s);
        if (!hadN) bound.delete(n.name);
        if (!hadL) bound.delete('loop');
        n.free = s.size === 0 ? null : [...s.values()];
        annotate(n.body, bound);
        continue;
      }
      case N_INC: {
        const r = READ.get(n.name);
        n.free = r === undefined || r.length === 0 ? null : r;
        continue;
      }
    }
  }
}

/** one free-path signature fragment: resolved value, or bit for truthy reads. */
function sigUse(S, r) {
  const v = pathAt(S, r.a);
  if (r.u === USE_T) return truthy(v) ? '|1' : '|0';
  if (r.u === USE_I) return isArr(v) ? '|#' + oid(v) : '|~';
  return frag(v);
}

function renderNodes(nodes, S, D) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case N_TEXT: {
        const b = n.bytes;
        if (GP + b.length > GB.length) gneed(b.length);
        GB.set(b, GP); GP += b.length;
        continue;
      }
      case N_VAR: {
        const v = pathAt(S, n.path);
        if (typeof v === 'string') gescs(v);
        else if (v instanceof R) gescBytes(v.s, v.e);
        else if (v === null || v === undefined) { }
        else if (typeof v === 'object') gescs(textOf(v));
        else gascii(String(v), 0, String(v).length);
        continue;
      }
      case N_RAW: {
        const v = pathAt(S, n.path);
        if (typeof v === 'string') gstr(v, 0, v.length);
        else if (v instanceof R) gcopy(v.s, v.e);
        else if (v === null || v === undefined) { }
        else if (typeof v === 'object') { const t = textOf(v); gstr(t, 0, t.length); }
        else gascii(String(v), 0, String(v).length);
        continue;
      }
      case N_IF: {
        const branch = truthy(pathAt(S, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, S, D);
        continue;
      }
      case N_FOR: {
        const xs = pathAt(S, n.path);
        if (!isArr(xs)) continue;
        let key = 'x' + oid(xs) + ',' + D;
        if (n.free !== null) for (const f of n.free) key += sigUse(S, f);
        const hit = n.memo.get(key);
        if (hit !== undefined) { gcopy(hit.s, hit.e); continue; }
        const st = GP;
        const vars = { [n.name]: xs[0], loop: { index: 1, first: true, last: xs.length === 1, length: xs.length } };
        LOOPIDS.set(vars.loop, ++LOOPN);
        const frame = { vars, parent: S };
        const lp = vars.loop;
        BOUND.push(n.name, 'loop');
        for (let k = 0; k < xs.length; k++) {
          if (n.name !== 'loop') vars[n.name] = xs[k];
          lp.index = k + 1; lp.first = k === 0; lp.last = k === xs.length - 1;
          renderNodes(n.body, frame, D);
        }
        BOUND.length -= 2;
        n.memo.set(key, new R(st, GP));
        continue;
      }
      case N_INC: {
        const t = M.get(n.name);
        if (t === undefined || D >= INCLUDE_DEPTH) continue;
        let key = 'i' + D;
        if (n.free !== null) for (const f of n.free) key += sigUse(S, f);
        const hit = n.memo.get(key);
        if (hit !== undefined) { gcopy(hit.s, hit.e); continue; }
        const st = GP;
        renderNodes(t, S, D + 1);
        n.memo.set(key, new R(st, GP));
        continue;
      }
    }
  }
}

// ---------------------------------------------------------------- build

export function run(input) {
  // 2. templates in name order: parse each, reporting TemplateErrors
  M.clear();
  const templates = M;
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseT(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  B.templates = templates;

  // free read-paths per template (fixpoint over include edges), then annotate
  READ.clear();
  {
    const direct = new Map();  // name -> Map<key,{a,u}>
    const edges = new Map();   // name -> Set of include names
    for (const [name, body] of templates) {
      const out = new Map(), ed = new Set();
      directReads(body, new Set(), out, ed);
      direct.set(name, out); edges.set(name, ed);
    }
    const work = new Map();
    for (const [name] of templates) work.set(name, new Map(direct.get(name)));
    let grew = true;
    while (grew) {
      grew = false;
      for (const [name, ed] of edges) {
        const mine = work.get(name);
        for (const e2 of ed) {
          const theirs = work.get(e2);
          if (theirs === undefined) continue;
          for (const [k, f] of theirs) {
            const have = mine.get(k);
            if (have === undefined) { mine.set(k, f); grew = true; }
            else if (f.u > have.u) { have.u = f.u; grew = true; }
          }
        }
      }
    }
    for (const [name, s] of work) READ.set(name, [...s.values()]);
    const bound = new Set();
    for (const [, body] of templates) annotate(body, bound);
  }

  // layouts whose render reads `*.reading_minutes` — only those files (and posts,
  // whose card carries it) need the body word count at all
  const needsRm = new Set();
  for (const [name, paths] of READ) {
    for (const r of paths) if (r.a[r.a.length - 1] === 'reading_minutes') { needsRm.add(name); break; }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  B.base = base;

  // 1. files sorted by path; md->source else static
  const files = input.files.sort((a, b) => byCodeUnits(a.path, b.path));
  const statics = [];
  const srcs = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
      srcs.push({ path: f.path, text });
    } else statics.push(f);
  }
  // 3-4. front matter + checks + permalinks, fused (order preserved)
  const kept = [];
  const bySource = new Map();
  const taken = new Map();
  for (const s of srcs) {
    const fm = parseFM(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    const data = fm.data;
    s.data = data;
    s.bstart = fm.bstart;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !hasOwn(data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (data.draft === true) { report.push(`draft ${s.path}`); continue; }
    // permalink
    s.srcDir = dirOf(s.path);
    s.dateLong = data.date === undefined ? '' : longDate(data.date);
    const dir = s.post ? 'posts' : s.srcDir;
    let tk = taken.get(dir);
    if (tk === undefined) { tk = new Set(dir === '' ? RESERVED_SET : undefined); taken.set(dir, tk); }
    const slug = uniqueSlug(data.slug ?? slugify(data.title), tk);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
    kept.push(s);
  }

  // 5. markdown per kept source
  B.bySource = bySource;
  B.staticPaths = new Set(statics.map((f) => f.path));
  B.broken = new Set();
  B.linkCache.clear();
  for (const s of kept) {
    B.dir = s.srcDir;
    B.srcPath = s.path;
    const md = renderBody(s.text, s.bstart);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  for (const s of kept) {
    if (s.post || needsRm.has(s.layout)) s.rm = Math.max(1, Math.ceil(wordsOf(s.text, s.bstart) / 200));
    else s.rm = 0;
  }

  // 6. collections
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  const linkObjs = posts.map((p) => ({ title: p.data.title, url: p.url, date: p.data.date ?? '', date_long: p.dateLong }));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : linkObjs[k - 1];
    p.older = k === posts.length - 1 ? null : linkObjs[k + 1];
  });

  // 7. tags
  const bySlug = new Map();
  for (const p of posts) {
    const names = dedupTags(p.data.tags);
    p.minis = [];
    for (const tn of names) {
      let tag = bySlug.get(tn.slug);
      if (tag === undefined) {
        const url = `${base}/tags/${tn.slug}/`;
        tag = { name: tn.name, slug: tn.slug, url, posts: [], mini: { name: tn.name, slug: tn.slug, url } };
        bySlug.set(tn.slug, tag);
      }
      tag.posts.push(p);
      p.minis.push(tag.mini);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    const names = dedupTags(s.data.tags);
    s.minis = names.map((tn) => bySlug.get(tn.slug)?.mini ?? { name: tn.name, slug: tn.slug, url: '' });
  }
  const allTags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. layouts
  for (const p of posts) {
    p.card = {
      title: p.data.title, url: p.url, date: p.data.date ?? '',
      date_long: p.dateLong,
      summary: p.data.summary ?? '', excerpt: p.excerpt,
      reading_minutes: p.rm,
      tags: p.minis,
    };
  }
  const site = { title: input.site.title, base_url: base };
  const tagsView = allTags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const out = new Map();

  const rootScope = { vars: null, parent: null };
  function render(name, varsObj) {
    const t = templates.get(name);
    if (t === undefined) return null;
    rootScope.vars = varsObj;
    ROOT_VARS = varsObj;
    const st = GP;
    renderNodes(t, rootScope, 0);
    return new R(st, GP);
  }

  for (const s of kept) {
    const data = s.data;
    // fresh page object per render: memo signatures key on value identity —
    // never on a mutated-shared object.
    const page = {
      title: data.title, url: s.url, date: data.date ?? '',
      date_long: s.dateLong,
      summary: data.summary ?? '', excerpt: s.excerpt,
      reading_minutes: s.rm,
      tags: s.minis, slug: s.slug, content: s.html, toc: s.toc,
      newer: s.post ? s.newer : null, older: s.post ? s.older : null, is_post: s.post,
    };
    const varsObj = { site, tags: tagsView, recent, page };
    out.set(`${s.outDir}/index.html`, render(s.layout, varsObj));
  }

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  for (let k = 1; k <= pages; k++) {
    const url = k === 1 ? `${base}/` : `${base}/page/${k}/`;
    const html = render('index', {
      site, tags: tagsView, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k, total: pages, url,
        newer_url: k === 1 ? '' : (k - 1 === 1 ? `${base}/` : `${base}/page/${k - 1}/`),
        older_url: k === pages ? '' : `${base}/page/${k + 1}/`,
      },
    });
    if (html !== null) out.set(k === 1 ? 'index.html' : `page/${k}/index.html`, html);
  }
  for (const t of allTags) {
    if (t.view === undefined) {
      const postCards = t.posts.map((p) => p.card);
      t.view = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: postCards };
    }
    const html = render('tag', {
      site, tags: tagsView, recent,
      tag: t.view,
    });
    if (html !== null) out.set(`tags/${t.slug}/index.html`, html);
  }
  const tagsHtml = render('tags', { site, tags: tagsView, recent });
  if (tagsHtml !== null) out.set('tags/index.html', tagsHtml);
  for (const f of statics) {
    if (out.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else {
      const st = GP;
      gstr(f.content, 0, f.content.length);
      out.set(f.path, new R(st, GP));
    }
  }

  // 9. report
  const lines = [...report, ...B.broken].sort(byCodeUnits);
  let nPages = 0;
  for (const s of kept) if (!s.post) nPages++;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${allTags.length} tags and ${statics.length} static files`);
  {
    const t = lines.join('\n') + '\n';
    const st = GP;
    gstr(t, 0, t.length);
    out.set('build-report.txt', new R(st, GP));
  }
  return out;
}

const RESERVED_SET = ['posts', 'tags', 'page'];

const SEEN = new Set();
function dedupTags(arr) {
  if (arr === undefined || arr.length === 0) return [];
  SEEN.clear();
  const out = [];
  for (const name of arr) {
    const sl = slugify(name);
    if (!SEEN.has(sl)) { SEEN.add(sl); out.push({ name, slug: sl }); }
  }
  return out;
}
