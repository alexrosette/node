#!/bin/sh
# End-to-end test of multi-panel mode against a real Xray Core.
#   IMAGE=rwnode:multipanel ./e2e/multi-panel/run.sh
# Requires: docker, node >= 22, openssl, project dependencies installed (npm ci).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${IMAGE:-rwnode:multipanel}"
DATA="$HERE/.data"

rm -rf "$DATA" && mkdir -p "$DATA"
for i in $(seq 1 20); do "$HERE/gen-panel.sh" "$DATA/panel$i"; done
"$HERE/gen-panel.sh" "$DATA/ledger"
node "$HERE/fill-client.mjs"
node "$HERE/scale.mjs" client

sk() { node --input-type=module -e "import { loadPanel } from '$HERE/fakepanel.mjs'; console.log(loadPanel($1).secretKey)"; }
lsk() { node --input-type=module -e "import { loadPanel } from '$HERE/fakepanel.mjs'; console.log(loadPanel('ledger', 'ledger').secretKey)"; }

cleanup() { docker rm -f rwn rwweb rwcli rwcli20 >/dev/null 2>&1 || true; docker network rm rwtest >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create rwtest >/dev/null

docker run -d --name rwweb --network rwtest --entrypoint node "$IMAGE" \
    -e "require('http').createServer((q,s)=>s.end(Buffer.alloc(3000000))).listen(8080)" >/dev/null
docker run -d --name rwcli --network rwtest -v "$DATA/client.json:/client.json:ro" \
    --entrypoint /usr/local/bin/xray "$IMAGE" run -c /client.json >/dev/null
docker run -d --name rwcli20 --network rwtest -v "$DATA/client20.json:/client.json:ro" \
    --entrypoint /usr/local/bin/xray "$IMAGE" run -c /client.json >/dev/null

start_node() {
    docker rm -f rwn >/dev/null 2>&1 || true
    # Background stats drain every 0.5 s instead of 5 s, so tests don't wait for it.
    docker run -d --name rwn --network rwtest --cap-add NET_ADMIN \
        -p 2222:2222 -p 2223:2223 -p 2224:2224 -e STATS_DRAIN_INTERVAL_MS=500 "$@" "$IMAGE" >/dev/null
    sleep 10
    docker cp "$HERE/dump.js" rwn:/dump.js
}

echo "### Multi-panel (3 panels)"
start_node -e NODE_PORT=2222 -e SECRET_KEY="$(sk 1)" \
    -e NODE_PORT_2=2223 -e SECRET_KEY_2="$(sk 2)" \
    -e NODE_PORT_3=2224 -e SECRET_KEY_3="$(sk 3)"
node "$HERE/part-a.mjs"
node "$HERE/part-b.mjs"

echo "### Shared port: 3 panels on NODE_PORT, routed by SNI"
start_node -e NODE_PORT=2222 -e SECRET_KEY="$(sk 1)" \
    -e SECRET_KEY_2="$(sk 2)" \
    -e SECRET_KEY_3="$(sk 3)"
E2E_PORTS=2222,2222,2222 node "$HERE/part-a.mjs"
E2E_PORTS=2222,2222,2222 node "$HERE/part-b.mjs"

echo "### Mixed: panels 1+2 on shared port, panel 3 on its own port"
start_node -e NODE_PORT=2222 -e SECRET_KEY="$(sk 1)" \
    -e SECRET_KEY_2="$(sk 2)" \
    -e NODE_PORT_3=2224 -e SECRET_KEY_3="$(sk 3)"
E2E_PORTS=2222,2222,2224 node "$HERE/part-a.mjs"
E2E_PORTS=2222,2222,2224 node "$HERE/part-b.mjs"

echo "### Scale: 20 panels on one port"
SCALE_ENV="-e NODE_PORT=2222 -e SECRET_KEY=$(sk 1)"
for i in $(seq 2 20); do SCALE_ENV="$SCALE_ENV -e SECRET_KEY_$i=$(sk "$i")"; done
# shellcheck disable=SC2086
start_node $SCALE_ENV
node "$HERE/scale.mjs"

echo "### Ledger: panels 1+2 on NODE_PORT, ledger by SNI on the same port"
start_node -e NODE_PORT=2222 -e SECRET_KEY="$(sk 1)" \
    -e SECRET_KEY_2="$(sk 2)" \
    -e LEDGER_SECRET_KEY="$(lsk)"
E2E_PORTS=2222,2222,2222 node "$HERE/ledger.mjs"

echo "### Single panel (upstream behaviour)"
start_node -e NODE_PORT=2222 -e SECRET_KEY="$(sk 1)"
node "$HERE/single-panel.mjs"
