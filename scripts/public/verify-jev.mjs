import fs from 'node:fs/promises';
const s=JSON.parse(await fs.readFile(new URL('../../governance/current-state.json',import.meta.url)));
if(s.jev.orderAuthority!==false||s.jev.status!=='DISABLED_UNCONFIGURED')throw Error('PUBLIC_JEV_BOUNDARY_CHANGED');
console.log(JSON.stringify({status:'OK',disposition:'PRESERVED_JEV_CODE_DISABLED_RUNTIME',privateImpact:'NONE'}));
