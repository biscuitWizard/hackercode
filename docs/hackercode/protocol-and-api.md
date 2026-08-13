# JSON-RPC protocol and proposed API

## Endpoint discovery and authentication

When control mode is enabled, the main process writes:

```text
<user-data-dir>/hackercode/control.json
```

Read `protocol`, `host`, `port`, `token`, and `pid` from that file. Do not print the file or token. The WebSocket URL uses the shared transport query name `tkn`:

```text
ws://127.0.0.1:54321/?tkn=FAKE_TOKEN_DO_NOT_USE
```

The token above is intentionally fake. URL-encode the real value in memory, and avoid command lines or logs that may persist it.

The control endpoint uses JSON-RPC 2.0 over text WebSocket frames. Request IDs must be non-negative safe integers. String and null request IDs are rejected. All mutation calls must be requests with an `id`; notifications are ignored and receive no response.

## Main method reference

Method names are plain strings except renderer registration.

| Method | Parameters | Result | Main-owned behavior |
| --- | --- | --- | --- |
| `getState` | absent, `null`, or `{}` | `IHackerCodeState` | Returns normalized ledger plus current baseline information. |
| `listRevisions` | absent, `null`, or `{}` | revision manifest array | Orders newest non-pristine revisions first and pristine last. |
| `createRevision` | `{ baseline, description?, parentId?, patches: [{ name, content }] }` | revision manifest | Validates current source baseline, content-addresses and stores patch sources, and adds the manifest without activating it. |
| `setRevision` | `{ revisionId, windowId?, mode?: "normal" \| "recover" }` | state | Selects, persists a boot attempt, arms monitoring, and reloads one/all eligible workbench windows. Recover mode falls back instead of activating unknown, quarantined, or baseline-invalid state. |
| `safeMode` | `{ reason?, windowId? }` | state | Quarantines/falls back, clears boot state, sets `skipPromoted`, and reloads one/all eligible windows. |
| `reload` | `{ revisionId, windowId }` | state | Requires the active revision, starts a boot attempt, and reloads the specified workbench window. |
| `promote` | `{ revisionId, windowId, commitMessage? }` | `{ revisionId, previousHead, newHead, commitMessage }` | Promotes the active non-pristine revision in a source checkout and creates a path-limited git commit. |
| `eval` | `{ source, windowId? }` | bounded JSON-safe value | Forwards the async-function body to a registered renderer, defaulting to the focused workbench window. Maximum source is 256 KiB UTF-8. |
| `refresh` | `{ mode: "soft" \| "module" \| "hard", specifier?, windowId? }` | `null` | Forwards refresh to a renderer. `specifier` is required only for module mode and forbidden for other modes. |
| `$/hackerCode/registerRenderer` | `{ windowId }` | `null` | Registers that authenticated connection as the eval/refresh handler for an existing regular workbench window. |

Renderer-facing requests use the same plain `eval` and `refresh` method strings, with `windowId` removed.

### Parameter and storage limits

- At most 64 patches per revision.
- Patch names: one to 128 trimmed characters, no path separators or control characters, and not `.` or `..`.
- Patch content: at most 1 MiB UTF-8 per patch.
- Baseline: one to 256 trimmed characters.
- Description: at most 4096 characters; empty is allowed, but surrounding whitespace and NUL are rejected.
- Commit message: one trimmed line, at most 200 characters, with no control characters.
- Non-pristine revision IDs and patch hashes: lowercase 64-character hexadecimal SHA-256.
- `windowId`: positive safe integer.

The protocol layer rejects unknown keys at the outer parameter level. Domain validation in the main service applies the tighter bounds above.

## Requests and responses

### Read state

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getState"
}
```

Successful response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "schemaVersion": 1,
    "activeRevisionId": "pristine",
    "lastKnownGoodRevisionId": "pristine",
    "revisions": [
      {
        "schemaVersion": 1,
        "id": "pristine",
        "baseline": "pristine",
        "createdAt": "1970-01-01T00:00:00.000Z",
        "parentId": "pristine",
        "patches": []
      }
    ],
    "quarantinedRevisions": [],
    "skipPromoted": false,
    "baseline": {
      "current": "0123456789abcdef0123456789abcdef01234567",
      "promotionAvailable": true
    }
  }
}
```

### Create a revision

Patch content is a JSON string containing ESM source:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "createRevision",
  "params": {
    "baseline": "0123456789abcdef0123456789abcdef01234567",
    "description": "Add a diagnostic command",
    "parentId": "pristine",
    "patches": [
      {
        "name": "diagnostic-command",
        "content": "export default async function (ctx) {\n\tctx.registerCommand('hackercode.example.diagnostic', () => 'ok');\n}\n"
      }
    ]
  }
}
```

Use the returned 64-character `result.id` in a separate `setRevision` request. Creating a revision does not activate it.

### Activate the returned revision

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "setRevision",
  "params": {
    "revisionId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "windowId": 7
  }
}
```

This response can arrive before the reloaded renderer reports healthy. Observe the subsequent state/boot behavior rather than treating the response alone as validation.

### Evaluate in the focused renderer

The source is the body of an async function, not an ESM module:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "eval",
  "params": {
    "source": "return { services: runtime.listServices().length, active: await getService('hackerCodeControlService').getState() };"
  }
}
```

Evaluation receives these parameters:

```text
runtime
instantiationService
getService
refresh
```

The returned value is serialized without invoking getters. Plain arrays/objects are traversed; non-plain instances are summarized. Unsupported values become descriptive strings. Default limits are depth 6, breadth 100, and 1 MiB serialized output.

### Soft refresh

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "refresh",
  "params": {
    "mode": "soft",
    "windowId": 7
  }
}
```

### Module refresh

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "refresh",
  "params": {
    "mode": "module",
    "specifier": "vs/base/common/lifecycle.js",
    "windowId": 7
  }
}
```

The module must already have been loaded through a patch’s `ctx.import`.

### Enter safe mode

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "safeMode",
  "params": {
    "reason": "Operator requested recovery",
    "windowId": 7
  }
}
```

Do not send this as a notification. Notifications are intentionally ignored.

## Error conventions

Errors use the JSON-RPC response shape:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32602,
    "message": "Invalid method parameters"
  }
}
```

| Code | Name | Typical cause |
| --- | --- | --- |
| `-32700` | Parse error | The underlying WebSocket transport could not parse JSON. |
| `-32600` | Invalid request | Wrong JSON-RPC envelope or request ID; invalid envelopes without a usable ID return `id: null`. |
| `-32601` | Method not found | Unknown method for the main or renderer target. |
| `-32602` | Invalid params | Wrong object shape, extra key, missing required field, invalid mode/window ID, or eval source over the wire limit. |
| `-32603` | Internal error | Renderer runtime unavailable or a generic request handler failure mapped by the JSON-RPC layer. |
| `-32001` | Renderer unavailable | No target workbench window, no registered renderer, or renderer connection closed. |
| `-32002` | Request timeout | Forwarded renderer `eval` or `refresh` exceeded 30 seconds. |

Domain failures such as unknown/quarantined revisions, baseline mismatch, integrity failure, or unavailable promotion are also returned as JSON-RPC errors by the protocol wrapper. Callers must inspect both `error.code` and `error.message`.

## Renderer registration trust implication

The protocol does not assign separate “driver” and “renderer” credentials. Any holder of the root token can call `$/hackerCode/registerRenderer` with an existing eligible window ID and replace that window’s prior renderer connection. This is intentional under the token-equals-root-authority model, but it means token disclosure permits disruption or interception of forwarded renderer calls.

## Minimal client outline

The repository already depends on `ws`. A trusted Node client can keep the token out of output and correlate numeric IDs:

```js
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';

const metadata = JSON.parse(await readFile(
	'/FAKE/USER-DATA/hackercode/control.json',
	'utf8'
));
const url = `${metadata.protocol}://${metadata.host}:${metadata.port}/`
	+ `?tkn=${encodeURIComponent(metadata.token)}`;
const socket = new WebSocket(url);

await new Promise((resolve, reject) => {
	socket.once('open', resolve);
	socket.once('error', reject);
});

socket.send(JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	method: 'getState'
}));
```

Production tooling should add a response map, request timeouts, close/error handling, strict response validation, and token redaction. Never include the URL in an exception or log.

## Proposed `vscode.hackerCode` API

The proposal is declared in `src/vscode-dts/vscode.proposed.hackerCode.d.ts`. It intentionally does not expose the endpoint or token.

| Method | Result | Behavior |
| --- | --- | --- |
| `getState()` | `Thenable<HackerCodeState>` | Reads current state. |
| `listRevisions()` | `Thenable<readonly HackerCodeRevision[]>` | Lists known manifests. |
| `getRevision(revisionId)` | revision or `undefined` | Reads a manifest; stored non-pristine manifests are revalidated from disk. |
| `createRevision(options)` | revision | Creates without activation. |
| `selectRevision(revisionId)` | state | Targets the calling extension’s current workbench window and reloads it. |
| `enterSafeMode(reason?)` | state | Enters safe mode for the current workbench window. |
| `evaluate(source)` | `HackerCodeJsonValue` | Runs an async-function body locally in the renderer runtime and serializes the result. |
| `refresh("soft" \| "hard")` | `void` | Refreshes the calling renderer. |
| `refresh("module", specifier)` | `void` | Refreshes a tracked guarded module. |
| `promoteActiveRevision(commitMessage?)` | promotion result | Reads active state, then asks main to promote it for the current workbench window. |

### Enablement

An extension must declare the proposal:

```json
{
  "enabledApiProposals": [
    "hackerCode"
  ]
}
```

The development host must also permit that extension to use proposed APIs through the normal VS Code proposed-API development mechanism, such as the corresponding `--enable-proposed-api=<publisher.extension>` launch argument when required.

Every namespace method calls `checkProposedApiEnabled(extension, 'hackerCode')`. The main-thread bridge then separately requires HackerCode control mode:

- source/development build: enabled by default;
- built product: start with `--hackercode-control`.

The proposal is unstable and must not be treated as a normal published-extension API.

### API-specific details

- `selectRevision`, `enterSafeMode`, hard refresh, and promotion always supply the current workbench `windowId`.
- `evaluate` does not traverse the external WebSocket. The main-thread bridge executes in the renderer with the same privileged async-function mechanism.
- The extension bridge checks eval source by JavaScript character count against 256 Ki characters; the WebSocket protocol checks UTF-8 byte length against 256 KiB. Non-ASCII source can therefore fit the extension check while exceeding the external wire policy, because the paths are separate.
- API return types expose the same manifest, quarantine, boot-attempt, baseline, and `skipPromoted` fields as core state.
- Proposed API gating does not make a trusted extension’s use safe. It grants direct access to intentionally privileged behavior.
