---
name: o-dashboard
description: Generate the workspace's progress dashboard and open it in the browser — a static page of projects in flight, weekly throughput, cycle time, a project timeline, the backlog, the GitHub Issues inbox and memory due for review, rebuilt from the plans every time. Use when asked to open, show, refresh or regenerate the dashboard, or to see how projects are going, how fast work is closing, or a visual overview of progress. When the user wants a picture of the workspace rather than the prioritized list /o-next prints.
---

# Progress dashboard

```bash
node scripts/dashboard.mjs --open
```

Run it from the workspace root. That writes `$TMPDIR/orbex-dashboard-<workspace>.html` and opens
it in the default browser. Flags:

- `--no-gh` — skip the GitHub Issues inbox (offline, or `gh` not signed in). The page then says
  "Not checked" for the inbox, rather than showing it as empty.
- `--out <file>` — write somewhere else instead of the temp directory.

## What to say afterwards

**Very little.** The user asked to see the page, not for a summary of it: report that it opened
and the path it printed, in a line. Point out only what the page itself flags as broken — an
inbox or memory error, or a "Problems in the plans" section — because those mean the picture
is incomplete.

If the script exits non-zero, the message is from one of its producers (`next.mjs`,
`build-project-index.mjs`). The usual one is an ambiguous project key: add `key: <KEY>` to the
workspace's `.orbex-workspace` marker. Show the message; don't retry with flags to make it pass.

## What it is not

**The page is never a source.** It renders `next.mjs --json` and `build-project-index.mjs
--json` and reads no file itself, so it can't disagree with `/o-next` or `projects/README.md`.
To change what it shows, change the plans, `BACKLOG.md` or memory — then regenerate. Never edit
the HTML, and never commit it. A saved copy is a second status list, and a second list drifts.

It is **a view, not a decision.** To pick what to work on, use `/o-next`.
