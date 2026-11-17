// Node loader hooks: map the Herdr-only modules to stubs, and the mod's generated ./store.js, ./io.js, ./wake.js and ./sources.js to _lib.
const here = new URL("./", import.meta.url);
const stub = (name) => new URL(`stubs/${name}.js`, here).href;
const lib = (name) => new URL(`../_lib/${name}`, here).href;

export function resolve(specifier, context, next) {
  if (["gpui-kit", "gpui-base", "herdr"].includes(specifier)) return { url: stub(specifier), shortCircuit: true };
  if (specifier === "fs/promises") return { url: stub("fs-promises"), shortCircuit: true };
  if (["./store.js", "./io.js", "./wake.js", "./sources.js", "./runs.js", "./sourcelist.js", "./ui.js", "./taskrun.js", "./notesend.js", "./config.js", "./config-schema.js", "./keys.js", "./workfolder.js", "./transcript.js", "./remote.js", "./herd-export.js", "./herd-share.js"].includes(specifier) && !context.parentURL?.includes("/_lib/")) return { url: lib(specifier.slice(2)), shortCircuit: true };
  // The dialog validates the GitHub query with the GitHub mod's own parser; install.sh copies it into drover-config.
  if (specifier === "./query.js" && context.parentURL?.includes("/drover-config/")) return { url: new URL("../drover-github/query.js", here).href, shortCircuit: true };
  return next(specifier, context);
}
