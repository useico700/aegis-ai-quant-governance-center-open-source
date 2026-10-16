import {assertPublicEnginePlatform} from './platform.mjs';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
assertPublicEnginePlatform();
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<13))throw Error('NODE_22_13_OR_LATER_REQUIRED');
for(const cmd of ['scripts/public/verify.mjs','scripts/public/demo.mjs']){const r=spawnSync(process.execPath,[cmd],{cwd:root,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
console.log('SETUP_OK: original S1/S2 engines exercised on isolated FakeS1Venue. Next: npm run dev; open http://127.0.0.1:3000/s1 or /s2. No keys, host changes, cloud publish or exchange orders.');
