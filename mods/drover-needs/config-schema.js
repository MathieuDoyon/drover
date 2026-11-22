// Drover Config schema: every setting the Drover mods let the person change. Pure ES module, no herdr import.
// Canonical copy lives in mods/_lib; install.sh copies it into each drover-* mod.
//
// Field matrix: field -> storage -> consumer (card that wires it) -> test.
// Storage for every field: shared key "drover.config" = { "<mod>": { "<key>": value } }, only changed values;
// fallback layer: the mod's mod.json `settings` block; last: the default below (see config.js).
//
// | field                          | consumer (wired by)                      | default test (mods/_test/config.test.js)        |
// |--------------------------------|------------------------------------------|-------------------------------------------------|
// | <mod>.enabled (11 mods)        | isEnabled() in each screen (card 4/5)    | _test/config-gate.test.js: every folder has one, or is exempt (config, tabs, newtask) |
// | drover-github.query            | github main.js, filter.js (card 3)       | = toArgs(DEFAULT_QUERY) (query.js)              |
// | drover-github.scopes           | github main.js (card 3)                  | = [] (no scopes until the person adds them)     |
// | drover-github.limit            | github main.js cfg() (card 3)            | clamp 1-1000, default 100                       |
// | drover-jira.jql                | jira main.js cfg() (card 3)              | default JQL text                                |
// | drover-jira.pages              | jira main.js cfg() (card 3)              | clamp 1-20, default 4                           |
// | drover-jira.refresh_minutes    | jira main.js, checked each minute (3)    | clamp 1-1440, default 5                         |
// | drover-jira.site               | jira main.js, io.js jiraFetch (card 3)   | intentionally "" (see below)                    |
// | drover-config.work_folder      | io.js launch() -> runs.js prompts (T-MWFPX2MUYRU) | enum repo|project, default project (workfolder.js) |
// | drover-room.refresh_minutes    | room main.js refresh(), cfg() on each use (card 5)  | = 5 (the old EVERY_MIN), clamp 1-1440 |
// | drover-room.pr_cap / kept_contexts | io.js loadContext (10), room main.js (30) (card 5) | = 10 / 30, tunables.test.js              |
// | drover-runs.max_parallel       | runs.js maxRuns() (card 5)               | = MAX_RUNS (runs.js)                            |
// | drover-runs.kept               | io.js launch() via pruneRuns (card 5)    | = 200; only ended runs are dropped              |
// | drover-runs.hold_load / hold_memory / hold_disk / hold_machines | io.js holdFor() in launch() and the resume paths (T-MWO2HEU32E4) | 1 / 80 / 90 / "" (_lib/loadhold.test.js, _test/load-hold.test.js); owner's limits: not agent-settable |
// | drover-wakeups.min_repeat_minutes | wake.js build(): UI, Room, CLI inbox (card 5) | = MIN_EVERY (wake.js)                  |
// | drover-wakeups.expiry_hours    | wake.js window() (card 5)                | = EXPIRES_AFTER (wake.js)                       |
// | drover-wakeups.ui_tick_seconds | wakeups main.js timer (card 5, applies on reopen) | = 30                                   |
// | drover-todos.context_refresh_seconds | todos main.js timer (card 5, on reopen) | = 60                                       |
// | drover-todos.pr_cap / run_history_cap / wake_cap | todos main.js (card 5)  | = 10 / 10 / 20                                  |
// | drover-agents.default_squad    | agents main.js Picker (card 6)           | "" = no squad: the picker starts on the claude agent, as before. A squad id; an id that no longer exists is ignored |
// | drover-agents.default_worktree | agents main.js Picker (card 6)           | false (picker checkbox starts off)              |
// | drover-agents.default_report   | agents main.js Picker (card 6)           | false (picker checkbox starts off)              |
// | drover-board.visible_columns   | board main.js columns() (card 6)         | all 6 ids of store.js COLUMNS; unknown ids and an empty list are rejected |
// | drover-board.default_sort      | board main.js sort per column (card 6)   | manual (a column's own Sort menu choice wins)   |
// | drover-reader.max_text         | reader main.js (card 5)                  | = 4000                                          |
// | drover-tasks.machine_polling   | io.js watchMachines -> health.js (T-MWO2HEHGIEC), read with cfg() each tick | false: off by default, live (_test/machines-sidebar.test.js) |
//
// `live: false` is only for a timer interval, which the host fixes when the timer starts ("applies when the screen reopens").
// `enabled` is read by every screen through isEnabled() (config.js); off = screen only (data and the drover CLI stay).
// Precedence for the picker: drover.agents.last (what was used last) beats default_squad/default_worktree/default_report.
// visible_columns hides columns ON SCREEN ONLY (board, list view, shift arrows): store.js and the drover CLI keep all 6 columns and every card.
// A card shifted toward a hidden column (arrows, shift+left/right) skips it and lands in the nearest visible column that way (store.js
// shiftVisible); with none it stays put. New cards go to Ready, or the first visible column. The header shows "N hidden" (scope, filter and
// search applied), so no card is ever hidden silently.
// jira.site: the default is "" ON PURPOSE (owner decision): no company site is shipped. An empty site means "not
// configured": the Jira screen says so and makes no request. Only a bare host is accepted (it becomes the URL host
// the credentials are sent to).

import { COLUMNS, SORT_MODES } from "./store.js";

const LOAD_V = String.raw`(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)`; // above 0
const PCT_V = String.raw`(?:100|[1-9]\d?(?:\.\d+)?)`; // 1 to 100
const PAIR = String.raw`(?:load\s+(?:off|${LOAD_V})|(?:memory|disk)\s+(?:off|${PCT_V}))`;
const ENTRY = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*\s*:\s*${PAIR}(?:\s*,\s*${PAIR})*`;
// The schema patterns. A value that fails its pattern is refused as a whole (the schema's rule), never half-applied.
// The load hold's value patterns (T-MWO2HEU32E4; loadhold.js re-exports them). A value that fails its pattern is refused as a whole, never half-applied.
export const HOLD_PATTERNS = Object.freeze({
  load: new RegExp(`^(?:off|${LOAD_V})$`),
  percent: new RegExp(`^(?:off|${PCT_V})$`),
  machines: new RegExp(`^${ENTRY}(?:\\s*;\\s*${ENTRY})*\\s*;?$`),
});

const MOD = (name) => `drover-${name}`;
// Folders that can be switched off. drover-config and drover-tabs are never disableable (config hosts the dialog, tabs the menu entry).
const COLUMN_IDS = COLUMNS.map(([id]) => id);
const TOGGLEABLE = ["agents", "board", "github", "jira", "projects", "reader", "room", "runs", "tasks", "todos", "wakeups"];

const enabled = (name) => ({
  mod: MOD(name), key: "enabled", title: "Enabled", type: "boolean", default: true, live: true,
  description: "Show this screen. Off hides it from the Drover menu and blanks it; data and the drover CLI stay.",
});

export const SCHEMA = [
  { mod: "drover-config", key: "work_folder", title: "Work folder", type: "enum", enum: ["repo", "project"], default: "project", live: true, alias: { run: "project" }, // a saved "run" (removed mode) reads as project in every layer
    description: "Where agents write plans, scouts, reviews and lane logs. Applies to runs started after a change.\nproject — ~/.config/drover-herdr/work/<project>/, shared by all runs of a project; later runs read earlier plans and reviews.\nrepo — .drover/ in the repo or worktree." },
  ...TOGGLEABLE.map(enabled),
  { mod: "drover-tabs", key: "dock_badge", title: "Dock badge", type: "boolean", default: true, live: true,
    description: "Show how many cards wait for you (the Needs you count, all projects) as a red badge on the Dock icon, hidden at 0. macOS only. Off clears it." },
  { mod: "drover-tasks", key: "machine_polling", title: "Machine health", type: "boolean", default: false, live: true,
    description: "Show a load meter for each linked machine in the Tasks sidebar. On, it runs one short read per linked machine every 5 minutes through hc exec --on (a failed machine is retried after 10 minutes). Off by default: the machine list still shows, with no numbers and no read on any machine." },
  { mod: "drover-agents", key: "default_squad", title: "Default squad", type: "text", default: "", empty: true, live: true,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, patternError: "A squad id, for example s1 (see the Squads screen). Empty means no default squad",
    description: "Squad the start dialog selects when nothing was used before. Empty: the claude agent, as before. What you used last still wins." },
  { mod: "drover-agents", key: "default_worktree", title: "Own git worktree", type: "boolean", default: false, live: true,
    description: "Start the dialog with Own git worktree ticked. What you used last still wins." },
  { mod: "drover-agents", key: "default_report", title: "Report to Drover", type: "boolean", default: false, live: true,
    description: "Start the dialog with Report to Drover ticked (it needs a running Drover). What you used last still wins." },
  { mod: "drover-board", key: "visible_columns", title: "Visible columns", type: "list", of: COLUMN_IDS, min: 1, default: COLUMN_IDS, live: true,
    description: `Columns the board and its list view show, from: ${COLUMN_IDS.join(", ")}. Hiding is screen only: the cards stay in your tasks and the drover CLI still lists all 6 columns. At least one stays visible.` },
  { mod: "drover-board", key: "default_sort", title: "Default sort", type: "enum", enum: SORT_MODES.map(([m]) => m), default: "manual", live: true,
    description: "How each column sorts its cards. A column's own Sort menu choice wins while the board is open." },
  { mod: "drover-github", key: "query", title: "Default query", type: "text", default: "is:issue state:open", live: true,
    description: "Search used when no filter was committed, and by Reset filter." },
  { mod: "drover-github", key: "scopes", title: "Default scopes", type: "list", default: [], live: true,
    description: "Orgs or owner/repo shown when none were added." },
  { mod: "drover-github", key: "limit", title: "Result limit", type: "int", default: 100, min: 1, max: 1000, live: true,
    description: "Most issues and PRs fetched for each scope." },
  { mod: "drover-jira", key: "jql", title: "Default JQL", type: "text", default: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC", live: true,
    description: "Query used when you have not run one." },
  { mod: "drover-jira", key: "pages", title: "Pages", type: "int", default: 4, min: 1, max: 20, live: true,
    description: "Pages of 50 issues fetched before the list is marked partial." },
  { mod: "drover-jira", key: "refresh_minutes", title: "Refresh (minutes)", type: "int", default: 5, min: 1, max: 1440, live: true,
    description: "How often the list reloads. Checked every minute, so a change applies without reopening." },
  { mod: "drover-jira", key: "site", title: "Jira site", type: "text", default: "", empty: true, live: true,
    pattern: /^[A-Za-z0-9][A-Za-z0-9.-]*$/, patternError: "Host name only, for example acme.atlassian.net (no https:// or /)",
    description: "Your Jira host, for example acme.atlassian.net. Empty means not configured: the Jira screen asks you to set it." },
  { mod: "drover-room", key: "refresh_minutes", title: "Refresh (minutes)", type: "int", default: 5, min: 1, max: 1440, live: true,
    description: "Minimum age before a run's context reloads. Checked every 30 seconds, so a change applies without reopening." },
  { mod: "drover-room", key: "pr_cap", title: "Linked PRs", type: "int", default: 10, min: 1, max: 100, live: true,
    description: "Most pull requests linked from the issue that the Room loads for a run." },
  { mod: "drover-room", key: "kept_contexts", title: "Kept runs", type: "int", default: 30, min: 1, max: 1000, live: true,
    description: "Runs whose loaded issue and PR context the Room remembers." },
  { mod: "drover-runs", key: "max_parallel", title: "Parallel runs", type: "int", default: 2, min: 1, max: 10, live: true,
    description: "Squad runs active at once for each project. A run whose card is in Review or Blocked is waiting and takes no slot. An agent can change this on your request (drover config max-parallel)." },
  { mod: "drover-runs", key: "kept", title: "Kept runs", type: "int", default: 200, min: 10, max: 5000, live: true,
    description: "Ended runs remembered in the list. Older ended runs are dropped; a run that is still going is never dropped." },
  { mod: "drover-runs", key: "hold_load", title: "Hold new starts: load", type: "text", default: "1", pattern: HOLD_PATTERNS.load, patternError: "A number above 0 (load per core, 1 = one running task for each core), or off", live: true,
    description: "A new start is held while this computer's load per core is over this number. 1 means as many busy tasks as cores. off turns this limit off. Advisory: a raw hc run --on bypasses it. Runs already going are never held." },
  { mod: "drover-runs", key: "hold_memory", title: "Hold new starts: memory %", type: "text", default: "80", pattern: HOLD_PATTERNS.percent, patternError: "A percent from 1 to 100, or off", live: true,
    description: "A new start is held while this computer's memory is fuller than this percent. off turns this limit off." },
  { mod: "drover-runs", key: "hold_disk", title: "Hold new starts: disk %", type: "text", default: "90", pattern: HOLD_PATTERNS.percent, patternError: "A percent from 1 to 100, or off", live: true,
    description: "A new start is held while the home disk or /tmp is fuller than this percent. off turns this limit off." },
  { mod: "drover-runs", key: "hold_machines", title: "Hold limits per machine", type: "text", default: "", empty: true, pattern: HOLD_PATTERNS.machines,
    patternError: "name: limit value, limit value; name2: ... with the limits load, memory, disk and a number or off, for example local: memory 90, load off. local is this computer. One bad entry refuses the whole text", live: true,
    description: "Limits for one machine that replace the three above. Format: name: memory 90, load off; other: disk 95. The name local is this computer (a linked machine cannot use it). Empty: every machine uses the limits above." },
  { mod: "drover-wakeups", key: "min_repeat_minutes", title: "Shortest repeat (minutes)", type: "int", default: 5, min: 1, max: 1440, live: true,
    description: "A repeating wakeup may not fire more often than this. The drover CLI uses the same value." },
  { mod: "drover-wakeups", key: "expiry_hours", title: "Expiry (hours)", type: "int", default: 2, min: 1, max: 168, live: true,
    description: "A wakeup not delivered this long after its time expires." },
  { mod: "drover-wakeups", key: "ui_tick_seconds", title: "Countdown refresh (seconds)", type: "int", default: 30, min: 1, max: 3600, live: false,
    description: "How often the countdowns repaint. Applies when the screen reopens." },
  { mod: "drover-todos", key: "context_refresh_seconds", title: "Context refresh (seconds)", type: "int", default: 60, min: 5, max: 3600, live: false,
    description: "How often an open task reloads its run and PR context. Applies when the screen reopens." },
  { mod: "drover-todos", key: "pr_cap", title: "PRs shown", type: "int", default: 10, min: 1, max: 100, live: true,
    description: "Most pull requests listed under a task." },
  { mod: "drover-todos", key: "run_history_cap", title: "Past runs shown", type: "int", default: 10, min: 1, max: 100, live: true,
    description: "Most past runs listed under a task." },
  { mod: "drover-todos", key: "wake_cap", title: "Wakeups shown", type: "int", default: 20, min: 1, max: 200, live: true,
    description: "Most open wakeups, and most ended wakeups, listed under a task." },
  { mod: "drover-reader", key: "max_text", title: "Longest entry (characters)", type: "int", default: 4000, min: 200, max: 100000, live: true,
    description: "Longer transcript entries are cut here and end with an ellipsis." },
];

const MAX_LEN = 2000;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function field(mod, key) {
  return SCHEMA.find((f) => f.mod === mod && f.key === key);
}

function text(f, value) {
  if (typeof value !== "string") return { ok: false, error: "Must be text" };
  const v = value.trim();
  if (CONTROL.test(v)) return { ok: false, error: "No control characters or line breaks" };
  if (v.length > MAX_LEN) return { ok: false, error: `At most ${MAX_LEN} characters` };
  if (!v && !f.empty) return { ok: false, error: "Cannot be empty" };
  if (v && f.pattern && !f.pattern.test(v)) return { ok: false, error: f.patternError ?? "Not an accepted value" };
  return { ok: true, value: v };
}

// validate(field, value) -> { ok: true, value } (value normalised: text trimmed) | { ok: false, error }
export function validate(f, value) {
  if (!f) return { ok: false, error: "Unknown setting" };
  switch (f.type) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "Must be on or off" };
    case "int":
      if (!Number.isInteger(value)) return { ok: false, error: "Must be a whole number" };
      if (value < f.min || value > f.max) return { ok: false, error: `Must be ${f.min} to ${f.max}` };
      return { ok: true, value };
    case "text":
      return text(f, value);
    case "enum":
      return Array.isArray(f.enum) && f.enum.includes(value) ? { ok: true, value } : { ok: false, error: `Must be one of ${(f.enum || []).join(", ")}` };
    case "list": {
      if (!Array.isArray(value)) return { ok: false, error: "Must be a list" };
      const out = [];
      for (const item of value) {
        const r = text({}, item);
        if (!r.ok) return { ok: false, error: `Item: ${r.error}` };
        out.push(r.value);
      }
      if (f.of) { // a closed set: known members only, kept in the set's order without duplicates
        const bad = out.find((x) => !f.of.includes(x));
        if (bad !== undefined) return { ok: false, error: `Unknown "${bad}". Use: ${f.of.join(", ")}` };
        const set = f.of.filter((x) => out.includes(x));
        if (set.length < (f.min ?? 0)) return { ok: false, error: `Keep at least ${f.min === 1 ? "one" : f.min} of: ${f.of.join(", ")}` };
        return { ok: true, value: set };
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: false, error: "Unknown type" };
  }
}
