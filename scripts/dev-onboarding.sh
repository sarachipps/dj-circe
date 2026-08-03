#!/usr/bin/env bash
# Cold-start the onboarding wizard against an isolated Hermes home + Circe
# state dir. Wipes the sandbox dirs on every run so first-run always fires.
set -euo pipefail

SANDBOX_HERMES="${HOME}/.hermes-dev"
SANDBOX_STATE="${HOME}/.hermes-tiles-dev"

rm -rf "${SANDBOX_HERMES}" "${SANDBOX_STATE}"
mkdir -p "${SANDBOX_HERMES}/profiles" "${SANDBOX_STATE}"

echo "circe: dev-onboarding sandbox reset"
echo "  HERMES_HOME=${SANDBOX_HERMES}"
echo "  HERMES_TILES_STATE_DIR=${SANDBOX_STATE}"

HERMES_HOME="${SANDBOX_HERMES}" \
  HERMES_TILES_STATE_DIR="${SANDBOX_STATE}" \
  exec npx electron .
