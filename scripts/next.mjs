#!/usr/bin/env node
// Everything still open, from all three sources, in one list.
//
//   node scripts/next.mjs            # human-readable
//   node scripts/next.mjs --json     # machine-readable
//   node scripts/next.mjs --no-gh    # skip the GitHub Issues inbox (offline)
//
// Sources, in priority order:
//   1. Projects with a non-done status  — projects/ORBI-N/plan.md frontmatter
//   2. BACKLOG.md                       — Now / Soon / Someday
//   3. Every OPEN GitHub Issue          — captured, untriaged
//
// Note (3) is deliberately *not* filtered by the `inbox` label. Issues are an inbox,
// never a tracker, so an open issue is untriaged by definition — and one captured from
// the mobile app usually arrives with no label at all. Filtering on the label hid three
// real items behind a confident "empty" (2026-08-30), which is the worst possible
// failure for a list whose whole job is to be complete. The label is now a hint, shown
// when missing, never a gate.
//
// Dependency-free on purpose. `gh` failures are non-fatal: the inbox is the least
// important source and being offline shouldn't stop you seeing the other two.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveWorkspace, projectKey, projectDirRe } from './lib/workspace.mjs';

const { root: REPO } = resolveWorkspace();
// ORBI-86: the key is the workspace's, not ours. An ambiguous key is fatal here — a list whose
// job is completeness must not silently show zero projects.
const KEY = projectKey(REPO);
if (KEY.error) { console.error(`next.mjs: ${KEY.error}`); process.exit(1); }
const PROJECT_DIR = projectDirRe(KEY.key);
const OPEN_STATUSES = ['blocked', 'active', 'open'];
const BACKLOG_SECTIONS = ['Now', 'Soon', 'Someday'];
// ORBI-74. A GUESS, mirrored from doctor.mjs's REVIEW_WEEKS — no evidence exists for the right
// interval; let a few months of use correct it. If you change one, change both.
const REVIEW_WEEKS = 8;

// ---- 1. open projects --------------------------------------------------------
function openProjects() {
  const dir = path.join(REPO, 'projects');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || !PROJECT_DIR.test(d.name)) continue;
    const name = ['plan.md', 'recommendation.md'].find((f) =>
      existsSync(path.join(dir, d.name, f)));
    if (!name) continue;
    const src = readFileSync(path.join(dir, d.name, name), 'utf8');
    if (!src.startsWith('---\n')) continue;
    const head = src.slice(4, src.indexOf('\n---', 4));
    const get = (k) => head.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim();
    const status = get('status');
    if (!OPEN_STATUSES.includes(status)) continue;
    const title = (src.match(/^#\s+(.+)$/m)?.[1] ?? d.name)
      .replace(new RegExp(`^${d.name}\\s*[:—-]\\s*`), '');
    out.push({
      id: d.name,
      num: Number(d.name.split('-')[1]),
      title,
      status,
      opened: get('opened'),
      priority: get('priority'),
      file: `projects/${d.name}/${name}`,
    });
  }
  return out.sort((a, b) =>
    OPEN_STATUSES.indexOf(a.status) - OPEN_STATUSES.indexOf(b.status) || a.num - b.num);
}

// ---- 2. backlog --------------------------------------------------------------
function backlog() {
  const file = path.join(REPO, 'BACKLOG.md');
  if (!existsSync(file)) return [];
  const out = [];
  let section = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = BACKLOG_SECTIONS.includes(h[1]) ? h[1] : null; continue; }
    if (!section) continue;
    const m = line.match(/^-\s+\[ \]\s+(.*)$/);
    if (!m) continue;
    const text = m[1].trim();
    const title = text.match(/^\*\*(.+?)\*\*/)?.[1] ?? text.split(' — ')[0];
    out.push({ section, title, text });
  }
  return out;
}

// ---- 3. github issues inbox --------------------------------------------------
// The inbox is THIS workspace's own repo, so derive it from the origin remote rather than
// writing the name down (ORBI-81). A hardcoded `owner/name` is a stale path in a different
// costume: it survives a repo rename silently, because GitHub redirects the old name, and the
// listing keeps working while pointing at the wrong thing for as long as the redirect stands.
function originRepo() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  // git@host:owner/name.git | https://host/owner/name(.git)
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`cannot parse origin remote: ${url}`);
  return `${m[1]}/${m[2]}`;
}

function inbox() {
  try {
    const raw = execFileSync('gh', [
      'issue', 'list', '--repo', originRepo(),
      '--state', 'open',
      '--json', 'number,title,createdAt,url,labels', '--limit', '100',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return {
      items: JSON.parse(raw).map((i) => ({
        ...i,
        labels: i.labels.map((l) => l.name),
        labelled: i.labels.some((l) => l.name === 'inbox'),
      })),
      error: null,
    };
  } catch {
    return { items: [], error: 'could not reach GitHub (offline, `gh` not authed, or no origin remote)' };
  }
}

// ---- 4. memory due for review ------------------------------------------------
// ORBI-74. Staleness is reported HERE, not by /o-doctor: re-verifying a fact against a live
// system is real work, so it is something to pick up, not a broken invariant. The doctor
// checks the schema (every memory declares a volatility; volatile ones carry a `reviewed`
// date) because that is fixable in seconds; ageing is not.
//
// Only `volatile` memories have a clock. A durable fact goes stale when the code changes, and
// changing the code is what prompts the edit.
function memoryReview() {
  const dir = path.join(REPO, 'context', 'memory');
  // Fail LOUD, never empty. next.mjs once filtered issues on a label and hid three real items
  // behind a confident "empty"; for a list whose job is completeness that is the worst outcome.
  if (!existsSync(dir)) return { items: [], error: `no memory directory at ${path.relative(REPO, dir)}` };
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch (e) {
    return { items: [], error: `could not read memory directory: ${e.message}` };
  }
  const cutoffDays = REVIEW_WEEKS * 7;
  const items = [];
  for (const f of files) {
    let src;
    try { src = readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (!src.startsWith('---\n')) continue;
    // Same inline idiom as openProjects() above, deliberately — one frontmatter reader per
    // script beats a second abstraction that has to agree with the first.
    const head = src.slice(4, src.indexOf('\n---', 4));
    const get = (k) => head.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim();
    if (get('volatility') !== 'volatile') continue;
    const reviewed = get('reviewed');
    const t = Date.parse(reviewed ?? '');
    if (Number.isNaN(t)) {
      // The doctor already reports this as a schema finding; surface it rather than skip it,
      // so an unreviewable memory can't hide from both tools.
      items.push({ file: f, reviewed: reviewed ?? null, days: null });
      continue;
    }
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days >= cutoffDays) items.push({ file: f, reviewed, days });
  }
  items.sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity));
  return { items, error: null };
}

// ---- report ------------------------------------------------------------------
const useGh = !process.argv.includes('--no-gh');
const projects = openProjects();
const back = backlog();
const { items: issues, error: ghError } = useGh ? inbox() : { items: [], error: 'skipped (--no-gh)' };
const { items: memDue, error: memError } = memoryReview();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ projects, backlog: back, inbox: issues, inboxError: ghError, memoryReview: memDue, memoryReviewError: memError }, null, 2));
  process.exit(0);
}

const bySection = Object.fromEntries(
  BACKLOG_SECTIONS.map((s) => [s, back.filter((b) => b.section === s)]));
const total = projects.length + back.length + issues.length + memDue.length;

const L = [];
L.push('');
L.push(`OPEN WORK — ${total} item${total === 1 ? '' : 's'}`);
L.push('='.repeat(60));

L.push('');
L.push(`PROJECTS IN FLIGHT (${projects.length})`);
if (!projects.length) L.push('  none — every numbered project is closed out');
for (const p of projects) {
  L.push(`  ${p.id.padEnd(9)} [${p.status}] ${p.title}`);
  L.push(`  ${' '.repeat(9)} opened ${p.opened} · ${p.file}`);
}

for (const s of BACKLOG_SECTIONS) {
  L.push('');
  L.push(`BACKLOG — ${s.toUpperCase()} (${bySection[s].length})`);
  if (!bySection[s].length) L.push('  none');
  for (const b of bySection[s]) L.push(`  · ${b.title}`);
}

L.push('');
L.push(`INBOX — untriaged GitHub Issues (${issues.length})`);
if (ghError) L.push(`  ${ghError}`);
else if (!issues.length) L.push('  empty');
for (const i of issues) {
  L.push(`  #${String(i.number).padEnd(4)} ${i.title}${i.labelled ? '' : '   ← no `inbox` label'}`);
  L.push(`  ${' '.repeat(5)} ${i.createdAt.slice(0, 10)} · ${i.url}`);
}
const unlabelled = issues.filter((i) => !i.labelled).length;
if (unlabelled) {
  L.push('');
  L.push(`  ${unlabelled} open issue${unlabelled === 1 ? '' : 's'} missing the \`inbox\` label — listed anyway.`);
  L.push('  Every open issue is untriaged by definition; the label is a hint, not a filter.');
}

L.push('');
L.push(`MEMORY — volatile facts due for re-checking (${memDue.length})`);
if (memError) L.push(`  ${memError}`);
else if (!memDue.length) L.push(`  none over ${REVIEW_WEEKS} weeks old`);
for (const m of memDue) {
  L.push(m.days === null
    ? `  · ${m.file} — reviewed "${m.reviewed ?? '(missing)'}" is not a date`
    : `  · ${m.file} — last verified ${m.reviewed} (${m.days} days)`);
}
if (memDue.length) {
  L.push('');
  L.push('  Re-verify the fact against reality, then set `reviewed:` to today.');
  L.push('  Bumping the date without re-checking is worse than leaving it overdue.');
}

L.push('');
L.push('-'.repeat(60));
L.push('Triage inbox items into BACKLOG.md or a project, then close the issue.');
L.push('Details for any backlog line live in BACKLOG.md.');
L.push('');
console.log(L.join('\n'));
