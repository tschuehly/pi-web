#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../../.."
: "${PI_TMP:?PI_TMP must be an isolated scratch directory}"
: "${PI_WEB_E2E_DURABLE_HOST:?Set the pinned Workbench chat-host-main.ts entry}"
export TMPDIR="$PI_TMP"
export PI_WEB_E2E_FLEET=1
export DURABLE_FLEET_HOST="$PI_WEB_E2E_DURABLE_HOST"
export PI_WEB_E2E_DURABLE_HOST="$here/fault-host.mjs"
export NODE_OPTIONS="${NODE_OPTIONS:-} --import=$(node -e 'console.log(require("node:url").pathToFileURL(process.argv[1]).href)' "$here/mock-only-network.mjs")"
node "$here/network-check.mjs"
exec npx playwright test e2e/durable/bash-atelier-tree/ "$@"
