#!/bin/sh
# Generates panel-like credentials: CA, node cert, client cert (ECDSA P-256), JWT RSA keys.
set -eu
D="$1"; mkdir -p "$D"; cd "$D"
openssl ecparam -name prime256v1 -genkey -noout -out ca.key 2>/dev/null
openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=ca-$(basename "$D")" -out ca.crt \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,digitalSignature" 2>/dev/null
for kind in node client; do
  openssl ecparam -name prime256v1 -genkey -noout -out $kind.ec.key 2>/dev/null
  openssl pkcs8 -topk8 -nocrypt -in $kind.ec.key -out $kind.key
  openssl req -new -key $kind.key -subj "/CN=$kind-$(basename "$D")" -out $kind.csr 2>/dev/null
  if [ $kind = node ]; then EKU=serverAuth; else EKU=clientAuth; fi
  printf "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,$EKU\nsubjectAltName=DNS:node\n" > $kind.ext
  openssl x509 -req -in $kind.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -sha256 -extfile $kind.ext -out $kind.crt 2>/dev/null
done
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt.key 2>/dev/null
openssl pkey -in jwt.key -pubout -out jwt.pub
