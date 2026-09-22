# Frozen fixture: `todos-pending/`

`todos-pending/` (sibling of this file, in the same `fixtures/` directory) is a
**frozen, synthetic set of 24 GSD todo files** used by `test-parse.js` to pin
the todo census assertions:

    total: 24, parked: 2, unparked: 22
    open (actionable): 13 at host macos, 12 at host windows, 11 at host linux

**Synthetic, and deliberately so.** Each file carries only generated
frontmatter — `severity` / `platform` / `ready` / `status` — laid out to
reproduce exactly the cross-tab that `LIVE_CENSUS_FIXTURE` in `test-parse.js`
states inline. The bodies are filler; the parser never reads them.

**What this fixture does and does not buy you.** It exercises the on-disk path
— real files, read from disk, through `parseFrontmatter` — which the inline
cross-tab skips by starting from already-parsed objects. It is **not** an
independent confirmation of the tally, because it was generated from that same
cross-tab. Both would be wrong together if the vocabulary were wrong.

**Do not point the test at a live `.planning/todos/pending`.** A real pending
tree is mutated by concurrent work — todos get filed, closed, re-triaged — so
an assertion reading it at test time is flaky by construction, and it fails in
the worst direction: it looks like a parser regression to whoever sees the
mismatch next, when the cause is someone closing a todo elsewhere.

**This README deliberately lives OUTSIDE the fixture directory, not inside
it.** `test-parse.js` globs that directory for `*.md` to build its input, so a
`README.md` sitting inside it matches the same glob and silently becomes a
25th "todo" — `parseFrontmatter` returns a mostly-empty object for it rather
than failing, and the tally quietly reads 25. That inflated count has been hit
once already. Do not "tidy" this file into the fixture directory.

**If a vocabulary or triage-ladder change needs different data,** add a **new**,
differently-named fixture directory rather than editing this one in place. The
old fixture and the assertions pinned to it should move together or be deleted
together, never silently reinterpreted against changed files.
