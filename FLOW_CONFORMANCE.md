# Flow Conformance Baseline

## Scope and roles

This baseline covers the two browser-extension flow surfaces that Phase 0 tracks. They have different
purposes and must not be substituted for one another.

| Role | Canonical artifact | Document shape | Runtime use |
|---|---|---|---|
| Production client overlay | `_common/flows.yaml` plus the active `<site>/flows.yaml` | `extends: app` overlay | Stored or remote site flows are deep-merged onto the base app flow by the extension/runtime. |
| SDK playground reference | `../axsdk-sdk-js/packages/axsdk-react/apps/browser-extension/flows.yaml` | Full `version: 1` app document | Imported by `packages/axsdk-react/src/App.tsx` for the SDK playground. It is not the production site flow. |

The production overlays currently tracked by the conformance check are `_common/flows.yaml` and
`thumbtack/flows.yaml`. A new populated site flow must be added to the check in the same change that
introduces it.

The SDK shopping example retains two LLM-managed sequential-loop nodes for compatibility. Both are
marked `LEGACY PLAYGROUND LOOP`; new multi-item or multi-site work must use `flow.map` plus deterministic
normalization/reduction. The former automatic `test_form` submission route is removed rather than
presented as a production template.

## Compatibility key

All tracked documents target **flow document contract `version: 1`**. Overlay documents inherit that
version from the base app flow. The shared executable fixture ID is
`axsdk-flow-conformance-v1` (`tools/fixtures/flow-conformance-v1.json`); the SDK keeps a byte-identical
copy at `packages/axsdk-react/tests/fixtures/flow-conformance-v1.json`.

Observed package baseline:

| Component | Version or contract | Responsibility |
|---|---|---|
| Config runtime | flow document contract `v1` | Authoritative merge and full compile during session creation |
| `@axsdk/core` | `0.4.32` | Sends `flowDocument` and `clientFlows` to session creation |
| `@axsdk/react` | `0.5.32` | Loads the SDK playground reference |
| `@axsdk/extension` | `0.1.0` | Loads and merges common/site client flows |
| Local YAML parser in both repositories | `yaml@2.9.0` | Strict parse stage for the Phase 0 preflight checks |

The config-runtime implementation and deployment version are not vendored in either repository.
Therefore package semver must not be invented for it: `v1` is the compatibility key, and successful
session creation is the authoritative full-compiler gate. Local checks are deterministic preflight
checks, not a replacement for that server compile.

## Mutation contract

Every adapter declared with `effect: mutation` must also declare all of the following:

```yaml
effect: mutation
consent: required
idempotent: true
require: { confirmed_state: true }
```

`require` must be a non-empty state gate. The shared fixture contains one accepted adapter and rejected
cases for missing consent, non-idempotency, and an empty state gate. Both repositories execute those
same cases. Production `set_memory`, `delete_memory`, `shopping_add_to_cart`, and `submit_quote`, plus
SDK reference `add_to_cart` and `checkout_start`, are checked against this contract.

## Gates

Run the local production preflight from this repository:

```bash
npm run check:flows
```

Run the SDK reference preflight from its package:

```bash
cd ../axsdk-sdk-js/packages/axsdk-react
bun run check:browser-extension-flow
```

Both commands parse with `yaml@2.9.0`, apply the shared `axsdk-flow-conformance-v1` fixture, and check
their tracked artifact's role, mutation metadata, and legacy/demo boundaries.

For the authoritative production compile, inject the working-copy Lua and flows and create a real
runtime session:

```bash
node tools/ax.mjs sync <site>
# Then send one focused user turn through the extension flow engine.
```

`sync` must report stored flows enabled and remote site flows disabled. Session creation must accept the
merged `version: 1` document. A local preflight pass without that session compile is insufficient for a
release that changes runtime flow behavior.

For the SDK playground, start or exercise the browser-extension app with its configured AXSDK session;
its `flow` prop sends the full reference as `flowDocument`, so successful session creation is the same
runtime compiler gate. Build-only success does not prove server compilation.
