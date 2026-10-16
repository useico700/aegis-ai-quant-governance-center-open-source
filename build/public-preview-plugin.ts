import type {Plugin} from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import {publicApi} from '../lib/public-preview.mjs';
export function publicPreview():Plugin{return {name:'aegis-public-local-preview',configureServer(server){
 server.middlewares.use(async(req,res,next)=>{
  if(process.env.AEGIS_PUBLIC_PROFILE==='CUSTOM_INTEGRATION'||!req.url?.startsWith('/api/'))return next();
  const route=new URL(req.url,'http://localhost').pathname.split('/').at(-1)!;let receipt=null;
  try{receipt=JSON.parse(await fs.readFile(path.resolve('.runtime/public-demo',route.startsWith('s2-')?'S2.json':'S1.json'),'utf8'));}catch{}
  const r=publicApi(route,req.method,receipt);res.statusCode=r.status;for(const [k,v]of r.headers)res.setHeader(k,v);res.end(await r.text());
 });
}};}
