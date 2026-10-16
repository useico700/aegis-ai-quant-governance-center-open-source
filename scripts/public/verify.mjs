import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const ignored=new Set(['.git','node_modules','.runtime','.wrangler','dist','.vinext','.next','coverage','outputs']);
const forbidden=new RegExp(['frank'+'ie','VM-4-'+'6-opencloudos','appgprj_'+'[a-z0-9]{20,}','/Users/','01a[0-9a-f]{5}-[0-9a-f-]{27,}','https://(?:fapi\\.binance\\.com|[a-z0-9.-]+\\.chatgpt\\.site)'].join('|'),'i');
const secret=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/;
const hits=[];let files=0;
async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(ignored.has(e.name))continue;const f=path.join(dir,e.name),rel=path.relative(root,f);if(e.isSymbolicLink()){hits.push(rel+':SYMLINK');continue;}if(e.isDirectory()){await walk(f);continue;}files++;if(e.name.startsWith('.env')&&e.name!=='.env.example'||e.name==='.dev.vars'||/\\.(pem|key|sqlite|db|zip|mp4)$/i.test(e.name))hits.push(rel+':SECRET_FILE');const text=await fs.readFile(f,'utf8');if(rel!=='scripts/public/verify.mjs'&&(forbidden.test(text)||secret.test(text)))hits.push(rel+':SENSITIVE_PATTERN');}}
await walk(root);const state=JSON.parse(await fs.readFile(path.join(root,'governance/current-state.json')));
if(state.exchangeOrdersAllowed!==false||state.activeOwnerAuthorizations.length)throw Error('PUBLIC_GOVERNANCE_NOT_DISARMED');
const source=JSON.parse(await fs.readFile(path.join(root,'governance/upstream-source-manifest.json')));
if(source.files.length<600)throw Error('FULL_SOURCE_EXPORT_REQUIRED');
if(hits.length){console.error(JSON.stringify({status:'BLOCKED',files,paths:hits}));process.exitCode=1;}else console.log(JSON.stringify({status:'OK',files,upstreamSourceFiles:source.files.length,privateHistoryIncluded:false,default:'LOCAL_SIMULATED_VENUE'}));
