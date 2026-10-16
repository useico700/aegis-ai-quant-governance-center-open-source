import path from 'node:path';
export function sensitiveFilename(name){
 return name.startsWith('.env')&&name!=='.env.example'||name==='.dev.vars'||new Set(['.pem','.key','.sqlite','.db','.zip','.mp4']).has(path.extname(name).toLowerCase());
}
