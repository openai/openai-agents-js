# Public API, Package, and Runtime Boundaries

Use this reference for package export maps, convenience-package re-exports, ESM/CJS/type declarations, optional dependencies, import side effects, and Node/browser/workerd runtime shims.

## Package Ownership

- `@openai/agents-core` owns provider-neutral runtime APIs. `@openai/agents-openai` owns OpenAI-specific models, sessions, tools, and tracing export. `@openai/agents-realtime` owns Realtime sessions and transports. `@openai/agents-extensions` owns optional integrations. `@openai/agents` is a convenience bundle, not a second implementation.
- Add a public symbol to its owning package first. Re-export it from `@openai/agents` or a subpath only when that route is intentionally supported, then cover both the owning and convenience imports.
- Treat package `exports`, root/subpath `src/index.ts` files, and emitted declarations as one compatibility surface. A source export that is missing from `package.json` or `dist` is not a working public API.
- Keep optional integrations behind `@openai/agents-extensions` subpaths. Importing a package root must not eagerly require unrelated optional provider SDKs.

## Import-Time Behavior

- Importing `@openai/agents` intentionally installs the default OpenAI model provider and tracing exporter. Provider-neutral consumers should import `@openai/agents-core` to avoid those defaults.
- Keep package roots free of browser-incompatible imports unless their export conditions route to a compatible shim. A type-only public surface must not cause a runtime import of a Node-only dependency.
- Validate current source through `src` imports and packaged behavior through a completed build and `dist` imports. Do not use a stale `dist` probe to decide what the current branch source does.

## Runtime Conditions and Shims

- Core and Realtime expose `_shims` conditionally for Node, browser, and workerd. Preserve the same interface across implementations even when context storage, event emitters, crypto, fetch, or MCP transports differ.
- Browser event-emitter removal must remove the intended listener without collapsing duplicate registrations unexpectedly. Context-storage shims must keep trace context active across awaited and streamed work even when true `AsyncLocalStorage` is unavailable.
- Keep workerd/browser package conditions aligned with bundler resolution. Test the condition that users actually import; a Node-only test does not validate a browser export.

## Review Checklist

1. Identify the owning package and every intended re-export path.
2. Check `package.json` export conditions, emitted declarations, and optional dependency loading.
3. Test the relevant Node, browser, or workerd condition and both ESM and CJS when the export map changes.
4. Confirm package-root imports do not add unintended initialization or optional-provider requirements.
5. Compare removed or moved exports with the latest release tag and add a compatibility path when a released import is affected.

## Sources

- `packages/agents-core/package.json`
- `packages/agents-openai/package.json`
- `packages/agents-realtime/package.json`
- `packages/agents-extensions/package.json`
- `packages/agents/package.json`
- `packages/agents-core/src/index.ts`
- `packages/agents-realtime/src/index.ts`
- `packages/agents/src/index.ts`
- `packages/agents-core/src/shims/`
- `packages/agents-realtime/src/shims/`
- `packages/agents-core/test/index.test.ts`
- `packages/agents/test/index.test.ts`
- `integration-tests/`
