import { publicApi } from "../../../../../lib/public-preview.mjs";
import { sanitizeShadow } from '../../../lib/shadow';
const headers={'Cache-Control':'no-store'};
async function env(){const {env}=await import('cloudflare:workers');return env as unknown as {DB:D1Database;JEV_FILTER_INGEST_TOKEN?:string};}
async function schema(db:D1Database){await db.prepare('CREATE TABLE IF NOT EXISTS jev_shadow_latest(id INTEGER PRIMARY KEY CHECK(id=1),as_of TEXT NOT NULL,payload TEXT NOT NULL)').run();}
export async function GET(){
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("shadow", "GET");
try{const {DB}=await env();await schema(DB);const result=await DB.prepare('SELECT payload FROM jev_shadow_latest WHERE id=1').all<{payload:string}>();const r=result.results[0];return Response.json({status:r?'OK':'WAITING',shadow:r?JSON.parse(r.payload):null},{headers});}catch{return Response.json({status:'UNAVAILABLE',shadow:null},{status:503,headers});}}
export async function POST(req:Request){
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("shadow", "POST");
try{const {DB,JEV_FILTER_INGEST_TOKEN=''}=await env();const supplied=req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')??'';let mismatch=0;for(let i=0;i<JEV_FILTER_INGEST_TOKEN.length;i++)mismatch|=JEV_FILTER_INGEST_TOKEN.charCodeAt(i)^(supplied.charCodeAt(i)||0);if(JEV_FILTER_INGEST_TOKEN.length<32||supplied.length!==JEV_FILTER_INGEST_TOKEN.length||mismatch)return Response.json({status:'UNAUTHORIZED'},{status:401,headers});
 const raw=await req.text();if(raw.length>2_000_000)return Response.json({status:'TOO_LARGE'},{status:413,headers});const payload=sanitizeShadow(JSON.parse(raw));await schema(DB);const result=await DB.prepare('INSERT INTO jev_shadow_latest VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET as_of=excluded.as_of,payload=excluded.payload WHERE excluded.as_of>jev_shadow_latest.as_of').bind(payload.asOf,JSON.stringify(payload)).run();return Response.json({status:result.meta.changes?'SYNCED':'OLDER_IGNORED'},{headers});}catch{return Response.json({status:'REJECTED'},{status:400,headers});}}
