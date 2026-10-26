import { unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  createStaffdeckSkillSync,
  type StaffdeckSkillSyncDeps
} from '../../../src/main/digital-employee/skillSync'
import { employeeSkillName } from '../../../src/main/digital-employee/employeeScope'

/**
 * 技能同步。
 *
 * StaffDeck 会随员工下发技能包（SKILL.md 根目录的 zip）。deepchat 侧要做两件事：
 * 下载 zip，然后装进本地技能目录。
 *
 * 隔离靠命名而不是靠 agent 目录——数字员工的对话全部跑在内置 `deepchat` agent 下，
 * 没有「每个员工一个 agent」这回事，所以技能名带员工前缀。
 */

const EMPLOYEE = 'agent_f2828efc2a2a476d'

type Skill = { id: string; name: string; slug: string; downloadUrl: string }

type State = {
  installed: Record<string, string>
  downloads: string[]
  lastBytes: Uint8Array | null
}

function createHarness(
  options: {
    connection?: { baseUrl: string; apiKey: string } | null
    responses?: Record<string, { ok: boolean; status?: number; bytes?: Uint8Array }>
    installResult?: { success: boolean; error?: string }
    initialInstalled?: Record<string, string>
  } = {}
) {
  const state: State = {
    installed: { ...(options.initialInstalled ?? {}) },
    downloads: [],
    lastBytes: null
  }
  const baseUrl = options.connection?.baseUrl ?? 'http://staffdeck.test'

  const deps: StaffdeckSkillSyncDeps = {
    getConnection: () => (options.connection === null ? null : { baseUrl, apiKey: 'sd_live_abc' }),
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input)
      state.downloads.push(url)
      const key = Object.keys(options.responses ?? {}).find((marker) => url.includes(marker))
      const response = key ? options.responses?.[key] : undefined
      if (!response) return new Response('not found', { status: 404 })
      if (!response.ok) return new Response('error', { status: response.status ?? 500 })
      return new Response(response.bytes ?? new Uint8Array([1, 2, 3]), { status: 200 })
    }) as typeof fetch,
    writeTempFile: async (bytes) => {
      state.lastBytes = bytes
      const path = `/tmp/fake-${bytes.byteLength}-${state.downloads.length}.zip`
      return path
    },
    removeTempFile: async () => undefined,
    skills: {
      installFromZipForAgent: async (agentId, _zipPath, installOptions) => {
        const entry = state.downloads.length > 0 ? state.downloads.length : 0
        state.installed[`${agentId}:${installOptions?.targetName ?? 'unnamed'}`] = String(entry)
        return options.installResult ?? { success: true }
      }
    },
    stateStore: {
      get: (employeeId) => {
        const raw = state.installed[`__baseline__${employeeId}`]
        return raw ? (JSON.parse(raw) as Record<string, string>) : undefined
      },
      set: (employeeId, value) => {
        const key = `__baseline__${employeeId}`
        if (value === undefined) delete state.installed[key]
        else state.installed[key] = JSON.stringify(value)
      }
    }
  }

  return { deps, state }
}

const skill = (slug: string, id = `sk_${slug}`): Skill => ({
  id,
  name: slug,
  slug,
  downloadUrl: `http://localhost:5173/api/v1/digital-employees/${EMPLOYEE}:export-skill?slug=${slug}`
})

describe('syncEmployee', () => {
  it('does nothing when the employee distributes no skills', async () => {
    const harness = createHarness()

    const result = await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: []
    })

    expect(result).toEqual({ ok: true, installed: 0, failedSkills: [], failureReasons: {} })
    expect(harness.state.downloads).toEqual([])
  })

  it('downloads every skill on the first pass', async () => {
    const harness = createHarness({
      responses: { 'slug=alpha': { ok: true }, 'slug=beta': { ok: true } }
    })

    const result = await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha'), skill('beta')]
    })

    expect(result.ok).toBe(true)
    expect(result.installed).toBe(2)
    expect(harness.state.downloads).toHaveLength(2)
  })

  it('uses the configured base url, not the one baked into downloadUrl', async () => {
    const harness = createHarness({
      connection: { baseUrl: 'http://real-host:9999', apiKey: 'k' },
      responses: { 'slug=alpha': { ok: true } }
    })

    await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha')]
    })

    // downloadUrl 由服务端的 tool_base_url 拼出，默认 localhost:5173，与客户端配置无关。
    expect(harness.state.downloads[0].startsWith('http://real-host:9999/api/v1/')).toBe(true)
    expect(harness.state.downloads[0]).not.toContain('localhost:5173')
  })

  it('addresses the skill through the export endpoint with the slug as a query', async () => {
    const harness = createHarness({ responses: { 'slug=alpha': { ok: true } } })

    await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha')]
    })

    expect(harness.state.downloads[0]).toBe(
      `http://staffdeck.test/api/v1/digital-employees/${EMPLOYEE}:export-skill?slug=alpha`
    )
  })

  it('installs under the employee-prefixed skill name', async () => {
    const harness = createHarness({ responses: { 'slug=alpha': { ok: true } } })

    await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha')]
    })

    // 名字必须带员工前缀，否则两个员工的同名技能会抢同一个目录。
    expect(Object.keys(harness.state.installed)).toContain(
      `deepchat:${employeeSkillName(EMPLOYEE, 'alpha')}`
    )
  })

  it('skips a second pass when nothing changed', async () => {
    const harness = createHarness({ responses: { 'slug=alpha': { ok: true } } })
    const sync = createStaffdeckSkillSync(harness.deps)
    const input = { employeeId: EMPLOYEE, skills: [skill('alpha')] }

    await sync.syncEmployee(input)
    const downloadsAfterFirst = harness.state.downloads.length
    await sync.syncEmployee(input)

    // 版本没变就不该重复下载——技能包里可能有几百 KB 的脚本。
    expect(harness.state.downloads).toHaveLength(downloadsAfterFirst)
  })

  it('reinstalls when the skill id changes', async () => {
    const harness = createHarness({ responses: { 'slug=alpha': { ok: true } } })
    const sync = createStaffdeckSkillSync(harness.deps)

    await sync.syncEmployee({ employeeId: EMPLOYEE, skills: [skill('alpha', 'sk_v1')] })
    const before = harness.state.downloads.length
    await sync.syncEmployee({ employeeId: EMPLOYEE, skills: [skill('alpha', 'sk_v2')] })

    // 服务端每次保存技能都会换 id，用它作版本号比内容 hash 便宜且够准。
    expect(harness.state.downloads.length).toBe(before + 1)
  })

  it('keeps going when one skill is missing on the server', async () => {
    const harness = createHarness({ responses: { 'slug=beta': { ok: true } } })

    const result = await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha'), skill('beta')]
    })

    expect(result.ok).toBe(false)
    expect(result.installed).toBe(1)
    expect(result.failedSkills).toEqual(['alpha'])
    // 失败原因必须可诊断：服务端 404 与网络故障的处置完全不同。
    expect(result.failureReasons).toEqual({ alpha: 'HTTP 404' })
  })

  it('remembers a successful install as the baseline', async () => {
    const harness = createHarness({ responses: { 'slug=alpha': { ok: true } } })
    const sync = createStaffdeckSkillSync(harness.deps)

    await sync.syncEmployee({ employeeId: EMPLOYEE, skills: [skill('alpha')] })

    expect(harness.state.installed[`__baseline__${EMPLOYEE}`]).toContain('sk_alpha')
  })

  it('does not record a failed install as the baseline', async () => {
    const harness = createHarness({
      responses: { 'slug=alpha': { ok: true } },
      installResult: { success: false, error: 'boom' }
    })

    await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha')]
    })

    // 记了基线就永远不会补上，失败的必须留空等下轮。
    expect(harness.state.installed[`__baseline__${EMPLOYEE}`] ?? '').not.toContain('sk_alpha')
  })

  it('reports an install failure without throwing', async () => {
    const harness = createHarness({
      responses: { 'slug=alpha': { ok: true } },
      installResult: { success: false, error: 'Skill "x" already exists' }
    })

    const result = await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha')]
    })

    expect(result.ok).toBe(false)
    expect(result.failedSkills).toEqual(['alpha'])
    expect(result.failureReasons).toEqual({ alpha: 'installer: Skill "x" already exists' })
  })

  it('tolerates a corrupt archive handed to the installer', async () => {
    const harness = createHarness({
      responses: { 'slug=alpha': { ok: true } },
      installResult: { success: false, error: 'ZIP entry has an invalid path' }
    })

    await expect(
      createStaffdeckSkillSync(harness.deps).syncEmployee({
        employeeId: EMPLOYEE,
        skills: [skill('alpha')]
      })
    ).resolves.toMatchObject({ ok: false })
  })

  it('does nothing when staffdeck is not configured', async () => {
    const harness = createHarness({ connection: null })

    const result = await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha')]
    })

    expect(result).toEqual({
      ok: false,
      installed: 0,
      failedSkills: [],
      failureReasons: {},
      reason: 'NOT_CONFIGURED'
    })
    expect(harness.state.downloads).toEqual([])
  })

  it('always cleans up the temp file', async () => {
    const removed: string[] = []
    const harness = createHarness({ responses: { 'slug=alpha': { ok: true } } })
    harness.deps.removeTempFile = async (path) => {
      removed.push(path)
    }

    await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha')]
    })

    expect(removed).toHaveLength(1)
  })

  it('cleans up the temp file even when installation fails', async () => {
    const removed: string[] = []
    const harness = createHarness({
      responses: { 'slug=alpha': { ok: true } },
      installResult: { success: false, error: 'boom' }
    })
    harness.deps.removeTempFile = async (path) => {
      removed.push(path)
    }

    await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha')]
    })

    expect(removed).toHaveLength(1)
  })

  it('drops the baseline for a skill the server stopped distributing', async () => {
    const harness = createHarness({
      responses: { 'slug=alpha': { ok: true }, 'slug=beta': { ok: true } }
    })
    const sync = createStaffdeckSkillSync(harness.deps)
    await sync.syncEmployee({ employeeId: EMPLOYEE, skills: [skill('alpha'), skill('beta')] })

    await sync.syncEmployee({ employeeId: EMPLOYEE, skills: [skill('alpha')] })

    // 基线里留着已下线的技能，将来同名技能重新上线时会被误判为「已装过」。
    expect(harness.state.installed[`__baseline__${EMPLOYEE}`]).not.toContain('sk_beta')
  })

  it('patches a missing SKILL.md frontmatter before installing', async () => {
    // 服务端（knowledge/skill 生成端）导出的包实测没有 frontmatter，直接以标题开头。
    const bare = zipSync({ 'SKILL.md': Buffer.from('# 文本翻译\n\n正文。\n', 'utf8') })
    const harness = createHarness({
      responses: { 'slug=text-translation': { ok: true, bytes: bare } }
    })
    const named: Skill = {
      id: 'sk_tt',
      name: '文本翻译',
      slug: 'text-translation',
      downloadUrl: ''
    }

    const result = await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [named]
    })

    expect(result.ok).toBe(true)
    const files = unzipSync(harness.state.lastBytes ?? new Uint8Array())
    const patched = Buffer.from(files['SKILL.md']).toString('utf8')
    // name 走 slug 清洗（frontmatter 名不允许中文），description 走服务端显示名。
    expect(patched.startsWith('---\nname: text-translation\ndescription: "文本翻译"\n---\n')).toBe(
      true
    )
    // 原正文必须原样保留在 frontmatter 之后。
    expect(patched).toContain('# 文本翻译\n\n正文。')
  })

  it('keeps an existing SKILL.md frontmatter untouched', async () => {
    const withFrontmatter = zipSync({
      'SKILL.md': Buffer.from('---\nname: alpha\ndescription: x\n---\n# Alpha\n', 'utf8')
    })
    const harness = createHarness({
      responses: { 'slug=alpha': { ok: true, bytes: withFrontmatter } }
    })

    await createStaffdeckSkillSync(harness.deps).syncEmployee({
      employeeId: EMPLOYEE,
      skills: [skill('alpha')]
    })

    // 已合规的包不做任何重打包：bytes 与下载内容逐字节一致。
    expect(harness.state.lastBytes).toEqual(withFrontmatter)
  })
})
