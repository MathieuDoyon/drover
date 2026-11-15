// A chainable no-op element. Opt in to recording with globalThis.__rec = { ids: [], texts: [] }:
// then .when(cond, fn) runs fn when cond is true, and .id(x) / .child("text") are recorded, so a test can see which
// branches rendered. Layout is still not under test.
const collect = (rec, a) => {
  if (typeof a === "string" || typeof a === "number") rec.texts.push(String(a));
  else if (a && typeof a === "object" && Symbol.iterator in a) for (const x of a) collect(rec, x);
};
// With __rec on, the chain keeps one node per element: { id, kids }. root[NODE] gives a test the tree (who sits inside whom).
export const NODE = Symbol.for("test.node");
const kidsOf = (a, out) => { if (a && (typeof a === "function" || typeof a === "object") && Array.isArray(a[NODE]?.kids)) out.push(a[NODE]); else if (a && typeof a === "object" && Symbol.iterator in a) for (const x of a) kidsOf(x, out); };
// The host throws when on_mouse_down / on_mouse_up get no MouseButton first (gpui-kit.d.ts: (button, handler)).
const BUTTONS = ["left", "right", "middle"];
const checked = (k, fn) => (...a) => {
  if (!BUTTONS.includes(a[0])) throw new Error(`${k}: first argument must be 'left' | 'right' | 'middle', got ${typeof a[0]}`);
  if (typeof a[1] !== "function") throw new Error(`${k}: second argument must be a handler`);
  return fn(...a);
};
export const el = () => {
  const node = { id: null, kids: [], calls: [], args: {} }; // calls: the style methods chained on it (flex_none, h_full, ...); args: the last arguments of each
  const self = new Proxy(() => el(), {
    get: (_t, k) => {
      const rec = globalThis.__rec;
      if (k === "then") return undefined;
      if (k === NODE) return node;
      if (k === "on_mouse_down" || k === "on_mouse_up") {
        if (rec) return checked(k, (...a) => { node.calls.push(String(k)); node.args[k] = a; return self; });
        return checked(k, () => el());
      }
      if (rec && k === "when") return (c, f) => { if (c) f(self); return self; };
      if (rec && k === "id") return (v) => { rec.ids.push(String(v)); node.id = String(v); return self; };
      if (rec && (k === "child" || k === "children" || k === "trigger" || k === "content")) return (a) => { node.calls.push(String(k)); node.args[k] = [a]; collect(rec, a); kidsOf(a, node.kids); return self; };
      if (rec) return (...a) => { node.calls.push(String(k)); node.args[k] = a; return self; };
      return el();
    },
    apply: () => el(),
  });
  return self;
};
