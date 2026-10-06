# Measurement contract

The endpoint is `https://chatgpt.com/backend-api/codex/responses`. Each run uses
one POST, explicit SSE, `store:false`, no tools, no previous-response continuation,
and zero automatic retries. The endpoint allowlist prevents accidental use of
a different provider. Authentication is resolved locally through Pi; headers
and tokens are never logged. The program is not a general subscription gateway.

The start time is a monotonic `process.hrtime.bigint()` sample immediately
before fetch. Every completed body reader read is timestamped before copying
bytes or parsing SSE. Frames get the timestamp of the read containing their
last byte. Coalesced frames share a timestamp. Disk output and terminal rendering
occur after inference timing ends. Pi still parses the live stream; client
scheduling, buffering, network delays and SDK processing can affect delivery.

Let O be native `usage.output_tokens`, R be native
`usage.output_tokens_details.reasoning_tokens`, F/L be first/last nonempty
visible text-delta receipt, S be send, and C be terminal response receipt:

```
non-reasoning output = O - R
visible delivery TPS = (O - R) / (L - F)
visible TTFT = F - S
full response duration = C - S
all-output end-to-end rate = O / (C - S)
```

These are different metrics. TTFT includes network/queue/prefill and preceding
reasoning time; it is not pure reasoning time. Native output can include
framing. The numerator includes the first chunk, while the first-to-last
denominator excludes the time before that chunk. Native per-chunk token counts
are unavailable, so this convention is explicit rather than an exact backend
decode estimate. Character counts are diagnostic, not a replacement tokenizer.
Reasoning summaries are not the full hidden reasoning transcript.

The meter also records message-added to message-done rate, chunk/delta counts,
max/median/p95 gaps, coalescing, and a central 20–80% character rate. Clock values
come from the requesting host; SSH transport of completed files is not timed.

## Validation

A successful measurement requires one completed terminal response, matching
response/item IDs, monotonic event sequence numbers, one assistant message,
no tools/compaction, native usage including reasoning counts, and at least two
nonempty visible deltas with positive duration. The request and any server
echoes of model/effort/tier must agree. Missing echoes remain null, not guessed.

Raw deltas, completed streamed message and Pi's final text must be identical.
Some terminal responses omit the message body: `response.output_item.done`
then provides the authoritative completed text. If the terminal body is present,
it is compared too. The summary separately records whether that optional check
was possible. A completed answer and text hashes are saved before strict
validation so a later validation failure does not discard them.

Incomplete requests get diagnostics and no certified TPS. The timeout is a
client limit, not a claim about server completion or billed usage. There is no
automatic retry. Hidden reasoning bytes and encrypted continuation material
are held in memory only and omitted from saved artifacts.

## Comparability and limitations

Compare full JSON request hashes, synthetic prompt/system hashes, exact model,
effort, tier, transport, native input/cache counts, source versions and output
lengths. `cacheRetention:none` removes Pi's session cache key; it does not force
the server cache off. Native cached counts must be checked after each run.
Pi's normalized input usage subtracts cache reads; this meter uses native
input counts to avoid that ambiguity.

The pinned model names and internal subscription endpoint are a snapshot and
may stop working or change. Subscription plan labels are read from existing
OAuth claims, not independently verified against billing. Different accounts,
regions, routes, server load, variable reasoning and different answer content
can affect observations. One pair cannot isolate those causes or estimate a
stable mean. No server/GPU generation timestamps are available here.

## Provenance of published data

The prompt was constructed for this experiment from fictional numbered bicycle
maintenance records and a code-generation task. It is not a private chat export.
Its complete SHA256 is checked offline against both result records. Published
results use Host A/B and an explicit allowlist of configuration, timing, native
counts and code/prompt hashes. Raw IDs, ID hashes, accounts, timestamps within
the day, local paths, SSH settings, auth files and raw event logs are excluded.

References: [OpenAI reasoning usage](https://developers.openai.com/api/docs/guides/reasoning),
[Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses),
[Codex auth storage format](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs),
[Pi source](https://github.com/earendil-works/pi).
