# CLIProxyAPI provider

Connects Pi to a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) server for GPT and Claude models.
GPT models use CPA's Responses WebSocket and continue earlier turns instead of resending the whole conversation.
Claude models use Anthropic Messages. OpenCode and OpenCode Go stay Pi's built-in providers.

The extension does nothing until its config file exists.

## Set up

1. Create `~/.pi/agent/cliproxyapi.json` (or `$PI_CODING_AGENT_DIR/cliproxyapi.json`):

   ```json
   { "baseUrl": "http://127.0.0.1:8317" }
   ```

2. Provide a CPA client key. Either set `CLIPROXYAPI_API_KEY` in Pi's environment or run `/login cliproxyapi`.
   A stored key can be a secret command such as `"!security find-generic-password -ws cpa"`.
3. Start Pi and run `/proxy`. You should see `ready`, the key source and the number of models.
   Run `/proxy models` to see the model table and metadata warnings.

On the first start without a cached model list, Pi asks CPA once, for at most 8 seconds, using the environment key.
Later starts and `/reload` use the cached list immediately. A matching catalog stays fresh for five minutes, including across restarts: background checks reuse it without contacting CPA. A missing or stale catalog is refreshed quietly, without a footer line. Pi owns the TUI startup refresh; the extension supplies one check for RPC and reloads, without an extra retry loop.
Print, JSON and offline runs use the cache without contacting CPA. `/proxy refresh` bypasses freshness and forces a server request. Failed refreshes keep the previous list.

## Move from a manual `proxy` provider in models.json

The extension refuses to register a provider id that `models.json` still defines with `models`, `baseUrl`, `api` or `oauth`.
`/proxy` names the conflict. To keep the name `proxy`:

1. Remove the `providers.proxy` block from `~/.pi/agent/models.json`. A block with only `modelOverrides` can stay.
2. Set `"provider": "proxy"` in `cliproxyapi.json`.
3. Move per-model corrections into `routes`, for example:

   ```json
   {
     "baseUrl": "https://cpa.example",
     "provider": "proxy",
     "routes": {
       "gpt-6.1-sol": { "contextWindow": 500000 },
       "gpt-6.1-sol-fast": { "metadata": "openai/gpt-6.1-sol", "contextWindow": 500000 }
     }
   }
   ```

4. Run `/reload`, then `/proxy refresh`.

Model ids stay exactly as CPA lists them, including aliases such as `gpt-6.1-sol-fast`.

## Configuration reference

`PI_CLIPROXYAPI_CONFIG` overrides the config file path. Unknown keys are rejected.

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | required | CPA root URL. A trailing `/v1` is accepted. |
| `provider` | `cliproxyapi` | Pi provider id. Built-in provider ids are refused. |
| `name` | `CLIProxyAPI` | Display name. |
| `apiKeyEnv` | `CLIPROXYAPI_API_KEY` | Environment variable that holds the client key. The file never holds the key itself. |
| `websocket` | `true` | `false` sends GPT requests over HTTP streaming (SSE) only. |
| `routes` | `{}` | Settings per CPA model id, described below. |

A route can set:

| Key | Meaning |
|---|---|
| `api` | `openai-responses` or `anthropic-messages`. Required for ids that are not inferred. |
| `metadata` | Pi catalog entry to enrich from, such as `openai/gpt-6.1-sol`. `null` turns enrichment off. |
| `name`, `contextWindow`, `maxTokens`, `input`, `reasoning`, `thinkingLevelMap`, `cost` | Corrections with Pi's model field meanings. |
| `promptCache` | Prompt cache lifetime in seconds per retention tier, such as `{ "long": 3600 }`. Pi warms only tiers listed here. On Claude routes, requests of a listed tier keep Pi's cache markers (see [Prompt cache lifetime](#prompt-cache-lifetime)). |
| `fallbackModels` | Claude only. Up to three CPA Claude routes Anthropic may answer with after a refusal. |
| `compat` | Pi compatibility settings for the route's API, such as `supportsMidConvoEffort` or `promptCacheKeyMode`. Settings for the other API are ignored with a warning. |

## Model list and metadata

CPA decides which models exist. Pi asks `GET /v1/models` and, for details, `GET /v1/models?client_version=pi`, which older CPA versions do not support.

Without a route, only bare ids are used: `gpt-*` with Responses and `claude-*` with Anthropic Messages.
Other ids, such as `go/claude-haiku-5-5`, are hidden and listed in `/proxy models`.

Each field takes the first available source:

| Field | GPT routes | Claude routes |
|---|---|---|
| Context window | route, CPA, Pi catalog | route, then CPA or Pi catalog (the smaller when both exist) |
| Max output, input types, reasoning levels | route, CPA, Pi catalog | route, Pi catalog |
| Price | route, Pi catalog | route, Pi catalog |

CPA reports GPT-style details even for Claude ids it knows little about, so they are not trusted there.
Conflicting context sizes appear as warnings in `/proxy models`.

Metadata comes from Pi's own model catalog: the session catalog including pi.dev updates, or the catalog bundled with Pi.
There is no separate models.dev download. The default entry is `openai/<id>` for GPT and `anthropic/<id>` for Claude.
Fields that no source provides stay conservative: text only, no reasoning, 128000 context, 16384 output and price 0.
This is common for aliases without a catalog entry. `/proxy models` warns about unverified default limits. A price of 0 does not mean free, and catalog prices are estimates, not CPA billing.

From a catalog entry, only flags describing the request shape are taken, such as strict tools and adaptive thinking.
Mid-conversation features such as `configuration_update`, message threads, session affinity, prompt cache lifetimes and refusal fallbacks stay off unless a route enables them.
The catalog describes Anthropic's and OpenAI's own endpoints, and CPA can change cache markers and model ids on the way.

## Cache

The model list is stored in Pi's `models-store.json` under the provider id, with the CPA root and a scrypt hash of the key.
The key itself is not stored. A cached list is used only for the same CPA root.
The extension checks its scope against the resolved key when Pi makes that key available, including keys stored as secret commands. This is a local cache check, not a request to CPA. Restoring the cache does not reset its five-minute freshness window.

## WebSocket continuation

For GPT models in a session, Pi's normal Responses request is carried over `wss://<root>/v1/responses`.
When a request extends the previous one on the same connection, only the new input is sent with `previous_response_id`.
Pi keeps the full history. Continuation only saves sending it again.

- A continuation is sent only when the request options are identical and the new input starts with the previous input and that response's output, item for item.
- Anything else, including compaction, `/tree` navigation, edited history and model changes, starts a full request on a new connection.
- Connections belong to one session, model and key. Parallel and subagent sessions never share them.
- If CPA rejects a continuation, or closes with code 1012 to ask for a replay, the full history is sent once on a new connection.
- If the WebSocket cannot connect, the same request goes over HTTP and the session stays on HTTP for 5 minutes.
- If a reused connection is lost before the request was sent, the full history goes over a new connection.
- If CPA may have received a request, the extension reports the failure instead of resending it. Pi's own retry policy still applies.
- Idle connections close after 5 minutes. Aborts, `/reload` and session shutdown close them.
- Pi's `transport: "sse"` setting, a model with a different `baseUrl`, and requests without a session id use HTTP.
- Requests with `disableContinuation`, such as Pi's cache-warming replays, use HTTP with the full input. The session's connection and continuation stay as the last real turn left them.

Request hooks work as usual. For WebSocket requests, `onResponse` sees a synthetic `200 text/event-stream` response, not the handshake headers.

Continuation applies between Pi and CPA. How CPA reaches the upstream service is CPA's decision.
For HTTP upstreams, CPA expands each continuation back to the full history.

## Claude routes

Pi's Anthropic adapter builds every Claude request. A route opts into the features that CPA and its upstream support. This route enables everything for Claude Fable 5.2:

```json
{
  "routes": {
    "claude-fable-5-2": {
      "promptCache": { "long": 3600 },
      "fallbackModels": ["claude-opus-5"],
      "compat": {
        "supportsMidConvoEffort": true,
        "supportsMidConvoSystemMessages": true,
        "supportsMidConvoToolChanges": true,
        "supportsMessageThreads": true,
        "sendSessionAffinityHeaders": true
      }
    },
    "claude-opus-5": { "compat": { "supportsMidConvoEffort": true } }
  }
}
```

- `supportsMidConvoEffort` sends thinking-level changes as effort markers in the conversation and sets `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`. Fable 5.2 rejects edited history with a 400 error without it.
- `supportsMidConvoSystemMessages` and `supportsMidConvoToolChanges` send system prompt and tool changes in place instead of rewriting the start of the conversation.
- `supportsMessageThreads` lets a turn send only its new messages. Pi starts a new thread with the full history after any change to earlier messages, the system prompt or tools, and when Anthropic or CPA rejects the thread. CPA's own rejection, sent when a cloaked credential lost its tool-name state for the thread, is a 404 without Anthropic's error code; the extension adds `thread_not_found` to that exact response so Pi resends the conversation once.
- `sendSessionAffinityHeaders` sends the session id as `x-session-affinity`, which CPA uses to keep a session on one credential.

For thread-enabled routes, requests carrying Pi's message-threads beta also retain `advanced-tool-use-2025-11-20`. CPA infers that beta from tool-search declarations but otherwise drops it when Pi omits unchanged tools on continuation, causing Anthropic to reject the changed thread fingerprint. The extension adds it after Pi generates headers, without replacing Pi's other betas. Explicit beta suppression and unthreaded routes stay unchanged.

### Prompt cache lifetime

Without `promptCache`, Pi does not warm the route's cache and CPA decides cache markers and their lifetimes. On cloaked credentials, such as Claude OAuth, CPA changes Pi's five-minute markers to one hour. On credentials with `cloak: never`, they stay five minutes.

`promptCache` does not choose a lifetime. Pi's cache retention does: the default short retention writes five-minute markers, and long retention (`PI_CACHE_RETENTION=long`) writes one-hour markers. `promptCache` states how long the entries of each tier last on this route, so Pi can warm them before they expire. For Anthropic these are 300 seconds for `short` and 3600 seconds for `long`.

A request whose retention tier is listed in `promptCache` also carries `prompt_cache_options: { "mode": "explicit" }`. CPA then keeps Pi's markers as written and removes the field before the upstream request. A request with `cacheRetention: "none"` carries it too, so CPA does not add markers that Pi left out. Requests of a tier that is not listed are sent as before, and CPA keeps handling their markers. The same rules apply when `models.json` sets `promptCache` for the model through `modelOverrides`.

Choose the tiers by the cache you want:

| `promptCache` | Short retention (default) | Long retention |
|---|---|---|
| not set | CPA decides: one hour on cloaked credentials, five minutes otherwise. Not warmed. | CPA decides. Not warmed. |
| `{ "long": 3600 }` (recommended) | Same as not set. | One hour as written by Pi, warmed. |
| `{ "short": 300, "long": 3600 }` | Five minutes as written by Pi, warmed. | One hour as written by Pi, warmed. |

Add `short` only if you want five-minute entries that Pi keeps warm. On a cloaked credential, this replaces the one-hour entries CPA would otherwise write. Pi keeps the shorter entries warm with extra one-token requests while it estimates that they pay off. These requests are billed as cache reads and count against the credential's quota.

The field is added before Pi's `before_provider_request` hooks run, so they see and can change it. This was verified against CPA 8.0.48 and 8.0.64 source and executor tests, not against Anthropic.

### Refusal fallbacks

`fallbackModels` lists other CPA routes Anthropic may answer with when the model refuses. Pi sends them as Anthropic's `fallbacks` field and prices a fallback reply with the fallback route's price. A target is used only when:

- Pi's catalog entry for the route lists it as a permitted fallback (Fable 5.2: `claude-opus-5`),
- CPA offers it as a Claude route with a known price,
- and it supports effort markers when the route uses them.

Ignored targets appear as warnings in `/proxy models`. Credential fallback inside CPA is unrelated to this setting.

## Commands

- `/proxy` shows an aligned status snapshot: `checking` while the background check runs, `ready` after verification, `cached` when showing a saved model list, `refresh failed` after an unsuccessful check or `not ready` when the key or models are missing.
  The command itself does not contact CPA. It counts metadata notices, config warnings and hidden ids without listing them. Metadata notices, such as a missing price, do not make the provider unhealthy.
  `idle` means this session has not sent a GPT request yet; the WebSocket opens on the first one.
- `/proxy models` shows an aligned table, one row per model, with API, token limits, input types, reasoning support and note references. Narrow terminals omit optional columns and shorten long model ids. Shared metadata warnings appear once below the table, followed by config warnings and hidden ids.
- `/proxy refresh` immediately shows a notification, then reports success, failure or timeout. Failed refreshes keep the previous list. A second refresh while one is running reports that it is already in progress. Neither automatic checks nor manual refreshes add a footer line.

Without an interactive UI, the commands write to stderr.

## Limitations

- First-use discovery before model selection needs the key in the environment. If there is no cached catalog yet and the key is only stored, Pi needs another available model to finish startup before the background check can discover CPA models.
- `pi update --models` does not load extensions, so it does not refresh this provider.
- Message threads and refusal fallbacks need the route id to be the upstream model id. CPA reports a different model id for aliases, which Pi treats as a fallback reply: it does not continue the thread and, for force-mapped aliases, cannot see a real fallback.

## Development

`pnpm test` covers this extension. `pnpm test:cli` stages the package with runtime dependencies only and runs it under the installed `pi` binary; set `PI_BIN` to use another one.
