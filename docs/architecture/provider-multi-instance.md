# Provider Multi-Instance Configuration

## Background

DeepChat historically treated each `LLM_PROVIDER` row as a single, global
configuration. A user could enable "OpenAI" once and configure one API key.
This is limiting for users who have multiple accounts, tenants, or endpoints
for the same underlying service (e.g. a work OpenAI key and a personal OpenAI
key) and want independent model selections for each.

## Decision

Introduce a lightweight **instance** dimension on top of the existing provider
row. A provider row is still the unit of persistence, runtime, and model
selection, but rows can now be grouped into logical *families* via
`baseProviderId` and disambiguated via `instanceLabel`.

## Data model

```ts
interface LLM_PROVIDER {
  id: string                         // row primary key (nanoid for instances)
  capabilityProviderId?: string       // transport family (openai, anthropic, ...)
  baseProviderId?: string             // logical group anchor
  instanceLabel?: string              // user-facing label ("Work", "Personal")
  // ... credentials, baseUrl, models, etc.
}
```

- `capabilityProviderId` already existed and identified the transport adapter.
- `baseProviderId` is the new **group anchor**. Two rows with the same
  `baseProviderId` are considered instances of the same logical service.
- `instanceLabel` is the new **display label** shown in the sidebar to tell
  instances apart.

## Group metadata

`src/main/provider/defaults.ts` exports `PROVIDER_GROUPS`, a static array of
`ProviderGroupMeta` used only for display in the sidebar. It contains an icon,
order, and description for each known family. Unknown families fall back to a
synthetic group built from the provider's own `name` and `id`.

Groups are exposed through `providersListGroupsRoute` and consumed by the
renderer store as `providerStore.providerGroups`.

## Duplicating a provider

The primary UX for creating a new instance is **Duplicate configuration** in
the sidebar's provider dropdown menu. The flow is:

1. User selects "Duplicate configuration" on an existing provider.
2. `DuplicateProviderDialog.vue` asks for an optional `instanceLabel`.
3. `providerStore.duplicateProvider(sourceId, { instanceLabel })`:
   - Reads the source row.
   - Generates a new `id` via `nanoid()`.
   - Sets `baseProviderId` to the source's `baseProviderId` or
     `capabilityProviderId` or `id`.
   - Clears `apiKey` and `oauthToken` for security.
   - Sets `enable: false` and `custom: true`.
   - Persists via the existing `providers.add` IPC route.
4. The new row appears in the sidebar under the same group, ready for the user
   to enter a fresh API key and enable models.

## Runtime implications

- `ProviderInstanceManager` already keys instances by `providerId`, so multiple
  rows already produce multiple runtime instances without any runtime changes.
- `ModelSelection` already uses `providerId`, so session history, default model
  selections, and model status keys remain correctly scoped per instance.
- `provider_models` / `model_status` / `model_configs` already use
  `(provider_id, ...)` keys, so each instance can have its own enabled models.

## UI changes

- `ModelProviderSettings.vue` sidebar shows `instanceLabel` as a small badge.
- Each configured provider row has a new **Duplicate configuration** menu item.
- `DuplicateProviderDialog.vue` handles the instance label input and security
  warning.
- `ProviderCatalog.vue` continues to show only the curated `DEFAULT_PROVIDERS`
  list; user-created instances live in the sidebar, not the catalog.

## Files

| File | Role |
| --- | --- |
| `src/shared/types/provider.ts` | `baseProviderId`, `instanceLabel`, `ProviderGroupMeta` |
| `src/shared/contracts/domainSchemas.ts` | Zod schemas for the new fields |
| `src/shared/contracts/routes/providers.routes.ts` | `providersListGroupsRoute` |
| `src/main/provider/defaults.ts` | `PROVIDER_GROUPS` static metadata |
| `src/main/provider/providerHelper.ts` | `getDefaultProviderGroups()` |
| `src/main/provider/settings.ts` | Port + implementation |
| `src/main/provider/routes.ts` | IPC handler for groups |
| `src/renderer/api/ProviderClient.ts` | `getProviderGroups()` client |
| `src/renderer/src/stores/providerStore.ts` | `providerGroups`, `duplicateProvider()` |
| `src/renderer/settings/components/DuplicateProviderDialog.vue` | Duplicate dialog UI |
| `src/renderer/settings/components/ModelProviderSettings.vue` | Sidebar duplicate action + label badge |
| `src/renderer/src/i18n/en-US/settings.json` | English strings |
| `src/renderer/src/i18n/zh-CN/settings.json` | Chinese strings |

## Migration and compatibility

- Legacy rows have no `baseProviderId` or `instanceLabel`; they fall back to
  `capabilityProviderId ?? id` for grouping and to `name` for display.
- No SQLite schema migration is required because the new fields live in the
  existing `provider_json` column.
- IPC signatures are unchanged except for the additive
  `providers.listGroups` route.
