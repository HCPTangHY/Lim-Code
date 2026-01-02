/**
 * 抠图工具 - 移除图片背景
 *
 * 支持多种引擎：
 * 1. transformers (本地 RMBG-1.4) - 推荐，本地运行，无需 API
 * 2. gemini - 使用生图模型生成遮罩（备选）
 *
 * 支持单张和批量两种模式
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { Tool, ToolResult, MultimodalData, ToolContext } from '../types';
import { resolveUri, getAllWorkspaces, calculateAspectRatio } from '../utils';
import { TaskManager, type TaskEvent } from '../taskManager';
import { getSharp } from '../../modules/dependencies';
import {
    createRemovalEngine,
    getDefaultEngineType,
    type RemovalEngineType,
    type RemovalEngineConfig
} from './engines';

/** 抠图任务类型常量 */
const TASK_TYPE_REMOVE_BG = 'remove_background';

/**
 * 抠图输出事件类型
 */
export interface RemoveBgOutputEvent {
    toolId: string;
    type: 'start' | 'progress' | 'complete' | 'cancelled' | 'error';
    data?: {
        message?: string;
        step?: 'reading' | 'processing' | 'saving';
        currentTask?: number;
        totalTasks?: number;
    };
    error?: string;
}

/**
 * 订阅抠图输出
 */
export function onRemoveBgOutput(listener: (event: RemoveBgOutputEvent) => void): () => void {
    return TaskManager.onTaskEventByType(TASK_TYPE_REMOVE_BG, (taskEvent: TaskEvent) => {
        const event: RemoveBgOutputEvent = {
            toolId: taskEvent.taskId,
            type: taskEvent.type as RemoveBgOutputEvent['type'],
            data: taskEvent.data as RemoveBgOutputEvent['data'],
            error: taskEvent.error
        };
        listener(event);
    });
}

/**
 * 取消抠图任务
 */
export function cancelRemoveBackground(toolId: string): { success: boolean; error?: string } {
    return TaskManager.cancelTask(toolId);
}

/**
 * 抠图工具配置
 */
interface RemoveBackgroundConfig {
    /** 引擎类型 */
    engine?: RemovalEngineType;
    /** API Key（用于远程 API） */
    apiKey?: string;
    /** API URL */
    url?: string;
    /** 模型名称 */
    model?: string;
    /** 代理 URL */
    proxyUrl?: string;
    /** 最大批量任务数 */
    maxBatchTasks?: number;
    /** 是否将图片返回给 AI */
    returnImageToAI?: boolean;
}

/**
 * 单个抠图任务
 */
interface RemoveTask {
    /** 原始图片路径 */
    image_path: string;
    /** 输出文件路径 */
    output_path: string;
    /** 主体描述（用于 Gemini 引擎） */
    subject_description?: string;
    /** 遮罩图保存路径（仅 Gemini 引擎支持） */
    mask_path?: string;
}

/**
 * 单个任务的结果
 */
interface TaskResult {
    index: number;
    success: boolean;
    error?: string;
    outputPath?: string;
    maskPath?: string;
    dimensions?: { width: number; height: number; aspectRatio: string };
    multimodal?: MultimodalData[];
    cancelled?: boolean;
}

/**
 * 读取图片文件
 */
async function readImageFile(imagePath: string): Promise<Buffer | null> {
    const uri = resolveUri(imagePath);
    if (!uri) {
        return null;
    }

    try {
        const content = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(content);
    } catch {
        return null;
    }
}

/**
 * 获取图片尺寸
 */
async function getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number } | null> {
    try {
        const sharp = await getSharp();
        if (sharp) {
            const metadata = await sharp(buffer).metadata();
            if (metadata.width && metadata.height) {
                return { width: metadata.width, height: metadata.height };
            }
        }
    } catch {
        // sharp 不可用，尝试手动解析
    }
    
    // 手动解析 PNG 头部
    if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        if (width > 0 && height > 0) {
            return { width, height };
        }
    }
    
    return null;
}

/**
 * 执行单个抠图任务
 */
async function executeRemoveTask(
    task: RemoveTask,
    index: number,
    config: RemoveBackgroundConfig,
    abortSignal?: AbortSignal
): Promise<TaskResult> {
    const { image_path, output_path, subject_description, mask_path } = task;

    // 验证参数
    if (!image_path) {
        return { index, success: false, error: `Task ${index + 1}: image_path is required` };
    }

    if (!output_path) {
        return { index, success: false, error: `Task ${index + 1}: output_path is required` };
    }

    try {
        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled`, cancelled: true };
        }

        // 1. 读取原图
        const imageBuffer = await readImageFile(image_path);
        if (!imageBuffer) {
            return { index, success: false, error: `Task ${index + 1}: Cannot read image: ${image_path}` };
        }

        // 获取图片尺寸
        const rawDimensions = await getImageDimensions(imageBuffer);
        const dimensions = rawDimensions ? {
            width: rawDimensions.width,
            height: rawDimensions.height,
            aspectRatio: calculateAspectRatio(rawDimensions.width, rawDimensions.height)
        } : undefined;

        // 检查是否已取消
        if (abortSignal?.aborted) {
            return { index, success: false, error: `Task ${index + 1}: User cancelled`, cancelled: true };
        }

        // 2. 选择引擎并执行抠图
        const engineType = config.engine || await getDefaultEngineType();
        const engine = createRemovalEngine(engineType);
        
        // 构建引擎配置
        const engineConfig: RemovalEngineConfig = {
            type: engineType,
            apiKey: config.apiKey,
            apiUrl: config.url,
            proxyUrl: config.proxyUrl,
            model: config.model,
            subjectDescription: subject_description,
            returnMask: !!mask_path  // 如果有 mask_path 则返回遮罩
        };
        
        const result = await engine.removeBackground(imageBuffer, engineConfig, abortSignal);
        
        if (!result.success) {
            return { index, success: false, error: `Task ${index + 1}: ${result.error}` };
        }

        // 3. 保存结果
        const outputUri = resolveUri(output_path);
        if (!outputUri) {
            return { index, success: false, error: `Task ${index + 1}: Cannot resolve output path` };
        }

        // 创建目录
        const dirUri = vscode.Uri.joinPath(outputUri, '..');
        try {
            await vscode.workspace.fs.createDirectory(dirUri);
        } catch {
            // 目录可能已存在
        }

        await vscode.workspace.fs.writeFile(outputUri, result.imageBuffer!);

        // 收集多模态数据
        const multimodal: MultimodalData[] = [];
        multimodal.push({
            mimeType: 'image/png',
            data: result.imageBuffer!.toString('base64'),
            name: path.basename(output_path)
        });

        // 4. 保存遮罩图（如果有）
        let savedMaskPath: string | undefined;
        if (mask_path && result.maskBuffer) {
            const maskUri = resolveUri(mask_path);
            if (maskUri) {
                const maskDirUri = vscode.Uri.joinPath(maskUri, '..');
                try {
                    await vscode.workspace.fs.createDirectory(maskDirUri);
                } catch {
                    // 目录可能已存在
                }
                await vscode.workspace.fs.writeFile(maskUri, result.maskBuffer);
                savedMaskPath = mask_path;
                
                multimodal.push({
                    mimeType: 'image/png',
                    data: result.maskBuffer.toString('base64'),
                    name: path.basename(mask_path)
                });
            }
        }

        return {
            index,
            success: true,
            outputPath: output_path,
            maskPath: savedMaskPath,
            dimensions,
            multimodal
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorName = error instanceof Error ? error.name : '';
        
        const isCancelled = abortSignal?.aborted ||
            errorName === 'AbortError' ||
            errorMessage.includes('aborted') ||
            errorMessage.includes('cancelled');
        
        return {
            index,
            success: false,
            error: isCancelled
                ? `Task ${index + 1}: User cancelled`
                : `Task ${index + 1}: ${errorMessage}`,
            cancelled: isCancelled
        };
    }
}

/**
 * 创建抠图工具（支持动态配置）
 *
 * @param maxBatchTasks 单次调用允许的最大任务数
 */
export function createRemoveBackgroundTool(maxBatchTasks: number = 5): Tool {
    const workspaces = getAllWorkspaces();
    const isMultiRoot = workspaces.length > 1;

    let description = `Remove background from images, generating transparent PNG. Supports single and batch modes.

**Engines** (choose via 'engine' parameter):
- "gemini": Uses Gemini API, better quality, requires API key
- "transformers": Local RMBG-1.4 model, offline, ~180MB download on first use

**Limits**:
- Maximum ${maxBatchTasks} background removal tasks per call

**Single Mode**: Use image_path + output_path parameters
**Batch Mode**: Use images array parameter (max ${maxBatchTasks} tasks)

**Use cases**:
- Product image background removal
- Portrait cutout
- Object extraction
- Creative composite material preparation`;

    if (isMultiRoot) {
        description += `\n\n**Multi-root Workspace**: Use "workspace_name/path" format. Available: ${workspaces.map(w => w.name).join(', ')}`;
    }

    return {
        declaration: {
            name: 'remove_background',
            description,
            category: 'media',
            dependencies: ['@huggingface/transformers', 'sharp'],  // 本地 RMBG-1.4 模型依赖
            parameters: {
                type: 'object',
                properties: {
                    // 批量模式参数
                    images: {
                        type: 'array',
                        description: 'Batch mode: Array of tasks. MUST be an array even for single task.',
                        items: {
                            type: 'object',
                            properties: {
                                image_path: {
                                    type: 'string',
                                    description: 'Source image path (required)'
                                },
                                output_path: {
                                    type: 'string',
                                    description: 'Output file path (required). Use .png extension.'
                                },
                                subject_description: {
                                    type: 'string',
                                    description: 'Subject description (optional, for Gemini engine)'
                                },
                                mask_path: {
                                    type: 'string',
                                    description: 'Mask save path (optional, only Gemini engine)'
                                }
                            },
                            required: ['image_path', 'output_path']
                        }
                    },
                    // 单张模式参数
                    image_path: {
                        type: 'string',
                        description: isMultiRoot
                            ? 'Single mode: Source image path. Use "workspace_name/path" format.'
                            : 'Single mode: Source image path relative to workspace.'
                    },
                    output_path: {
                        type: 'string',
                        description: isMultiRoot
                            ? 'Single mode: Output file path (.png). Use "workspace_name/path" format.'
                            : 'Single mode: Output file path (.png).'
                    },
                    subject_description: {
                        type: 'string',
                        description: 'Subject description (optional, for Gemini engine)'
                    },
                    mask_path: {
                        type: 'string',
                        description: 'Mask save path (optional)'
                    },
                    engine: {
                        type: 'string',
                        enum: ['gemini', 'transformers'],
                        description: 'Engine choice: "gemini" (API, better quality) or "transformers" (local, offline)'
                    }
                }
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const config = (context?.config || {}) as RemoveBackgroundConfig;
            const toolId = context?.toolId || TaskManager.generateTaskId('rmbg');

            const abortController = new AbortController();
            const abortSignal = abortController.signal;

            if (context?.abortSignal) {
                context.abortSignal.addEventListener('abort', () => {
                    abortController.abort();
                });
            }

            // 检查使用哪种模式
            const imagesArray = args.images as RemoveTask[] | undefined;
            const singleImagePath = args.image_path as string | undefined;
            const singleOutputPath = args.output_path as string | undefined;

            let tasks: RemoveTask[] = [];

            // 如果 AI 指定了引擎，使用指定的引擎
            if (args.engine) {
                config.engine = args.engine as RemovalEngineType;
            }

            if (imagesArray && Array.isArray(imagesArray) && imagesArray.length > 0) {
                tasks = imagesArray;
            } else if (singleImagePath && singleOutputPath) {
                tasks = [{
                    image_path: singleImagePath,
                    output_path: singleOutputPath,
                    subject_description: args.subject_description as string | undefined,
                    mask_path: args.mask_path as string | undefined
                }];
            } else {
                return {
                    success: false,
                    error: 'Please provide either:\n1. Single mode: image_path and output_path\n2. Batch mode: images array'
                };
            }

            // 验证任务数量
            const configMaxBatchTasks = config.maxBatchTasks || maxBatchTasks;

            if (tasks.length === 0) {
                return { success: false, error: 'No valid tasks' };
            }

            if (tasks.length > configMaxBatchTasks) {
                return { success: false, error: `Maximum ${configMaxBatchTasks} tasks per call (current: ${tasks.length})` };
            }

            // 注册任务
            TaskManager.registerTask(toolId, TASK_TYPE_REMOVE_BG, abortController, {
                totalTasks: tasks.length
            });

            try {
                // 获取引擎信息
                const engineType = config.engine || await getDefaultEngineType();
                const engine = createRemovalEngine(engineType);
                
                // 并发执行所有任务
                const results = await Promise.all(
                    tasks.map((task, index) => executeRemoveTask(task, index, config, abortSignal))
                );

                // 统计结果
                const successResults = results.filter(r => r.success);
                const failedResults = results.filter(r => !r.success && !r.cancelled);
                const cancelledResults = results.filter(r => r.cancelled);

                // 任务完成
                TaskManager.unregisterTask(toolId, 'completed', {
                    totalTasks: tasks.length,
                    successCount: successResults.length
                });

                // 如果所有任务都被取消
                if (cancelledResults.length === results.length) {
                    return {
                        success: false,
                        error: 'User cancelled the operation.',
                        cancelled: true
                    };
                }

                // 收集结果
                const allMultimodal: MultimodalData[] = [];
                const allPaths: string[] = [];
                const maskPaths: string[] = [];

                for (const result of successResults) {
                    if (result.multimodal) {
                        allMultimodal.push(...result.multimodal);
                    }
                    if (result.outputPath) {
                        allPaths.push(result.outputPath);
                    }
                    if (result.maskPath) {
                        maskPaths.push(result.maskPath);
                    }
                }

                // 生成报告
                const isBatch = tasks.length > 1;
                let message: string;

                if (failedResults.length === 0 && cancelledResults.length === 0) {
                    if (isBatch) {
                        message = `✅ Batch completed: ${successResults.length}/${tasks.length} succeeded (Engine: ${engine.name})\n\nSaved to:\n${allPaths.map(p => `• ${p}`).join('\n')}`;
                    } else {
                        const r = successResults[0];
                        const dimInfo = r.dimensions
                            ? `\nDimensions: ${r.dimensions.width}×${r.dimensions.height} (${r.dimensions.aspectRatio})`
                            : '';
                        message = `✅ Background removed! (Engine: ${engine.name})${dimInfo}\n\nOutput: ${allPaths[0]}`;
                    }
                    
                    if (maskPaths.length > 0) {
                        message += `\n\nMasks:\n${maskPaths.map(p => `• ${p}`).join('\n')}`;
                    }
                } else if (successResults.length === 0) {
                    const errors = failedResults.map(r => r.error).join('\n');
                    return {
                        success: false,
                        error: isBatch
                            ? `All ${tasks.length} tasks failed:\n${errors}`
                            : failedResults[0]?.error || 'Background removal failed'
                    };
                } else {
                    const errors = failedResults.map(r => r.error).join('\n');
                    message = `⚠️ Partial success: ${successResults.length}/${tasks.length} (Engine: ${engine.name})\n\n`;
                    message += `Saved:\n${allPaths.map(p => `• ${p}`).join('\n')}\n\n`;
                    if (failedResults.length > 0) {
                        message += `Failed:\n${errors}`;
                    }
                }

                if (cancelledResults.length > 0) {
                    message += `\n\n⚠️ ${cancelledResults.length} task(s) cancelled`;
                }

                // 根据配置决定是否返回多模态数据
                const shouldReturnImageToAI = config.returnImageToAI === true;
                
                return {
                    success: true,
                    data: {
                        message,
                        toolId,
                        engine: engine.name,
                        totalTasks: tasks.length,
                        successCount: successResults.length,
                        failedCount: failedResults.length,
                        cancelledCount: cancelledResults.length,
                        paths: allPaths,
                        maskPaths
                    },
                    multimodal: shouldReturnImageToAI && allMultimodal.length > 0 ? allMultimodal : undefined,
                    cancelled: cancelledResults.length > 0
                };

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isCancelled = abortSignal.aborted ||
                    errorMessage.includes('aborted') ||
                    errorMessage.includes('cancelled');

                TaskManager.unregisterTask(
                    toolId,
                    isCancelled ? 'cancelled' : 'error',
                    isCancelled ? undefined : { error: errorMessage }
                );

                if (isCancelled) {
                    return {
                        success: false,
                        error: 'User cancelled the operation.',
                        cancelled: true
                    };
                }

                return {
                    success: false,
                    error: `Background removal failed: ${errorMessage}`
                };
            }
        }
    };
}

/**
 * 注册抠图工具（默认配置）
 */
export function registerRemoveBackground(): Tool {
    return createRemoveBackgroundTool();
}
