'use strict';

/**
 * Pure parsing helpers for a GSD .planning tree.
 * No vscode imports here on purpose: this file is testable with plain node.
 */

const ORDER = [
  'blocked',
  'humanneeded',
  'inprogress',
  'planned',
  'discussed',
  'complete',
  'parked',
  'superseded',
  'pending',
  'unknown',
];

/** Statuses that a filesystem signal is allowed to overwrite. */
const UPGRADEABLE = new Set(['pending', 'unknown', null]);

/**
 * Declared outcomes that outrank STATE.md naming a phase active. Parked belongs
 * here for the same reason complete does: plan files still sit in the folder
 * and the phase is still cited by its successors, so without this a mention is
 * enough to repaint a stood-down phase as live work.
 */
const SETTLED = new Set(['complete', 'blocked', 'parked', 'superseded']);

/**
 * Phase numbers are hierarchical and can nest any number of levels deep:
 * "34", "34.1", "4.4.1". They are stored and keyed as normalized strings, not
 * floats — parseFloat("4.4.1") is 4.4, which both loses the third level and
 * collides with the real phase 4.4. Normalizing strips per-segment leading
 * zeros so "04.01" and "4.1" are the same phase.
 *
 * @returns {string|null} e.g. "4.4.1", or null if not a dotted number.
 */
function normalizePhaseNum(raw) {
  if (raw === null || raw === undefined) return null;
  const segments = String(raw).trim().split('.');
  const out = [];
  for (const seg of segments) {
    if (!/^\d+$/.test(seg)) return null;
    out.push(String(parseInt(seg, 10)));
  }
  return out.length ? out.join('.') : null;
}

/**
 * Order two hierarchical phase numbers numerically, segment by segment, so
 * "4" < "4.1" < "4.2" < "4.10" < "34". A missing segment sorts before any
 * present one ("4" before "4.1").
 */
function comparePhaseNum(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = i < pa.length ? pa[i] : -1;
    const y = i < pb.length ? pb[i] : -1;
    if (x !== y) return x - y;
  }
  return 0;
}

// Capture group for a hierarchical phase number: one or more dot-separated
// integer segments. Kept as a string so callers can share it in regexes.
const PHASE_NUM = '\\d+(?:\\.\\d+)*';

const DEFAULT_DISCUSSED_MARKERS = ['*'];
// Glob-aware: matches "34-02-PLAN.md" as well as a bare "PLAN.md".
const DEFAULT_PLANNED_MARKERS = ['*PLAN.md'];
// A per-plan SUMMARY file is GSD's signal that that wave has been executed.
const DEFAULT_SUMMARY_MARKERS = ['*SUMMARY.md'];

// The status emojis a roadmap may lead its value with ("**Status:** ⛔ PARKED").
// Skipped by the status-field reader so the WORD after the emoji decides: ⛔ on
// its own says "stop", which is true of blocked and parked alike, and only the
// word says which. ️ covers the variation-selector spellings.
const STATUS_EMOJI_SRC = '(?:[✅✔☑🚧⏳🔄▶⛔❌🛑⚠⏸🅿]\\uFE0F?\\s*)*';

// Parked/deferred/cancelled: work that was deliberately stood down, as opposed
// to work that is stuck (blocked) or never started (pending). Kept as one
// vocabulary so the field reader and the prose reader cannot drift apart.
const PARKED_WORDS =
  'parked|deferred|defer|cancelled|canceled|superseded|supersede[sd]?|abandoned|dropped|shelved|descoped|de-scoped|obsolete|wont-?fix|skipped|retired|withdrawn';
const PARKED_FIELD = new RegExp(`^(?:${PARKED_WORDS})`);
// Superseded is a subset of the parked vocabulary that means something
// stronger: a successor replaced this work and it will not come back. It is
// tested BEFORE the parked words wherever those are, but only when it LEADS the
// value, so "PARKED — superseded by Phase 24" stays parked (the word that leads
// is the one that decides) while "SUPERSEDED by Phase 24" is its own status.
const SUPERSEDED_WORDS = 'superseded|supersede[sd]?';
const SUPERSEDED_FIELD = new RegExp(`^(?:${SUPERSEDED_WORDS})`);
const SUPERSEDED_WEAK = new RegExp(`(?:^|[|(\\[—–-]\\s*)\\**\\s*(?:${SUPERSEDED_WORDS})\\b`, 'i');
// In prose the word must LEAD its clause — at the head of the line, or straight
// after a cell/parenthesis/dash separator — because these words are far more
// often used about some other phase than about this one. Phase 34.6's goal
// says its channels were "deferred rather than dropped": that is a description
// of upcoming work, and a bare keyword search paints it as cancelled.
const PARKED_WEAK = new RegExp(`(?:^|[|(\\[—–-]\\s*)\\**\\s*(?:${PARKED_WORDS})\\b`, 'i');

/**
 * Strong signals are unambiguous status declarations. Weak signals are bare
 * keywords anywhere on the line, which are prone to false positives
 * ("Phase 2: Complete the auth flow"), so they only apply when no strong
 * signal was found for that phase.
 */
function strongStatus(line) {
  const trimmed = line.trim();

  // Markdown task checkbox at the start of a list item
  if (/^[-*+]\s*\[[xX✓]\]/.test(trimmed)) return 'complete';
  if (/^[-*+]\s*\[[~\-]\]/.test(trimmed)) return 'inprogress';
  if (/^[-*+]\s*\[\s\]/.test(trimmed)) return 'pending';

  // Explicit status field: "status: complete", "**Status:** In Progress", "- Status — blocked"
  const field = trimmed.match(
    new RegExp(`(?:^|[^a-z])status\\s*[:\\-–—]\\s*\\**\\s*${STATUS_EMOJI_SRC}([a-z][a-z _\\-]*)`, 'i')
  );
  if (field) {
    const v = field[1].toLowerCase().replace(/[_\s]+/g, '-').trim();
    // Parked is tested first: such a line usually also carries the reason it
    // stood down ("PARKED — superseded by the completed Phase 24"), so a later
    // test would happily read that reason as this phase's own status.
    if (SUPERSEDED_FIELD.test(v)) return 'superseded';
    if (PARKED_FIELD.test(v)) return 'parked';
    if (/^(complete|completed|done|shipped|verified|closed)/.test(v)) return 'complete';
    if (/^(in-progress|inprogress|active|executing|current|wip|started|running)/.test(v)) return 'inprogress';
    if (/^(blocked|failed|error|needs-fix|broken)/.test(v)) return 'blocked';
    if (/^(pending|planned|not-started|todo|upcoming|queued|backlog|draft)/.test(v)) return 'pending';
  }

  // Emoji markers GSD and hand-edited roadmaps both use
  if (/[✅✔☑]/.test(line)) return 'complete';
  if (/[🚧⏳🔄▶]/.test(line)) return 'inprogress';
  if (/[⏸🅿]/.test(line)) return 'parked';
  if (/[⛔❌🛑⚠️⚠]/.test(line)) return 'blocked';
  if (/[⬜◻⭕]/.test(line)) return 'pending';

  return null;
}

function weakStatus(line) {
  const l = line.toLowerCase();
  const lead = stripLeadDecoration(l);
  if (SUPERSEDED_WEAK.test(lead) && !PARKED_WEAK.test(lead.replace(SUPERSEDED_WEAK, ''))) return 'superseded';
  if (PARKED_WEAK.test(lead)) return 'parked';
  if (/\b(complete|completed|done|shipped|verified)\b/.test(l)) return 'complete';
  if (/\b(in[-_ ]?progress|active|executing|wip|started)\b/.test(l)) return 'inprogress';
  if (/\b(blocked|failed|needs[-_ ]fix)\b/.test(l)) return 'blocked';
  if (/\b(pending|planned|not[-_ ]started|todo|upcoming|queued)\b/.test(l)) return 'pending';
  return null;
}

/**
 * A phase artifact's frontmatter `status:` is a CONTROLLED vocabulary — GSD
 * writes it — so unlike ROADMAP prose the value can be trusted exactly. That is
 * why this is a separate reader from strongStatus(): `passed` and `approved` are
 * definitive in a VERIFICATION.md header and merely suggestive in a roadmap
 * sentence, and folding them into the prose vocabulary would repaint phases.
 *
 * Every value below was observed in the tree; anything unseen returns null so a
 * new vocabulary word shows up as uncoloured rather than as a wrong colour.
 */
const ARTIFACT_STATUS = {
  complete: [
    'complete', 'completed', 'done', 'approved', 'validated', 'audited', 'verified',
    'secured', 'passed', 'pass', 'all-fixed', 'fixed', 'resolved', 'warnings-resolved',
    'closed', 'shipped', 'ready', 'accepted', 'signed-off',
  ],
  // "partial" is the big one: 14 UAT/REVIEW-FIX files sit here, and it must not
  // read as pending — the work started and stopped, it was never untouched.
  inprogress: [
    'partial', 'testing', 'diagnosed', 'in-progress', 'inprogress', 'executing',
    'active', 'wip', 'started', 'running', 'issues-found', 'gaps-found', 'open',
  ],
  // Waiting on a person, not on code. Distinct from blocked (nothing is broken)
  // and from pending (the work IS done, it just needs someone to look).
  humanneeded: [
    'human-needed', 'human-required', 'needs-human', 'awaiting-human',
    'human-verification', 'needs-uat', 'awaiting-uat',
  ],
  blocked: ['failed', 'fail', 'error', 'broken', 'needs-fix', 'regressed'],
  pending: ['draft', 'pending', 'planned', 'not-started', 'todo', 'queued', 'backlog'],
};

const ARTIFACT_LOOKUP = new Map();
for (const [status, words] of Object.entries(ARTIFACT_STATUS)) {
  for (const w of words) ARTIFACT_LOOKUP.set(w, status);
}
for (const w of PARKED_WORDS.split('|')) {
  // The parked vocabulary is shared rather than restated, so the two readers
  // cannot drift. Regex-only alternatives (`supersede[sd]?`) are skipped.
  if (/^[a-z-]+$/.test(w)) ARTIFACT_LOOKUP.set(w, 'parked');
}
ARTIFACT_LOOKUP.set('superseded', 'superseded');

/**
 * Map one frontmatter `status:` value to a status, or null if unrecognised.
 * Trailing prose and `#` comments are cut: values like `resolved  # report
 * redacted (b2eeb6cb)` and `complete (13/14 waves)` are both real.
 */
function statusWord(value) {
  if (value === null || value === undefined) return null;
  let v = String(value).trim().replace(/^["']|["']$/g, '');
  v = v.split('#')[0]; // trailing comment
  v = v.split(/[\s(,;—–]/)[0]; // first token only
  return v || null;
}

function artifactStatus(value) {
  const word = statusWord(value);
  if (word === null) return null;
  const v = word.toLowerCase().replace(/[_\s]+/g, '-').replace(/^-+|-+$/g, '');
  if (!v) return null;
  return ARTIFACT_LOOKUP.get(v) || null;
}

/**
 * REVIEW.md needs deriving, not reading. Its `status: issues_found` records what
 * the review FOUND and is never rewritten when the fixes land — 32 of 37 files
 * in this tree still say it, and only 5 have a REVIEW-FIX.md sibling. So pair
 * the two the way PLAN pairs with SUMMARY, and fall back to the review's own
 * status only when no fix pass exists.
 *
 * @param {object} fm  REVIEW.md's parsed frontmatter
 * @param {string|null} fix REVIEW-FIX.md's status value, or null if absent
 */
function reviewStatus(fm, fix) {
  const own = fm ? fm.status : null;
  // `critical:` sits under `findings:` in every file in this tree; the bare form
  // is accepted too so a flatter writer still works.
  const critical = fm && fm.critical !== undefined ? fm.critical : fm ? fm['findings.critical'] : null;
  if (fix !== null && fix !== undefined) {
    // A fix pass exists: it, not the review, states where this stands.
    return artifactStatus(fix) || 'inprogress';
  }
  const s = artifactStatus(own);
  if (s === 'complete') return 'complete';
  // No fix pass and the review still reports findings. An unaddressed CRITICAL
  // is worth surfacing as such; anything else is simply unfinished.
  const n = parseInt(String(critical === null || critical === undefined ? '' : critical).trim(), 10);
  if (Number.isFinite(n) && n > 0) return 'blocked';
  return s || 'inprogress';
}

/**
 * Tier-1 artifacts: every one carries a frontmatter `status:` that GSD writes,
 * so a status read here reports a real gate rather than a guess about prose.
 * Longest suffix first, because "05-HUMAN-UAT.md" also ends in "-UAT.md" and
 * "34-REVIEW-FIX.md" would otherwise be read as a plain review.
 *
 * Deliberately excluded: CONTEXT / RESEARCH / PATTERNS / DISCUSSION-LOG /
 * deferred-items / PORTED-CHANNELS. None of them carries frontmatter at all —
 * they are inputs, not gates, and are "done" the moment they exist, so a status
 * would only dilute the ones that mean something.
 */
const ARTIFACT_KINDS = [
  'REVIEW-FIX.md',
  'HUMAN-UAT.md',
  'VERIFICATION.md',
  'VALIDATION.md',
  'SECURITY.md',
  'UI-SPEC.md',
  'REVIEW.md',
  'UAT.md',
];

// Compared upper-against-upper: ".md" uppercases to ".MD", so folding only one
// side matches nothing at all — silently, on every file.
const ARTIFACT_KINDS_UPPER = ARTIFACT_KINDS.map((k) => k.toUpperCase());

/**
 * A review round after the first is a separate document, and the tree names it
 * three different ways — `34.2-REVIEW-GAP-CYCLE-1.md`, `34.9-REVIEW-CYCLE2.md`.
 * None of them ends in `-REVIEW.md`, so the suffix list above matched NOTHING
 * and eight reviews carried no badge and fed nothing into the folder rollup.
 * Both phases' own fix ledgers record the hole verbatim (34.2-REVIEW-FIX.md:67,
 * 34.9-REVIEW-FIX.md:60).
 *
 * Matched by pattern rather than by suffix because the numbering is part of the
 * name. Kept OUT of ARTIFACT_KINDS so the suffix scan stays a pure list.
 *
 * Deliberately NOT matched: `-REVIEW.iter2.md` / `-REVIEW.partA.md` (phase
 * 34.13). Those pair with `-REVIEW-FIX2.md` / `-REVIEW-FIX3.md` siblings that
 * are equally unrecognised here, so badging the reviews alone would assert
 * unaddressed Criticals that the fix passes may already discharge.
 */
const REVIEW_CYCLE_KIND = 'REVIEW-CYCLE';
const REVIEW_CYCLE_RE = /-REVIEW-(?:GAP-)?CYCLE-?\d+\.MD$/;

/** Which tier-1 artifact a file name is, or null if it is not one. */
function artifactKind(fileName) {
  const upper = String(fileName).toUpperCase();
  // Checked first: a cycle review must never fall through to the suffix scan.
  if (REVIEW_CYCLE_RE.test(upper)) return REVIEW_CYCLE_KIND;
  const i = ARTIFACT_KINDS_UPPER.findIndex((k) => upper === k || upper.endsWith(`-${k}`));
  return i === -1 ? null : ARTIFACT_KINDS[i];
}

/**
 * A cycle review's own `status:` is `issues_found` and permanently will be, for
 * the same reason REVIEW.md's is — but it has no `-FIX` sibling of its own to
 * pair with, and it must NOT borrow the folder's. Both fix ledgers in the tree
 * scope themselves to their round-1 review and disclaim the cycles outright
 * (34.2-REVIEW-FIX.md:53, 34.9-REVIEW-FIX.md:54-58), so inheriting `partial`
 * from them would attribute a status their own authors refused to give.
 *
 * Where the disposition actually lives differs per cycle — `PORTED-CHANNELS.md`
 * §7 for 34.2, `deferred-items.md` tables for 34.9 — and neither file carries
 * frontmatter, so neither is reachable from here. Rather than guess (deriving
 * "cycle N is closed once cycle N+1 exists" is already wrong: 34.2's cycle 4 is
 * dispositioned by a Gap-cycle-5 section with no cycle-5 file behind it), the
 * cycle review DECLARES the outcome in a `disposition:` field that points at its
 * evidence via `dispositioned_by:`.
 *
 * Vocabulary is the existing artifact one, unextended: `closed` → complete,
 * `partial`/`open` → inprogress.
 *
 * @param {object} fm the cycle review's parsed frontmatter
 */
function reviewCycleStatus(fm) {
  const declared = fm ? artifactStatus(fm.disposition) : null;
  if (declared) return declared;
  // Undeclared: fall back to what the review itself reports. An unaddressed
  // Critical reads blocked, anything else in-progress — never uncoloured, so a
  // cycle that nobody has dispositioned is visible rather than absent.
  return reviewStatus(fm, null);
}

/**
 * One artifact's status from its kind and frontmatter. REVIEW.md and
 * REVIEW-CYCLE are the only kinds that cannot be read straight off their own
 * `status:` — see reviewStatus and reviewCycleStatus.
 *
 * @param {string} kind          from artifactKind()
 * @param {object|null} fm       that file's parsed frontmatter
 * @param {string|null} fixValue the sibling REVIEW-FIX.md's raw `status:` value
 */
function resolveArtifactStatus(kind, fm, fixValue = null) {
  if (!fm) return null;
  if (kind === 'REVIEW.md') return reviewStatus(fm, fixValue);
  if (kind === REVIEW_CYCLE_KIND) return reviewCycleStatus(fm);
  return artifactStatus(fm.status);
}

/**
 * Every tier-1 artifact status in one phase folder, for rolling into the
 * folder's own colour. Without this a phase folder is only ever as honest as
 * its PLAN/SUMMARY pairs: phase 34.9 has 33 of 33 summaries on disk and so
 * painted green while its own REVIEW and REVIEW-FIX sat yellow inside it, which
 * is the one thing a container colour must never do — read greener than what it
 * contains.
 *
 * Pure: the caller does the reading and hands over name -> frontmatter.
 *
 * @param {Map<string,object>|object} fmByName file name -> parsed frontmatter
 * @returns {string[]} statuses, unrecognised vocabulary dropped
 */
function folderArtifactStatuses(fmByName) {
  const entries = fmByName instanceof Map ? [...fmByName.entries()] : Object.entries(fmByName || {});
  // Resolved once for the whole folder: every REVIEW.md in it pairs with the
  // same REVIEW-FIX.md, and re-deriving it per file re-reads the directory.
  let fixValue = null;
  for (const [name, fm] of entries) {
    if (fm && artifactKind(name) === 'REVIEW-FIX.md') {
      fixValue = fm.status === undefined ? null : fm.status;
      break;
    }
  }

  const out = [];
  for (const [name, fm] of entries) {
    const kind = artifactKind(name);
    if (!kind) continue;
    // An unrecognised vocabulary word is dropped, not guessed at: it must not
    // drag a folder off green on the strength of a word nobody has mapped.
    const status = resolveArtifactStatus(kind, fm, fixValue);
    if (status) out.push(status);
  }
  return out;
}

/**
 * Extract a phase number from a line, e.g. "### Phase 3: Auth", "- Phase 03 —",
 * "phase-3", "| 3 | Auth |". Hierarchical sub-phases ("Phase 34.1", "Phase
 * 4.4.1") are kept distinct: they are different phases, not all rolled into the
 * integer prefix.
 */
function phaseNumberOnLine(line) {
  const m = line.match(new RegExp(`phase\\s*[-_ ]?0*(${PHASE_NUM})`, 'i'));
  if (m) return normalizePhaseNum(m[1]);
  return null;
}

/** Strip leading markdown decoration (heading hashes, quote/table pipes, list
 * bullet, task checkbox, bold markers) so a line can be tested for what it
 * *starts* with rather than what it merely contains. */
function stripLeadDecoration(line) {
  return String(line)
    .replace(/^[\s>#|]*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/^\**\s*/, '');
}

/**
 * Does this line DECLARE a phase, or merely MENTION one?
 *
 * A declaration leads with the phase label — "### Phase 22: Families",
 * "- [x] **Phase 24: bridge**". A mention buries it mid-sentence —
 * "**Status:** ⛔ PARKED — superseded by Phase 24", "planned at
 * `/gsd-plan-phase 34.9 --gaps`".
 *
 * The distinction matters because parseRoadmap stops its lookahead at the next
 * phase. Treating a cross-reference as a declaration truncated the scan before
 * the phase's own Status line could be read, so a phase whose status line named
 * its superseder reported that status as unknown and fell through to a weak
 * keyword match in the surrounding prose.
 */
function isPhaseDeclaration(line) {
  if (line === null || line === undefined) return false;
  const head = stripLeadDecoration(line);
  return new RegExp(`^phase\\s*[-_ ]?0*${PHASE_NUM}\\b`, 'i').test(head);
}

/**
 * Is this line an entry for an individual plan (wave) file, e.g.
 * "- [x] 34.9-23-PLAN.md — ..."?
 *
 * These carry a PLAN's status, not the phase's. They contain no "Phase N"
 * label, so they never broke the lookahead — which meant a ticked plan
 * checkbox inside a phase's section was silently adopted as that phase's own
 * status, marking a live phase complete off a single finished wave.
 */
function isPlanFileLine(line) {
  if (line === null || line === undefined) return false;
  return planKeyFromFileName(stripLeadDecoration(line)) !== null;
}

/** Match "Phase 34.1" / "Phase 04.01" in a title line, tolerating zero-padded
 * segments, so the number can be stripped no matter how it was written. */
function phaseLabelRegex(num) {
  const segs = String(num)
    .split('.')
    .map((s) => `0*${s}`)
    .join('\\.');
  return new RegExp(`phase\\s*[-_ ]?${segs}\\s*[:\\-–—]?\\s*`, 'i');
}

function titleOnLine(line, num) {
  let t = line
    .replace(/^[#\s>|]*/, '')
    .replace(/^[-*+]\s*\[[^\]]*\]\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(phaseLabelRegex(num), '')
    .replace(/\*\*/g, '')
    .replace(/[|`]/g, ' ')
    .trim();
  // Cut anything after a status separator so the title stays short
  t = t.split(/\s+[–—]\s+/)[0].trim();
  return t.length > 60 ? t.slice(0, 57) + '...' : t;
}

/**
 * Parse ROADMAP.md into Map<phaseNumber, {status, title}>.
 * A phase's status may be declared on its own line or within the next few
 * lines (GSD writes a heading then a Status line beneath it).
 */
function parseRoadmap(text, lookahead = 8) {
  const phases = new Map();
  if (!text) return phases;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    // Only a line that LEADS with the phase label owns that phase; a passing
    // cross-reference must not mint a record (that is where phantom "phase
    // 2026" entries come from, read out of a date).
    if (!isPhaseDeclaration(lines[i])) continue;
    const num = phaseNumberOnLine(lines[i]);
    if (num === null) continue;
    // A per-plan entry states that PLAN's status and never the phase's — not
    // as an anchor here, and not in any lookahead below. Such a line can still
    // name its phase ("leave `/gsd-verify-work 34.9` as the next step"), so
    // without this guard one finished wave's [x] marks the whole phase done.
    if (isPlanFileLine(lines[i])) continue;

    if (!phases.has(num)) {
      phases.set(num, { status: null, weak: null, title: titleOnLine(lines[i], num) });
    }
    const rec = phases.get(num);

    // The declaring line itself takes priority
    if (!rec.status) rec.status = strongStatus(lines[i]);
    if (!rec.weak) rec.weak = weakStatus(lines[i]);

    // Then a short lookahead, stopping at the next phase declaration. Lines
    // that merely cite another phase are scanned through, not stopped at.
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + lookahead); j++) {
      if (isPhaseDeclaration(lines[j])) break;
      // A per-plan entry states that PLAN's status, never the phase's.
      if (isPlanFileLine(lines[j])) continue;
      if (!rec.status) rec.status = strongStatus(lines[j]);
      if (!rec.weak) rec.weak = weakStatus(lines[j]);
    }
  }

  for (const rec of phases.values()) {
    // `weakOnly` records that this status came from a bare keyword in prose
    // rather than a declared marker — a guess, not a statement. Callers treat
    // it as overridable by filesystem evidence, because phase sections without
    // a Status line otherwise take their colour from whatever adjective their
    // description happens to contain ("the *active* tab", "8/8 plans
    // *complete*").
    rec.weakOnly = !rec.status && !!rec.weak;
    rec.status = rec.status || rec.weak || 'unknown';
    delete rec.weak;
  }
  return phases;
}

/** Read simple `key: value` pairs out of a leading YAML frontmatter block. */
function parseFrontmatter(text) {
  const out = {};
  if (!text) return out;
  const m = text.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  // Top-level keys keep their bare name; nested ones are stored under a dotted
  // path instead of being hoisted. Both halves are load-bearing:
  //   - hoisting lets the LAST key win, and 34.2-VERIFICATION.md declares
  //     `status: passed` on line 3 while carrying a nested `status: overridden`
  //     51 lines down inside an override record;
  //   - but dropping nested keys outright loses REVIEW.md's `critical:`, which
  //     lives under `findings:` and is the only count worth reading.
  const stack = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\s*)([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const indent = kv[1].length;
    const key = kv[2].toLowerCase();
    const value = kv[3].trim().replace(/^["']|["']$/g, '');
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const path = stack.map((f) => f.key).concat(key).join('.');
    out[path] = value;
    stack.push({ indent, key });
  }
  return out;
}

// "PHASE 23.1 COMPLETE", "Phase 34.15 — completed", "phase 7 is done". The
// outcome word has to follow the phase reference closely: "Phase 12 blocked on
// the completed Phase 11" must not read as phase 12 being finished.
const PHASE_DONE_IN_STATE = new RegExp(
  `phase\\s*[-_ ]?0*(${PHASE_NUM})\\s*[-–—:,()]*\\s*(?:is\\s+|was\\s+|now\\s+)?` +
    `(?:complete|completed|done|finished|shipped|closed)\\b`,
  'i'
);

/**
 * STATE.md tells us which phase is actually being worked on right now.
 * GSD's STATE.md doesn't always carry an `active_phase:` frontmatter key, so we
 * also read the `stopped_at:` field and the body prose it always writes.
 */
function parseActivePhase(text) {
  if (!text) return null;
  const fm = parseFrontmatter(text);

  // 1. Explicit frontmatter key, if present.
  for (const key of ['active_phase', 'current_phase', 'phase']) {
    if (fm[key] !== undefined) {
      const m = String(fm[key]).match(new RegExp(`0*(${PHASE_NUM})`));
      if (m) return normalizePhaseNum(m[1]);
    }
  }

  // 2. GSD frontmatter: "stopped_at: Completed 34-02-PLAN.md" names the live phase.
  if (fm.stopped_at) {
    const raw = String(fm.stopped_at);
    const m = raw.match(new RegExp(`0*(${PHASE_NUM})`));
    if (m) {
      const num = normalizePhaseNum(m[1]);
      // ...but GSD conventionally OPENS this field with the outcome, so
      // "stopped_at: PHASE 23.1 COMPLETE (2026-08-18). 5/5 plans." names the
      // phase that just FINISHED, not the one being worked on. Reading it as
      // active paints a finished phase yellow AND clears weakOnly, which locks
      // out the folder evidence (5 of 5 summaries on disk) that would have
      // corrected it — the roadmap, the filesystem and this very field all say
      // complete, and the phase still comes out yellow.
      const done = raw.match(PHASE_DONE_IN_STATE);
      if (!(done && normalizePhaseNum(done[1]) === num)) return num;
    }
  }

  // 3. The body's focus line, which is the one place GSD can say "nothing is in
  //    flight" — and it had no way to be heard. Scan focus lines in order and
  //    let the FIRST one carrying a verdict answer: a LEADING none/nothing/idle
  //    sentinel means no phase is active. Without it the phase-number scan takes
  //    whatever number the line mentions first, which on a just-closed phase is
  //    the phase being reported COMPLETE — the same yellow-finished-phase bug
  //    `stopped_at` is guarded against above, arriving by the other door.
  //    The sentinel has to LEAD the value, like PARKED_WORDS: "Phase 47, none of
  //    the gates run yet" is a live phase, not an idle tree.
  for (const line of text.match(/current\s+focus[^\n]*/gi) || []) {
    if (/^current\s+focus[^A-Za-z0-9]*(?:none|nothing|idle|n\/a)\b/i.test(line)) return null;
    const m = line.match(new RegExp(`phase\\s*[-_ ]?0*(${PHASE_NUM})`, 'i')); // "**Current focus:** Phase 34"
    if (m) return normalizePhaseNum(m[1]);
  }

  // 3b. Other body phrasings GSD writes.
  const patterns = [
    new RegExp(`phase\\s*[:\\-]?\\s*0*(${PHASE_NUM})[^\\n]*\\bexecuting\\b`, 'i'), // "Phase: 34 (...) — EXECUTING"
    new RegExp(`(?:active|current)[\\s_-]*phase\\s*[:=]?\\s*#?\\s*0*(${PHASE_NUM})`, 'i'),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return normalizePhaseNum(m[1]);
  }
  return null;
}

/**
 * Format a wave number + optional letter suffix into a plan id that matches
 * planKeyFromFileName's output: a plain number (8) when unlettered, a string
 * ("8a") for a split/parallel plan. Leading zeros are stripped either way.
 */
function planId(numStr, letter) {
  const n = parseInt(numStr, 10);
  return letter ? `${n}${letter.toLowerCase()}` : n;
}

/**
 * Which plan (wave) within the active phase is current. GSD records this as
 * "Plan: 3 of 6" in STATE.md; falls back to the plan number in
 * "stopped_at: Completed 34-02-PLAN.md" + 1 (the next one to run).
 *
 * Split/parallel plans carry a letter suffix (08a, 08b, 08c). These run in
 * parallel, so there is no sequential "+1" successor: when STATE names a
 * lettered wave we return that plan id verbatim ("8b") rather than guessing the
 * next letter. The caller only paints it in-progress if it is not yet complete.
 */
function parseActivePlan(text) {
  if (!text) return null;
  const body = text.match(/\bplan\s*[:#]?\s*0*(\d+)([a-z]+)?\s*of\s*0*(\d+)/i);
  if (body) return planId(body[1], body[2]);
  const fm = parseFrontmatter(text);
  if (fm.stopped_at) {
    const m = String(fm.stopped_at).match(
      new RegExp(`(${PHASE_NUM})\\s*-\\s*0*(\\d+)([a-z]+)?`, 'i')
    ); // "34-02" -> 02, "34.8-08b" -> "8b"
    if (m) return m[3] ? planId(m[2], m[3]) : parseInt(m[2], 10) + 1;
  }
  return null;
}

/**
 * Given a workspace-relative POSIX path, return the phase number it belongs to,
 * or null. Matches `.planning/phases/03-auth/PLAN.md`, `.planning/phases/phase-3.md`, etc.
 */
function phaseNumberForPath(relPath, planningDir = '.planning') {
  if (!relPath) return null;
  const p = relPath.replace(/\\/g, '/');
  const needle = `${planningDir.replace(/^\.?\/*/, '.').replace(/\/$/, '')}/phases/`.toLowerCase();
  const idx = p.toLowerCase().indexOf(needle);
  if (idx === -1) return null;
  const rest = p.slice(idx + needle.length);
  if (!rest) return null;
  return phaseNumberFromSegment(rest.split('/')[0]);
}

/**
 * First phase number in a single path segment, e.g. "03-auth" -> "3",
 * "phase-12.md" -> "12", "34.1-auth" -> "34.1", "4.4.1-auth" -> "4.4.1". A
 * trailing ".md" extension is stripped first so a flat "phase-2.md" file is not
 * read as phase 2.md.
 */
function phaseNumberFromSegment(segment) {
  if (!segment) return null;
  const m = segment
    .replace(/\.(md|markdown|txt)$/i, '')
    .match(new RegExp(`0*(${PHASE_NUM})`));
  return m ? normalizePhaseNum(m[1]) : null;
}

/**
 * Parse a per-plan filename like "34-02-PLAN.md" or "34-02-SUMMARY.md" into
 * { phase, plan }. Returns null when the name is not a two-number plan file —
 * a phase-level file such as "4.4.1-PLAN.md" has no separate "-NN" wave number,
 * so it is left for phaseNumberFromSegment to read as phase "4.4.1".
 *
 * A letter suffix on the wave number ("34.8-08a-PLAN.md") marks a split /
 * parallel plan: 08a, 08b and 08c are distinct plans, so `plan` comes back as a
 * string ("8a") in that case and a plain number (8) otherwise.
 */
function planKeyFromFileName(name) {
  const m = String(name).match(new RegExp(`^0*(${PHASE_NUM})-0*(\\d+)([a-z]+)?\\b`, 'i'));
  if (!m) return null;
  return { phase: normalizePhaseNum(m[1]), plan: planId(m[2], m[3]) };
}

/**
 * Does a list of file names match a marker list?
 * "*" as a whole marker means any file at all counts. Markers may also contain
 * "*" as a wildcard (e.g. "*PLAN.md" matches "34-02-PLAN.md"). Case-insensitive.
 */
function matchesMarkers(fileNames, markers) {
  if (!fileNames || !fileNames.length) return false;
  if (!markers || !markers.length) return false;
  if (markers.includes('*')) return true;
  const names = fileNames.map((f) => f.toLowerCase());
  return markers.some((m) => {
    const marker = String(m).toLowerCase();
    if (marker.includes('*')) {
      const re = new RegExp(
        '^' + marker.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
      );
      return names.some((f) => re.test(f));
    }
    return names.includes(marker);
  });
}

/**
 * Backwards-compatible alias for the single-tier check used before planned/
 * discussed were split apart.
 */
function isStartedByFiles(fileNames, markers = ['*']) {
  return matchesMarkers(fileNames, markers);
}

/**
 * Classify a phase folder from its file listing, following GSD's
 * discuss -> plan -> execute sequence:
 *
 *   empty folder            -> null      (stays pending)
 *   has research/notes      -> discussed (orange)
 *   has PLAN.md             -> planned   (blue)
 *
 * Planned is checked first, since a phase that has been planned was also
 * necessarily discussed.
 */
function classifyFolder(fileNames, opts = {}) {
  const discussedMarkers = opts.discussedMarkers || DEFAULT_DISCUSSED_MARKERS;
  const plannedMarkers = opts.plannedMarkers || DEFAULT_PLANNED_MARKERS;

  if (!fileNames || !fileNames.length) return null;
  if (matchesMarkers(fileNames, plannedMarkers)) return 'planned';
  if (matchesMarkers(fileNames, discussedMarkers)) return 'discussed';
  return null;
}

/**
 * Classify each plan (wave) inside a phase folder by pairing its PLAN and
 * SUMMARY files. Returns Map<planNumber, {status, planFile, summaryFile}>:
 *   has a *-SUMMARY.md -> 'complete'
 *   has a *-PLAN.md only -> 'planned'
 * The caller promotes the single active plan to 'inprogress' using STATE.md.
 */
function classifyPlans(fileNames, opts = {}) {
  const plannedMarkers = opts.plannedMarkers || DEFAULT_PLANNED_MARKERS;
  const summaryMarkers = opts.summaryMarkers || DEFAULT_SUMMARY_MARKERS;
  const plans = new Map();
  if (!fileNames || !fileNames.length) return plans;

  const ensure = (n) => {
    if (!plans.has(n)) plans.set(n, { status: null, planFile: null, summaryFile: null });
    return plans.get(n);
  };

  for (const name of fileNames) {
    const key = planKeyFromFileName(name);
    if (!key) continue;
    if (matchesMarkers([name], summaryMarkers)) {
      ensure(key.plan).summaryFile = name;
    } else if (matchesMarkers([name], plannedMarkers)) {
      ensure(key.plan).planFile = name;
    }
  }

  for (const rec of plans.values()) {
    rec.status = rec.summaryFile ? 'complete' : rec.planFile ? 'planned' : null;
  }
  return plans;
}

/**
 * Fold filesystem-derived statuses into the roadmap map. Only touches phases
 * that are pending/unknown, so complete, blocked and in-progress all survive.
 * Phase folders absent from ROADMAP.md are added rather than ignored.
 *
 * @param {Map<number, object>} phases
 * @param {Map<number, string>|Set<number>} folderStates phase number -> status
 */
function applyFolderState(phases, folderStates) {
  const entries =
    folderStates instanceof Set
      ? [...folderStates].map((n) => [n, 'discussed'])
      : [...folderStates.entries()];

  for (const [num, status] of entries) {
    if (!status) continue;
    if (!phases.has(num)) {
      phases.set(num, { status, title: '' });
      continue;
    }
    const rec = phases.get(num);
    // Declared statuses stand. Guessed ones (weakOnly) yield to what the plan
    // and summary files on disk actually show.
    if (UPGRADEABLE.has(rec.status) || rec.weakOnly) {
      rec.status = status;
      rec.weakOnly = false;
    }
  }
  return phases;
}

/** Deprecated alias kept so older configs and scripts keep working. */
function applyStarted(phases, startedNumbers) {
  return applyFolderState(phases, startedNumbers);
}

/** Roll child statuses up into a single status for a parent folder. */
function rollup(statuses) {
  if (!statuses.length) return 'unknown';
  // Parked children are out of the running, not part of it: a container whose
  // only unfinished phase was cancelled is finished, not stuck.
  const live = statuses.filter((s) => s !== 'parked' && s !== 'superseded');
  if (!live.length) return statuses.every((s) => s === 'superseded') ? 'superseded' : 'parked';
  statuses = live;
  if (statuses.includes('blocked')) return 'blocked';
  // Nothing is broken, but nothing moves until a person looks at it — that
  // outranks in-progress, which is work the machine can still push forward.
  if (statuses.includes('humanneeded')) return 'humanneeded';
  if (statuses.includes('inprogress')) return 'inprogress';
  if (statuses.every((s) => s === 'complete')) return 'complete';
  if (statuses.includes('complete')) return 'inprogress';
  if (statuses.includes('planned')) return 'planned';
  if (statuses.includes('discussed')) return 'discussed';
  return 'pending';
}

/** Combine roadmap + state into the final phase map. */
function buildPhaseMap(roadmapText, stateText) {
  const phases = parseRoadmap(roadmapText);
  const active = parseActivePhase(stateText);
  const activePlan = parseActivePlan(stateText);

  if (active !== null) {
    if (!phases.has(active)) phases.set(active, { status: 'inprogress', title: '' });
    const rec = phases.get(active);
    // STATE.md wins unless the roadmap DECLARES the phase finished or stuck.
    // A merely guessed "complete" must not outrank STATE.md naming this the
    // phase being worked on right now.
    if (rec.weakOnly || !SETTLED.has(rec.status)) {
      rec.status = 'inprogress';
      rec.weakOnly = false;
    }
  }
  return { phases, active, activePlan };
}

/**
 * Map one todo's frontmatter `status:` to a status word.
 *
 * Same reader as every other artifact, with one deliberate exception: in a todo
 * `open` means nobody has started, while in a REVIEW it means findings are
 * still being worked. 25 of the 43 pending todos say OPEN, and letting
 * artifactStatus() paint them all "in progress" yellow would claim 25 open work
 * fronts that do not exist. Same reason reviewStatus() is its own reader.
 */
function todoStatus(value) {
  // Compared against the shared tokeniser rather than a \b regex: `-` is a
  // non-word character, so \b would read `open-question` as the bare idiom.
  const word = statusWord(value);
  if (word && word.toLowerCase() === 'open') return 'pending';
  // A superseded todo is stood down like a parked one; only phases tell them apart.
  const s = artifactStatus(value);
  return s === 'superseded' ? 'parked' : s;
}

/**
 * The status to paint a todo file, given its frontmatter and which folder it
 * sits in.
 *
 * The FOLDER is authoritative for done-ness, not the `status:` line. A todo is
 * closed by moving the file, and the line inside it rots: 6 of the 68 files in
 * completed/ still say `status: OPEN`, and 26 have no status line at all.
 * Trusting frontmatter over location would paint six finished todos as
 * outstanding work — the exact false alarm these badges exist to prevent.
 *
 * Frontmatter is consulted only for what a folder cannot express: that an item
 * was deliberately stood down (parked, in either folder — that is a decision,
 * not a completion), or that a pending one is being worked right now.
 */
function todoFileStatus(fmStatus, folder) {
  const declared = todoStatus(fmStatus);
  if (declared === 'parked') return 'parked';
  if (folder === 'completed') return 'complete';
  return declared === 'inprogress' ? 'inprogress' : 'pending';
}

// Severity as an ORDINAL DIGIT rather than a glyph: `1` reads as worse than `4`
// at a glance without a legend, and digits carry no font-rendering risk across
// themes — unlike the `🧍` in STYLE, which depends on emoji fallback.
const TRIAGE_SEVERITY_DIGIT = {
  critical: '1',
  major: '2',
  medium: '3',
  minor: '4',
};

const TRIAGE_UNKNOWN_SEVERITY = 'untriaged severity';

function normalizeTriageValue(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

// The known-OS vocabulary for the platform rung, keyed by the normalized
// `platform:` value. `M` is a newly spent letter — the letters already in use
// are B W L . G H ? plus the two 1-char exceptions ✓ ▶, so `M` for macOS does
// not collide. extension.js reads this same map (via HOST_PLATFORMS below) so
// the host vocabulary is defined once, not forked between the two files.
const HOST_PLATFORMS = {
  macos: { letter: 'M', label: 'macOS only — not this machine' },
  windows: { letter: 'W', label: 'Windows only — not this machine' },
  linux: { letter: 'L', label: 'Linux only — not this machine' },
};

// Purple is parked-or-blocked, red is wrong-platform: everything else (green
// ready, blue live-gate, orange human, yellow in progress, descriptionForeground
// untriaged) is actionable. This is what makes `tallyTodos`'s `open` and the
// per-file badges agree BY CONSTRUCTION, instead of forking the vocabulary a
// second time inside the tally. Standing obligation: if a future rung ever
// paints something red or purple that IS actionable, this set has to be
// revisited — the cap sweep in test-parse.js pins the mapping non-vacuously
// so that obligation is enforced, not just written down here.
const TRIAGE_STOOD_DOWN_COLORS = new Set(['charts.purple', 'charts.red']);

function triageActionable(triage) {
  return !TRIAGE_STOOD_DOWN_COLORS.has(triage.color);
}

/**
 * Badge, colour and tooltip label for one todo file, from its triage
 * frontmatter (`severity:` / `platform:` / `ready:`) and which folder it is in.
 *
 * `fm` is a parseFrontmatter() result or null; `folder` is 'pending' or
 * 'completed'. Returns { badge, color, label } — `color` is a plain theme
 * colour ID string, the same shape as the STYLE entries, so extension.js's
 * deco() consumes it unchanged.
 *
 * WHY THE BADGE REPEATS WHAT THE COLOUR SAYS. The redundancy is deliberate, not
 * an oversight. Colour tuning on this hand-installed extension is already
 * documented as fragile — `contributes.colors` never registers, because VS
 * Code's registry entry for it is pinned to an old version, so a colour can
 * silently render as plain foreground. A channel that can fail silently is a
 * poor SOLE channel, so readiness is encoded twice: once as a letter anyone can
 * read, once as a colour that is faster when it works. Neither is load-bearing
 * alone.
 *
 * ACCEPTED WART: `charts.green` means *complete* on a phase folder and *ready
 * to start* on a todo — opposite ends of the same work. This is accepted under
 * the extension's existing cross-namespace reuse rationale (see the
 * `discussed`/`humanneeded` and TODO_OPEN_COLOR notes at extension.js:50-53 and
 * :57-62): phase folders, artifact files and todo files are three separate
 * namespaces, and a colour is only ever read against the other rows of its own
 * kind. Renaming would cost more legibility than the collision does.
 *
 * The badge is structurally 2 characters on every pending path — one severity
 * digit plus one readiness/platform letter, both always non-empty. The two
 * single-character exceptions (`✓` complete, `▶` in progress) are today's
 * behaviour, preserved rather than displaced. VS Code truncates a 3-character
 * badge silently, so a wide badge is a WRONG answer, not a missing one;
 * test-parse.js sweeps the whole vocabulary cross-product to hold this.
 *
 * Values are lowercased here: parseFrontmatter lowercases KEYS but not VALUES,
 * so `severity: Major` arrives with its capital intact.
 *
 * `host` is the third argument: a normalized platform value (`'macos'` /
 * `'windows'` / `'linux'`) identifying THIS machine, or a falsy value to
 * disable the platform rung entirely. parse.js stays pure — it never reads
 * `process.platform` itself; extension.js reads it once and passes the result
 * in. See HOST_PLATFORMS above for the vocabulary this is compared against.
 */
function todoTriage(fm, folder, host) {
  const status = todoFileStatus(fm ? fm.status : null, folder);
  const severity = normalizeTriageValue(fm && fm.severity);
  const platform = normalizeTriageValue(fm && fm.platform);
  const ready = normalizeTriageValue(fm && fm.ready);

  const digit = TRIAGE_SEVERITY_DIGIT[severity] || '?';
  const sevLabel = TRIAGE_SEVERITY_DIGIT[severity]
    ? severity
    : TRIAGE_UNKNOWN_SEVERITY;
  const of = (letter, color, what) => ({
    badge: `${digit}${letter}`,
    color,
    label: `${sevLabel} · ${what}`,
  });

  // Rungs 1-3 defer to todoFileStatus rather than re-deriving done-ness from
  // the folder: that function already encodes the rule that the FOLDER is
  // authoritative for completion while frontmatter still decides parked and
  // in-progress. Re-deriving it here would fork that logic and, specifically,
  // would repaint a parked todo sitting in completed/ from purple to green.
  if (status === 'complete') {
    return { badge: '✓', color: 'charts.green', label: 'Complete' };
  }
  if (status === 'parked') {
    return of('B', 'charts.purple', 'parked');
  }
  if (status === 'inprogress') {
    return {
      badge: '▶',
      color: 'charts.yellow',
      label: `${sevLabel} · in progress`,
    };
  }

  // Platform beats readiness: "not on this machine" dominates, because a todo
  // you cannot verify here is not one you can pick up here, however desk-ready
  // its code half looks. "Here" is a HOST LOOKUP, not a constant — the rung
  // fires only when the frontmatter names a KNOWN os (a key of HOST_PLATFORMS)
  // that is NOT the host we were given. `platform: any`, a missing
  // `platform:`, and an unrecognised value (e.g. `flurbled`) are always
  // actionable, at every host, because they are not a key of the map. A
  // falsy/unknown `host` (no `process.platform` mapping) disables the rung
  // entirely rather than reddening every platform-tagged todo — see
  // T-sya-03 in the plan's threat register.
  if (host && HOST_PLATFORMS[platform] && platform !== host) {
    const { letter, label } = HOST_PLATFORMS[platform];
    return of(letter, 'charts.red', label);
  }

  if (ready === 'code') {
    return of('.', 'charts.green', 'ready to pick up at the desk');
  }
  if (ready === 'live-gate') return of('G', 'charts.blue', 'needs a live gate');
  if (ready === 'human') return of('H', 'charts.orange', 'needs a human');
  // Same purple as parked above, and the same meaning: stood down, nothing is
  // wrong and nobody is waiting on it.
  if (ready === 'blocked') return of('B', 'charts.purple', 'blocked');

  // `?` for the readiness half rather than a blank, so a file carrying no
  // triage keys at all reads `??` — unmistakably "this one was never triaged"
  // rather than something that merely failed to render.
  return of('?', 'descriptionForeground', 'untriaged readiness');
}

/**
 * Tally one folder of todo files.
 *
 * `fms` is one parseFrontmatter() result per PENDING file, null included: a
 * todo with no `status:` line (or no frontmatter at all) is still a todo, it
 * just never said so. `host` is the same host value passed to `todoTriage` —
 * see its doc comment.
 *
 * `total` is unchanged in meaning from before this rewrite: it has to agree
 * with the file count the Explorer shows when `pending/` is expanded, so the
 * `todos/pending` badge can keep reading it. `parked` is pulled out the same
 * way it always was.
 *
 * `open` narrowed with this rewrite: it used to be `total - parked`; now it
 * is the count of files whose `todoTriage` verdict is ACTIONABLE — parked,
 * `ready: blocked`, and wrong-platform todos are all excluded, not just
 * parked ones. It is derived from `todoTriage` (via `triageActionable`)
 * rather than a second copy of the vocabulary, specifically so the folder
 * number and the per-file badges cannot silently drift apart the way they did
 * when `ready: blocked` was added to the ladder but not to this function.
 *
 * `unparked` is the OLD `open` (`total - parked`), kept under its own name
 * solely so the `todos/pending` row's colour — which switches on "is
 * anything here not parked" — is unaffected by `open` narrowing. Changing
 * that row is explicitly out of scope for the actionable rewrite.
 */
function tallyTodos(fms, host) {
  const total = fms.length;
  const parked = fms.filter(
    (fm) => todoFileStatus(fm && fm.status, 'pending') === 'parked'
  ).length;
  const unparked = total - parked;
  const open = fms.filter((fm) =>
    triageActionable(todoTriage(fm, 'pending', host))
  ).length;
  return { total, parked, unparked, open };
}

/**
 * A count rendered as a decoration badge.
 *
 * VS Code truncates a badge at 2 characters without saying so, which would
 * turn 104 into "10" — a wrong answer rather than a missing one. Anything
 * wider becomes a glyph meaning "more than fits"; the exact number is only
 * ever promised by the tooltip.
 */
function countBadge(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n <= 99 ? String(n) : '⋯';
}

module.exports = {
  ORDER,
  UPGRADEABLE,
  SETTLED,
  normalizePhaseNum,
  comparePhaseNum,
  DEFAULT_DISCUSSED_MARKERS,
  DEFAULT_PLANNED_MARKERS,
  DEFAULT_SUMMARY_MARKERS,
  strongStatus,
  weakStatus,
  statusWord,
  artifactStatus,
  reviewStatus,
  reviewCycleStatus,
  ARTIFACT_STATUS,
  ARTIFACT_KINDS,
  REVIEW_CYCLE_KIND,
  artifactKind,
  resolveArtifactStatus,
  folderArtifactStatuses,
  isPhaseDeclaration,
  isPlanFileLine,
  parseRoadmap,
  parseFrontmatter,
  parseActivePhase,
  parseActivePlan,
  phaseNumberForPath,
  phaseNumberFromSegment,
  planKeyFromFileName,
  matchesMarkers,
  classifyFolder,
  classifyPlans,
  applyFolderState,
  isStartedByFiles,
  applyStarted,
  rollup,
  buildPhaseMap,
  todoStatus,
  todoFileStatus,
  todoTriage,
  tallyTodos,
  countBadge,
  HOST_PLATFORMS,
  TRIAGE_STOOD_DOWN_COLORS,
  triageActionable,
};
