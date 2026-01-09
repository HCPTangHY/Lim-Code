/**
 * 聊天功能消息处理器
 * 
 * 处理删除消息等非流式操作
 */

import { t } from '../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * 删除消息（删除到指定位置）
 */
export const deleteMessage: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, targetIndex } = data;
  const result = await ctx.chatHandler.handleDeleteToMessage({
    conversationId,
    targetIndex
  });
  ctx.sendResponse(requestId, result);
};

/**
 * 删除单条消息
 */
export const deleteSingleMessage: MessageHandler = async (data, requestId, ctx) => {
  const { conversationId, targetIndex } = data;
  try {
    await ctx.conversationManager.deleteMessage(conversationId, targetIndex);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_SINGLE_MESSAGE_ERROR', error.message || t('webview.errors.deleteMessageFailed'));
  }
};

/**
 * 注册聊天处理器
 */
export function registerChatHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('deleteMessage', deleteMessage);
  registry.set('deleteSingleMessage', deleteSingleMessage);
}
