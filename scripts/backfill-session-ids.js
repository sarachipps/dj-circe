#!/usr/bin/env node
/**
 * backfill-session-ids Script
 *
 * One-shot: reads ~/.hermes-tiles/state.json, and for each tab that has no
 * sessionId, matches the tab's first user message against the hermes ACP
 * session store to guess which server-side session it corresponds to. Writes
 * the sessionId back into state.json in place. Original state is backed up
 * by the caller (see companion README).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const STATE_FILE =
  process.env.HERMES_TILES_STATE_DIR
    ? path.join(process.env.HERMES_TILES_STATE_DIR, 'state.json')
    : path.join(os.homedir(), '.hermes-tiles', 'state.json');

function dbPathForProfile(name) {
  return name === 'default'
    ? path.join(HERMES_HOME, 'state.db')
    : path.join(HERMES_HOME, 'profiles', name, 'state.db');
}

function firstUserOf(tab) {
  if (tab.firstUserText) return tab.firstUserText;
  if (Array.isArray(tab.messages)) {
    const m = tab.messages.find((x) => x.role === 'user' && x.text);
    if (m) return m.text;
  }
  return null;
}

function sql(dbPath, query) {
  const out = execFileSync(
    'sqlite3',
    ['-separator', '\x1f', dbPath, query],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\x1f'));
}

function findSession(dbPath, needle) {
  if (!needle) return null;
  const trimmed = needle.trim();
  if (!trimmed) return null;
  // Look for a user message whose content equals the needle exactly,
  // in an ACP-source session, preferring the most recent match.
  const rows = sql(
    dbPath,
    `SELECT s.id, s.started_at
       FROM sessions s
       JOIN messages m ON m.session_id = s.id
       WHERE s.source='acp'
         AND m.role='user'
         AND m.content = ${quote(trimmed)}
       ORDER BY s.started_at DESC
       LIMIT 1;`,
  );
  if (rows.length && rows[0][0]) return rows[0][0];
  return null;
}

function quote(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}

function main() {
  if (!fs.existsSync(STATE_FILE)) {
    console.error(`state file not found: ${STATE_FILE}`);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const profiles = state.profiles || {};
  const summary = [];
  let totalTabs = 0;
  let matched = 0;
  let alreadyHad = 0;
  let missing = 0;

  for (const [profileName, profileState] of Object.entries(profiles)) {
    const tabs = Array.isArray(profileState.tabs) ? profileState.tabs : [];
    const dbPath = dbPathForProfile(profileName);
    if (!fs.existsSync(dbPath)) {
      summary.push(`  ${profileName}: no state.db at ${dbPath} — skipped`);
      continue;
    }
    let m = 0, a = 0, x = 0;
    for (const tab of tabs) {
      totalTabs += 1;
      if (tab.sessionId) {
        a += 1;
        alreadyHad += 1;
        continue;
      }
      const needle = firstUserOf(tab);
      if (!needle) {
        x += 1;
        missing += 1;
        continue;
      }
      const id = findSession(dbPath, needle);
      if (id) {
        tab.sessionId = id;
        m += 1;
        matched += 1;
      } else {
        x += 1;
        missing += 1;
      }
    }
    summary.push(
      `  ${profileName}: ${m} matched, ${a} already had id, ${x} unmatched (${tabs.length} tabs)`,
    );
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`Backfilled ${STATE_FILE}`);
  console.log(`Total tabs: ${totalTabs}  matched: ${matched}  already-had: ${alreadyHad}  unmatched: ${missing}`);
  for (const line of summary) console.log(line);
}

main();
