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
    result[key] = value
    return ''
  })
  return result
}

function encodeMeta(memory) {
  const tags = Array.isArray(memory.tags) ? memory.tags.join(',') : ''
  return `<!-- id="${memory.id}" type="${memory.memoryType || 'event'}" importance="${memory.importance || 1}" timestamp="${memory.timestamp || Date.now()}" date="${memory.date || nowText()}" group="${memory.groupId || ''}" tags="${tags}" -->`
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
    groupId: meta.group || null,
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

  static _isDuplicateMemory(candidate, existingMemories = []) {
    if (!candidate || !candidate.content) return true
    const next = normalizeText(candidate.content)
    if (!next) return true
    return existingMemories.some(m => {
      if (!m || m.memoryType !== candidate.memoryType) return false
      const old = normalizeText(m.content)
      if (!old) return false
      return old === next || old.includes(next) || next.includes(old)
    })
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
    const archive = this._parseMemories(sections, 'Archive')

    // 整理阶段先把过时记忆挪到 Archive，把活跃记忆继续参与去重和排序。
    for (const memory of this._parseMemories(sections, 'Facts')) {
      if (shouldArchive(memory)) {
        archive.push(memory)
      } else {
        active.push(memory)
      }
    }

    // 同类型内容做包含式去重，避免“喜欢原神”和“用户偏好：喜欢原神”反复占位。
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

  // 自动提取规则使用轻量正则策略：
  // 普通聊天中出现“我叫/我喜欢/我讨厌/我最近很焦虑/请记住”等稳定信息时，
  // 会先生成候选记忆；真正写入前仍会经过去重、冷却和 Markdown compact。
  static _extractMemoriesFromUserMessage(text = '') {
    const source = String(text || '').trim()
    if (!source) return []
    if (source.startsWith('#')) return []
    if (source.length < 6 || source.length > 220) return []

    const pushUnique = (arr, item) => {
      if (!item || !item.content) return
      const key = `${item.memoryType}:${normalizeText(item.content)}`
      if (!arr.some(x => `${x.memoryType}:${normalizeText(x.content)}` === key)) {
        arr.push(item)
      }
    }

    const result = []
    let m

    m = source.match(/(?:我叫|我是|本人是|我现在是)([^，。！？\n]{1,24})/)
    if (m?.[1]) {
      pushUnique(result, {
        memoryType: 'user_profile',
        content: `用户自述身份：${m[1].trim()}`,
        importance: 6,
        tags: ['身份']
      })
    }

    m = source.match(/(?:我在|我住在|我来自|来自)([^，。！？\n]{1,24})/)
    if (m?.[1]) {
      pushUnique(result, {
        memoryType: 'user_profile',
        content: `用户所在地：${m[1].trim()}`,
        importance: 5,
        tags: ['地区']
      })
    }

    m = source.match(/(?:我喜欢|我最喜欢|我爱|我偏好)([^，。！？\n]{1,30})/)
    if (m?.[1]) {
      pushUnique(result, {
        memoryType: 'preference',
        content: `用户偏好：喜欢${m[1].trim()}`,
        importance: 5,
        tags: ['喜欢']
      })
    }

    m = source.match(/(?:我讨厌|我不喜欢)([^，。！？\n]{1,30})/)
    if (m?.[1]) {
      pushUnique(result, {
        memoryType: 'preference',
        content: `用户偏好：不喜欢${m[1].trim()}`,
        importance: 5,
        tags: ['不喜欢']
      })
    }

    m = source.match(/我(?:今天|现在|最近)?(?:真的|有点|挺|很|太)?(开心|高兴|兴奋|难过|伤心|生气|烦|焦虑|崩溃|抑郁|委屈|紧张)/)
    if (m?.[1]) {
      pushUnique(result, {
        memoryType: 'emotional_memory',
        content: `用户当前情绪：${m[1].trim()}`,
        importance: 6,
        tags: ['情绪']
      })
    }

    if (/(明天|后天|今晚|下周|周[一二三四五六日天]|\d{1,2}[点时分])/.test(source)
      && /(提醒|记得|要|约|安排|考试|面试|开会|上课|打卡|ddl|截止)/i.test(source)) {
      pushUnique(result, {
        memoryType: 'event',
        content: `用户提到待办/时间安排：${clip(source, 80)}`,
        importance: 7,
        tags: ['待办', '时间']
      })
    }

    if (/(请记住|记一下|记住这件事|别忘了)/.test(source)) {
      pushUnique(result, {
        memoryType: 'event',
        content: `用户要求记住：${clip(source, 80)}`,
        importance: 8,
        tags: ['用户要求']
      })
    }

    return result.slice(0, 2)
  }

  static async saveMemory(memory) {
    try {
      const scope = memory.scope === 'group' ? 'group' : 'user'
      const targetId = scope === 'group' ? memory.groupId : memory.userId
      if (!targetId) {
        return { success: false, message: '缺少记忆目标ID' }
      }

      return await withMemoryWriteLock(scope, targetId, async () => {
        const sections = await this._read(scope, targetId)
        const existing = this._parseMemories(sections, 'Facts')

        // 保存前去重，避免工具调用或自动规则把同一条长期记忆重复写入 Markdown。
        if (this._isDuplicateMemory(memory, existing)) {
          return { success: true, message: '记忆已存在，已跳过' }
        }

        const next = {
          ...memory,
          id: memory.id || `${Date.now()}${Math.random().toString(36).substring(2, 9)}`,
          timestamp: memory.timestamp || Date.now(),
          date: memory.date || nowText(),
          importance: Math.min(10, Math.max(1, Number(memory.importance || 1))),
          tags: Array.isArray(memory.tags) ? memory.tags : []
        }

        // 新记忆先进入 Facts，再统一 compact：生成 Summary、归档过时项、执行上限整理。
        sections.Facts = [renderMemoryLine(next), ...(sections.Facts || [])]
        await writeMemoryFile(scope, targetId, sections)
        await this._compact(scope, targetId)

        return {
          success: true,
          message: '记忆保存成功'
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

  static async autoExtractAndSaveFromMessage(e, text = '') {
    try {
      if (!Config.enableMemory) {
        return { success: false, saved: 0, reason: 'memory_disabled' }
      }
      const userId = e?.user_id || e?.sender?.user_id
      if (!userId) {
        return { success: false, saved: 0, reason: 'missing_user_id' }
      }

      const cooldownKey = `CHATGPT:MEMORY:AUTO_COOLDOWN:${userId}`
      const inCooldown = await redis.get(cooldownKey)
      if (inCooldown) {
        return { success: true, saved: 0, reason: 'cooldown' }
      }

      const candidates = this._extractMemoriesFromUserMessage(text)
      if (!candidates.length) {
        return { success: true, saved: 0, reason: 'no_candidate' }
      }

      // 自动规则只负责补充明显长期信息；更复杂的长期记忆由 save_memory 工具主动写入。
      // 冷却时间避免同一用户连续触发时把相近内容刷进 Markdown。
      const existingMemories = await this.getUserMemories(userId, 100, 1)
      let saved = 0

      for (const candidate of candidates) {
        if (this._isDuplicateMemory(candidate, existingMemories)) continue
        const memory = {
          timestamp: Date.now(),
          date: nowText(),
          userId,
          groupId: e?.group_id || null,
          isGroup: Boolean(e?.isGroup),
          userMsg: String(text || ''),
          userName: e?.sender?.card || e?.sender?.nickname || '未知',
          memoryType: candidate.memoryType,
          content: candidate.content,
          importance: candidate.importance,
          tags: Array.isArray(candidate.tags) ? candidate.tags : []
        }
        const saveRet = await this.saveMemory(memory)
        if (saveRet?.success && !saveRet.message?.includes('跳过')) {
          saved++
          existingMemories.unshift(memory)
        }
      }

      if (saved > 0) {
        await redis.set(cooldownKey, '1', { EX: 90 })
      }
      return { success: true, saved, reason: saved > 0 ? 'saved' : 'all_duplicate' }
    } catch (err) {
      logger.error('[Memory] 自动提取记忆失败:', err)
      return { success: false, saved: 0, reason: err.message || 'unknown_error' }
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
    const prompt = `【长期记忆摘要，仅供本轮参考】\n${blocks.join('\n')}\n使用原则：优先相信当前用户消息；记忆与当前消息或角色设定冲突时忽略记忆；不要主动提及“我记得/根据记忆/长期记忆”等来源；新的长期有效信息可用 save_memory 保存，避免保存短期闲聊。`
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
