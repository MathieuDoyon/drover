// Drover Config dialog model. Pure: no herdr import, so node --test runs it.
// The schema and the override helpers are injected (createModel) because main.js imports the install.sh copies
// (./config-schema.js, ./config.js) while the tests import the canonical _lib files.
// Nothing here writes. set/reset/resetAll return a NEW shared object; the view stores it with setShared("drover.config", ...).

const TITLES = { "drover-github": "GitHub", "drover-config": "General" };

const title = (mod) => TITLES[mod] ?? mod.replace(/^drover-/, "").replace(/^./, (c) => c.toUpperCase());

export function createModel({ SCHEMA, validate, isOverride, setOverride, resetOverride, resolve, parseQuery }) {
  const find = (mod, key) => SCHEMA.find((f) => f.mod === mod && f.key === key);
  const show = (f, value) => (f.type === "list" ? value.join(", ") : String(value));

  // Draft text (or a boolean) -> { ok, value } | { ok: false, error }. Text for int/list is parsed first, then the schema validates.
  // The GitHub default query must parse to at least one term (parseQuery drops a `key:` with no value); anything else is opaque.
  const queryProblem = (f, r) => (parseQuery && f.mod === "drover-github" && f.key === "query" && r.ok && !parseQuery(r.value).length
    ? { ok: false, error: "Not a usable GitHub query. Use words or key:value terms, for example is:issue state:open" } : r);

  function check(mod, key, raw) {
    const f = find(mod, key);
    if (!f) return { ok: false, error: "Unknown setting" };
    return queryProblem(f, checkType(f, raw));
  }
  function checkType(f, raw) {
    if (f.type === "int" && typeof raw === "string") {
      const s = raw.trim();
      if (!/^-?\d+$/.test(s)) return { ok: false, error: "Must be a whole number" };
      return validate(f, Number(s));
    }
    if (f.type === "list" && typeof raw === "string") {
      return validate(f, raw.split(",").map((x) => x.trim()).filter(Boolean));
    }
    return validate(f, raw);
  }

  // The value in force: a valid override, else the valid inherited mod.json value, else the default (config.js resolve).
  const effective = (shared, inherited, f) => resolve(shared, inherited, f.mod, f.key);
  // The valid value the mod.json layer gives this field, or undefined. This is what Reset goes back to.
  const inheritedValue = (inherited, f) => {
    if (inherited === null || typeof inherited !== "object" || !Object.hasOwn(inherited, f.key)) return undefined;
    const r = validate(f, inherited[f.key]);
    return r.ok ? r.value : undefined;
  };

  return {
    mods(shared) {
      return [...new Set(SCHEMA.map((f) => f.mod))].map((mod) => ({
        mod,
        title: title(mod),
        changed: SCHEMA.filter((f) => f.mod === mod && isOverride(shared, mod, f.key)).length,
      }));
    },
    // inherited: the mod's mod.json `settings` object (the dialog loads it); omit it and only the default is inherited.
    rows(shared, mod, inherited) {
      return SCHEMA.filter((f) => f.mod === mod).map((f) => {
        const value = effective(shared, inherited, f);
        const inh = inheritedValue(inherited, f);
        return { ...f, value, text: show(f, value), changed: isOverride(shared, mod, f.key), defaultText: show(f, f.default), inheritedText: inh === undefined ? null : show(f, inh) };
      });
    },
    check,
    // { ok: true, shared } or { ok: false, error } (no shared: an invalid value is never written).
    set(shared, mod, key, raw) {
      const r = check(mod, key, raw);
      if (!r.ok) return r;
      return { ok: true, shared: setOverride(shared, mod, key, r.value) };
    },
    reset: (shared, mod, key) => resetOverride(shared, mod, key),
    resetAll: (shared, mod) => SCHEMA.filter((f) => f.mod === mod).reduce((acc, f) => resetOverride(acc, mod, f.key), shared),
    step(f, current, dir) {
      return Math.min(f.max, Math.max(f.min, current + dir));
    },
    // The -/+ buttons start from what the person typed when it is a number, else from the effective value.
    stepFrom(mod, key, draft, current, dir) {
      const f = find(mod, key);
      const s = String(draft ?? "").trim();
      return this.step(f, /^-?\d+$/.test(s) ? Number(s) : current, dir);
    },
  };
}
