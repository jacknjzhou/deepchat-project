import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractSkillArchive, DEFAULT_SKILL_ARCHIVE_LIMITS } from '../../../src/main/skill/archive'

// 全局 setup 把 fs / path mock 成空壳，这个用例必须用真实实现。
vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('path')
vi.unmock('node:path')

/**
 * D4 联调：StaffDeck 导出的技能包能不能被 deepchat 自己的解包器吃掉。
 *
 * fixture 是从真实服务端导出的（`GET /digital-employees/{id}:export-skill`），
 * 不是手工造的 zip —— 要验证的正是「两边对包结构的假设一致」。重新生成方式
 * 见 StaffDeck 仓库 backend/tests/manual_d4_handshake.py。
 */
// ESM 里没有 __dirname；vitest 的 cwd 是仓库根。
const FIXTURE = path.join(process.cwd(), 'test/fixtures/skills/staffdeck-export-skill.zip')

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('StaffDeck export-skill archive', () => {
  it('extracts with SKILL.md at the archive root', async () => {
    expect(fs.existsSync(FIXTURE)).toBe(true)

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'd4-extract-'))
    temporaryDirectories.push(target)

    await extractSkillArchive(FIXTURE, target, DEFAULT_SKILL_ARCHIVE_LIMITS)

    // 只验证结果落盘：解包器对非法结构一律抛错，没抛就说明包结构被接受了。
    const skillMd = path.join(target, 'SKILL.md')
    expect(fs.existsSync(skillMd)).toBe(true)
    expect(fs.readFileSync(skillMd, 'utf-8')).toContain('技能用途')
  })
})
