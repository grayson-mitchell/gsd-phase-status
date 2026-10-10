'use strict';
 
const vscode = require('vscode');
const {
  buildPhaseMap,
  phaseNumberForPath,
  phaseNumberFromSegment,
  planKeyFromFileName,
  classifyFolder,
  classifyPlans,
  parseFrontmatter,
  artifactKind,
  REVIEW_CYCLE_KIND,
  resolveArtifactStatus,
  folderArtifactStatuses,
  applyFolderState,
  rollup,
  comparePhaseNum,
  DEFAULT_DISCUSSED_MARKERS,
  DEFAULT_PLANNED_MARKERS,
  DEFAULT_SUMMARY_MARKERS,
  artifactStatus,
  statusWord,
  todoStatus,
  todoFileStatus,
  todoTriage,
  tallyTodos,
  countBadge,
} = require('./parse');
 
/**
 * Badge is capped at 2 characters by VS Code. Colors are built-in theme color
 * IDs, so they adapt to whatever theme is active without us contributing any.
 */
const STYLE = {
  complete:   { badge: '✓', color: 'charts.green',           label: 'Complete' },
  inprogress: { badge: '▶', color: 'charts.yellow',          label: 'In progress' },
  planned:    { badge: '◑', color: 'charts.blue',            label: 'Planned' },
  discussed:  { badge: '◔', color: 'charts.orange',          label: 'Discussed' },
  // charts.red, not a contributed id: VS Code's registry entry for this
  // hand-installed extension is pinned to an old version, so a new
  // contributes.colors block never registers and the badge renders as plain
  // foreground (white). Tune the shade via workbench.colorCustomizations
  // instead — see .vscode/settings.json.
  blocked:    { badge: '!', color: 'charts.red',             label: 'Blocked' },
  // Deliberately stood down — deferred, cancelled or superseded. Purple rather
  // than red because nothing here is wrong or waiting on anyone, and rather
  // than grey because a parked phase is a decision, not an untouched backlog
  // item.
  parked:     { badge: '⊘', color: 'charts.purple',          label: 'Parked / cancelled' },
  // Permanently replaced by a successor — unlike parked it will not be
  // revived. Greyed out rather than purple so it reads as finished-and-gone.
  // The FileDecoration API has no strikethrough, so badge + colour carry it.
  superseded: { badge: '⇢', color: 'disabledForeground',    label: 'Superseded' },
  // Waiting on a person, not on code — a passed gate that nobody has run yet.
  // Shares charts.orange with `discussed`; they do not collide in practice
  // because discussed lands on phase FOLDERS and this lands on artifact FILES.
  humanneeded:{ badge: '🧍', color: 'charts.orange',          label: 'Needs a human' },
  pending:    { badge: '○', color: 'descriptionForeground',  label: 'Pending' },
  unknown:    { badge: '·', color: 'descriptionForeground',  label: 'No status found' },
};

// A todo count is not a phase status, so the todo folders get their own
// two-colour scheme rather than a STYLE entry: orange while anything is still
// open, green once the folder is clear. Sharing charts.orange with `discussed`
// and `humanneeded` does not collide — those land on phase folders and artifact
// files, these land only on .planning/todos.
const TODO_OPEN_COLOR = 'charts.orange';
const TODO_DONE_COLOR = 'charts.green';

// The only place this module reads the running host's OS. parse.js stays
// pure — the host travels in as an argument, not a lookup the parser does
// itself. `null` on an unrecognised platform (e.g. FreeBSD) is deliberate: it
// disables the todoTriage platform rung rather than reddening every
// platform-tagged todo, see T-sya-03 in the plan's threat register.
const HOST_PLATFORM = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform] || null;
 
// phases: Map<phaseNum, {status, title}>
// plans:  Map<phaseNum, Map<planNum, {status, planFile, summaryFile}>>
let state = { phases: new Map(), plans: new Map(), active: null, activePlan: null, todos: null, planningDir: '.planning' };
 
const emitter = new vscode.EventEmitter();
let statusBar;
let watcher;
let debounce;
 
function cfg() {
  return vscode.workspace.getConfiguration('gsdPhaseStatus');
}
 
function rel(uri) {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}
 
function deco(style, tooltip) {
  return {
    badge: style.badge,
    color: new vscode.ThemeColor(style.color),
    tooltip,
    propagate: false,
  };
}
 
async function readIfExists(uri) {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}
 
/**
 * A setting the user actually chose, or this module's own constant.
 *
 * Deliberately NOT `conf.get(key, fallback)`: that fallback only applies when
 * the key is absent from the manifest, so a wrong `default` in package.json
 * wins over the code. This extension is installed by dropping a folder into
 * ~/.vscode/extensions, where VS Code can serve a stale cached manifest — so
 * the manifest is not a trustworthy source of defaults. inspect() lets us see
 * whether a human set the value and fall back to the constant when nobody did.
 */
function userSetOr(conf, key, fallback) {
  const v = conf.inspect(key);
  if (!v) return fallback;
  const chosen =
    v.workspaceFolderValue !== undefined
      ? v.workspaceFolderValue
      : v.workspaceValue !== undefined
        ? v.workspaceValue
        : v.globalValue;
  return chosen === undefined ? fallback : chosen;
}

function markerOpts() {
  // startedMarkers is the pre-0.3 name; honour it if the user set it and has
  // not moved to discussedMarkers.
  const conf = cfg();
  const legacy = conf.inspect('startedMarkers');
  const legacySet =
    legacy && (legacy.globalValue !== undefined || legacy.workspaceValue !== undefined);
  const discussedMarkers = legacySet
    ? conf.get('startedMarkers')
    : userSetOr(conf, 'discussedMarkers', DEFAULT_DISCUSSED_MARKERS);
  const plannedMarkers = userSetOr(conf, 'plannedMarkers', DEFAULT_PLANNED_MARKERS);
  const summaryMarkers = userSetOr(conf, 'summaryMarkers', DEFAULT_SUMMARY_MARKERS);
  return { discussedMarkers, plannedMarkers, summaryMarkers };
}
 
/**
 * Read every tier-1 artifact in one phase folder and return their statuses.
 *
 * Frontmatter goes through the same mtime+size cache the on-demand decoration
 * path uses, so a folder whose artifacts have not changed costs one stat per
 * file per reload and no reads at all.
 */
async function readArtifactStatuses(folderUri, files) {
  const fmByName = new Map();
  for (const name of files) {
    if (!artifactKind(name)) continue;
    const fm = await frontmatterOf(vscode.Uri.joinPath(folderUri, name));
    if (fm) fmByName.set(name, fm);
  }
  return folderArtifactStatuses(fmByName);
}

/**
 * Walk .planning/phases and, for each phase folder, build both a rolled-up
 * phase status and a per-plan (per-wave) status map.
 * Returns { folderStatus: Map<num, status>, plans: Map<num, Map<planNum, rec>> }.
 */
async function scanFolders(root, dir) {
  const folderStatus = new Map();
  const plans = new Map();
  const opts = markerOpts();
 
  const phasesUri = vscode.Uri.joinPath(root, dir, 'phases');
  let entries;
  try {
    entries = await vscode.workspace.fs.readDirectory(phasesUri);
  } catch {
    return { folderStatus, plans }; // no phases/ directory yet
  }
 
  for (const [name, type] of entries) {
    const num = phaseNumberFromSegment(name);
    if (num === null) continue;
 
    if (type === vscode.FileType.Directory) {
      let children;
      try {
        children = await vscode.workspace.fs.readDirectory(
          vscode.Uri.joinPath(phasesUri, name)
        );
      } catch {
        continue;
      }
      const files = children
        .filter(([, t]) => t === vscode.FileType.File)
        .map(([n]) => n);
 
      const planMap = classifyPlans(files, opts);
      // Both tiers of evidence in the folder, rolled up together: the waves
      // (PLAN/SUMMARY pairs) AND the phase's own gate artifacts. Waves alone
      // are not enough — 33 of 33 summaries on disk painted phase 34.9 green
      // while its REVIEW and REVIEW-FIX sat yellow inside it.
      const artifactStatuses = await readArtifactStatuses(
        vscode.Uri.joinPath(phasesUri, name),
        files
      );
      if (planMap.size) {
        plans.set(num, planMap);
        const planStatuses = [...planMap.values()].map((p) => p.status).filter(Boolean);
        folderStatus.set(num, rollup(planStatuses.concat(artifactStatuses)));
      } else {
        // No waves yet: the folder's own discuss/plan tier, still held back by
        // any gate artifact already sitting in it.
        const status = classifyFolder(files, opts);
        const combined = (status ? [status] : []).concat(artifactStatuses);
        if (combined.length) folderStatus.set(num, rollup(combined));
      }
    } else if (type === vscode.FileType.File) {
      // Flat layout: .planning/phases/phase-3.md — no per-plan granularity.
      const status = classifyFolder([name], opts);
      if (status) folderStatus.set(num, status);
    }
  }
  return { folderStatus, plans };
}
 
/**
 * Count .planning/todos/{pending,completed}. Returns null when neither folder
 * exists, or when the feature is switched off.
 *
 * Only the pending side is read for frontmatter — enough to tell an open todo
 * from a parked one. Completed todos are a count and nothing more; reading ~70
 * settled files to re-derive the word "completed" would be work with no answer
 * at the end of it. Pending reads go through the same mtime+size cache as
 * artifact frontmatter, so an unrelated write costs one stat per todo.
 */
async function scanTodos(root, dir) {
  if (!userSetOr(cfg(), 'showTodoCounts', true)) return null;

  const todosUri = vscode.Uri.joinPath(root, dir, 'todos');
  const namesIn = async (sub) => {
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.joinPath(todosUri, sub)
      );
      return entries
        .filter(([n, t]) => t === vscode.FileType.File && /\.md$/i.test(n))
        .map(([n]) => n);
    } catch {
      return null; // no such subfolder
    }
  };

  const pendingNames = await namesIn('pending');
  const completedNames = await namesIn('completed');
  if (!pendingNames && !completedNames) return null;

  const fms = [];
  for (const name of pendingNames || []) {
    fms.push(await frontmatterOf(vscode.Uri.joinPath(todosUri, 'pending', name)));
  }

  return {
    pending: tallyTodos(fms, HOST_PLATFORM),
    completed: { total: (completedNames || []).length },
  };
}

async function reload() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return;
 
  const root = folders[0].uri;
  const dir = cfg().get('planningDir', '.planning');
  state.planningDir = dir;
 
  const roadmap = await readIfExists(vscode.Uri.joinPath(root, dir, 'ROADMAP.md'));
  const stateMd = await readIfExists(vscode.Uri.joinPath(root, dir, 'STATE.md'));
  const scan = await scanFolders(root, dir);
  state.todos = await scanTodos(root, dir);
 
  if (roadmap === null && stateMd === null && !scan.folderStatus.size) {
    state.phases = new Map();
    state.plans = new Map();
    state.active = null;
    state.activePlan = null;
  } else {
    const built = buildPhaseMap(roadmap, stateMd);
    applyFolderState(built.phases, scan.folderStatus);
    state.phases = built.phases;
    state.plans = scan.plans;
    state.active = built.active;
    state.activePlan = built.activePlan;
  }
 
  updateStatusBar();
  emitter.fire(undefined); // undefined = "everything may have changed"
}
 
function updateStatusBar() {
  if (!statusBar) return;
  if (!cfg().get('showStatusBar', true) || (!state.phases.size && !state.todos)) {
    statusBar.hide();
    return;
  }
  const all = [...state.phases.values()].map((p) => p.status);
  const count = (s) => all.filter((x) => x === s).length;
 
  const parts = [];
  if (all.length) parts.push(`$(checklist) ${count('complete')}/${all.length}`);
  if (state.active !== null) {
    parts.push(
      state.activePlan !== null
        ? `phase ${state.active}·plan ${state.activePlan}`
        : `phase ${state.active}`
    );
  }
  if (count('planned')) parts.push(`◑ ${count('planned')}`);
  if (count('discussed')) parts.push(`◔ ${count('discussed')}`);
  if (count('blocked')) parts.push(`$(error) ${count('blocked')}`);
  if (count('parked')) parts.push(`⊘ ${count('parked')}`);
  // ACTIONABLE todos, not pending ones: a parked todo is a decision, a
  // `ready: blocked` one has nothing waiting on it, and a todo tagged for a
  // different OS (via `platform:`) cannot be picked up on THIS machine —
  // counting any of those as outstanding work would inflate the number
  // nobody here can act on. `pending.open` is host-derived (see HOST_PLATFORM
  // above), so this same tree reads a different number on a different host.
  if (state.todos && state.todos.pending.open) parts.push(`☐ ${state.todos.pending.open}`);
 
  if (!parts.length) {
    statusBar.hide();
    return;
  }
  statusBar.text = `GSD ${parts.join(' · ')}`;
  const lines = [...state.phases.entries()]
    .sort((a, b) => comparePhaseNum(a[0], b[0]))
    .map(([n, p]) => `${STYLE[p.status].badge} Phase ${n}${p.title ? ` — ${p.title}` : ''} (${STYLE[p.status].label})`);
  if (state.todos) lines.push(lines.length ? `\n${todoSummary()}` : todoSummary());
  statusBar.tooltip = lines.join('\n');
  statusBar.show();
}
 
// Frontmatter is read on demand (only for files the Explorer actually shows)
// and keyed on mtime+size, so a reload triggered by an unrelated write does not
// re-read all ~180 artifacts. A changed file re-stats cheap and re-reads once.
const fmCache = new Map();

async function frontmatterOf(uri) {
  let stat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch {
    return null;
  }
  const hit = fmCache.get(uri.fsPath);
  if (hit && hit.mtime === stat.mtime && hit.size === stat.size) return hit.fm;
  const text = await readIfExists(uri);
  const fm = text === null ? null : parseFrontmatter(text);
  fmCache.set(uri.fsPath, { mtime: stat.mtime, size: stat.size, fm });
  return fm;
}

/** The REVIEW-FIX.md sitting beside a REVIEW.md, if a fix pass was ever run. */
async function siblingReviewFix(uri) {
  const dir = vscode.Uri.joinPath(uri, '..');
  let entries;
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return null;
  }
  const match = entries.find(([name]) => artifactKind(name) === 'REVIEW-FIX.md');
  if (!match) return null;
  return frontmatterOf(vscode.Uri.joinPath(dir, match[0]));
}

async function decorateArtifact(uri, kind, num) {
  const fm = await frontmatterOf(uri);
  if (!fm) return undefined; // no frontmatter at all -> nothing to report

  let status;
  let note = '';
  if (kind === 'REVIEW.md') {
    const fix = await siblingReviewFix(uri);
    status = resolveArtifactStatus(kind, fm, fix ? fix.status : null);
    note = fix ? ' (from its REVIEW-FIX)' : ' (no fix pass yet)';
  } else if (kind === REVIEW_CYCLE_KIND) {
    // A cycle review is derived like a plain REVIEW, but from its OWN
    // `disposition:` field rather than from a sibling — see reviewCycleStatus.
    status = resolveArtifactStatus(kind, fm);
    note = fm.disposition
      ? ` (disposition: ${String(fm.disposition).trim()})`
      : ' (no disposition declared)';
  } else {
    status = resolveArtifactStatus(kind, fm);
  }
  // An unrecognised vocabulary word stays uncoloured on purpose: a missing
  // badge is a question, a wrong badge is an answer.
  if (!status) return undefined;

  const style = STYLE[status] || STYLE.unknown;
  const label = kind.replace(/\.md$/, '');
  return deco(style, `Phase ${num} · ${label}: ${style.label}${note}`);
}

/** One line of prose covering both todo folders, for the tooltips. */
function todoSummary() {
  const { pending, completed } = state.todos;
  const all = pending.total + completed.total;
  const parked = pending.parked ? ` (${pending.parked} parked)` : '';
  const standDown = pending.total - pending.open;
  return `Todos: ${completed.total}/${all} done · ${pending.open} actionable, ${standDown} stood down${parked}`;
}

/**
 * Badge .planning/todos and its two folders with how many todos are in them.
 *
 * The pending badge counts FILES, parked ones included, so it agrees with what
 * the Explorer shows when the folder is expanded; the open/parked split is in
 * the tooltip. The parent badge counts open todos instead — on a collapsed
 * .planning the actionable number is the one worth a glance.
 */
async function decorateTodoFile(uri, folder) {
  const fm = await frontmatterOf(uri);
  const declared = fm ? todoStatus(fm.status) : null;
  const status = todoFileStatus(fm ? fm.status : null, folder);
  // Triage badge + readiness colour, not the flat STYLE lookup this used to do.
  // Every open todo used to render the same grey `○` regardless of severity or
  // whether it was even actionable on this machine, which is no information at
  // all on a folder of 35. See todoTriage() in parse.js for the precedence
  // ladder and the two rationale notes.
  const triage = todoTriage(fm, folder, HOST_PLATFORM);
  // When the file's own status: line disagrees with where the file lives, the
  // folder wins but the tooltip says so. That disagreement is worth reporting
  // rather than silently resolving — it is how you find the six todos in
  // completed/ still declaring themselves OPEN.
  const stale =
    declared && declared !== status
      ? ` — its status: line still reads "${statusWord(fm.status)}"`
      : '';
  return deco(triage, `GSD todo: ${triage.label}${stale}`);
}

function todoDecoration(uri, lower, dir) {
  if (!state.todos) return undefined;
  const base = `${dir.toLowerCase()}/todos`;
  const { pending, completed } = state.todos;

  // A todo file in either folder, coloured by the same STYLE map as everything
  // else, so a parked todo reads purple where it sits rather than only in a
  // folder tooltip. Frontmatter is read on demand — expanding the folder is
  // what pays for it, and only for the rows actually on screen.
  for (const folder of ['pending', 'completed']) {
    const prefix = `${base}/${folder}/`;
    const rest = lower.startsWith(prefix) ? lower.slice(prefix.length) : null;
    if (rest && rest.endsWith('.md') && !rest.includes('/')) {
      return decorateTodoFile(uri, folder);
    }
  }

  if (lower === `${base}/pending`) {
    // PINNED: this row's badge and colour are deliberately unaffected by the
    // `open` narrowing (parked+blocked+wrong-platform). Badge stays the raw
    // file count `pending.total`, same as before. Colour switches on
    // `pending.unparked` — the OLD `open` (total - parked) — rather than the
    // new actionable `pending.open`, so this row behaves identically to
    // today: it does not flip green just because every remaining todo is
    // stood down or for another machine. See parse.js tallyTodos doc comment.
    const parked = pending.parked ? `, ${pending.parked} parked` : '';
    return deco(
      {
        badge: pending.total ? countBadge(pending.total) : '✓',
        color: pending.unparked ? TODO_OPEN_COLOR : TODO_DONE_COLOR,
      },
      `GSD todos: ${pending.total} pending — ${pending.open} actionable, ${pending.total - pending.open} stood down${parked}`
    );
  }

  if (lower === `${base}/completed`) {
    if (!completed.total) return undefined; // nothing closed yet is not news
    return deco(
      { badge: countBadge(completed.total), color: TODO_DONE_COLOR },
      `GSD todos: ${completed.total} completed`
    );
  }

  if (lower === base) {
    if (!pending.total && !completed.total) return undefined;
    return deco(
      {
        badge: pending.open ? countBadge(pending.open) : '✓',
        color: pending.open ? TODO_OPEN_COLOR : TODO_DONE_COLOR,
      },
      todoSummary()
    );
  }

  return undefined;
}

/** Statuses of every known phase, for decorating the phases/ and .planning/ folders. */
function allStatuses() {
  return [...state.phases.values()].map((p) => p.status);
}
 
const provider = {
  onDidChangeFileDecorations: emitter.event,
 
  provideFileDecoration(uri) {
    const path = rel(uri);
    const dir = state.planningDir.replace(/\/$/, '');
    const lower = path.toLowerCase();

    // Todos first, and ahead of the phases guard: they are independent of the
    // roadmap, so a workspace with a todo folder and no phases yet still has
    // something to report.
    const todo = todoDecoration(uri, lower, dir);
    if (todo) return todo;

    if (!state.phases.size) return undefined;
 
    // The phases/ container and .planning/ itself get a rolled-up status
    if (lower === `${dir.toLowerCase()}/phases` || lower === dir.toLowerCase()) {
      const s = STYLE[rollup(allStatuses())] || STYLE.unknown;
      const done = allStatuses().filter((x) => x === 'complete').length;
      const phases = `GSD: ${done}/${state.phases.size} phases complete`;
      return deco(s, state.todos ? `${phases}\n${todoSummary()}` : phases);
    }
 
    const num = phaseNumberForPath(path, dir);
    if (num === null) return undefined;
    const rec = state.phases.get(num);
    if (!rec) return undefined;
 
    // Locate the path relative to phases/<phaseSegment>/...
    const needle = `${dir.toLowerCase()}/phases/`;
    const idx = lower.indexOf(needle);
    const rest = idx === -1 ? '' : path.slice(idx + needle.length);
    const parts = rest.split('/').filter(Boolean);
    const fileName = parts.length ? parts[parts.length - 1] : '';
 
    // A tier-1 artifact. Checked BEFORE the plan branch: "18-05-REVIEW.md" also
    // parses as phase 18 / plan 5, and its own gate status is the truer answer.
    const kind = parts.length >= 2 ? artifactKind(fileName) : null;
    if (kind) return decorateArtifact(uri, kind, num);

    // A per-plan (per-wave) file inside the phase folder
    const planMap = state.plans.get(num);
    const key = planKeyFromFileName(fileName);
    if (parts.length >= 2 && key && planMap && planMap.has(key.plan)) {
      let status = planMap.get(key.plan).status;
      // The active phase's current plan is the one being executed right now.
      if (num === state.active && key.plan === state.activePlan && status !== 'complete') {
        status = 'inprogress';
      }
      const s = STYLE[status] || STYLE.unknown;
      return deco(s, `Phase ${num} · Plan ${key.plan}: ${s.label}`);
    }
 
    // The phase folder itself (single segment, or a flat phase file) -> rolled-up status
    if (parts.length <= 1) {
      const s = STYLE[rec.status] || STYLE.unknown;
      return deco(s, `Phase ${num}${rec.title ? ` — ${rec.title}` : ''}: ${s.label}`);
    }
 
    // Other files inside the phase folder are left undecorated in granular mode.
    return undefined;
  },
};
 
function setupWatcher(context) {
  if (watcher) watcher.dispose();
  const dir = cfg().get('planningDir', '.planning');
  watcher = vscode.workspace.createFileSystemWatcher(`**/${dir}/**`);
 
  const bump = () => {
    clearTimeout(debounce);
    debounce = setTimeout(reload, 250);
  };
  watcher.onDidCreate(bump);
  watcher.onDidChange(bump);
  watcher.onDidDelete(bump);
  context.subscriptions.push(watcher);
}
 
function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.command = 'gsdPhaseStatus.refresh';
  context.subscriptions.push(statusBar);
 
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider),
    vscode.commands.registerCommand('gsdPhaseStatus.refresh', reload),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gsdPhaseStatus')) {
        setupWatcher(context);
        reload();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(reload)
  );
 
  setupWatcher(context);
  reload();
}
 
function deactivate() {
  if (watcher) watcher.dispose();
  clearTimeout(debounce);
}
 
module.exports = { activate, deactivate };
