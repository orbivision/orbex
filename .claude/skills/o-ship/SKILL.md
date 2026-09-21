---
name: o-ship
description: Close out a project — verify it actually shipped, append the execution log to plan.md, flip the frontmatter to done, reconcile any memory the work invalidated, regenerate the project index, and commit. Use when work is finished and merged, when the user says a project is done, or when a plan is still marked active after the work landed. When a project's work is merged and live. When the user says "that's done", "close it out", "ship it", or "wrap up <KEY>-N". When /o-next shows a project still active whose work has actually landed.
---

# Closing out a project

The step that gets skipped, which is why memory goes stale and plans sit marked `active` after
their work shipped. Closing out is a real step with real outputs.

## 1. Verify it actually shipped

Don't take a merged PR as proof of a live deploy. Check the artifact that a visitor or consumer
would see:

**Check the thing a visitor or a consumer would actually receive** — the live URL, the
published package as the registry serves it, the release artifact unpacked. Not the merge, not
a green workflow run, not a CLI that caches.

Three traps worth knowing before you pick a method, because each one produces a confident wrong
answer rather than an error:

- **A package manager's own `view`/`info` command can serve a stale index for minutes** after a
  publish. Read the registry directly.
- **A workflow listing can return the *previous* run** while the one you care about is still
  starting, so "the build passed" may be about the wrong build.
- **A host that posts no commit status** leaves a status poll `pending` forever; absence of a
  result is not a failure, and waiting on it hangs.

**Your workspace's `CLAUDE.md` should carry the per-repo recipe** — which URL, which registry,
which artifact — since that is workspace knowledge, not procedure.

## 2. Append the execution log

To `plan.md`, under a dated heading. **Append — never rewrite history.** What belongs there:

- What was done, and where it deviated from the plan.
- **What the plan got wrong.** The most valuable content in the file.
- A verification table: what you checked, and the result.
- Anything left deliberately undone, and why.

## 3. Flip the frontmatter

```yaml
status: done
closed: <today, YYYY-MM-DD>
```

Drop `priority` — it's meaningless once done.

If it *didn't* ship, say so honestly: `blocked` (with the reason in the log) or `dropped`.

## 4. Reconcile memory

**This is the step that keeps memory trustworthy**, and skipping it is why ORBI-65 found three
stale files, one six weeks old.

- Did this work make an existing memory wrong? Fix that file *and* its `MEMORY.md` row.
- Did it teach something durable and non-obvious? Write a new memory — one fact per file.
- Don't record status in memory. Status goes in plan frontmatter or `BACKLOG.md`.
- Don't record what the repo already says. Code structure, git history, and anything in the
  workspace instructions (`CLAUDE.md`; `AGENTS.md` is the same file) are not memories.

## 5. Update the backlog

- Delete any `BACKLOG.md` line this project completed.
- Add follow-ups it created — the "left deliberately undone" items from step 2.
- If something was considered and rejected, put it under **Accepted / won't fix** so it doesn't
  get re-raised.

## 6. Regenerate and commit

```bash
node scripts/build-project-index.mjs
git add -A && git commit && git push
```

**Include `context/memory/` in the commit.** Memory is versioned here specifically so it
travels between laptops; leaving it uncommitted defeats the arrangement.

## Checklist

```
[ ] verified live, against the real artifact
[ ] execution log appended, including what the plan got wrong
[ ] frontmatter: status + closed
[ ] memory reconciled (fixed stale, added new, updated MEMORY.md)
[ ] BACKLOG.md updated — completed lines removed, follow-ups added
[ ] index regenerated
[ ] committed and pushed, memory included
```
