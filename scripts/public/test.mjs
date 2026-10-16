import {assertPublicEnginePlatform} from './platform.mjs';
import {spawnSync} from 'node:child_process';
assertPublicEnginePlatform();
const files=['tests/public-edition.test.mjs','tests/s1-execution-engine.test.mjs','tests/s1-precision.test.mjs','tests/s1-position-lifecycle.test.mjs','tests/jev-filter.test.mjs','tests/jev-evaluate.test.mjs','tests/s1-candidate-selection.test.mjs','tests/s1-untouched-intersections.test.mjs','tests/s1-s2-px-first-close-live.test.mjs'];
const r=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});process.exit(r.status??1);
