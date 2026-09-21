---
name: o-plan
description: Start a new numbered project — pick the next number, create projects/<KEY>-N/plan.md with the required frontmatter and sections, write the plan, and stop for approval before touching any code. Use whenever new work is being started, when the user describes something they want built or fixed, or when a BACKLOG.md item graduates into real work. When starting any new piece of work in the ecosystem this workspace governs. When the user says "let's do X", "new project", "plan this out", or promotes a backlog item. Before writing any code in a sibling repo.
---

# Starting a project

Every change to the ecosystem this workspace governs starts as a plan in it. The plan is a
**negotiation surface** — being wrong on paper is cheap, and the point is to be wrong there
rather than in a deploy.

**`<KEY>` below is your workspace's project key**, declared in its `CLAUDE.md`. Everything else
here is the same in every workspace.

## 1. Pick the number

```bash
ls projects | sed 's/[A-Z]*-//' | sort -n | tail -1
```

Increment it. Numbers are never reused, including for abandoned work.

## 2. Create the plan

`projects/<KEY>-N/plan.md`, starting with frontmatter:

```yaml
---
status: active
opened: <today, YYYY-MM-DD>
epic: <KEY>-N       # optional — omit unless this is genuinely a phase of a larger effort
priority: high      # optional — only meaningful while not done
repos: [some-repo, another-repo]           # optional but useful
---
```

Then `# <KEY>-N: <title>` and these four sections. They're required because each one catches a
different class of mistake:

| Section | What it's for |
|---|---|
| **Goal** | What this accomplishes and why. If it can't be stated in a paragraph, the scope is wrong. |
| **Current State** | The relevant existing code, config, and deployment state — **verified, not remembered.** Fetch/pull first; these repos are developed on more than one laptop. |
| **Implementation Steps** | Numbered, specific, one action per step. Mark which steps are the user's — anything behind a UI, a 2FA prompt, or credentials an agent does not hold. |
| **Key Differences / Risks** | The non-obvious things that could bite. This is the highest-value section and the one most worth over-writing. |

## 3. Stop

**Do not touch any repo this workspace governs until the user approves the plan.** This is the
workspace's one hard rule. Present the plan, name the decisions you need from them, and wait.

Ask about genuinely open choices — ones where different answers mean different work. Don't ask
for permission to start.

## 4. If it came from the backlog

**Delete the `BACKLOG.md` line.** The plan is the record now, and leaving both is how the two
lists drift apart.

## 5. Regenerate the index

```bash
node scripts/build-project-index.mjs
```

## While executing

- **Update the plan as you go.** Deviations, corrections, and things that turned out wrong get
  appended — never edited out. A plan whose history has been tidied away is worth much less
  later, and "step 1 was wrong twice" is exactly the kind of thing worth keeping — a step the
  plan got wrong twice before getting right is worth more than the step that worked.
- **Verify with evidence, not vibes.** Prefer a measurement to an assertion: the emitted
  bundle, a live HTTP check, a count that matches the source.
- **Run the tests.** If the workspace has a skill covering which suite applies to what, use it.
- Close out with `/o-ship`.

## Conventions

- No secrets in plan files. Reference where they live (a provider's UI, `.env`, `gh secret`).
- Screenshots and generated artifacts go in the project folder alongside `plan.md`.
- A project that produces a document rather than a change is fine — a research spike whose
  artifact is a `recommendation.md` and no plan at all is a legitimate project.
