import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { makeForwardMsg, getUin } from '../utils/common.js'
import { UserMemory } from '../utils/userMemory.js'

export class memoryManage extends plugin {
  constructor(e) {
    super({
      name: 'ChatGPT-Plugin 记忆管理',
      dsc: 'AI记忆系统管理，查看、删除、清空用户记忆',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: '^#我的记忆$',
          fnc: 'myMemories'
        },
        {
          reg: '^#群记忆$',
          fnc: 'groupMemories'
        },
        {
          reg: '^#(他|她|TA|ta)的记忆',
          fnc: 'otherMemories',
          permission: 'master'
        },
        {
          reg: '^#清空(他|她|TA|ta)的记忆',
          fnc: 'clearOtherMemories',
          permission: 'master'
        },
        {
          reg: '^#清空我的记忆$',
          fnc: 'clearMyMemories',
          // permission: 'master'
        },
        {
          reg: '^#清空群记忆$',
          fnc: 'clearGroupMemories',
          permission: 'master'
        },
        {
          reg: '^#删除群记忆',
          fnc: 'deleteGroupMemory',
          permission: 'master'
        },
        {
          reg: '^#删除记忆',
          fnc: 'deleteMemory',
          permission: 'master'
        },
        {
          reg: '^#清空所有记忆$',
          fnc: 'clearAllMemories',
          permission: 'master'
        },
        {
          reg: '^#记忆统计',
          fnc: 'memoryStats',
          permission: 'master'
        },
        {
          reg: '^#记忆帮助$',
          fnc: 'memoryHelp',
          permission: 'master'
        }
      ]
    })
  }

  /**
   * 查看自己的记忆
   */
  async myMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }

    try {
      const memories = await UserMemory.getUserMemories(e.user_id, 100, 0)

      if (!memories || memories.length === 0) {
        await e.reply('你还没有任何记忆哦~', true)
        return
      }

      const memoryTypeNames = {
        user_profile: '📋用户画像',
        scene_memory: '🎬场景记忆',
        emotional_memory: '💭情感记忆',
        preference: '❤️偏好',
        event: '📅事件'
      }

      const messages = memories.map((m, index) => {
        const typeLabel = memoryTypeNames[m.memoryType] || m.memoryType
        let msg = `【记忆 ${index + 1}】\n`
        msg += `类型：${typeLabel}\n`
        msg += `内容：${m.content}\n`
        msg += `重要性：${'⭐'.repeat(Math.min(m.importance, 10))} (${m.importance}/10)\n`
        if (m.tags && m.tags.length > 0) {
          msg += `标签：${m.tags.join(', ')}\n`
        }
        msg += `时间：${m.date}\n`
        msg += `ID：${m.id}`
        return msg
      })

      await e.reply(await makeForwardMsg(e, messages, `我的记忆 (共${memories.length}条)`))
    } catch (err) {
      logger.error('[Memory] 获取记忆失败:', err)
      await e.reply('获取记忆失败', true)
    }
  }

  /**
   * 查看群内所有人的记忆（主人专用）
   */
  async groupMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }

    if (!e.isGroup) {
      await e.reply('此命令仅在群聊中可用', true)
      return
    }

    try {
      const groupMemories = await UserMemory.getGroupMemories(e.group_id, 100, 0)

      if (groupMemories.length === 0) {
        await e.reply('本群还没有任何记忆', true)
        return
      }

      const messages = groupMemories.map((m, index) => {
        let msg = `【群记忆 ${index + 1}】\n`
        msg += `类型：${m.memoryType}\n`
        msg += `内容：${m.content}\n`
        msg += `重要性：${'⭐'.repeat(Math.min(m.importance, 10))} (${m.importance}/10)\n`
        if (m.tags && m.tags.length > 0) {
          msg += `标签：${m.tags.join(', ')}\n`
        }
        msg += `时间：${m.date}\n`
        msg += `ID：${m.id}`
        return msg
      })

      await e.reply(await makeForwardMsg(e, messages, `群记忆 (共${groupMemories.length}条)`))
    } catch (err) {
      logger.error('[Memory] 获取群记忆失败:', err)
      await e.reply('获取群记忆失败', true)
    }
  }

  /**
   * 查看他人的记忆（主人专用）
   */
  async otherMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }

    // 提取用户ID
    let targetUserId = null

    // 从@中提取
    const atUsers = e.message.filter(m => m.type === 'at')
    if (atUsers.length > 0) {
      targetUserId = atUsers[0].qq
    } else {
      // 匹配任意非空白字符作为目标用户ID (兼容多平台适配器)
      const match = e.msg.match(/^#(?:他|她|TA|ta)的记忆\s+(\S+)/i)
      if (match) {
        targetUserId = match[1]
      }
    }

    if (!targetUserId) {
      await e.reply('请@某人或输入用户ID，例如：#他的记忆 user_123', true)
      return
    }

    try {
      const memories = await UserMemory.getUserMemories(targetUserId, 100, 0)

      if (!memories || memories.length === 0) {
        await e.reply(`用户 ${targetUserId} 还没有任何记忆`, true)
        return
      }

      const memoryTypeNames = {
        user_profile: '📋用户画像',
        scene_memory: '🎬场景记忆',
        emotional_memory: '💭情感记忆',
        preference: '❤️偏好',
        event: '📅事件'
      }

      const messages = memories.map((m, index) => {
        const typeLabel = memoryTypeNames[m.memoryType] || m.memoryType
        let msg = `【记忆 ${index + 1}】\n`
        msg += `类型：${typeLabel}\n`
        msg += `内容：${m.content}\n`
        msg += `重要性：${'⭐'.repeat(Math.min(m.importance, 10))} (${m.importance}/10)\n`
        if (m.tags && m.tags.length > 0) {
          msg += `标签：${m.tags.join(', ')}\n`
        }
        msg += `群聊：${m.isGroup ? `是 (${m.groupId})` : '否'}\n`
        msg += `时间：${m.date}\n`
        msg += `ID：${m.id}`
        return msg
      })

      const userName = memories[0].userName || targetUserId
      await e.reply(await makeForwardMsg(e, messages, `${userName}的记忆 (共${memories.length}条)`))
    } catch (err) {
      logger.error('[Memory] 获取用户记忆失败:', err)
      await e.reply('获取记忆失败', true)
    }
  }

  /**
   * 清空他人的记忆（主人专用）
   */
  async clearOtherMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }

    // 提取用户ID
    let targetUserId = null

    const atUsers = e.message.filter(m => m.type === 'at')
    if (atUsers.length > 0) {
      targetUserId = atUsers[0].qq
    } else {
      // 匹配任意非空白字符作为目标用户ID (兼容多平台适配器)
      const match = e.msg.match(/^#清空(?:他|她|TA|ta)的记忆\s+(\S+)/i)
      if (match) {
        targetUserId = match[1]
      }
    }

    if (!targetUserId) {
      await e.reply('请@某人或输入用户ID，例如：#清空他的记忆 user_123', true)
      return
    }

    try {
      const memories = await UserMemory.getUserMemories(targetUserId, 1, 0)
      if (!memories || memories.length === 0) {
        await e.reply(`用户 ${targetUserId} 没有记忆，无需清空`, true)
        return
      }

      await e.reply(`确定要清空用户 ${targetUserId} 的所有记忆吗？\n回复"是"确认，回复其他内容取消`, true)

      const e_new = await this.awaitContext()

      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await e.reply('操作已取消', true)
        return
      }

      const success = await UserMemory.clearUserMemories(targetUserId)

      if (success) {
        await e.reply(`已成功清空用户 ${targetUserId} 的所有记忆`, true)
        logger.info(`[Memory] 主人 ${e.user_id} 清空了用户 ${targetUserId} 的记忆`)
      } else {
        await e.reply('清空记忆失败', true)
      }
    } catch (err) {
      logger.error('[Memory] 清空记忆失败:', err)
      await e.reply('清空记忆失败', true)
    }
  }

  /**
   * 清空自己的记忆
   */
  async clearMyMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }

    try {
      const memories = await UserMemory.getUserMemories(e.user_id, 1, 0)
      if (!memories || memories.length === 0) {
        await e.reply('你还没有记忆，无需清空', true)
        return
      }

      await e.reply('确定要清空你的所有记忆吗？此操作不可恢复！\n回复"是"确认，回复其他内容取消', true)

      const e_new = await this.awaitContext()

      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await e.reply('操作已取消', true)
        return
      }

      const success = await UserMemory.clearUserMemories(e.user_id)

      if (success) {
        await e.reply('已成功清空你的所有记忆', true)
        logger.info(`[Memory] 用户 ${e.user_id} 清空了自己的记忆`)
      } else {
        await e.reply('清空记忆失败', true)
      }
    } catch (err) {
      logger.error('[Memory] 清空记忆失败:', err)
      await e.reply('清空记忆失败', true)
    }
  }

  /**
   * 清空当前群的群记忆（主人专用）
   */
  async clearGroupMemories(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }

    if (!e.isGroup) {
      await e.reply('此命令仅在群聊中可用', true)
      return
    }

    try {
      const memories = await UserMemory.getGroupMemories(e.group_id, 1, 0)
      if (!memories || memories.length === 0) {
        await e.reply('本群没有群记忆，无需清空', true)
        return
      }

      await e.reply('确定要清空本群的所有群记忆吗？此操作不可恢复！\n回复"是"确认，回复其他内容取消', true)

      const e_new = await this.awaitContext()

      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await e.reply('操作已取消', true)
        return
      }

      const success = await UserMemory.clearGroupMemories(e.group_id)

      if (success) {
        await e.reply('已成功清空本群的群记忆', true)
        logger.info(`[Memory] 主人 ${e.user_id} 清空了群 ${e.group_id} 的群记忆`)
      } else {
        await e.reply('清空群记忆失败', true)
      }
    } catch (err) {
      logger.error('[Memory] 清空群记忆失败:', err)
      await e.reply('清空群记忆失败', true)
    }
  }

  /**
   * 删除当前群指定群记忆（主人专用）
   */
  async deleteGroupMemory(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }

    if (!e.isGroup) {
      await e.reply('此命令仅在群聊中可用', true)
      return
    }

    const match = e.msg.match(/#删除群记忆\s+[#\s]*([a-zA-Z0-9_\-]+)/i)
    if (!match) {
      await e.reply('格式错误！\n用法1: #删除群记忆 序号\n用法2: #删除群记忆 记忆ID', true)
      return
    }

    const memoryIdentifier = match[1]

    try {
      const memories = await UserMemory.getGroupMemories(e.group_id, 100, 0)

      if (!memories || memories.length === 0) {
        await e.reply('本群没有群记忆', true)
        return
      }

      let memoryToDelete = null

      if (/^\d{1,4}$/.test(memoryIdentifier)) {
        const index = parseInt(memoryIdentifier) - 1
        if (index < 0 || index >= memories.length) {
          await e.reply(`序号超出范围，本群共有 ${memories.length} 条群记忆`, true)
          return
        }
        memoryToDelete = memories[index]
      } else {
        memoryToDelete = memories.find(m => m.id === memoryIdentifier)
        if (!memoryToDelete) {
          await e.reply('未找到该群记忆ID', true)
          return
        }
      }

      await e.reply(`确定要删除以下群记忆吗？\n类型：${memoryToDelete.memoryType}\n内容：${memoryToDelete.content}\n\n回复"是"确认，回复其他内容取消`, true)

      const e_new = await this.awaitContext()

      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await e.reply('操作已取消', true)
        return
      }

      const success = await UserMemory.deleteMemory(e.group_id, memoryToDelete.id, 'group')

      if (success) {
        await e.reply('群记忆已删除', true)
        logger.info(`[Memory] 主人 ${e.user_id} 删除了群 ${e.group_id} 的群记忆: ${memoryToDelete.id}`)
      } else {
        await e.reply('删除群记忆失败', true)
      }
    } catch (err) {
      logger.error('[Memory] 删除群记忆失败:', err)
      await e.reply('删除群记忆失败', true)
    }
  }

  /**
   * 删除指定记忆（主人专用）
   */
  async deleteMemory(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }

    // 修复正则：第一个 \S+ 匹配任意用户ID(包含英文字符等)，第二个匹配序号或记忆ID
    const match = e.msg.match(/#删除记忆\s+(\S+)\s+[#\s]*([a-zA-Z0-9_\-]+)/i)

    if (!match) {
      await e.reply('格式错误！\n用法1: #删除记忆 用户ID 序号 (例如：#删除记忆 user_123 3)\n用法2: #删除记忆 用户ID 记忆ID', true)
      return
    }

    const targetUserId = match[1]
    const memoryIdentifier = match[2]

    try {
      const memories = await UserMemory.getUserMemories(targetUserId, 100, 0)

      if (!memories || memories.length === 0) {
        await e.reply(`用户 ${targetUserId} 没有记忆`, true)
        return
      }

      let memoryToDelete = null

      // 判断是序号还是ID (纯数字且长度较短判定为序号)
      if (/^\d{1,4}$/.test(memoryIdentifier)) {
        // 序号
        const index = parseInt(memoryIdentifier) - 1
        if (index < 0 || index >= memories.length) {
          await e.reply(`序号超出范围，该用户共有 ${memories.length} 条记忆`, true)
          return
        }
        memoryToDelete = memories[index]
      } else {
        // ID
        memoryToDelete = memories.find(m => m.id === memoryIdentifier)
        if (!memoryToDelete) {
          await e.reply('未找到该记忆ID', true)
          return
        }
      }

      await e.reply(`确定要删除以下记忆吗？\n类型：${memoryToDelete.memoryType}\n内容：${memoryToDelete.content}\n\n回复"是"确认，回复其他内容取消`, true)

      const e_new = await this.awaitContext()

      if (!e_new.msg || !(/^(是|y|yes|确定|确认)$/i).test(e_new.msg.trim())) {
        await e.reply('操作已取消', true)
        return
      }

      const success = await UserMemory.deleteMemory(targetUserId, memoryToDelete.id)

      if (success) {
        await e.reply('记忆已删除', true)
        logger.info(`[Memory] 主人 ${e.user_id} 删除了用户 ${targetUserId} 的记忆: ${memoryToDelete.id}`)
      } else {
        await e.reply('删除记忆失败', true)
      }
    } catch (err) {
      logger.error('[Memory] 删除记忆失败:', err)
      await e.reply('删除记忆失败', true)
    }
  }

  /**
   * 清空所有用户的记忆（主人专用）
   */
  async clearAllMemories(e) {
    // if (!Config.enableMemory) {
    //   await e.reply('记忆系统未启用', true)
    //   return
    // }

    try {
      const allMemories = await UserMemory.getAllMemories()

      if (allMemories.length === 0) {
        await e.reply('当前没有任何记忆', true)
        return
      }

      // 统计用户数量
      const userIds = new Set(allMemories.filter(m => m.scope === 'user').map(m => m.userId))
      const groupIds = new Set(allMemories.filter(m => m.scope === 'group').map(m => m.groupId))
      const totalUsers = userIds.size
      const totalGroups = groupIds.size
      const totalMemories = allMemories.length

      await e.reply(
        `⚠️ 警告：此操作将清空所有用户的记忆！\n\n` +
        `总用户数：${totalUsers} 人\n` +
        `总群数：${totalGroups} 个\n` +
        `总记忆数：${totalMemories} 条\n\n` +
        `此操作不可恢复！确定要继续吗？\n` +
        `回复"确定清空所有记忆"以确认，回复其他内容取消`,
        true
      )

      const e_new = await this.awaitContext()

      if (!e_new.msg || e_new.msg.trim() !== '确定清空所有记忆') {
        await e.reply('操作已取消', true)
        return
      }

      await UserMemory.clearAllMemories()

      await e.reply(
        `✅ 已成功清空所有记忆\n\n` +
        `清空用户数：${totalUsers} 人\n` +
        `清空群数：${totalGroups} 个\n` +
        `清空记忆数：${totalMemories} 条`,
        true
      )
      logger.warn(`[Memory] 主人 ${e.user_id} 清空了所有记忆 (${totalUsers}人, ${totalGroups}群, ${totalMemories}条)`)
    } catch (err) {
      logger.error('[Memory] 清空所有记忆失败:', err)
      await e.reply('清空所有记忆失败', true)
    }
  }

  /**
   * 记忆统计（主人专用）
   */
  async memoryStats(e) {
    if (!Config.enableMemory) {
      await e.reply('记忆系统未启用', true)
      return
    }

    // 提取用户ID
    let targetUserId = e.user_id

    const atUsers = e.message.filter(m => m.type === 'at')
    if (atUsers.length > 0) {
      targetUserId = atUsers[0].qq
    } else {
      // 兼容多平台字符串ID提取
      const match = e.msg.match(/^#记忆统计\s+(\S+)/i)
      if (match) {
        targetUserId = match[1]
      }
    }

    try {
      const stats = await UserMemory.getMemoryStats(targetUserId)

      if (!stats) {
        await e.reply('获取统计信息失败', true)
        return
      }

      const memoryTypeNames = {
        user_profile: '用户画像',
        scene_memory: '场景记忆',
        emotional_memory: '情感记忆',
        preference: '偏好',
        event: '事件'
      }

      let msg = `📊 记忆统计 (用户 ${targetUserId})\n\n`
      msg += `总记忆数：${stats.total} 条\n`
      msg += `高重要性记忆：${stats.highImportance} 条 (≥7分)\n`
      msg += `平均重要性：${stats.avgImportance}/10\n\n`
      msg += `分类统计：\n`

      for (const [type, count] of Object.entries(stats.byType)) {
        const typeName = memoryTypeNames[type] || type
        msg += `  ${typeName}：${count} 条\n`
      }

      msg += `\n配置信息：\n`
      msg += `  单用户上限：${Config.maxMemoriesPerUser} 条\n`
      msg += `  单群上限：${Config.maxMemoriesPerGroup} 条\n`
      msg += `  对话最低重要性：${Config.memoryMinImportance}/10\n`
      msg += `  摘要条数上限：${Config.memorySummaryLimit} 条\n`
      msg += `  相关记忆补充：${Config.memoryRelevantFactsLimit} 条\n`
      msg += `  记忆上下文上限：${Config.memoryPromptMaxChars} 字符`

      await e.reply(msg, true)
    } catch (err) {
      logger.error('[Memory] 获取统计失败:', err)
      await e.reply('获取统计信息失败', true)
    }
  }

  /**
   * 记忆帮助
   */
  async memoryHelp(e) {
    const helpMsg = `📚 记忆系统帮助\n\n` +
      `【查看记忆】\n` +
      `#我的记忆 - 查看自己的记忆\n` +
      `#他的记忆 @某人 - 查看某人的记忆(主人)\n` +
      `#他的记忆 123456 - 通过用户ID查看(主人)\n` +
      `#群记忆 - 查看当前群的记忆统计\n\n` +
      `【删除记忆】\n` +
      `#清空所有记忆 - 清空所有用户的记忆(主人)\n` +
      `#清空我的记忆 - 清空自己的所有记忆\n` +
      `#清空群记忆 - 清空当前群的群记忆(主人)\n` +
      `#清空他的记忆 @某人 - 清空某人的记忆(主人)\n` +
      `#删除记忆 用户ID 序号 - 删除指定记忆(主人)\n` +
      `#删除群记忆 序号 - 删除当前群指定群记忆(主人)\n` +
      `例如：#删除记忆 user_123 3\n\n` +
      `【统计信息】\n` +
      `#记忆统计 - 查看自己的记忆统计\n` +
      `#记忆统计 @某人 - 查看某人的统计(主人)\n\n` +
      `记忆类型：\n` +
      `📋用户画像 - 性格、职业、兴趣等\n` +
      `🎬场景记忆 - 重要对话场景\n` +
      `💭情感记忆 - 情绪状态、倾向\n` +
      `❤️偏好 - 喜好、习惯\n` +
      `📅事件 - 重要事件、约定`

    await e.reply(helpMsg, true)
  }
}
