// Canonical copy lives in mods/_lib. Pure: export, validate, plan and apply agents + squads.
// No fs, no exec, no node:crypto. Facts that need IO (env files, local souls and their hashes) come in as inputs.
// Design: work folder agents-export/design.md, sections 1 and 2.
import { argv, utf8Bytes } from "./runs.js";

export const FORMAT = "drover-herdr.agents";
export const VERSION = 1;
export const MAX_BYTES = 1048576;
export const MAX_AGENTS = 200;
export const MAX_SQUADS = 100;
export const MAX_MEMBERS = 50;
const ID = /^[A-Za-z0-9_-]{1,64}$/; // the agent env contract (io.js hasAgentEnv); squads use the same grammar
const SOUL = /^[a-z0-9-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const LIMIT = { name: 200, command: 4000, instructions: 100000, role: 1000 };
const HARNESSES = ["claude", "codex", "pi"];
const MAX_DEPTH = 32;
const MAX_COPY_TRIES = 1000;
const CHOICES = ["add", "skip", "keep", "copy", "overwrite"];
const WRITES = ["add", "copy", "overwrite"];
const ACTIONS = [...CHOICES, "blocked"];

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f]/;
const line = (v, max) => typeof v === "string" && v.trim() !== "" && v.length <= max && !CONTROL.test(v.trim());

// ---- sha-256 (the mod runtime has no node:crypto). Verified against known vectors and node:crypto in the tests.

const PRIMES = (() => { const p = []; for (let n = 2; p.length < 64; n++) if (p.every((q) => n % q)) p.push(n); return p; })();
const frac32 = (x) => Math.floor((x - Math.floor(x)) * 4294967296) >>> 0;
const K = PRIMES.map((p) => frac32(Math.cbrt(p)));
const H0 = PRIMES.slice(0, 8).map((p) => frac32(Math.sqrt(p)));

function utf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00); }
    else if (c >= 0xd800 && c < 0xe000) c = 0xfffd; // a lone surrogate, as TextEncoder does
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function sha256(text) {
  const b = utf8(String(text));
  const bits = b.length * 8;
  b.push(0x80);
  while (b.length % 64 !== 56) b.push(0);
  const hi = Math.floor(bits / 4294967296), lo = bits >>> 0;
  for (const w of [hi, lo]) b.push((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255);
  const h = H0.slice();
  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < b.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = ((b[i + 4 * t] << 24) | (b[i + 4 * t + 1] << 16) | (b[i + 4 * t + 2] << 8) | b[i + 4 * t + 3]) | 0;
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    [a, bb, c, d, e, f, g, hh].forEach((v, n) => { h[n] = (h[n] + v) | 0; });
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

// JSON with sorted keys: the same data gives the same text whatever the key order.
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x === undefined ? null : x)).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

// ---- secret scan. Best effort, no entropy heuristics. Rule names only; a value is never returned.
// The first group is the set of scripts/public-sync.sh; the rest was added by this feature. Patterns are built
// from parts so this file does not trip the public-sync leak scan itself.
const RULES = [
  ["github-token", new RegExp("gh" + "p_[A-Za-z0-9]{16,}")],
  ["github-pat", new RegExp("github" + "_pat_[A-Za-z0-9_]{20,}")],
  ["anthropic-key", new RegExp("sk-" + "ant-[A-Za-z0-9_-]{10,}")],
  ["private-key", new RegExp("-----BEGIN [A-Z ]*PRIVATE" + " KEY")],
  ["secret-assignment", /[A-Z0-9_]*(?:_API_KEY|_TOKEN|_SECRET) *= *[^ ]/],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
  ["secret-flag", /--(?:api-key|token|password)(?:=|\s+)(?![-<$])\S{8,}/],
];
export const scanSecrets = (text) => (typeof text === "string" ? RULES.filter(([, re]) => re.test(text)).map(([name]) => name) : []);
// A home folder with a user name is privacy, not a secret: a warning.
export const homePath = (text) => typeof text === "string" && /\/(?:Users|home)\/[A-Za-z0-9._-]+/.test(text);

// Problems of one agent or squad, as [{field, rule}]. Used by export (blocked) and import (row blocked).
const secretsOf = (pairs) => pairs.flatMap(([field, text]) => scanSecrets(text).map((rule) => ({ field, rule })));
const agentSecrets = (a) => secretsOf([["name", a.name], ["command", a.command], ["instructions", a.instructions]]);
const squadSecrets = (s) => secretsOf([["name", s.name], ...(Array.isArray(s.members) ? s.members : []).map((m) => ["role", m?.role])]);
export function scanItems({ agents = [], squads = [] }) {
  return [
    ...agents.flatMap((a) => agentSecrets(a).map((h) => ({ id: a.id, ...h }))),
    ...squads.flatMap((s) => squadSecrets(s).map((h) => ({ id: s.id, ...h }))),
  ];
}

// ---- env audit: the log holds names only. Replay it to know which variables an agent currently has.
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
function envNamesOf(log) {
  const names = new Set();
  for (const l of Array.isArray(log) ? log : []) {
    const m = typeof l === "string" ? l.match(/^\S+ (set|clear)(?: (.*))?$/) : null;
    if (!m) continue;
    // The editor logs the complete environment on each save: a set replaces the names, a clear empties them.
    names.clear();
    if (m[1] === "set" && m[2]) m[2].split(", ").filter((n) => ENV_NAME.test(n)).forEach((n) => names.add(n));
  }
  return [...names].sort();
}

const validCfg = (c) => isObj(c) && Array.isArray(c.agents) && Array.isArray(c.squads);
const digestOf = (c) => sha256(stableJson(c));

// ---- export

export function exportHerd(cfg, opts = {}) {
  if (!validCfg(cfg)) return { error: "No agents to export" };
  const all = opts.agents === undefined && opts.squads === undefined;
  const wantAgents = new Set(all ? cfg.agents.map((a) => a.id) : opts.agents ?? []);
  const wantSquads = new Set(all ? cfg.squads.map((s) => s.id) : opts.squads ?? []);
  for (const id of wantAgents) if (!cfg.agents.some((a) => a.id === id)) return { error: `No agent ${id}` };
  for (const id of wantSquads) {
    const s = cfg.squads.find((x) => x.id === id);
    if (!s) return { error: `No squad ${id}` };
    for (const ref of [s.leader, ...s.members.map((m) => m.agent)]) {
      if (!cfg.agents.some((a) => a.id === ref)) return { error: `Squad ${s.name} names a missing agent` };
      wantAgents.add(ref);
    }
  }
  if (!wantAgents.size && !wantSquads.size) return { error: "Nothing selected to export" };
  const agents = cfg.agents.filter((a) => wantAgents.has(a.id));
  const squads = cfg.squads.filter((s) => wantSquads.has(s.id));

  const blocked = [];
  const warnings = [];
  const souls = isObj(opts.souls) ? opts.souls : {};
  const outAgents = agents.map((a) => {
    const id = String(a.id);
    if (!ID.test(id)) blocked.push({ id, field: "id", rule: "id-contract" });
    for (const h of agentSecrets(a)) blocked.push({ id, ...h });
    for (const field of ["command", "instructions"]) if (homePath(a[field])) warnings.push({ id, field, rule: "home-path" });
    const hash = typeof a.soul === "string" && own(souls, a.soul) ? souls[a.soul] : null;
    const soulOk = typeof a.soul === "string" && SOUL.test(a.soul) && typeof hash === "string" && HASH.test(hash);
    if (a.soul && !soulOk) warnings.push({ id, field: "soul", rule: "soul-missing" });
    const needs = envNamesOf(a.envLog).length;
    return { id, name: String(a.name ?? ""), ...(soulOk ? { soul: a.soul, soulHash: hash } : {}), command: String(a.command ?? ""), instructions: String(a.instructions ?? ""), ...(needs ? { needsEnv: needs } : {}) };
  });
  const outSquads = squads.map((s) => {
    const id = String(s.id);
    if (!ID.test(id)) blocked.push({ id, field: "id", rule: "id-contract" });
    for (const h of squadSecrets(s)) blocked.push({ id, ...h });
    return { id, name: String(s.name ?? ""), leader: s.leader, members: s.members.map((m) => ({ agent: m.agent, role: String(m.role ?? "") })) };
  });
  if (blocked.length) return { blocked };
  const at = new Date(opts.now ?? 0);
  if (Number.isNaN(at.getTime())) return { error: "Bad export time" };
  const data = { format: FORMAT, version: VERSION, exported: at.toISOString(), app: String(opts.app ?? ""), agents: outAgents, squads: outSquads };
  return { file: JSON.stringify(data, null, 2), warnings, agents: outAgents.length, squads: outSquads.length };
}

// ---- import: read and validate the file

function badKey(v, depth = 0) {
  if (depth > MAX_DEPTH) return "deep";
  if (Array.isArray(v)) { for (const x of v) { const r = badKey(x, depth + 1); if (r) return r; } return null; }
  if (!isObj(v)) return null;
  for (const k of Object.keys(v)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return "proto";
    const r = badKey(v[k], depth + 1);
    if (r) return r;
  }
  return null;
}

function readFile(text, supported) {
  if (typeof text !== "string") return { errors: ["The file is not text"] };
  if (utf8Bytes(text) > MAX_BYTES) return { errors: ["The file is larger than 1 MB"] };
  let d;
  try { d = JSON.parse(text); } catch { return { errors: ["The file is not valid JSON"] }; }
  const bad = badKey(d);
  if (bad === "deep") return { errors: ["The file is nested too deeply"] };
  if (bad) return { errors: ["The file has a forbidden key (__proto__, constructor or prototype)"] };
  if (!isObj(d) || d.format !== FORMAT) return { errors: [`Not a ${FORMAT} file`] };
  if (!Number.isInteger(d.version) || d.version < 1) return { errors: ["The file has no valid version"] };
  if (d.version > supported) return { errors: [`The file is version ${d.version}; this Drover reads up to ${supported}. Update Drover`] };
  const agents = d.agents ?? [], squads = d.squads ?? [];
  if (!Array.isArray(agents) || !Array.isArray(squads)) return { errors: ["agents and squads must be lists"] };
  if (agents.length > MAX_AGENTS) return { errors: [`More than ${MAX_AGENTS} agents`] };
  if (squads.length > MAX_SQUADS) return { errors: [`More than ${MAX_SQUADS} squads`] };
  if (squads.some((s) => isObj(s) && Array.isArray(s.members) && s.members.length > MAX_MEMBERS)) return { errors: [`A squad has more than ${MAX_MEMBERS} members`] };
  for (const [kind, list] of [["agent", agents], ["squad", squads]]) {
    const seen = new Set();
    for (const x of list) {
      if (!isObj(x) || typeof x.id !== "string" || !ID.test(x.id)) continue;
      if (seen.has(x.id)) return { errors: [`Two ${kind}s share the id ${x.id}`] };
      seen.add(x.id);
    }
  }
  return { agents, squads };
}

const problem = (code, field) => ({ code, ...(field ? { field } : {}) });

// Builds the agent from the allowed fields only. problems = what makes the row unusable.
function cleanAgent(raw) {
  const problems = [];
  if (!isObj(raw)) return { item: null, problems: [problem("bad-item")] };
  const idOk = typeof raw.id === "string" && ID.test(raw.id);
  if (!idOk) problems.push(problem("bad-id", "id"));
  const str = (field, max, single = true) => {
    const v = raw[field];
    if (typeof v !== "string" || v.trim() === "" || v.length > max || (single ? CONTROL.test(v.trim()) : v.includes("\0"))) { problems.push(problem("bad-field", field)); return ""; }
    return v.trim();
  };
  const name = str("name", LIMIT.name);
  const command = str("command", LIMIT.command);
  if (command && !argv(command).length) problems.push(problem("bad-field", "command"));
  let instructions = "";
  if (raw.instructions !== undefined && raw.instructions !== null) {
    if (typeof raw.instructions !== "string" || raw.instructions.length > LIMIT.instructions || raw.instructions.includes("\0")) problems.push(problem("bad-field", "instructions"));
    else instructions = raw.instructions.trim();
  }
  let soul;
  if (raw.soul !== undefined && raw.soul !== null && raw.soul !== "") {
    if (typeof raw.soul !== "string") problems.push(problem("bad-field", "soul"));
    else soul = raw.soul;
  }
  const soulHash = typeof raw.soulHash === "string" && HASH.test(raw.soulHash) ? raw.soulHash : undefined;
  const needsEnv = Number.isInteger(raw.needsEnv) && raw.needsEnv > 0 && raw.needsEnv <= 100 ? raw.needsEnv : undefined;
  return { item: { id: idOk ? raw.id : "", name, ...(soul ? { soul } : {}), ...(soulHash ? { soulHash } : {}), command, instructions, ...(needsEnv ? { needsEnv } : {}) }, problems };
}

function cleanSquad(raw) {
  const problems = [];
  if (!isObj(raw)) return { item: null, problems: [problem("bad-item")] };
  const idOk = typeof raw.id === "string" && ID.test(raw.id);
  if (!idOk) problems.push(problem("bad-id", "id"));
  const name = line(raw.name, LIMIT.name) ? raw.name.trim() : (problems.push(problem("bad-field", "name")), "");
  const leader = typeof raw.leader === "string" && ID.test(raw.leader) ? raw.leader : (problems.push(problem("bad-field", "leader")), "");
  const members = [];
  const list = raw.members ?? [];
  if (!Array.isArray(list)) problems.push(problem("bad-field", "members"));
  else for (const m of list) {
    const role = isObj(m) && (m.role === undefined || m.role === null ? "" : m.role);
    if (!isObj(m) || typeof m.agent !== "string" || !ID.test(m.agent) || typeof role !== "string" || role.length > LIMIT.role || role.includes("\0")) { problems.push(problem("bad-field", "members")); break; }
    members.push({ agent: m.agent, role: role.trim() });
  }
  return { item: { id: idOk ? raw.id : "", name, leader, members }, problems };
}

// ---- import: plan

function normChoices(c) {
  const out = {};
  if (!isObj(c)) return out;
  for (const key of Object.keys(c).sort()) {
    const v = c[key];
    if (!/^(agent|squad):/.test(key) || !isObj(v)) continue;
    const e = {};
    if (CHOICES.includes(v.action)) e.action = v.action;
    if (v.ackEnv === true) e.ackEnv = true;
    if (v.ackSoul === true) e.ackSoul = true;
    if (Object.keys(e).length) out[key] = e;
  }
  return out;
}

const tokenOf = (fileDigest, digest, choices) => sha256(`${fileDigest}|${digest}|${stableJson(choices)}`);
const basename = (p) => String(p).slice(String(p).lastIndexOf("/") + 1);

// ctx: { localSouls: {name: hash}, envIds: Set of agent ids that have an env file | {error}, supported: 1 }
// choices: { "agent:<id>"|"squad:<id>": { action: add|skip|keep|copy|overwrite, ackEnv?: true, ackSoul?: true } }
export function plan(cfg, text, ctx = {}, choices = {}) {
  const digest = validCfg(cfg) ? digestOf(cfg) : null;
  const norm = normChoices(choices);
  const fail = (...errors) => ({ rows: [], warnings: [], errors, digest, token: null, fileDigest: null, choices: norm, ok: false });
  if (!validCfg(cfg)) return fail("The destination configuration is not valid");
  const envIds = ctx?.envIds;
  if (!(envIds instanceof Set)) return fail(`Cannot check the agent environment files${isObj(envIds) && envIds.error ? ` (${String(envIds.error).slice(0, 80)})` : ""}`);
  const localSouls = isObj(ctx.localSouls) ? ctx.localSouls : {};
  const file = readFile(text, ctx.supported ?? VERSION);
  if (file.errors) return fail(...file.errors);

  const cfgAgentIds = new Set(cfg.agents.map((a) => a.id));
  const usedAgent = new Set([...cfgAgentIds, ...file.agents.filter((a) => isObj(a) && typeof a.id === "string" && ID.test(a.id)).map((a) => a.id)]);
  const usedSquad = new Set([...cfg.squads.map((s) => s.id), ...file.squads.filter((s) => isObj(s) && typeof s.id === "string" && ID.test(s.id)).map((s) => s.id)]);
  const copyId = (id, used, blockedBy) => {
    for (let n = 2; n < 2 + MAX_COPY_TRIES; n++) {
      const suffix = `-${n}`;
      const cand = id.slice(0, 64 - suffix.length) + suffix;
      if (!used.has(cand) && !blockedBy(cand)) { used.add(cand); return { id: cand, n }; }
    }
    return null;
  };
  const suffixName = (name, n) => `${name.slice(0, LIMIT.name - String(n).length - 1)} ${n}`;

  const rows = [];
  const avail = new Map(); // file agent id -> the id a squad should point at, or null when it will not exist

  file.agents.forEach((raw, i) => {
    const { item, problems } = cleanAgent(raw);
    const blocked = [...problems];
    if (item && !problems.length) for (const h of agentSecrets(item)) blocked.push({ code: "secret", ...h });
    // A secret-shaped id is never echoed: the row is keyed by position.
    if (item?.id && scanSecrets(item.id).length) { blocked.push({ code: "secret", field: "id", rule: scanSecrets(item.id)[0] }); item.id = ""; }
    const shownId = item?.id ?? "";
    const key = shownId ? `agent:${shownId}` : `agent#${i}`;
    const base = { key, kind: "agent", id: shownId, name: item?.name ?? "", warnings: [], pendingAck: [] };
    if (blocked.length) {
      rows.push({ ...base, name: "", action: "blocked", blocked, item: null }); // a blocked row shows no text of the file
      if (shownId) avail.set(shownId, null);
      return;
    }
    const warnings = [];
    const warn = (code, text, field) => warnings.push({ code, text, ...(field ? { field } : {}) });
    const c = norm[key] ?? {};
    // Soul: a name that is not a local soul file is never kept.
    let soulDropped = false;
    if (item.soul) {
      if (SOUL.test(item.soul) && own(localSouls, item.soul)) {
        const local = localSouls[item.soul];
        if (item.soulHash && typeof local === "string" && HASH.test(local) && local !== item.soulHash) warn("soul-differs", `Your ${item.soul} soul differs from the sender's; the agent will use yours`, "soul");
      } else {
        soulDropped = true;
        warn("soul-dropped", `No local soul "${String(item.soul).slice(0, 64)}": the agent imports without a soul and only its instructions apply`, "soul");
        delete item.soul;
      }
    }
    delete item.soulHash;
    if (item.needsEnv) warn("needs-env", `Re-add ${item.needsEnv} environment variable${item.needsEnv === 1 ? "" : "s"} after the import`);
    if (homePath(item.command)) warn("home-path", "The command has a home folder path", "command");
    if (homePath(item.instructions)) warn("home-path", "The instructions have a home folder path", "instructions");
    const exe = basename(argv(item.command)[0] ?? "");
    if (!HARNESSES.includes(exe)) warn("unknown-harness", `Unknown program "${exe.slice(0, 64)}": it will run on this machine when the agent starts`, "command");

    const existing = cfg.agents.find((a) => a.id === item.id);
    let action, newId, version, envNames, hasEnv;
    if (!existing) {
      action = c.action === "skip" ? "skip" : "add";
      if (action === "add" && envIds.has(item.id)) {
        rows.push({ ...base, name: "", action: "blocked", blocked: [{ code: "env-orphan", text: "An environment file already exists for this id; remove it or pick another id" }], warnings, item: null });
        avail.set(item.id, null);
        return;
      }
    } else {
      const same = existing.name === item.name && (existing.soul ?? undefined) === item.soul && existing.command === item.command && (existing.instructions ?? "") === item.instructions;
      if (same) action = "skip";
      else {
        action = ["copy", "overwrite", "keep"].includes(c.action) ? c.action : "keep";
        if (existing.command !== item.command) warn("command-changed", "The command of an existing agent changes", "command");
        if ((existing.instructions ?? "") !== item.instructions) warn("instructions-changed", "The instructions of an existing agent change", "instructions");
      }
    }
    if (action === "add" || action === "copy") {
      const other = cfg.agents.find((a) => a.id !== item.id && String(a.name).toLowerCase() === item.name.toLowerCase());
      if (other) warn("name-clash", `Another agent (${other.id}) has the same name`);
    }
    const out = { ...item };
    if (action === "copy") {
      const got = copyId(item.id, usedAgent, (cand) => envIds.has(cand));
      if (!got) {
        rows.push({ ...base, name: "", action: "blocked", blocked: [{ code: "no-free-id", text: "No free copy id" }], warnings, item: null });
        avail.set(item.id, null);
        return;
      }
      newId = got.id;
      out.id = newId;
      out.name = suffixName(item.name, got.n);
    }
    if (action === "overwrite") {
      version = (Number.isInteger(existing.version) ? existing.version : 0) + 1;
      envNames = envNamesOf(existing.envLog);
      hasEnv = envIds.has(item.id);
    }
    const pendingAck = [];
    if (WRITES.includes(action) && soulDropped && c.ackSoul !== true) pendingAck.push("soul");
    if (action === "overwrite" && hasEnv && c.ackEnv !== true) pendingAck.push("env");
    avail.set(item.id, action === "skip" && !existing ? null
      : action === "add" ? (pendingAck.length ? null : item.id)
      : action === "copy" ? (pendingAck.length ? null : newId)
      : item.id);
    rows.push({
      ...base, action, blocked: [], warnings, pendingAck, item: out,
      ...(newId ? { newId } : {}), ...(version ? { version, envNames, hasEnv } : {}),
      ...(existing ? { existing: { name: existing.name, soul: existing.soul, command: existing.command, instructions: existing.instructions ?? "", version: existing.version } } : {}),
    });
  });

  file.squads.forEach((raw, i) => {
    const { item, problems } = cleanSquad(raw);
    const blocked = [...problems];
    if (item && !problems.length) for (const h of squadSecrets(item)) blocked.push({ code: "secret", ...h });
    if (item?.id && scanSecrets(item.id).length) { blocked.push({ code: "secret", field: "id", rule: scanSecrets(item.id)[0] }); item.id = ""; }
    const key = item?.id ? `squad:${item.id}` : `squad#${i}`;
    const base = { key, kind: "squad", id: item?.id ?? "", name: item?.name ?? "", warnings: [], pendingAck: [] };
    if (!blocked.length) {
      const resolve = (id) => {
        const hit = avail.has(id) ? avail.get(id) : cfgAgentIds.has(id) ? id : undefined;
        if (hit) return hit;
        blocked.push({ code: hit === null ? "ref-unavailable" : "ref-missing", ref: scanSecrets(id).length ? "" : id });
        return id;
      };
      item.leader = resolve(item.leader);
      item.members = item.members.map((m) => ({ agent: resolve(m.agent), role: m.role }));
    }
    if (blocked.length) { rows.push({ ...base, name: "", action: "blocked", blocked, item: null }); return; }
    const c = norm[key] ?? {};
    const existing = cfg.squads.find((s) => s.id === item.id);
    let action, newId, version;
    if (!existing) action = c.action === "skip" ? "skip" : "add";
    else if (existing.name === item.name && existing.leader === item.leader && stableJson(existing.members) === stableJson(item.members)) action = "skip";
    else action = ["copy", "overwrite", "keep"].includes(c.action) ? c.action : "keep";
    const out = { ...item };
    if (action === "copy") {
      const got = copyId(item.id, usedSquad, () => false);
      if (!got) { rows.push({ ...base, name: "", action: "blocked", blocked: [{ code: "no-free-id", text: "No free copy id" }], item: null }); return; }
      newId = got.id;
      out.id = newId;
      out.name = suffixName(item.name, got.n);
    }
    if (action === "overwrite") version = (Number.isInteger(existing.version) ? existing.version : 0) + 1;
    rows.push({ ...base, action, blocked: [], item: out, ...(newId ? { newId } : {}), ...(version ? { version } : {}) });
  });

  const fileDigest = sha256(text);
  const result = {
    rows, errors: [], digest, fileDigest, choices: norm, ok: true, token: tokenOf(fileDigest, digest, norm),
    warnings: rows.flatMap((r) => r.warnings.map((w) => ({ row: r.key, ...w }))),
  };
  // The bound file travels with the plan in memory only: not enumerable, so it never reaches JSON, a log or a preview.
  // apply recomputes the authoritative plan from it. A plan that was serialized hands the text back through ctx.fileText.
  Object.defineProperty(result, "fileText", { value: text, enumerable: false });
  return result;
}

// ---- apply

// Final check, the same as saveSquad: unique ids, an id the env contract accepts for everything written, no dangling refs.
function finalProblem(agents, squads, writtenAgents, writtenSquads) {
  const ids = new Set();
  for (const a of agents) { if (ids.has(a.id)) return `Two agents share the id ${a.id}`; ids.add(a.id); }
  const sids = new Set();
  for (const s of squads) { if (sids.has(s.id)) return `Two squads share the id ${s.id}`; sids.add(s.id); }
  for (const id of [...writtenAgents, ...writtenSquads]) if (!ID.test(id)) return `Bad id ${String(id).slice(0, 20)}`;
  for (const s of squads) if (!ids.has(s.leader) || s.members.some((m) => !ids.has(m.agent))) return `Squad ${s.name} names a missing agent`;
  return null;
}

export function apply(cfg, p, ctx = {}) {
  if (!isObj(p) || !Array.isArray(p.rows) || (p.errors && p.errors.length) || typeof p.token !== "string" || !isObj(p.choices)) return { error: "No plan to apply" };
  if (!validCfg(cfg)) return { error: "The destination configuration is not valid" };
  if (p.token !== tokenOf(p.fileDigest, p.digest, p.choices)) return { error: "The plan does not match its token" };
  if (digestOf(cfg) !== p.digest) return { stale: true };
  const envIds = ctx?.envIds;
  if (!(envIds instanceof Set)) return { error: "Cannot check the agent environment files" };

  let agents = cfg.agents.slice();
  let squads = cfg.squads.slice();
  const applied = [], held = [], writtenAgents = [], writtenSquads = [];
  for (const r of p.rows) {
    if (!isObj(r) || !ACTIONS.includes(r.action) || !["agent", "squad"].includes(r.kind)) return { error: "The plan has a row it cannot read" };
    if (!WRITES.includes(r.action)) continue;
    if (!isObj(r.item) || !Array.isArray(r.pendingAck)) return { error: "The plan has a row it cannot read" };
    if (r.pendingAck.length) { held.push(r.key); continue; }
    const it = r.item;
    if (r.kind === "agent") {
      const { problems } = cleanAgent(it);
      if (problems.length || agentSecrets(it).length) return { error: `Agent ${String(it.id).slice(0, 64)} is not valid` };
      if (it.soul && isObj(ctx.localSouls) && !(SOUL.test(it.soul) && own(ctx.localSouls, it.soul))) return { stale: true };
      const existing = agents.find((a) => a.id === it.id);
      const base = { id: it.id, name: it.name, ...(it.soul ? { soul: it.soul } : {}), command: it.command, instructions: it.instructions };
      if (r.action === "overwrite") {
        if (!existing) return { error: `No agent ${it.id} to overwrite` };
        if (envIds.has(it.id) && p.choices[r.key]?.ackEnv !== true) return { error: `Agent ${it.id} has an environment: acknowledge the overwrite` };
        const next = { ...base, ...(Array.isArray(existing.envLog) ? { envLog: existing.envLog } : {}), version: (Number.isInteger(existing.version) ? existing.version : 0) + 1 };
        agents = agents.map((a) => (a.id === it.id ? next : a));
      } else {
        if (existing) return { error: `An agent ${it.id} exists` };
        if (envIds.has(it.id)) return { error: `An environment file already exists for ${it.id}` };
        agents.push({ ...base, version: 1 });
      }
      writtenAgents.push(it.id);
    } else {
      const { problems } = cleanSquad(it);
      if (problems.length || squadSecrets(it).length) return { error: `Squad ${String(it.id).slice(0, 64)} is not valid` };
      const existing = squads.find((s) => s.id === it.id);
      const base = { id: it.id, name: it.name, leader: it.leader, members: it.members.map((m) => ({ agent: m.agent, role: m.role })) };
      if (r.action === "overwrite") {
        if (!existing) return { error: `No squad ${it.id} to overwrite` };
        squads = squads.map((s) => (s.id === it.id ? { ...base, version: (Number.isInteger(existing.version) ? existing.version : 0) + 1 } : s));
      } else {
        if (existing) return { error: `A squad ${it.id} exists` };
        squads.push({ ...base, version: 1 });
      }
      writtenSquads.push(it.id);
    }
    applied.push({ key: r.key, action: r.action, id: it.id });
  }
  const bad = finalProblem(agents, squads, writtenAgents, writtenSquads);
  if (bad) return { error: bad };
  // Never trust the plan object: rebuild the plan from the bound file, the current config, the current facts and the
  // reviewed choices, and apply only if the rows we just acted on are exactly those.
  const fileText = typeof p.fileText === "string" ? p.fileText : ctx.fileText;
  if (typeof fileText !== "string") return { error: "The plan has no file bound to it" };
  const auth = plan(cfg, fileText, ctx, p.choices);
  if (!auth.ok || auth.token !== p.token || stableJson(auth.rows) !== stableJson(p.rows)) return { error: "The plan does not match the file, the configuration and the choices it was made from" };
  return { config: { ...cfg, agents, squads }, applied, held };
}
