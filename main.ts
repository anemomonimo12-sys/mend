// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format (MIT). It reads a patch in
// one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at
// the first of three matching tiers, and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileLines {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as (old, new) pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of N: `ctx` is its index in O when it is a context line, else null. */
interface NItem {
  text: string;
  ctx: number | null;
}

/** Section 5: two lines equal at one tier (0 exact, 1 trailing ws ignored, 2 both ends ignored). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return trimBoth(a) === trimBoth(b);
}

/** Positions where O occurs in `lines` at one tier, from `from` on; with `endAtEnd` only ones ending at the last line. */
function occurrences(O: string[], lines: string[], tier: number, from: number, endAtEnd: boolean): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const start = Math.max(0, from);
  for (let i = start; i + O.length <= lines.length; i++) {
    if (endAtEnd && i + O.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(O[k]!, lines[i + k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with its positions; null when it occurs nowhere. */
function findTier(
  O: string[],
  lines: string[],
  strict: boolean,
  from = 0,
  endAtEnd = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(O, lines, t, from, endAtEnd);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier where one is (single-line matching). */
function findAnchor(anchor: string, lines: string[], strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = Math.max(0, from); i < lines.length; i++) {
      if (lineEq(anchor, lines[i]!, t)) return i;
    }
  }
  return null;
}

/** A non-context line of N, re-indented at tier 2 (section 5). */
function reindent(text: string, f: string, p: string): string {
  if (text === '' || text.trim() === '') return text;
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/** Replace the k lines at `pos` by N: context lines are the file's own matched lines. */
function applyReplace(lines: string[], pos: number, O: string[], N: NItem[], tier: number): string[] {
  const out = lines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && O.length > 0) {
    f = leadingWs(lines[pos]!);
    p = leadingWs(O[0]!);
  }
  for (const item of N) {
    if (item.ctx !== null) out.push(lines[pos + item.ctx]!);
    else if (tier === 2) out.push(reindent(item.text, f, p));
    else out.push(item.text);
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

/** One body line of a hunk or chunk: context, old or new, with its text (prefix removed). */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/** Build O and N from body items: context lines land in both, `-` lines in O, `+` lines in N. */
function buildON(items: BodyItem[]): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const idx = O.length;
      O.push(it.text);
      N.push({ text: it.text, ctx: idx });
    } else if (it.kind === 'old') {
      O.push(it.text);
    } else {
      N.push({ text: it.text, ctx: null });
    }
  }
  return { O, N };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** Old start line from the header (1-based). */
  a: number;
  items: BodyItem[];
  O: string[];
  N: NItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  tailNoEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoEol: boolean;
}

interface Section {
  /** Old path (null: /dev/null), after any `a/` or `b/` prefix is removed. */
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    gitOld: null,
    gitNew: null,
    newFileMode: false,
    deletedFileMode: false,
    hunks: [],
  };
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` or `+++ `: text after four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const raw = line.slice(4);
  const upToTab = raw.split('\t')[0]!;
  let p = upToTab.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** `/dev/null` means no file; anything else is a path (an empty one is unsafe, not absent). */
const devNull = (p: string | null): string | null => (p === null || p === '/dev/null' ? null : p);

/** Parse one hunk body starting at `i` (just after the header); returns the index after the body. */
function parseHunkBody(lines: string[], i: number, hunk: Hunk): number {
  const body: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      i += 1;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it; a line that is only whitespace is empty too.
  while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
  const items: BodyItem[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) items.push({ kind: 'ctx', text: l.slice(1) });
    else if (l === '') items.push({ kind: 'ctx', text: '' });
    else if (l.startsWith('-')) items.push({ kind: 'old', text: l.slice(1) });
    else if (l.startsWith('+')) items.push({ kind: 'new', text: l.slice(1) });
    // `\` lines refer to the body line before them; they add nothing to O or N.
  }
  hunk.items = items;
  const { O, N } = buildON(items);
  hunk.O = O;
  hunk.N = N;
  // The hunk's last context or `+` line, and whether a `\` line follows it.
  hunk.tailNoEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const l = body[k]!;
    if (l.startsWith(' ') || l === '' || l.startsWith('+')) {
      hunk.tailNoEol = k + 1 < body.length && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  hunk.lastPlusNoEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.startsWith('+')) {
      hunk.lastPlusNoEol = k + 1 < body.length && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  return i;
}

/** Parse the whole patch as unified diffs; each section becomes one edit. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  const startSection = (s: Section): void => {
    sections.push(s);
    cur = s;
  };
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      startSection(s);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), items: [], O: [], N: [], tailNoEol: false, lastPlusNoEol: false };
      cur.hunks.push(hunk);
      i = parseHunkBody(lines, i + 1, hunk);
      continue;
    }
    if (cur === null) {
      // Outside any section: a `--- ` line followed by a `+++ ` line starts one; the rest is prose.
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = newSection();
        const oldP = headerPath(l);
        const newP = headerPath(lines[i + 1]!);
        s.pairOld = oldP;
        s.pairNew = newP;
        startSection(s);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (cur.hunks.length === 0) {
      // Inside the section's header.
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          const oldP = headerPath(l);
          const newP = headerPath(lines[i + 1]!);
          cur.pairOld = oldP;
          cur.pairNew = newP;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('+++ ')) {
        const newP = headerPath(l);
        cur.pairNew = newP;
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFileMode = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deletedFileMode = true;
        i += 1;
        continue;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and anything else.
      i += 1;
      continue;
    }
    // After the first hunk: a `--- ` line followed by a `+++ ` line starts a new section; the rest is prose.
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = newSection();
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      s.pairOld = oldP;
      s.pairNew = newP;
      startSection(s);
      i += 2;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

/** The old and new paths a section names, with the documented precedence. */
function sectionPaths(sec: Section): { old: string | null; new: string | null } {
  const old = devNull(sec.pairOld !== null ? sec.pairOld : sec.renameFrom !== null ? sec.renameFrom : sec.gitOld);
  const nw = devNull(sec.pairNew !== null ? sec.pairNew : sec.renameTo !== null ? sec.renameTo : sec.gitNew);
  return { old, new: nw };
}

/** Apply one hunk to the file's lines; `d` is the drift of the hunks applied so far. */
function applyHunk(f: FileLines, hunk: Hunk, strict: boolean, d: number, path: string): FileLines {
  if (hunk.O.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, f.lines.length));
    const atEnd = at === f.lines.length;
    const lines = [...f.lines.slice(0, at), ...hunk.N.map((x) => x.text), ...f.lines.slice(at)];
    return { lines, br: f.br, final: atEnd ? !hunk.tailNoEol : f.final };
  }
  const found = findTier(hunk.O, f.lines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const pos of found.positions) {
    const dist = Math.abs(pos - target);
    if (dist < bestDist) {
      best = pos;
      bestDist = dist;
    }
  }
  const atEnd = best + hunk.O.length === f.lines.length;
  const lines = applyReplace(f.lines, best, hunk.O, hunk.N, found.tier);
  return { lines, br: f.br, final: atEnd ? !hunk.tailNoEol : f.final };
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const { old, new: nw } = sectionPaths(sec);
    const isCreate = old === null || sec.newFileMode;
    const isDelete = !isCreate && (nw === null || sec.deletedFileMode);
    const isMove = !isCreate && !isDelete && old !== nw;
    if (old !== null && !safe(old)) throw new Fail('unsafe', old);
    if (nw !== null && !safe(nw)) throw new Fail('unsafe', nw);
    if (isCreate) {
      if (nw === null) return;
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const created: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const it of h.items) if (it.kind === 'new') hasPlus = true;
        if (hasPlus) noEol = h.lastPlusNoEol;
        for (const it of h.items) if (it.kind === 'new') created.push(it.text);
      }
      tree.now.set(nw, created.length === 0 ? '' : noEol ? created.join('\n') : `${created.join('\n')}\n`);
      return;
    }
    if (isDelete) {
      if (old === null) return;
      if (tree.get(old) === null) throw new Fail('missing', old);
      tree.now.set(old, null);
      return;
    }
    const src = old!;
    const cur = tree.get(src);
    if (cur === null) throw new Fail('missing', src);
    if (isMove && tree.get(nw!) !== null) throw new Fail('exists', nw!);
    let f = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      f = applyHunk(f, h, strict, d, src);
      d += h.N.length - h.O.length;
    }
    const text = joinFile(f);
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(nw!, text);
      tree.moves.push([src, nw!]);
    } else {
      tree.now.set(src, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  old: string[];
  new: string[];
  /** 1-based line of the `<<<<<<< SEARCH` line. */
  searchLine: number;
}

/** Parse the whole patch as SEARCH/REPLACE blocks; each block becomes one edit. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevReplace = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // The path: the nearest line before SEARCH, after the previous block's REPLACE, that is not
    // blank and does not start with three backticks (surrounding whitespace removed).
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    // Old lines up to a `=======` line, then new lines up to `>>>>>>> REPLACE`.
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const old = lines.slice(i + 1, j);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const nw = lines.slice(j + 1, k);
    blocks.push({ path, old, new: nw, searchLine });
    prevReplace = k;
    prevPath = path;
    i = k + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srBlockEdit(b, strict));
}

function srBlockEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.new.length === 0 ? '' : `${b.new.join('\n')}\n`);
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    const found = findTier(b.old, f.lines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const N = b.new.map((t) => ({ text: t, ctx: null }));
    const lines = applyReplace(f.lines, pos, b.old, N, found.tier);
    tree.now.set(p, joinFile({ lines, br: f.br, final: f.final }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** Null when the `@@` line carries no anchor text. */
  anchor: string | null;
  endOfFile: boolean;
  items: BodyItem[];
  /** True for items that came from a truly blank patch line (empty context lines). */
  fromBlank: boolean[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add File lines, in order. */
  addLines: string[];
  chunks: V4aChunk[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Parse the whole patch as a V4A patch; each section becomes one edit. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (true) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i += 1;
      const addLines: string[] = [];
      const fromBlank: boolean[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        const x = lines[i]!;
        if (x.startsWith('+')) {
          addLines.push(x.slice(1));
          fromBlank.push(false);
          i += 1;
        } else if (blank(x)) {
          addLines.push('');
          fromBlank.push(true);
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (addLines.length > 0 && fromBlank[addLines.length - 1]) {
        addLines.pop();
        fromBlank.pop();
      }
      sections.push({ kind: 'add', path, moveTo: null, addLines, chunks: [] });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i += 1;
      sections.push({ kind: 'delete', path, moveTo: null, addLines: [], chunks: [] });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i += 1;
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const x = lines[i]!;
        if (isV4aSectionStart(x)) break;
        if (x === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.endOfFile = true;
          closeChunk();
          i += 1;
          continue;
        }
        if (x.startsWith('*** Move to: ')) {
          if (moveTo !== null || chunks.length > 0 || cur !== null) throw new Exit2(`error: parse ${i + 1}`);
          moveTo = x.slice('*** Move to: '.length).trim();
          i += 1;
          continue;
        }
        if (x.startsWith('@@')) {
          closeChunk();
          const anchorText = x.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, endOfFile: false, items: [], fromBlank: [] };
          i += 1;
          continue;
        }
        if (x.startsWith(' ') || x.startsWith('-') || x.startsWith('+')) {
          if (cur === null) cur = { anchor: null, endOfFile: false, items: [], fromBlank: [] };
          if (x.startsWith(' ')) {
            cur.items.push({ kind: 'ctx', text: x.slice(1) });
            cur.fromBlank.push(blank(x));
          } else if (x.startsWith('-')) {
            cur.items.push({ kind: 'old', text: x.slice(1) });
            cur.fromBlank.push(false);
          } else {
            cur.items.push({ kind: 'new', text: x.slice(1) });
            cur.fromBlank.push(false);
          }
          i += 1;
          continue;
        }
        if (blank(x)) {
          // A blank line is an empty context line only inside a chunk already under way;
          // elsewhere (between sections, after a header) it is ignored.
          if (cur !== null) {
            cur.items.push({ kind: 'ctx', text: '' });
            cur.fromBlank.push(true);
          }
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk();
      // Blank lines at the end of the section are not part of it.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.items.length > 0 && lastChunk.fromBlank[lastChunk.items.length - 1]) {
          lastChunk.items.pop();
          lastChunk.fromBlank.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      sections.push({ kind: 'update', path, moveTo, addLines: [], chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : `${sec.addLines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let f = splitFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ch.anchor, f.lines, strict, cursor);
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { O, N } = buildON(ch.items);
      if (O.length === 0) {
        const at = ch.endOfFile ? f.lines.length : cursor;
        const lines = [...f.lines.slice(0, at), ...N.map((x) => x.text), ...f.lines.slice(at)];
        cursor = at + N.length;
        f = { lines, br: f.br, final: f.final };
        continue;
      }
      const found = findTier(O, f.lines, strict, cursor, ch.endOfFile);
      if (found === null) throw new Fail('no-match', p);
      const pos = found.positions[0]!;
      const lines = applyReplace(f.lines, pos, O, N, found.tier);
      cursor = pos + N.length;
      f = { lines, br: f.br, final: f.final };
    }
    const text = joinFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4)                                */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: f.br, final: f.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)    */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // One line per changed path, in byte order of the paths; a move prints one `R` line, sorted by its new path.
  const rows: Array<{ key: string; line: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.original(n) === null && tree.get(o) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Delete first, then write, so a path freed by a move can be created by another edit in the same patch.
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
