import { describe, expect, it, vi } from 'vitest'
import { createDigitalEmployeeKnowledgeServer } from '../../../src/main/digital-employee/knowledgeToolServer'

const makeKnowledge = (results: unknown[] = []) => ({
  similarityQuery: vi.fn(async () => results)
})

describe('DigitalEmployeeKnowledgeServer', () => {
  it('exposes one search tool bound to the employee local base', async () => {
    const knowledge = makeKnowledge([
      { id: 'c1', distance: 0.1, metadata: { content: '报销流程：先提交 OA，再走财务审核。' } }
    ])
    const server = createDigitalEmployeeKnowledgeServer({
      knowledge,
      localKnowledgeBaseId: 'de-emp-1'
    })

    const { tools } = await server.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('de_knowledge_search')
    expect(tools[0].inputSchema).toBeTruthy()

    const result = await server.callTool('de_knowledge_search', { query: '怎么报销' })
    expect(knowledge.similarityQuery).toHaveBeenCalledWith('de-emp-1', '怎么报销')
    expect(result.content[0].text).toContain('报销流程')
  })

  it('returns a friendly notice instead of erroring on no hits', async () => {
    const server = createDigitalEmployeeKnowledgeServer({
      knowledge: makeKnowledge(),
      localKnowledgeBaseId: 'de-emp-1'
    })
    const result = await server.callTool('de_knowledge_search', { query: '无关问题' })
    expect(result.content[0].text).toContain('未找到')
  })

  it('degrades query failures to tool text so the session keeps running', async () => {
    const knowledge = {
      similarityQuery: vi.fn(async () => {
        throw new Error('index busy')
      })
    }
    const server = createDigitalEmployeeKnowledgeServer({
      knowledge,
      localKnowledgeBaseId: 'de-emp-1'
    })
    const result = await server.callTool('de_knowledge_search', { query: 'x' })
    expect(result.content[0].text).toContain('知识检索失败')
  })

  it('never queries and answers empty when no local base is bound', async () => {
    const knowledge = makeKnowledge([{ id: 'c1', distance: 0, metadata: { content: 'x' } }])
    const server = createDigitalEmployeeKnowledgeServer({ knowledge, localKnowledgeBaseId: '' })
    const result = await server.callTool('de_knowledge_search', { query: '怎么报销' })
    expect(knowledge.similarityQuery).not.toHaveBeenCalled()
    expect(result.content[0].text).toContain('未找到')
  })
})
