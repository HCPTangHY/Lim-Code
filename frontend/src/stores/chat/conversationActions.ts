/**
 * Chat Store 对话操作
 * 
 * 包含对话的 CRUD 操作
 */

import type { ChatStoreState, Conversation, CheckpointRecord } from './types'
import { sendToExtension } from '../../utils/vscode'
import { contentToMessageEnhanced } from './parsers'
import type { Content } from '../../types'

/**
 * 取消流式并拒绝工具的回调类型
 */
export type CancelStreamAndRejectToolsCallback = () => Promise<void>

/**
 * 创建新对话（仅清空消息，不创建对话记录）
 *
 * 如果当前有正在进行的请求，会先取消并将工具标记为拒绝
 */
export async function createNewConversation(
  state: ChatStoreState,
  cancelStreamAndRejectTools: CancelStreamAndRejectToolsCallback
): Promise<void> {
  // 如果有正在进行的请求，先取消并拒绝工具
  if (state.isWaitingForResponse.value || state.isStreaming.value) {
    await cancelStreamAndRejectTools()
  }
  
  state.currentConversationId.value = null
  state.allMessages.value = []  // 清空消息
  state.checkpoints.value = []  // 清空检查点
  state.error.value = null
  
  // 清除所有加载和流式状态
  state.isLoading.value = false
  state.isStreaming.value = false
  state.streamingMessageId.value = null
  state.isWaitingForResponse.value = false
}

/**
 * 创建并持久化新对话到后端
 */
export async function createAndPersistConversation(
  state: ChatStoreState,
  firstMessage: string
): Promise<string | null> {
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  
  // 使用第一句话的前30个字符作为标题
  const title = firstMessage.slice(0, 30) + (firstMessage.length > 30 ? '...' : '')
  
  try {
    // 创建对话时传递工作区 URI
    await sendToExtension('conversation.createConversation', {
      conversationId: id,
      title: title,
      workspaceUri: state.currentWorkspaceUri.value || undefined
    })
    
    // 添加到对话列表
    const newConversation: Conversation = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      isPersisted: true,
      workspaceUri: state.currentWorkspaceUri.value || undefined
    }
    
    state.conversations.value.unshift(newConversation)
    state.currentConversationId.value = id
    
    return id
  } catch (err) {
    console.error('Failed to create conversation:', err)
    return null
  }
}

/**
 * 加载对话列表
 *
 * 优化：只获取元信息，不加载具体消息内容
 * 消息内容在用户点击对话时才延迟加载
 */
export async function loadConversations(state: ChatStoreState): Promise<void> {
  state.isLoadingConversations.value = true
  
  try {
    const ids = await sendToExtension<string[]>('conversation.listConversations', {})
    
    const summaries: Conversation[] = []
    for (const id of ids) {
      try {
        // 只获取元信息，不获取消息内容
        const metadata = await sendToExtension<any>('conversation.getConversationMetadata', { conversationId: id })
        
        summaries.push({
          id,
          title: metadata?.title || `Chat ${id.slice(0, 8)}`,
          createdAt: metadata?.createdAt || Date.now(),
          updatedAt: metadata?.updatedAt || metadata?.custom?.updatedAt || Date.now(),
          // 消息数量从元信息获取（如果有），否则显示为 0，切换时再更新
          messageCount: metadata?.custom?.messageCount || 0,
          preview: metadata?.custom?.preview,
          isPersisted: true,  // 从后端加载的都是已持久化的
          workspaceUri: metadata?.workspaceUri
        })
      } catch {
        summaries.push({
          id,
          title: `Chat ${id.slice(0, 8)}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 0,
          isPersisted: true
        })
      }
    }
    
    // 保留未持久化的对话
    const unpersistedConvs = state.conversations.value.filter(c => !c.isPersisted)
    state.conversations.value = [...unpersistedConvs, ...summaries]
  } catch (err: any) {
    state.error.value = {
      code: err.code || 'LOAD_ERROR',
      message: err.message || 'Failed to load conversations'
    }
  } finally {
    state.isLoadingConversations.value = false
  }
}

/**
 * 加载历史消息
 *
 * 存储所有消息，包括 functionResponse 消息
 * 前端索引与后端索引一一对应
 */
export async function loadHistory(state: ChatStoreState): Promise<void> {
  if (!state.currentConversationId.value) return
  
  try {
    const history = await sendToExtension<Content[]>('conversation.getMessages', {
      conversationId: state.currentConversationId.value
    })
    
    // 转换所有消息，包括 functionResponse 消息
    state.allMessages.value = history.map(content =>
      contentToMessageEnhanced(content)
    )
  } catch (err: any) {
    state.error.value = {
      code: err.code || 'LOAD_ERROR',
      message: err.message || 'Failed to load history'
    }
  }
}

/**
 * 加载当前对话的检查点
 */
export async function loadCheckpoints(state: ChatStoreState): Promise<void> {
  if (!state.currentConversationId.value) {
    state.checkpoints.value = []
    return
  }
  
  try {
    const result = await sendToExtension<{ checkpoints: CheckpointRecord[] }>('checkpoint.getCheckpoints', {
      conversationId: state.currentConversationId.value
    })
    
    if (result?.checkpoints) {
      state.checkpoints.value = result.checkpoints
    } else {
      state.checkpoints.value = []
    }
  } catch (err) {
    console.error('Failed to load checkpoints:', err)
    state.checkpoints.value = []
  }
}

/**
 * 切换到指定对话
 *
 * 每次切换都会重新加载对话内容，确保数据最新
 * 如果当前有正在进行的请求，会先取消并将工具标记为拒绝
 */
export async function switchConversation(
  state: ChatStoreState,
  id: string,
  cancelStreamAndRejectTools: CancelStreamAndRejectToolsCallback
): Promise<void> {
  // 注意：即使是相同对话也允许重新加载（从历史记录进入时需要刷新）
  const conv = state.conversations.value.find(c => c.id === id)
  if (!conv) return
  
  // 如果有正在进行的请求，先取消并拒绝工具
  if (state.isWaitingForResponse.value || state.isStreaming.value) {
    await cancelStreamAndRejectTools()
  }
  
  // 清除状态
  state.currentConversationId.value = id
  state.allMessages.value = []
  state.checkpoints.value = []
  state.error.value = null
  state.isLoading.value = false
  state.isStreaming.value = false
  state.streamingMessageId.value = null
  state.isWaitingForResponse.value = false
  
  // 如果是已持久化的对话，从后端加载历史和检查点
  if (conv.isPersisted) {
    await loadHistory(state)
    await loadCheckpoints(state)
    
    // 更新对话的消息数量（在加载后才有准确数据）
    conv.messageCount = state.allMessages.value.length
  }
}

/**
 * 检查对话是否正在删除
 */
export function isDeletingConversation(state: ChatStoreState, id: string): boolean {
  return state.deletingConversationIds.value.has(id)
}

/**
 * 删除对话
 *
 * 使用锁机制防止快速连续删除时的竞态条件
 */
export async function deleteConversation(
  state: ChatStoreState,
  id: string,
  switchConversationFn: (id: string) => Promise<void>,
  createNewConversationFn: () => Promise<void>
): Promise<boolean> {
  const conv = state.conversations.value.find(c => c.id === id)
  if (!conv) return false
  
  // 如果正在删除，跳过
  if (state.deletingConversationIds.value.has(id)) {
    console.warn(`[chatStore] 对话 ${id} 正在删除中，跳过重复请求`)
    return false
  }
  
  // 标记为正在删除
  state.deletingConversationIds.value.add(id)
  
  try {
    // 如果是已持久化的，需要从后端删除
    if (conv.isPersisted) {
      await sendToExtension('conversation.deleteConversation', { conversationId: id })
    }
    
    // 后端删除成功后，再从前端移除
    state.conversations.value = state.conversations.value.filter(c => c.id !== id)
    
    // 如果删除的是当前对话，切换或创建新对话
    if (state.currentConversationId.value === id) {
      if (state.conversations.value.length > 0) {
        await switchConversationFn(state.conversations.value[0].id)
      } else {
        await createNewConversationFn()
      }
    }
    
    return true
  } catch (err: any) {
    state.error.value = {
      code: err.code || 'DELETE_ERROR',
      message: err.message || 'Failed to delete conversation'
    }
    return false
  } finally {
    // 无论成功失败，都移除删除锁
    state.deletingConversationIds.value.delete(id)
  }
}

/**
 * 流式完成后更新对话元数据
 */
export async function updateConversationAfterMessage(state: ChatStoreState): Promise<void> {
  if (!state.currentConversationId.value) return
  
  const conv = state.conversations.value.find(c => c.id === state.currentConversationId.value)
  if (!conv) return
  
  const now = Date.now()
  const messageCount = state.allMessages.value.length
  
  try {
    // 更新对话的updatedAt时间戳
    await sendToExtension('conversation.setCustomMetadata', {
      conversationId: state.currentConversationId.value,
      key: 'updatedAt',
      value: now
    })
    
    // 更新消息数量
    await sendToExtension('conversation.setCustomMetadata', {
      conversationId: state.currentConversationId.value,
      key: 'messageCount',
      value: messageCount
    })
    
    // 如果有消息，更新preview
    if (state.allMessages.value.length > 0) {
      const lastUserMsg = state.allMessages.value.filter(m => m.role === 'user' && !m.isFunctionResponse).pop()
      if (lastUserMsg) {
        await sendToExtension('conversation.setCustomMetadata', {
          conversationId: state.currentConversationId.value,
          key: 'preview',
          value: lastUserMsg.content.slice(0, 50)
        })
        conv.preview = lastUserMsg.content.slice(0, 50)
      }
    }
    
    conv.updatedAt = now
    conv.messageCount = messageCount
  } catch (err) {
    console.error('Failed to update conversation metadata:', err)
  }
}
