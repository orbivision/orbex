#!/usr/bin/env bash
# Wire this machine up to the portable agent context in this repo.
#
# Creates symlinks so Claude Code and Codex find context that lives in git:
#   <ecosystem>/CLAUDE.md             -> <workspace>/<ecosystem_doc>   (when declared)
#   ~/.claude/projects/<slug>/memory  -> <workspace>/context/memory   (Claude Code only)
#   ~/.claude/skills/<skill>          -> <workspace>/.claude/skills/<skill>   (ORBI-55)
#   ~/.agents/skills/<skill>          -> <workspace>/.agents-visible skills   (ORBI-79, Codex)
#
# <workspace> is wherever this checkout lives — nested under orbi/ before ORBI-81, a sibling
# of it after. Every path below is derived; none is written down.
#
# Both personal skill dirs point at the SAME canonical directory — one hop, not a chain
# through .agents/skills. Project memory stays Claude-only: Codex publishes no equivalent
# filesystem contract, so there is nothing here to link for it (see CLAUDE.md, "Two hosts").
#
# Idempotent: safe to re-run. Existing real files are moved aside to *.bak
# rather than overwritten. Does NOT clone repos or create .env files — see README.md.
set -euo pipefail

CTX="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # <workspace>/context
REPO="$(cd "$CTX/.." && pwd)"                          # <workspace>

# The ecosystem this workspace governs, and the doc linked into it — both declared in the
# .orbex-workspace marker, or absent, which is valid: a workspace may govern nothing but
# itself. Read through scripts/lib/workspace.mjs rather than reimplemented here. This used to
# be the same rule written twice, once in bash and once in node, which is a drift waiting to
# happen. ECO_DOC_REL is RELATIVE to the ecosystem root, so the link survives the whole tree
# being moved or cloned to a different absolute path.
eval "$(node --input-type=module -e "
  import { resolveEcosystemRoot, readMarker } from '$REPO/scripts/lib/workspace.mjs';
  import path from 'node:path';
  const ws = '$REPO';
  const { root, how } = resolveEcosystemRoot(ws);
  const doc = readMarker(ws).ecosystem_doc;
  const rel = root && doc ? path.relative(root, path.resolve(ws, doc)) : '';
  console.log('ECO_ROOT=' + JSON.stringify(root ?? ''));
  console.log('ECO_DOC_REL=' + JSON.stringify(rel));
  console.log('ECO_HOW=' + JSON.stringify(how));
")"

echo "context: $CTX"
echo "workspace: $REPO"
if [ -n "$ECO_ROOT" ]; then
  echo "ecosystem: $ECO_ROOT  ($ECO_HOW)"
  echo "root doc link: ${ECO_DOC_REL:-<none declared>}"
else
  echo "ecosystem: none declared — this workspace governs only itself"
fi
echo

# A symlink can exist and still be broken. If the clone moves, every absolute link
# left behind dangles — and `[ -L ]` alone reports a dangling link as perfectly fine.
# That is exactly what happened the first time one of these clones was moved: the memory
# link and a skill link both pointed at the old path for weeks, so Claude Code silently
# saw NO project memory, and re-running this script kept saying "already
# linked" (ORBI-65). Always check that a link resolves, not just that it exists.

# true when $1 is a symlink that actually resolves
link_live() { [ -L "$1" ] && [ -e "$1" ]; }

# true when directory symlink $1 resolves to the same place as $2
dir_links_to() {
  link_live "$1" || return 1
  [ "$(cd "$1" 2>/dev/null && pwd -P)" = "$(cd "$2" 2>/dev/null && pwd -P)" ]
}

# ---- 1. ecosystem root doc ----------------------------------------------------
# Skipped entirely when the marker declares no ecosystem, which is how the machinery repo
# bootstraps itself. Relative link, so it does not care where the ecosystem dir lives.
# Resolving is necessary but not sufficient: a link left over from an earlier layout can
# still resolve while pointing at a stale checkout, so the target is compared too.
if [ -z "$ECO_ROOT" ] || [ -z "$ECO_DOC_REL" ]; then
  echo "· no ecosystem doc declared — skipping"
else
  ORBI="$ECO_ROOT"
  ROOT_DOC_REL="$ECO_DOC_REL"
  if link_live "$ORBI/CLAUDE.md" && [ "$(readlink "$ORBI/CLAUDE.md")" = "$ROOT_DOC_REL" ]; then
    echo "✓ ecosystem CLAUDE.md already linked -> $(readlink "$ORBI/CLAUDE.md")"
  elif [ -L "$ORBI/CLAUDE.md" ]; then
    old="$(readlink "$ORBI/CLAUDE.md")"
    rm "$ORBI/CLAUDE.md"
    ln -s "$ROOT_DOC_REL" "$ORBI/CLAUDE.md"
    echo "✓ ecosystem CLAUDE.md RE-linked (was -> $old)"
  elif [ -e "$ORBI/CLAUDE.md" ]; then
    mv "$ORBI/CLAUDE.md" "$ORBI/CLAUDE.md.bak"
    ln -s "$ROOT_DOC_REL" "$ORBI/CLAUDE.md"
    echo "✓ ecosystem CLAUDE.md linked (previous real file saved as CLAUDE.md.bak)"
  else
    ln -s "$ROOT_DOC_REL" "$ORBI/CLAUDE.md"
    echo "✓ ecosystem CLAUDE.md linked"
  fi

fi

# ---- 2. memory directory ------------------------------------------------------
# Claude Code keys the project dir off the absolute path, with '/' -> '-'.
SLUG="$(echo "$REPO" | sed 's|/|-|g')"
TARGET="$HOME/.claude/projects/$SLUG"
mkdir -p "$TARGET"

if dir_links_to "$TARGET/memory" "$CTX/memory"; then
  echo "✓ memory already linked -> $(readlink "$TARGET/memory")"
elif [ -L "$TARGET/memory" ]; then
  # Dangling, or pointing at some other checkout. Either way, re-point it.
  old="$(readlink "$TARGET/memory")"
  rm "$TARGET/memory"
  ln -s "$CTX/memory" "$TARGET/memory"
  echo "✓ memory RE-linked (was -> $old)"
elif [ -d "$TARGET/memory" ]; then
  if [ -z "$(ls -A "$TARGET/memory")" ]; then
    rmdir "$TARGET/memory"          # empty: nothing to preserve, don't leave a confusing .bak
    ln -s "$CTX/memory" "$TARGET/memory"
    echo "✓ memory linked (replaced an empty real dir)"
  else
    mv "$TARGET/memory" "$TARGET/memory.bak"
    ln -s "$CTX/memory" "$TARGET/memory"
    echo "✓ memory linked (previous real dir saved as memory.bak — merge it in, it had files)"
  fi
else
  ln -s "$CTX/memory" "$TARGET/memory"
  echo "✓ memory linked"
fi

# ---- 3. skills (ORBI-55) ------------------------------------------------------
# Project skills in this repo are found automatically when a session starts here (or
# anywhere below it). Sessions started elsewhere — inside one of the code repos, which is a
# SIBLING of the workspace and so never scanned — won't see them. Linking each skill into
# the personal skills dir makes them available from anywhere.
#
# Symlink, not a copy: both hosts follow a symlinked skill directory and load the skill
# once even when it's reachable from both places. A REAL directory here would instead
# shadow the repo copy, since personal skills override project skills.
#
# Two destinations, one source (ORBI-79): Claude Code reads ~/.claude/skills, Codex reads
# ~/.agents/skills. Neither is derived from the other — they are separate product contracts
# that happen to want the same files.
SKILLS_SRC="$REPO/.claude/skills"
CLAUDE_SKILLS_DST="$HOME/.claude/skills"
CODEX_SKILLS_DST="$HOME/.agents/skills"

link_skills_into() {
  dst="$1"
  host="$2"
  echo "· $host personal skills -> $dst"
  mkdir -p "$dst"
  for skill_dir in "$SKILLS_SRC"/*/; do
    [ -d "$skill_dir" ] || continue
    skill="$(basename "$skill_dir")"
    link="$dst/$skill"
    if dir_links_to "$link" "${skill_dir%/}"; then
      echo "  ✓ skill '$skill' already linked -> $(readlink "$link")"
    elif [ -L "$link" ]; then
      old="$(readlink "$link")"
      rm "$link"
      ln -s "${skill_dir%/}" "$link"
      echo "  ✓ skill '$skill' RE-linked (was -> $old)"
    elif [ -e "$link" ]; then
      mv "$link" "$link.bak"
      ln -s "${skill_dir%/}" "$link"
      echo "  ✓ skill '$skill' linked (previous real dir saved as $skill.bak — it was shadowing this repo's copy)"
    else
      ln -s "${skill_dir%/}" "$link"
      echo "  ✓ skill '$skill' linked"
    fi
  done
}

if [ -d "$SKILLS_SRC" ]; then
  link_skills_into "$CLAUDE_SKILLS_DST" "Claude Code"
  link_skills_into "$CODEX_SKILLS_DST" "Codex"
else
  echo "· no .claude/skills yet — nothing to link"
fi

echo
echo "slug: $SLUG"
echo "memory files visible: $(ls "$TARGET/memory" 2>/dev/null | wc -l | tr -d ' ')"
echo "skills linked: $(ls "$CLAUDE_SKILLS_DST" 2>/dev/null | wc -l | tr -d ' ') claude, $(ls "$CODEX_SKILLS_DST" 2>/dev/null | wc -l | tr -d ' ') codex"
echo
echo "Still to do by hand — interactive, run these yourself:"
echo "  - gh auth login --git-protocol ssh --web  (if your remotes are SSH)"
echo "  - ~/.claude/settings.json"
echo "  - trust this project in Codex            (project hooks don't run until you do)"
echo "  - whatever your workspace's own setup doc lists (toolchain, .env files, Docker)"

# Flag the two that are cheap to check, so a broken setup surfaces here rather
# than halfway through a task.
echo
command -v gh >/dev/null 2>&1 \
  && { gh auth status >/dev/null 2>&1 && echo "✓ gh authenticated" || echo "✗ gh present but not authenticated"; } \
  || echo "✗ gh not installed"
command -v node >/dev/null 2>&1 \
  && echo "✓ node $(node -v)" \
  || echo "✗ node not installed — every script here needs it"
