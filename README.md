# GSD Phase Status

Colour-codes your GSD phase folders in the VS Code Explorer, reading straight from
`.planning/ROADMAP.md` and `.planning/STATE.md`. No extra state file, no hooks —
it just reads what GSD already writes.

```
▶ .planning
  ▶ phases
    ✓ 01-project-foundation      green    complete
    ✓ 02-data-ingestion          green    complete
    ▶ 03-transform-pipeline      yellow   executing — active_phase in STATE.md
    ◑ 04-reporting-ui            blue     planned — PLAN.md written
    ◔ 05-deployment              orange   discussed — research only
    ○ 06-handover                dim      pending — folder empty
```

The six states follow GSD's own sequence:

```
pending  →  discussed  →  planned  →  in progress  →  complete
   ○           ◔             ◑            ▶              ✓
  dim        orange         blue        yellow          green
                                    ( ! red = blocked )
```

A status bar item on the left shows `GSD 2/5 · phase 3`. Hover it for the full
phase list; click it to force a refresh.

## Install

No build step — it's plain JavaScript.

**macOS / Linux**

```bash
cp -r gsd-phase-status ~/.vscode/extensions/
```

**Windows (PowerShell)**

```powershell
Copy-Item -Recurse gsd-phase-status "$env:USERPROFILE\.vscode\extensions\"
```

Then reload VS Code: `Cmd/Ctrl+Shift+P` → **Developer: Reload Window**.

For Cursor or Windsurf, use `~/.cursor/extensions/` or `~/.windsurf/extensions/`
instead.

## Requirements

Explorer decorations must be on (they are by default):

```jsonc
"explorer.decorations.colors": true,
"explorer.decorations.badges": true
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `gsdPhaseStatus.planningDir` | `.planning` | Where the GSD planning tree lives |
| `gsdPhaseStatus.showStatusBar` | `true` | Show the phase counter in the status bar |
| `gsdPhaseStatus.showTodoCounts` | `true` | Badge the `todos/` folders with how many todos are in them |
| `gsdPhaseStatus.discussedMarkers` | `["*"]` | Files marking a phase **discussed** (orange). `*` = any file |
| `gsdPhaseStatus.plannedMarkers` | `["PLAN.md"]` | Files marking a phase **planned** (blue). Takes precedence |
| `gsdPhaseStatus.startedMarkers` | — | Deprecated pre-0.3 name for `discussedMarkers`; still honoured |

## How status is determined

For each phase found in `ROADMAP.md`, the parser looks at the declaring line and
the next 8 lines (stopping at the next phase), in this order of precedence:

1. **Task checkbox** — `- [x]` complete, `- [ ]` pending, `- [~]` in progress
2. **Explicit status field** — `Status: complete`, `**Status:** In Progress`
3. **Emoji** — ✅ complete, 🚧 in progress, ⛔ blocked, ⏸ parked, ⬜ pending
   (an emoji leading a status *field* is skipped, so `**Status:** ⛔ PARKED`
   reads as parked rather than blocked — the word is more specific than ⛔)
4. **Bare keywords** — only used if none of the above matched, since a title like
   "Phase 5: Complete the onboarding flow" would otherwise read as complete

`STATE.md` is then applied on top: whatever `active_phase` points at is forced to
**in progress**, unless the roadmap already marked it complete, blocked or
parked.

`stopped_at:` is read for that phase number too, but a record of an *outcome* is
not a record of live work: GSD conventionally opens the field with the result, so
`stopped_at: "PHASE 23.1 COMPLETE (2026-08-18). 5/5 plans."` names the phase that
just **finished**. Taking it as the active phase paints a finished phase yellow
*and* clears `weakOnly`, which locks out the folder evidence that would have
corrected it. A completion word attached to the phase makes the field fall
through to the body's `Current focus:` line instead. A finished **plan**
(`stopped_at: Completed 34-02-PLAN.md`) still leaves its phase live.

Finally the phase folders themselves are scanned, and a phase is upgraded to
**planned** or **discussed** based on what is inside — but only if the roadmap
still calls it pending or gives no status at all. Complete, blocked, parked and
in-progress always survive, so the filesystem can only ever promote a phase,
never demote one.

This fills the gap in the GSD flow where `/gsd:discuss-phase` and
`/gsd:plan-phase` have produced artefacts but ROADMAP.md has not moved off
pending yet:

| Folder contents | Status | Colour |
|---|---|---|
| empty | pending | dim |
| research/notes, no plan | discussed | orange |
| contains `PLAN.md` | planned | blue |

`plannedMarkers` is checked first, since a phase that has been planned was
necessarily discussed too.

```jsonc
// defaults: any file means discussed, PLAN.md means planned
"gsdPhaseStatus.discussedMarkers": ["*"],
"gsdPhaseStatus.plannedMarkers": ["PLAN.md"]

// stricter: only go orange once research has actually been written
"gsdPhaseStatus.discussedMarkers": ["research.md", "DISCUSSION.md"],
"gsdPhaseStatus.plannedMarkers": ["PLAN.md"]
```

Matching is case-insensitive, so `PLAN.md` and `plan.md` both hit. A phase folder
present on disk but missing from ROADMAP.md is added to the list rather than
ignored.

Once a phase has waves, its folder rolls up **both** tiers of evidence inside it:
the `PLAN`/`SUMMARY` pairs *and* the phase's own gate artifacts (see [Phase
artifacts](#phase-artifacts)). Waves alone are not enough — phase 34.9 had 33 of
33 summaries on disk and painted green while its `REVIEW.md` and `REVIEW-FIX.md`
sat yellow inside it, which is the one thing a container colour must never do:
read greener than what it contains. A gate artifact can therefore only ever hold
a folder **back** — blocked and 🧍 outrank in-progress, an unfinished gate keeps
it off green, and a *parked* gate is out of the running rather than part of it,
so it holds nothing back.

Phase numbers are taken from the leading number in the folder name under
`phases/`, so `03-auth/`, `phase-3-auth/`, and `phase-3.md` all resolve to 3.
Hierarchical numbers are supported to any depth and kept distinct: `34.1-auth/`
is phase 34.1, and `4.4.1-cache/` is phase 4.4.1 (not folded into 4.4). Leading
zeros are stripped per segment, so `04.01` and `4.1` are the same phase.

## If the badges look wrong

Run the parser against your real roadmap to see what it detected:

```bash
node -e "console.log(require('./parse').parseRoadmap(require('fs').readFileSync('.planning/ROADMAP.md','utf8')))"
```

The status vocabulary lives in `strongStatus()` and `weakStatus()` in `parse.js` —
both are short and easy to extend. `node test-parse.js` runs the test suite.

## Colours

Built-in theme colour IDs, so they follow your theme:

| Status | Badge | Colour ID |
|---|---|---|
| Complete | ✓ | `charts.green` |
| In progress | ▶ | `charts.yellow` |
| Planned | ◑ | `charts.blue` |
| Discussed | ◔ | `charts.orange` |
| Blocked | ! | `charts.red` |
| Parked / cancelled | ⊘ | `charts.purple` |
| Superseded (permanent, replaced by a successor) | ⇢ | `disabledForeground` |
| Needs a human | 🧍 | `charts.orange` |
| Pending | ○ | `descriptionForeground` |

Change them in the `STYLE` map at the top of `extension.js`.

## Phase artifacts

Tier-1 artifacts inside a phase folder get their own badge, read from their
frontmatter `status:` — a controlled vocabulary GSD writes, so unlike ROADMAP
prose the value is taken exactly:

`VALIDATION.md` · `VERIFICATION.md` · `UAT.md` · `HUMAN-UAT.md` · `SECURITY.md` ·
`UI-SPEC.md` · `REVIEW.md` · `REVIEW-FIX.md` · `REVIEW-CYCLE`

Done values are `approved`, `passed`, `verified`, `secured`, `validated`,
`audited`, `all_fixed`, `complete`. `partial`, `testing` and `gaps_found` read as
in progress; `draft` as pending; `human_needed` gets the 🧍 badge, which is the
one worth watching — it is the pile of gates waiting on **you** specifically.

A value nobody has used yet stays uncoloured on purpose: a missing badge is a
question, a wrong badge is an answer.

**`REVIEW.md` is derived, not read.** Its `status: issues_found` records what the
review *found* and is never rewritten when the fixes land, so it is paired with
its `REVIEW-FIX.md` sibling the way `PLAN` pairs with `SUMMARY`. With no fix pass
on disk, a non-zero `findings.critical` reads as blocked and anything else as in
progress.

**A cycle review is derived too, but from itself.** A review round after the
first is a separate document, named `34.2-REVIEW-GAP-CYCLE-1.md` or
`34.9-REVIEW-CYCLE2.md` — neither ends in `-REVIEW.md`, so before v0.8.0 the
suffix scan matched nothing and eight of them carried no badge and fed nothing
into the folder rollup. They are now matched by pattern (`-REVIEW-CYCLE<n>`,
`-REVIEW-GAP-CYCLE-<n>`, any separator, any case).

A cycle review has no `-FIX` sibling of its own, and it must **not** borrow the
folder's: both fix ledgers in this tree scope themselves to their round-1 review
and disclaim the cycles by name, so inheriting `partial` from them would
attribute a status their own authors refused to give. Where the disposition
really lives differs per cycle — `PORTED-CHANNELS.md` §7 for one phase,
`deferred-items.md` tables for another — and neither file carries frontmatter, so
neither is reachable. Deriving it structurally is a guess and is already wrong:
34.2's cycle 4 is dispositioned by a *Gap cycle 5 reconciliation* section with no
cycle-5 file behind it.

So the cycle review **declares** it, in fields alongside the permanent `status:`:

```yaml
status: issues_found      # what the review FOUND. Never rewritten.
disposition: closed       # where those findings now stand. closed | partial | open
dispositioned_by: 34.2-PORTED-CHANNELS.md §7 "Gap cycle 5 reconciliation"
```

`closed` reads complete, `partial`/`open` read in progress — the existing
artifact vocabulary, unextended. With no `disposition:` at all it falls back to
the same rule `REVIEW.md` uses with no fix pass: a non-zero `findings.critical`
reads blocked, anything else in progress. Never uncoloured, so a cycle nobody has
dispositioned is visible rather than absent.

`-REVIEW.iter2.md` and `-REVIEW.partA.md` (phase 34.13) are deliberately **not**
matched. They pair with `-REVIEW-FIX2.md` / `-REVIEW-FIX3.md` siblings that are
equally unrecognised, so badging the reviews alone would assert unaddressed
Criticals that the fix passes may already discharge.

Files with no frontmatter at all — `CONTEXT.md`, `RESEARCH.md`, `PATTERNS.md`,
`DISCUSSION-LOG.md`, `deferred-items.md`, `PORTED-CHANNELS.md` — are left white
deliberately. They are inputs, not gates: they are done the moment they exist, so
a badge would only dilute the ones that mean something.

Frontmatter is cached on mtime+size, so an unrelated write does not re-read the
tree — a scan of a folder whose artifacts have not moved costs one stat per file
and no reads at all. The same cache serves the on-demand badge for a file the
Explorer is showing and the folder rollup that has to see every gate.

## Todo counts

`.planning/todos/pending` and `.planning/todos/completed` are badged with how
many `.md` files are in them, and `.planning/todos` itself is badged with the
number **actionable** — the ones you could actually pick up on the machine
VS Code is running on right now. Hover any of the three for the breakdown.

A todo is actionable when it is none of: parked, `ready: blocked` (stood down,
nothing is wrong and nobody is waiting on it), or tagged with a `platform:`
naming an OS other than this one. `platform: any`, a missing `platform:`, and
any value that isn't `macos`/`windows`/`linux` are actionable everywhere.
`pending/` still shows the raw file count, badge and colour unchanged — only
the parent `todos/` row, the status bar, and the tooltips narrowed to
actionable. The host comes from `process.platform`, read once in
`extension.js` and passed into the parser as an argument, so the exact same
`.planning/todos` tree reads a different number on a different machine — that
is the point, not a bug.

| Folder | Badge | Colour |
|---|---|---|
| `todos/` | actionable todos, or ✓ when there are none | orange / green |
| `todos/pending/` | files in the folder, or ✓ when empty | orange / green |
| `todos/completed/` | files in the folder | green |

Individual todo files are coloured with the same `STYLE` scheme as everything
else, so a parked todo is purple where it sits:

| Todo | Badge | Colour |
|---|---|---|
| In `completed/` | ✓ | green |
| In `pending/` | ○ | grey |
| `status:` says parked/deferred/superseded, either folder | ⊘ | purple |
| `status:` says in-progress, in `pending/` | ▶ | yellow |

**The folder decides done-ness, not the `status:` line.** A todo is closed by
*moving* the file, and the line inside it rots: 6 of the 68 files in
`completed/` still declare `status: OPEN`, and 26 have no status line at all.
Trusting frontmatter over location would report six finished todos as
outstanding work. Frontmatter is read only for the two things a folder cannot
express — that an item was stood down, or that a pending one is in flight.
Where the two disagree the folder wins, but the tooltip quotes the stale line
back at you (`Complete — its status: line still reads "OPEN"`), because that
disagreement is worth finding rather than silently resolving.

Note that `open` means something different here than in a REVIEW, where it
signals findings still being worked. 25 pending todos say `OPEN` and none of
them are in progress, so `todoStatus()` reads the word as plain pending — the
same reason `reviewStatus()` is its own reader.

Two things the folder badges do NOT do, both on purpose:

- **`pending/` counts files, not open work.** A parked todo is still a file in
  the folder, and a badge that disagreed with the row count underneath it would
  read as a bug — the purple ⊘ on the row itself is what tells you it is parked.
  The open/parked split is in the tooltip and the status bar.
- **A count over 99 shows as `⋯`.** VS Code truncates a badge at two characters
  silently, so 104 would render as "10" — a wrong number rather than a missing
  one. The exact figure is always in the tooltip.

The status bar gains a `☐ n` segment counting **actionable** todos (parked,
`ready: blocked`, and wrong-platform ones excluded — nobody here can act on
them), and the whole tooltip gets a summary line. Only pending todos are read
in bulk; a completed one is opened only when the Explorer actually shows its
row.

## Known limits

- VS Code caps Explorer badges at **2 characters**, so it's a glyph, not a label.
- Only the first workspace folder is scanned.
- The Explorer shows one decoration per row; if another extension also decorates
  these files, VS Code picks one.
