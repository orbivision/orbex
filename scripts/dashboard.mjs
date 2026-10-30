#!/usr/bin/env node
// A static progress page for the workspace — generated, never stored. ORBI-86.
//
//   node scripts/dashboard.mjs              # write $TMPDIR/orbex-dashboard-<workspace>.html
//   node scripts/dashboard.mjs --open       # …and open it
//   node scripts/dashboard.mjs --out f.html # write somewhere else
//   node scripts/dashboard.mjs --no-gh      # skip the GitHub Issues inbox (offline)
//
// THIS IS A RENDERER, NOT A SOURCE. It reads no plan, backlog or memory file itself: it runs
// `next.mjs --json` and `build-project-index.mjs --json` and draws what they say. If the page
// needs a field, the field goes into one of those two producers. A third frontmatter reader is
// a third thing that can disagree, and a dashboard that keeps its own status is the fourth list
// the tracking design forbids — which is also why the default output is a temp file rather
// than something committed: there is nothing here to drift, only something to regenerate.
//
// Errors are shown, never zeroed. next.mjs reports `inboxError`/`memoryReviewError` so an outage
// can't read as "empty" (the 2026-08-30 label-filter lesson); a chart that dropped them would
// bring that failure back in a nicer font.
//
// Dependency-free and self-contained: inline CSS, inline SVG (the Orbex logo is read from
// ../assets and inlined), native <title> tooltips, <details> table views. Dark by default; the
// only JavaScript is the light/dark toggle, which remembers the choice per browser. Without it
// the page is simply dark, with every chart and table intact.

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { resolveWorkspace } from './lib/workspace.mjs';

const { root: REPO } = resolveWorkspace();
const NAME = path.basename(REPO);
// The producers are siblings of THIS file (the machinery), run against REPO (the workspace).
// ORBEX_WORKSPACE pins them to the same tree we resolved, whatever their own cwd logic finds.
const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const OUT = path.resolve(outArg ?? path.join(tmpdir(), `orbex-dashboard-${NAME}.html`));

function produce(script, extra = []) {
  const out = execFileSync(process.execPath, [path.join(HERE, script), '--json', ...extra], {
    cwd: REPO,
    env: { ...process.env, ORBEX_WORKSPACE: REPO },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

let next, index;
try {
  next = produce('next.mjs', flag('--no-gh') ? ['--no-gh'] : []);
  index = produce('build-project-index.mjs');
} catch (e) {
  // A producer failing is the producer's message to show — e.g. an ambiguous project key.
  console.error(`dashboard.mjs: ${(e.stderr || e.message).trim()}`);
  process.exit(1);
}

function git(...a) {
  try { return execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
const SHA = git('rev-parse', '--short', 'HEAD');
const DIRTY = !!git('status', '--porcelain');

// Plan links go to GitHub, which renders the markdown, rather than to file:// — a browser shows
// a local .md as raw text at best, and Safari refuses file→file navigation outright, so those
// links looked dead. Derived from the origin remote like next.mjs's inbox, never written down.
// `--show-prefix` covers a workspace that is a subdirectory of its repo (the sample one).
// No GitHub origin → file:// is still the best there is.
const GH = (() => {
  const m = git('remote', 'get-url', 'origin')?.match(/github\.com[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  return m && branch && branch !== 'HEAD'
    ? `https://github.com/${m[1]}/${m[2]}/blob/${encodeURIComponent(branch)}/${git('rev-parse', '--show-prefix') ?? ''}`
    : null;
})();

// ---- dates -------------------------------------------------------------------
// Frontmatter dates are local calendar days. Treat them as whole UTC days so "opened and closed
// the same day" is 0 in every timezone, rather than a fraction that rounds either way.
const DAY = 86400000;
const toDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : null);
const now = new Date();
const TODAY = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
const fmt = (t) => new Date(t).toISOString().slice(0, 10);
const short = (t) => new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---- html helpers --------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Backlog/inbox titles carry markdown backticks; render them as code, everything else as text.
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const planHref = (file) => (GH ? GH + file.split('/').map(encodeURIComponent).join('/') : pathToFileURL(path.join(REPO, file)).href);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function table(head, rows) {
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
const tableView = (head, rows) => `<details class="tv"><summary>Table view</summary>${table(head, rows)}</details>`;

// ---- derived numbers -------------------------------------------------------------
const projects = index.projects;
const STATUSES = ['blocked', 'active', 'open', 'done', 'dropped'];
const counts = Object.fromEntries(STATUSES.map((s) => [s, projects.filter((p) => p.status === s).length]));
const done = projects.filter((p) => p.status === 'done' && toDay(p.closed) != null && toDay(p.opened) != null);
const cycle = done.map((p) => (toDay(p.closed) - toDay(p.opened)) / DAY).sort((a, b) => a - b);
const pct = (q) => (cycle.length ? cycle[Math.min(cycle.length - 1, Math.floor(q * cycle.length))] : null);

// ---- charts --------------------------------------------------------------------
// Two series at most, in fixed slot order (opened = 1, closed = 2), validated light + dark with
// the dataviz palette validator. Every chart has a legend or a title naming its single series,
// native tooltips, and a table view.

function throughput() {
  const WEEKS = 16;
  // Monday-start weeks ending with the current one.
  const dow = (new Date(TODAY).getUTCDay() + 6) % 7;
  const start = TODAY - dow * DAY - (WEEKS - 1) * 7 * DAY;
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ t: start + i * 7 * DAY, opened: 0, closed: 0 }));
  const bucket = (t) => (t == null || t < start ? null : weeks[Math.floor((t - start) / (7 * DAY))]);
  for (const p of projects) {
    const o = bucket(toDay(p.opened)); if (o) o.opened++;
    if (p.status === 'done') { const c = bucket(toDay(p.closed)); if (c) c.closed++; }
  }
  // Whole-number ticks at an even step, with the axis rounded up to the last one.
  const peak = Math.max(1, ...weeks.flatMap((w) => [w.opened, w.closed]));
  const step = [1, 2, 5, 10, 20, 50].find((s) => peak / s <= 4) ?? Math.ceil(peak / 4);
  const max = Math.ceil(peak / step) * step;
  const W = 720, H = 220, L = 32, B = 28, T = 12, plotW = W - L - 8, plotH = H - B - T;
  const slot = plotW / WEEKS, bw = Math.max(3, (slot - 8) / 2);
  const y = (v) => T + plotH - (v / max) * plotH;
  const ticks = Array.from({ length: max / step + 1 }, (_, i) => i * step);
  let s = ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  weeks.forEach((w, i) => {
    const x0 = L + i * slot + (slot - (bw * 2 + 2)) / 2;
    for (const [k, j] of [['opened', 0], ['closed', 1]]) {
      const v = w[k]; if (!v) continue;
      const h = (v / max) * plotH;
      s += `<path class="s${j + 1}" d="${bar(x0 + j * (bw + 2), T + plotH - h, bw, h)}"><title>Week of ${short(w.t)}: ${v} ${k}</title></path>`;
    }
    if (i % 2 === 0) s += `<text class="axis" x="${L + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle">${short(w.t)}</text>`;
  });
  s += `<line class="base" x1="${L}" x2="${W - 8}" y1="${T + plotH}" y2="${T + plotH}"/>`;
  const tot = weeks.reduce((a, w) => ({ o: a.o + w.opened, c: a.c + w.closed }), { o: 0, c: 0 });
  return `<figure><figcaption><h3>Throughput</h3><p>Projects opened and closed per week, last ${WEEKS} weeks — ${tot.o} opened, ${tot.c} closed.</p>
    <ul class="legend"><li><i class="s1"></i>Opened</li><li><i class="s2"></i>Closed</li></ul></figcaption>
    <div class="plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projects opened and closed per week">${s}</svg></div>
    ${tableView(['Week of', 'Opened', 'Closed'], weeks.map((w) => [fmt(w.t), w.opened, w.closed]))}</figure>`;
}

// A bar with 4px rounded data-end, square on the baseline.
function bar(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function cycleTime() {
  if (!cycle.length) return `<figure><figcaption><h3>Cycle time</h3><p>No closed projects yet.</p></figcaption></figure>`;
  const BUCKETS = [['Same day', 0, 0], ['1–2 days', 1, 2], ['3–7 days', 3, 7], ['1–2 weeks', 8, 14], ['2–4 weeks', 15, 30], ['Over a month', 31, Infinity]];
  const rows = BUCKETS.map(([label, lo, hi]) => ({ label, n: cycle.filter((d) => d >= lo && d <= hi).length }));
  const max = Math.max(1, ...rows.map((r) => r.n));
  const W = 720, rowH = 28, L = 112, R = 48, H = rows.length * rowH + 8;
  let s = '';
  rows.forEach((r, i) => {
    const yy = 4 + i * rowH, w = (r.n / max) * (W - L - R);
    s += `<text class="lab" x="${L - 8}" y="${yy + 18}" text-anchor="end">${r.label}</text>`;
    if (r.n) s += `<path class="s1" d="${hbar(L, yy + 6, w, rowH - 12)}"><title>${r.label}: ${plural(r.n, 'project')}</title></path>`;
    s += `<text class="val" x="${L + w + 6}" y="${yy + 18}">${r.n}</text>`;
  });
  s += `<line class="base" x1="${L}" x2="${L}" y1="0" y2="${H}"/>`;
  const days = (d) => (d == null ? '—' : d === 0 ? 'same day' : plural(Math.round(d), 'day'));
  return `<figure><figcaption><h3>Cycle time</h3><p>Opened → closed for ${plural(cycle.length, 'done project')}. Median <b>${days(pct(0.5))}</b>, 90th percentile <b>${days(pct(0.9))}</b>, longest <b>${days(cycle.at(-1))}</b>.</p></figcaption>
    <div class="plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cycle time distribution">${s}</svg></div>
    ${tableView(['Cycle time', 'Projects'], rows.map((r) => [r.label, r.n]))}</figure>`;
}

// Horizontal bar: square on the baseline (left), rounded data-end (right).
function hbar(x, y, w, h) {
  const r = Math.min(4, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function timeline() {
  const N = 20;
  const recent = projects.filter((p) => toDay(p.opened) != null).sort((a, b) => toDay(b.opened) - toDay(a.opened) || b.num - a.num).slice(0, N);
  if (!recent.length) return '';
  const lo = Math.min(...recent.map((p) => toDay(p.opened))), hi = TODAY;
  const span = Math.max(DAY, hi - lo);
  const W = 720, L = 80, R = 12, rowH = 22, T = 4, H = recent.length * rowH + T + 24;
  const x = (t) => L + ((t - lo) / span) * (W - L - R);
  let s = '';
  // Month gridlines.
  for (let d = new Date(lo); d.getTime() <= hi; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    if (t < lo) continue;
    s += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H - 22}"/><text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">${new Date(t).toLocaleDateString('en', { month: 'short', timeZone: 'UTC' })}</text>`;
  }
  recent.forEach((p, i) => {
    const yy = T + i * rowH;
    const isOpen = p.status !== 'done' && p.status !== 'dropped';
    // A dropped plan has no `closed:` — it gets a stub at its opened date, in neutral grey, so it
    // can't be mistaken for finished work.
    const a = toDay(p.opened), b = isOpen ? TODAY : (toDay(p.closed) ?? a);
    const cls = isOpen ? 's2' : p.status === 'dropped' ? 'sx' : 's1';
    const x0 = x(a), w = Math.max(6, x(b) - x0);
    const tip = `${p.id} — ${p.title} (${p.status}; opened ${p.opened}${p.closed ? `, closed ${p.closed}` : ''})`;
    s += `<a href="${esc(planHref(p.file))}"><text class="lab" x="${L - 8}" y="${yy + 15}" text-anchor="end">${esc(p.id)}</text></a>`;
    s += `<rect class="${cls}" x="${x0}" y="${yy + 5}" width="${w}" height="${rowH - 10}" rx="3"><title>${esc(tip)}</title></rect>`;
  });
  return `<figure><figcaption><h3>Timeline</h3><p>The ${recent.length} most recently opened projects, opened → closed. Open work runs to today.</p>
    <ul class="legend"><li><i class="s1"></i>Closed</li><li><i class="s2"></i>Still open</li>${recent.some((p) => p.status === 'dropped') ? '<li><i class="sx"></i>Dropped</li>' : ''}</ul></figcaption>
    <div class="plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Timeline of recent projects">${s}</svg></div>
    ${tableView(['Project', 'Status', 'Opened', 'Closed'], recent.map((p) => [`${p.id} ${p.title}`, p.status, p.opened, p.closed ?? '—']))}</figure>`;
}

// ---- sections -------------------------------------------------------------------
// The logo comes from the machinery's own assets, so the page and the README can't disagree on
// it. Its wordmark is black in the file; it's handed to CSS so each theme sets the ink
// (#f2f2f2 on dark, as in orbex-logo-on-dark.svg). No file → plain text, never a broken page.
function logo() {
  try {
    const svg = readFileSync(path.join(HERE, '..', 'assets', 'orbex-logo.svg'), 'utf8');
    // Sized from its viewBox to a 44 px height. (The first attempt looked like a sizing bug and
    // was really the charts' global `svg{width:100%}` rule catching the logo — now `.plot svg`.)
    const [, , vw, vh] = (svg.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 3 1').split(/\s+/).map(Number);
    const H = 44;
    return svg
      .replace(/\s(width|height)="[^"]*"/g, '')
      .replace('<svg ', `<svg class="logo" role="img" aria-label="Orbex" width="${Math.round((H * vw) / vh)}" height="${H}" `)
      .replace('fill="#000000"', 'class="wordmark"');
  } catch {
    return '<p class="logo-text">Orbex</p>';
  }
}

function header() {
  const chips = STATUSES.filter((s) => counts[s]).map((s) => `<li class="chip ${s}"><b>${counts[s]}</b> ${s}</li>`).join('');
  const stamp = `Generated ${esc(new Date().toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }))}` +
    (SHA ? ` from <code>${SHA}</code>${DIRTY ? ' + uncommitted changes' : ''}` : '');
  return `<header><div class="top">${logo()}<button class="theme" type="button" hidden></button></div>
    <h1>${esc(NAME)}</h1>
    <p class="sub">${plural(projects.length, 'project')} · key <code>${esc(index.key ?? '—')}</code></p>
    <ul class="chips">${chips}</ul><p class="stamp">${stamp}. Regenerate to refresh — this page is never the source.</p></header>`;
}

function inFlight() {
  const open = next.projects;
  if (!open.length) return `<section><h2>In flight</h2><p class="empty">Nothing open. Every numbered project is closed out.</p></section>`;
  const cards = open.map((p) => {
    const full = projects.find((q) => q.id === p.id) ?? p;
    const age = toDay(p.opened) != null ? Math.round((TODAY - toDay(p.opened)) / DAY) : null;
    return `<li class="card"><a href="${esc(planHref(p.file))}"><span class="id">${esc(p.id)}</span> ${esc(p.title)}</a>
      <p class="meta"><span class="st ${esc(p.status)}">${esc(p.status)}</span>${p.priority ? ` · ${esc(p.priority)} priority` : ''}${age != null ? ` · open ${plural(age, 'day')}` : ''}</p>
      ${full.repos?.length ? `<p class="repos">${full.repos.map((r) => `<code>${esc(r)}</code>`).join(' ')}</p>` : ''}</li>`;
  }).join('');
  return `<section><h2>In flight <span class="n">${open.length}</span></h2><ul class="cards">${cards}</ul></section>`;
}

function backlog() {
  const by = (s) => next.backlog.filter((b) => b.section === s);
  const list = (items) => `<ul class="items">${items.map((b) => `<li>${md(b.title)}</li>`).join('')}</ul>`;
  const sec = (s, open) => {
    const items = by(s);
    if (!items.length) return `<h3>${s} <span class="n">0</span></h3>`;
    return open ? `<h3>${s} <span class="n">${items.length}</span></h3>${list(items)}`
      : `<details><summary><h3>${s} <span class="n">${items.length}</span></h3></summary>${list(items)}</details>`;
  };
  return `<section><h2>Backlog <span class="n">${next.backlog.length}</span></h2>${sec('Now', true)}${sec('Soon', true)}${sec('Someday', false)}</section>`;
}

function inbox() {
  // `--no-gh` is a choice, not a failure — say so plainly rather than in the error colour.
  const skipped = flag('--no-gh');
  const body = skipped
    ? `<p class="empty">Not checked (<code>--no-gh</code>).</p>`
    : next.inboxError
    ? `<p class="err"><b>Couldn't read the inbox:</b> ${esc(next.inboxError)}. This is not the same as empty.</p>`
    : next.inbox.length
      ? `<ul class="items">${next.inbox.map((i) => `<li><a href="${esc(i.url)}">#${esc(i.number)}</a> ${md(i.title)}</li>`).join('')}</ul><p class="note">Untriaged — a decision owed, not work to pick up.</p>`
      : `<p class="empty">Empty — nothing untriaged.</p>`;
  return `<section><h2>Inbox <span class="n">${next.inboxError ? '–' : next.inbox.length}</span></h2>${body}</section>`;
}

function memory() {
  const body = next.memoryReviewError
    ? `<p class="err"><b>Couldn't read memory:</b> ${esc(next.memoryReviewError)}.</p>`
    : next.memoryReview.length
      ? `<ul class="items">${next.memoryReview.map((m) => `<li><code>${esc(m.file)}</code> — ${m.days == null ? `unreadable reviewed date (${esc(m.reviewed ?? 'missing')})` : `reviewed ${esc(m.reviewed)}, ${m.days} days ago`}</li>`).join('')}</ul><p class="note">Re-verify against reality before bumping a date.</p>`
      : `<p class="empty">No volatile fact is overdue.</p>`;
  return `<section><h2>Memory review <span class="n">${next.memoryReviewError ? '–' : next.memoryReview.length}</span></h2>${body}</section>`;
}

function problems() {
  if (!index.problems.length) return '';
  return `<section><h2>Problems in the plans</h2><ul class="items err">${index.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></section>`;
}

// ---- page -----------------------------------------------------------------------
const CSS = `
/* Dark is the default; [data-theme="light"] is the toggle's other state. Brand: the logo's
   magenta #CF27E0 is series 1 in both modes, burnt orange #D9681F series 2 (user's pick over
   teal, amber, coral and lime). The pair passes the dataviz validator — lightness band, CVD
   (27.6 deutan), normal-vision, 3:1 contrast — on each mode's surface. Blues all FAIL CVD
   against this magenta (1.3–4.3): red-green colour-blind viewers see them as the same hue. */
:root{color-scheme:dark;--page:#120f15;--surface:#1b1720;--ink:#f4eff6;--ink-2:#c9c0cd;--muted:#a39aa8;--axis:#8d8492;--grid:#2e2833;--base:#443c4a;--ring:rgba(255,255,255,.10);
  --s1:#CF27E0;--s2:#D9681F;--accent:#E27AF0;--brand:#CF27E0;--err:#ff8a80;--err-bg:#2c1518;--code:#2a2430;--logo-ink:#f2f2f2}
:root[data-theme="light"]{color-scheme:light;--page:#f7f2f8;--surface:#fdfbfd;--ink:#120f15;--ink-2:#4f4754;--muted:#6e6573;--axis:#857c8a;--grid:#ebe3ee;--base:#cfc5d3;--ring:rgba(18,15,21,.10);
  --s1:#CF27E0;--s2:#D9681F;--accent:#A11AB0;--brand:#CF27E0;--err:#b42318;--err-bg:#fdf0ee;--code:#f1e9f3;--logo-ink:#000000}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 64px}
a{color:inherit;text-underline-offset:2px}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 4px;border-radius:4px}
h1{font-size:2rem;margin:.1em 0 .1em;letter-spacing:-.01em}
h2{font-size:1.15rem;margin:0 0 12px}
a:hover{color:var(--accent)}
h3{font-size:1rem;margin:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}
.logo{display:block;flex:none}
.logo .wordmark{fill:var(--logo-ink)}
.logo-text{margin:0;font-size:1.6rem;font-weight:700;color:var(--brand)}
.theme{font:inherit;font-size:.85rem;color:var(--ink-2);background:var(--surface);border:1px solid var(--ring);border-radius:999px;padding:6px 14px;cursor:pointer}
.theme:hover{color:var(--ink);border-color:var(--accent)}
.theme:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sub,.stamp,.note,figcaption p{color:var(--ink-2);margin:.25em 0}
.stamp{font-size:.85rem;color:var(--muted)}
.n{color:var(--muted);font-weight:500;margin-left:4px}
header{margin-bottom:24px;padding-bottom:20px;border-bottom:2px solid var(--brand)}
.chips{list-style:none;padding:0;margin:12px 0;display:flex;flex-wrap:wrap;gap:8px}
.chip{background:var(--surface);border:1px solid var(--ring);border-radius:999px;padding:4px 12px;color:var(--ink-2)}
.chip b{color:var(--accent)}
section,figure{background:var(--surface);border:1px solid var(--ring);border-radius:12px;padding:20px;margin:0 0 16px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid2>section{margin:0}
@media (max-width:760px){.grid2{grid-template-columns:1fr}}
.cards{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{border:1px solid var(--ring);border-top:3px solid var(--brand);border-radius:10px;padding:12px 14px}
.card a{font-weight:600;text-decoration:none}
.card a:hover{text-decoration:underline;text-decoration-color:var(--accent)}
.id{color:var(--muted);font-weight:500}
.meta,.repos{margin:6px 0 0;font-size:.88rem;color:var(--ink-2)}
.st{font-weight:600;color:var(--accent)}
.items{margin:8px 0 12px;padding-left:20px}
.items li{margin:2px 0}
details>summary{cursor:pointer;list-style:none}
details>summary::-webkit-details-marker{display:none}
details>summary h3::before{content:"▸ ";color:var(--muted)}
details[open]>summary h3::before{content:"▾ "}
section h3{margin-top:12px}
.empty{color:var(--muted);margin:0}
.err{color:var(--err);background:var(--err-bg);border-radius:8px;padding:8px 12px}
figure{margin:0 0 16px}
figcaption{margin-bottom:8px}
.plot{overflow-x:auto;-webkit-overflow-scrolling:touch}
.plot svg{width:100%;min-width:560px;height:auto;display:block}
svg text{font:12px system-ui,-apple-system,sans-serif}
.axis{fill:var(--axis)} .lab{fill:var(--ink-2)} .val{fill:var(--ink)}
.grid{stroke:var(--grid);stroke-width:1} .base{stroke:var(--base);stroke-width:1}
.s1{fill:var(--s1)} .s2{fill:var(--s2)} .sx{fill:var(--axis)}
svg a:hover text{text-decoration:underline}
.legend{list-style:none;padding:0;margin:6px 0 0;display:flex;gap:16px;font-size:.88rem;color:var(--ink-2)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.legend i.s1{background:var(--s1)} .legend i.s2{background:var(--s2)} .legend i.sx{background:var(--axis)}
.tv{margin-top:8px;font-size:.85rem}
.tv summary{color:var(--muted)}
.tv summary::before{content:"▸ "} .tv[open] summary::before{content:"▾ "}
table{border-collapse:collapse;width:100%;margin-top:8px}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--grid)}
th{color:var(--muted);font-weight:500}
`;

// The choice is a per-viewer convenience, so browser storage is the right home for it — it is
// never data the dashboard reports. Storage can be unavailable (private window, file:// rules);
// then the toggle still works for the visit, it just isn't remembered.
const THEME_KEY = 'orbex-dashboard-theme';
const TOGGLE = `(function(){
  var root=document.documentElement, b=document.querySelector('.theme');
  if(!b) return;
  function label(){var d=root.dataset.theme!=='light';b.textContent=d?'\u2600 Light mode':'\u263E Dark mode';b.setAttribute('aria-label',d?'Switch to light mode':'Switch to dark mode');}
  b.hidden=false; label();
  b.addEventListener('click',function(){
    root.dataset.theme=root.dataset.theme==='light'?'dark':'light'; label();
    try{localStorage.setItem(${JSON.stringify(THEME_KEY)},root.dataset.theme)}catch(e){}
  });
})();`;

const html = `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(NAME)} — progress</title>
<script>try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${CSS}</style></head>
<body><main>
${header()}
${inFlight()}
${throughput()}
${cycleTime()}
${timeline()}
<div class="grid2">${inbox()}${memory()}</div>
${backlog()}
${problems()}
</main>
<script>${TOGGLE}</script>
</body></html>
`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
if (flag('--open')) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [OUT], { detached: true, stdio: 'ignore' }).unref();
}
