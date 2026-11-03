#!/bin/sh
# End-to-end test of the single-panel node with the ledger channel, against a real Xray Core.
#   IMAGE=rwnode:single ./e2e/single/run.sh
# Requires: docker, node >= 22, openssl, project dependencies installed (npm ci).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${IMAGE:-rwnode:single}"
DATA="$HERE/.data"

rm -rf "$DATA" && mkdir -p "$DATA"
"$HERE/gen-panel.sh" "$DATA/panel1"
"$HERE/gen-panel.sh" "$DATA/ledger"

key() { node --input-type=module -e "import { loadPanel } from '$HERE/fakepanel.mjs'; console.log(loadPanel(1, '$1').secretKey)"; }

cleanup() { docker rm -f rwn >/dev/null 2>&1 || true; }
trap cleanup EXIT

start_node() {
    cleanup
    docker run -d --name rwn --cap-add NET_ADMIN -p 2222:2222 \
        -e NODE_PORT=2222 -e SECRET_KEY="$(key panel1)" "$@" "$IMAGE" >/dev/null
    sleep 10
    docker cp "$HERE/dump.js" rwn:/dump.js
}

echo "### Without LEDGER_SECRET_KEY (upstream behaviour)"
start_node
E2E_LEDGER=off node "$HERE/single.mjs"

echo "### With LEDGER_SECRET_KEY"
start_node -e LEDGER_SECRET_KEY="$(key ledger)"
E2E_LEDGER=on node "$HERE/single.mjs"
