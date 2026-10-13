#!/bin/sh
# End-to-end test of multi-panel mode against a real Xray Core.
#   IMAGE=rwnode:multipanel ./e2e/multi-panel/run.sh
# Requires: docker, node >= 22, openssl, project dependencies installed (npm ci).
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${IMAGE:-rwnode:multipanel}"
DATA="$HERE/.data"

rm -rf "$DATA" && mkdir -p "$DATA"
for i in 1 2 3; do "$HERE/gen-panel.sh" "$DATA/panel$i"; done
node "$HERE/fill-client.mjs"

sk() { node --input-type=module -e "import { loadPanel } from '$HERE/fakepanel.mjs'; console.log(loadPanel($1).secretKey)"; }

cleanup() { docker rm -f rwn rwweb rwcli >/dev/null 2>&1 || true; docker network rm rwtest >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create rwtest >/dev/null

docker run -d --name rwweb --network rwtest --entrypoint node "$IMAGE" \
    -e "require('http').createServer((q,s)=>s.end(Buffer.alloc(3000000))).listen(8080)" >/dev/null
docker run -d --name rwcli --network rwtest -v "$DATA/client.json:/client.json:ro" \
    --entrypoint /usr/local/bin/xray "$IMAGE" run -c /client.json >/dev/null

start_node() {
    docker rm -f rwn >/dev/null 2>&1 || true
    docker run -d --name rwn --network rwtest --cap-add NET_ADMIN \
        -p 2222:2222 -p 2223:2223 -p 2224:2224 "$@" "$IMAGE" >/dev/null
    sleep 10
    docker cp "$HERE/dump.js" rwn:/dump.js
}

echo "### Multi-panel (3 panels)"
start_node -e NODE_PORT=2222 -e SECRET_KEY="$(sk 1)" \
    -e NODE_PORT_2=2223 -e SECRET_KEY_2="$(sk 2)" \
    -e NODE_PORT_3=2224 -e SECRET_KEY_3="$(sk 3)"
node "$HERE/part-a.mjs"
node "$HERE/part-b.mjs"

echo "### Single panel (upstream behaviour)"
start_node -e NODE_PORT=2222 -e SECRET_KEY="$(sk 1)"
node "$HERE/single-panel.mjs"
