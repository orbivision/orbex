#!/usr/bin/env node
// List the workspace's skill commands, lifecycle first, each with a one-line summary. ORBI-87.
//
//   node scripts/help.mjs            # human-readable, spelled /o-* (Claude Code)
//   node scripts/help.mjs --codex    # spelled $o-*
//   node scripts/help.mjs --json     # machine-readable
//
// DERIVED, like projects/README.md: it reads .claude/skills/*/SKILL.md every time and keeps no
// list of its own. A hand-written help page is one more skills table to forget on the next
// skill added — and the hand-written tables in both READMEs already are that.
//
// Where each piece comes from:
//   - the command      — the skill's DIRECTORY name (that is what the host turns into /o-x)
//   - the summary      — the description cut at its first ` — ` or sentence end. A heuristic,
//                        not a field: frontmatter is `name` + `description` only (ORBI-79), so a
//                        `summary:` key would break the portability rule. Capped so a bad cut
//                        stays visible without wrecking the layout.
//   - the grouping     — `lifecycle:` in the workspace's .orbex-workspace marker, in display
//                        order. It is workspace data because the lifecycle skills are mostly
//                        workspace-specific (deploys, tests, releases). Everything NOT listed is
//                        a utility, so a new skill can land in the wrong group but never vanish.
//
// Problems are WARNINGS, printed, never fatal: help that refuses to print helps no one.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveWorkspace, readMarker, MARKER } from './lib/workspace.mjs';

const args = new Set(process.argv.slice(2));
const SIGIL = args.has('--codex') ? '$' : '/';
const SUMMARY_MAX = 100;

const { root: REPO } = resolveWorkspace();
const SKILLS = path.join(REPO, '.claude', 'skills');

// Same trap as doctor.mjs's skillDirs(): a consumed skill is a SYMLINK to a directory, which
// `withFileTypes` reports as a symlink — so statSync, which follows it, decides.
function skillDirs() {
  if (!existsSync(SKILLS)) return [];
  return readdirSync(SKILLS)
    .filter((n) => { try { return statSync(path.join(SKILLS, n)).isDirectory(); } catch { return false; } })
    .sort();
}

function description(dir) {
  let src;
  try { src = readFileSync(path.join(SKILLS, dir, 'SKILL.md'), 'utf8'); } catch { return null; }
  if (!src.startsWith('---\n')) return null;
  const head = src.slice(4, src.indexOf('\n---', 4));
  const raw = head.match(/^description:\s*(.*)$/m)?.[1]?.trim();
  return raw ? raw.replace(/^(['"])(.*)\1$/, '$2') : null;
}

function summarize(desc) {
  const cut = desc.split(' — ')[0].split(/\.\s/)[0].replace(/\.$/, '').trim();
  return cut.length > SUMMARY_MAX ? cut.slice(0, SUMMARY_MAX - 1).trimEnd() + '…' : cut;
}

const warnings = [];
const skills = new Map();
for (const dir of skillDirs()) {
  const desc = description(dir);
  if (!desc) warnings.push(`${dir}: no description in SKILL.md frontmatter`);
  skills.set(dir, desc ? summarize(desc) : '(no description)');
}

const declared = readMarker(REPO).lifecycle;
const order = declared ? declared.split(',').map((s) => s.trim()).filter(Boolean) : [];
for (const n of order) {
  if (!skills.has(n)) warnings.push(`lifecycle: lists ${n}, but there is no .claude/skills/${n}`);
}
const lifecycle = order.filter((n) => skills.has(n)).map((name) => ({ name, summary: skills.get(name) }));
const utilities = [...skills].filter(([n]) => !order.includes(n)).map(([name, summary]) => ({ name, summary }));

if (args.has('--json')) {
  console.log(JSON.stringify({ root: REPO, lifecycle, utilities, warnings }, null, 2));
  process.exit(0);
}

if (skills.size === 0) {
  console.log(`No skills in ${path.relative(process.cwd(), SKILLS) || SKILLS}.`);
  process.exit(0);
}

const width = Math.max(...[...skills.keys()].map((n) => n.length)) + 1;
const line = ({ name, summary }) => `  ${(SIGIL + name).padEnd(width + 2)} ${summary}`;
const out = [];
if (declared) {
  out.push('Project lifecycle — in the order a project passes through them', ...lifecycle.map(line), '');
  out.push('Utilities', ...utilities.map(line));
} else {
  out.push('Skills', ...utilities.map(line), '',
    `(No \`lifecycle:\` in ${MARKER}, so nothing is grouped. List the lifecycle skills there, in order.)`);
}
if (warnings.length) out.push('', ...warnings.map((w) => `! ${w}`));
out.push('', `Claude Code spells these /o-*, Codex $o-*. The host's own /help lists everything else.`);
console.log(out.join('\n'));
