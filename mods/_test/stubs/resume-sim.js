// A simulated Herdr for the resume tests: terminals that open, report statuses, deliver (or not) and die on a script.
// A behavior: { status(read), delivered(read), killFails?, noRecord? }. OK = ready at once.
// The live list always holds a bystander (t900, the person's own terminal), so "the list is not empty" holds as it does for real.
export const OK = { status: () => "idle", delivered: () => true };
export const SID = { lead: "11111111-2222-4333-8444-555555555555", a: "66666666-7777-4888-8999-aaaaaaaaaaaa", b: "99999999-7777-4888-8999-bbbbbbbbbbbb" };

export function makeSim(host, { first = 100 } = {}) {
  const sim = { plan: [], terms: new Map(), n: first, hc: [], calls: [], snap: 0, empty: new Set(), onGet: null, onOpen: null, onPark: null, blackout: false, gate: null, files: new Map(), exists: new Set(), git: null };
  host.hc = async (args) => {
    sim.hc.push(args);
    if (args[0] === "get") {
      if (args[1] === "t900") return { code: 0, stdout: JSON.stringify({ address: "t900", state: "live", argv: ["/bin/zsh"] }), stderr: "" }; // the person's own terminal
      const t = sim.terms.get(args[1]);
      if (!t) return { code: 1, stdout: "", stderr: "no terminal" };
      sim.onGet?.(args[1]);
      return { code: 0, stdout: JSON.stringify({ address: args[1], state: t.killed && !t.b.killFails ? "exited" : "live", argv: [...t.argv, t.task],
        ...(t.b.noRecord ? {} : { first_message: { sent: t.b.delivered(t.reads) } }) }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  host.exec = async (cmd, args, opts) => {
    if (cmd === "sleep") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "test") return { code: sim.exists.has(args[1]) ? 0 : 1, stdout: "", stderr: "" };
    if (cmd === "git") return sim.git ? sim.git(args, opts) : { code: 1, stdout: "", stderr: "no git" };
    if (cmd === "ls" || cmd === "grep") return sim.search?.(cmd, args) ?? { code: 1, stdout: "", stderr: "" };
    if (cmd !== "herdr-app") return { code: 0, stdout: "", stderr: "" };
    const [, op, ...rest] = args;
    sim.calls.push([op, rest]);
    if (op === "tab.new" || op === "space.new") {
      sim.onOpen?.(op, rest);
      if (sim.gate) await sim.gate;
      const address = `t${++sim.n}`, b = sim.plan.shift() ?? OK;
      sim.terms.set(address, { b, reads: 0, killed: false, argv: JSON.parse(rest[rest.indexOf("--argv") + 1]), task: rest[rest.indexOf("--task") + 1] });
      return { code: 0, stdout: JSON.stringify({ terminal: address, space: op === "space.new" ? `sp-new${sim.n}` : rest[rest.indexOf("--space") + 1] }), stderr: "" };
    }
    if (op === "terminal.park") sim.onPark?.(rest[rest.indexOf("--terminal") + 1]);
    if (op === "terminal.kill") { const t = sim.terms.get(rest[rest.indexOf("--terminal") + 1]); if (t) t.killed = true; return { code: 0, stdout: "{}", stderr: "" }; }
    return { code: 0, stdout: "{}", stderr: "" };
  };
  Object.defineProperty(host, "terminals", { configurable: true, get() {
    if (sim.empty.has(++sim.snap) || sim.blackout) return [];
    const out = [{ address: "t900" }];
    for (const [address, t] of sim.terms) {
      t.reads++;
      const status = t.killed && !t.b.killFails ? "gone" : t.b.status(t.reads);
      if (status === "gone") continue;
      out.push({ address, ...(status === "running" ? {} : { status }) });
    }
    return out;
  } });
  sim.opened = () => [...sim.terms.keys()];
  sim.killed = () => sim.calls.filter(([op]) => op === "terminal.kill").map(([, r]) => r[r.indexOf("--terminal") + 1]);
  sim.parked = () => sim.calls.filter(([op]) => op === "terminal.park").map(([, r]) => r[r.indexOf("--terminal") + 1]);
  sim.ops = () => sim.calls.map(([op]) => op);
  sim.opens = () => sim.calls.filter(([op]) => op === "tab.new" || op === "space.new");
  return sim;
}
