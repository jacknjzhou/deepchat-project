export type ProviderWriteAction = 'update' | 'remove' | 'reorder'

export class ManagedProviderLockedError extends Error {
  constructor(readonly providerId: string) {
    super(
      `[managed.providerLocked:${providerId}] This provider is managed by your organization and cannot be changed.`
    )
    this.name = 'ManagedProviderLockedError'
  }
}

export function assertProviderWritable(
  providerId: string,
  _action: ProviderWriteAction,
  readManagedProviderIds: () => string[]
): void {
  if (readManagedProviderIds().includes(providerId)) {
    throw new ManagedProviderLockedError(providerId)
  }
}
