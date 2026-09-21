---
name: o-doctor
description: Reconcile this workspace against reality — symlinks resolve, memory is wired to the right slug, the project index is current, plan frontmatter is valid, no stale absolute paths, no backlog line duplicating a live project, MEMORY.md matches its files, and every memory declares its volatility. Use at the start of a session, after moving or re-cloning the repo, on a new machine, when memory or a skill seems to be missing, or when something feels out of sync. At the start of a work session, before trusting the workspace. After the clone moves, after a rename, or on a second machine. When project memory seems to be missing, when a skill doesn't load, or when the project index looks wrong. Before committing a batch of plan/memory changes.
---

# Workspace doctor

```bash
node scripts/doctor.mjs
```

`--json` for a machine-readable report, `--only <id>` to run one check.

**Exit 0 means every check passed. Exit 1 means at least one finding.**

Since ORBI-67 this **runs automatically at session start** via a `SessionStart` hook
(`scripts/hooks/session-start.mjs`), which is silent when clean. That covers sessions started
in **this workspace** only — sibling repos are not scanned and get no hooks — so running it by
hand is still the move after the clone moves or when something feels out of sync.

## One severity tier

Every finding fails the run. There is no warning level, deliberately: a warning level is where
a real problem goes to be ignored, which is the same failure as a silent pass reached from the
other side.

So when a check fires, there are exactly two legitimate responses — **fix the workspace, or fix
the check.** Never `|| true` it, and never downgrade it. A check that turns out to be noisy
should be repaired or deleted.

This follows the rule the whole tool exists for (ORBI-65): **a green report from a broken
checker is worse than no checker.** Prefer a false alarm to a silent pass.

## What each check catches

| id | Catches |
|---|---|
| `symlinks` | the ecosystem root doc, `AGENTS.md`, and every personal skill link — `~/.claude/skills/<name>` always, plus Codex's `~/.agents/skills/<name>` **only when Codex is set up on this machine**. Checks each one **resolves**, not merely exists, and lands inside this repo |
| `codex-skills` | `.agents/skills/<name>` missing, dangling, or — the ORBI-79 defect — a real directory instead of a symlink, i.e. a second copy that will drift. Also an entry there with no `.claude/skills/` counterpart. **Unconditional**, unlike the global links: this is repo state |
| `hooks` | `.claude/settings.json` and `.codex/hooks.json` registering different commands, or either naming a `scripts/hooks/` file that doesn't exist |
| `memory-slug` | `~/.claude/projects/<slug>/memory` dangling, shadowed by a real directory, or at a stale slug after a path or username change — the memory-blackout bug. **Claude-only** — Codex publishes no equivalent contract |
| `index` | `projects/README.md` out of date (delegates to `build-project-index.mjs --check`) |
| `frontmatter` | Missing/invalid `status`, a non-ISO `opened`, `done` without `closed` (or `closed` without `done`), an `epic` naming a project that doesn't exist |
| `paths` | Paths **naming this workspace or the ecosystem it governs** (a path segment matching either directory's name) in live files that don't exist on this machine — including prose, because ORBI-65's stale-path defect was prose |
| `backlog` | A `BACKLOG.md` line naming a currently **open** project — i.e. work that graduated to a plan but left its backlog line behind |
| `memory-index` | A memory file with no `MEMORY.md` row, a row with no file, or a duplicated row |
| `memory-volatility` | A memory with no (or an invalid) `volatility`, a `volatile` one without a valid `reviewed:` date, or a `durable` one carrying a stray `reviewed:`. **Schema only — it never flags a memory as *overdue*;** `/o-next` does that |

## Reading the findings

- **`symlinks` / `memory-slug`** — almost always fixed by re-running `context/bootstrap.sh`,
  which is idempotent and re-links whatever moved. The slug is *derived from the checkout path*;
  the doctor prints the one it derived, which is the fastest way to see a path change. The
  summary says `claude + codex` or `claude only`, so you can tell a skipped check from a passed
  one — the Codex half is gated on `~/.codex`/`~/.agents` existing, because demanding it on a
  laptop that never installed Codex would paint every session red over a non-defect.
- **`codex-skills`** — recreate the link: `ln -s ../../.claude/skills/<name> .agents/skills/<name>`.
  If it reports a real **directory**, look at it before deleting: that is a copy, and it may hold
  edits made through `.agents/` that never reached the canonical file. Diff first, then relink.
- **`hooks`** — edit both files to match. There is no supported single registration file; the
  scripts in `scripts/hooks/` are shared, the two JSON files that name them are not. Remember
  Codex runs none of them until the project's config layer is trusted, which this check cannot
  see — a green `hooks` means the registrations agree, not that Codex executed anything.
- **`index`** — run `node scripts/build-project-index.mjs`. Never hand-edit
  `projects/README.md`.
- **`frontmatter`** — fix the plan's frontmatter, not the index.
- **`paths`** — if the path is *deliberately* historical, add an inline `doctor:ignore-path`
  marker to that line rather than rewording the prose. `projects/**` is already exempt: plans
  are append-only, and a plan recording the path as it was is correct. Only paths with an
  `orbi` segment are in scope — `~/.claude/skills`, `~/.agents/skills` and the like are destinations the bootstrap
  creates, not stale references, and flagging them made a fresh clone unreadable. The summary
  line prints the workspace name it derived, so a checkout in a differently-named parent shows
  up as `0 <name> paths` rather than a false all-clear.
- **`memory-volatility`** — add the missing field. Every memory declares `volatility: durable |
  volatile`; a volatile one also carries `reviewed: YYYY-MM-DD`. There is no default, on purpose.
  If the fix looks like "this fact needs a version number kept current", delete the number
  instead — see the workspace instructions (`CLAUDE.md`; `AGENTS.md` is the same file)
- **`backlog`** — delete the backlog line. The plan is the record from then on
  (`o-plan` step 4). Provenance references to *done* projects are fine and don't fire.

## What it does not do

**A green doctor does not mean you are in sync.** It checks this machine against this checkout,
offline, with no network calls and no look at the sibling repos it governs. It will report a
perfectly healthy workspace while `origin` is ten commits ahead and the other laptop's memory is
simply absent.

That gap is now covered *beside* the doctor rather than inside it: `scripts/hooks/origin-check.mjs`
fetches and warns at session start. Keeping the split matters — the doctor stays fast, offline
and testable; the network lives in the hook.

It also can't tell you a memory file has gone **stale** — that a fact was true when written and
isn't now. That needs review dates on volatile memory (a separate `BACKLOG.md` item), and it's
why ORBI-65's claim is *four of five* defects caught, not five.

## When it changes

Adding a check is the point — `scripts/doctor.mjs` has a `CHECKS` array, one entry per check,
each returning findings. Two rules:

1. **Negative-test it.** Break the condition deliberately and confirm the exact finding text and
   a non-zero exit before considering it done. A check never seen to fail isn't a check.
   `projects/ORBI-66/plan.md` records this for the original seven.
2. **A check that throws is a finding, not a skip** — already handled by the runner, so don't
   add a `try`/`catch` that swallows.
