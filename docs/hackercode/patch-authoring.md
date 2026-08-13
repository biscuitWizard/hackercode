# Patch authoring and refresh

## Patch module contract

Revision patch content is JavaScript ESM source, not a unified diff, source-file replacement, TypeScript fragment, or CommonJS module. HackerCode imports each source through a Blob URL and requires its module namespace to contain a callable default export.

Use this shape:

```js
export default async function (ctx) {
	// Perform reversible work through ctx.
}
```

The default factory may be synchronous or async. HackerCode awaits it.

**All top-level side effects are forbidden by the patch contract.** Top-level declarations and pure initialization are fine, but do not register listeners, mutate globals, start timers, call services, or alter imported objects before the factory runs. ESM evaluation occurs before the patch registry creates a context; a top-level side effect therefore has no undo record. It may also repeat on soft refresh.

The runtime cannot fully enforce this contract. Patch review remains a trust boundary.

## Complete example

This example exercises every current context method. It uses `Reflect.apply` because a generic wrapper cannot otherwise call an unknown original function while preserving the caller’s dynamic `this`. It does not use `.apply`, `.call`, or `.bind`.

```js
const STATUSBAR_RIGHT = 1; // StatusbarAlignment.RIGHT

const formatter = {
	prefix: 'HackerCode',
	format(value) {
		return `${this.prefix}: ${value}`;
	}
};

export default async function (ctx) {
	const lifecycle = await ctx.import('vs/base/common/lifecycle.js');
	const logService = ctx.getService('logService');

	ctx.defineProperty(formatter, 'revision', {
		value: 'example',
		configurable: true,
		enumerable: true,
		writable: true
	});

	ctx.patchMethod(formatter, 'format', original => function format(value) {
		const originalResult = Reflect.apply(original, this, [value]);
		return `[runtime patch] ${originalResult}`;
	});

	let active = true;
	ctx.track(lifecycle.toDisposable(() => {
		active = false;
	}));

	const commandId = 'hackercode.example.showState';
	ctx.registerCommand(commandId, () => ({
		active,
		message: formatter.format(formatter.revision),
		logServiceType: logService.constructor.name
	}));

	ctx.addStatusBarEntry({
		name: 'HackerCode Example',
		text: '$(beaker) HackerCode example',
		tooltip: 'Run the reversible HackerCode example command',
		command: commandId
	}, 'status.hackercode.example', STATUSBAR_RIGHT, 100);
}
```

Notes:

- `formatter` is module-local. Creating it at top level is pure; mutating it happens only through `ctx`.
- A newly added property must explicitly be `configurable: true`, or `defineProperty` rejects it because rollback could not remove it.
- `registerCommand` and `addStatusBarEntry` already track their returned disposables.
- The explicit `track` example demonstrates ownership of any other `IDisposable`.
- `getService('logService')` resolves the DI identifier named `logService`. Use `globalThis.$hackercode.listServices()` or eval `return runtime.listServices()` to discover loaded identifiers.
- Numeric `1` is the current runtime value of `StatusbarAlignment.RIGHT`; `StatusbarAlignment` is a TypeScript `const enum`, so it is not a runtime export that a JavaScript patch can import.

## Context reference

### `ctx.defineProperty(target, key, descriptor)`

Defines or changes an own property and records its original descriptor.

Reversibility constraints:

- a new property must be configurable;
- a configurable existing property cannot be made non-configurable;
- fixed enumerable/configurable attributes cannot be changed;
- a fixed data property cannot become an accessor;
- a fixed writable property cannot become read-only;
- a fixed accessor cannot become a data property.

Rollback restores the old descriptor or deletes a newly created property with `Reflect.deleteProperty`.

### `ctx.patchMethod(target, key, wrap)`

Patches an **own callable data property**. Inherited methods are rejected; select the prototype object that owns a method when patching a class prototype.

`wrap(original)` must return a function. Use normal `function`/method semantics when the original relies on dynamic `this`:

```js
ctx.patchMethod(SomeType.prototype, 'render', original => function render(options) {
	const result = Reflect.apply(original, this, [options]);
	return decorate(result);
});
```

An arrow returned from `wrap` captures lexical `this` and is therefore wrong for most prototype methods. `Reflect.apply` is technically necessary for a generic original with dynamic receiver and arguments; avoid `.apply`, `.call`, and `.bind` merely for convenience.

The original descriptor is restored on revert.

### `ctx.track(disposable)`

Adds an `IDisposable` to the patch’s ownership and returns the same value. Track resources immediately after creation. Revert disposes tracked resources in reverse undo order; duplicate tracking of the same object is ignored.

Do not interpret `track` as permission to perform an arbitrary direct side effect first. Prefer APIs that return a disposable at the point of registration, and track that result immediately. If an API has no reversible handle, it is usually unsuitable for a runtime patch.

### `ctx.registerCommand(id, handler)`

Registers through `CommandsRegistry.registerCommand`, tracks the registration, and returns its disposable. Command IDs must be unique while the patch is active.

### `ctx.addStatusBarEntry(entry, id, alignment, priority?)`

Adds through `IStatusbarService.addEntry`, tracks the accessor, and returns it. JavaScript patches can pass `0` for left or `1` for right because the source enum is compile-time-only.

### `ctx.getService(name)`

Resolves a loaded DI service identifier from `_util.serviceIds`. The name is the decorator identifier, not necessarily an interface or class name. Empty and unknown names fail. Values must resolve to an object or function.

Services whose identifier contains `hackercode` are branded as protected before being returned. The control service and installed runtime are also protected. `defineProperty` and `patchMethod` reject protected targets, but this is a narrow object guard, not transitive isolation.

### `ctx.import(specifier)`

Imports a guarded renderer ESM namespace and tracks it as eligible for module refresh. Repeated imports of the same canonical specifier return the cached namespace.

Valid specifiers:

- start with `vs/`;
- end with `.js`;
- use slash-separated segments containing only letters, digits, `_`, `$`, `.`, or `-`;
- contain no `/./` or `/../`;
- contain no query string or fragment.

Examples:

```text
vs/base/common/lifecycle.js
vs/platform/log/common/log.js
vs/workbench/services/statusbar/browser/statusbar.js
```

The following case-insensitive prefixes are protected:

```text
vs/platform/hackercode/
vs/workbench/contrib/hackercode/
```

The specifier guard is **not** a sandbox. An allowed module or service can still expose significant authority.

## Transaction and convergence behavior

Patches form one ordered target set. Identity is:

```text
<revision id>:<stored file name>:<patch name>:<patch sha256>
```

The SHA-256 is also used as the patch `key`. If every current patch has the same `id`, `name`, and `key` at the same index, `applySet` is a no-op.

For a different set, the registry:

1. reverts the current set in reverse order;
2. applies target patches in order;
3. if one factory fails, reverts that patch’s context immediately;
4. reverts already-applied target patches;
5. re-applies the previous patch set in order;
6. reports an aggregate error, including rollback or restoration failures.

“Transactional” here means best-effort compensation through tracked context operations. It is not a database transaction and cannot undo untracked JavaScript effects.

## Refresh tiers

| Tier | Entry point | Exact behavior | Limits |
| --- | --- | --- | --- |
| Soft | `refresh('soft')`, `runtime.soft()`, or `vscode.hackerCode.refresh('soft')` | Waits for loader initialization, reverts all applied patches, reloads promoted layers unless `skipPromoted`, re-reads the active revision, evaluates fresh Blob ESM modules, and applies the resulting set. It does not reload the window. | Only patch-registry effects are deliberately reverted. Top-level ESM effects and direct side effects can duplicate or persist. |
| Module | `refresh('module', specifier)` or `runtime.module(specifier)` | Requires a specifier previously loaded through `ctx.import`. Imports a cache-busted namespace, asks the hot-reload helper for `patch-prototype` handling, and applies mutable new exports to the old namespace’s eligible prototype exports. | Untracked modules fail. Modules not handled by the hot-reload helper fail; rejected new exports fail. This does not re-run revision patch factories. |
| Hard | `refresh('hard')`, `runtime.hard()`, or `vscode.hackerCode.refresh('hard')` | Waits for loader initialization, asks main to `reloadRevision` for the active revision and current window, persists a new boot attempt, arms main monitoring, and reloads the renderer. | Only the active revision can be hard-reloaded. Source-checkout baseline mismatch causes an error after a reload request is issued by the mismatch path. |

## Authoring checklist

- Export exactly one callable default patch factory.
- Keep top level side-effect-free.
- Put every reversible mutation behind a context method.
- Track every disposable immediately.
- Patch the object that owns a method, not an instance inheriting it.
- Preserve dynamic `this` and argument/return behavior.
- Use `ctx.import`, never direct static imports in submitted patch text.
- Avoid importing or resolving HackerCode control internals.
- Expect the factory to run again after soft refresh or failed-set restoration.
- Test revert, reapply, a deliberately thrown factory error, soft refresh, and hard reload.
- Do not promote until boot health has completed and behavior has been observed.
