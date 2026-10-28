#!/usr/bin/env node
// Reconcile this workspace against reality. Exit non-zero on ANY finding.
//
//   node scripts/doctor.mjs              # human-readable report
//   node scripts/doctor.mjs --json       # machine-readable (for a SessionStart hook)
//   node scripts/doctor.mjs --only <id>  # run one check: see CHECKS below for ids
//
// ONE SEVERITY TIER, on purpose (ORBI-66). Every finding fails the run. There is no
// warning level, because a warning level is where a real problem goes to be ignored —
// which is the same failure as a silent pass, reached from the other side. If a check
// turns out to be noisy, FIX IT OR DELETE IT. Do not downgrade it.
//
// The governing rule from ORBI-65: a green report from a broken checker is worse than no
// checker. Prefer a false alarm to a silent pass, and see the negative tests recorded in
// projects/ORBI-66/plan.md — a check that has never been seen to fail isn't a check.
//
// SCOPE: this workspace, offline. No network, no sibling repos. A green doctor does NOT
// mean you are in sync with the other laptop — that is the SessionStart hook's job.
//
// Dependency-free on purpose, like the other two scripts here: this repo has no
// package.json and shouldn't need one.

import { readFileSync, existsSync, readdirSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveWorkspace, resolveEcosystemRoot, readMarker, projectKey, projectDirRe } from './lib/workspace.mjs';

// Derived, never written down. The tool whose headline check is "did a path move?" must
// not itself contain a hardcoded path — that is exactly the ORBI-65 root cause.
//
// ORBI-81: both roots now come from scripts/lib/workspace.mjs rather than from this file's own
// location, because this file is a symlink in the workspace that consumes it and Node resolves
// symlinks before setting import.meta.url. Both `how` values are REPORTED in the output: a
// resolver that can pick the wrong tree must never be able to do it quietly.
const { root: REPO, how: REPO_HOW } = resolveWorkspace();
const HOME = homedir();
// May be null: a workspace governing nothing but itself is valid, and is what the machinery
// repo is. Every use below has to cope with that rather than assume an ecosystem exists.
const { root: ORBI, how: ORBI_HOW, missing: ORBI_MISSING } = resolveEcosystemRoot(REPO);

// ORBI-86: the workspace's project key. An `error` here is a finding (frontmatter check), not
// a throw — this script runs under a SessionStart hook.
const KEY = projectKey(REPO);
const PROJECT_DIR = projectDirRe(KEY.key);

const OPEN_STATUSES = ['blocked', 'active', 'open'];
const ALL_STATUSES = [...OPEN_STATUSES, 'done', 'dropped'];
const IGNORE_MARKER = 'doctor:ignore-path';
const VOLATILITY = ['durable', 'volatile'];
// ORBI-74. A GUESS — there is no evidence for the right interval, so it lives in one place
// and the first few months of use should correct it. Only `next.mjs` consumes the staleness
// itself; this script checks the SCHEMA, never the age (see the memory-volatility check).
const REVIEW_WEEKS = 8;

const MARKER_NAME = '.orbex-workspace';
const rel = (p) => path.relative(REPO, p) || '.';

// ABSENT IS NOT BROKEN (ORBI-81). The machinery is now canonical in the public `orbex` repo,
// which is a workspace with no content: no projects/, no memory, no backlog. Those checks must
// pass there without being weakened where the content DOES exist.
//
// The repo itself is asked, via git, rather than a config flag that could drift: a path that is
// TRACKED but missing on disk is broken and must fail; a path that was never tracked is simply
// not part of this workspace. That keeps a deleted memory directory loud in the workspace while
// staying silent in a repo that never had one.
function trackedInGit(relPath) {
  try {
    return execFileSync('git', ['ls-files', '--', relPath],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch {
    return false;   // not a git checkout at all — treat as untracked, i.e. absent
  }
}

// { absent: true } when this workspace legitimately does not carry `relPath`.
function contentState(relPath) {
  const abs = path.join(REPO, relPath);
  if (existsSync(abs)) return { absent: false, abs, tracked: true };
  const tracked = trackedInGit(relPath);
  return { absent: !tracked, abs, tracked };
}

// A symlink is only healthy when it RESOLVES. `[ -L ]` — lstat alone — reports a dangling
// link as perfectly fine, which is how Claude Code ran with zero memory for weeks after the
// clone moved (ORBI-65, defect 5). Mirrors link_live() in context/bootstrap.sh.
function linkState(link, expected) {
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return { ok: false, why: 'missing' };
  }
  if (!st.isSymbolicLink()) return { ok: false, why: 'not a symlink (a real file/dir shadows it)' };
  if (!existsSync(link)) return { ok: false, why: `DANGLING -> ${readlinkSafe(link)}` };
  const got = realpathSync(link);
  const want = realpathSync(expected);
  if (got !== want) return { ok: false, why: `resolves to ${got}, expected ${want}` };
  return { ok: true };
}

function readlinkSafe(p) {
  try {
    return execFileSync('readlink', [p], { encoding: 'utf8' }).trim();
  } catch {
    return '?';
  }
}

function skillDirs() {
  const dir = path.join(REPO, '.claude', 'skills');
  if (!existsSync(dir)) return [];
  // `withFileTypes` reports a SYMLINK to a directory as a symlink, not a directory — so a
  // filter on isDirectory() alone silently drops every skill a workspace consumes from the
  // machinery repo, and the codex-skills check then reports those as Codex-only copies.
  // Found the moment the split went live (ORBI-81). statSync follows the link.
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => {
      if (d.isDirectory()) return true;
      if (!d.isSymbolicLink()) return false;
      try { return statSync(path.join(dir, d.name)).isDirectory(); } catch { return false; }
    })
    .map((d) => d.name);
}

// Is Codex set up on THIS machine? (ORBI-79)
//
// This gate exists because of the one-severity-tier rule. The project tree is repo state and
// is checked unconditionally — it is wrong for everyone, on every machine. But ~/.agents/skills
// is a per-machine facility, and demanding it on a laptop where Codex was never installed would
// paint every session red over something that is not a defect. A finding you cannot clear at
// session start is how a checker gets ignored (ORBI-74), which is the same failure as a silent
// pass reached from the other side.
const codexPresent = () =>
  existsSync(path.join(HOME, '.codex')) || existsSync(path.join(HOME, '.agents'));

// Hook registrations are per-host files naming the same scripts. Compare the SUBSTANCE — the
// commands and their async flag — not the whole object, so a host-specific presentation field
// (a statusMessage one of them ignores, say) doesn't fail the run.
function hookCommands(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const events = raw.hooks ?? {};
  const out = {};
  for (const [event, groups] of Object.entries(events)) {
    out[event] = (groups ?? [])
      .flatMap((g) => g.hooks ?? [])
      .map((h) => `${h.command}${h.async ? ' [async]' : ''}`)
      .sort();
  }
  return out;
}

// Minimal frontmatter reader, same shape as build-project-index.mjs.
function readFrontmatter(src) {
  if (!src.startsWith('---\n')) return null;
  const end = src.indexOf('\n---', 4);
  if (end === -1) return null;
  const out = {};
  for (const line of src.slice(4, end).split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function planFiles() {
  const dir = path.join(REPO, 'projects');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || !PROJECT_DIR.test(d.name)) continue;
    const name = ['plan.md', 'recommendation.md'].find((f) =>
      existsSync(path.join(dir, d.name, f)));
    out.push({ id: d.name, name, file: name && path.join(dir, d.name, name) });
  }
  return out.sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));
}

function projectStatuses() {
  const map = new Map();
  for (const p of planFiles()) {
    if (!p.file) continue;
    map.set(p.id, readFrontmatter(readFileSync(p.file, 'utf8'))?.status);
  }
  return map;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

// ---- checks ------------------------------------------------------------------

const CHECKS = [
  {
    id: 'symlinks',
    // The portable-context contract: orbi/CLAUDE.md, AGENTS.md and every skill are symlinks
    // INTO this repo, so all of it travels between machines. Skill links are discovered by
    // iterating .claude/skills/*/ rather than hardcoded, mirroring bootstrap.sh — a new skill
    // must not need an edit here.
    //
    // AGENTS.md is Codex's required filename and CLAUDE.md is Claude Code's. One is a symlink
    // to the other so there is exactly one document; two real files would drift, which is the
    // whole lesson of ORBI-79.
    run() {
      const findings = [];
      const skills = skillDirs();
      if (ORBI_MISSING) {
        findings.push(`${MARKER_NAME} declares ecosystem_root ${ORBI}, which does not exist on this machine`);
      }
      const doc = readMarker(REPO).ecosystem_doc;
      const links = [
        // Only when this workspace declares an ecosystem AND the doc to link into it.
        ...(ORBI && !ORBI_MISSING && doc ? [[path.join(ORBI, 'CLAUDE.md'), path.join(REPO, doc)]] : []),
        [path.join(REPO, 'AGENTS.md'), path.join(REPO, 'CLAUDE.md')],
        ...skills.map((s) => [
          path.join(HOME, '.claude', 'skills', s),
          path.join(REPO, '.claude', 'skills', s),
        ]),
      ];
      // Codex's personal skills dir — only when Codex is actually set up here. See codexPresent().
      const codex = codexPresent();
      if (codex) {
        links.push(
          ...skills.map((s) => [
            path.join(HOME, '.agents', 'skills', s),
            path.join(REPO, '.claude', 'skills', s),
          ]),
        );
      }
      for (const [link, expected] of links) {
        if (!existsSync(expected)) {
          findings.push(`${link}: target ${rel(expected)} does not exist in the repo`);
          continue;
        }
        const st = linkState(link, expected);
        if (!st.ok) findings.push(`${link}: ${st.why}`);
      }
      const note = codex ? 'claude + codex' : 'claude only — no ~/.codex or ~/.agents here';
      return { findings, summary: `${links.length} links resolve (${note})` };
    },
  },

  {
    id: 'codex-skills',
    // UNCONDITIONAL, unlike the global links above: this is repo state, wrong on every machine
    // at once. `.claude/skills/` is the one canonical copy and `.agents/skills/<name>` must be a
    // symlink to it, because that is the exact failure ORBI-79 was opened to remove — Codex's
    // first-run import wrote eight independent COPIES, four of which had already diverged, one
    // instructing `gh issue create --repo orbivision/orbi-Codex` (codex-case:deliberate), a
    // repository that does not exist. A copy here looks healthy in both hosts right up until
    // the two answers differ.
    run() {
      const findings = [];
      const dir = path.join(REPO, '.agents', 'skills');
      const want = skillDirs();
      // Nothing to link is not a defect: a workspace may carry no skills of its own and rely
      // entirely on the ones the machinery repo provides. Demanding the directory anyway made
      // a freshly-created workspace red on its first doctor run (ORBI-81).
      if (want.length === 0) return { findings: [], summary: 'no skills in this workspace' };
      if (!existsSync(dir)) {
        return {
          findings: [`.agents/skills/ is missing — Codex discovers project skills there (${want.length} to link)`],
          summary: '',
        };
      }
      for (const s of want) {
        const link = path.join(dir, s);
        const expected = path.join(REPO, '.claude', 'skills', s);
        let st;
        try {
          st = lstatSync(link);
        } catch {
          findings.push(`.agents/skills/${s}: missing — Codex will not see this skill`);
          continue;
        }
        if (!st.isSymbolicLink()) {
          findings.push(
            `.agents/skills/${s}: a real ${st.isDirectory() ? 'directory' : 'file'}, not a symlink — ` +
              'this is a COPY and will drift; replace it with a link to ../../.claude/skills/' + s,
          );
          continue;
        }
        const state = linkState(link, expected);
        if (!state.ok) findings.push(`.agents/skills/${s}: ${state.why}`);
      }
      // An entry with no canonical counterpart is a skill only Codex can see — the same
      // one-source rule, failing in the other direction.
      for (const found of readdirSync(dir)) {
        if (!want.includes(found)) {
          findings.push(`.agents/skills/${found}: no .claude/skills/${found} — a Codex-only skill is still a second copy`);
        }
      }
      return { findings, summary: `${want.length} skills linked for Codex` };
    },
  },

  {
    id: 'hooks',
    // Same three scripts, two registration files, because neither product reads the other's.
    // They have to be edited together, and nothing else in the repo would notice if they
    // weren't: a missing hook is invisible by design (a correctly-wired hook and an unwired
    // one look identical — CLAUDE.md), so drift here would be silent indefinitely.
    run() {
      const findings = [];
      const files = {
        'claude (.claude/settings.json)': path.join(REPO, '.claude', 'settings.json'),
        'codex (.codex/hooks.json)': path.join(REPO, '.codex', 'hooks.json'),
      };
      const parsed = {};
      for (const [label, file] of Object.entries(files)) {
        if (!existsSync(file)) {
          findings.push(`${rel(file)} is missing — ${label.split(' ')[0]} would run none of the lifecycle hooks`);
          continue;
        }
        try {
          parsed[label] = hookCommands(file);
        } catch (e) {
          findings.push(`${rel(file)}: unreadable (${e.message})`);
        }
      }
      const labels = Object.keys(parsed);
      if (labels.length === 2) {
        const [a, b] = labels;
        const events = [...new Set([...Object.keys(parsed[a]), ...Object.keys(parsed[b])])].sort();
        for (const ev of events) {
          const ca = (parsed[a][ev] ?? []).join(' | ');
          const cb = (parsed[b][ev] ?? []).join(' | ');
          if (ca !== cb) {
            findings.push(`${ev}: registrations differ`);
            findings.push(`    ${a}: ${ca || '(none)'}`);
            findings.push(`    ${b}: ${cb || '(none)'}`);
          }
        }
      }
      // The scripts themselves must exist — a registration naming a deleted file fails silently.
      for (const map of Object.values(parsed)) {
        for (const cmds of Object.values(map)) {
          for (const c of cmds) {
            const m = c.match(/scripts\/hooks\/[A-Za-z0-9._-]+/);
            if (m && !existsSync(path.join(REPO, m[0]))) findings.push(`${m[0]} is registered but does not exist`);
          }
        }
      }
      const n = Object.values(parsed)[0] ? Object.values(Object.values(parsed)[0]).flat().length : 0;
      return { findings, summary: `${n} hooks, both hosts agree` };
    },
  },

  {
    id: 'memory-slug',
    // CLAUDE-SPECIFIC, on purpose (ORBI-79). Codex publishes no equivalent filesystem contract
    // for project memory, so there is no second half to add here — see CLAUDE.md, "Two hosts".
    // Claude Code looks for project memory at ~/.claude/projects/<slug>/memory, where the
    // slug is the absolute repo path with separators replaced. Derive it — never hardcode
    // it — because a path or username change silently moves it, and the repo looks perfectly
    // healthy from the inside while Claude sees no memory at all.
    run() {
      const slug = REPO.replace(/\//g, '-');
      const link = path.join(HOME, '.claude', 'projects', slug, 'memory');
      const target = path.join(REPO, 'context', 'memory');
      const findings = [];

      const content = contentState(path.join('context', 'memory'));
      if (content.absent) return { findings: [], summary: 'no project memory in this workspace' };
      if (!existsSync(target)) {
        return { findings: [`${rel(target)} is tracked in git but missing on disk`], summary: '' };
      }
      const count = readdirSync(target).filter((f) => f.endsWith('.md')).length;

      const st = linkState(link, target);
      if (!st.ok) {
        findings.push(`${link}: ${st.why}`);
        // A real directory here is the nastiest variant: Claude Code reads it happily, so
        // memory looks fine while the repo copy silently diverges. Show the divergence.
        if (st.why.startsWith('not a symlink') && existsSync(link)) {
          const other = readdirSync(link).filter((f) => f.endsWith('.md')).length;
          findings.push(`  it holds ${other} .md files; the repo holds ${count} — these are two separate copies`);
        }
        findings.push(`  slug derived from this checkout: ${slug}`);
        findings.push('  fix: context/bootstrap.sh');
      }
      return { findings, summary: `${count} files, slug matches` };
    },
  },

  {
    id: 'index',
    // Reuse, don't reimplement: build-project-index.mjs already has a --check mode.
    // Every generator gets a verify mode and the doctor just runs all of them.
    run() {
      const projects = contentState('projects');
      if (projects.absent) return { findings: [], summary: 'no projects/ in this workspace' };
      try {
        execFileSync(process.execPath, [path.join(REPO, 'scripts', 'build-project-index.mjs'), '--check'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { findings: [], summary: 'projects/README.md up to date' };
      } catch (e) {
        const msg = (e.stderr || e.stdout || String(e)).trim().split('\n')[0];
        return { findings: [msg], summary: 'stale' };
      }
    },
  },

  {
    id: 'frontmatter',
    run() {
      const findings = [];
      if (KEY.error) findings.push(KEY.error);
      const plans = planFiles();
      const ids = new Set(plans.map((p) => p.id));
      for (const p of plans) {
        if (!p.file) { findings.push(`${p.id}: no plan.md or recommendation.md`); continue; }
        const fm = readFrontmatter(readFileSync(p.file, 'utf8'));
        const at = `${p.id}/${p.name}`;
        if (!fm) { findings.push(`${at}: no frontmatter`); continue; }
        if (!ALL_STATUSES.includes(fm.status)) {
          findings.push(`${at}: status "${fm.status ?? '(missing)'}" not one of ${ALL_STATUSES.join(', ')}`);
        }
        if (!isDate(fm.opened)) findings.push(`${at}: opened "${fm.opened ?? '(missing)'}" is not YYYY-MM-DD`);
        // `closed` is present exactly when the work is done — the frontmatter convention in
        // claude/CLAUDE.md. Either half missing means status and reality have drifted.
        if (fm.status === 'done' && !isDate(fm.closed)) {
          findings.push(`${at}: status done but closed is "${fm.closed ?? '(missing)'}"`);
        }
        if (fm.status !== 'done' && fm.closed) {
          findings.push(`${at}: closed ${fm.closed} but status is ${fm.status}`);
        }
        if (fm.epic && !ids.has(fm.epic)) findings.push(`${at}: epic ${fm.epic} does not exist`);
      }
      return { findings, summary: `${plans.length} plans valid (key ${KEY.key ?? "—"}: ${KEY.how})` };
    },
  },

  {
    id: 'paths',
    // ORBI-65 defect 1: the clone moved and stranded every written-down path, including
    // every command in the new-machine setup. That was PROSE, not config, which is why this
    // scans markdown too.
    //
    // SCOPED TO PATHS THAT NAME THIS WORKSPACE — i.e. containing an `orbi` segment, derived
    // from basename(ORBI), never hardcoded. Without that scope the check flags every
    // `~/.claude/skills`, `~/.agents/skills` and `~/.nvm/nvm.sh` in the setup docs, which are DESTINATIONS the
    // bootstrap creates, not stale references. On a fresh un-bootstrapped clone that was 34
    // findings burying 7 real ones — and a new machine is exactly when this has to be
    // readable. See projects/ORBI-66/plan.md.
    //
    // projects/** is excluded: plans are append-only history, and a plan that records the
    // path as it was in 2026-03 is correct, not stale. Lines that deliberately name a
    // historical path carry an inline `doctor:ignore-path` marker.
    run() {
      const findings = [];
      const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean)
        .filter((f) => !f.startsWith('projects/'))
        .filter((f) => /\.(md|sh|json|mjs|js|ya?ml|txt)$/.test(f));

      const re = /(?:~|\/Users\/[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)+/g;
      // BOTH names, or this check goes blind exactly when it matters (ORBI-81). It used to
      // scope to basename(ORBI) alone, which covered every path worth scanning only while the
      // workspace lived INSIDE the ecosystem directory. Once the workspace is a sibling, its
      // own paths no longer carry that segment, and the check designed to catch a moved clone
      // would silently skip every path naming the moved clone.
      //
      // No illustrative absolute path in this comment, deliberately: an example naming a real
      // directory is itself scanned, and would fail the moment that directory is the one being
      // renamed. Found by the ORBI-81 negative test, which flagged this very line.
      const names = [...new Set([ORBI && path.basename(ORBI), path.basename(REPO)].filter(Boolean))];
      let scanned = 0;
      for (const f of files) {
        const lines = readFileSync(path.join(REPO, f), 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (line.includes(IGNORE_MARKER)) return;
          for (const m of line.match(re) ?? []) {
            const raw = m.replace(/[.,;:)\]]+$/, '');
            const segs = raw.split('/');
            if (!names.some((n) => segs.includes(n))) continue;
            scanned++;
            const abs = raw.startsWith('~') ? path.join(HOME, raw.slice(1)) : raw;
            if (!existsSync(abs)) findings.push(`${f}:${i + 1}: ${raw} does not exist on this machine`);
          }
        });
      }
      if (findings.length) {
        findings.push(`  if the path is deliberately historical, add a \`${IGNORE_MARKER}\` marker to the line`);
      }
      const label = names.map((n) => `\`${n}\``).join(' + ');
      return { findings, summary: `${scanned} ${label} paths in ${files.length} live files` };
    },
  },

  {
    id: 'machinery',
    // ORBI-81. The split's own new failure mode: a workspace consumes the machinery from a
    // sibling clone, so that clone can be missing, half-migrated, or pointed at two different
    // places at once. None of that is visible from inside this repo without looking.
    //
    // This is the one check that leaves the workspace, and it is in scope because the machinery
    // is a DEPENDENCY rather than a governed repo — without it, nothing here runs at all.
    // Still offline: whether that clone is behind origin is the origin-check hook's job.
    run() {
      const findings = [];
      const roots = new Set();
      let links = 0;

      const scan = (relDir) => {
        const dir = path.join(REPO, relDir);
        if (!existsSync(dir)) return;
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          if (!d.isSymbolicLink()) continue;
          const link = path.join(dir, d.name);
          if (!existsSync(link)) {
            findings.push(`${relDir}/${d.name}: DANGLING -> ${readlinkSafe(link)}`);
            continue;
          }
          const target = realpathSync(link);
          if (target.startsWith(REPO + path.sep)) continue;   // an internal link, not machinery
          links++;
          // Walk up from the target to whatever holds a marker: that is the machinery root.
          let dir2 = path.dirname(target);
          for (;;) {
            if (existsSync(path.join(dir2, MARKER_NAME))) { roots.add(dir2); break; }
            const up = path.dirname(dir2);
            if (up === dir2) { roots.add('(no marker above ' + target + ')'); break; }
            dir2 = up;
          }
        }
      };
      // A workspace may link the whole directory (`ln -s ../orbex/scripts scripts`) or each
      // file inside it. Check both, or the whole-directory form reads as "self-contained".
      const consider = (rel) => {
        const abs = path.join(REPO, rel);
        let st; try { st = lstatSync(abs); } catch { return false; }
        if (!st.isSymbolicLink()) return false;
        if (!existsSync(abs)) { findings.push(`${rel}: DANGLING -> ${readlinkSafe(abs)}`); return true; }
        const target = realpathSync(abs);
        if (target.startsWith(REPO + path.sep)) return true;
        links++;
        let dir2 = target;
        for (;;) {
          if (existsSync(path.join(dir2, MARKER_NAME))) { roots.add(dir2); break; }
          const up = path.dirname(dir2);
          if (up === dir2) { roots.add(`(no marker above ${target})`); break; }
          dir2 = up;
        }
        return true;
      };
      for (const d of ['scripts', 'scripts/hooks', 'context', '.claude/skills']) {
        if (!consider(d)) scan(d);   // a linked directory is the answer; don't also scan inside it
      }

      if (links === 0) return { findings, summary: 'self-contained — no machinery consumed' };
      if (roots.size > 1) {
        findings.push(`machinery links point at ${roots.size} different roots — a half-migrated workspace:`);
        for (const r of roots) findings.push(`    ${r}`);
      }
      const root = [...roots][0];
      if (roots.size === 1 && !existsSync(path.join(String(root), '.git'))) {
        findings.push(`${root} is not a git checkout — it cannot be updated or verified`);
      }
      return { findings, summary: `${links} links consumed from ${root}` };
    },
  },

  {
    id: 'backlog',
    // NOTE: this is the INVERSE of what projects/ORBI-65/orbi-claude-roadmap.md proposed.
    // That spec said "flag backlog items naming a project that is now done" — measured
    // against the real BACKLOG.md that fires on ~10 lines, all of them legitimate
    // provenance ("the last piece of ORBI-63", "scoped out of ORBI-62").
    //
    // The defect actually being reached for is a backlog line left behind when work
    // GRADUATED to a project — and a graduated project is active/open, not done. Hence:
    // flag lines naming a currently-OPEN project. Do not "fix" this back.
    run() {
      const st = contentState('BACKLOG.md');
      if (st.absent) return { findings: [], summary: 'no BACKLOG.md in this workspace' };
      if (!existsSync(st.abs)) return { findings: ['BACKLOG.md is tracked in git but missing on disk'], summary: '' };
      const file = st.abs;
      const status = projectStatuses();
      const findings = [];
      let items = 0;
      let section = null;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const h = line.match(/^##\s+(.+?)\s*$/);
        if (h) { section = h[1]; return; }
        // "Accepted / won't fix" is a record of decisions, not open work — it may name
        // anything without implying a duplicate.
        if (!section || /accepted/i.test(section)) return;
        if (/^-\s+\[ \]/.test(line)) items++;
        for (const id of (KEY.key && line.match(new RegExp(`\\b${KEY.key}-\\d+\\b`, 'g'))) || []) {
          if (OPEN_STATUSES.includes(status.get(id))) {
            findings.push(`BACKLOG.md:${i + 1}: names ${id}, which is ${status.get(id)} — the plan is the record now; delete the line`);
          }
        }
      });
      return { findings, summary: `${items} open items, none duplicating a live project` };
    },
  },

  {
    id: 'memory-index',
    // MEMORY.md is the index loaded into context each session. A file with no row is
    // invisible; a row with no file is a promise of a fact that isn't there.
    //
    // Deliberately NOT checked: [[wikilinks]] pointing at memories that don't exist. The
    // memory convention says a dangling link is a valid marker for a memory worth writing,
    // so flagging it would be a false alarm by design.
    run() {
      const st = contentState(path.join('context', 'memory'));
      if (st.absent) return { findings: [], summary: 'no project memory in this workspace' };
      const dir = path.join(REPO, 'context', 'memory');
      // An empty memory directory is memory not in use yet, not a missing index. Demanding
      // MEMORY.md there made a freshly-created workspace red on its first run (ORBI-81).
      if (readdirSync(dir).filter((f) => f.endsWith('.md')).length === 0) {
        return { findings: [], summary: 'no memory files yet' };
      }
      const index = path.join(dir, 'MEMORY.md');
      if (!existsSync(index)) return { findings: [`${rel(index)} is missing`], summary: 'no index' };

      const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
      const rows = [];
      for (const line of readFileSync(index, 'utf8').split('\n')) {
        const m = line.match(/^\|\s*([A-Za-z0-9._-]+\.md)\s*\|/);
        if (m) rows.push(m[1]);
      }
      const findings = [];
      for (const f of files) if (!rows.includes(f)) findings.push(`${f}: on disk but no row in MEMORY.md`);
      for (const r of rows) if (!files.includes(r)) findings.push(`${r}: row in MEMORY.md but no such file`);
      const dupes = rows.filter((r, i) => rows.indexOf(r) !== i);
      for (const d of new Set(dupes)) findings.push(`${d}: listed more than once in MEMORY.md`);
      return { findings, summary: `${rows.length} rows = ${files.length} files` };
    },
  },

  {
    id: 'memory-volatility',
    // ORBI-74. SCHEMA ONLY — deliberately does NOT flag a memory as overdue for review.
    //
    // A stale-review finding cannot be fixed now: re-verifying a fact against a live system
    // is real work. Since this script has no warning tier (rejected in ORBI-66) and runs on
    // every session start, an unfixable finding would mean a permanently red doctor, which
    // trains you to ignore it — the exact failure the no-warning-tier rule exists to prevent.
    // So "which memories are overdue" is reported by `next.mjs`, where work gets picked up.
    //
    // Everything below is fixable in seconds, which is the bar for belonging here.
    //
    // No default for `volatility`: the classification IS the value, and a default is a way of
    // not making it (ORBI-74 decision B). Fields are top-level, not under `metadata`, because
    // readFrontmatter is intentionally a flat parser and `type` under `metadata` is already
    // invisible to it — putting them at the top level needs no change to a parser the
    // frontmatter check depends on.
    run() {
      const st = contentState(path.join('context', 'memory'));
      if (st.absent) return { findings: [], summary: 'no project memory in this workspace' };
      const dir = path.join(REPO, 'context', 'memory');
      if (!existsSync(dir)) return { findings: [`${rel(dir)} is tracked in git but missing on disk`], summary: '' };
      const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
      const findings = [];
      let volatile_ = 0;
      for (const f of files) {
        const fm = readFrontmatter(readFileSync(path.join(dir, f), 'utf8'));
        // A missing/!malformed frontmatter block is the memory-slug check's business, not ours.
        if (!fm) continue;
        if (!VOLATILITY.includes(fm.volatility)) {
          findings.push(`${f}: volatility "${fm.volatility ?? '(missing)'}" not one of ${VOLATILITY.join(' | ')}`);
          continue;
        }
        if (fm.volatility === 'volatile') {
          volatile_++;
          if (!isDate(fm.reviewed)) {
            findings.push(`${f}: volatile but reviewed is "${fm.reviewed ?? '(missing)'}" — needs YYYY-MM-DD`);
          }
        } else if (fm.reviewed) {
          // A review date on a durable fact implies a clock that nothing reads, and would
          // quietly rot into a claim nobody made.
          findings.push(`${f}: durable but carries reviewed ${fm.reviewed} — drop it, or mark it volatile`);
        }
      }
      return {
        findings,
        summary: `${files.length} classified, ${volatile_} volatile (review window ${REVIEW_WEEKS}w, reported by /o-next)`,
      };
    },
  },
];

// ---- run ---------------------------------------------------------------------

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
if (only && !CHECKS.some((c) => c.id === only)) {
  console.error(`unknown check "${only}" — try: ${CHECKS.map((c) => c.id).join(', ')}`);
  process.exit(2);
}
const selected = only ? CHECKS.filter((c) => c.id === only) : CHECKS;

const results = selected.map((c) => {
  try {
    const { findings, summary } = c.run();
    return { id: c.id, findings, summary };
  } catch (e) {
    // A check that throws is a FINDING, never a skip. Swallowing it here would be the
    // broken-checker-reporting-green failure this whole script exists to prevent.
    return { id: c.id, findings: [`check crashed: ${e.message}`], summary: 'crashed' };
  }
});

const total = results.reduce((n, r) => n + r.findings.length, 0);

if (argv.includes('--json')) {
  console.log(JSON.stringify({
    repo: REPO, repoResolvedBy: REPO_HOW,
    ecosystemRoot: ORBI, ecosystemResolvedBy: ORBI_HOW,
    ok: total === 0, findings: total, checks: results,
  }, null, 2));
  process.exit(total ? 1 : 0);
}

const w = Math.max(...selected.map((c) => c.id.length));
// Print WHICH tree was checked, and how it was chosen (ORBI-81). The machinery is a symlink
// into a sibling repo, so "the doctor was green" is only meaningful alongside "green about
// what?" — a checker examining the wrong tree passing quietly is the failure this file's
// header calls worse than having no checker at all.
const L = ['', 'ORBEX WORKSPACE DOCTOR', '='.repeat(60),
  `  workspace  ${REPO}`,
  `             via ${REPO_HOW}`,
  `  ecosystem  ${ORBI ?? '(none)'}  (${ORBI_HOW})`,
  '-'.repeat(60)];
for (const r of results) {
  const bad = r.findings.length > 0;
  L.push(`  ${(bad ? 'FAIL' : 'ok').padEnd(5)} ${r.id.padEnd(w)}  ${bad ? '' : r.summary}`);
  for (const f of r.findings) L.push(`  ${' '.repeat(5)} ${' '.repeat(w)}  ${f}`);
}
L.push('');
L.push('-'.repeat(60));
L.push(total === 0
  ? `${results.length} checks passed. Note: this machine only — it says nothing about origin or the other laptop.`
  : `${total} finding${total === 1 ? '' : 's'} — fix them, or fix the check. There is no warning tier.`);
L.push('');
console.log(L.join('\n'));
process.exit(total ? 1 : 0);
