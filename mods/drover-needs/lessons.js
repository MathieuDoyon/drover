// Lessons: the pure model. Layer paths, the org slug grammar, entry parse/format, title validation for the prompt loader.
// No I/O. A lesson file is markdown: `### L-<n> <title>`, then 1-3 body lines; the last body line may end with
// `(added YYYY-MM-DD · <card or run id> · confirmed YYYY-MM-DD)`. Titles are the only text a loader puts in a prompt, so they are strict.
import { safeSegment } from "./workfolder.js";

export const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const LAYER_FILES = ["lessons.md", "workflows.md", "squads.md"];
export const TITLE_MAX = 120;
export const BODY_LINES_MAX = 3;
export const ENTRY_CHARS_MAX = 400;
export const FILE_READ_MAX_BYTES = 65536;
const N_MAX = 999999;
const LAYERS = ["org", "project", "agent"];

// ---- slugs and paths ----

export function isOrgSlug(v) {
  if (typeof v !== "string" || !ORG_SLUG_RE.test(v)) return false;
  try { safeSegment(v); return true; } catch { return false; }
}

export function orgSlug(v) {
  if (!isOrgSlug(v)) throw new Error("invalid org slug");
  return v;
}

const safeId = (v) => {
  if (typeof v !== "string" || v.length > 100 || v.startsWith(".")) return null;
  try { return safeSegment(v); } catch { return null; }
};

export function lessonPaths(configDir, opts) {
  const { org, project, agent } = opts && typeof opts === "object" ? opts : {};
  if (typeof configDir !== "string" || !configDir.startsWith("/")) return { org: null, project: null, agent: null };
  const c = configDir.length > 1 ? configDir.replace(/\/+$/, "") : "";
  const o = isOrgSlug(org) ? Object.fromEntries(LAYER_FILES.map((f) => [f.replace(/\.md$/, ""), `${c}/orgs/${org}/${f}`])) : null;
  const p = safeId(project);
  const a = safeId(agent);
  return { org: o, project: p ? `${c}/projects/${p}/lessons.md` : null, agent: a ? `${c}/agents/${a}.lessons.md` : null };
}

// ---- text hygiene ----

// Control, format and bidi characters never reach a title or body; every kind of space becomes one plain space.
export function sanitize(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/[\t\n\r\f\v\u0085\u00a0\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

const RAW_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const canonId = (n) => `L-${String(n).padStart(2, "0")}`;

// The header line, checked raw first (no newline/control smuggled in), then the sanitized title re-checked.
function parseHeader(line) {
  if (typeof line !== "string" || RAW_FORBIDDEN.test(line)) return null;
  const m = /^### L-(\d{1,6}) (.+)$/.exec(line);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > N_MAX) return null;
  const title = sanitize(m[2]).normalize("NFC");
  if (!title || title.length > TITLE_MAX) return null;
  if (/[<>`]/.test(title) || /^[#\->]/.test(title) || /\[(org|project|agent)\]/i.test(title)) return null;
  return { n, id: canonId(n), title };
}

export function entryTitle(line) {
  const h = parseHeader(line);
  return h ? { id: h.id, title: h.title } : null;
}

// ---- metadata ----

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_RE = /^[A-Za-z0-9-]{1,40}$/;
const validDate = (s) => {
  if (typeof s !== "string" || !DATE_SHAPE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? s : null;
};

// Split a trailing `(added D[ · S][ · confirmed D])`. The WHOLE suffix must be valid (real dates, a source id);
// any malformed part leaves the suffix in the body and every metadata field null.
function splitMeta(line) {
  const m = /\s*\(added ([^()]*)\)$/.exec(line);
  if (!m) return null;
  const rest = m[1].split(" · ");
  const added = validDate(rest.shift());
  if (!added) return null;
  let source = null;
  let confirmed = null;
  if (rest.length && !rest[0].startsWith("confirmed ")) {
    source = rest.shift();
    if (!SOURCE_RE.test(source)) return null;
  }
  if (rest.length) {
    if (rest.length > 1 || !rest[0].startsWith("confirmed ")) return null;
    confirmed = validDate(rest[0].slice(10));
    if (!confirmed) return null;
  }
  return { text: line.slice(0, m.index), added, source, confirmed };
}

// ---- UTF-8 without TextEncoder/TextDecoder (the mod runtime has neither) ----

// UTF-8 byte length. A lone surrogate counts 3, as the encoder's U+FFFD does.
export function utf8Length(str) {
  if (typeof str !== "string") return 0;
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// The longest prefix of `str` that is at most `max` UTF-8 bytes; never ends inside a character or a surrogate pair.
export function utf8Cut(str, max) {
  if (typeof str !== "string") return "";
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    let w = 3, units = 1;
    if (c < 0x80) w = 1;
    else if (c < 0x800) w = 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { w = 4; units = 2; }
    if (n + w > max) return str.slice(0, i);
    n += w;
    i += units - 1;
  }
  return str;
}

// The UTF-8 bytes of `str` (lone surrogates as U+FFFD), as a plain array.
function utf8Bytes(str) {
  const out = [];
  for (const ch of str) {
    let cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp < 0xe000) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

// ---- fingerprint ----

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const idNumber = (e) => (Number.isInteger(e?.n) ? e.n : Number(/^L-(\d{1,6})$/.exec(e?.id ?? "")?.[1]));

// A content fingerprint (title + body, FNV-1a 64 over the UTF-8 of the NFC text). NOT a security hash: it
// ignores the metadata so a confirm keeps it. The writer's edit token is a separate full-entry SHA-256.
export function entryHash(entry) {
  const body = Array.isArray(entry?.body) ? entry.body : [];
  const text = `${canonId(idNumber(entry))}\n${sanitize(entry?.title)}\n${body.map(sanitize).join("\n")}`.normalize("NFC");
  let h = FNV_OFFSET;
  for (const b of utf8Bytes(text)) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK64;
  return h.toString(16).padStart(16, "0");
}

export function titleKey(title) {
  return sanitize(String(title ?? "")).normalize("NFC").toLowerCase();
}

// ---- bounded reading ----

// Cut to <= FILE_READ_MAX_BYTES UTF-8 bytes on a character boundary and drop the trailing partial entry
// (everything after the last complete blank-line / next-heading boundary). The cut happens when the text is over the
// limit or when the caller says the read was cut short (`truncated: true`, e.g. it hit the cap): then even an
// exact-cap text keeps its last entry only if a complete boundary follows it. A complete, short file is returned as is.
export function boundText(text, { truncated = false } = {}) {
  if (typeof text !== "string") return "";
  const over = utf8Length(text) > FILE_READ_MAX_BYTES;
  if (!over && !truncated) return text;
  const lines = utf8Cut(text, FILE_READ_MAX_BYTES).split("\n");
  // the last element is a possibly partial line: only the lines before it can be boundaries
  for (let j = lines.length - 2; j >= 0; j--) {
    if (lines[j].trim() === "" || lines[j].startsWith("###")) return j === 0 ? "" : `${lines.slice(0, j).join("\n")}\n`;
  }
  return "";
}

// ---- parse / format ----

export function parseEntries(text) {
  const out = { entries: [], skipped: 0 };
  if (typeof text !== "string") return out;
  const lines = boundText(text).split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const seen = new Set();
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("###")) { i++; continue; }
    const header = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "" && !lines[j].startsWith("###")) j++;
    const raw = lines.slice(i + 1, j);
    i = j;
    const h = parseHeader(header);
    if (!h || seen.has(h.n) || raw.length > BODY_LINES_MAX || [header, ...raw].join("\n").length > ENTRY_CHARS_MAX) { out.skipped++; continue; }
    const body = raw.map((l) => sanitize(l).normalize("NFC"));
    let meta = { added: null, source: null, confirmed: null };
    const last = body.length ? splitMeta(body[body.length - 1]) : null;
    if (last) {
      body[body.length - 1] = last.text.trim();
      meta = { added: last.added, source: last.source, confirmed: last.confirmed };
    }
    const kept = body.filter(Boolean);
    if (!kept.length) { out.skipped++; continue; }
    seen.add(h.n);
    const entry = { id: h.id, n: h.n, title: h.title, body: kept, ...meta };
    out.entries.push({ ...entry, hash: entryHash(entry) });
  }
  return out;
}

export function titles(text) {
  return parseEntries(text).entries.map((e) => ({ id: e.id, title: e.title }));
}

export function titleLine(layer, entry) {
  if (!LAYERS.includes(layer)) throw new Error("invalid lesson layer");
  const n = idNumber(entry);
  if (!Number.isInteger(n) || n < 1 || n > N_MAX) throw new Error("invalid lesson id");
  return `- [${layer}] ${canonId(n)}: ${entry.title}`;
}

// The canonical text of one entry; throws on anything parseEntries would not accept (the writer uses it).
export function formatEntry(x) {
  const bad = (why) => { throw new Error(`invalid lesson entry: ${why}`); };
  if (!x || typeof x !== "object") bad("not an object");
  const { n, title, body, added, source, confirmed } = x;
  if (!Number.isInteger(n) || n < 1 || n > N_MAX) bad("n");
  if (typeof title !== "string") bad("title");
  const h = entryTitle(`### ${canonId(n)} ${title}`);
  if (!h || h.title !== title.normalize("NFC")) bad("title");
  if (!Array.isArray(body) || body.length < 1 || body.length > BODY_LINES_MAX) bad("body lines");
  const lines = body.map((l) => {
    if (typeof l !== "string" || !l || l !== sanitize(l).normalize("NFC") || l.startsWith("###") || splitMeta(l)) bad("body line");
    return l;
  });
  if (added == null && (source != null || confirmed != null)) bad("metadata needs added");
  if (added != null) {
    if (!validDate(added)) bad("added");
    if (source != null && !SOURCE_RE.test(source)) bad("source");
    if (confirmed != null && !validDate(confirmed)) bad("confirmed");
    lines[lines.length - 1] += ` (added ${added}${source != null ? ` · ${source}` : ""}${confirmed != null ? ` · confirmed ${confirmed}` : ""})`;
  }
  const text = [`### ${canonId(n)} ${h.title}`, ...lines].join("\n");
  if (text.length > ENTRY_CHARS_MAX) bad("too long");
  const back = parseEntries(text);
  if (back.skipped || back.entries.length !== 1) bad("does not round-trip");
  return text;
}
