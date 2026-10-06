/** Measure the actual Pi Codex SSE body before Pi event normalization.
 * Credentials are resolved by Pi's read-only SDK storage and never logged.
 * Node >=24: node pi-api-meter.ts --self-test
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

type WireSample = { at: bigint; bytes: Buffer };
type Frame = { at: bigint; data: any; wireEnd: number };
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const seconds = (b: bigint, a: bigint) => Number(b - a) / 1e9;
const now = () => process.hrtime.bigint();
function safeUsage(usage: any) {
  if (!usage) return null;
  const items = usage.attribution?.items;
  return { input_tokens: usage.input_tokens, input_tokens_details: usage.input_tokens_details,
    output_tokens: usage.output_tokens, output_tokens_details: usage.output_tokens_details,
    total_tokens: usage.total_tokens,
    ...(items ? { item_attribution: Object.entries(items).map(([id, counts]) => ({ id_sha256: hash(id), counts })) } : {}) };
}
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

function decodeJwt(token: string) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Unsupported credential format');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

/** User-selected existing Codex auth.json, consumed only on its own host.
 * Implements Pi's public CredentialStore interface. Never writes or refreshes.
 */
function codexCredential(data: any) {
  if (data.auth_mode != null && !['chatgpt', 'chatgptAuthTokens', 'chatgpt_auth_tokens'].includes(data.auth_mode)) {
    throw new Error('Existing credential is not ChatGPT subscription authentication');
  }
  const access = data.tokens?.access_token;
  if (typeof access !== 'string' || !access) throw new Error('Existing Codex OAuth is unavailable');
  const jwt = decodeJwt(access);
  if (!Number.isFinite(jwt.exp) || jwt.exp * 1000 - Date.now() < 360000) {
    throw new Error('Existing Codex OAuth requires refresh; read-only meter refuses refresh');
  }
  return { type: 'oauth' as const, access, refresh: '', expires: jwt.exp * 1000 };
}

class ReadOnlyCodexCredentials {
  authPath: string;
  constructor(root: string) { this.authPath = join(resolve(root), 'auth.json'); }
  async read(providerId: string, options?: any) {
    options?.signal?.throwIfAborted();
    if (providerId !== 'openai-codex') return undefined;
    return codexCredential(JSON.parse(readFileSync(this.authPath, 'utf8')));
  }
  async list(options?: any) {
    await this.read('openai-codex', options);
    return [{ providerId: 'openai-codex', type: 'oauth' as const }];
  }
  async modify() { throw new Error('Read-only Codex credentials refuse modification or refresh'); }
  async delete() { throw new Error('Read-only Codex credentials refuse deletion'); }
}

async function authMetadata(runtime: any, model: any) {
  const result = await runtime.getAuth(model);
  if (!result?.auth?.apiKey) return { auth_available: false, auth_source: null, plan: null };
  const jwt = decodeJwt(result.auth.apiKey);
  const claims = jwt['https://api.openai.com/auth'] ?? {};
  const plan = claims.chatgpt_plan_type;
  return { auth_available: true, auth_source: result.source ?? null,
    plan: ['free','plus','pro','team','business','enterprise','edu','go'].includes(plan) ? plan : null,
    plan_provenance: 'existing OAuth claim; no account identifier or raw JWT recorded' };
}

class WireRecorder {
  samples: WireSample[] = [];
  sendAt: bigint | null = null;
  sendUtc: string | null = null;
  headersAt: bigint | null = null;
  eofAt: bigint | null = null;
  endpoint: string | null = null;
  status: number | null = null;
  calls = 0;
  wireBytes = 0;
  requestWireBytes: number | null = null;
  requestEncoding: string | null = null;

  wrap(response: Response): Response {
    if (!response.body) return response;
    const source = response.body.getReader();
    const self = this;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const read = await source.read();
        const at = now(); // stamp immediately after read, before copy/parse/formatting
        if (read.done) {
          self.eofAt = at;
          controller.close();
          return;
        }
        self.samples.push({ at, bytes: Buffer.from(read.value) });
        self.wireBytes += read.value.byteLength;
        if (self.wireBytes > 64 * 1024 * 1024) {
          await source.cancel();
          controller.error(new Error('Response body exceeded measurement limit'));
          return;
        }
        controller.enqueue(read.value);
      },
      cancel(reason) { return source.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  fetch: typeof fetch = async (input, init) => {
    if (++this.calls !== 1) throw new Error('Retries are disabled: second fetch refused');
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.pathname !== '/backend-api/codex/responses') {
      throw new Error('Refusing an endpoint outside the installed native Codex provider');
    }
    this.endpoint = `${url.origin}${url.pathname}`;
    // Inspect only non-secret transport fields. Never enumerate or store headers.
    this.requestEncoding = new Headers(init?.headers).get('content-encoding');
    const body = init?.body;
    this.requestWireBytes = typeof body === 'string' ? Buffer.byteLength(body)
      : ArrayBuffer.isView(body) ? body.byteLength : body instanceof ArrayBuffer ? body.byteLength : null;
    this.sendUtc = new Date().toISOString();
    this.sendAt = now();
    const response = await globalThis.fetch(input, init);
    this.headersAt = now();
    this.status = response.status;
    return this.wrap(response);
  };
}

/** Parse after the entire request finishes. A frame gets the timestamp of the
 * network read containing its last byte; frames in one read share a timestamp.
 */
function parseFrames(samples: WireSample[], allowIncomplete = false): Frame[] {
  const frames: Frame[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let totalBytes = 0;
  for (const sample of samples) {
    pending += decoder.decode(sample.bytes, { stream: true });
    totalBytes += sample.bytes.length;
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(pending);
      if (!boundary) break;
      const block = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]') continue;
      frames.push({ at: sample.at, data: JSON.parse(data), wireEnd: totalBytes });
    }
  }
  pending += decoder.decode();
  if (pending.trim() && !allowIncomplete) throw new Error('Incomplete SSE frame at EOF');
  return frames;
}

function analyze(frames: Frame[], sendAt: bigint, requestedModel: string, sdkText: string | null) {
  const terminalFrames = frames.filter(f => ['response.completed', 'response.done', 'response.failed', 'response.incomplete'].includes(f.data.type));
  assert.equal(terminalFrames.length, 1, 'Exactly one terminal response required');
  const terminal = terminalFrames[0];
  const response = terminal.data.response;
  assert.equal(response?.status, 'completed', 'Response must complete successfully');
  assert.ok(response?.id, 'Native response ID missing');
  const created = frames.find(f => f.data.type === 'response.created');
  assert.equal(created?.data.response?.id, response.id, 'Response IDs differ');
  if (response.model != null) assert.equal(response.model, requestedModel, 'Server model echo differs');
  if (response.reasoning?.effort != null) assert.equal(response.reasoning.effort, 'xhigh', 'Server reasoning echo differs');
  if (response.service_tier != null) assert.equal(response.service_tier, 'default', 'Server tier echo differs');
  const output = response.output ?? [];
  const addedItems = frames.filter(f => f.data.type === 'response.output_item.added').map(f => f.data.item);
  assert.equal([...output, ...addedItems].filter((i: any) => !['message', 'reasoning'].includes(i?.type)).length, 0, 'Unexpected tool/compaction/output item');
  // The Codex terminal event can omit message bodies. Its streamed item.done
  // events are the authoritative completed output items used by Pi itself.
  const doneMessages = frames.filter(f => f.data.type === 'response.output_item.done' && f.data.item?.type === 'message');
  assert.equal(doneMessages.length, 1, 'Exactly one streamed assistant message required');
  const itemDone = doneMessages[0];
  const message = itemDone.data.item;
  if (message.role != null) assert.equal(message.role, 'assistant', 'Streamed message is not assistant');
  const finalText = (message.content ?? []).filter((p: any) => p.type === 'output_text').map((p: any) => p.text ?? '').join('');
  const terminalMessages = output.filter((i: any) => i.type === 'message');
  let terminalTextCompared = false;
  if (terminalMessages.length) {
    assert.equal(terminalMessages.length, 1, 'Unexpected terminal message count');
    const m = terminalMessages[0];
    assert.equal(m.id, message.id, 'Terminal message ID differs');
    if (m.role != null) assert.equal(m.role, 'assistant', 'Terminal message is not assistant');
    if (Array.isArray(m.content) && m.content.length > 0) {
      const terminalText = m.content.filter((p: any) => p.type === 'output_text').map((p: any) => p.text ?? '').join('');
      assert.equal(terminalText, finalText, 'Terminal text differs from streamed item');
      terminalTextCompared = true;
    }
  }
  const deltas = frames.filter(f => f.data.type === 'response.output_text.delta' && typeof f.data.delta === 'string' && f.data.delta.length > 0);
  assert.ok(deltas.length > 1, 'At least two nonempty text deltas required');
  assert.ok(deltas.every(f => f.data.item_id === message.id), 'Delta item IDs differ');
  assert.ok(frames.every(f => f.data.response_id == null || f.data.response_id === response.id), 'Event response IDs differ');
  assert.equal(deltas.map(f => f.data.delta).join(''), finalText, 'Raw deltas differ from final API text');
  if (sdkText != null) assert.equal(sdkText, finalText, 'SDK final text differs from API text');
  for (const f of frames.filter(f => f.data.type === 'response.output_text.done')) {
    assert.equal(f.data.item_id, message.id, 'text.done ID differs');
    assert.equal(f.data.text, message.content?.[f.data.content_index]?.text, 'text.done content differs');
  }
  const itemAdded = frames.find(f => f.data.type === 'response.output_item.added' && f.data.item?.id === message.id);
  assert.ok(itemAdded && itemDone, 'Message lifecycle events missing');
  const itemDoneText = itemDone.data.item.content.filter((p: any) => p.type === 'output_text').map((p: any) => p.text).join('');
  assert.equal(itemDoneText, finalText, 'item.done differs from final response');
  const usage = response.usage;
  assert.ok(Number.isInteger(usage?.input_tokens) && Number.isInteger(usage?.output_tokens), 'Native token usage missing');
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  assert.ok(Number.isInteger(reasoning), 'Native reasoning token count missing');
  const nonreasoning = usage.output_tokens - reasoning;
  assert.ok(nonreasoning > 0 && reasoning >= 0, 'Invalid native counts');
  const first = deltas[0], last = deltas.at(-1)!;
  const span = seconds(last.at, first.at);
  assert.ok(span > 0, 'Visible stream is fully coalesced; TPS unavailable');
  const gaps = deltas.slice(1).map((f, i) => seconds(f.at, deltas[i].at));
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const cumulative: number[] = [];
  let chars = 0;
  for (const f of deltas) { chars += f.data.delta.length; cumulative.push(chars); }
  const lo = cumulative.findIndex(n => n >= chars * .2);
  const hi = cumulative.findIndex(n => n >= chars * .8);
  const centralSpan = seconds(deltas[hi].at, deltas[lo].at);
  const seq = frames.map(f => f.data.sequence_number).filter(Number.isInteger);
  const monotonicallyIncreasingSequence = seq.every((v, i) => !i || v > seq[i - 1]);
  assert.ok(monotonicallyIncreasingSequence, 'Duplicate/out-of-order sequence numbers');
  return {
    summary: {
      model_requested: requestedModel, model_echo: response.model ?? null,
      effort_requested: 'xhigh', effort_echo: response.reasoning?.effort ?? null,
      service_tier_requested: 'default', service_tier_echo: response.service_tier ?? null,
      native_usage: safeUsage(usage), native_nonreasoning_output_tokens: nonreasoning,
      count_provenance: `${terminal.data.type}.usage; nonreasoning=output_tokens-output_tokens_details.reasoning_tokens; may include framing`,
      ttft_visible_s: seconds(first.at, sendAt), first_to_last_visible_s: span,
      native_nonreasoning_over_visible_span_tps: nonreasoning / span,
      message_item_receipt_s: seconds(itemDone.at, itemAdded.at),
      native_nonreasoning_over_message_receipt_tps: nonreasoning / seconds(itemDone.at, itemAdded.at),
      full_response_s: seconds(terminal.at, sendAt),
      end_to_end_all_output_tokens_per_s: usage.output_tokens / seconds(terminal.at, sendAt),
      server_created_at: response.created_at ?? null,
      raw_delta_count: deltas.length, first_delta_utf16_chars: first.data.delta.length,
      first_delta_utf8_bytes: Buffer.byteLength(first.data.delta),
      final_utf16_chars: chars, final_utf8_bytes: Buffer.byteLength(finalText),
      max_interdelta_gap_s: Math.max(...gaps),
      median_interdelta_gap_s: sortedGaps[Math.floor(sortedGaps.length / 2)],
      p95_interdelta_gap_s: sortedGaps[Math.floor((sortedGaps.length - 1) * .95)],
      same_timestamp_delta_fraction: gaps.filter(g => g === 0).length / gaps.length,
      central_20_80_utf16_chars_per_s: centralSpan > 0 ? (cumulative[hi] - cumulative[lo]) / centralSpan : null,
      terminal_message_text_present_and_compared: terminalTextCompared,
      validations: { one_terminal_response: true, one_assistant_message: true, no_tools_or_compaction: true,
        IDs_match: true, raw_deltas_equal_final: true, SDK_text_equals_API_text: sdkText != null,
        native_counts_present: true, sequence_monotonic: true },
    },
    finalText,
  };
}

function safeEvent(f: Frame, sendAt: bigint) {
  const d = f.data;
  return { type: d.type, receive_ns: (f.at - sendAt).toString(), wire_read_end_bytes: f.wireEnd,
    sequence_number: d.sequence_number ?? null, item_type: d.item?.type ?? null,
    response_id_sha256: d.response_id || d.response?.id ? hash(d.response_id ?? d.response.id) : null,
    item_id_sha256: d.item_id || d.item?.id ? hash(d.item_id ?? d.item.id) : null,
    output_index: d.output_index ?? null, content_index: d.content_index ?? null,
    delta_utf16_chars: typeof d.delta === 'string' ? d.delta.length : null,
    delta_utf8_bytes: typeof d.delta === 'string' ? Buffer.byteLength(d.delta) : null };
}

async function loadPi() {
  const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), 'node_modules/@earendil-works/pi-coding-agent');
  const root = resolve(arg('--pi-root', defaultRoot)!);
  const runtimePath = join(root, 'dist/core/model-runtime.js');
  const authPath = join(root, 'dist/core/auth-storage.js');
  // Resolve both npm-hoisted and nested dependencies without touching global Pi.
  const requireFromPi = createRequire(join(root, 'package.json'));
  const aiRoot = requireFromPi.resolve.paths('@earendil-works/pi-ai')!
    .map(p => join(p, '@earendil-works/pi-ai')).find(p => existsSync(join(p, 'package.json')));
  assert.ok(aiRoot, 'Pi API package unavailable');
  const apiPath = join(aiRoot, 'dist/api/openai-codex-responses.js');
  const { ModelRuntime } = await import(pathToFileURL(runtimePath).href);
  const { ReadOnlyAuthStorage } = await import(pathToFileURL(authPath).href);
  const codexHome = arg('--codex-home');
  const credentials = process.argv.includes('--self-test')
    ? { read: async () => undefined, list: async () => [], modify: async () => { throw new Error('Offline credentials are read-only'); }, delete: async () => { throw new Error('Offline credentials are read-only'); } }
    : codexHome ? new ReadOnlyCodexCredentials(codexHome) : new ReadOnlyAuthStorage();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel('openai-codex', arg('--model', 'gpt-6.1-sol'));
  assert.ok(model && model.api === 'openai-codex-responses', 'Exact native Codex model unavailable');
  return { runtime, model, apiPath, authentication: codexHome ? 'Existing Codex auth.json via read-only Pi CredentialStore adapter' : 'Pi SDK ReadOnlyAuthStorage; existing native Codex OAuth', versions: {
    pi_coding_agent: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    pi_ai: JSON.parse(readFileSync(join(aiRoot, 'package.json'), 'utf8')).version,
    node: process.version, provider_source_sha256: hash(readFileSync(apiPath)),
    usage_processor_sha256: hash(readFileSync(join(aiRoot, 'dist/api/openai-responses-shared.js'))),
  } };
}

function fixture() {
  const text = 'const café = 42;\n';
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
  const response = { id: 'resp_fixture', model: 'gpt-6.1-sol', status: 'completed', service_tier: 'default',
    reasoning: { effort: 'xhigh' }, output: [item], usage: { input_tokens: 100000,
      input_tokens_details: { cached_tokens: 80000 }, output_tokens: 17, output_tokens_details: { reasoning_tokens: 11 }, total_tokens: 100017 } };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    ...['const ca', 'fé = ', '42;\n'].map(delta => ({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta })),
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ].map((e, i) => ({ ...e, sequence_number: i }));
  return { text, events, bytes: Buffer.from(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('')) };
}

async function selfTest() {
  globalThis.fetch = async () => { throw new Error('Network is forbidden in offline tests'); };
  const pi = await loadPi();
  const f = fixture();
  // Every byte is its own read: tests split UTF-8 characters, CRLF and SSE boundaries.
  const samples = [...f.bytes].map((b, i) => ({ at: BigInt(i + 1) * 1000000n, bytes: Buffer.from([b]) }));
  const frames = parseFrames(samples);
  const a = analyze(frames, 0n, 'gpt-6.1-sol', f.text);
  assert.equal(a.summary.native_nonreasoning_output_tokens, 6);
  assert.ok(a.summary.native_usage);
  assert.equal(a.summary.native_usage.input_tokens, 100000);
  assert.equal(a.summary.native_usage.input_tokens_details.cached_tokens, 80000);
  assert.equal(a.finalText, f.text);
  const jwtFixture = `e30.${Buffer.from(JSON.stringify({exp:Date.now()/1000+3600})).toString('base64url')}.fixture`;
  assert.equal(codexCredential({auth_mode:'chatgpt',tokens:{access_token:jwtFixture}}).access, jwtFixture);
  assert.throws(()=>codexCredential({auth_mode:'apikey',tokens:{access_token:jwtFixture}}));
  assert.throws(()=>codexCredential({auth_mode:'chatgpt',tokens:{access_token:'not-a-jwt'}}));
  const expiredFixture = `e30.${Buffer.from(JSON.stringify({exp:Date.now()/1000-1})).toString('base64url')}.fixture`;
  assert.throws(()=>codexCredential({auth_mode:'chatgpt',tokens:{access_token:expiredFixture}}));
  const terminalWithoutOutput = frames.map(x => ({ ...x, data: { ...x.data } }));
  const finalFrame = terminalWithoutOutput.at(-1)!;
  finalFrame.data.response = { ...finalFrame.data.response, output: [] };
  assert.equal(analyze(terminalWithoutOutput, 0n, 'gpt-6.1-sol', f.text).summary.terminal_message_text_present_and_compared, false);
  assert.throws(() => parseFrames([...samples, { at: 100000000000n, bytes: Buffer.from('data: {') }]));
  assert.equal(parseFrames([...samples, { at: 100000000000n, bytes: Buffer.from('data: {') }], true).length, frames.length);
  const wrongID = frames.map(x => ({ ...x, data: { ...x.data } }));
  wrongID.find(x => x.data.type === 'response.output_text.delta')!.data.item_id = 'wrong';
  assert.throws(() => analyze(wrongID, 0n, 'gpt-6.1-sol', f.text));
  const wrongDoneText = frames.map(x => ({ ...x, data: { ...x.data } }));
  const doneFrame = wrongDoneText.find(x => x.data.type === 'response.output_item.done')!;
  doneFrame.data.item = { ...doneFrame.data.item, content: [{ type: 'output_text', text: 'wrong' }] };
  assert.throws(() => analyze(wrongDoneText, 0n, 'gpt-6.1-sol', f.text));
  const { stream } = await import(pathToFileURL(pi.apiPath).href);
  const fakeJWT = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-not-a-real-account' } })).toString('base64')}.fixture`;
  let payload: any;
  const wire = new WireRecorder();
  const sdkFixtureBytes = Buffer.from(f.bytes.toString().replace(/\r\n/g, '\n'));
  const s = stream(pi.model, { messages: [{ role: 'user', content: 'offline fixture', timestamp: 0 }] }, {
    apiKey: fakeJWT, transport: 'sse', serviceTier: 'default', reasoningEffort: 'xhigh', toolChoice: 'none', maxRetries: 0,
    onPayload(p: any) { payload = p; },
    fetch: async () => {
      const chunks = [sdkFixtureBytes.subarray(0, 137), sdkFixtureBytes.subarray(137, 523), sdkFixtureBytes.subarray(523)];
      return wire.wrap(new Response(new ReadableStream({ pull(c) { const b = chunks.shift(); b ? c.enqueue(b) : c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }));
    },
  });
  for await (const _ of s) { /* consume without terminal formatting */ }
  const result = await s.result();
  assert.equal(result.stopReason, 'stop', result.errorMessage ?? 'offline SDK fixture failed');
  assert.equal(result.usage.reasoning, 11);
  assert.equal(result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''), f.text);
  assert.equal(payload.model, 'gpt-6.1-sol');
  assert.equal(payload.reasoning.effort, 'xhigh');
  assert.equal(payload.service_tier, 'default');
  assert.equal(payload.tool_choice, 'none');
  assert.equal(payload.tools, undefined);
  assert.equal(Buffer.concat(wire.samples.map(x => x.bytes)).equals(sdkFixtureBytes), true);
  console.log(JSON.stringify({ self_test: 'passed', live_model_calls: 0,
    checks: ['Codex_read_only_adapter_format_and_expiry', 'split_UTF8_and_CRLF', 'partial_stream_preserved', 'terminal_without_output', 'native_reasoning_subtraction', 'cached_input_preserved', 'ID_mismatch_rejected', 'final_text_mismatch_rejected', 'Pi_payload_and_parser', 'wire_bytes_preserved'], versions: pi.versions }));
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node pi-api-meter.ts --prompt FILE --out NEW_DIRECTORY [--codex-home DIRECTORY] [--model MODEL] [--label LABEL] [--timeout-ms 600000] [--pi-root SDK_DIRECTORY]\nOffline: --self-test\nRead-only auth check: --preflight\nLive runs use xhigh, default tier and SSE; each run consumes subscription usage.');
    return;
  }
  if (process.argv.includes('--self-test')) return selfTest();
  const pi = await loadPi();
  const auth = await authMetadata(pi.runtime, pi.model);
  if (process.argv.includes('--preflight')) {
    console.log(JSON.stringify({status:'preflight',live_model_calls:0,model:pi.model.id,api:pi.model.api,versions:pi.versions,authentication:pi.authentication,...auth}));
    return;
  }
  assert.ok(auth.auth_available, 'Existing native Codex OAuth unavailable');
  const promptFile = arg('--prompt');
  const inlinePrompt = (globalThis as any).__PI_METER_INLINE_PROMPT;
  assert.ok(promptFile || typeof inlinePrompt === 'string', '--prompt is required');
  const prompt = typeof inlinePrompt === 'string' ? inlinePrompt : readFileSync(resolve(promptFile!), 'utf8');
  const out = resolve(arg('--out', 'api-result')!);
  const stdoutArtifacts = process.argv.includes('--stdout-artifacts');
  if (!stdoutArtifacts) {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    assert.ok(!['summary.json', 'failure.json'].some(f => existsSync(join(out, f))), 'Use a fresh output directory for each run');
  }
  const persist = (name: string, contents: string) => stdoutArtifacts
    ? console.log(JSON.stringify({artifact:name,encoding:'base64',data:Buffer.from(contents).toString('base64')}))
    : writeFileSync(join(out,name),contents,{mode:0o600});
  const system = 'You are a code generation assistant. Follow the user request without tools. Return only the requested TypeScript file.';
  const wire = new WireRecorder();
  let payload: any = null;
  const controller = new AbortController();
  const timeoutMs = Number(arg('--timeout-ms', '600000'));
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1800000, 'Timeout must be 1..1800000 milliseconds');
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sdkMessage: any;
  try {
    const s = pi.runtime.stream(pi.model, { messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt, timestamp: 0 },
    ] }, { transport: 'sse', serviceTier: 'default', reasoningEffort: 'xhigh',
      reasoningSummary: 'auto', toolChoice: 'none', textVerbosity: 'low', cacheRetention: 'none',
      maxRetries: 0, signal: controller.signal, fetch: wire.fetch,
      onPayload(p: any) { payload = p; },
    });
    for await (const _ of s) { /* no UI rendering or disk flush on the measurement path */ }
    sdkMessage = await s.result();
    assert.equal(wire.calls, 1, 'Exactly one HTTP inference request required');
    assert.equal(wire.status, 200, 'Codex endpoint did not return HTTP 200');
    assert.equal(sdkMessage.stopReason, 'stop', 'SDK response did not finish normally');
    assert.equal(payload.model, pi.model.id);
    assert.equal(payload.reasoning.effort, 'xhigh');
    assert.equal(payload.service_tier, 'default');
    assert.equal(payload.tools, undefined);
    const sdkText = sdkMessage.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    const frames = parseFrames(wire.samples);
    // Save completed visible output and comparison evidence before strict validation.
    // This happens after inference timing ends and survives a validator failure.
    persist('generated.ts', sdkText);
    const rawText = frames.filter(f=>f.data.type==='response.output_text.delta').map(f=>f.data.delta??'').join('');
    persist('text-validation.json', JSON.stringify({sdk_sha256:hash(sdkText),delta_sha256:hash(rawText),
      delta_equals_sdk:rawText===sdkText,
      completed_messages:frames.filter(f=>f.data.type==='response.output_item.done' && f.data.item?.type==='message').map(f=>{
        const t=(f.data.item.content??[]).filter((p:any)=>p.type==='output_text').map((p:any)=>p.text??'').join('');
        return {id_sha256:hash(f.data.item.id),text_sha256:hash(t),equals_delta:t===rawText,equals_sdk:t===sdkText};
      })},null,2)+'\n');
    const a = analyze(frames, wire.sendAt!, pi.model.id, sdkText);
    const input = { prompt_sha256: hash(prompt), prompt_utf8_bytes: Buffer.byteLength(prompt),
      system_sha256: hash(system), request_json_sha256: hash(JSON.stringify(payload)),
      request_json_bytes: Buffer.byteLength(JSON.stringify(payload)), request_input_items: payload.input.length,
      request_tool_schemas: payload.tools?.length ?? 0, previous_response_id_present: !!payload.previous_response_id,
      config_sha256: hash(JSON.stringify({ ...payload, input: undefined, instructions: undefined })),
      store: payload.store, stream: payload.stream, reasoning: payload.reasoning, service_tier: payload.service_tier };
    const summary = { ...a.summary, host_label: arg('--label', 'local'), send_utc: wire.sendUtc,
      versions: pi.versions, authentication: pi.authentication, auth_metadata: auth,
      timeout_ms: timeoutMs,
      transport: 'direct HTTPS SSE, Pi provider fetch hook', endpoint: wire.endpoint, http_status: wire.status,
      headers_received_s: seconds(wire.headersAt!, wire.sendAt!), first_body_read_s: seconds(wire.samples[0].at, wire.sendAt!),
      network_body_reads: wire.samples.length, response_wire_bytes: wire.wireBytes,
      request_wire_bytes: wire.requestWireBytes, request_content_encoding: wire.requestEncoding,
      input, measurement_boundary: 'Monotonic timestamp at HTTP body reader completion, before parsing. Client delivery; backend decode timing unavailable.' };
    persist('summary.json', JSON.stringify(summary, null, 2) + '\n');
    persist('events.json', JSON.stringify(frames.map(f => safeEvent(f, wire.sendAt!)), null, 2) + '\n');
    persist('wire-reads.json', JSON.stringify(wire.samples.map((c, i) => ({ read: i,
      receive_ns: (c.at - wire.sendAt!).toString(), bytes: c.bytes.length })), null, 2) + '\n');
    persist('generated.ts', a.finalText);
    console.log(JSON.stringify(summary));
  } catch (error) {
    // Never print SDK error payloads or credential objects, even on an auth failure.
    let frames: Frame[] = [];
    let frameParseError: string | null = null;
    try { frames = parseFrames(wire.samples, true); }
    catch (e) { frameParseError = e instanceof Error ? e.name : 'unknown'; }
    const eventCounts: Record<string, number> = Object.create(null);
    for (const f of frames) eventCounts[f.data.type] = (eventCounts[f.data.type] ?? 0) + 1;
    const deltas = frames.filter(f => f.data.type === 'response.output_text.delta' && typeof f.data.delta === 'string' && f.data.delta.length > 0);
    const terminal = frames.findLast(f => ['response.completed', 'response.done', 'response.failed', 'response.incomplete'].includes(f.data.type));
    const safeFailure = { status: 'failed', http_status: wire.status, inference_http_requests: wire.calls,
      endpoint: wire.endpoint, error_class: error instanceof Error ? error.name : 'unknown',
      assertion: error instanceof assert.AssertionError ? error.message.split('\n')[0] : null,
      prompt_sha256: hash(prompt), send_utc: wire.sendUtc, versions: pi.versions,
      timeout_ms: timeoutMs, timed_out: controller.signal.aborted, sdk_stop_reason: sdkMessage?.stopReason ?? null,
      elapsed_s: wire.sendAt == null ? null : seconds(now(), wire.sendAt),
      headers_received_s: wire.sendAt && wire.headersAt ? seconds(wire.headersAt, wire.sendAt) : null,
      network_body_reads: wire.samples.length, response_wire_bytes: wire.wireBytes,
      last_body_read_s: wire.sendAt && wire.samples.length ? seconds(wire.samples.at(-1)!.at, wire.sendAt) : null,
      first_visible_delta_s: wire.sendAt && deltas.length ? seconds(deltas[0].at, wire.sendAt) : null,
      visible_delta_count: deltas.length, visible_utf16_chars: deltas.reduce((n, f) => n + f.data.delta.length, 0),
      raw_event_counts: eventCounts, frame_parse_error_class: frameParseError,
      terminal_type: terminal?.data.type ?? null, terminal_status: terminal?.data.response?.status ?? null,
      native_usage: safeUsage(terminal?.data.response?.usage),
      terminal_output_shapes: terminal?.data.response?.output?.map((i: any) => ({type:i.type,role:i.role??null,id_sha256:i.id?hash(i.id):null,content_count:i.content?.length??null})) ?? null,
      sdk_text_sha256: sdkMessage?.content ? hash(sdkMessage.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')) : null,
      raw_delta_text_sha256: frames.length ? hash(deltas.map(f => f.data.delta).join('')) : null,
      item_done_text_sha256: frames.filter(f=>f.data.type==='response.output_item.done' && f.data.item?.type==='message')
        .map(f=>({id_sha256:hash(f.data.item.id),text_sha256:hash((f.data.item.content??[]).filter((p:any)=>p.type==='output_text').map((p:any)=>p.text??'').join(''))})),
      partial_stream_note: 'Partial text without native final usage is not assigned a token/sec rate.' };
    if (wire.sendAt != null) {
      persist('events.json', JSON.stringify(frames.map(f => safeEvent(f, wire.sendAt!)), null, 2) + '\n');
      persist('wire-reads.json', JSON.stringify(wire.samples.map((c, i) => ({ read: i,
        receive_ns: (c.at - wire.sendAt!).toString(), bytes: c.bytes.length })), null, 2) + '\n');
    }
    persist('failure.json', JSON.stringify(safeFailure, null, 2) + '\n');
    console.error(JSON.stringify(safeFailure));
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    // Sensitive request headers, SDK credentials and encrypted reasoning are never persisted.
    wire.samples.length = 0;
    payload = null;
    sdkMessage = null;
  }
}

main().catch(e => { console.error(JSON.stringify({ status: 'setup_failed', error_class: e?.name ?? 'unknown',
  ...(process.argv.includes('--self-test') ? { offline_fixture_error: e?.message, stack: e?.stack } : {}) })); process.exitCode = 1; });
