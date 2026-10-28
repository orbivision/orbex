# CLAUDE.md — Orbex

**Orbex is a workspace for an AI coding agent: a git repo that holds the *process* for a
project, sitting beside the repos that hold the code.**

This repo is the machinery — the scripts, the skills and the conventions. A *workspace* is a
repo that uses it and holds the actual work: plans, memory, a backlog. This repo is itself a
workspace, one that happens to govern nothing but itself, which is why every check here passes
with no `projects/` and no memory.

> **Two hosts, one file.** `AGENTS.md` is a symlink to this file, so Codex and Claude Code read
> the same document. Edit through either name; there is no second copy to keep in sync. This
> file writes commands as `/o-plan`; read that as `$o-plan` under Codex.

## The idea

An agent is good at the work and bad at remembering why. Four kinds of knowledge get confused
with each other constantly, and separating them is most of what this repo is:

| | Lives in | Changes when |
|---|---|---|
| **Intent** — what we're doing and why | `projects/<KEY>-N/plan.md` | the work does |
| **Facts about the codebase** | `CLAUDE.md` | the code does |
| **Facts learned the hard way** | `context/memory/` | reality does |
| **Procedures too long to keep in context** | `.claude/skills/` | you improve them |

Guess wrong about which is which and the workspace gets worse, not better: a procedure written
as a fact is ignored, and a fact written as a procedure is never read.

## The loop

**`/o-plan` → work → `/o-ship`**, with **`/o-next`** choosing what enters it and **`/o-doctor`**
underneath, checking that the machinery is actually wired up.

The one hard rule is in `/o-plan`: **nothing gets built before an approved plan exists.** A plan
is a *negotiation surface* — being wrong on paper is cheap, and the whole point is to be wrong
there rather than in a deploy. Plans are **append-only**: what a plan got wrong is the most
valuable thing in it, so deviations get appended and never edited out.

## Setting up a workspace

A workspace is a git repo with a `.orbex-workspace` marker at its root and this repo cloned
**as a sibling**:

```
~/somewhere/
├── orbex/              # this repo
└── my-workspace/       # yours
    ├── .orbex-workspace
    ├── projects/<KEY>-N/plan.md
    ├── context/memory/
    ├── BACKLOG.md
    └── scripts/ …      # symlinks into ../orbex/scripts/
```

The marker is how every script finds the tree it operates on, and it carries optional settings:

```
key:            ACME              # plans live at projects/ACME-N/
ecosystem_root: ../some-dir       # the repos the work is actually about
ecosystem_doc:  context/arch.md   # linked into ecosystem_root as CLAUDE.md
```

All three are optional. A workspace that governs nothing but itself omits the ecosystem pair.

**Declare your project key in two places, the same in both.** The marker's `key:` is what the
scripts read; left out, they infer it from `projects/` when every numbered directory shares one
prefix, and fail loudly when they don't — they never assume one. The line in your workspace's own
`CLAUDE.md` is what the skills read when they write `<KEY>-N`.

Then run `context/bootstrap.sh` from your workspace. It is idempotent, it moves real files aside
rather than overwriting them, and it wires up:

- the ecosystem doc link, when declared
- `~/.claude/projects/<slug>/memory` → your workspace's `context/memory/` (Claude Code only)
- `~/.claude/skills/<name>` and `~/.agents/skills/<name>` → each skill

**Why the memory symlink matters:** project memory is a Claude Code filesystem contract at a
path derived from your workspace's absolute location. Putting the real directory in git and
linking it there makes memory *versioned* — it travels between machines and gets committed with
the work. Codex publishes no equivalent, so memory is Claude-only; don't assume a fact written
on one host is in context on the other.

**Why the skill links matter:** both hosts only discover project skills at or below the session's
directory. Sibling repos are never scanned, so a session started in the code repo sees none of
this. Linking each skill into the personal skills directory makes the names visible anywhere.

## Memory

One file per fact, with frontmatter. Every memory declares how it can go wrong, and there is
**no default** — the classification is the point, and a default is a way of not making it.

```yaml
volatility: volatile     # durable | volatile — required
reviewed: 2026-09-11     # required when volatile; must NOT appear on a durable one
```

- **`volatile`** — depends on something that changes *without anyone editing the file*: a
  third-party rule set, live infrastructure, an account setting, a published version.
- **`durable`** — true until the code changes, and changing the code is what prompts the edit.

**Never bump `reviewed:` without re-checking.** That converts "nobody knows if this is true"
into a false claim that somebody checked — strictly worse than leaving it overdue.

Enforced in two places, deliberately split: `/o-doctor` checks the **schema** (fixable in
seconds), while `/o-next` reports what is **overdue** (real work to pick up). A finding you
cannot clear at session start is how a checker gets ignored.

## Hooks

Skills are *judgment* — the agent loads them when they look relevant. Hooks are things that must
happen **every** time, so the harness runs them.

| Event | Script | Does |
|---|---|---|
| `SessionStart` | `scripts/hooks/session-start.mjs` | Runs the doctor (~0.05 s, sync). Silent when clean |
| `SessionStart` | `scripts/hooks/origin-check.mjs` | `git fetch` + warns if behind `origin` (**async**) |
| `Stop` | `scripts/hooks/stop.mjs` | Warns on uncommitted memory and a stale index |

All three: `systemMessage` only, never blocking, **always exit 0**. A hook fires on every turn,
so a bad one degrades everything.

Two registration files, because neither host reads the other's: `.claude/settings.json` and
`.codex/hooks.json`. They name the same scripts and must be edited together — the doctor fails
when they disagree. Commands are **relative**, because hooks run with the workspace root as cwd.

**Silent success is invisible.** A host only reports hooks that error or run slow, so a
correctly-wired hook and an unwired one look identical. Prove one by side effect — `.git/FETCH_HEAD`'s
mtime for `origin-check`, the `orbi-stop-<session-id>` sentinel in your temp dir for `stop`.
Under Codex, the project config layer has to be trusted before any hook runs at all.

## Tracking

Three places, and the split is deliberate — **status is derived, never maintained in parallel.**

| | What | Maintained by |
|---|---|---|
| `projects/<KEY>-N/plan.md` | The work; `status` in its frontmatter | Hand — but *inside* the artifact it describes, so it can't drift from it |
| `projects/README.md` | Index, in-flight first | **Generated** — `node scripts/build-project-index.mjs` |
| the dashboard | Progress page — throughput, cycle time, timeline | **Generated on demand** — `node scripts/dashboard.mjs --open`, written to a temp file. A renderer of the two scripts' `--json`; it never reads a plan and is never committed |
| `BACKLOG.md` | Ideas that aren't projects yet | Hand. The **only** hand-maintained list |

Plus a capture inbox: any open GitHub Issue on the workspace's own repo, derived from its
`origin` remote. Issues are an **inbox, never a tracker** — triage into the backlog or a project,
then close.

**Why it's built this way:** an earlier version kept a hand-maintained status list separate from
the work. It drifted far enough to mark a project "awaiting approval" on the day it shipped to
production. Anything updated separately from the work it describes will do the same. Don't add a
fourth list.

### Plan frontmatter

```yaml
---
status: done          # done | active | open | blocked | dropped
opened: 2026-05-17
closed: 2026-08-23    # omit unless done
epic: KEY-25          # optional
priority: high        # optional; only meaningful while not done
repos: [some-repo]    # optional
---
```

## The doctor

`node scripts/doctor.mjs` reconciles a workspace against reality: symlinks that **resolve**
(not merely exist), memory wired to the right slug, a current index, valid frontmatter, no stale
absolute paths, no backlog line duplicating a live project.

**One severity tier, on purpose.** Every finding fails the run. There is no warning level,
because a warning level is where a real problem goes to be ignored — the same failure as a
silent pass, reached from the other side. If a check turns out noisy, fix it or delete it; do
not downgrade it. The governing rule: **a green report from a broken checker is worse than no
checker.**

It prints which tree it checked and how it chose it, because the scripts are symlinks into this
repo and "the doctor was green" means nothing without "green about what?".

Scope is this machine, offline. A green doctor says nothing about `origin` or your other laptop
— that's the `origin-check` hook's job.

---

**Note on `ORBI-N` references.** Some comments and skill bodies cite project numbers like
`ORBI-65`. Those point into the private workspace this was extracted from, where each was a real
plan. They're kept as design rationale — the *why* behind a decision — and you can't follow them.
Nothing here depends on them.
