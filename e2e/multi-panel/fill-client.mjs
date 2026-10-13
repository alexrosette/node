/* eslint-disable no-console */
import fs from 'node:fs';

import { makeUser } from './fakepanel.mjs';

const dir = new URL('./.data/', import.meta.url).pathname;
const config = JSON.parse(
    fs.readFileSync(new URL('./client.template.json', import.meta.url), 'utf8'),
);
config.outbounds[0].settings.vnext[0].users[0].id = makeUser(1, 'a').vlessUuid;
config.outbounds[1].settings.vnext[0].users[0].id = makeUser(3, 'b').vlessUuid;
fs.writeFileSync(`${dir}/client.json`, JSON.stringify(config, null, 2));
