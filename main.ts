// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, line matching at three tiers (section 5), unified
// diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9)
// and order and atomicity (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
interface Move {
  old: string;
  new: string;
}

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

// ---------- section 5: lines and matching ----------

/** A file's lines under its own line break, and whether it ends with one. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function trimTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function occurrencesAt(o: string[], file: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j], file[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  pos: number[];
}

/** The first tier at which O occurs in the file at or after `from`, with its positions. */
function findTier(o: string[], file: string[], strict: boolean, from = 0, mustEndAtLast = false): Found | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier++) {
    let pos = occurrencesAt(o, file, tier, from);
    if (mustEndAtLast) pos = pos.filter((p) => p + o.length === file.length);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NItem {
  text: string;
  ctx: number;
}

/** N with context lines taken from the file's own matched lines, and tier 2 re-indentation. */
function buildReplacement(o: string[], n: NItem[], file: string[], at: number, tier: number): string[] {
  const f = o.length > 0 ? leading(file[at]) : '';
  const p = o.length > 0 ? leading(o[0]) : '';
  return n.map((it) => {
    if (it.ctx >= 0) return file[at + it.ctx];
    const t = it.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

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

// ---------- section 6: unified diffs ----------

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  items: BodyItem[];
  o: string[];
  n: NItem[];
  noNL: boolean;
}

function hunkFromItems(a: number, items: BodyItem[]): Hunk {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: o.length - 1 });
    } else if (it.kind === 'old') o.push(it.text);
    else if (it.kind === 'new') n.push({ text: it.text, ctx: -1 });
  }
  let noNL = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === 'ctx' || items[k].kind === 'new') {
      noNL = k + 1 < items.length && items[k + 1].kind === 'bs';
      break;
    }
  }
  return { a, items, o, n, noNL };
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renOld: string | null;
  renNew: string | null;
  hasRename: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function applyHunks(m: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > m.lines.length) pos = m.lines.length;
      const atEnd = pos === m.lines.length;
      const ins = h.n.map((it) => it.text);
      m.lines.splice(pos, 0, ...ins);
      if (atEnd) m.final = !h.noNL;
      d += h.n.length;
      continue;
    }
    const found = findTier(h.o, m.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + h.o.length === m.lines.length;
    const rep = buildReplacement(h.o, h.n, m.lines, best, found.tier);
    m.lines.splice(best, h.o.length, ...rep);
    if (atEnd) m.final = !h.noNL;
    d += h.n.length - h.o.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const startSection = (gOld: string | null, gNew: string | null): UniSection => {
    const s: UniSection = {
      gitOld: gOld,
      gitNew: gNew,
      pairOld: null,
      pairNew: null,
      hasPair: false,
      renOld: null,
      renNew: null,
      hasRename: false,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  const parsePathLine = (line: string): string => {
    let t = line.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    return t.trim();
  };
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : '';
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1], m[2]);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      // A pair in a section's header names that section's paths; after the
      // section's first hunk it starts a new section instead.
      if (cur === null || !inHeader) startSection(null, null);
      const oldRaw = parsePathLine(line);
      const newRaw = parsePathLine(next);
      cur!.pairOld = oldRaw === '/dev/null' ? null : stripPrefix(oldRaw);
      cur!.pairNew = newRaw === '/dev/null' ? null : stripPrefix(newRaw);
      cur!.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const items: BodyItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (j + 1 < lines.length ? lines[j + 1] : '').startsWith('+++ ')) break;
        if (bl === '') {
          items.push({ kind: 'ctx', text: '', raw: bl });
          j++;
          continue;
        }
        const c = bl[0];
        if (c === ' ') {
          items.push({ kind: 'ctx', text: bl.slice(1), raw: bl });
          j++;
          continue;
        }
        if (c === '-') {
          items.push({ kind: 'old', text: bl.slice(1), raw: bl });
          j++;
          continue;
        }
        if (c === '+') {
          items.push({ kind: 'new', text: bl.slice(1), raw: bl });
          j++;
          continue;
        }
        if (c === '\\') {
          items.push({ kind: 'bs', text: '', raw: bl });
          j++;
          continue;
        }
        break;
      }
      while (items.length > 0 && items[items.length - 1].raw === '') items.pop();
      cur!.hunks.push(hunkFromItems(a, items));
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      else if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
        cur.hasRename = true;
      } else if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
        cur.hasRename = true;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((sec) => unifiedSectionEdit(sec, strict, moves));
}

function unifiedSectionEdit(sec: UniSection, strict: boolean, moves: Move[]): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (sec.hasPair) {
    oldP = sec.pairOld;
    newP = sec.pairNew;
  } else if (sec.hasRename) {
    oldP = sec.renOld;
    newP = sec.renNew;
  } else {
    oldP = sec.gitOld;
    newP = sec.gitNew;
  }
  let kind: 'create' | 'delete' | 'move' | 'change';
  if (sec.newFile || oldP === null) kind = 'create';
  else if (sec.deletedFile || newP === null) kind = 'delete';
  else if (oldP !== newP) kind = 'move';
  else kind = 'change';
  if (kind === 'create' && newP === null) return () => undefined;
  if (kind === 'create') {
    const p = newP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let noNL = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.items.length; k++) {
          const it = h.items[k];
          if (it.kind === 'new') {
            out.push(it.text);
            noNL = k + 1 < h.items.length && h.items[k + 1].kind === 'bs';
          }
        }
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (noNL ? '' : '\n'));
    };
  }
  if (kind === 'delete') {
    const p = oldP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = oldP!;
  const q = kind === 'move' ? newP! : oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (kind === 'move' && !safe(q)) throw new Fail('unsafe', q);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (kind === 'move' && tree.get(q) !== null) throw new Fail('exists', q);
    const m = splitFile(cur);
    applyHunks(m, sec.hunks, strict, p);
    const text = joinFile(m);
    if (kind === 'move') {
      tree.now.set(p, null);
      tree.now.set(q, text);
      moves.push({ old: p, new: q });
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const s = lines.findIndex((l, idx) => idx >= i && l.trimEnd() === '<<<<<<< SEARCH');
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j];
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const eq = lines.findIndex((l, idx) => idx > s && l.trimEnd() === '=======');
    const rep = eq >= 0 ? lines.findIndex((l, idx) => idx > eq && l.trimEnd() === '>>>>>>> REPLACE') : -1;
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const m = splitFile(cur);
    const found = findTier(oldLines, m.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0];
    const nItems: NItem[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = buildReplacement(oldLines, nItems, m.lines, pos, found.tier);
    m.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(m));
  };
}

// ---------- section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
  o: string[];
  n: NItem[];
}

function chunkFromItems(anchor: string | null, items: BodyItem[], eof: boolean): VChunk {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: o.length - 1 });
    } else if (it.kind === 'old') o.push(it.text);
    else if (it.kind === 'new') n.push({ text: it.text, ctx: -1 });
  }
  return { anchor, items, eof, o, n };
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const hm = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(line);
    if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = hm[1];
    const path = hm[2].trim();
    let j = i + 1;
    while (j < last && !isHeader(lines[j])) j++;
    const raw: number[] = [];
    for (let k = i + 1; k < j; k++) raw.push(k);
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]])) raw.pop();
    if (kind === 'Add File') {
      const fileLines: string[] = [];
      for (const k of raw) {
        const l = lines[k];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'Delete File') {
      for (const k of raw) throw new Exit2(`error: parse ${k + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(v4aUpdateEdit(path, raw, lines, i + 1, strict, moves));
    }
    i = j;
  }
  return edits;
}

function v4aUpdateEdit(path: string, raw: number[], lines: string[], updateLine: number, strict: boolean, moves: Move[]): Edit {
  let p = 0;
  while (p < raw.length && blank(lines[raw[p]])) p++;
  let moveTo: string | null = null;
  if (p < raw.length && lines[raw[p]].startsWith('*** Move to: ')) {
    moveTo = lines[raw[p]].slice('*** Move to: '.length).trim();
    p++;
    while (p < raw.length && blank(lines[raw[p]])) p++;
  }
  const chunks: VChunk[] = [];
  let curItems: BodyItem[] | null = null;
  let curAnchor: string | null = null;
  let seenChunk = false;
  const closeChunk = (eof: boolean): void => {
    if (curItems === null) return;
    chunks.push(chunkFromItems(curAnchor, curItems, eof));
    curItems = null;
    curAnchor = null;
  };
  while (p < raw.length) {
    const k = raw[p];
    const line = lines[k];
    if (curItems === null && blank(line)) {
      p++;
      continue;
    }
    if (line.startsWith('@@')) {
      closeChunk(false);
      curItems = [];
      curAnchor = line.slice(2).trim();
      seenChunk = true;
      p++;
    } else if (line === '*** End of File') {
      if (curItems === null) {
        if (seenChunk) throw new Exit2(`error: parse ${k + 1}`);
        p++;
        continue;
      }
      closeChunk(true);
      seenChunk = true;
      p++;
    } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (curItems === null) {
        if (seenChunk) throw new Exit2(`error: parse ${k + 1}`);
        curItems = [];
        curAnchor = null;
        seenChunk = true;
      }
      const c = line === '' ? ' ' : line[0];
      curItems.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: line === '' ? '' : line.slice(1), raw: line });
      p++;
    } else {
      throw new Exit2(`error: parse ${k + 1}`);
    }
  }
  closeChunk(false);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundAt = -1;
        const maxTier = strict ? 0 : 2;
        for (let tier = 0; tier <= maxTier && foundAt < 0; tier++) {
          for (let q = cursor; q < m.lines.length; q++) {
            if (lineEq(ch.anchor, m.lines[q], tier)) {
              foundAt = q;
              break;
            }
          }
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? m.lines.length : cursor;
        const ins = ch.n.map((it) => it.text);
        m.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = findTier(ch.o, m.lines, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.pos[0];
      const rep = buildReplacement(ch.o, ch.n, m.lines, pos, found.tier);
      m.lines.splice(pos, ch.o.length, ...rep);
      cursor = pos + rep.length;
    }
    const text = joinFile(m);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

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
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const supOld = new Set<string>();
  const supNew = new Set<string>();
  for (const mv of moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.new) === null && tree.get(mv.new) !== null) {
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      supOld.add(mv.old);
      supNew.add(mv.new);
    }
  }
  const sortedKeys = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of sortedKeys) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (supOld.has(p) || supNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of sortedKeys) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
