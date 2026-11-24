// Drover Projects: a list of projects (name, repos, folders, base branch). Tasks point at one project by id.
// New / Edit opens a dialog overlay of this same mod (props.projectEdit: a project id, or null for a new one).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, setShared, props, closeOverlay, openOverlay, exec, notify, shared, readTextFile, home } from "herdr";
import { PROJECTS_KEY, addProject, updateProject, removeProject } from "./store.js";
import { load, loadProjects, modSettings, remote, setRemoteWrites } from "./io.js";
import { writesToggle } from "./remote-write-ui.js";
import { withRemote, remoteOf } from "./remote.js";
import { bind, isEnabled, whenLoaded, ready as cfgReady } from "./config.js";
import { gated } from "./ui.js";
import { lessonPaths } from "./lessons.js";

const button = (t, id, text, primary, action) =>
  h_flex().id(id).h(30).px(12).items_center().rounded(7).cursor_pointer()
    .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5)
    .hover((s) => s.opacity(0.88)).on_click(action).child(text);

export const openEditor = (id) => openOverlay({ mod: "drover-projects", kind: "dialog", modal: true, width: 540, height: 0.8, props: { projectEdit: id ?? null } }); // a definite height (as the proof and pick dialogs): the body scrolls inside it

// The first repo path that is not a git repo, or null. A missing folder fails git too.
export async function badRepo(paths) {
  for (const path of paths) {
    const r = await exec("git", ["rev-parse", "--git-dir"], { cwd: path }).catch(() => null);
    if (!r || r.code !== 0) return path;
  }
  return null;
}

export class ProjectEditor {
  constructor(cx) {
    const p = props().projectEdit ? loadProjects().find((x) => x.id === props().projectEdit) : null;
    this.project = p ?? null;
    this.error = null;
    this.closed = false;
    this.saving = false;
    this.name = InputState.new({ placeholder: "Name, e.g. Acme", value: p?.name ?? "" });
    this.repos = TextareaState.new({ placeholder: "/path/to/repo (one per line, first is the default)", value: (p?.repos ?? []).map((r) => r.path).join("\n"), rows: 3 });
    this.folders = TextareaState.new({ placeholder: "/path/to/folder (one per line)", value: (p?.folders ?? []).join("\n"), rows: 3 });
    this.branch = InputState.new({ placeholder: "main", value: p?.branch ?? "main" });
    // Remote binding (an existing project only): the project's cards then live on another machine, read-only here.
    const r = p ? remoteOf(loadProjects(), p.id) : null;
    this.machine = InputState.new({ placeholder: "machine name", value: r?.machine ?? "" });
    this.remoteId = InputState.new({ placeholder: "P-… (the project's id on that machine)", value: r?.projectId ?? "" });
    this.remoteMsg = null; this.binding = false; this.bindGen = 0;
    this.org = InputState.new({ placeholder: "acme (optional)", value: p?.org ?? "" });
    // Open lessons: the file is looked for once, here. render() only reads these fields. A file that appears later shows after the dialog is reopened.
    this.savedOrg = p?.org ?? "";
    const paths = lessonPaths(`${home()}/.config/drover-herdr`, { org: this.savedOrg, project: p?.id });
    this.lessonsPath = paths.org?.lessons ?? null;
    this.hasLessons = false; this.lessonsChecked = !this.lessonsPath;
    this.projectLessonsPath = paths.project; // null for a new project: it has no id yet
    this.hasProjectLessons = false; this.projectLessonsChecked = !this.projectLessonsPath;
    const probe = (path, found, checked) => cx.spawn(async (acx) => {
      let has = false;
      try { has = (await readTextFile(path)) != null; } catch { has = false; }
      this[found] = has; this[checked] = true;
      if (!this.closed) acx.notify();
    });
    if (this.lessonsPath) probe(this.lessonsPath, "hasLessons", "lessonsChecked");
    if (this.projectLessonsPath) probe(this.projectLessonsPath, "hasProjectLessons", "projectLessonsChecked");
    this.name.focus();
    cx.timer.after(300, () => this.name.focus());
  }

  // Checks the repo paths, then saves. One save at a time; an error leaves the dialog open and saves nothing.
  async save(cx) {
    if (this.closed || this.saving) return;
    this.saving = true;
    const f = { name: this.name.value(), repos: this.repos.value(), folders: this.folders.value(), branch: this.branch.value(), org: this.org.value() };
    const apply = () => (this.project ? updateProject(loadProjects(), this.project.id, f) : addProject(loadProjects(), f));
    const r = apply();
    const bad = r.error || remoteOf(loadProjects(), this.project?.id) ? null : await badRepo(r.project.repos.map((x) => x.path)); // a remote project's paths are on the other machine
    // Recompute from the list as it is now: another dialog may have saved during the git checks.
    const fresh = bad ? r : apply();
    this.saving = false;
    if (fresh.error || bad) { this.error = fresh.error ?? `${bad} does not exist or is not a git repo`; cx.notify(); return; }
    setShared(PROJECTS_KEY, fresh.projects);
    this.close();
  }

  // Check the machine and its project (a read), then save the binding. Refusals show their message and save nothing.
  async bindRemote(cx) {
    if (this.closed || this.binding || !this.project) return;
    const gen = ++this.bindGen, expected = JSON.stringify(remoteOf(loadProjects(), this.project.id) ?? null);
    this.binding = true; this.remoteMsg = "Checking…"; cx.notify();
    const r = await remote.bind(this.project, { machine: this.machine.value().trim(), projectId: this.remoteId.value().trim() }, { tasks: load(), projects: loadProjects() });
    this.binding = false;
    // An Unbind, a close or another dialog's change while checking cancels this attempt: it never writes back.
    if (gen !== this.bindGen || JSON.stringify(remoteOf(loadProjects(), this.project.id) ?? null) !== expected) { this.remoteMsg = "Cancelled: the binding changed while checking"; cx.notify(); return; }
    if (r.error) { this.remoteMsg = r.error; cx.notify(); return; }
    const now = loadProjects(); // another dialog may have saved meanwhile
    if (!now.some((x) => x.id === this.project.id) || load().some((x) => x.project === this.project.id && !x.archived)) { this.remoteMsg = "The project changed while checking: try again"; cx.notify(); return; }
    setShared(PROJECTS_KEY, withRemote(now, this.project.id, r.project.remote));
    this.remoteMsg = `Bound to ${r.project.remote.machine}: its cards now show on the Board and Tasks`;
    cx.notify();
  }

  // The writes switch: remote.writes off refuses every write to that machine at once (nothing is queued).
  toggleWrites(cx) {
    const cur = remoteOf(loadProjects(), this.project?.id);
    if (!cur) return;
    setRemoteWrites(this.project.id, cur.writes === false);
    cx.notify();
  }

  unbindRemote(cx) {
    const cur = remoteOf(loadProjects(), this.project?.id);
    this.bindGen++;
    if (!cur) return;
    remote.detach(cur.machine, cur.projectId);
    setShared(PROJECTS_KEY, withRemote(loadProjects(), this.project.id, null));
    this.remoteMsg = "Unbound: this project shows its local cards again";
    cx.notify();
  }

  // Enabled only for the saved org, with the file there when the dialog opened. Opening reads and writes nothing.
  lessonsReady() { return Boolean(this.lessonsPath && this.hasLessons && this.org.value().trim() === this.savedOrg); }

  openLessons() {
    if (this.lessonsReady()) exec("open", ["-t", this.lessonsPath]);
  }

  // Enabled only for a saved project, with the file there when the dialog opened.
  projectLessonsReady() { return Boolean(this.projectLessonsPath && this.hasProjectLessons); }

  openProjectLessons() {
    if (this.projectLessonsReady()) exec("open", ["-t", this.projectLessonsPath]);
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.bindGen++;
    closeOverlay(props().overlay);
  }

  render(_cx) {
    const t = theme();
    const label = (text) => div().pt(12).pb(5).text_size(11.5).text_color(t.dim).child(text);
    const field = (el) => el.px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground);
    return v_flex().id("project-editor").w_full().max_h_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .child(h_flex().items_center()
        .child(h_flex().flex_1().items_center().gap(6).text_size(15).font_semibold()
          .child(this.project ? "Edit project" : "New project")
          .when(Boolean(this.project), (el) => el.child(h_flex().id("copy-project-id").px(6).py(2).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              cx.write_to_clipboard(this.project.id);
              this.copied = true; cx.notify();
              cx.timer.after(1500, (cx) => { this.copied = false; cx.notify(); });
            })
            .child(this.project.id)
            .child(div().text_size(11).font_weight(400).text_color(this.copied ? t.done : t.dim).child(this.copied ? "Copied" : "⧉ Copy")))))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(v_flex().id("project-editor-body").flex_1().min_h(0).overflow_y_scrollbar() // the body scrolls; the header (Esc) and the Cancel/Save row stay in view
      .child(label("Name")).child(field(Input.new(this.name).h(34)))
      .child(label("Repos (git, one path per line, first is the default)")).child(field(Textarea.new(this.repos)).py(6))
      .child(label("Folders (one path per line)")).child(field(Textarea.new(this.folders)).py(6))
      .child(label("Base branch")).child(field(Input.new(this.branch).h(34)))
      .child(label("Org (optional: shared lessons)")).child(field(Input.new(this.org).h(34)))
      .child(h_flex().pt(8).gap(8).items_center()
        .child(button(t, "open-lessons", "Org lessons", false, () => this.openLessons()).opacity(this.lessonsReady() ? 1 : 0.5))
        .when(!this.lessonsReady(), (e) => e.child(div().id("lessons-note").text_size(12).text_color(t.muted).child(this.org.value().trim() && this.org.value().trim() !== this.savedOrg ? "none yet (save the org first)" : "none yet"))))
      .child(h_flex().pt(8).gap(8).items_center()
        .child(button(t, "open-project-lessons", "Project lessons", false, () => this.openProjectLessons()).opacity(this.projectLessonsReady() ? 1 : 0.5))
        .when(!this.projectLessonsReady(), (e) => e.child(div().id("project-lessons-note").text_size(12).text_color(t.muted).child(this.project ? "none yet" : "none yet (save the project first)"))))
      .when(Boolean(this.project), (el) => el
        .child(label("Remote: machine (hc machine ls) and the project's id there. Its cards show here; with writes on you can change them from here."))
        .child(h_flex().gap(8).child(field(Input.new(this.machine).h(34).w(160))).child(field(Input.new(this.remoteId).h(34).flex_1())))
        .child(h_flex().pt(8).gap(8).items_center()
          .child(button(t, "bind-remote", remoteOf(loadProjects(), this.project.id) ? "Rebind" : "Bind", false, (_e, cx) => cx.spawn((acx) => this.bindRemote(acx))))
          .when(Boolean(remoteOf(loadProjects(), this.project.id)), (e) => e.child(button(t, "unbind-remote", "Unbind", false, (_e, cx) => this.unbindRemote(cx))))
          .when(Boolean(this.remoteMsg), (e) => e.child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).child(this.remoteMsg))))
        .when(Boolean(remoteOf(loadProjects(), this.project.id)), (e) => {
          const g = writesToggle(remoteOf(loadProjects(), this.project.id));
          return e.child(h_flex().pt(8).gap(8).items_center()
            .child(button(t, "toggle-writes", g.on ? "Turn writes off" : "Turn writes on", false, (_e, cx) => this.toggleWrites(cx)))
            .child(div().id("writes-note").flex_1().min_w(0).text_size(12).text_color(t.muted).child(`${g.label}: ${g.note}`)));
        })))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(18).gap(8).child(div().flex_1())
        .child(button(t, "ed-cancel", "Cancel", false, () => this.close()))
        .child(button(t, "ed-save", "Save", true, (_e, cx) => cx.spawn((acx) => this.save(acx))))).h_full(); // h_full on the root, as the drover-agents dialogs: a definite height for the flex_1 body
  }
}

export default class Projects extends View {
  init(_props, cx) {
    if (props()?.overlay && "projectEdit" in props()) { this.editor = new ProjectEditor(cx); return; }
    bind({ shared, modSettings });
    whenLoaded("drover-projects", cx);
    this.confirm = null; // id of the project whose ✕ was clicked once
  }

  render(cx) {
    if (this.editor) return this.editor.render(cx);
    const t = theme();
    { const g = gated("drover-projects"); if (g) return g; }
    const projects = loadProjects(), tasks = load().filter((x) => !x.archived);
    const link = (id, text, action, color = t.muted) => div().id(id).px(6).h(22).flex().items_center().rounded(5).text_size(11.5).text_color(color)
      .cursor_pointer().hover((s) => s.bg(t.raised)).on_click((_e, cx) => { action(cx); cx.notify(); }).child(text);
    const remove = (p) => (cx) => {
      if (this.confirm !== p.id) { this.confirm = p.id; cx.timer.after(4000, (cx) => { if (this.confirm === p.id) { this.confirm = null; cx.notify(); } }); return; }
      this.confirm = null;
      const r = removeProject(projects, load(), p.id);
      if (r.error) notify({ title: `${p.name} not removed`, body: r.error, level: "error" });
      else setShared(PROJECTS_KEY, r.projects);
    };
    const row = (p) => {
      const n = tasks.filter((x) => x.project === p.id).length;
      return h_flex().id(`p-${p.id}`).px(16).py(10).gap(12).items_start().text_size(13).border_b_1().border_color(t.border).hover((s) => s.bg(t.hover))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(8).items_center()
            .child(div().truncate().font_medium().child(p.name))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(p.id))
            .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`${n} task${n === 1 ? "" : "s"} · ${p.branch}`)))
          .children(p.repos.map((r) => div().truncate().text_size(12).text_color(t.muted).child(r.default ? `${r.path} (default)` : r.path)))
          .children(p.folders.map((f) => div().truncate().text_size(12).text_color(t.dim).child(f))))
        .child(h_flex().flex_none().gap(6).items_center()
          .child(link(`e-${p.id}`, "Edit", () => openEditor(p.id)))
          .child(link(`x-${p.id}`, this.confirm === p.id ? "Remove project?" : "✕", remove(p), this.confirm === p.id ? t.blocked : t.muted)));
    };
    return v_flex().id("root").size_full().bg(t.surface).text_color(t.foreground)
      .child(h_flex().h(52).px(16).gap(10).items_center().border_b_1().border_color(t.border)
        .child(div().text_size(14).font_medium().child("Projects"))
        .child(div().text_size(12).text_color(t.dim).child(String(projects.length)))
        .child(div().flex_1())
        .child(button(t, "new", "+ New", true, () => openEditor(null))))
      .child(v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(projects.map(row))
        .when(projects.length === 0, (el) => el.child(div().p(16).text_size(12.5).text_color(t.dim).child("No projects yet. Press + New."))));
  }
}
