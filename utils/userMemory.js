import fs from 'fs/promises'
import path from 'path'
import { Config } from './config.js'

const MEMORY_ROOT = path.join(process.cwd(), 'plugins/chatgpt-plugin/config/memory')
const USER_MEMORY_DIR = path.join(MEMORY_ROOT, 'users')
const GROUP_MEMORY_DIR = path.join(MEMORY_ROOT, 'groups')

const SECTION_TITLES = ['Summary', 'Facts', 'Archive']
const DEFAULT_SUMMARY_LIMIT = 12
const DEFAULT_PROMPT_MAX_CHARS = 1000
const DEFAULT_RELEVANT_FACTS_LIMIT = 4
const memoryWriteQueues = new Map()

// Markdown 记忆后端：
// - users/<userId>.md 记录跨群共享的个人长期记忆
// - groups/<groupId>.md 记录当前群独立的群长期记忆
// - Summary 负责每轮低 token 注入，Facts 保存活跃事实，Archive 保存过时/溢出的旧记忆
function safeId(id) {
  return String(id || 'unknown').replace(/[^\w.-]/g, '_')
}

function memoryDir(scope) {
  return scope === 'group' ? GROUP_MEMORY_DIR : USER_MEMORY_DIR
}

function memoryPath(scope, id) {
  return path.join(memoryDir(scope), `${safeId(id)}.md`)
}

async function withMemoryWriteLock(scope, id, fn) {
  const key = memoryPath(scope, id)
  const previous = memoryWriteQueues.get(key) || Promise.resolve()
  let release
  const current = new Promise(resolve => {
    release = resolve
  })
  const chained = previous.then(() => current, () => current)
  memoryWriteQueues.set(key, chained)

  try {
    await previous
    return await fn()
  } finally {
    release()
    if (memoryWriteQueues.get(key) === chained) {
      memoryWriteQueues.delete(key)
    }
  }
}

function nowText() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

function normalizeText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?;:：；"'`~@#$%^&*()_\-+=\[\]{}<>]/g, '')
    .trim()
}

function shouldSkipMemory(memory) {
  if (!memory?.content) return true
  return false
}

function memoryDedupeKey(memory = {}) {
  return String(memory.key || normalizeText(memory.content)).trim().toLowerCase()
}

function memoryTarget(scope, memory = {}) {
  return scope === 'group' ? memory.groupId : memory.userId
}

function memorySource(memory = {}) {
  if (memory.source) return String(memory.source).trim()
  const sourceType = memory.sourceType || 'current_message'
  const sourceGroup = memory.sourceGroupId || memory.groupId || (memory.isGroup ? 'unknown_group' : 'private')
  const sourceUser = memory.sourceUserId || memory.userId || 'unknown_user'
  const sourceMessage = memory.sourceMessageId || memory.messageId || ''
  return [sourceType, sourceGroup, sourceUser, sourceMessage].map(item => String(item || '')).join(':')
}

function stripBullet(line = '') {
  return String(line || '').replace(/^\s*[-*]\s+/, '').trim()
}

function clip(text = '', max = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}...` : s
}

function parseMeta(meta = '') {
  const result = {}
  String(meta || '').replace(/(\w+)="([^"]*)"/g, (_, key, value) => {
    result[key] = value.replace(/&quot;/g, '"')
    return ''
  })
  return result
}

function encodeMetaValue(value = '') {
  return String(value || '').replace(/"/g, '&quot;')
}

function encodeMeta(memory) {
  const tags = Array.isArray(memory.tags) ? memory.tags.join(',') : ''
  const scope = memory.scope === 'group' ? 'group' : 'user'
  const fields = {
    id: memory.id,
    type: memory.memoryType || 'event',
    key: memoryDedupeKey(memory),
    importance: memory.importance || 1,
    scope,
    target: memory.target || memoryTarget(scope, memory) || '',
    source: memorySource(memory),
    confidence: memory.confidence || '',
    timestamp: memory.timestamp || Date.now(),
    date: memory.date || nowText(),
    group: memory.groupId || '',
    tags
  }
  const meta = Object.entries(fields)
    .map(([key, value]) => `${key}="${encodeMetaValue(value)}"`)
    .join(' ')
  return `<!-- ${meta} -->`
}

function emptyDocument() {
  return '# ChatGPT Memory\n\n## Summary\n\n## Facts\n\n## Archive\n'
}

function splitSections(markdown = '') {
  const sections = {
    Summary: [],
    Facts: [],
    Archive: []
  }
  let current = null
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const title = line.match(/^##\s+(Summary|Facts|Archive)\s*$/i)?.[1]
    if (title) {
      current = SECTION_TITLES.find(item => item.toLowerCase() === title.toLowerCase())
      continue
    }
    if (current) {
      sections[current].push(line)
    }
  }
  return sections
}

function renderSections(sections) {
  const clean = title => (sections[title] || [])
    .map(line => String(line || '').trimEnd())
    .filter((line, index, arr) => line || (arr[index - 1] && arr[index + 1]))
    .join('\n')
    .trim()

  return `# ChatGPT Memory\n\n## Summary\n${clean('Summary') ? `\n${clean('Summary')}\n` : '\n'}\n## Facts\n${clean('Facts') ? `\n${clean('Facts')}\n` : '\n'}\n## Archive\n${clean('Archive') ? `\n${clean('Archive')}\n` : '\n'}`
}

function parseMemoryLine(line = '') {
  const match = String(line || '').match(/^\s*[-*]\s+(<!--\s*([^>]+)\s*-->\s*)?(.+?)\s*$/)
  if (!match) return null
  const meta = parseMeta(match[2] || '')
  const content = String(match[3] || '').trim()
  if (!content) return null
  return {
    id: meta.id || '',
    memoryType: meta.type || 'event',
    importance: Number(meta.importance || 1),
    timestamp: Number(meta.timestamp || 0),
    date: meta.date || '',
    scope: meta.scope || '',
    target: meta.target || '',
    source: meta.source || '',
    confidence: meta.confidence ? Number(meta.confidence) : null,
    groupId: meta.group || null,
    key: meta.key || '',
    tags: meta.tags ? meta.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    content
  }
}

function renderMemoryLine(memory) {
  return `- ${encodeMeta(memory)} ${clip(memory.content, 180)}`
}

function getSummaryLines(sections) {
  return (sections.Summary || [])
    .map(stripBullet)
    .filter(Boolean)
}

function scoreMemory(memory, query = '') {
  const q = normalizeText(query)
  const content = normalizeText(`${memory.content || ''}${(memory.tags || []).join('')}`)
  let score = Number(memory.importance || 1)

  // 相关性加权：当前消息和记忆内容/tag 重合越多，本轮越优先补充到上下文。
  if (q && content) {
    const chars = [...new Set(q.split(''))]
    const hits = chars.filter(ch => content.includes(ch)).length
    score += Math.min(8, hits / 2)
  }

  // 时间衰减：排序时同时考虑重要性和时效性。
  // 越久越降权，但最低保留 25%，避免高重要长期事实被时间完全抹掉。
  const ageDays = memory.timestamp ? (Date.now() - memory.timestamp) / (1000 * 60 * 60 * 24) : 365
  score *= Math.max(0.25, 1 - ageDays / 365)
  return score
}

function shouldArchive(memory) {
  const ageDays = memory.timestamp ? (Date.now() - memory.timestamp) / (1000 * 60 * 60 * 24) : 365
  const content = memory.content || ''

  // 过时清理策略：短期情绪、含相对时间的旧事件、低重要性旧事实不直接删除，
  // 而是移入 Archive，便于人工回看，同时不再进入默认对话注入。
  if (shouldSkipMemory(memory)) return true
  if (memory.memoryType === 'emotional_memory' && memory.importance <= 6 && ageDays > 30) return true
  if (memory.memoryType === 'event' && ageDays > 60 && /今天|明天|后天|今晚|下周|这周|周[一二三四五六日天]/.test(content)) return true
  if (memory.importance <= 3 && ageDays > 90) return true
  return false
}

async function ensureMemoryDirs() {
  await fs.mkdir(USER_MEMORY_DIR, { recursive: true })
  await fs.mkdir(GROUP_MEMORY_DIR, { recursive: true })
}

async function readMemoryFile(scope, id, createIfMissing = true) {
  await ensureMemoryDirs()
  const file = memoryPath(scope, id)
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    if (!createIfMissing) return null
    await fs.writeFile(file, emptyDocument(), 'utf8')
    return emptyDocument()
  }
}

async function writeMemoryFile(scope, id, sections) {
  await ensureMemoryDirs()
  await fs.writeFile(memoryPath(scope, id), `${renderSections(sections).trim()}\n`, 'utf8')
}

async function listMemoryFiles(scope) {
  await ensureMemoryDirs()
  const dir = memoryDir(scope)
  try {
    return (await fs.readdir(dir))
      .filter(name => name.endsWith('.md'))
      .map(name => path.join(dir, name))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

export class UserMemory {
  static _normalizeMemoryText(text = '') {
    return normalizeText(text)
  }

  /**
   * 查找同 key 的已有记忆（同 memoryType 且 key 匹配）。
   * 返回匹配的记忆对象，未找到返回 null。
   */
  static _findSameKeyMemory(candidate, existingMemories = []) {
    if (!candidate || !candidate.content) return null
    const next = memoryDedupeKey(candidate)
    if (!next) return null
    return existingMemories.find(m => {
      if (!m || m.memoryType !== candidate.memoryType) return false
      const old = memoryDedupeKey(m)
      if (!old) return false
      return old === next || old.includes(next) || next.includes(old)
    }) || null
  }

  /**
   * 判断是否为完全重复的记忆（同 key 且内容也相同）。
   * 用于 compact 去重和跳过完全相同的写入。
   */
  static _isDuplicateMemory(candidate, existingMemories = []) {
    if (!candidate || !candidate.content) return true
    const match = this._findSameKeyMemory(candidate, existingMemories)
    if (!match) return false
    // 同 key 但内容不同 → 不算重复（需要替换）
    // 同 key 且内容也相同 → 才算真正的重复
    return normalizeText(candidate.content) === normalizeText(match.content)
  }

  static async _read(scope, id, createIfMissing = true) {
    const markdown = await readMemoryFile(scope, id, createIfMissing)
    return markdown == null ? null : splitSections(markdown)
  }

  static _parseMemories(sections, sectionName = 'Facts') {
    return (sections[sectionName] || [])
      .map(parseMemoryLine)
      .filter(Boolean)
      .sort((a, b) => b.timestamp - a.timestamp)
  }

  static async _compact(scope, id) {
    const sections = await this._read(scope, id)
    const maxFacts = Math.max(5, Number(scope === 'group'
      ? (Config.maxMemoriesPerGroup || 30)
      : (Config.maxMemoriesPerUser || 20)))
    const summaryLimit = Math.max(3, Number(Config.memorySummaryLimit || DEFAULT_SUMMARY_LIMIT))
    const active = []
    const withStorageMeta = memory => ({
      ...memory,
      scope: memory.scope || scope,
      target: id,
      groupId: memory.groupId || (scope === 'group' ? id : null)
    })
    const archive = this._parseMemories(sections, 'Archive').map(withStorageMeta)

    // 整理阶段先把过时记忆挪到 Archive，把活跃记忆继续参与去重和排序。
    for (const memory of this._parseMemories(sections, 'Facts').map(withStorageMeta)) {
      if (shouldArchive(memory)) {
        archive.push(memory)
      } else {
        active.push(memory)
      }
    }

    // 同类型内容按核心语义做去重，避免同一事实用不同表述反复占位。
    const unique = []
    for (const memory of active.sort((a, b) => scoreMemory(b) - scoreMemory(a))) {
      if (!this._isDuplicateMemory(memory, unique)) {
        unique.push(memory)
      }
    }

    // 上限控制：Facts 只保留当前范围内分数最高的活跃记忆。
    // 用户和群分别使用 maxMemoriesPerUser / maxMemoriesPerGroup。
    const kept = unique.slice(0, maxFacts)
    const moved = unique.slice(maxFacts)
    const sortedArchive = [...archive, ...moved]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxFacts * 2)

    // Summary 是每轮注入的主要来源，所以强制保持短句和少量条目。
    const summary = kept
      .sort((a, b) => scoreMemory(b) - scoreMemory(a))
      .slice(0, summaryLimit)
      .map(memory => `- ${clip(memory.content, 80)}`)

    sections.Summary = summary
    sections.Facts = kept
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(renderMemoryLine)
    sections.Archive = sortedArchive.map(renderMemoryLine)

    await writeMemoryFile(scope, id, sections)
  }

  static async saveMemory(memory) {
    try {
      const scope = memory.scope === 'group' ? 'group' : 'user'
      const targetId = memoryTarget(scope, memory)
      if (!targetId) {
        return { success: false, message: '缺少记忆目标ID' }
      }
      if (shouldSkipMemory(memory)) {
        return { success: true, message: '记忆内容为空，已跳过' }
      }

      return await withMemoryWriteLock(scope, targetId, async () => {
        const sections = await this._read(scope, targetId)
        const existing = this._parseMemories(sections, 'Facts')

        const next = {
          ...memory,
          id: memory.id || `${Date.now()}${Math.random().toString(36).substring(2, 9)}`,
          timestamp: memory.timestamp || Date.now(),
          date: memory.date || nowText(),
          importance: Math.min(10, Math.max(1, Number(memory.importance || 1))),
          scope,
          target: targetId,
          source: memorySource(memory),
          confidence: memory.confidence ? Math.min(1, Math.max(0, Number(memory.confidence))) : '',
          key: memoryDedupeKey(memory),
          tags: Array.isArray(memory.tags) ? memory.tags : []
        }

        // 查找同 key 的已有记忆
        const sameKeyMemory = this._findSameKeyMemory(memory, existing)

        if (sameKeyMemory) {
          // 同 key 且内容也完全相同 → 跳过，无需重复写入
          if (normalizeText(memory.content) === normalizeText(sameKeyMemory.content)) {
            return { success: true, message: '记忆已存在，已跳过' }
          }

          // 同 key 但内容不同 → 替换旧记忆为新记忆（将旧记忆归档，写入新记忆）
          logger.debug(`[Memory] 同 key 记忆更新：「${clip(sameKeyMemory.content, 40)}」→「${clip(memory.content, 40)}」`)

          // 将旧记忆移入 Archive
          if (!sections.Archive) sections.Archive = []
          sections.Archive = [renderMemoryLine({ ...sameKeyMemory, scope, target: targetId }), ...sections.Archive]

          // 从 Facts 中移除旧记忆行
          const oldKey = memoryDedupeKey(sameKeyMemory)
          sections.Facts = (sections.Facts || []).filter(line => {
            const parsed = parseMemoryLine(line)
            if (!parsed) return true
            return memoryDedupeKey(parsed) !== oldKey || parsed.memoryType !== sameKeyMemory.memoryType
          })
        }

        // 新记忆进入 Facts，再统一 compact：生成 Summary、归档过时项、执行上限整理。
        sections.Facts = [renderMemoryLine(next), ...(sections.Facts || [])]
        await writeMemoryFile(scope, targetId, sections)
        await this._compact(scope, targetId)

        return {
          success: true,
          message: sameKeyMemory ? '记忆已更新' : '记忆保存成功'
        }
      })
    } catch (err) {
      logger.error('[Memory] 保存记忆失败:', err)
      return {
        success: false,
        message: err.message || '未知错误'
      }
    }
  }

  static async getUserMemories(userId, limit = 10, minImportance = 1) {
    try {
      const sections = await this._read('user', userId, false)
      if (!sections) return []
      return this._parseMemories(sections, 'Facts')
        .filter(m => m.importance >= minImportance)
        .slice(0, limit)
    } catch (err) {
      logger.error('[Memory] 获取用户记忆失败:', err)
      return []
    }
  }

  static async getGroupMemories(groupId, limit = 10, minImportance = 1) {
    try {
      const sections = await this._read('group', groupId, false)
      if (!sections) return []
      return this._parseMemories(sections, 'Facts')
        .filter(m => m.importance >= minImportance)
        .slice(0, limit)
    } catch (err) {
      logger.error('[Memory] 获取群记忆失败:', err)
      return []
    }
  }

  static async searchMemoriesByTags(userId, tags) {
    try {
      const memories = await this.getUserMemories(userId, 100, 1)
      return memories.filter(m =>
        m.tags && m.tags.some(tag => tags.includes(tag))
      )
    } catch (err) {
      logger.error('[Memory] 搜索记忆失败:', err)
      return []
    }
  }

  static async deleteMemory(userId, memoryId, scope = 'user') {
    try {
      return await withMemoryWriteLock(scope, userId, async () => {
        const sections = await this._read(scope, userId, false)
        if (!sections) return false
        let deleted = false
        for (const section of ['Facts', 'Archive']) {
          const before = sections[section].length
          sections[section] = sections[section].filter(line => parseMemoryLine(line)?.id !== memoryId)
          deleted = deleted || before !== sections[section].length
        }
        if (deleted) {
          await writeMemoryFile(scope, userId, sections)
          await this._compact(scope, userId)
        }
        return deleted
      })
    } catch (err) {
      logger.error('[Memory] 删除记忆失败:', err)
      return false
    }
  }

  static async clearUserMemories(userId) {
    try {
      await withMemoryWriteLock('user', userId, async () => {
        await writeMemoryFile('user', userId, splitSections(emptyDocument()))
      })
      return true
    } catch (err) {
      logger.error('[Memory] 清空用户记忆失败:', err)
      return false
    }
  }

  static async clearGroupMemories(groupId) {
    try {
      await withMemoryWriteLock('group', groupId, async () => {
        await writeMemoryFile('group', groupId, splitSections(emptyDocument()))
      })
      return true
    } catch (err) {
      logger.error('[Memory] 清空群记忆失败:', err)
      return false
    }
  }

  static async clearAllMemories() {
    try {
      let count = 0
      for (const scope of ['user', 'group']) {
        for (const file of await listMemoryFiles(scope)) {
          await fs.writeFile(file, emptyDocument(), 'utf8')
          count++
        }
      }
      return count
    } catch (err) {
      logger.error('[Memory] 清空所有记忆失败:', err)
      return 0
    }
  }

  static async getAllMemories() {
    const all = []
    for (const scope of ['user', 'group']) {
      for (const file of await listMemoryFiles(scope)) {
        const id = path.basename(file, '.md')
        const sections = splitSections(await fs.readFile(file, 'utf8'))
        all.push(...this._parseMemories(sections, 'Facts').map(memory => ({
          ...memory,
          scope,
          userId: scope === 'user' ? id : memory.userId,
          groupId: scope === 'group' ? id : memory.groupId
        })))
      }
    }
    return all
  }

  static formatMemoriesForPrompt(memories) {
    if (!memories || memories.length === 0) return ''
    return memories
      .map(memory => `- ${memory.content}`)
      .join('\n')
  }

  static async buildMemoryPromptForEvent(e, query = '') {
    if (!Config.enableMemory) return ''
    const userId = e?.user_id || e?.sender?.user_id
    const groupId = e?.group_id
    const minImportance = Number(Config.memoryMinImportance || 1)
    const relevantLimit = Math.max(1, Number(Config.memoryRelevantFactsLimit || DEFAULT_RELEVANT_FACTS_LIMIT))
    const maxChars = Math.max(400, Number(Config.memoryPromptMaxChars || DEFAULT_PROMPT_MAX_CHARS))

    const blocks = []
    const buildBlock = async (scope, id, title) => {
      if (!id) return
      const sections = await this._read(scope, id, false)
      if (!sections) return

      // 每轮只注入“精简 Summary + 少量相关 Facts”，不全量塞入 Markdown，
      // 避免记忆文件变大后造成 token 长期膨胀。
      const summary = getSummaryLines(sections)
      const facts = this._parseMemories(sections, 'Facts')
        .filter(m => m.importance >= minImportance)
        .sort((a, b) => scoreMemory(b, query) - scoreMemory(a, query))
        .slice(0, relevantLimit)
        .map(m => m.content)
      const lines = [...new Set([...summary, ...facts].map(item => clip(item, 90)).filter(Boolean))]
      if (lines.length > 0) {
        blocks.push(`${title}:\n${lines.map(line => `- ${line}`).join('\n')}`)
      }
    }

    // 群聊 = 当前群记忆 + 当前用户记忆；私聊 = 当前用户记忆。
    // 因此同一用户在不同群会动态拼接不同的 group/<groupId>.md。
    if (e?.isGroup && groupId) {
      await buildBlock('group', groupId, '群长期记忆')
    }
    await buildBlock('user', userId, '当前用户长期记忆')

    if (!blocks.length) return ''
    const prompt = `【长期记忆摘要，仅供本轮参考】\n${blocks.join('\n')}\n使用原则：优先相信当前用户消息；记忆与当前消息或角色设定冲突时忽略记忆；不要主动提及“我记得/根据记忆/长期记忆”等来源；新的长期有效信息可用 save_memory 保存，保存前必须区分当前消息、引用消息、群聊历史和不同说话人，避免保存短期闲聊或错误归因。`
    return prompt.length > maxChars ? `${prompt.slice(0, maxChars)}\n[记忆摘要已截断]` : prompt
  }

  static async getMemoryStats(userId) {
    try {
      const memories = await this.getUserMemories(userId, 1000, 0)
      const stats = {
        total: memories.length,
        byType: {},
        avgImportance: 0,
        highImportance: 0
      }

      let totalImportance = 0
      memories.forEach(m => {
        stats.byType[m.memoryType] = (stats.byType[m.memoryType] || 0) + 1
        totalImportance += m.importance
        if (m.importance >= 7) stats.highImportance++
      })

      stats.avgImportance = memories.length > 0
        ? (totalImportance / memories.length).toFixed(2)
        : 0

      return stats
    } catch (err) {
      logger.error('[Memory] 获取记忆统计失败:', err)
      return null
    }
  }
}
