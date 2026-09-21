#!/usr/bin/env node
// Stop hook: warn about uncommitted memory and a stale project index.
//
// Stop fires on EVERY turn end (including clear, resume, compact) — not once per session.
// That makes naive warning the central risk here: a message shown on all twenty turns of a
// session stops being read by roughly the third, and an unread warning is worse than none
// because it manufactures the feeling of coverage. Same failure mode ORBI-66 hit twice.
//
// So this hook is THROTTLED, keyed on the set of problem CATEGORIES currently present:
//
//   dirty memory        -> warn                      (categories: memory)
//   still dirty, +1 file-> silent                    (same categories)
//   index goes stale too-> warn again, both listed   (categories changed)
//   commit everything   -> silent                    (categories: none)
//   dirty memory again  -> warn again                (none -> memory)
//
// Counts deliberately do NOT participate in the key: editing three more memory files should
// not re-interrupt you, but a genuinely new KIND of problem should.
//
// Note this is a different judgment from /o-doctor's no-warning-tier rule, and not a
// contradiction: the doctor is PULLED — you ran it, you want the whole answer. A Stop hook is
// PUSHED — it interrupts, so it has to earn each interruption.
//
// Contract: JSON or nothing on stdout, and ALWAYS exit 0. Never `continue: false` — blocking
// the agent mid-turn over an uncommitted file would be far worse than the problem it reports.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWorkspaceSafe } from '../lib/workspace.mjs';

const { root: REPO } = resolveWorkspaceSafe();

// SESSION KEY — read the environment FIRST, stdin only as a fallback (ORBI-79).
//
// ORBI-67 deliberately never read stdin, because a read that waits for EOF hangs when the host
// leaves the pipe open — and this hook fires on EVERY turn end, so a hang costs the full hook
// timeout every turn, in the one hook whose entire design is about not interrupting. That
// reasoning still stands; it is the ORDER that changed, not the risk assessment.
//
// Claude Code sets CLAUDE_CODE_SESSION_ID, so under Claude Code this file never touches stdin
// and behaves exactly as it did before. Codex sets no such variable but does pass `session_id`
// in the hook's stdin JSON, where the old code fell back to one shared `default` sentinel and
// let one task suppress another task's warning.
//
// The fallback is bounded by a timer rather than by EOF, so it cannot hang: if nothing parses
// within STDIN_DEADLINE_MS we give up and degrade to the shared key, exactly as before.
const STDIN_DEADLINE_MS = 250;

const sessionIdFrom = (text) => {
  try {
    const id = JSON.parse(text)?.session_id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null; // not valid JSON *yet* — keep reading until the deadline
  }
};

async function sessionIdFromStdin() {
  if (process.stdin.isTTY) return null; // interactive: nothing was piped in
  return new Promise((resolve) => {
    let buf = '';
    const finish = (v) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      try {
        process.stdin.pause();
      } catch {
        // nothing to do — we are about to exit anyway
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), STDIN_DEADLINE_MS);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1_000_000) return finish(null); // absurd payload; not our problem
      const id = sessionIdFrom(buf);
      if (id) finish(id); // got it — don't wait around for EOF
    });
    process.stdin.on('end', () => finish(sessionIdFrom(buf)));
    process.stdin.on('error', () => finish(null));
  });
}

const SESSION = process.env.CLAUDE_CODE_SESSION_ID || (await sessionIdFromStdin()) || 'default';
const SENTINEL = path.join(tmpdir(), `orbi-stop-${SESSION.replace(/[^A-Za-z0-9-]/g, '')}`);

const run = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).trim() };
  }
};

const categories = [];
const lines = [];

// 1. Uncommitted memory. Memory is versioned specifically so it travels between laptops;
//    leaving it uncommitted defeats the entire arrangement (context/README.md).
const mem = run('git', ['status', '--porcelain', '--', 'context/memory']);
// trim per line, not just the whole blob — porcelain status codes are two columns, so the
// first entry would otherwise lose its leading space and sit misaligned against the rest.
const memFiles = mem.ok ? mem.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
if (memFiles.length) {
  categories.push('memory');
  lines.push(`⚠ context/memory/ has uncommitted changes (${memFiles.length} file${memFiles.length === 1 ? '' : 's'})`);
  for (const f of memFiles.slice(0, 5)) lines.push(`    ${f}`);
  if (memFiles.length > 5) lines.push(`    … and ${memFiles.length - 5} more`);
  lines.push('  commit them with the work — versioned memory that never gets committed is just memory');
}

// 2. Stale index. Reuse the generator's own --check; never reimplement it.
const idx = run(process.execPath, [path.join(REPO, 'scripts', 'build-project-index.mjs'), '--check']);
if (!idx.ok) {
  categories.push('index');
  lines.push('⚠ projects/README.md is out of date — run: node scripts/build-project-index.mjs');
}

const key = categories.sort().join(',');
let prev = null;
try {
  prev = readFileSync(SENTINEL, 'utf8');
} catch {
  // no sentinel yet — first Stop of this session
}

try {
  writeFileSync(SENTINEL, key);
} catch {
  // A read-only temp dir must not break the turn; worst case we warn every time.
}

// Same categories as last turn: already said, stay quiet.
if (key === prev || !key) process.exit(0);

process.stdout.write(JSON.stringify({ systemMessage: lines.join('\n') }));
process.exit(0);
