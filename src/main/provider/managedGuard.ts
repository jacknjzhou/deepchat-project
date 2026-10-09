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
  readManagedProviderIds: () => string[]
): void {
  if (readManagedProviderIds().includes(providerId)) {
    throw new ManagedProviderLockedError(providerId)
  }
}

/**
 * 只保护托管 provider 之间的相对顺序：用户重排自有 provider 放行，
 * 一旦托管 provider 在结果中的相对顺序发生变化即拒绝。
 */
export function assertManagedOrderPreserved(
  incomingIds: readonly string[],
  currentIds: readonly string[],
  readManagedProviderIds: () => string[]
): void {
  const managed = new Set(readManagedProviderIds())
  if (managed.size === 0) {
    return
  }
  const currentManaged = currentIds.filter((id) => managed.has(id))
  const incomingManaged = incomingIds.filter((id) => managed.has(id))
  const length = Math.max(currentManaged.length, incomingManaged.length)
  for (let index = 0; index < length; index += 1) {
    const expected = currentManaged[index]
    const actual = incomingManaged[index]
    if (expected !== actual) {
      throw new ManagedProviderLockedError(actual ?? expected ?? '')
    }
  }
}
