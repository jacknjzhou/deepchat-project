import { describe, expect, it, beforeEach } from 'vitest'
import {
  DIGITAL_EMPLOYEE_KNOWLEDGE_SYNC_KEY,
  createKnowledgeSyncStateStore
} from '../../../src/main/digital-employee/knowledgeSyncState'

const createSettings = (initial: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>(Object.entries(initial))
  return {
    get<TValue = unknown>(key: string): TValue | undefined {
      return store.get(key) as TValue | undefined
    },
    set(key: string, value: unknown): void {
      store.set(key, value)
    }
  }
}

describe('knowledgeSyncState', () => {
  let settings: ReturnType<typeof createSettings>

  beforeEach(() => {
    settings = createSettings()
  })

  it('reads an empty state when nothing has been written', () => {
    const store = createKnowledgeSyncStateStore({ settings })
    expect(store.getEmployee('emp-1')).toBeNull()
    expect(store.listEmployees()).toEqual([])
  })

  it('survives corrupted stored data instead of throwing', () => {
    // 同步状态只是缓存：读坏了最多是全量重拉，不该阻断对话链路。
    const store = createKnowledgeSyncStateStore({
      settings: createSettings({ [DIGITAL_EMPLOYEE_KNOWLEDGE_SYNC_KEY]: 'not-an-object' })
    })
    expect(store.getEmployee('emp-1')).toBeNull()
  })

  it('round-trips an employee record', () => {
    const store = createKnowledgeSyncStateStore({ settings })
    store.setEmployee('emp-1', {
      localKnowledgeBaseId: 'de-emp-1',
      packages: {
        kb_a: {
          configVersion: 'kv1:abc',
          configHash: 'sha256:def',
          etag: '"etag-1"',
          stale: false,
          staleReason: null,
          lastSyncAt: '2026-10-23T00:00:00.000Z',
          concepts: { 'sources/doc': { hash: 'h1', fileId: 'file-1' } }
        }
      }
    })

    const read = createKnowledgeSyncStateStore({ settings }).getEmployee('emp-1')
    expect(read?.localKnowledgeBaseId).toBe('de-emp-1')
    expect(read?.packages.kb_a.configHash).toBe('sha256:def')
    expect(read?.packages.kb_a.concepts['sources/doc']).toEqual({
      hash: 'h1',
      fileId: 'file-1'
    })
  })

  it('keeps other packages intact when marking one stale', () => {
    const store = createKnowledgeSyncStateStore({ settings })
    store.setEmployee('emp-1', {
      localKnowledgeBaseId: 'de-emp-1',
      packages: {
        kb_a: {
          configVersion: 'kv1:a',
          configHash: 'sha256:a',
          etag: null,
          stale: false,
          staleReason: null,
          lastSyncAt: 't1',
          concepts: {}
        },
        kb_b: {
          configVersion: 'kv1:b',
          configHash: 'sha256:b',
          etag: null,
          stale: false,
          staleReason: null,
          lastSyncAt: 't1',
          concepts: {}
        }
      }
    })

    store.markPackageStale('emp-1', 'kb_a', 'UNREACHABLE')

    const read = store.getEmployee('emp-1')
    expect(read?.packages.kb_a.stale).toBe(true)
    expect(read?.packages.kb_a.staleReason).toBe('UNREACHABLE')
    expect(read?.packages.kb_b.stale).toBe(false)
    expect(read?.packages.kb_b.configHash).toBe('sha256:b')
  })

  it('does not invent an employee record when marking an unknown package stale', () => {
    const store = createKnowledgeSyncStateStore({ settings })
    store.markPackageStale('emp-missing', 'kb_a', 'UNREACHABLE')
    expect(store.getEmployee('emp-missing')).toBeNull()
  })

  it('clears only the requested package', () => {
    const store = createKnowledgeSyncStateStore({ settings })
    store.setEmployee('emp-1', {
      localKnowledgeBaseId: 'de-emp-1',
      packages: {
        kb_a: {
          configVersion: 'kv1:a',
          configHash: 'sha256:a',
          etag: null,
          stale: false,
          staleReason: null,
          lastSyncAt: 't1',
          concepts: { c1: { hash: 'h1', fileId: 'f1' } }
        },
        kb_b: {
          configVersion: 'kv1:b',
          configHash: 'sha256:b',
          etag: null,
          stale: false,
          staleReason: null,
          lastSyncAt: 't1',
          concepts: {}
        }
      }
    })

    store.removePackage('emp-1', 'kb_a')

    const read = store.getEmployee('emp-1')
    expect(read?.packages.kb_a).toBeUndefined()
    expect(read?.packages.kb_b).toBeDefined()
  })

  it('drops the employee record once its last package is removed', () => {
    // 留下一条 packages 为空的员工记录会让「这个员工同步过没有」的判断变成假阳性。
    const store = createKnowledgeSyncStateStore({ settings })
    store.setEmployee('emp-1', {
      localKnowledgeBaseId: 'de-emp-1',
      packages: {
        kb_a: {
          configVersion: 'kv1:a',
          configHash: 'sha256:a',
          etag: null,
          stale: false,
          staleReason: null,
          lastSyncAt: 't1',
          concepts: {}
        }
      }
    })

    store.removePackage('emp-1', 'kb_a')
    expect(store.getEmployee('emp-1')).toBeNull()
  })

  it('lists employees for the scheduler to iterate', () => {
    const store = createKnowledgeSyncStateStore({ settings })
    store.setEmployee('emp-1', { localKnowledgeBaseId: 'de-emp-1', packages: {} })
    store.setEmployee('emp-2', { localKnowledgeBaseId: 'de-emp-2', packages: {} })

    expect(
      store
        .listEmployees()
        .map((entry) => entry.employeeId)
        .sort()
    ).toEqual(['emp-1', 'emp-2'])
  })
})
