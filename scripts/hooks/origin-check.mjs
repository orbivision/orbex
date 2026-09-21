#!/usr/bin/env node
// SessionStart hook (ASYNC): is this checkout behind origin?
//
// Separate from session-start.mjs on purpose. `git fetch` costs ~0.70s and needs the network;
// the doctor costs 0.05s and does not. Splitting them means the doctor's answer is present
// immediately and a slow or missing network never delays a session start.
//
// This is the half the doctor deliberately cannot do. `/o-doctor` is offline by design and
// says nothing about origin — so a green doctor is NOT "you are in sync". This hook is what
// makes that statement true, and it is the enforcement half of the cross-machine rule in
// CLAUDE.md: these repos are developed on two laptops, and memory conflicts are only cheap
// if you pull first.
//
// Same contract as the other hooks: JSON or nothing on stdout, always exit 0.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveWorkspaceSafe } from '../lib/workspace.mjs';

const { root: REPO } = resolveWorkspaceSafe();
const git = (args, timeout = 15000) =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim();

try {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  // Offline, unauthed, or no upstream: nothing useful to say, so say nothing. This is the one
  // place silence is right — a "couldn't reach GitHub" line on every offline session start is
  // noise about a condition the user already knows about.
  try {
    git(['fetch', '-q', 'origin', branch]);
  } catch {
    process.exit(0);
  }

  const [behind, ahead] = git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`])
    .split(/\s+/).map(Number);
  if (!behind) process.exit(0);

  const lines = [
    `⚠ ${branch} is ${behind} commit${behind === 1 ? '' : 's'} behind origin — git pull before starting`,
    '  the other laptop has work you do not have; memory conflicts are cheap only if you pull first',
  ];
  if (ahead) lines.push(`  (also ${ahead} ahead — this will be a merge, not a fast-forward)`);
  process.stdout.write(JSON.stringify({ systemMessage: lines.join('\n') }));
} catch {
  // Not a git repo, git missing, detached HEAD — none of it worth interrupting a session for.
}

process.exit(0);
