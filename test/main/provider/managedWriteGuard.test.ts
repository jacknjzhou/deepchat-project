import { describe, expect, it, vi } from 'vitest'
import { createRendererRouteContext } from '@/routes/routeRegistry'
import { createProviderRoutes } from '@/provider/routes'
import {
  modelsAddCustomRoute,
  modelsSetStatusRoute,
  providersAddRoute,
  providersRemoveRoute
} from '@shared/contracts/routes'
import {
  ManagedProviderLockedError,
  assertManagedOrderPreserved,
  assertProviderWritable
} from '@/provider/managedGuard'

describe('assertProviderWritable', () => {
  const readProviderIds = vi.fn(() => ['managed-corp-gw'])

  it('throws for managed provider on update', () => {
    expect(() => assertProviderWritable('managed-corp-gw', readProviderIds)).toThrow(
      /\[managed\.providerLocked:managed-corp-gw\]/
    )
  })

  it('throws for managed provider on remove', () => {
    expect(() => assertProviderWritable('managed-corp-gw', readProviderIds)).toThrow(
      ManagedProviderLockedError
    )
  })

  it('allows the builtin new-api entry', () => {
    expect(() => assertProviderWritable('new-api', readProviderIds)).not.toThrow()
  })

  it('allows user-created instances of the same apiType', () => {
    expect(() => assertProviderWritable('my-newapi', readProviderIds)).not.toThrow()
    expect(() => assertProviderWritable('managed-corp-gw-2', readProviderIds)).not.toThrow()
    expect(() => assertProviderWritable('MANAGED-CORP-GW', readProviderIds)).not.toThrow()
  })

  it('allows everything when nothing is managed', () => {
    expect(() => assertProviderWritable('managed-corp-gw', () => [])).not.toThrow()
  })
})

describe('assertManagedOrderPreserved', () => {
  const readProviderIds = () => ['managed-1', 'managed-2']

  it('allows reordering user providers when managed order is preserved', () => {
    expect(() =>
      assertManagedOrderPreserved(
        ['b', 'managed-1', 'a', 'managed-2'],
        ['a', 'managed-1', 'b', 'managed-2'],
        readProviderIds
      )
    ).not.toThrow()
  })

  it('rejects changing the relative order of managed providers', () => {
    expect(() =>
      assertManagedOrderPreserved(
        ['a', 'managed-2', 'b', 'managed-1'],
        ['a', 'managed-1', 'b', 'managed-2'],
        readProviderIds
      )
    ).toThrow(/\[managed\.providerLocked:managed-2\]/)
  })

  it('rejects dropping a managed provider from the reorder payload', () => {
    expect(() =>
      assertManagedOrderPreserved(
        ['a', 'b', 'managed-1'],
        ['a', 'managed-1', 'b', 'managed-2'],
        readProviderIds
      )
    ).toThrow(ManagedProviderLockedError)
  })

  it('allows any order when nothing is managed', () => {
    expect(() => assertManagedOrderPreserved(['b', 'a'], ['a', 'b'], () => [])).not.toThrow()
  })
})

describe('provider write guard integration', () => {
  const context = createRendererRouteContext(42, 7)

  function createRoutes(managedIds: string[]) {
    const removeProviderAtomic = vi.fn()
    const addProviderAtomic = vi.fn()
    const addCustomModel = vi.fn(async (providerId: string, model: Record<string, unknown>) => ({
      ...model,
      group: 'custom',
      providerId,
      isCustom: true
    }))
    const updateModelStatus = vi.fn()
    const getProviderById = vi.fn(() => undefined)
    const routes = createProviderRoutes({
      providerSettings: {
        getProviders: () => [],
        getProviderById,
        isManagedProvider: (providerId: string) => managedIds.includes(providerId)
      } as any,
      providerRuntime: {
        removeProviderAtomic,
        addProviderAtomic,
        addCustomModel,
        updateModelStatus
      } as any,
      acpProviderAdminPort: {} as any,
      providerImportService: {} as any,
      oauthService: {} as any,
      scheduler: {
        timeout: async <T>({ task }: { task: Promise<T> }) => await task
      },
      readManagedProviderIds: () => managedIds,
      recordSettingsActivity: vi.fn(async () => undefined)
    })
    return { routes, removeProviderAtomic, addProviderAtomic, addCustomModel, updateModelStatus }
  }

  it('blocks removing a managed provider and leaves settings untouched', async () => {
    const { routes, removeProviderAtomic } = createRoutes(['managed-corp-gw'])

    await expect(
      routes.get(providersRemoveRoute.name)?.({ providerId: 'managed-corp-gw' }, context)
    ).rejects.toBeInstanceOf(ManagedProviderLockedError)
    expect(removeProviderAtomic).not.toHaveBeenCalled()
  })

  it('allows adding a user instance that shares a managed apiType', async () => {
    const { routes, addProviderAtomic } = createRoutes(['managed-corp-gw'])

    await expect(
      routes.get(providersAddRoute.name)?.(
        {
          provider: {
            id: 'my-corp-gw',
            name: 'My Corp GW',
            apiType: 'new-api',
            apiKey: '',
            baseUrl: 'https://example.com',
            enable: true,
            custom: true
          }
        },
        context
      )
    ).resolves.toMatchObject({ provider: { id: 'my-corp-gw' } })
    expect(addProviderAtomic).toHaveBeenCalledTimes(1)
  })

  it('blocks adding a custom model to a managed provider', async () => {
    const { routes, addCustomModel } = createRoutes(['managed-corp-gw'])

    await expect(
      routes.get(modelsAddCustomRoute.name)?.(
        { providerId: 'managed-corp-gw', model: { id: 'tampered', name: 'Tampered' } },
        context
      )
    ).rejects.toBeInstanceOf(ManagedProviderLockedError)
    await expect(
      routes.get(modelsAddCustomRoute.name)?.(
        { providerId: 'managed-corp-gw', model: { id: 'tampered', name: 'Tampered' } },
        context
      )
    ).rejects.toThrow(/\[managed\.providerLocked:managed-corp-gw\]/)
    expect(addCustomModel).not.toHaveBeenCalled()
  })

  it('allows adding a custom model to a user provider', async () => {
    const { routes, addCustomModel } = createRoutes(['managed-corp-gw'])

    await expect(
      routes.get(modelsAddCustomRoute.name)?.(
        { providerId: 'my-provider', model: { id: 'my-model', name: 'My Model' } },
        context
      )
    ).resolves.toMatchObject({ model: { id: 'my-model', providerId: 'my-provider' } })
    expect(addCustomModel).toHaveBeenCalledTimes(1)
  })

  it('does not block toggling models on a managed provider', async () => {
    const { routes, updateModelStatus } = createRoutes(['managed-corp-gw'])

    await expect(
      routes.get(modelsSetStatusRoute.name)?.(
        { providerId: 'managed-corp-gw', modelId: 'managed-model', enabled: true },
        context
      )
    ).resolves.toEqual({ providerId: 'managed-corp-gw', modelId: 'managed-model', enabled: true })
    expect(updateModelStatus).toHaveBeenCalledWith('managed-corp-gw', 'managed-model', true)
  })
})
