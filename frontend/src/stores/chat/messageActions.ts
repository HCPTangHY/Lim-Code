/**
 * Chat Store 消息操作
 * 
 * 包含消息发送、重试、编辑、删除等操作
 */

import type { Message, Attachment } from '../../types'
import type { ChatStoreState, ChatStoreComputed, AttachmentData } from './types'
import { sendToExtension } from '../../utils/vscode'
import { generateId } from '../../utils/format'
import { createAndPersistConversation } from './conversationActions'
import { clearCheckpointsFromIndex } from './checkpointActions'

/**
 * 取消流式的回调类型
 */
export type CancelStreamCallback = () => Promise<void>

/**
 * 发送消息
 */
export async function sendMessage(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  messageText: string,
  attachments?: Attachment[]
): Promise<void> {
  if (!messageText.trim() && (!attachments || attachments.length === 0)) return
  
  state.error.value = null
  if (state.isWaitingForResponse.value) return
  
  state.isLoading.value = true
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true
  
  try {
    if (!state.currentConversationId.value) {
      const newId = await createAndPersistConversation(state, messageText)
      if (!newId) {
        throw new Error('Failed to create conversation')
      }
    }
    
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: messageText,
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined
    }
    state.allMessages.value.push(userMessage)
    
    const assistantMessageId = generateId()
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
      metadata: {
        modelVersion: computed.currentModelName.value
      }
    }
    state.allMessages.value.push(assistantMessage)
    state.streamingMessageId.value = assistantMessageId
    
    const conv = state.conversations.value.find(c => c.id === state.currentConversationId.value)
    if (conv) {
      conv.updatedAt = Date.now()
      conv.messageCount = state.allMessages.value.length
      conv.preview = messageText.slice(0, 50)
    }
    
    state.toolCallBuffer.value = ''
    state.inToolCall.value = null
    
    const attachmentData: AttachmentData[] | undefined = attachments && attachments.length > 0
      ? attachments.map(att => ({
          id: att.id,
          name: att.name,
          type: att.type,
          size: att.size,
          mimeType: att.mimeType,
          data: att.data || '',
          thumbnail: att.thumbnail
        }))
      : undefined
    
    await sendToExtension('chatStream', {
      conversationId: state.currentConversationId.value,
      configId: state.configId.value,
      message: messageText,
      attachments: attachmentData
    })
    
  } catch (err: any) {
    if (state.isStreaming.value) {
      state.error.value = {
        code: err.code || 'SEND_ERROR',
        message: err.message || 'Failed to send message'
      }
      state.streamingMessageId.value = null
      state.isStreaming.value = false
      state.isWaitingForResponse.value = false
    }
  } finally {
    state.isLoading.value = false
  }
}

/**
 * 重试最后一条消息
 */
export async function retryLastMessage(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if (state.allMessages.value.length === 0) return
  let lastAssistantIndex = -1
  for (let i = state.allMessages.value.length - 1; i >= 0; i--) {
    if (state.allMessages.value[i].role === 'assistant') {
      lastAssistantIndex = i
      break
    }
  }
  if (lastAssistantIndex !== -1) {
    await retryFromMessage(state, computed, lastAssistantIndex, cancelStream)
  }
}

/**
 * 从指定消息重试
 */
export async function retryFromMessage(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  messageIndex: number,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if (!state.currentConversationId.value || state.allMessages.value.length === 0) return
  if (messageIndex < 0 || messageIndex >= state.allMessages.value.length) return
  
  if (state.isStreaming.value) {
    await cancelStream()
  }
  
  state.error.value = null
  state.isLoading.value = true
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true
  
  state.allMessages.value = state.allMessages.value.slice(0, messageIndex)
  clearCheckpointsFromIndex(state, messageIndex)
  
  try {
    await sendToExtension('deleteMessage', {
      conversationId: state.currentConversationId.value,
      targetIndex: messageIndex
    })
  } catch (err) {
    console.error('Failed to delete messages from backend:', err)
  }
  
  state.toolCallBuffer.value = ''
  state.inToolCall.value = null
  
  // 重置 diff 相关状态（防止上一轮对话的状态影响新请求）
  state.processedDiffTools.value = new Map()
  state.handledDiffIds.value = new Set()
  state.handledFilePaths.value = new Map()
  state.pendingDiffToolIds.value = []
  state.pendingAnnotation.value = ''
  
  const assistantMessageId = generateId()
  const assistantMessage: Message = {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    streaming: true,
    metadata: {
      modelVersion: computed.currentModelName.value
    }
  }
  state.allMessages.value.push(assistantMessage)
  state.streamingMessageId.value = assistantMessageId
  
  try {
    await sendToExtension('retryStream', {
      conversationId: state.currentConversationId.value,
      configId: state.configId.value
    })
  } catch (err: any) {
    if (state.isStreaming.value) {
      state.error.value = {
        code: err.code || 'RETRY_ERROR',
        message: err.message || 'Retry failed'
      }
      state.streamingMessageId.value = null
      state.isStreaming.value = false
      state.isWaitingForResponse.value = false
    }
  } finally {
    state.isLoading.value = false
  }
}

/**
 * 错误后重试
 */
export async function retryAfterError(
  state: ChatStoreState,
  computed: ChatStoreComputed
): Promise<void> {
  if (!state.currentConversationId.value) return
  if (state.isLoading.value || state.isStreaming.value) return
  
  state.error.value = null
  state.isLoading.value = true
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true
  
  state.toolCallBuffer.value = ''
  state.inToolCall.value = null
  
  const assistantMessageId = generateId()
  const assistantMessage: Message = {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    streaming: true,
    metadata: {
      modelVersion: computed.currentModelName.value
    }
  }
  state.allMessages.value.push(assistantMessage)
  state.streamingMessageId.value = assistantMessageId
  
  try {
    await sendToExtension('retryStream', {
      conversationId: state.currentConversationId.value,
      configId: state.configId.value
    })
  } catch (err: any) {
    if (state.isStreaming.value) {
      state.error.value = {
        code: err.code || 'RETRY_ERROR',
        message: err.message || 'Retry failed'
      }
      state.streamingMessageId.value = null
      state.isStreaming.value = false
      state.isWaitingForResponse.value = false
    }
  } finally {
    state.isLoading.value = false
  }
}

/**
 * 编辑并重发消息
 */
export async function editAndRetry(
  state: ChatStoreState,
  computed: ChatStoreComputed,
  messageIndex: number,
  newMessage: string,
  attachments: Attachment[] | undefined,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if ((!newMessage.trim() && (!attachments || attachments.length === 0)) || !state.currentConversationId.value) return
  if (messageIndex < 0 || messageIndex >= state.allMessages.value.length) return
  
  if (state.isStreaming.value) {
    await cancelStream()
  }
  
  state.error.value = null
  state.isLoading.value = true
  state.isStreaming.value = true
  state.isWaitingForResponse.value = true
  
  const targetMessage = state.allMessages.value[messageIndex]
  targetMessage.content = newMessage
  targetMessage.parts = [{ text: newMessage }]
  targetMessage.attachments = attachments && attachments.length > 0 ? attachments : undefined
  
  state.allMessages.value = state.allMessages.value.slice(0, messageIndex + 1)
  clearCheckpointsFromIndex(state, messageIndex)
  
  state.toolCallBuffer.value = ''
  state.inToolCall.value = null
  
  const assistantMessageId = generateId()
  const assistantMessage: Message = {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    streaming: true,
    metadata: {
      modelVersion: computed.currentModelName.value
    }
  }
  state.allMessages.value.push(assistantMessage)
  state.streamingMessageId.value = assistantMessageId
  
  const attachmentData: AttachmentData[] | undefined = attachments && attachments.length > 0
    ? attachments.map(att => ({
        id: att.id,
        name: att.name,
        type: att.type,
        size: att.size,
        mimeType: att.mimeType,
        data: att.data || '',
        thumbnail: att.thumbnail
      }))
    : undefined
  
  try {
    await sendToExtension('editAndRetryStream', {
      conversationId: state.currentConversationId.value,
      messageIndex,
      newMessage,
      attachments: attachmentData,
      configId: state.configId.value
    })
  } catch (err: any) {
    if (state.isStreaming.value) {
      state.error.value = {
        code: err.code || 'EDIT_RETRY_ERROR',
        message: err.message || 'Edit and retry failed'
      }
      state.streamingMessageId.value = null
      state.isStreaming.value = false
      state.isWaitingForResponse.value = false
    }
  } finally {
    state.isLoading.value = false
  }
}

/**
 * 删除消息
 */
export async function deleteMessage(
  state: ChatStoreState,
  targetIndex: number,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if (!state.currentConversationId.value) return
  if (targetIndex < 0 || targetIndex >= state.allMessages.value.length) return
  
  if (state.isStreaming.value) {
    await cancelStream()
  }
  
  try {
    const response = await sendToExtension<{ success: boolean; deletedCount: number }>('deleteMessage', {
      conversationId: state.currentConversationId.value,
      targetIndex
    })
    
    if (response.success) {
      state.allMessages.value = state.allMessages.value.slice(0, targetIndex)
      clearCheckpointsFromIndex(state, targetIndex)
    }
  } catch (err: any) {
    state.error.value = {
      code: err.code || 'DELETE_ERROR',
      message: err.message || 'Delete failed'
    }
  }
}

/**
 * 删除单条消息（不删除后续消息）
 */
export async function deleteSingleMessage(
  state: ChatStoreState,
  targetIndex: number,
  cancelStream: CancelStreamCallback
): Promise<void> {
  if (!state.currentConversationId.value) return
  if (targetIndex < 0 || targetIndex >= state.allMessages.value.length) return
  
  if (state.isStreaming.value) {
    await cancelStream()
  }
  
  try {
    const response = await sendToExtension<{ success: boolean }>('deleteSingleMessage', {
      conversationId: state.currentConversationId.value,
      targetIndex
    })
    
    if (response.success) {
      state.allMessages.value = [
        ...state.allMessages.value.slice(0, targetIndex),
        ...state.allMessages.value.slice(targetIndex + 1)
      ]
    }
  } catch (err: any) {
    state.error.value = {
      code: err.code || 'DELETE_ERROR',
      message: err.message || 'Delete failed'
    }
  }
}

/**
 * 清空当前对话的消息
 */
export function clearMessages(state: ChatStoreState): void {
  state.allMessages.value = []
  state.error.value = null
  state.streamingMessageId.value = null
  state.isWaitingForResponse.value = false
}
