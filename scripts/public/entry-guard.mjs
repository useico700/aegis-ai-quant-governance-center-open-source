import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function blockLegacyDirectLaunch(url) {
 if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(url)) throw Error('PUBLIC_EDITION_USE_NPM_SETUP_DEMO_DEV; legacy host launchers require separate user-owned integration');
}
