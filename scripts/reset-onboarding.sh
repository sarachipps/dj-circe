#!/usr/bin/env bash
# Flip firstRunComplete=false in the REAL state file so the wizard runs
# again on next launch, without touching profiles or creds.
set -euo pipefail

STATE_DIR="${HERMES_TILES_STATE_DIR:-${HOME}/.hermes-tiles}"
STATE_FILE="${STATE_DIR}/state.json"

if [[ ! -f "${STATE_FILE}" ]]; then
  echo "circe: no state file at ${STATE_FILE} — wizard would already run"
  exit 0
fi

node -e "
const fs = require('fs');
const p = process.argv[1];
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.firstRunComplete = false;
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('circe: flipped firstRunComplete=false in ' + p);
" "${STATE_FILE}"
