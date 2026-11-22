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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, for the `R old -> new` output rows. */
  readonly moves: Array<{ old: string; nw: string }> = [];
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

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files: a file's line break, its lines, and whether it ends with a line break
// (SPEC.md section 3).
// ---------------------------------------------------------------------------

interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** A file an edit creates: LF breaks, ending with a line break (unless the caller says otherwise). */
function createdText(lines: string[], final = true): string {
  return serializeFile({ br: '\n', lines, final });
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5).
// ---------------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

interface Occurrence {
  tier: number;
  positions: number[];
}

/**
 * The occurrences of `oldLines` in `lines` at or after `from`, at the first tier where there is at least one
 * (tier 0 only with --strict). Occurrences may overlap; positions ascend. With `eofOnly`, only occurrences that
 * end at the file's last line count.
 */
function findOccurrences(lines: string[], oldLines: string[], strict: boolean, from = 0, eofOnly = false): Occurrence | null {
  // An empty O is an insertion, never a match: the callers handle it separately (unified empty hunks, V4A
  // empty chunks), so the matcher reports no occurrence for it rather than matching at every position.
  if (oldLines.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const norm = t === 0 ? (s: string): string => s : t === 1 ? stripTrail : stripBoth;
    const o = oldLines.map(norm);
    const pos: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (norm(lines[i + j]!) !== o[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line at offset `ctx` into O) or a fresh line. */
interface NewLine {
  text: string;
  ctx: number; // >= 0: file line at the matched position + ctx; -1: a fresh line
}

/** Replace O's `oLen` lines at `at` with N, re-indenting at tier 2 (section 5). The file's final break is kept. */
function applyReplace(doc: FileDoc, at: number, oLen: number, nLines: NewLine[], tier: number, oLines: string[]): FileDoc {
  const out = doc.lines.slice(0, at);
  if (tier === 2 && oLen > 0) {
    const f = leadWs(doc.lines[at] ?? '');
    const p = leadWs(oLines[0] ?? '');
    for (const nl of nLines) {
      if (nl.ctx >= 0) {
        out.push(doc.lines[at + nl.ctx]!);
      } else if (nl.text !== '' && !/^[ \t]+$/.test(nl.text) && nl.text.startsWith(p)) {
        out.push(f + nl.text.slice(p.length));
      } else {
        out.push(nl.text);
      }
    }
  } else {
    for (const nl of nLines) out.push(nl.ctx >= 0 ? doc.lines[at + nl.ctx]! : nl.text);
  }
  out.push(...doc.lines.slice(at + oLen));
  return { br: doc.br, lines: out, final: doc.final };
}

/** A hunk/chunk body as O lines and N lines (context lines keep their index into O). */
function splitBody(body: string[]): { oLines: string[]; nLines: NewLine[] } {
  const oLines: string[] = [];
  const nLines: NewLine[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const text = l === '' ? '' : l.slice(1);
      oLines.push(text);
      nLines.push({ text, ctx: oLines.length - 1 });
    } else if (l.startsWith('-')) {
      oLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      nLines.push({ text: l.slice(1), ctx: -1 });
    }
    // A `\` line refers to the body line before it; it is in neither O nor N.
  }
  return { oLines, nLines };
}

/** Whether a `\` line follows the hunk's last context or `+` line (section 6). */
function backslashAfterLast(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) last = k;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  a: number; // old start line, 1-based
  body: string[];
  oLines: string[];
  nLines: NewLine[];
  noEol: boolean; // a `\` line follows the hunk's last context or `+` line
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null | undefined; // undefined: no `---`/`+++` pair seen
  dashNew: string | null | undefined;
  renOld: string | null | undefined; // undefined: no `rename from` seen
  renNew: string | null | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, a leading `a/` or `b/` removed. */
function diffPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Read one hunk starting at `lines[i]` (a hunk header line); returns the hunk and the next index. */
function readHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const hunk: Hunk = { a: Number(m[1]), body: [], oLines: [], nLines: [], noEol: false };
  const n = lines.length;
  i += 1;
  // The body: lines starting with ` `, `-`, `+`, `\`, or empty; it ends at the first other line, at a
  // `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at the end of the patch.
  while (i < n) {
    const b = lines[i]!;
    if (b.startsWith('diff --git ')) break;
    if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
      hunk.body.push(b);
      i += 1;
    } else break;
  }
  while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
  const split = splitBody(hunk.body);
  hunk.oLines = split.oLines;
  hunk.nLines = split.nLines;
  hunk.noEol = backslashAfterLast(hunk.body);
  return { hunk, next: i };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false; // sec exists and its first hunk has not started
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { gitOld: m[1]!, gitNew: m[2]!, dashOld: undefined, dashNew: undefined, renOld: undefined, renNew: undefined, create: false, del: false, hunks: [] };
      sections.push(sec);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null) {
        sec = { gitOld: null, gitNew: null, dashOld: undefined, dashNew: undefined, renOld: undefined, renNew: undefined, create: false, del: false, hunks: [] };
        sections.push(sec);
        inHeader = true;
      }
      if (inHeader) {
        // The pair belongs to the current section's header.
        const o = diffPath(line);
        const nw = diffPath(lines[i + 1]!);
        sec.dashOld = o === '/dev/null' ? null : o;
        sec.dashNew = nw === '/dev/null' ? null : nw;
        i += 2;
        continue;
      }
      // After a hunk: the pair starts a new section.
      sec = { gitOld: null, gitNew: null, dashOld: undefined, dashNew: undefined, renOld: undefined, renNew: undefined, create: false, del: false, hunks: [] };
      sections.push(sec);
      inHeader = true;
      continue; // the header handling above consumes the pair next round
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) {
        // A `--- ` line not followed by a `+++ ` line, inside a section's header.
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        sec.renOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.del = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const r = readHunk(lines, i);
        sec.hunks.push(r.hunk);
        i = r.next;
        inHeader = false;
        continue;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any other line.
      i += 1;
      continue;
    }
    if (sec !== null && line.startsWith('@@')) {
      // After a hunk: a further hunk of the same section.
      const r = readHunk(lines, i);
      sec.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    if (sec === null && line.startsWith('@@')) {
      // A hunk before any section.
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i += 1;
  }
  return sections;
}

/** A section's old and new path: the `---`/`+++` pair names them, else `rename from`/`rename to`, else `diff --git`. */
function sectionPaths(sec: Section): { oldP: string | null; newP: string | null } {
  const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld;
  const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew;
  return { oldP, newP };
}

/** Apply a section's hunks in order to a file's lines (section 6). */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let cur = doc;
  let d = 0;
  for (const h of hunks) {
    if (h.oLines.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > cur.lines.length) pos = cur.lines.length;
      const atEnd = pos === cur.lines.length;
      const ins = h.nLines.map((nl) => nl.text);
      cur = { br: cur.br, lines: [...cur.lines.slice(0, pos), ...ins, ...cur.lines.slice(pos)], final: cur.final };
      if (atEnd) cur.final = !h.noEol;
      d += h.nLines.length;
      continue;
    }
    const m = findOccurrences(cur.lines, h.oLines, strict);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = m.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of m.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + h.oLines.length === cur.lines.length;
    cur = applyReplace(cur, best, h.oLines.length, h.nLines, m.tier, h.oLines);
    if (runsToEnd) cur.final = !h.noEol;
    d += h.nLines.length - h.oLines.length;
  }
  return cur;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const { oldP, newP } = sectionPaths(sec);
    const isCreate = sec.create || (oldP === null && newP !== null);
    const isDelete = !isCreate && (sec.del || (newP === null && oldP !== null));
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        if (newP === null) return; // both paths /dev/null: nothing to create
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const created: string[] = [];
        let final = true;
        let lastPlus: { hunk: Hunk; idx: number } | null = null;
        for (const h of sec.hunks) {
          h.body.forEach((b, idx) => {
            if (b.startsWith('+')) {
              created.push(b.slice(1));
              lastPlus = { hunk: h, idx };
            }
          });
        }
        if (lastPlus !== null) {
          const next = lastPlus.hunk.body[lastPlus.idx + 1];
          if (next !== undefined && next.startsWith('\\')) final = false;
        }
        tree.now.set(newP, createdText(created, final));
        return;
      }
      if (isDelete) {
        if (oldP === null) return; // both paths /dev/null: nothing to delete
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (isMove) {
        if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
        const out = applyHunks(parseFile(tree.get(oldP!)!), sec.hunks, strict, oldP!);
        tree.now.set(oldP!, null);
        tree.now.set(newP!, serializeFile(out));
        tree.moves.push({ old: oldP!, nw: newP! });
        return;
      }
      const p = oldP ?? newP;
      if (p === null) return; // no path named at all: nothing to change
      if (tree.get(p) === null) throw new Fail('missing', p);
      const out = applyHunks(parseFile(tree.get(p)!), sec.hunks, strict, p);
      tree.now.set(p, serializeFile(out));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, createdText(newLines));
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const doc = parseFile(cur);
      const m = findOccurrences(doc.lines, oldLines, strict);
      if (m === null) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const nLines: NewLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
      tree.now.set(p, serializeFile(applyReplace(doc, m.positions[0]!, oldLines.length, nLines, m.tier, oldLines)));
    });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null; // null: no anchor
  eof: boolean;
  oLines: string[];
  nLines: NewLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number; // 1-based line of the section's start line
  moveTo: string | null;
  chunks: VChunk[];
  addLines: string[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  // Split the lines between Begin and End into sections; blank lines at the end of a section are not part of it.
  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    lineNo: number;
    raw: Array<{ text: string; lineNo: number }>;
  }
  const rawSections: RawSection[] = [];
  let cur: RawSection | null = null;
  const closeSection = (): void => {
    if (cur === null) return;
    while (cur.raw.length > 0 && blank(cur.raw[cur.raw.length - 1]!.text)) cur.raw.pop();
    rawSections.push(cur);
    cur = null;
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    }
    if (kind !== null) {
      closeSection();
      cur = { kind, path, lineNo: i + 1, raw: [] };
      continue;
    }
    if (blank(line)) {
      if (cur !== null) cur.raw.push({ text: line, lineNo: i + 1 });
      continue; // blank lines between sections are ignored
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    cur.raw.push({ text: line, lineNo: i + 1 });
  }
  closeSection();
  const sections: VSection[] = rawSections.map((rs) => {
    const sec: VSection = { kind: rs.kind, path: rs.path, lineNo: rs.lineNo, moveTo: null, chunks: [], addLines: [] };
    if (rs.kind === 'add') {
      for (const r of rs.raw) {
        if (r.text === '') sec.addLines.push('');
        else if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
      return sec;
    }
    if (rs.kind === 'delete') {
      if (rs.raw.length > 0) throw new Exit2(`error: parse ${rs.raw[0]!.lineNo}`);
      return sec;
    }
    // Update: an optional `*** Move to: <path>` first line, then chunks.
    let at = 0;
    if (rs.raw.length > 0 && rs.raw[0]!.text.startsWith('*** Move to: ')) {
      sec.moveTo = rs.raw[0]!.text.slice('*** Move to: '.length).trim();
      at = 1;
    }
    let chunk: VChunk | null = null;
    let chunkBody: string[] = [];
    const closeChunk = (eof: boolean): void => {
      if (chunk === null) return;
      const split = splitBody(chunkBody);
      chunk.oLines = split.oLines;
      chunk.nLines = split.nLines;
      chunk.eof = eof;
      sec.chunks.push(chunk);
      chunk = null;
      chunkBody = [];
    };
    for (let k = at; k < rs.raw.length; k++) {
      const r = rs.raw[k]!;
      const line = r.text;
      if (line.startsWith('@@')) {
        closeChunk(false);
        const anchor = line.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, oLines: [], nLines: [] };
        continue;
      }
      if (line === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${r.lineNo}`);
        closeChunk(true);
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
        if (chunk === null) {
          // The first chunk may start at a body line.
          if (sec.chunks.length === 0) chunk = { anchor: null, eof: false, oLines: [], nLines: [] };
          else throw new Exit2(`error: parse ${r.lineNo}`);
        }
        chunkBody.push(line);
        continue;
      }
      throw new Exit2(`error: parse ${r.lineNo}`);
    }
    closeChunk(false);
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    return sec;
  });
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      const text = createdText(sec.addLines);
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      };
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      return (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    const p = sec.path;
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      let doc = parseFile(cur);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const am = findOccurrences(doc.lines, [ch.anchor], strict, cursor);
          if (am === null) throw new Fail('no-match', p);
          cursor = am.positions[0]! + 1;
        }
        if (ch.oLines.length === 0) {
          const pos = ch.eof ? doc.lines.length : cursor;
          const ins = ch.nLines.map((nl) => nl.text);
          doc = { br: doc.br, lines: [...doc.lines.slice(0, pos), ...ins, ...doc.lines.slice(pos)], final: doc.final };
          cursor = pos + ins.length;
          continue;
        }
        const m = findOccurrences(doc.lines, ch.oLines, strict, cursor, ch.eof);
        if (m === null) throw new Fail('no-match', p);
        const at = m.positions[0]!;
        doc = applyReplace(doc, at, ch.oLines.length, ch.nLines, m.tier, ch.oLines);
        cursor = at + ch.nLines.length;
      }
      const out = serializeFile(doc);
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(moveTo, out);
        tree.moves.push({ old: p, nw: moveTo });
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9).
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
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
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---------------------------------------------------------------------------
// The run (SPEC.md sections 1, 2 and 10).
// ---------------------------------------------------------------------------

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

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
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
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
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line for each path whose state changed, in byte order of the paths (UTF-8). A move that succeeded,
  // whose old path existed before the patch and does not after it and whose new path did not exist before it
  // and does after it, is one `R <old> -> <new>` line sorting by <new>, replacing that pair's `D` and `A`.
  const rows: Array<{ key: string; line: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const mv of tree.moves) {
    if (usedOld.has(mv.old) || usedNew.has(mv.nw)) continue;
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.nw) === null && tree.get(mv.nw) !== null) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      usedOld.add(mv.old);
      usedNew.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const out = rows.map((r) => r.line);
  if (!check) {
    // Delete first, then write, so a move to or from a path under another changed path still lands.
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const now = tree.now.get(p)!;
      if (now === null || tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
