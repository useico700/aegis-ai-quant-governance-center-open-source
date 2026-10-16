import fs from 'node:fs/promises';
export const S2_SCANNER_STATE_MAX_BYTES=64*1024*1024;

// Only S2 scanner state has the enlarged proof envelope. Bound allocation and
// reads on one descriptor, so a stat/read replacement cannot evade the cap.
// Scanner writes are atomic; an in-place change is unavailable evidence.
export async function readS2ScannerState(file) {
 let handle;
 try {
  handle=await fs.open(file,'r');const before=await handle.stat();
  if(!before.isFile()||!Number.isSafeInteger(before.size)||before.size<2||before.size>S2_SCANNER_STATE_MAX_BYTES)return null;
  const buffer=Buffer.allocUnsafe(before.size+1);let offset=0;
  while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,Math.min(1024*1024,buffer.length-offset),offset);if(!bytesRead)break;offset+=bytesRead;}
  const after=await handle.stat();
  if(offset!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)return null;
  return JSON.parse(buffer.subarray(0,offset).toString('utf8'));
 }catch{return null;}finally{await handle?.close();}
}
