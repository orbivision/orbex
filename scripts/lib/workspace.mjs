// Resolve the two roots every script here needs. ORBI-81.
//
// WHY THIS EXISTS. Until ORBI-81 each script derived its root from its own file location:
//
//     const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
//
// That is correct only while the script physically lives in the tree it operates on. Once the
// machinery is canonical in the public `orbex` repo and the private workspace consumes it
// through symlinks, it is actively wrong — **Node resolves symlinks before setting
// `import.meta.url`**, so `orbex-workspace/scripts/doctor.mjs` reports its own location as
// `orbex/scripts/doctor.mjs`, computes REPO as the public repo, and checks a tree nobody is
// working in. It would pass. A green report from a checker examining the wrong tree is the
// exact failure doctor.mjs's own header calls worse than having no checker, and here it would
// arrive silently and by construction.
//
// `node --preserve-symlinks` would also fix it and is rejected: it needs the flag on every
// invocation, including inside both hook registration files, which is the kind of invisible
// coupling that survives on one laptop and breaks on the other.
//
// NOTHING HERE IS HARDCODED. Same rule as before: the tool whose headline check is "did a path
// move?" must not itself contain a written-down path (ORBI-65 root cause).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const MARKER = '.orbex-workspace';

// Both repos carry a MARKER. The public one is a workspace with no content — no projects/, no
// memory, no backlog — which is precisely the case the checks must treat as *absent* rather
// than *broken* (see doctor.mjs). Marking it means branch 2 below answers correctly when a
// session runs there, instead of falling through to the physical-location guess.
const LIB = path.dirname(fileURLToPath(import.meta.url));

/**
 * The tree being operated on.
 *   1. $ORBEX_WORKSPACE      — explicit; always wins, and is how you point a script at another checkout
 *   2. nearest ancestor of process.cwd() holding MARKER
 *   3. the tree this file physically lives in — standalone: the machinery repo checking itself
 *
 * Returns { root, how } — `how` exists so the answer can be PRINTED. A resolver that can pick
 * the wrong tree must never do it quietly.
 */
export function resolveWorkspace() {
  const env = process.env.ORBEX_WORKSPACE;
  if (env) {
    const root = path.resolve(env);
    if (!existsSync(root)) throw new Error(`ORBEX_WORKSPACE=${env} does not exist`);
    return { root, how: 'ORBEX_WORKSPACE' };
  }

  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, MARKER))) return { root: dir, how: `${MARKER} above cwd` };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  return { root: path.resolve(LIB, '..', '..'), how: "this script's own location" };
}

/**
 * Read the marker file's optional `key: value` settings. Comments and blank lines ignored.
 * The marker is the one place a workspace describes itself, so nothing downstream has to
 * guess — and so this machinery carries no site's directory names.
 */
export function readMarker(root) {
  const out = {};
  try {
    for (const line of readFileSync(path.join(root, MARKER), 'utf8').split('\n')) {
      const m = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/);
      if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2];
    }
  } catch { /* missing or unreadable: no settings, which is a valid state */ }
  return out;
}

/**
 * The ecosystem this workspace governs: the directory holding the repos the work is actually
 * about, and the doc that gets linked into it as the agent's instruction file.
 *
 * **A workspace may have none** — one that governs nothing but itself is perfectly valid, and
 * is exactly what the machinery repo is. `{ root: null }` says so; it is not an error.
 *
 * Declared in the marker rather than guessed:
 *
 *     ecosystem_root: ../some-dir      # relative to the workspace
 *     ecosystem_doc:  context/foo.md   # relative to the workspace; linked in as CLAUDE.md
 *
 * ORBI-81 originally hardcoded a sibling named `orbi`, which worked here and was wrong
 * everywhere else. A path this machinery cannot know belongs in the workspace that does.
 */
export function resolveEcosystemRoot(workspace) {
  const env = process.env.ORBEX_ECOSYSTEM_ROOT;
  if (env) return { root: path.resolve(env), how: 'ORBEX_ECOSYSTEM_ROOT' };

  const declared = readMarker(workspace).ecosystem_root;
  if (declared) {
    const root = path.resolve(workspace, declared);
    return existsSync(root)
      ? { root, how: `${MARKER}: ecosystem_root` }
      : { root, how: `${MARKER}: ecosystem_root`, missing: true };
  }

  return { root: null, how: 'not declared — this workspace governs no ecosystem' };
}

/**
 * The workspace's project key — the `KEY` in `projects/KEY-N/`. ORBI-86.
 *
 * Until ORBI-86 every script matched `/^ORBI-\d+$/`, so the "generic" machinery only worked
 * for the one workspace whose key happened to be ORBI. Resolution order:
 *   1. `key:` in the marker — explicit, and what the README tells a new workspace to set
 *   2. inferred from `projects/` when every numbered directory shares ONE prefix
 *
 * **Never defaults to ORBI.** That default is the defect this replaces. With no projects at all
 * there is nothing to key, which is valid (`{ key: null }`); mixed prefixes are ambiguous, and
 * the answer is an `error` the caller must surface — never a guess.
 *
 * Never throws: doctor.mjs runs under a SessionStart hook, so this reports rather than raises.
 * Returns { key, how, error? }.
 */
export function projectKey(workspace) {
  const declared = readMarker(workspace).key;
  if (declared) {
    return /^[A-Z][A-Z0-9]*$/.test(declared)
      ? { key: declared, how: `${MARKER}: key` }
      : { key: null, how: `${MARKER}: key`, error: `key "${declared}" in ${MARKER} must be uppercase letters/digits, e.g. ORBI` };
  }

  let names = [];
  try {
    names = readdirSync(path.join(workspace, 'projects'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { /* no projects/ — nothing to key */ }
  const prefixes = new Set(names.map((n) => n.match(/^([A-Z][A-Z0-9]*)-\d+$/)?.[1]).filter(Boolean));

  if (prefixes.size === 1) return { key: [...prefixes][0], how: 'inferred from projects/' };
  if (prefixes.size === 0) return { key: null, how: 'no numbered projects yet' };
  return {
    key: null,
    how: 'inferred from projects/',
    error: `projects/ mixes keys (${[...prefixes].sort().join(', ')}) — add \`key: <KEY>\` to ${MARKER}`,
  };
}

/** `/^KEY-\d+$/` for directory names; matches nothing when there is no key. */
export function projectDirRe(key) {
  return key ? new RegExp(`^${key}-\\d+$`) : /(?!)/;
}

/**
 * Never-throwing variant, for the lifecycle hooks.
 *
 * A hook must ALWAYS exit 0 (ORBI-67): a session must never fail to start because the
 * workspace is untidy. Root resolution happens at module top level, *before* a hook's own
 * try/catch can run, so a throw there would break that contract in the one place it matters
 * most — on every session, on both hosts.
 */
export function resolveWorkspaceSafe() {
  try {
    return resolveWorkspace();
  } catch (e) {
    return { root: path.resolve(LIB, '..', '..'), how: `fallback (${e.message})` };
  }
}
