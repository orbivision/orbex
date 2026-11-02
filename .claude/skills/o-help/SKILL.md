---
name: o-help
description: List this workspace's skill commands with a one-line summary each — the project-lifecycle commands, in the order a project passes through them, shown apart from the utilities. Generated from the skills themselves every time, so it can't fall behind them. Use when asked for help, which commands or skills exist, what the o- commands do, what can be done in this workspace, or which command to use for a stage of the work. When someone new to the workspace asks where to start.
---

# Skill commands

```bash
node scripts/help.mjs
```

Run it from the workspace root. Under Codex add `--codex`, which spells the commands `$o-*`;
`--json` is there if you need to process the list.

## What to say afterwards

**Show the output as it is, and add nothing.** The user asked for the list, and the list is
generated so that it can't be wrong about which skills exist — a summary of your own would be
the one part that can. If they then ask about a particular command, read its `SKILL.md`.

Lines starting with `!` are problems in the workspace, not in the help: a `lifecycle:` entry
with no matching skill, or a skill with no `description`. Point those out.

## Where it comes from

- **Commands** are the directory names under `.claude/skills/`.
- **Summaries** are each `description` cut at its first ` — ` or the end of its first
  sentence. So that opening clause has to work on its own as a summary — write new descriptions
  that way rather than adding a frontmatter field (`name` and `description` are the only two).
- **Grouping** is the `lifecycle:` line in `.orbex-workspace`, in display order. Anything not
  listed there is a utility. To move a skill between the groups, edit that line.
