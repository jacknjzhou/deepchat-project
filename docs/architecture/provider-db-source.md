# Provider DB Source

## Background

The aggregated provider/model catalog used by DeepChat comes from two places:

1. A bundled snapshot at `resources/model-db/providers.json`, refreshed at build time by
   `scripts/fetch-provider-db.mjs` from the upstream
   `ThinkInAIXYZ/PublicProviderConf` `dist/all.json`.
2. A per-user cache under `<userData>/provider-db/providers.json` (with a `meta.json`
   sibling) that the runtime can refresh in the background every `PROVIDER_DB_TTL_HOURS`
   hours (default 4).

`ProviderDbLoader.initialize()` (`src/main/provider/providerDbLoader.ts`) loads the cache
first, falls back to the bundled snapshot, then schedules a non-blocking refresh. This
works for the public distribution but is a problem for private/internal builds that want
to ship a fixed catalog and never contact GitHub.

## Goal

Make it possible to run DeepChat with **no outbound network calls** related to the
provider DB, with the bundled `resources/model-db/providers.json` as the single source
of truth.

## Switch

Set the environment variable before launching the app or running `pnpm run build`:

```powershell
# Windows PowerShell
$env:DEEPCHAT_PROVIDER_DB_OFFLINE = "1"
pnpm run dev
```

```bash
# bash
DEEPCHAT_PROVIDER_DB_OFFLINE=1 pnpm run dev
```

`1`, `true`, `yes` (case-insensitive) all activate offline mode. Any other value, an
unset variable, or a value like `0` / `false` falls back to the default online
behavior.

## Behavior

When `DEEPCHAT_PROVIDER_DB_OFFLINE=1`:

| Stage | Action |
| --- | --- |
| `scripts/fetch-provider-db.mjs` (`prebuild`) | Skips the upstream download; refuses to run if `resources/model-db/providers.json` is missing. |
| `ProviderDbLoader.initialize()` | Purges `<userData>/provider-db/providers.json` and `meta.json`; loads only `resources/model-db/providers.json`; never schedules the background refresh. |
| `ProviderDbLoader.refreshIfNeeded()` | Returns `skipped` with `message: 'offline mode'` as a defensive guard. |
| `ProviderDbLoader.getDb()` (lazy path) | Skips the user-cache lookup; reads built-in only. |

The `DEEPCHAT_PROVIDER_DB_OFFLINE=1` value can be flipped at any time:

- **Going online → offline**: the next `initialize()` deletes the cached snapshot and
  switches to the bundled file. The cached snapshot is no longer touched.
- **Going offline → online**: the next `initialize()` restores normal behavior and
  re-fetches from upstream after the next TTL window.

## Operational notes

- The bundled snapshot is still the only data baked into the binary. Replace
  `resources/model-db/providers.json` with your own catalog before building; the file
  must pass `sanitizeAggregate` (see `src/shared/types/model-db.ts`).
- The upstream URL constant (`DEFAULT_PROVIDER_DB_URL` in
  `src/main/provider/providerDbLoader.ts`) is intentionally kept so the online path
  remains unchanged when the variable is unset.
- The privacy-mode switch (`privacyModeProviderDb` in settings) still works
  independently; offline mode is an additional hard stop.
- The provider list in `src/main/provider/defaults.ts` is unrelated to this switch and
  still controls which providers are shown in the settings sidebar / catalog.

## Files

| File | Role |
| --- | --- |
| `scripts/fetch-provider-db.mjs` | Build-time upstream fetch; honors the env var. |
| `src/main/provider/providerDbLoader.ts` | Runtime loader; honors the env var in `initialize()`, `getDb()`, and `refreshIfNeeded()`. |
| `resources/model-db/providers.json` | Bundled catalog (source of truth in offline mode). |
| `<userData>/provider-db/providers.json` | Per-user cache; purged on first offline boot. |
