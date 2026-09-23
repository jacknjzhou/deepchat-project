import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ToolchainKind } from '@shared/types/toolchains'
import runtimeVersions from '../../../resources/runtime-versions.json'
import {
  DocumentTextExtractionService,
  type DocumentTextExtractionInput,
  type DocumentTextExtractionResult
} from './documentTextExtractionService'
import {
  ImageTextExtractionService,
  type ImageTextExtractionBatchItem,
  type ImageTextExtractionInput,
  type ImageTextExtractionResult
} from './imageTextExtractionService'
import { LightOcrProcessHost, type LightOcrProcessHostStatus } from './lightOcrProcessHost'
import { OcrArtifactStore, type OcrArtifactStoreStats } from './ocrArtifactStore'
import { SafeStorageOcrCacheKeyProvider } from './ocrCacheKeyProvider'
import { OcrExtractionScheduler } from './ocrExtractionScheduler'
import { OcrRuntimeAssetResolver, type OcrRuntimeAvailability } from './ocrRuntimeAssetResolver'
import { OcrSourceSnapshotBudget } from './ocrSourceSnapshotBudget'

export interface OcrRuntimeServiceOptions {
  appPath: string
  isPackaged: boolean
  nodeRuntimePath: string | null
  resolveNode?: () => { executable: string; version: string }
  tempBaseDir: string
  userDataDir: string
  platform?: NodeJS.Platform
  arch?: string
  onDiagnostic?: (event: { code: 'cache_read_failed' | 'cache_write_failed' }) => void
}

export interface OcrRuntimeServiceStatus {
  availability: OcrRuntimeAvailability
  process: LightOcrProcessHostStatus | null
  cache: OcrArtifactStoreStats | null
}

interface RuntimeResources {
  host: LightOcrProcessHost
  store: OcrArtifactStore
  scheduler: OcrExtractionScheduler
  extraction: ImageTextExtractionService
  documentExtraction: DocumentTextExtractionService
}

export class OcrRuntimeBusyError extends Error {
  constructor() {
    super('OCR cache cannot be cleared while extraction is active')
    this.name = 'OcrRuntimeBusyError'
  }
}

const HELPER_BUNDLE_COPY_NAME = 'bundle-copy'
const HELPER_BUNDLE_ID_MARKER = '.bundle-id'

/**
 * The native OCR helper (std::filesystem) cannot open files under paths
 * longer than MAX_PATH. Deep bundle-internal paths (e.g. CoreML weights
 * inside the model bundle under a pnpm store) exceed MAX_PATH on Windows
 * even when the bundle directory itself does not. Path aliases do not help
 * because the helper canonicalizes paths back to the long original, so the
 * bundle is copied to a short, stable location instead. The copy is cached
 * per bundleId and refreshed when the marker mismatches.
 * No-op on non-Windows platforms.
 */
export async function resolveHelperAccessibleBundlePath(
  bundlePath: string,
  anchorDir: string,
  bundleId: string
): Promise<string> {
  if (process.platform !== 'win32') {
    return bundlePath
  }
  const copyPath = path.join(anchorDir, HELPER_BUNDLE_COPY_NAME)
  const markerPath = path.join(copyPath, HELPER_BUNDLE_ID_MARKER)
  let valid = false
  try {
    valid = (await readFile(markerPath, 'utf8')).trim() === bundleId
  } catch {
    valid = false
  }
  if (!valid) {
    await rm(copyPath, { force: true, recursive: true })
    await cp(bundlePath, copyPath, { recursive: true })
    await writeFile(markerPath, bundleId, 'utf8')
  }
  return copyPath
}

/** Lazily owns the offline OCR helper, engine, and derived cache for the application lifetime. */
export class OcrRuntimeService {
  private readonly resolver: OcrRuntimeAssetResolver
  private availabilityPromise: Promise<OcrRuntimeAvailability> | null = null
  private resourcesPromise: Promise<RuntimeResources> | null = null
  private closingResources: Promise<void> = Promise.resolve()
  private closed = false
  private resourcesStale = false

  constructor(private readonly options: OcrRuntimeServiceOptions) {
    this.resolver = new OcrRuntimeAssetResolver({
      appPath: options.appPath,
      isPackaged: options.isPackaged,
      nodeRuntimePath: options.nodeRuntimePath,
      resolveNode: options.resolveNode,
      platform: options.platform,
      arch: options.arch
    })
  }

  refreshAvailability(kind?: ToolchainKind): void {
    this.availabilityPromise = null
    if (kind === 'uv') return
    const existing = this.resourcesPromise
    if (!existing) return
    this.closingResources = this.closingResources
      .then(async () => {
        const resources = await existing.catch(() => null)
        if (!resources) {
          if (this.resourcesPromise === existing) this.resourcesPromise = null
          return
        }
        if (this.isResourcesBusy(resources)) {
          this.resourcesStale = true
          return
        }
        if (this.resourcesPromise === existing) this.resourcesPromise = null
        this.resourcesStale = false
        await this.disposeResources(resources)
      })
      .catch(() => {})
  }

  async getAvailability(): Promise<OcrRuntimeAvailability> {
    if (this.closed) {
      return {
        status: 'unavailable',
        reason: 'service_closed',
        lightOcrVersion: runtimeVersions.lightOcr.facadeVersion,
        bundleId: runtimeVersions.lightOcr.bundleId
      }
    }
    if (this.availabilityPromise) {
      const current = await this.availabilityPromise
      if (current.status === 'available') return current
      this.availabilityPromise = null
    }
    this.availabilityPromise = this.resolver.resolve()
    return await this.availabilityPromise
  }

  async extract(input: ImageTextExtractionInput): Promise<ImageTextExtractionResult> {
    return await (await this.getResources()).extraction.extract(input)
  }

  async extractBatch(inputs: ImageTextExtractionInput[]): Promise<ImageTextExtractionBatchItem[]> {
    return await (await this.getResources()).extraction.extractBatch(inputs)
  }

  async extractDocument(input: DocumentTextExtractionInput): Promise<DocumentTextExtractionResult> {
    return await (await this.getResources()).documentExtraction.extractDocument(input)
  }

  async getStatus(): Promise<OcrRuntimeServiceStatus> {
    const availability = await this.getAvailability()
    const resources = await this.resourcesPromise?.catch(() => null)
    return {
      availability,
      process: resources?.host.getStatus() ?? null,
      cache: resources ? await resources.store.getStats().catch(() => null) : null
    }
  }

  async clearCache(): Promise<void> {
    const resources = await this.getResources()
    if (this.isResourcesBusy(resources)) {
      throw new OcrRuntimeBusyError()
    }
    await resources.store.clear()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.availabilityPromise = null
    const existing = this.resourcesPromise
    this.resourcesPromise = null
    await this.closingResources
    const resources = existing ? await existing.catch(() => null) : null
    if (!resources) return
    await this.disposeResources(resources)
  }

  private async getResources(): Promise<RuntimeResources> {
    if (this.closed) throw new Error('OCR runtime service is closed')
    await this.closingResources
    if (this.closed) throw new Error('OCR runtime service is closed')
    if (this.resourcesStale && this.resourcesPromise) {
      const resources = await this.resourcesPromise.catch(() => null)
      if (resources && !this.isResourcesBusy(resources)) {
        this.resourcesPromise = null
        this.resourcesStale = false
        this.closingResources = this.closingResources
          .then(() => this.disposeResources(resources))
          .catch(() => {})
        await this.closingResources
      }
    }
    this.resourcesPromise ??= this.createResources()
    try {
      return await this.resourcesPromise
    } catch (error) {
      this.resourcesPromise = null
      throw error
    }
  }

  private async createResources(): Promise<RuntimeResources> {
    const availability = await this.getAvailability()
    if (availability.status === 'unavailable') {
      throw new Error(`OCR runtime unavailable: ${availability.reason}`)
    }
    if (this.closed) throw new Error('OCR runtime service is closed')

    const cacheDir = path.join(this.options.userDataDir, 'ocr')
    await mkdir(cacheDir, { recursive: true, mode: 0o700 })
    let host: LightOcrProcessHost | null = null
    let store: OcrArtifactStore | null = null
    let extraction: ImageTextExtractionService | null = null
    let documentExtraction: DocumentTextExtractionService | null = null
    let scheduler: OcrExtractionScheduler | null = null
    try {
      host = new LightOcrProcessHost({
        nodeExecutable: availability.assets.nodeExecutable,
        helperEntryPath: availability.assets.helperEntryPath,
        bundlePath: await resolveHelperAccessibleBundlePath(
          availability.assets.bundlePath,
          cacheDir,
          availability.assets.bundleId
        ),
        expectedBundleId: availability.assets.bundleId,
        expectedNodeVersion: availability.assets.nodeVersion,
        nativePackageDir: availability.assets.nativePackageDir,
        nativePayloadEncoding: availability.assets.nativePayloadEncoding,
        tempBaseDir: this.options.tempBaseDir
      })
      store = new OcrArtifactStore({
        dbPath: path.join(cacheDir, 'ocr-cache.db'),
        keyProvider: new SafeStorageOcrCacheKeyProvider(path.join(cacheDir, 'cache-key.json'))
      })
      scheduler = new OcrExtractionScheduler()
      const snapshotBudget = new OcrSourceSnapshotBudget()
      extraction = new ImageTextExtractionService({
        processHost: host,
        artifactStore: store,
        scheduler,
        closeSchedulerOnClose: false,
        snapshotBudget,
        lightOcrVersion: availability.assets.lightOcrVersion,
        bundleId: availability.assets.bundleId,
        onDiagnostic: this.options.onDiagnostic
      })
      documentExtraction = new DocumentTextExtractionService({
        processHost: host,
        artifactStore: store,
        scheduler,
        closeSchedulerOnClose: false,
        snapshotBudget,
        facadeVersion: availability.assets.lightOcrVersion,
        bundleId: availability.assets.bundleId,
        onDiagnostic: this.options.onDiagnostic
      })
      if (this.closed) throw new Error('OCR runtime service is closed')
      return { host, store, scheduler, extraction, documentExtraction }
    } catch (error) {
      extraction?.close()
      documentExtraction?.close()
      scheduler?.close()
      await Promise.allSettled([host?.close(), store?.close()])
      throw error
    }
  }

  private isResourcesBusy(resources: RuntimeResources): boolean {
    const processStatus = resources.host.getStatus()
    return (
      resources.extraction.hasActiveExtractions() ||
      resources.documentExtraction.hasActiveExtractions() ||
      processStatus.queuedRequests > 0 ||
      processStatus.state === 'starting' ||
      processStatus.state === 'busy' ||
      processStatus.state === 'stopping'
    )
  }

  private async disposeResources(resources: RuntimeResources): Promise<void> {
    resources.extraction.close()
    resources.documentExtraction.close()
    resources.scheduler.close()
    await Promise.allSettled([resources.host.close(), resources.store.close()])
  }
}
