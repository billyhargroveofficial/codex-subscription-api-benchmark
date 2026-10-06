// Audit indexed files, and optionally every reachable commit/blob. Never prints a match.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const git=(...args)=>execFileSync('git',args,{maxBuffer:32*1024*1024});
const patterns=[
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  /\b(?:resp|msg|rs)_[a-z0-9]{20,}\b/,
  /\/(?:Users|home)\/[A-Za-z0-9][A-Za-z0-9_.-]*\//,
  /\b(?:192\.168\.|10\.\d+\.)\d+\.\d+\b/
];
const forbiddenPath=/(?:^|\/)(?:auth\.json|\.env(?:\..*)?|id_rsa|id_ed25519|comparison-salt\.txt|process\.log|node_modules)(?:\/|$)/;
const failures=[];let inspected=0;
function check(path,buf,where){
  inspected++;
  if(forbiddenPath.test(path)) failures.push(`${where}: forbidden path ${path}`);
  if(buf.includes(0)) failures.push(`${where}: binary file requires separate review ${path}`);
  const text=buf.toString('utf8');
  patterns.forEach((p,i)=>{if(p.test(text))failures.push(`${where}: ${path}: pattern ${i+1}`);});
}
const indexed=git('ls-files','--stage','-z').toString().split('\0').filter(Boolean);
for(const line of indexed){const [meta,path]=line.split('\t');const sha=meta.split(' ')[1];check(path,git('cat-file','blob',sha),'index');}
if(process.argv.includes('--history')){
  const commits=git('rev-list','--all').toString().trim().split('\n').filter(Boolean);
  const seen=new Set();
  for(const commit of commits){
    check('commit-metadata',git('cat-file','commit',commit),commit.slice(0,12));
    for(const line of git('ls-tree','-r','-z',commit).toString().split('\0').filter(Boolean)){
      const [meta,path]=line.split('\t');const [,type,sha]=meta.split(' ');
      assert.equal(type,'blob','Submodules require separate publication review');
      const key=path+':'+sha;if(seen.has(key))continue;seen.add(key);
      check(path,git('cat-file','blob',sha),commit.slice(0,12));
    }
  }
}
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
console.log(`Publication audit passed: ${inspected} indexed/history entries. Pattern audit supplements manual review; it cannot prove absence of every secret.`);
