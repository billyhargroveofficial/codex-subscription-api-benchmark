# Codex subscription API benchmark

A TypeScript meter for the Codex subscription HTTPS SSE endpoint, using the
native Pi provider. It timestamps received HTTP body chunks before SSE parsing
and reports visible delivery speed separately from hidden reasoning tokens.

This is an independent experiment, not an official OpenAI SDK or a guarantee
of backend/GPU decode speed. The subscription endpoint and Pi internal module
paths can change. Live runs require your own existing, authorized subscription
credentials and consume its usage allowance. The tool does not create, refresh,
export or upload credentials anywhere except the intended Codex request.

## Install and test

Node.js 24+ and npm are required. Pi coding-agent / pi-ai are pinned to 1.0.2;
the lockfile pins the dependency graph. No global Pi or Codex installation is
needed for the offline tests.

```sh
git clone https://github.com/billyhargroveofficial/codex-subscription-api-benchmark.git
cd codex-subscription-api-benchmark
npm ci --ignore-scripts --no-audit --no-fund
npm run check
node pi-api-meter.ts --help
```

`npm run check` type-checks the program and runs offline tests. Tests replace
network fetch with a rejecting function, inject a mock transport, and use an
empty credential store. They never read your auth file or call a model.

## One live request

Use an existing Codex file credential store. The read-only adapter implements
Pi's public CredentialStore interface; the access token stays in local process
memory. API-key billing credentials are not substituted. Credentials needing
refresh fail without changing the file. Keyring-only credentials are not
supported by this file adapter.

```sh
# Optional read-only credential/model check; no inference:
node pi-api-meter.ts --preflight --codex-home "$HOME/.codex"

# One request, no retries or tool calls:
npm run benchmark -- \
  --codex-home "$HOME/.codex" \
  --prompt examples/synthetic-code-prompt.txt \
  --out runs/host-a --label host-a
```

Omit `--codex-home` to use Pi's existing read-only native credential store.
The default model is `gpt-6.1-sol`; `--model` requires an exact model present in
the pinned provider catalog and available to your account. There is no silent
model fallback. Effort is fixed to `xhigh`, tier to `default` (Standard), and
transport to SSE. The default timeout is 600000 ms; `--timeout-ms` accepts up
to 1800000 ms. Every run needs a fresh output directory.

The included synthetic workload contains 2400 fictional maintenance records
and asks for a complete TypeScript parser/aggregator/CSV module. In the recorded
pair it produced 101209 native input tokens and about 1800 visible output
tokens, plus 9410–11002 reasoning tokens. Those counts are observations, not
guaranteed future sizes. You may supply a smaller synthetic prompt for a cheaper
control. Do not put secrets or private chat exports in a publishable workload.

## Survive an SSH/client disconnect

Run this command **on each host** after installation:

```sh
node scripts/start-run.mjs \
  --codex-home "$HOME/.codex" \
  --prompt examples/synthetic-code-prompt.txt \
  --out runs/host-a --label host-a
```

The detached process writes to that host's disk, including `run.log` and
`launch.json`. Reconnect and retrieve the result directory after completion.
This protects against terminal/SSH closure; it does not survive an OS restart
or guarantee that sleep/network loss leaves an inference connection intact.
HTTP chunk buffers remain in memory until the request finishes or throws;
power loss can still lose an in-flight measurement.

## Metrics and output

See [METHODOLOGY.md](METHODOLOGY.md) for exact definitions and validation.

- `summary.json`: native token counts, request/source hashes, timings, settings.
- `events.json`, `wire-reads.json`: sanitized event metadata and body-read times.
- `generated.ts`, `text-validation.json`: visible answer and text equality proof.
- `failure.json`: diagnostics for an unsuccessful or incomplete measurement.

`wire` in a field/file name means the body delivered by fetch after HTTP/TLS
handling and automatic decompression. It is not a packet capture. Output files
are local and may contain the model's answer to your prompt; review before
sharing. This repository includes only allowlisted, anonymized aggregate results,
not raw session events, credentials, account/request IDs or generated run logs.

## Recorded validated pair

[`examples/validated-pair.json`](examples/validated-pair.json) contains one
paired observation from 2026-10-06. Both requests had identical complete JSON
bodies, 101209 input tokens, zero cached input, `gpt-6.1-sol`, `xhigh`, and
`default` tier. Both passed ID, native-count and final-text validations.

| Metric | Host A | Host B |
|---|---:|---:|
| Visible delivery, tokens/s | 57.11 | 50.37 |
| Reasoning output tokens | 11002 | 9410 |
| Non-reasoning output tokens | 1845 | 1795 |
| First visible delta, seconds | 355.31 | 288.74 |
| Full response, seconds | 387.63 | 324.40 |

Host B's visible stream was 11.81% slower in this pair, while its whole response
finished sooner. Accounts were different; both OAuth claims indicated Pro.
Pi/Node versions differed but provider and usage-processor source hashes matched.
This single pair does not establish an enduring difference or its cause.

## Publication and dependencies

Project code is [MIT licensed](LICENSE). No third-party provider source or
dependency binaries are vendored. See [THIRD_PARTY.md](THIRD_PARTY.md) and
[`dependency-licenses.json`](dependency-licenses.json) for dependency notices.

The CI runs only offline checks on Node 24 and 26. Before publishing changes:

```sh
git add <reviewed-files>
npm run audit:publication -- --history
```

The audit checks the index and all reachable history with targeted secret/path
patterns. It complements manual review and cannot prove that every possible
secret or personal detail is absent. Never commit credentials or run directories.
