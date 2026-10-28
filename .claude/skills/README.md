# Skills

One directory per skill, `<name>/SKILL.md`. **This directory is the single canonical copy for
both hosts** — `.agents/skills/<name>` holds relative symlinks to it so Codex discovers the same
files. Never edit through `.agents/`, and never let a real directory appear there: a copy looks
healthy in both hosts right up until the two answers differ.

## Format

```yaml
---
name: o-example
description: What it does, then when to use it — several phrasings, including the words a user would actually type.
---
```

Only `name` and `description` are standard; both hosts ignore anything else, so don't invent
fields. **The `description` is the entire trigger mechanism**: an agent decides whether to load a
skill by matching what you asked against that one string. A description that only says what the
skill *does* will not fire when it should, which is why the ones here also enumerate the
situations and the phrasings.

## What belongs in one

A skill is a **procedure** — a sequence with an order that matters, too long to keep in context
and too specific to re-derive. If it is a *fact*, it belongs in `CLAUDE.md` or in memory; if it
is *intent*, it belongs in a plan. Guessing wrong is the main way a workspace gets worse instead
of better.

Write the traps, not just the steps. The steps are usually obvious in hindsight; the reason the
obvious thing fails is not.

## The five here

| | |
|---|---|
| [`o-plan`](o-plan/SKILL.md) | Start a numbered project; stop for approval before touching code |
| [`o-next`](o-next/SKILL.md) | One prioritized view across projects, backlog, Issues and overdue memory |
| [`o-dashboard`](o-dashboard/SKILL.md) | Generate and open the progress dashboard — throughput, cycle time, timeline — rebuilt every time |
| [`o-ship`](o-ship/SKILL.md) | Verify it shipped, log what the plan got wrong, reconcile memory, close out |
| [`o-doctor`](o-doctor/SKILL.md) | Reconcile the workspace against reality |

These are the host-generic ones. The skills that know about *your* deploys, tests and releases
belong in your own workspace, not here — `bootstrap.sh` links both sets into the personal skills
directory, so a session sees them together regardless of which repo they live in.

## Adding one

Create the directory and `SKILL.md`, add the matching symlink under `.agents/skills/`, and run
`node scripts/doctor.mjs` — it checks that every skill is linked for both hosts and that nothing
under `.agents/` is a real directory.
