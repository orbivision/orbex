---
name: o-next
description: Show everything still open across this workspace — projects in flight, the BACKLOG.md list, untriaged GitHub Issues, and volatile memories due for re-checking — as one prioritized view, then help decide what to work on next. Use at the start of a work session, when asked "what's next", "what's left", "what should I work on", "show me the backlog", or when an idea needs capturing or triaging. At the start of a session when the user is deciding what to pick up. When asked what is open, outstanding, left to do, or next in priority. When the user wants to capture a new idea, or triage the GitHub Issues inbox into the backlog.
---

# What's next

One command, three sources:

```bash
node scripts/next.mjs
```

Add `--no-gh` if GitHub is unreachable; add `--json` if you need to process it.

| Source | What it holds | Where it lives |
|---|---|---|
| Projects in flight | Numbered work already planned | `status:` in `projects/<KEY>-N/plan.md` frontmatter |
| Backlog | Not a project yet, grouped Now / Soon / Someday | `BACKLOG.md` (the one hand-maintained list) |
| Inbox | Captured, untriaged ideas | **Every open** GitHub Issue on this workspace's own repo, derived from its `origin` remote |
| Memory review | Volatile facts whose `reviewed:` date is over 8 weeks old | `volatility`/`reviewed` frontmatter in `context/memory/` |

## Presenting it

Don't just dump the script output — the user ran this to make a decision.

- **Lead with what's genuinely next**, not with the full list. Usually that's the active
  project, or the top of **Now** if nothing's in flight.
- **Say why**, in a clause. Cheapness, unblocking something else, or "this has been sitting
  in Now for weeks" are all real reasons.
- **Group rather than enumerate** when a section is long. Someday rarely needs reading aloud.
- **Surface the inbox separately.** Untriaged items are a decision the user owes the system,
  not work they can pick up — keep the distinction visible.
- **Memory review is a small, concrete job — treat it that way.** An overdue volatile fact means
  "go re-verify this against reality", usually one query or one command. Say which fact and how
  old it is. **Never offer to just bump the date** — that turns "nobody knows if this is true"
  into a false claim that someone checked, which is worse than leaving it overdue.
- If an item's one-line title isn't enough to decide on, read its detail out of `BACKLOG.md`
  rather than guessing.

## Capturing an idea

Two paths, and the right one depends on where the user is.

**At the laptop** — add it straight to the right section of `BACKLOG.md`. No issue needed.

**Away from it** — a GitHub Issue on this workspace's repo. The mobile app works; so does:

```bash
gh issue create --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
  --label inbox --title "..." --body "..."
```

**The `inbox` label is a hint, not a requirement.** `next.mjs` lists every open issue, so an
issue captured without it — which is what the mobile app makes easiest — still shows up, flagged
`← no inbox label`. Add the label when convenient; never treat a missing one as "not captured."
This is deliberate: the label used to be a filter, and it hid three real items behind a confident
`empty` (2026-08-30).

## Triaging the inbox

**Issues are an inbox, never a tracker.** Nothing in flight should live there. An issue's only
job is to survive the trip from wherever the idea struck to the repo. So every triaged issue
ends the same way — closed:

1. Decide: real work, or not?
2. If it's small or not-yet-scoped → add a line to the right `BACKLOG.md` section.
3. If it's a real chunk of work → `/o-plan` it into a numbered project.
4. **Close the issue**, referencing where it went (`gh issue close <n> --comment "..."`).

Never leave an issue open as a reminder. That's what `BACKLOG.md` is for, and two lists that
both hold open work is the exact failure this design exists to avoid.

## Keeping it honest

- `BACKLOG.md` is the **only** hand-maintained list. `projects/README.md` is generated —
  never edit it; change the plan's frontmatter and re-run
  `node scripts/build-project-index.mjs`.
- When a backlog item graduates to a project, **delete the backlog line.** The plan is the
  record from then on, and a duplicate is how the two drift apart.
- **Accepted / won't fix** in `BACKLOG.md` is load-bearing — it stops decided things being
  re-raised. If the user rejects something, record it there rather than deleting it.
