// Canonical copy lives in mods/_lib. Pure: Claude Code and Codex JSONL transcripts → entries
// { role: "user" | "assistant" | "tool", text }. Unknown records are skipped, never invented.

const MAX = 400; // ponytail: last 400 entries; older ones show as "N earlier entries"

const lines = (text) => String(text ?? "").split("\n").filter(Boolean).flatMap((l) => {
  try { return [JSON.parse(l)]; } catch { return []; }
});

const firstLine = (v) => String(v ?? "").split("\n")[0].slice(0, 160);

function toolLine(name, input) {
  const i = input ?? {};
  const arg = i.command ?? i.cmd ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description ?? "";
  return `${name}${arg ? `: ${firstLine(Array.isArray(arg) ? arg.join(" ") : arg)}` : ""}`;
}

export function claudeEntries(text) {
  const out = [];
  for (const r of lines(text)) {
    const c = r.message?.content;
    if (r.isSidechain || (r.type !== "user" && r.type !== "assistant")) continue;
    if (typeof c === "string") { if (r.type === "user" && !c.startsWith("<")) out.push({ role: "user", text: c }); continue; }
    for (const part of Array.isArray(c) ? c : []) {
      if (part.type === "text" && part.text?.trim() && !(r.type === "user" && part.text.startsWith("<"))) out.push({ role: r.type, text: part.text });
      else if (part.type === "tool_use") out.push({ role: "tool", text: toolLine(part.name, part.input) });
    }
  }
  return trim(out);
}

export function codexEntries(text) {
  const out = [];
  for (const r of lines(text)) {
    const p = r.payload ?? {};
    if (r.type !== "response_item") continue;
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const t = (p.content ?? []).map((x) => x.text ?? "").join("").trim();
      // Codex sends AGENTS.md and environment blocks as user messages: not the person's words.
      if (t && !(p.role === "user" && (t.startsWith("<") || t.startsWith("# AGENTS.md")))) out.push({ role: p.role, text: t });
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      let args = p.arguments ?? p.input ?? p.action;
      try { args = typeof args === "string" ? JSON.parse(args) : args; } catch { args = { command: args }; }
      out.push({ role: "tool", text: toolLine(p.name ?? "shell", args) });
    }
  }
  return trim(out);
}

function trim(entries) {
  return entries.length > MAX ? { entries: entries.slice(-MAX), earlier: entries.length - MAX } : { entries, earlier: 0 };
}
