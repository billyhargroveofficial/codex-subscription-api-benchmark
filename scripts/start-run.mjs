import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const args=process.argv.slice(2);
if(args.includes('--help')){
  console.log('node scripts/start-run.mjs --prompt FILE --out NEW_DIRECTORY [benchmark options]');
  process.exit(0);
}
const get=(flag)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
if(!get('--prompt')||!get('--out'))throw new Error('--prompt and a fresh --out directory are required');
if(args.includes('--stdout-artifacts'))throw new Error('Detached runs require on-disk artifacts');
const out=resolve(get('--out'));
mkdirSync(dirname(out),{recursive:true,mode:0o700});
mkdirSync(out,{mode:0o700}); // refuse duplicate launch into an existing directory
const log=openSync(join(out,'run.log'),'wx',0o600);
const meter=fileURLToPath(new URL('../pi-api-meter.ts',import.meta.url));
const child=spawn(process.execPath,[meter,...args],{detached:true,stdio:['ignore',log,log]});
closeSync(log);
child.once('error',()=>{process.exitCode=1;console.error('Unable to start detached benchmark');});
child.once('spawn',()=>{
  const metadata={pid:child.pid,started_utc:new Date().toISOString()};
  writeFileSync(join(out,'launch.json'),JSON.stringify(metadata,null,2)+'\n',{mode:0o600});
  child.unref();console.log(JSON.stringify(metadata));
});
