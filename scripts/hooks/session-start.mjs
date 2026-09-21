#!/usr/bin/env node
// SessionStart hook: run the workspace doctor, report findings to the user.
//
// Wired in .claude/settings.json. Runs SYNCHRONOUSLY — it costs ~0.05s, measured, which is
// cheap enough to block on. The network half (are we behind origin?) is a separate async
// hook, scripts/hooks/origin-check.mjs, so a slow or absent network never delays a session.
//
// Contract, and all three parts matter (ORBI-67 risk 2 — a bad hook degrades every session,
// which a bad skill does not):
//   - stdout is JSON or nothing. Silence == nothing to say.
//   - ALWAYS exit 0. A session must never fail to start because the workspace is untidy.
//   - systemMessage only. No additionalContext: findings go to the user, who decides. The
//     hook does not hand Claude a to-do list it never asked for.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveWorkspaceSafe } from '../lib/workspace.mjs';

const { root: REPO } = resolveWorkspaceSafe();

function say(systemMessage) {
  process.stdout.write(JSON.stringify({ systemMessage }));
}

try {
  let report;
  try {
    // doctor.mjs exits 1 when it has findings, so a non-zero exit is the EXPECTED path.
    // Its stdout is still valid JSON either way; that's what we parse.
    const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'doctor.mjs'), '--json'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    report = JSON.parse(out);
  } catch (e) {
    if (!e.stdout) throw e;
    report = JSON.parse(e.stdout);
  }

  if (report.ok) process.exit(0); // silent when healthy

  const failed = report.checks.filter((c) => c.findings.length);
  const lines = [`⚠ /o-doctor: ${report.findings} finding${report.findings === 1 ? '' : 's'} in this workspace`];
  for (const c of failed) {
    lines.push(`  ${c.id}:`);
    for (const f of c.findings) lines.push(`    ${f}`);
  }
  lines.push('  → node scripts/doctor.mjs   (symlink/memory findings are almost always: context/bootstrap.sh)');
  say(lines.join('\n'));
} catch (e) {
  // A crash here must not be silent — that is the broken-checker-reports-green failure the
  // doctor exists to prevent, and it would be worse in a hook nobody looks at.
  say(`⚠ SessionStart hook failed: ${e.message}\n  the workspace was NOT checked — run: node scripts/doctor.mjs`);
}

process.exit(0);
