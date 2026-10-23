import { describe, expect, it, vi } from 'vitest'
import { createRemoteSessionRegistry } from '../../../src/main/digital-employee/remoteSessionRegistry'

function createMemorySettings(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  return {
    store,
    get<T = unknown>(key: string): T | undefined {
      return store.get(key) as T | undefined
    },
    set(key: string, value: unknown): void {
      store.set(key, value)
    }
  }
}

const KEY = 'digitalEmployee.remoteSessions'

describe('createRemoteSessionRegistry', () => {
  it('persists a binding and reads it back', () => {
    const settings = createMemorySettings()
    const registry = createRemoteSessionRegistry({ settings, key: KEY })

    registry.set('local-1', {
      remoteSessionId: 'remote-1',
      employeeId: 'emp-1',
      runId: 'run-1',
      lastEventId: null,
      executionMode: 'remote'
    })

    expect(registry.get('local-1')).toMatchObject({
      remoteSessionId: 'remote-1',
      employeeId: 'emp-1'
    })
    expect(settings.store.get(KEY)).toHaveProperty('local-1')
  })

  it('returns null for an unknown session', () => {
    const registry = createRemoteSessionRegistry({ settings: createMemorySettings(), key: KEY })
    expect(registry.get('missing')).toBeNull()
  })

  it('restores bindings written by a previous process', () => {
    const settings = createMemorySettings({
      [KEY]: {
        'local-1': {
          remoteSessionId: 'remote-1',
          employeeId: 'emp-1',
          runId: null,
          lastEventId: null,
          executionMode: 'remote'
        }
      }
    })
    const registry = createRemoteSessionRegistry({ settings, key: KEY })

    expect(registry.get('local-1')?.remoteSessionId).toBe('remote-1')
  })

  it('treats corrupted storage as empty instead of throwing', () => {
    const settings = createMemorySettings({ [KEY]: 'not-an-object' })
    const registry = createRemoteSessionRegistry({ settings, key: KEY })

    expect(registry.listAll()).toEqual([])
    expect(registry.get('local-1')).toBeNull()
  })

  it('drops entries that are missing required fields', () => {
    const settings = createMemorySettings({
      [KEY]: {
        good: {
          remoteSessionId: 'r',
          employeeId: 'e',
          runId: null,
          lastEventId: null,
          executionMode: 'remote'
        },
        broken: { remoteSessionId: 42 }
      }
    })
    const registry = createRemoteSessionRegistry({ settings, key: KEY })

    expect(registry.listAll().map((entry) => entry.sessionId)).toEqual(['good'])
  })

  it('updates the run cursor without losing the binding', () => {
    const settings = createMemorySettings()
    const registry = createRemoteSessionRegistry({ settings, key: KEY })
    registry.set('local-1', {
      remoteSessionId: 'remote-1',
      employeeId: 'emp-1',
      runId: 'run-1',
      lastEventId: null,
      executionMode: 'remote'
    })

    registry.update('local-1', { runId: 'run-2', lastEventId: '17' })

    expect(registry.get('local-1')).toMatchObject({
      remoteSessionId: 'remote-1',
      runId: 'run-2',
      lastEventId: '17'
    })
  })

  it('ignores an update for an unbound session instead of creating a half entry', () => {
    const settings = createMemorySettings()
    const registry = createRemoteSessionRegistry({ settings, key: KEY })

    registry.update('local-9', { runId: 'run-9' })

    expect(registry.get('local-9')).toBeNull()
  })

  it('deletes a binding and keeps the others', () => {
    const settings = createMemorySettings()
    const registry = createRemoteSessionRegistry({ settings, key: KEY })
    const binding = {
      remoteSessionId: 'r',
      employeeId: 'e',
      runId: null,
      lastEventId: null,
      executionMode: 'remote' as const
    }
    registry.set('a', binding)
    registry.set('b', { ...binding, remoteSessionId: 'r2' })

    registry.delete('a')

    expect(registry.get('a')).toBeNull()
    expect(registry.get('b')?.remoteSessionId).toBe('r2')
  })

  it('reports whether a session is bound without exposing the whole entry', () => {
    const settings = createMemorySettings()
    const registry = createRemoteSessionRegistry({ settings, key: KEY })
    registry.set('a', {
      remoteSessionId: 'r',
      employeeId: 'e',
      runId: null,
      lastEventId: null,
      executionMode: 'remote'
    })

    expect(registry.has('a')).toBe(true)
    expect(registry.has('b')).toBe(false)
  })

  it('does not throw when the settings store rejects a write', () => {
    const settings = createMemorySettings()
    settings.set = vi.fn(() => {
      throw new Error('disk full')
    })
    const registry = createRemoteSessionRegistry({ settings, key: KEY })

    expect(() =>
      registry.set('a', {
        remoteSessionId: 'r',
        employeeId: 'e',
        runId: null,
        lastEventId: null,
        executionMode: 'remote'
      })
    ).toThrow(/disk full/)
    // 写入失败后不得留下内存态脏数据，否则重启前后的行为会分叉。
    expect(registry.get('a')).toBeNull()
  })
})
