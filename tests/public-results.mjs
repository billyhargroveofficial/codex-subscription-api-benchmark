import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const example=JSON.parse(readFileSync(new URL('../examples/validated-pair.json',import.meta.url)));
const prompt=readFileSync(new URL('../examples/synthetic-code-prompt.txt',import.meta.url));
const digest=createHash('sha256').update(prompt).digest('hex');
const [background,task]=prompt.toString().split('\n\nTask:');
assert.ok(task?.startsWith(' Write a complete, standalone TypeScript module'));
const records=background.trim().split('\n').slice(1);
assert.equal(records.length,2400);
assert.ok(records.every(line=>/^Record \d{4}: The (chain and sprocket|front brake|rear brake|tire contact patch|steering geometry|gear ratio|pedal cadence|wheel bearing) on bicycle B\d{3} was inspected after \d+ km; adjustment index \d{2}; service note: smooth motion, stable handling, and controlled braking depend on correct setup\.$/.test(line)));
const [a,b]=Object.values(example.runs);
for(const s of [a,b]) {
  const u=s.native_usage;
  assert.equal(s.input.prompt_sha256,digest);
  assert.equal(u.input_tokens,101209);
  assert.equal(u.input_tokens_details.cached_tokens,0);
  assert.equal(u.output_tokens-u.output_tokens_details.reasoning_tokens,s.native_nonreasoning_output_tokens);
  assert.equal(u.total_tokens,u.input_tokens+u.output_tokens);
  assert.ok(Math.abs(s.native_nonreasoning_output_tokens/s.first_to_last_visible_s-s.native_nonreasoning_over_visible_span_tps)<1e-10);
  assert.ok(Object.values(s.validations).every(Boolean));
}
assert.equal(a.input.request_json_sha256,b.input.request_json_sha256);
const forbidden=new Set(['account_id','device_id','response_id','item_id','request_id','account_comparison_fingerprint','id_sha256','send_utc','host_label','local_source_path','item_attribution']);
function inspect(v) { if(v && typeof v==='object') for(const [key,value] of Object.entries(v)){assert.ok(!forbidden.has(key),`Private field: ${key}`);inspect(value);} }
inspect(example);
// Exercise the detached launcher with a fixture-only child, never inference.
const temp=mkdtempSync(join(tmpdir(),'subscription-meter-offline-'));
const out=join(temp,'run');
const launcher=fileURLToPath(new URL('../scripts/start-run.mjs',import.meta.url));
const args=[launcher,'--self-test','--prompt','offline-fixture','--out',out];
try {
  const child=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(child.status,0,'Detached offline child should start');
  const deadline=Date.now()+15000;
  let complete=false;
  while(Date.now()<deadline){
    const log=join(out,'run.log');
    if(existsSync(log)&&readFileSync(log,'utf8').includes('"self_test":"passed"')){complete=true;break;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(complete,'Detached offline test did not complete');
  assert.notEqual(spawnSync(process.execPath,args,{encoding:'utf8'}).status,0,'Duplicate launch must be refused');
} finally { rmSync(temp,{recursive:true,force:true}); }
console.log('Public result arithmetic, synthetic prompt provenance, and anonymization checks passed. No model calls.');
