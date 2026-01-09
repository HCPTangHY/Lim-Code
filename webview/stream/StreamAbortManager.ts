/**
 * 流式请求管理器
 * 
 * 管理流式请求的取消控制器
 */

import type * as vscode from 'vscode';

/**
 * 流式请求管理器
 */
export class StreamAbortManager {
  private controllers: Map<string, AbortController> = new Map();

  /**
   * 创建并存储新的 AbortController
   */
  create(conversationId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(conversationId, controller);
    return controller;
  }

  /**
   * 获取指定对话的 AbortController
   */
  get(conversationId: string): AbortController | undefined {
    return this.controllers.get(conversationId);
  }

  /**
   * 取消指定对话的流式请求
   */
  cancel(conversationId: string): boolean {
    const controller = this.controllers.get(conversationId);
    if (controller) {
      controller.abort();
      this.controllers.delete(conversationId);
      return true;
    }
    return false;
  }

  /**
   * 删除指定对话的 AbortController
   */
  delete(conversationId: string): void {
    this.controllers.delete(conversationId);
  }

  /**
   * 取消所有活跃的流式请求
   */
  cancelAll(view?: vscode.WebviewView): void {
    for (const [conversationId, controller] of this.controllers) {
      controller.abort();
      try {
        view?.webview.postMessage({
          type: 'streamChunk',
          data: {
            conversationId,
            type: 'cancelled'
          }
        });
      } catch {
        // 忽略发送失败
      }
    }
    this.controllers.clear();
  }

  /**
   * 获取活跃的流式请求数量
   */
  get size(): number {
    return this.controllers.size;
  }
}
