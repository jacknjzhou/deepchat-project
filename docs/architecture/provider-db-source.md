# Provider DB Source

## Background

The aggregated provider/model catalog used by DeepChat is a bundled snapshot at
`resources/model-db/providers.json`, generated from the upstream
`ThinkInAIXYZ/PublicProviderConf` `dist/all.json` by `scripts/fetch-provider-db.mjs`
and committed to the repository.

The runtime (`src/main/provider/providerDbLoader.ts`) treats this bundled snapshot as
the single source of truth: **no outbound network calls** related to the provider DB
happen by default. A per-user cache under `<userData>/provider-db/` only exists when
remote refresh has been explicitly enabled.

## Default: offline (bundled snapshot only)

| Stage | Action |
| --- | --- |
| `scripts/fetch-provider-db.mjs` (`prebuild`) | Skips the upstream download; fails if `resources/model-db/providers.json` is missing. |
| `ProviderDbLoader.initialize()` | Purges `<userData>/provider-db/providers.json` and `meta.json`; loads only the bundled snapshot. |
| `ProviderDbLoader.refreshIfNeeded()` | Returns `skipped` with `message: 'remote fetch disabled'` as a defensive guard. |
| `ProviderDbLoader.getDb()` (lazy path) | Skips the user-cache lookup; reads the bundled snapshot only. |

## Escape hatch: `DEEPCHAT_PROVIDER_DB_ONLINE`

Set the environment variable before launching the app (or before running
`node scripts/fetch-provider-db.mjs`) to re-enable remote refresh:

```powershell
# Windows PowerShell
$env:DEEPCHAT_PROVIDER_DB_ONLINE = "1"
pnpm run dev
```

```bash
# bash
DEEPCHAT_PROVIDER_DB_ONLINE=1 pnpm run dev
```

`1`, `true`, `yes` (case-insensitive) enable remote refresh. An unset variable or any
other value (including `0` / `false`) keeps the default offline behavior.

When enabled, the runtime restores the cache-first behavior: load from
`<userData>/provider-db/providers.json` with fallback to the bundled snapshot, a
non-blocking refresh on startup, then every `PROVIDER_DB_TTL_HOURS` hours (default 4).

The value can be flipped at any time:

- **Going online → offline**: the next `initialize()` deletes the user-level cache and
  switches to the bundled snapshot.
- **Going offline → online**: the next `initialize()` restores normal behavior and
  re-fetches from upstream.

## Updating the bundled snapshot

```powershell
$env:DEEPCHAT_PROVIDER_DB_ONLINE = "1"
node scripts/fetch-provider-db.mjs
```

Review the diff of `resources/model-db/providers.json` and commit it. The file must
pass `sanitizeAggregate` (see `src/shared/types/model-db.ts`).

## Operational notes

- The upstream URL constant (`DEFAULT_PROVIDER_DB_URL` in
  `src/main/provider/providerDbLoader.ts` and `scripts/fetch-provider-db.mjs`) is only
  used on the opt-in online path.
- The privacy-mode switch (`privacyModeProviderDb` in settings) still blocks automatic
  refreshes independently when online mode is enabled. Manual refresh stays available.
- The manual refresh button in Settings → Data returns `skipped` while remote fetch is
  disabled, which the UI surfaces as "up to date".
- The provider list in `src/main/provider/defaults.ts` is unrelated to this switch and
  still controls which providers are shown in the settings sidebar / catalog.

## Files

| File | Role |
| --- | --- |
| `scripts/fetch-provider-db.mjs` | Build-time snapshot refresh; remote fetch is opt-in via the env var. |
| `src/main/provider/providerDbLoader.ts` | Runtime loader; remote refresh is opt-in via the env var (`initialize()`, `getDb()`, `refreshIfNeeded()`). |
| `resources/model-db/providers.json` | Bundled catalog (single source of truth by default). |
| `<userData>/provider-db/providers.json` | Per-user cache; only used with remote refresh enabled, purged on default boot. |
