# Revisions, promotion, operations, and validation

## Revision model

### Pristine semantics

`pristine` is a synthetic revision:

```json
{
  "schemaVersion": 1,
  "id": "pristine",
  "baseline": "pristine",
  "createdAt": "1970-01-01T00:00:00.000Z",
  "parentId": "pristine",
  "patches": []
}
```

In normal operation, selecting pristine still applies source-controlled promoted layers. It means “no unpromoted selected revision,” not “no patch code.”

Emergency safe mode adds `skipPromoted: true`. The loader then uses an empty promoted manifest and, with pristine selected by command-line safe mode, applies no HackerCode patches.

### Content addressing

Each patch descriptor records:

| Field | Meaning |
| --- | --- |
| `name` | Stable human-readable patch name. |
| `fileName` | Revision-local `patch-0000.txt`, `patch-0001.txt`, and so on. |
| `sha256` | Lowercase SHA-256 of exact UTF-8 patch content. |
| `size` | Exact UTF-8 byte length. |

A revision ID is SHA-256 over canonical metadata plus the length-delimited exact patch contents. Canonical metadata includes schema version, baseline, description (or `null`), parent ID, and patch descriptors. `createdAt` is not identity-bearing, so submitting identical identity/content reuses the existing revision.

Before load or promotion, stored content is checked against `size` and `sha256`. Promoted content uses `<sha256>.js` and receives the same checks.

### Manifest fields

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Currently `1`. |
| `id` | `pristine` or a 64-character content hash. |
| `baseline` | Source git HEAD against which the revision was authored. |
| `createdAt` | ISO timestamp assigned on first storage. |
| `description?` | Optional operator/agent description. |
| `parentId` | Explicit parent or the active revision at creation time. |
| `patches` | Ordered descriptors. Order is application order. |

`parentId` contributes to identity and must name a usable revision when creating. The current loader does **not** recursively load parent revisions. Runtime composition is promoted layers followed by the selected revision’s own patch list. Authors who want cumulative behavior must submit the complete selected patch set.

### Ledger and revision store

The normalized ledger is persisted by the main state service under:

```text
hackercode.revisionLedger.v1
```

It contains:

- `activeRevisionId`;
- `lastKnownGoodRevisionId`;
- all known manifests;
- quarantine records with timestamp/reason;
- optional persisted `bootAttempt`;
- optional `skipPromoted`.

Patch files and non-pristine manifests are stored at:

```text
<user-data-dir>/hackercode/revisions/<revision-id>/
```

Revision creation writes a private staging directory, patch files, and `manifest.json`, then renames the directory into place. Existing identity-compatible content is reused.

### Selection, health, quarantine, and last known good

- A normal selection rejects unknown or quarantined revisions.
- Selection sets `activeRevisionId`, resets `skipPromoted` to false, persists `bootAttempt`, arms main monitoring, and reloads.
- `completeBoot` requires the active revision, stored boot attempt, and window ID to match. It clears the attempt, marks the active revision healthy, updates `lastKnownGoodRevisionId`, and removes any quarantine for that revision.
- Quarantining the active revision selects last known good. Quarantining last known good resets that field to pristine.
- Ledger normalization always restores the synthetic pristine manifest, removes invalid/duplicate quarantine entries, makes invalid last-known-good pristine, and makes invalid active selection fall back.
- Source-checkout baseline mismatch quarantines a non-pristine revision. Built products skip git baseline checks.
- A stale non-pristine `bootAttempt` found during main startup is quarantined with “previous boot did not complete”; a pristine attempt is cleared.

The control service serializes mutations through one sequencer. This avoids concurrent ledger writes inside the process; it is not a cross-process storage protocol.

### Promoted layers

The promoted manifest contains ordered layers:

| Field | Meaning |
| --- | --- |
| `id` | Original revision ID. |
| `baseline` | Git HEAD against which it was authored. |
| `promotedAt` | ISO timestamp. |
| `patches` | Original ordered descriptors with `fileName` rewritten to `<sha256>.js`. |

The loader applies every promoted layer in manifest order before the selected unpromoted revision. If the selected revision ID already appears as a promoted layer, the loader does not append the stored revision a second time.

Promotion resets active and last-known-good to pristine, clears boot state, and clears `skipPromoted`; it does not erase known revision manifests or quarantine history.

## Promotion lifecycle

Promotion is available only when:

- the process is running from a source checkout (`isBuilt === false`);
- current git `HEAD` can be resolved;
- the requested revision is active, non-pristine, and not quarantined;
- the revision’s `baseline` exactly equals current git `HEAD`;
- `windowId` identifies a regular workbench.

The main process then:

1. re-reads and verifies the revision manifest and every patch byte;
2. reads the existing source-controlled promoted bundle;
3. appends or identity-checks the promoted layer;
4. writes content-addressed `.js` patch files and replaces the promoted manifest under `src/vs/workbench/contrib/hackercode/browser/promoted/`;
5. if the `out/.../promoted/` directory exists, attempts to mirror the same bundle there;
6. runs path-limited git commands;
7. refreshes git HEAD and resets ledger selection to pristine.

The git commands are exactly equivalent to:

```bash
git -C <app-root> add -- \
  src/vs/workbench/contrib/hackercode/browser/promoted/manifest.json \
  src/vs/workbench/contrib/hackercode/browser/promoted/<sha256>.js

git -C <app-root> commit --only -m "<message>" -- <same-limited-paths>
```

Only manifest and 64-hex `.js` paths under the promoted directory pass validation. Normal git hooks are honored: the code does not pass `--no-verify`, does not amend, and does not force any ref operation.

Important limits:

- Promotion preserves JavaScript ESM patch modules as JavaScript. It cannot infer a source diff or translate runtime JavaScript into maintainable TypeScript.
- Bundle files are written before git commit. If staging, a hook, or commit fails, the source files may remain modified and the ledger is not reset. Inspect and resolve the checkout normally.
- Failure to mirror `out/` is only warned; it does not abort promotion.
- A hook that changes files is governed by normal git behavior. HackerCode does not amend a resulting commit.
- Promoted layers remain runtime patch code and retain the same trust/reversibility constraints.

## Trusted driver playbook

The repository includes `scripts/hackercode-control.mjs`, a dependency-free
reference driver that uses Node's global `WebSocket` when available and falls
back to the existing `ws` dependency. Supply the token-bearing metadata file
explicitly or through `HACKERCODE_CONTROL_FILE`:

```bash
CONTROL_FILE="<userDataDir>/hackercode/control.json"
npm run hackercode:control -- --control-file "$CONTROL_FILE" state
npm run hackercode:control -- --control-file "$CONTROL_FILE" list
printf '%s' 'return runtime.listServices();' \
	| npm run hackercode:control -- --control-file "$CONTROL_FILE" eval --stdin
```

The driver prints one machine-readable JSON object for command success or
failure, exits nonzero on RPC errors, correlates requests with timeouts, and
never prints the token or authenticated URL. `eval --source`, `eval --file`,
and `eval --stdin` always transmit source as data; the driver never evaluates
it locally or passes it through a shell.

Create requests are JSON files with the protocol's normal `createRevision`
shape. As a convenience, a patch may use `contentFile` instead of `content`;
the path is resolved relative to the request file and read verbatim:

```json
{
  "baseline": "0123456789abcdef0123456789abcdef01234567",
  "description": "Add a diagnostic command",
  "parentId": "pristine",
  "patches": [
    {
      "name": "diagnostic-command",
      "contentFile": "patches/diagnostic-command.mjs"
    }
  ]
}
```

```bash
npm run hackercode:control -- --control-file "$CONTROL_FILE" \
	create --request-file ./revision-request.json
npm run hackercode:control -- --control-file "$CONTROL_FILE" \
	select --revision <returned-id>
```

Run `npm run hackercode:control -- --help` for refresh, safe-mode, window
targeting, and promotion examples. Promotion requires `--confirm-promote` to
exactly repeat the revision ID, in addition to the normal active revision and
window checks.

### 1. Discover without disclosing

1. Determine the exact user data directory for the target instance.
2. Read `<user-data-dir>/hackercode/control.json` privately.
3. Check that `pid` names the intended live process.
4. Connect to `ws://127.0.0.1:<port>/?tkn=<URL-encoded token>`.
5. Never log the metadata object, token, or final URL.

An abnormal process exit can leave stale metadata. A new process rotates the token and atomically replaces the file. A failed connection plus a dead/mismatched PID should be treated as stale discovery, not as permission to scan arbitrary local ports.

### 2. Establish baseline and state

Call `getState`, then `listRevisions` if needed. In a source checkout:

- require `state.baseline.current` to be defined;
- use that exact value as `createRevision.baseline`;
- note `activeRevisionId`, `lastKnownGoodRevisionId`, quarantines, `bootAttempt`, and `skipPromoted`.

In a built product, baseline `current` and promotion availability are normally unavailable.

### 3. Create an immutable revision

Submit complete, side-effect-disciplined ESM patch sources with meaningful unique names. Creation only stores the revision. Save the returned ID; do not assume an ID calculated by unrelated serialization.

### 4. Activate deliberately

Call `setRevision` with the returned ID and, preferably, the target `windowId`. Activation reloads the window. Use `mode: "normal"` for ordinary operation. Reserve `"recover"` for tooling that explicitly wants fallback semantics.

### 5. Observe healthy completion

Poll `getState` after renderer reconnection. Treat the revision as healthy only when:

- `activeRevisionId` is the expected ID;
- `bootAttempt` is absent;
- `lastKnownGoodRevisionId` equals the expected ID;
- the revision is not quarantined;
- the target behavior is observed.

A successful `setRevision` response only proves that main persisted selection and initiated reload.

The current refresh service is delayed-instantiated. If its revision preparation has not registered by the time `AfterRestored` calls `whenRevisionReady`, that method resolves immediately. Therefore even cleared `bootAttempt`/updated last-known-good state is not sufficient on its own; direct behavior observation and renderer logs are part of validation.

### 6. Evaluate and refresh

Use `eval` for bounded diagnostics and `refresh` according to the tier:

- soft for patch-factory re-evaluation;
- module for a namespace previously tracked through `ctx.import`;
- hard for a monitored window reload.

Avoid eval expressions that mutate state during observation. Eval has full privilege.

### 7. Promote only after validation

Re-read state and baseline immediately before `promote`. Confirm the worktree and intended commit message. Promotion creates a real git commit and is therefore a deliberate final step, not a refresh operation.

### 8. Recover

If behavior fails but the endpoint responds, call `safeMode`. If the renderer or endpoint is unavailable, restart with `--hackercode-safe-mode`. In a development bootstrap before workbench import, use the recovery chord when available.

## Safety checklist

- [ ] Target user data directory and PID were verified.
- [ ] Token and authenticated URL will not be logged.
- [ ] Source baseline equals current git HEAD.
- [ ] Patch ESM has no top-level side effects.
- [ ] Every mutation/disposable is context-owned.
- [ ] Patch names are unique and patch set is complete.
- [ ] Dynamic `this` is preserved for patched methods.
- [ ] Protected imports and direct control-plane mutation are avoided.
- [ ] `setRevision` targets the intended regular workbench window.
- [ ] Healthy state was observed after reload.
- [ ] Soft and hard recovery were tested before promotion.
- [ ] Promotion paths and resulting commit were reviewed.

## Development and validation

### Dependencies and build

From the repository root:

```bash
npm install
npm run compile
```

Run `npm install` only when `node_modules/` is missing or stale. Do not share/symlink dependencies from another worktree. `npm run compile` builds the client and Copilot extension; a full runnable workbench also needs built-in extension output. For repeated work, `npm run watch` performs the full incremental watch set.

For a fast one-shot refresh of client output used by unit tests:

```bash
npm run transpile-client
```

That does not build all built-in extensions and is not sufficient by itself for launching a complete app.

### Targeted HackerCode tests

After output is current:

```bash
./scripts/test.sh --run src/vs/platform/hackercode/test/common/hackerCode.test.ts
./scripts/test.sh --run src/vs/platform/hackercode/test/common/hackerCodeControlProtocol.test.ts
./scripts/test.sh --run src/vs/platform/hackercode/test/browser/hackerCodeRuntime.test.ts
./scripts/test.sh --run src/vs/platform/hackercode/test/browser/hackerCodeControlSerializer.test.ts
./scripts/test.sh --run src/vs/platform/hackercode/test/node/hackerCodePromotion.test.ts
./scripts/test.sh --run src/vs/workbench/contrib/hackercode/test/browser/hackerCodePatchRegistry.test.ts
./scripts/test.sh --run src/vs/workbench/contrib/hackercode/test/browser/hackerCodeRevisionLoader.test.ts
./scripts/test.sh --run src/vs/workbench/api/test/browser/mainThreadHackerCode.test.ts
npm run test-hackercode:control
```

Relevant compile checks:

```bash
npm run typecheck-client
npm run vscode-dts-compile-check
```

Do not run `typecheck-client` immediately before a full compile solely as duplication; choose validation proportional to the change.

### Launch with the existing skill

On macOS/Linux, the repository launcher is:

```bash
LAUNCH="$PWD/.agents/skills/launch/scripts/launch.sh"
INFO=$("$LAUNCH" --repo "$PWD" -- --hackercode-control | tail -n1)
```

The final `--` forwards `--hackercode-control` to `scripts/code.sh`. Source development builds already enable HackerCode control by default, so the explicit flag mainly makes intent visible. The launcher creates an isolated throwaway user-data directory and returns it in the JSON as `userDataDir`; discover this instance at:

```text
<userDataDir>/hackercode/control.json
```

The launcher requires its documented source profile, build, Node, and platform tools. Read [the launch skill](../../.agents/skills/launch/SKILL.md) for Windows invocation, profile isolation, debug ports, and prerequisites.

To exercise command-line recovery with the same launcher:

```bash
INFO=$("$LAUNCH" --repo "$PWD" -- --hackercode-safe-mode --hackercode-control | tail -n1)
```

Do not run the Agents-window variant to test patch application. Session/Agents windows are intentionally excluded.

### Destructive watchdog recovery test

`scripts/test-hackercode-recovery-e2e.mjs` is an explicitly opt-in integration
harness. It waits for a completed initial workbench boot, creates and activates
a revision whose factory deliberately wedges the renderer, and verifies that
the main-process watchdog quarantines the revision and restores last known good
state with `skipPromoted`. It always makes a final out-of-renderer `safeMode`
request for cleanup.

The harness refuses to run unless all of these checks pass:

- `HACKERCODE_RUN_DESTRUCTIVE_RECOVERY_TEST=1` is set;
- `--control-file` is supplied explicitly;
- the control file is under the launch skill's isolated
  `hackercode-dev/.../user-data` profile;
- the endpoint PID is live;
- the source build was launched with the development-only
  `--hackercode-destructive-recovery-test` flag.

That flag only takes effect in source/development builds. It suppresses the
native frozen-renderer dialog so the unchanged 20-second production watchdog
can perform the automatic revert; built products ignore it. Production
watchdog and dialog defaults are otherwise unchanged.

```bash
LAUNCH="$PWD/.agents/skills/launch/scripts/launch.sh"
INFO=$("$LAUNCH" --repo "$PWD" -- \
	--hackercode-control --hackercode-destructive-recovery-test | tail -n1)
CONTROL_FILE="$(jq -r .userDataDir <<<"$INFO")/hackercode/control.json"

HACKERCODE_RUN_DESTRUCTIVE_RECOVERY_TEST=1 \
	npm run test-hackercode:recovery-e2e -- --control-file "$CONTROL_FILE"
```

Never include this harness in the ordinary unit suite. It intentionally freezes
and reloads a renderer and has bounded operation, request, and cleanup
timeouts.

## Recovery commands and keys

| Situation | Action | Result |
| --- | --- | --- |
| Workbench UI is healthy | Run **HackerCode: Select Revision...** or select the status item. | Select a usable revision or normal pristine. Normal pristine includes promoted layers. |
| Development renderer is failing before workbench import | Windows/Linux: Ctrl+Shift+Alt+R. macOS: Cmd+Shift+Alt+R. | When developer bootstrap keybindings are active, main enters safe mode and reloads that window. |
| Renderer is broken but control endpoint is reachable | JSON-RPC `safeMode` with an optional `windowId`. | Main quarantines/falls back, sets `skipPromoted`, and reloads. |
| Previous boot never completed | Relaunch normally. | Main detects persisted stale `bootAttempt`, quarantines its non-pristine revision, and falls back. |
| Strongest no-patch startup | Start `scripts/code.sh --hackercode-safe-mode` (plus the same profile/workspace arguments as usual). | Main forces pristine and `skipPromoted` before renderer patch loading. |
| Need the endpoint in a built product | Add `--hackercode-control`. | Enables the loopback server, renderer runtime/channel, and proposed API control mode. |

`--hackercode-safe-mode` and `--hackercode-control` are independent. Safe mode changes revision state even if the external control endpoint remains disabled.

## Troubleshooting

### `control.json` is missing

- Confirm the exact target user data directory.
- Development enables control by default; built products require `--hackercode-control`.
- Check main-process logs for “Failed to start the control endpoint.”
- Do not infer a port or token.

### WebSocket receives 403

The `tkn` query value is absent, duplicated, stale, malformed, or incorrect. Re-read metadata privately and verify PID. Do not print the candidate token while debugging.

### `Renderer unavailable`

- No regular workbench is focused and no `windowId` was supplied.
- The requested window ID is stale or names a sessions/Agents window.
- The renderer has not registered yet or is reconnecting.
- A token holder replaced the renderer registration.

Wait for the intended regular workbench registration or use main-owned recovery instead of repeatedly evaluating.

### Revision is quarantined or baseline-invalid

Do not force normal activation. Inspect `quarantinedRevisions`, compare `baseline.current` with the manifest baseline, and create a new revision for the current HEAD. Recover mode intentionally falls back rather than bypassing quarantine.

### Soft refresh duplicates behavior

The patch likely performed a top-level or direct side effect outside the context. Enter safe mode or hard reload, then rewrite the patch so registrations and mutations are context-owned.

### Module refresh is untracked, unhandled, or rejected

- The specifier must first be imported with `ctx.import`.
- It must pass guarded syntax and protected-prefix checks.
- The hot-reload helper must support its exports in `patch-prototype` mode.

Use soft refresh for patch factories or hard refresh when module hot reload cannot preserve semantics.

### Boot recovery dialog appears

Main observed three five-second liveness misses. **Revert and Reload** enters safe mode. **Wait** resets heartbeat/watchdog timers and gives the same revision another interval. If the window vanished or the dialog itself fails, main enters safe mode automatically.

### Promotion commit fails

Inspect git status. Promoted source files may already be modified because bundle writing precedes the commit. Resolve hook or repository issues normally, and do not amend an unrelated commit. HackerCode itself does not retry, amend, bypass hooks, or roll back the source bundle.

### Pristine still changes behavior

Normal pristine includes promoted layers. Use `--hackercode-safe-mode` or the main-owned `safeMode` operation to set `skipPromoted`. Selecting pristine from the picker resets `skipPromoted` to false.
