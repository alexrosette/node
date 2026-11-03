/* eslint-disable no-console */
const fs = require('fs');
const http = require('http');
const env = (n) => fs.readFileSync('/run/s6/container_environment/' + n, 'utf8').trim();
http.get(
    {
        socketPath: '\0' + env('INTERNAL_SOCKET_PATH'),
        path: '/internal/get-config?token=' + env('INTERNAL_REST_TOKEN'),
    },
    (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => process.stdout.write(b));
    },
);
