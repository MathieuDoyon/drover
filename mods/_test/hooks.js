// Node loader hooks: map the Herdr-only modules to stubs, and the mod's generated ./store.js, ./io.js, ./wake.js and ./sources.js to _lib.
const here = new URL("./", import.meta.url);
const stub = (name) => new URL(`stubs/${name}.js`, here).href;
const lib = (name) => new URL(`../_lib/${name}`, here).href;

export function resolve(specifier, context, next) {
  if (["gpui-kit", "gpui-base", "herdr"].includes(specifier)) return { url: stub(specifier), shortCircuit: true };
  if (specifier === "fs/promises") return { url: stub("fs-promises"), shortCircuit: true };
  if (["./store.js", "./io.js", "./wake.js", "./sources.js", "./runs.js", "./sourcelist.js", "./ui.js", "./taskrun.js", "./notesend.js", "./config.js", "./config-schema.js", "./keys.js", "./workfolder.js", "./transcript.js", "./remote.js", "./herd-export.js", "./herd-share.js", "./needs.js", "./needsnav.js", "./accept.js", "./runline.js", "./runscache.js", "./jump.js", "./dockbadge.js"].includes(specifier) && !context.parentURL?.includes("/_lib/")) return { url: lib(specifier.slice(2)), shortCircuit: true };
  // The dialog validates the GitHub query with the GitHub mod's own parser; install.sh copies it into drover-config.
  if (specifier === "./query.js" && context.parentURL?.includes("/drover-config/")) return { url: new URL("../drover-github/query.js", here).href, shortCircuit: true };
  return next(specifier, context);
}

// Test spies: every call of these exports bumps globalThis.__calls[name] (slotSnapshot also keeps globalThis.__slotCalls). A screen's render must make none.
// The original is renamed to <name>Inner and the export becomes a counting wrapper. Production code is untouched.
const SPIES = { "/_lib/runs.js": ["slotSnapshot", "lineageOf", "squadRows", "runStatus"], "/_lib/runline.js": ["lineOf"] };
export async function load(url, context, next) {
  const r = await next(url, context);
  const key = Object.keys(SPIES).find((k) => url.endsWith(k));
  if (!key || r.format !== "module") return r;
  let src = String(r.source), extra = "";
  for (const name of SPIES[key]) {
    const renamed = src.replace(`export function ${name}(`, `function ${name}Inner(`);
    if (renamed === src) continue;
    src = renamed;
    extra += `\nexport const ${name} = (...a) => { const c = (globalThis.__calls ??= {}); c.${name} = (c.${name} ?? 0) + 1;${name === "slotSnapshot" ? " globalThis.__slotCalls = (globalThis.__slotCalls ?? 0) + 1;" : ""} return ${name}Inner(...a); };`;
  }
  return extra ? { ...r, source: src + extra + "\n" } : r;
}
