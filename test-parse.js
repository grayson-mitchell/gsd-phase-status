'use strict';
const p = require('./parse');
const fs = require('fs');
const path = require('path');

let fails = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.log(`FAIL ${label}\n  got      ${a}\n  expected ${e}`); fails++; }
  else console.log(`ok   ${label}`);
}

// --- Format A: heading + Status line (GSD-ish) ---
const A = `
# Roadmap

## Phase 1: Foundation
**Status:** Complete
Set up the repo and CI.

## Phase 2: Authentication
**Status:** In Progress
Login, sessions, password reset.

## Phase 3: Billing
**Status:** Pending
Stripe integration.
`;
{
  const m = p.parseRoadmap(A);
  eq([...m.keys()], ['1', '2', '3'], 'A: phase numbers');
  eq(m.get('1').status, 'complete', 'A: phase 1 complete');
  eq(m.get('2').status, 'inprogress', 'A: phase 2 in progress');
  eq(m.get('3').status, 'pending', 'A: phase 3 pending');
  eq(m.get('2').title, 'Authentication', 'A: title extraction');
}

// --- Format B: checkbox list ---
const B = `
- [x] Phase 1 — Foundation
- [x] Phase 2 — Auth
- [ ] Phase 3 — Billing
- [ ] Phase 4 — Reporting
`;
{
  const m = p.parseRoadmap(B);
  eq(m.get('1').status, 'complete', 'B: checked = complete');
  eq(m.get('3').status, 'pending', 'B: unchecked = pending');
  eq(m.get('2').title, 'Auth', 'B: title from checkbox line');
}

// --- Format C: emoji status table ---
const C = `
| Phase | Name | Status |
|---|---|---|
| Phase 1 | Foundation | ✅ |
| Phase 2 | Auth | 🚧 |
| Phase 3 | Billing | ⬜ |
| Phase 4 | Reporting | ⛔ blocked on vendor API |
`;
{
  const m = p.parseRoadmap(C);
  eq(m.get('1').status, 'complete', 'C: emoji complete');
  eq(m.get('2').status, 'inprogress', 'C: emoji in progress');
  eq(m.get('3').status, 'pending', 'C: emoji pending');
  eq(m.get('4').status, 'blocked', 'C: emoji blocked');
}

// --- False positive guard: "Complete" as a verb in the title ---
const D = `
## Phase 5: Complete the onboarding flow
**Status:** Pending
`;
{
  const m = p.parseRoadmap(D);
  eq(m.get('5').status, 'pending', 'D: explicit Status beats keyword in title');
}

// --- Lookahead must not bleed into the next phase ---
const E = `
## Phase 1: Foundation
## Phase 2: Auth
**Status:** Complete
`;
{
  const m = p.parseRoadmap(E);
  eq(m.get('1').status, 'unknown', 'E: no bleed into previous phase');
  eq(m.get('2').status, 'complete', 'E: next phase reads its own status');
}

// --- STATE.md frontmatter ---
eq(p.parseActivePhase('---\nactive_phase: 3\nnext_action: execute\n---\n# State\n'), '3', 'STATE frontmatter');
eq(p.parseActivePhase('---\nactive_phase: "07"\n---\n'), '7', 'STATE quoted + zero pad');
eq(p.parseActivePhase('# State\n\nCurrent phase: 4\n'), '4', 'STATE body fallback');
eq(p.parseActivePhase('# State\n\nnothing here\n'), null, 'STATE absent');

// --- path -> phase number ---
eq(p.phaseNumberForPath('.planning/phases/03-auth/PLAN.md'), '3', 'path: zero-padded dir');
eq(p.phaseNumberForPath('.planning/phases/phase-12-billing/NOTES.md'), '12', 'path: phase-N dir');
eq(p.phaseNumberForPath('.planning/phases/phase-2.md'), '2', 'path: flat file');
eq(p.phaseNumberForPath('.planning\\phases\\03-auth\\PLAN.md'), '3', 'path: windows separators');
eq(p.phaseNumberForPath('src/app/phases/03-auth.ts'), null, 'path: outside .planning');
eq(p.phaseNumberForPath('.planning/ROADMAP.md'), null, 'path: roadmap itself');

// --- rollup ---
eq(p.rollup(['complete', 'complete']), 'complete', 'rollup: all complete');
eq(p.rollup(['complete', 'pending']), 'inprogress', 'rollup: partial');
eq(p.rollup(['pending', 'pending']), 'pending', 'rollup: none started');
eq(p.rollup(['complete', 'blocked']), 'blocked', 'rollup: blocked wins');

// --- combined build ---
{
  const { phases, active } = p.buildPhaseMap(A, '---\nactive_phase: 3\n---\n');
  eq(active, '3', 'build: active phase');
  eq(phases.get('3').status, 'inprogress', 'build: STATE overrides pending');
  eq(phases.get('1').status, 'complete', 'build: complete survives override');
}

// --- folder classification: discussed vs planned ---
const M = { discussedMarkers: ['*'], plannedMarkers: ['PLAN.md'] };
eq(p.classifyFolder([], M), null, 'classify: empty folder -> null');
eq(p.classifyFolder(['research.md'], M), 'discussed', 'classify: research only -> discussed');
eq(p.classifyFolder(['PLAN.md'], M), 'planned', 'classify: plan -> planned');
eq(p.classifyFolder(['research.md', 'PLAN.md'], M), 'planned', 'classify: planned beats discussed');
eq(p.classifyFolder(['plan.MD'], M), 'planned', 'classify: plan match is case-insensitive');
eq(p.classifyFolder(['NOTES.md'], M), 'discussed', 'classify: any file counts as discussed by default');

const STRICT = { discussedMarkers: ['research.md'], plannedMarkers: ['PLAN.md'] };
eq(p.classifyFolder(['NOTES.md'], STRICT), null, 'classify: strict discussed marker not matched');
eq(p.classifyFolder(['research.md'], STRICT), 'discussed', 'classify: strict discussed marker matched');
eq(p.classifyFolder(['NOTES.md', 'PLAN.md'], STRICT), 'planned', 'classify: planned regardless of discussed markers');

eq(p.matchesMarkers(['a.md'], ['*']), true, 'markers: wildcard');
eq(p.matchesMarkers([], ['*']), false, 'markers: no files');
eq(p.matchesMarkers(['a.md'], []), false, 'markers: empty marker list');

eq(p.phaseNumberFromSegment('03-auth'), '3', 'segment: zero padded');
eq(p.phaseNumberFromSegment('phase-12-billing'), '12', 'segment: phase prefix');
eq(p.phaseNumberFromSegment('research'), null, 'segment: no number');

// --- applyFolderState precedence ---
const FIVE = `
## Phase 1: Foundation
**Status:** Complete
## Phase 2: Ingestion
**Status:** Complete
## Phase 3: Transform
**Status:** Pending
## Phase 4: Reporting
**Status:** Pending
## Phase 5: Deploy
**Status:** Pending
`;
{
  const { phases } = p.buildPhaseMap(FIVE, '---\nactive_phase: 3\n---\n');
  p.applyFolderState(phases, new Map([['1','planned'],['3','planned'],['4','planned'],['5','discussed']]));
  eq(phases.get('1').status, 'complete', 'apply: does not downgrade complete');
  eq(phases.get('3').status, 'inprogress', 'apply: does not downgrade in-progress');
  eq(phases.get('4').status, 'planned', 'apply: pending -> planned');
  eq(phases.get('5').status, 'discussed', 'apply: pending -> discussed');
}
{
  const phases = p.parseRoadmap('## Phase 1: X\n**Status:** Blocked\n');
  p.applyFolderState(phases, new Map([['1', 'planned']]));
  eq(phases.get('1').status, 'blocked', 'apply: does not downgrade blocked');
}
{
  const phases = new Map();
  p.applyFolderState(phases, new Map([['9', 'discussed']]));
  eq(phases.get('9').status, 'discussed', 'apply: adds folder missing from roadmap');
}
{
  const phases = p.parseRoadmap('## Phase 7: Mystery\nno status here\n');
  eq(phases.get('7').status, 'unknown', 'apply: unknown before');
  p.applyFolderState(phases, new Map([['7', 'planned']]));
  eq(phases.get('7').status, 'planned', 'apply: unknown -> planned');
}
// legacy Set input still works
{
  const phases = p.parseRoadmap('## Phase 2: Y\n**Status:** Pending\n');
  p.applyStarted(phases, new Set(['2']));
  eq(phases.get('2').status, 'discussed', 'apply: legacy Set input maps to discussed');
}

// --- decimal sub-phases (34.1, 34.2) must stay distinct, not collapse to 34 ---
const DOT = `
### Phase 34.1: Auth setup
**Status:** Complete

### Phase 34.2: Auth UI
**Status:** Pending
`;
{
  const m = p.parseRoadmap(DOT);
  eq([...m.keys()], ['34.1', '34.2'], 'dot: sub-phases kept distinct');
  eq(m.get('34.1').status, 'complete', 'dot: 34.1 complete');
  eq(m.get('34.2').status, 'pending', 'dot: 34.2 not started (was inheriting 34.1 green)');
  eq(m.get('34.1').title, 'Auth setup', 'dot: title strips the decimal number');
  eq(m.get('34.2').title, 'Auth UI', 'dot: sibling title clean');
}
eq(p.phaseNumberFromSegment('34.1-auth'), '34.1', 'dot: segment keeps decimal');
eq(p.phaseNumberFromSegment('34.2'), '34.2', 'dot: bare decimal segment');
eq(p.phaseNumberForPath('.planning/phases/34.2-auth-ui/PLAN.md'), '34.2', 'dot: path keeps decimal');
eq(p.phaseNumberFromSegment('phase-2.md'), '2', 'dot: flat .md file not read as 2.md');
eq(p.parseActivePhase('---\nactive_phase: "34.1"\n---\n'), '34.1', 'dot: STATE active decimal phase');
eq(p.planKeyFromFileName('34.1-02-PLAN.md'), { phase: '34.1', plan: 2 }, 'dot: plan file under decimal phase');

// --- three-level phases (4.4.1) must work like 34.1 did, not collapse to 4.4 ---
const DEEP = `
### Phase 4.4: Data layer
**Status:** Complete

### Phase 4.4.1: Cache warmup
**Status:** Pending
`;
{
  const m = p.parseRoadmap(DEEP);
  eq([...m.keys()], ['4.4', '4.4.1'], 'deep: 4.4 and 4.4.1 stay distinct');
  eq(m.get('4.4').status, 'complete', 'deep: parent 4.4 complete');
  eq(m.get('4.4.1').status, 'pending', 'deep: child 4.4.1 not collapsed into 4.4');
  eq(m.get('4.4.1').title, 'Cache warmup', 'deep: three-level title strips the number');
}
eq(p.phaseNumberFromSegment('4.4.1-cache'), '4.4.1', 'deep: segment keeps all levels');
eq(p.phaseNumberFromSegment('04.04.01-cache'), '4.4.1', 'deep: strips zero padding per segment');
eq(p.phaseNumberForPath('.planning/phases/4.4.1-cache/PLAN.md'), '4.4.1', 'deep: path keeps all levels');
eq(p.parseActivePhase('---\nactive_phase: "4.4.1"\n---\n'), '4.4.1', 'deep: STATE active three-level phase');
// A phase-level "4.4.1-PLAN.md" is NOT a two-number wave file: no "-NN" suffix.
eq(p.planKeyFromFileName('4.4.1-PLAN.md'), null, 'deep: phase-level PLAN is not a wave file');
eq(p.planKeyFromFileName('4.4.1-02-PLAN.md'), { phase: '4.4.1', plan: 2 }, 'deep: wave file under three-level phase');

// --- lettered split/parallel plans (34.8-08a .. 08c) stay distinct ---
eq(p.planKeyFromFileName('34.8-08a-PLAN.md'), { phase: '34.8', plan: '8a' }, 'split: 08a wave -> plan 8a');
eq(p.planKeyFromFileName('34.8-08b-PLAN.md'), { phase: '34.8', plan: '8b' }, 'split: 08b wave -> plan 8b');
eq(p.planKeyFromFileName('34.8-08-PLAN.md'), { phase: '34.8', plan: 8 }, 'split: unlettered wave stays numeric');
eq(p.planKeyFromFileName('34.8-08a-SUMMARY.md'), { phase: '34.8', plan: '8a' }, 'split: SUMMARY pairs to same lettered plan');
{
  const plans = p.classifyPlans(['34.8-08a-PLAN.md', '34.8-08b-PLAN.md', '34.8-08c-PLAN.md', '34.8-08a-SUMMARY.md']);
  eq([...plans.keys()], ['8a', '8b', '8c'], 'split: three lettered plans kept distinct');
  eq(plans.get('8a').status, 'complete', 'split: 08a complete via its SUMMARY');
  eq(plans.get('8b').status, 'planned', 'split: 08b planned, no summary');
}

// --- normalize + compare helpers ---
eq(p.normalizePhaseNum('04.01'), '4.1', 'normalize: strips leading zeros per segment');
eq(p.normalizePhaseNum('4.4.1'), '4.4.1', 'normalize: keeps three levels');
eq(p.normalizePhaseNum(34.1), '34.1', 'normalize: accepts a number');
eq(p.normalizePhaseNum('abc'), null, 'normalize: rejects non-numeric');
eq(['34', '4.4.1', '4.4', '4', '4.10', '4.2'].sort(p.comparePhaseNum),
   ['4', '4.2', '4.4', '4.4.1', '4.10', '34'], 'compare: hierarchical numeric order');

// --- rollup with six states ---
eq(p.rollup(['discussed', 'pending']), 'discussed', 'rollup: discussed beats pending');
eq(p.rollup(['planned', 'discussed']), 'planned', 'rollup: planned beats discussed');
eq(p.rollup(['planned', 'complete']), 'inprogress', 'rollup: any complete implies progress');
eq(p.rollup(['planned', 'blocked']), 'blocked', 'rollup: blocked still wins');
eq(p.rollup(['planned', 'inprogress']), 'inprogress', 'rollup: inprogress beats planned');
eq(p.rollup(['pending', 'pending']), 'pending', 'rollup: still pending');
eq(p.rollup(['complete', 'complete']), 'complete', 'rollup: all complete');

// --- declaration vs mere mention ---
eq(p.isPhaseDeclaration('### Phase 22: Save Sync'), true, 'decl: heading');
eq(p.isPhaseDeclaration('- [x] **Phase 24: bridge**'), true, 'decl: checkbox + bold');
eq(p.isPhaseDeclaration('**Status:** PARKED — superseded by Phase 24. See PARKED.md'), false,
   'decl: cross-reference in a status line is NOT a declaration');
eq(p.isPhaseDeclaration('planned 2026-08-13 at `/gsd-plan-phase 34.9 --gaps`'), false,
   'decl: slash-command mention is NOT a declaration');

eq(p.isPlanFileLine('- [x] 34.9-23-PLAN.md — census by predicate'), true, 'planline: ticked plan entry');
eq(p.isPlanFileLine('### Phase 34.9: onedir repackaging'), false, 'planline: heading is not a plan entry');

// A parked phase whose Status line names its superseder. The cross-reference
// must not truncate the lookahead before the ⛔ is read.
{
  const R = `
### Phase 22: Save Sync
**Status:** ⛔ PARKED 2026-07-21 — superseded by Phase 24. See PARKED.md.
**Plans:** 8 written, 0 executed.

**Why:** Phase 22 existed to group games into families; that work is done differently now.
`;
  eq(p.parseRoadmap(R).get('22').status, 'parked', 'parked: reads its own ⛔ past the Phase 24 mention');
}

// --- parked / deferred / cancelled is its own outcome, not "blocked" ---
// Nobody is stuck and nobody is waiting: the phase was stood down on purpose.
eq(p.strongStatus('**Status:** ⛔ PARKED 2026-07-21 — superseded by Phase 24.'), 'parked',
  'parked: the WORD wins over a leading ⛔');
eq(p.strongStatus('**Status:** ✅ COMPLETE 2026-08-16'), 'complete',
  'parked: skipping the emoji still reads the word after ✅');
eq(p.strongStatus('status: cancelled'), 'parked', 'parked: cancelled');
eq(p.strongStatus('status: deferred to v0.9'), 'parked', 'parked: deferred');
eq(p.strongStatus('- Status — superseded by Phase 24'), 'parked', 'parked: superseded');
eq(p.strongStatus('**Status:** ⛔ BLOCKED on the depot fix'), 'blocked',
  'parked: a genuinely blocked phase is still blocked');
eq(p.strongStatus('**Status:** ⛔'), 'blocked', 'parked: a bare ⛔ keeps its old meaning');
eq(p.weakStatus('Parked (superseded by Phase 24), 8 plans written'), 'parked',
  'parked: prose "parked" outranks the "written" that follows it');
eq(p.weakStatus('Cancelled — the eight plans were complete but never executed'), 'parked',
  'parked: the reason a phase stopped does not make it complete');
eq(p.weakStatus('| 22. Save Sync | 0/8 | Parked (superseded by Phase 24) | - |'), 'parked',
  'parked: a summary-table cell');
// The word must lead its clause. Phase 34.6 is upcoming work whose goal happens
// to describe the channels it inherited — a bare keyword search paints it purple.
eq(p.weakStatus('all three deferred rather than dropped because Phase 35 requires it'), null,
  'parked: prose ABOUT deferral is not a deferred phase');
eq(p.weakStatus('16 channels the previous slice superseded are ported here'), null,
  'parked: mid-sentence "superseded" does not park this phase');

// A parked declaration is settled: STATE.md citing the phase must not repaint
// it as live work, and folder evidence must not upgrade it either.
{
  const R = `
### Phase 22: Save Sync
**Status:** ⛔ PARKED 2026-07-21 — superseded by Phase 24.
`;
  const built = p.buildPhaseMap(R, '---\nstopped_at: Phase 22 parked, see PARKED.md\n---\n');
  eq(built.phases.get('22').status, 'parked', 'parked: outranks STATE.md naming it active');
  p.applyFolderState(built.phases, new Map([['22', 'planned']]));
  eq(built.phases.get('22').status, 'parked', 'parked: 8 unexecuted plans do NOT reopen it');
}

// A parked child is out of the running, so it neither blocks a parent nor
// holds it back from reading as finished.
eq(p.rollup(['complete', 'parked']), 'complete', 'rollup: parked does not hold back a parent');
eq(p.rollup(['parked', 'parked']), 'parked', 'rollup: all parked');
eq(p.rollup(['parked', 'blocked']), 'blocked', 'rollup: a real blocker still wins');

// A ticked plan checkbox states that PLAN's status, never the phase's — even
// when the line names its own phase.
{
  const R = `
### Phase 34.9: onedir repackaging

**Gap cycle 4 — planned at \`/gsd-plan-phase 34.9 --gaps\`.** 5 plans in 4 waves.

- [x] 34.9-23-PLAN.md — census by predicate
- [x] 34.9-28-PLAN.md — sweep, leave \`/gsd-verify-work 34.9\` as the next step
`;
  const rec = p.parseRoadmap(R).get('34.9');
  eq(rec && rec.status !== 'complete', true, 'plan checkbox does not mark the phase complete');
}

// A bare keyword in prose is a guess: filesystem evidence overrides it.
{
  const R = `
### Phase 34.10: Navigation shell
A row of card tabs where the active tab is raised.
`;
  const phases = p.parseRoadmap(R);
  eq(phases.get('34.10').status, 'inprogress', 'weak: prose "active" still guesses inprogress');
  eq(phases.get('34.10').weakOnly, true, 'weak: flagged as a guess');
  p.applyFolderState(phases, new Map([['34.10', 'complete']]));
  eq(phases.get('34.10').status, 'complete', 'weak: filesystem evidence overrides the guess');
}

// A DECLARED status is authoritative and survives contrary folder state.
{
  const R = `
### Phase 7: Billing
**Status:** Complete
`;
  const phases = p.parseRoadmap(R);
  eq(phases.get('7').weakOnly, false, 'declared: not a guess');
  p.applyFolderState(phases, new Map([['7', 'planned']]));
  eq(phases.get('7').status, 'complete', 'declared: folder state does NOT override a declaration');
}

// STATE.md naming the live phase outranks a guessed "complete".
{
  const R = `
### Phase 34.9: onedir repackaging
All eight findings were swept and the census is complete.
`;
  const built = p.buildPhaseMap(R, '---\nstopped_at: Phase 34.9 gap cycle 4 planned\n---\n');
  eq(built.phases.get('34.9').status, 'inprogress', 'active phase outranks a guessed complete');
}

// A nested key must not be read as top-level. Real shape from
// 34.2-VERIFICATION.md: the file passed, and an override record buried in its
// own frontmatter carries a second `status:`.
{
  const fm = p.parseFrontmatter([
    '---',
    'phase: 34.2-tauri-ipc-re-plumb',
    'status: passed',
    'overrides_applied: 1',
    'override:',
    '  verdict: accepted-as-tracked-debt',
    '  gaps:',
    '    status: overridden',
    '---',
    '',
  ].join('\n'));
  eq(fm.status, 'passed', 'frontmatter: a nested status does NOT overwrite the top-level one');
  eq(fm.verdict, undefined, 'frontmatter: nested keys are not hoisted');
  eq(fm.overrides_applied, '1', 'frontmatter: top-level siblings still read');
}

// --- artifact frontmatter: a CONTROLLED vocabulary, unlike roadmap prose ---
// Every value below was observed in the real tree.
eq(p.artifactStatus('approved'), 'complete', 'artifact: approved (29 files)');
eq(p.artifactStatus('passed'), 'complete', 'artifact: passed (21 files)');
eq(p.artifactStatus('PASSED'), 'complete', 'artifact: case folded');
eq(p.artifactStatus('all_fixed'), 'complete', 'artifact: underscores folded to dashes');
eq(p.artifactStatus('verified'), 'complete', 'artifact: verified');
eq(p.artifactStatus('SECURED'), 'complete', 'artifact: secured');
eq(p.artifactStatus('human_needed'), 'humanneeded', 'artifact: human_needed is its own state');
eq(p.artifactStatus('partial'), 'inprogress', 'artifact: partial is started, NOT pending');
eq(p.artifactStatus('gaps_found'), 'inprogress', 'artifact: gaps_found is unfinished, not passed');
eq(p.artifactStatus('draft'), 'pending', 'artifact: draft');
eq(p.artifactStatus('failed'), 'blocked', 'artifact: failed');
eq(p.artifactStatus('deferred'), 'parked', 'artifact: shares the parked vocabulary');
eq(p.artifactStatus('resolved  # report redacted (b2eeb6cb)'), 'complete', 'artifact: trailing # comment cut');
eq(p.artifactStatus('complete (13/14 waves)'), 'complete', 'artifact: trailing prose cut');
// A word nobody has used yet must stay uncoloured: a missing badge is a
// question, a wrong badge is an answer.
eq(p.artifactStatus('frobnicated'), null, 'artifact: unknown vocabulary stays uncoloured');
eq(p.artifactStatus(''), null, 'artifact: empty');
eq(p.artifactStatus(undefined), null, 'artifact: absent');

// The roadmap reader must NOT inherit the artifact vocabulary — "passed" and
// "approved" are definitive in frontmatter and merely suggestive in prose.
eq(p.strongStatus('status: passed'), null, 'artifact: vocabulary did NOT leak into strongStatus');
eq(p.strongStatus('status: approved'), null, 'artifact: approved did not leak either');

// --- REVIEW.md is derived, not read ---
// Its own status records what the review FOUND and is never rewritten when the
// fixes land: 32 of 37 files still say issues_found.
// Real shape: `critical:` is nested under `findings:`, never top-level.
const rev = (status, critical) =>
  p.parseFrontmatter(`---\nstatus: ${status}\nfindings:\n  critical: ${critical}\n  warning: 3\n---\n`);
eq(p.reviewStatus(rev('issues_found', 0), 'all_fixed'), 'complete', 'review: the fix pass decides');
eq(p.reviewStatus(rev('issues_found', 2), 'all_fixed'), 'complete', 'review: fix pass outranks a critical count');
eq(p.reviewStatus(rev('issues_found', 1), 'partial'), 'inprogress', 'review: a partial fix pass');
eq(p.reviewStatus(rev('issues_found', 0), null), 'inprogress', 'review: findings, no fix pass');
eq(p.reviewStatus(rev('issues_found', 4), null), 'blocked', 'review: an UNADDRESSED critical, read from findings.critical');
eq(p.reviewStatus(rev('resolved', 1), null), 'complete', 'review: own status resolved still wins');
eq(p.reviewStatus(rev('issues_found', '0   # open; 1 found, CR-01 fixed in 77f094bfd'), null), 'inprogress',
  'review: a commented critical count parses to 0');
// A flat writer must keep working, and a review with no counts at all must not
// claim a critical it never reported.
eq(p.reviewStatus(p.parseFrontmatter('---\nstatus: issues_found\ncritical: 2\n---\n'), null), 'blocked',
  'review: a top-level critical is accepted too');
eq(p.reviewStatus(p.parseFrontmatter('---\nstatus: issues_found\n---\n'), null), 'inprogress',
  'review: no count at all is not a critical');

// Nested keys must be reachable WITHOUT clobbering their top-level namesakes.
{
  const fm = p.parseFrontmatter('---\nstatus: passed\nfindings:\n  critical: 4\noverride:\n  status: overridden\n---\n');
  eq(fm.status, 'passed', 'frontmatter: top-level status survives a nested one');
  eq(fm['findings.critical'], '4', 'frontmatter: nested value reachable by dotted path');
  eq(fm['override.status'], 'overridden', 'frontmatter: the nested status is kept, just not hoisted');
}

eq(p.rollup(['complete', 'humanneeded']), 'humanneeded', 'rollup: a human gate holds the parent');
eq(p.rollup(['humanneeded', 'blocked']), 'blocked', 'rollup: a real blocker still outranks it');

// --- stopped_at records an OUTCOME, and GSD opens the field with it ---
// "PHASE 23.1 COMPLETE ..." names the phase that just finished. Reading it as
// the live phase paints a finished phase yellow AND clears weakOnly, locking
// out the folder evidence that would have corrected it.
const at = (v) => `---\nstopped_at: "${v}"\n---\n`;
eq(p.parseActivePhase(at('PHASE 23.1 COMPLETE (2026-08-18). 5/5 plans across 4 waves.')), null,
  'active: a completion record is NOT the live phase');
eq(p.parseActivePhase(at('PHASE 34.15 COMPLETE 2026-08-16')), null, 'active: same, unparenthesised');
eq(p.parseActivePhase(at('Phase 7 is done')), null, 'active: "is done"');
// A PLAN completing does not finish its phase, so that phase is still live.
eq(p.parseActivePhase(at('Completed 34-02-PLAN.md')), '34', 'active: a finished PLAN leaves the phase live');
eq(p.parseActivePhase(at('Phase 34.9 gap cycle 4 planned')), '34.9', 'active: ordinary in-flight record');
eq(p.parseActivePhase(at('Phase 12 blocked on the completed Phase 11')), '12',
  'active: the outcome word must attach to THIS phase, not a cross-reference');
// Falling through to the body is the point: something else may be live.
eq(p.parseActivePhase(at('PHASE 23.1 COMPLETE.') + '\n**Current focus:** Phase 35 — cutover\n'), '35',
  'active: falls through to the body focus line');

// End to end: three sources agree a phase is done, and it must come out green.
{
  const R = '\n### Phase 23.1: Native LZMA depot decode (INSERTED)\nAll five waves are complete.\n';
  const built = p.buildPhaseMap(R, at('PHASE 23.1 COMPLETE (2026-08-18). 5/5 plans.'));
  p.applyFolderState(built.phases, new Map([['23.1', 'complete']]));
  eq(built.phases.get('23.1').status, 'complete',
    'active: roadmap + folder + stopped_at all say complete -> complete');
}


// --- artifact kinds ---
eq(p.artifactKind('34.9-REVIEW-FIX.md'), 'REVIEW-FIX.md', 'artifactKind: fix beats plain review');
eq(p.artifactKind('05-HUMAN-UAT.md'), 'HUMAN-UAT.md', 'artifactKind: human-uat beats uat');
eq(p.artifactKind('34.9-VERIFICATION.md'), 'VERIFICATION.md', 'artifactKind: verification');
eq(p.artifactKind('REVIEW.md'), 'REVIEW.md', 'artifactKind: bare name');
eq(p.artifactKind('34.9-RESEARCH.md'), null, 'artifactKind: research is not a gate');
eq(p.artifactKind('34.9-01-PLAN.md'), null, 'artifactKind: a plan is not a gate');

// --- folderArtifactStatuses ---
{
  // Phase 34.9 as it actually sits on disk: every wave summarised, but the
  // review's fix pass stopped at 5 of 6 findings.
  const s = p.folderArtifactStatuses({
    '34.9-REVIEW-FIX.md': { status: 'partial' },
    '34.9-REVIEW.md': { status: 'issues_found' },
    '34.9-SECURITY.md': { status: 'verified' },
    '34.9-VALIDATION.md': { status: 'approved' },
    '34.9-VERIFICATION.md': { status: 'passed' },
  });
  eq(s.filter((x) => x === 'inprogress').length, 2, 'artifacts: fix and its review both unfinished');
  eq(p.rollup(['complete', 'complete'].concat(s)), 'inprogress',
     'artifacts: an unfinished gate holds its folder back off green');
}
{
  // The REVIEW-FIX is resolved once for the folder, so a review anywhere in the
  // listing pairs with it — including one listed BEFORE it.
  const s = p.folderArtifactStatuses({
    '34-REVIEW.md': { status: 'issues_found', 'findings.critical': '3' },
    '34-REVIEW-FIX.md': { status: 'all-fixed' },
  });
  eq(s, ['complete', 'complete'], 'artifacts: fix pass resolves a review listed before it');
}
{
  // No fix pass and unaddressed criticals: the review is a blocker, and a
  // blocker outranks every finished wave beside it.
  const s = p.folderArtifactStatuses({ '34-REVIEW.md': { status: 'issues_found', 'findings.critical': '2' } });
  eq(s, ['blocked'], 'artifacts: unaddressed criticals block');
  eq(p.rollup(['complete'].concat(s)), 'blocked', 'artifacts: a blocking gate reddens its folder');
}
{
  // Unrecognised vocabulary is dropped rather than guessed at, so it cannot
  // drag a folder off green on the strength of a word nobody has mapped.
  eq(p.folderArtifactStatuses({ '34-UAT.md': { status: 'flurbled' } }), [],
     'artifacts: unknown vocabulary is dropped');
  eq(p.folderArtifactStatuses({ '34-CONTEXT.md': { status: 'draft' } }), [],
     'artifacts: non-gate files are ignored');
}
{
  // A parked gate is out of the running, not part of it.
  const s = p.folderArtifactStatuses({ '34.2-HUMAN-UAT.md': { status: 'superseded' } });
  eq(s, ['parked'], 'artifacts: parked vocabulary reads as parked');
  eq(p.rollup(['complete'].concat(s)), 'complete', 'artifacts: a parked gate does not hold a folder back');
}

// --- Cycle reviews: a review round after the first ---
// These were invisible before: `-REVIEW-GAP-CYCLE-1.md` ends in neither
// `-REVIEW.md` nor `-REVIEW-FIX.md`, so artifactKind() returned null, the file
// carried no badge, and folderArtifactStatuses() skipped it entirely.
eq(p.artifactKind('34.2-REVIEW-GAP-CYCLE-1.md'), 'REVIEW-CYCLE', 'cycle: 34.2 gap-cycle spelling');
eq(p.artifactKind('34.9-REVIEW-CYCLE2.md'), 'REVIEW-CYCLE', 'cycle: 34.9 no-separator spelling');
eq(p.artifactKind('34.2-REVIEW-GAP-CYCLE-14.md'), 'REVIEW-CYCLE', 'cycle: two-digit round');
eq(p.artifactKind('34.9-review-cycle3.md'), 'REVIEW-CYCLE', 'cycle: case-insensitive');

// The kind must be decided BEFORE the suffix scan and must not steal its files.
eq(p.artifactKind('34.2-REVIEW.md'), 'REVIEW.md', 'cycle: a plain review is untouched');
eq(p.artifactKind('34.2-REVIEW-FIX.md'), 'REVIEW-FIX.md', 'cycle: a fix pass is untouched');
// Out of scope on purpose — 34.13's iteration reviews pair with REVIEW-FIX2 /
// REVIEW-FIX3 siblings that are equally unrecognised, so badging one half would
// assert unaddressed Criticals the other half may already discharge.
eq(p.artifactKind('34.13-REVIEW.iter2.md'), null, 'cycle: iter form deliberately unmatched');
eq(p.artifactKind('34.13-REVIEW.partA.md'), null, 'cycle: part form deliberately unmatched');
// No number, no round.
eq(p.artifactKind('34.2-REVIEW-CYCLE.md'), null, 'cycle: needs a round number');

{
  const cyc = (disposition, critical) => {
    const fm = { status: 'issues_found' };
    if (disposition !== null) fm.disposition = disposition;
    if (critical !== undefined) fm['findings.critical'] = String(critical);
    return fm;
  };

  // A declared disposition decides, and `status: issues_found` — which is
  // permanent by design — never gets in its way.
  eq(p.reviewCycleStatus(cyc('closed', 3)), 'complete', 'cycle: declared closed outranks a critical count');
  eq(p.reviewCycleStatus(cyc('partial', 0)), 'inprogress', 'cycle: declared partial');
  eq(p.reviewCycleStatus(cyc('open', 0)), 'inprogress', 'cycle: declared open');

  // RED PROOF for the declaration: without the field the SAME frontmatter reads
  // differently, so the passing cases above are attributable to `disposition:`
  // and not to some other property of the fixture.
  eq(p.reviewCycleStatus(cyc(null, 3)), 'blocked', 'cycle: RED PROOF — undeclared with a critical reads blocked');
  eq(p.reviewCycleStatus(cyc(null, 0)), 'inprogress', 'cycle: undeclared without a critical reads in-progress');
  // Never uncoloured: an undispositioned cycle is visible, not absent.
  eq(p.reviewCycleStatus({ status: 'issues_found' }), 'inprogress', 'cycle: no findings block still colours');

  // Unmapped vocabulary falls through to the review rather than painting a
  // wrong colour — same rule the rest of the artifact reader follows.
  eq(p.reviewCycleStatus(cyc('flurbled', 3)), 'blocked', 'cycle: unknown disposition word defers to the review');
}

{
  // A cycle review must NOT borrow the folder's REVIEW-FIX status. Both fix
  // ledgers in the tree scope themselves to their round-1 review and disclaim
  // the cycles by name, so inheriting `partial` from them would attribute a
  // status their own authors refused to give.
  const s = p.folderArtifactStatuses({
    '34.2-REVIEW-FIX.md': { status: 'partial' },
    '34.2-REVIEW-GAP-CYCLE-3.md': { status: 'issues_found', disposition: 'closed' },
  });
  eq(s, ['inprogress', 'complete'], 'cycle: the fix pass does not reach the cycle review');

  // And it does now reach the folder rollup, which it could not do before.
  const blocking = p.folderArtifactStatuses({
    '34.9-REVIEW-CYCLE4.md': { status: 'issues_found', 'findings.critical': '1' },
  });
  eq(blocking, ['blocked'], 'cycle: an undispositioned cycle feeds the rollup');
  eq(p.rollup(['complete'].concat(blocking)), 'blocked', 'cycle: and can redden its folder');
}

{
  // Todo tallies. The real vocabulary in .planning/todos/pending is OPEN,
  // pending, PARKED and — for three files — nothing at all; only the parked
  // ones are stood down, and a missing status: line must not silently drop a
  // todo out of the count.
  // v0.11.0: tallyTodos takes frontmatter objects + a host, not pre-mapped
  // status words — and `open` is now derived from todoTriage's verdict, so a
  // 5-file fixture with uniform `ready: code` and no platform tag reproduces
  // today's "parked is the only exclusion" shape at any host.
  const fms5 = [
    { status: 'OPEN', ready: 'code' },
    { status: 'pending', ready: 'code' },
    { status: 'PARKED 2026-09-04 — superseded', ready: 'code' },
    null,
    { status: 'OPEN', ready: 'code' },
  ];
  eq(p.tallyTodos(fms5, 'macos'), { total: 5, parked: 1, unparked: 4, open: 4 }, 'todos: parked split out, statusless still counted (v0.11.0 shape)');
  eq(p.tallyTodos([], 'macos'), { total: 0, parked: 0, unparked: 0, open: 0 }, 'todos: an empty folder tallies to zero (v0.11.0 shape)');

  // The badge is capped at 2 characters by VS Code, so a 3-digit count has to
  // become a glyph rather than its own first two digits.
  eq(p.countBadge(0), '', 'badge: nothing to show');
  eq(p.countBadge(7), '7', 'badge: one digit');
  eq(p.countBadge(99), '99', 'badge: two digits, the widest that fits');
  eq(p.countBadge(100), '⋯', 'badge: three digits would truncate to a wrong number');
  eq(p.countBadge(1043), '⋯', 'badge: and stays a glyph however big it gets');
}

{
  // A todo's `open` is not a REVIEW's `open`. This is the whole reason
  // todoStatus exists, so pin both readings side by side.
  eq(p.artifactStatus('OPEN'), 'inprogress', 'todo: artifactStatus still reads open as in-progress');
  // statusWord is the one tokeniser both readers share, and the tooltip quotes
  // it verbatim, so it must not lowercase or otherwise tidy what the file says.
  eq(p.statusWord('OPEN'), 'OPEN', 'word: reported verbatim for quoting back');
  eq(p.statusWord('"PARKED 2026-09-04 — superseded"'), 'PARKED', 'word: quotes and trailing prose cut');
  eq(p.statusWord('resolved  # report redacted'), 'resolved', 'word: trailing comment cut');
  eq(p.statusWord('   '), null, 'word: nothing declared');
  eq(p.todoStatus('OPEN'), 'pending', 'todo: but a todo saying OPEN is merely pending');
  eq(p.todoStatus('pending'), 'pending', 'todo: pending');
  eq(p.todoStatus('"PARKED 2026-09-04 — superseded"'), 'parked', 'todo: parked survives quoting and trailing prose');
  eq(p.todoStatus('CLOSED'), 'complete', 'todo: closed');
  eq(p.todoStatus('in-progress'), 'inprogress', 'todo: a genuinely in-flight todo keeps its yellow');
  eq(p.todoStatus(null), null, 'todo: nothing declared');
  // `opened`/`open-question` must not trip the word-boundary shortcut into the
  // pending branch — only the bare word `open` is the todo idiom.
  eq(p.todoStatus('open-question'), null, 'todo: open-question is not the open idiom');

  // The FOLDER decides done-ness. Measured on the real tree: 6 of 68 files in
  // completed/ still say `status: OPEN`, so a status line that outranked the
  // folder would report six finished todos as open work.
  eq(p.todoFileStatus(null, 'pending'), 'pending', 'todo: no status in pending/ reads pending');
  eq(p.todoFileStatus(null, 'completed'), 'complete', 'todo: no status in completed/ reads complete');
  eq(p.todoFileStatus('OPEN', 'completed'), 'complete', 'todo: a STALE open line does not reopen a filed todo');
  eq(p.todoFileStatus('CLOSED', 'pending'), 'pending', 'todo: nor does a closed line file an unfiled one');
  eq(p.todoFileStatus('flurbled', 'pending'), 'pending', 'todo: unknown vocabulary defers to the folder');
  // The two things a folder cannot say.
  eq(p.todoFileStatus('PARKED — superseded', 'completed'), 'parked', 'todo: parked in completed/ is stood down, not finished');
  eq(p.todoFileStatus('PARKED — superseded', 'pending'), 'parked', 'todo: and parked in pending/ is not outstanding work');
  eq(p.todoFileStatus('in-progress', 'pending'), 'inprogress', 'todo: a pending todo being worked right now');
  eq(p.todoFileStatus('in-progress', 'completed'), 'complete', 'todo: but a filed one is done however it reads');
}

// --- todoTriage: severity+readiness badges on pending todos (v0.10.0, host-aware platform rung added v0.11.0) ---
{
  // One case per rung of the precedence ladder, in ladder order, each asserting
  // the WHOLE {badge, color, label} object rather than just the badge — a rung
  // that returns the right badge under the wrong colour is still wrong.

  // Rung 1: completed/ keeps today's green tick, whatever the triage keys say.
  eq(p.todoTriage({ severity: 'critical', ready: 'code', platform: 'any' }, 'completed'),
    { badge: '✓', color: 'charts.green', label: 'Complete' },
    'triage: rung 1 — completed/ still renders the green tick');

  // Rung 2: parked outranks readiness, in either folder.
  eq(p.todoTriage({ severity: 'critical', status: 'PARKED — superseded', ready: 'code' }, 'pending'),
    { badge: '1B', color: 'charts.purple', label: 'critical · parked' },
    'triage: rung 2 — parked outranks ready: code');

  // Rung 3: today's in-progress signal is preserved, not displaced.
  eq(p.todoTriage({ severity: 'major', status: 'in-progress', ready: 'code' }, 'pending'),
    { badge: '▶', color: 'charts.yellow', label: 'major · in progress' },
    'triage: rung 3 — in-progress keeps its yellow play glyph');

  // Rungs 4-5: platform beats readiness. "Not on this machine" dominates —
  // the rung fires when the frontmatter names a KNOWN, non-host OS, so these
  // now have to pass a host that mismatches to observe it (v0.11.0: this used
  // to be host-independent; see the host-aware block below for that change).
  eq(p.todoTriage({ severity: 'medium', platform: 'windows', ready: 'code' }, 'pending', 'macos'),
    { badge: '3W', color: 'charts.red', label: 'medium · Windows only — not this machine' },
    'triage: rung 4 — platform windows beats ready: code, at a mismatching host');
  eq(p.todoTriage({ severity: 'minor', platform: 'linux', ready: 'live-gate' }, 'pending', 'macos'),
    { badge: '4L', color: 'charts.red', label: 'minor · Linux only — not this machine' },
    'triage: rung 5 — platform linux beats ready: live-gate, at a mismatching host');

  // Rungs 6-9: the four readiness values.
  eq(p.todoTriage({ severity: 'minor', platform: 'any', ready: 'code' }, 'pending'),
    { badge: '4.', color: 'charts.green', label: 'minor · ready to pick up at the desk' },
    'triage: rung 6 — ready: code is desk-ready green');
  eq(p.todoTriage({ severity: 'major', platform: 'any', ready: 'live-gate' }, 'pending'),
    { badge: '2G', color: 'charts.blue', label: 'major · needs a live gate' },
    'triage: rung 7 — ready: live-gate');
  eq(p.todoTriage({ severity: 'medium', platform: 'any', ready: 'human' }, 'pending'),
    { badge: '3H', color: 'charts.orange', label: 'medium · needs a human' },
    'triage: rung 8 — ready: human');
  eq(p.todoTriage({ severity: 'critical', platform: 'any', ready: 'blocked' }, 'pending'),
    { badge: '1B', color: 'charts.purple', label: 'critical · blocked' },
    'triage: rung 9 — ready: blocked shares parked purple');

  // Rung 10: anything else.
  eq(p.todoTriage({ severity: 'minor', platform: 'any' }, 'pending'),
    { badge: '4?', color: 'descriptionForeground', label: 'minor · untriaged readiness' },
    'triage: rung 10 — a known severity with no ready: still reads untriaged');

  // AT HOST macos, `platform: macos` must NOT be treated as a platform
  // blocker — it falls through to the readiness rungs. Getting this wrong
  // would paint every Mac-only todo red as "not this machine" on the one
  // host it is actually meant for. (v0.11.0: this used to be true regardless
  // of host, because the rung was hardcoded to macOS; now it's true only when
  // the host actually IS macOS — see the host-aware block below.)
  eq(p.todoTriage({ severity: 'medium', platform: 'macos', ready: 'code' }, 'pending', 'macos'),
    { badge: '3.', color: 'charts.green', label: 'medium · ready to pick up at the desk' },
    'triage: platform macos at host macos is NOT a blocker — falls through to readiness');

  // Unrecognised values and untriaged files. `??` has to be unmistakable:
  // "nobody triaged this", not "something failed to render".
  eq(p.todoTriage({ severity: 'flurbled', platform: 'any', ready: 'code' }, 'pending'),
    { badge: '?.', color: 'charts.green', label: 'untriaged severity · ready to pick up at the desk' },
    'triage: garbage severity degrades to ? without losing readiness');
  eq(p.todoTriage({ severity: 'major', platform: 'any', ready: 'flurbled' }, 'pending'),
    { badge: '2?', color: 'descriptionForeground', label: 'major · untriaged readiness' },
    'triage: garbage ready degrades to ? without losing severity');
  eq(p.todoTriage({}, 'pending'),
    { badge: '??', color: 'descriptionForeground', label: 'untriaged severity · untriaged readiness' },
    'triage: a file with NO triage keys reads ??');
  eq(p.todoTriage(null, 'pending'),
    { badge: '??', color: 'descriptionForeground', label: 'untriaged severity · untriaged readiness' },
    'triage: unreadable frontmatter (null) reads ?? rather than throwing');

  // parseFrontmatter lowercases KEYS but not VALUES, so the mapper has to
  // lowercase them itself or `severity: Major` renders as untriaged.
  eq(p.todoTriage({ severity: 'Major', platform: 'ANY', ready: 'Live-Gate' }, 'pending'),
    { badge: '2G', color: 'charts.blue', label: 'major · needs a live gate' },
    'triage: mixed-case values normalize (parseFrontmatter does not lowercase values)');
  eq(p.todoTriage({ severity: '  minor  ', platform: 'any', ready: '  code  ' }, 'pending'),
    { badge: '4.', color: 'charts.green', label: 'minor · ready to pick up at the desk' },
    'triage: surrounding whitespace is trimmed');

  // THE 2-CHARACTER CAP. VS Code truncates a wider badge SILENTLY, which turns
  // a wrong answer into an invisible one. This is a loop over the real
  // vocabulary cross-product, not a handful of spot checks: the cap has to hold
  // for every combination the frontmatter can express, including the garbage
  // and missing values that produce the `?` fallbacks.
  {
    const SEVERITIES = ['critical', 'major', 'medium', 'minor', 'flurbled', undefined, '', null];
    const READINESS = ['code', 'live-gate', 'human', 'blocked', 'flurbled', undefined, '', null];
    const PLATFORMS = ['any', 'macos', 'windows', 'linux', 'flurbled', undefined, '', null];
    // v0.11.0: the badge cap now has a 4th dimension, the host — the `M`
    // letter only shows up when platform=macos AND host is something else, so
    // the sweep has to drive host too or it would never exercise `M` at all.
    const HOSTS = ['macos', 'windows', 'linux', null];
    let combos = 0;
    let widest = '';
    const violations = [];
    for (const severity of SEVERITIES) {
      for (const ready of READINESS) {
        for (const platform of PLATFORMS) {
          for (const host of HOSTS) {
            const { badge } = p.todoTriage({ severity, ready, platform }, 'pending', host);
            combos++;
            if (badge.length > widest.length) widest = badge;
            if (badge.length !== 2) violations.push(`${severity}/${ready}/${platform}/${host}=${badge}`);
          }
        }
      }
    }
    eq(violations, [], `triage: badge is exactly 2 chars across all ${combos} severity x readiness x platform x host combinations`);
    eq(combos, 2048, 'triage: the cap sweep really covered the whole cross-product including host (non-vacuity)');
    eq(widest.length, 2, 'triage: widest badge observed in the sweep is 2 chars');
  }

  // The two single-char exceptions are deliberate and inherited, so the cap
  // sweep above deliberately excludes them by only driving pending non-parked
  // rows. Pin them here instead so a later "make everything 2 chars" edit has
  // to confront them.
  eq(p.todoTriage({ severity: 'minor' }, 'completed').badge, '✓', 'triage: complete is a deliberate 1-char exception');
  eq(p.todoTriage({ severity: 'minor', status: 'in-progress' }, 'pending').badge, '▶', 'triage: in-progress is a deliberate 1-char exception');

  // completed/ is out of scope for this whole feature: it must render exactly
  // as it did before, for every severity, including files that carry no triage
  // keys at all (100+ of them predate this vocabulary).
  for (const severity of ['critical', 'major', 'medium', 'minor', undefined]) {
    eq(p.todoTriage({ severity, ready: 'human', platform: 'windows' }, 'completed'),
      { badge: '✓', color: 'charts.green', label: 'Complete' },
      `triage: completed/ unchanged for severity=${severity} even with blocking platform/ready`);
  }
}

// --- todoTriage: HOST-AWARE platform rung + actionable tallyTodos (v0.11.0) ---
{
  const winCodeMed = { severity: 'medium', platform: 'windows', ready: 'code' };
  const macCodeMed = { severity: 'medium', platform: 'macos', ready: 'code' };
  const linCodeMed = { severity: 'medium', platform: 'linux', ready: 'code' };

  // The rung is driven by the HOST argument, not a hardcoded macOS
  // assumption: a platform matching the host is desk-ready green, and a
  // known-OS platform that is NOT the host is red with its own letter.
  eq(p.todoTriage(winCodeMed, 'pending', 'windows'),
    { badge: '3.', color: 'charts.green', label: 'medium · ready to pick up at the desk' },
    'triage: platform windows at host windows is GREEN, desk-ready');
  eq(p.todoTriage(macCodeMed, 'pending', 'windows'),
    { badge: '3M', color: 'charts.red', label: 'medium · macOS only — not this machine' },
    'triage: platform macos at host windows is RED with the new M letter');
  eq(p.todoTriage(linCodeMed, 'pending', 'linux'),
    { badge: '3.', color: 'charts.green', label: 'medium · ready to pick up at the desk' },
    'triage: platform linux at host linux is GREEN, desk-ready');
  eq(p.todoTriage(macCodeMed, 'pending', 'linux'),
    { badge: '3M', color: 'charts.red', label: 'medium · macOS only — not this machine' },
    'triage: platform macos at host linux is RED with the new M letter');

  // Regression guard: host macos must still reproduce TODAY's verdicts.
  eq(p.todoTriage(winCodeMed, 'pending', 'macos'),
    { badge: '3W', color: 'charts.red', label: 'medium · Windows only — not this machine' },
    'triage: host macos still reds platform windows (regression guard)');
  eq(p.todoTriage(linCodeMed, 'pending', 'macos'),
    { badge: '3L', color: 'charts.red', label: 'medium · Linux only — not this machine' },
    'triage: host macos still reds platform linux (regression guard)');
  eq(p.todoTriage(macCodeMed, 'pending', 'macos'),
    { badge: '3.', color: 'charts.green', label: 'medium · ready to pick up at the desk' },
    'triage: host macos still greens platform macos (regression guard)');

  // T-sya-03 mitigation: a falsy/unknown host disables the rung rather than
  // reddening everything.
  for (const host of [null, undefined, '']) {
    eq(p.todoTriage({ platform: 'windows', ready: 'code', severity: 'medium' }, 'pending', host),
      { badge: '3.', color: 'charts.green', label: 'medium · ready to pick up at the desk' },
      `triage: falsy host ${JSON.stringify(host)} disables the platform rung`);
  }

  // platform: any, a missing platform:, and an unrecognised value are ALWAYS
  // actionable, at every host.
  for (const host of ['macos', 'windows', 'linux']) {
    for (const platform of ['any', undefined, 'flurbled']) {
      const t = p.todoTriage({ severity: 'medium', ready: 'code', platform }, 'pending', host);
      eq(t.color === 'charts.red', false,
        `triage: platform ${JSON.stringify(platform)} at host ${host} is not reddened by the rung`);
    }
  }

  // Case and whitespace, matching the existing convention at :729-732.
  eq(p.todoTriage({ severity: 'medium', ready: 'code', platform: '  Windows  ' }, 'pending', 'windows'),
    { badge: '3.', color: 'charts.green', label: 'medium · ready to pick up at the desk' },
    'triage: platform "  Windows  " normalizes and matches host windows');

  // Rung precedence survives: parked beats platform.
  eq(p.todoTriage({ severity: 'critical', platform: 'windows', status: 'PARKED — x', ready: 'code' }, 'pending', 'macos'),
    { badge: '1B', color: 'charts.purple', label: 'critical · parked' },
    'triage: parked beats a blocking platform, at host macos');

  // completed/ with a blocking platform is still the green tick, at every host.
  for (const host of ['macos', 'windows', 'linux', null]) {
    eq(p.todoTriage({ severity: 'minor', platform: 'windows', ready: 'code' }, 'completed', host),
      { badge: '✓', color: 'charts.green', label: 'Complete' },
      `triage: completed/ still renders the green tick at host ${JSON.stringify(host)} despite a blocking platform`);
  }
}

// --- triageActionable: colour-keyed actionability, pinned non-vacuously ---
{
  const SEV2 = ['critical', 'major', 'medium', 'minor', undefined];
  const READY2 = ['code', 'live-gate', 'human', 'blocked', undefined];
  const PLATFORM2 = ['any', 'macos', 'windows', 'linux', undefined];
  const HOST2 = ['macos', 'windows', 'linux', null];
  let observedActionable = false;
  let observedStoodDown = false;
  let mismatchError = null;
  try {
    for (const severity of SEV2) {
      for (const ready of READY2) {
        for (const platform of PLATFORM2) {
          for (const host of HOST2) {
            const t = p.todoTriage({ severity, ready, platform }, 'pending', host);
            const actionable = p.triageActionable(t);
            if (actionable) observedActionable = true; else observedStoodDown = true;
            const expected = !['charts.purple', 'charts.red'].includes(t.color);
            if (actionable !== expected) {
              throw new Error(`mismatch at ${severity}/${ready}/${platform}/${host}: actionable=${actionable} color=${t.color}`);
            }
          }
        }
      }
    }
  } catch (e) {
    mismatchError = e.message;
  }
  eq(mismatchError, null, 'triageActionable: colour-actionable mapping holds across the cross-product');
  eq(observedActionable && observedStoodDown, true,
    'triageActionable: the sweep observed BOTH an actionable and a stood-down verdict (non-vacuity)');
}

// --- tallyTodos: the 24-row live-census fixture, at all three hosts ---
{
  // Exact cross-tab of the real 24-file pending tree (todoFileStatus | platform
  // | ready), reproduced row-for-row from the measured census.
  const todoRows = (n, { platform, ready, parked }) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push(parked
        ? { severity: 'medium', platform, ready, status: 'PARKED — fixture row' }
        : { severity: 'medium', platform, ready });
    }
    return rows;
  };
  const LIVE_CENSUS_FIXTURE = [
    ...todoRows(2, { platform: 'any', ready: 'blocked', parked: true }),
    ...todoRows(3, { platform: 'any', ready: 'blocked' }),
    ...todoRows(3, { platform: 'any', ready: 'code' }),
    ...todoRows(4, { platform: 'any', ready: 'human' }),
    ...todoRows(3, { platform: 'any', ready: 'live-gate' }),
    ...todoRows(1, { platform: 'linux', ready: 'code' }),
    ...todoRows(3, { platform: 'macos', ready: 'live-gate' }),
    ...todoRows(3, { platform: 'windows', ready: 'blocked' }),
    ...todoRows(1, { platform: 'windows', ready: 'code' }),
    ...todoRows(1, { platform: 'windows', ready: 'human' }),
  ];
  eq(LIVE_CENSUS_FIXTURE.length, 24, 'todos: live-census fixture reproduces the 24-file pending tree');

  // tallyTodos derives `open` from the triage verdict (host-aware,
  // ready:blocked-aware), not from `total - parked`.
  for (const [host, expectedOpen] of [['macos', 13], ['windows', 12], ['linux', 11]]) {
    eq(p.tallyTodos(LIVE_CENSUS_FIXTURE, host),
      { total: 24, parked: 2, unparked: 22, open: expectedOpen },
      `todos: live-census tally at host ${host} — total 24, parked 2, unparked 22, open ${expectedOpen}`);
  }
}

{
  // The same numbers again, but reached through the ON-DISK path: real .md
  // files read from a frozen fixture directory and run through
  // parseFrontmatter, which the hand-built cross-tab above skips entirely by
  // starting from already-parsed objects. That is what this block is for.
  //
  // It is NOT an independent census. The fixture files are SYNTHETIC and were
  // generated from the very cross-tab above, so they cannot disagree with it
  // about the tally — if the cross-tab is wrong about the vocabulary, both are
  // wrong together. An earlier revision of this block did have that
  // independence: it read a frozen snapshot of a real .planning/todos/pending
  // tree. That snapshot was removed before this repo was published because it
  // carried another project's internal defect notes. Say what is left, not
  // what was lost.
  //
  // The directory is still FROZEN and must not be pointed at a live
  // .planning/todos/pending: reading a live tree at test time is flaky by
  // construction, since a sibling session filing or closing a todo mid-run
  // flips these numbers and looks like a parser regression to whoever sees the
  // mismatch next. See fixtures/todos-pending-README.md.
  const fixtureDir = path.join(__dirname, 'fixtures', 'todos-pending');
  const fixtureFiles = fs.readdirSync(fixtureDir).filter((f) => /\.md$/i.test(f));
  eq(fixtureFiles.length, 24, 'todos: frozen fixture directory still holds its 24 files');
  const fixtureFms = fixtureFiles.map((f) =>
    p.parseFrontmatter(fs.readFileSync(path.join(fixtureDir, f), 'utf8'))
  );
  for (const [host, expectedOpen] of [['macos', 13], ['windows', 12], ['linux', 11]]) {
    eq(p.tallyTodos(fixtureFms, host),
      { total: 24, parked: 2, unparked: 22, open: expectedOpen },
      `todos: on-disk fixture tally at host ${host} — total 24, parked 2, unparked 22, open ${expectedOpen}`);
  }
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll parser tests passed.');
process.exit(fails ? 1 : 0);
