# Provider Catalog Data Source

## Background

The "Browse all providers" page in `ProviderCatalog.vue` is the curated catalog
shown to users when no provider has been configured yet (or when they explicitly
navigate to it via `route.query.view === 'catalog'`).

Earlier the catalog read `providerStore.sortedProviders`, which is sourced from
`providersListSummariesRoute` → `ProviderSettings.getProviders()`. That list is
the **persisted** provider list, seeded from `DEFAULT_PROVIDERS` on first boot
but augmented by every `AddProviderFlow` invocation. As a result, user-added
custom providers leaked into the "browse all" catalog, which mixed the official
white-list with private additions and made the page no longer represent the
out-of-the-box catalog.

## Decision

The catalog data source is now `providerStore.sortedDefaultProviders`, sourced
from `providersListDefaultsRoute` → `ProviderSettings.getDefaultProviders()` →
`ProviderHelper.defaultProviders` (the static `DEFAULT_PROVIDERS` exported from
`src/main/provider/defaults.ts`).

User-added custom providers remain reachable via the sidebar
(`providerStore.configuredProviders`) but never appear in the catalog view.

## Data flow

```text
src/main/provider/defaults.ts  →  DEFAULT_PROVIDERS  (static)
                          ↓
ProviderHelper.defaultProviders  →  ProviderSettings.getDefaultProviders()
                          ↓
providersListDefaultsRoute (IPC)
                          ↓
ProviderClient.getDefaultProviders()
                          ↓
providerStore.defaultProvidersQuery → defaultProviders (computed)
                          ↓
sortProviders(defaultProviders, true)
                          ↓
sortedDefaultProviders (computed, exported)
                          ↓
ProviderCatalog.vue + ModelProviderSettings.vue catalogProviders (count badge)
```

## Why a separate getter instead of reusing `sortedProviders`

- `sortedProviders` reflects the persisted state (includes user-added custom
  providers and any user-defined ordering tweaks). Using it for "browse all"
  would silently re-include the leakage problem.
- `sortedDefaultProviders` applies the **same** `sortProviders` algorithm but
  operates on the bundled `DEFAULT_PROVIDERS` snapshot only, so custom providers
  are excluded by construction rather than by post-hoc filtering.
- The two getters can evolve independently as the sidebar and catalog diverge.

## What's preserved

- The `'acp'` filter is kept — ACP runtime is a different concept and never
  belongs in the static catalog.
- The `isProviderConfigured` "configured" badge still works: a default provider
  that the user has actually configured still shows its badge in the catalog.
- The onboarding fallback `guideCandidateProviders` now resolves to the
  `DEFAULT_PROVIDERS` snapshot when the sidebar is empty, which is the intended
  pre-onboarding experience.
- "Browse all providers" i18n key is unchanged; the page label still applies
  to a curated list rather than the universal set.

## Files

| File | Role |
| --- | --- |
| `src/main/provider/defaults.ts` | `DEFAULT_PROVIDERS` single source of truth |
| `src/main/provider/providerHelper.ts` | `defaultProviders` getter |
| `src/main/provider/settings.ts` | `getDefaultProviders()` public API |
| `src/main/provider/routes.ts` | `providersListDefaultsRoute` IPC |
| `src/renderer/api/ProviderClient.ts` | `getDefaultProviders()` client |
| `src/renderer/src/stores/providerStore.ts` | `defaultProviders`, `sortedDefaultProviders` |
| `src/renderer/settings/components/ProviderCatalog.vue` | catalog view |
| `src/renderer/settings/components/ModelProviderSettings.vue` | count badge + guided onboarding fallback |