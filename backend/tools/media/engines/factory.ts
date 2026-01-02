/**
 * 抠图引擎工厂
 */

import type { IRemovalEngine, RemovalEngineType } from './types';
import { TransformersEngine } from './TransformersEngine';
import { GeminiEngine } from './GeminiEngine';

/**
 * 引擎实例缓存
 */
const engineCache = new Map<RemovalEngineType, IRemovalEngine>();

/**
 * 创建抠图引擎
 * 
 * @param type 引擎类型
 * @returns 引擎实例
 */
export function createRemovalEngine(type: RemovalEngineType): IRemovalEngine {
    // 检查缓存
    const cached = engineCache.get(type);
    if (cached) {
        return cached;
    }
    
    let engine: IRemovalEngine;
    
    switch (type) {
        case 'transformers':
            engine = new TransformersEngine();
            break;
        case 'gemini':
            engine = new GeminiEngine();
            break;
        default:
            throw new Error(`Unknown engine type: ${type}`);
    }
    
    engineCache.set(type, engine);
    return engine;
}

/**
 * 获取所有可用的引擎类型
 */
export async function getAvailableEngines(): Promise<Array<{ type: RemovalEngineType; name: string; available: boolean }>> {
    const engines: Array<{ type: RemovalEngineType; name: string; available: boolean }> = [];
    
    // Transformers.js (本地 RMBG-1.4) - 推荐首选
    const transformersEngine = createRemovalEngine('transformers');
    engines.push({
        type: 'transformers',
        name: transformersEngine.name,
        available: await transformersEngine.isAvailable()
    });
    
    // Gemini（备选）
    const geminiEngine = createRemovalEngine('gemini');
    engines.push({
        type: 'gemini',
        name: geminiEngine.name,
        available: await geminiEngine.isAvailable()
    });
    
    return engines;
}

/**
 * 获取默认引擎类型
 * 优先级：transformers (本地 RMBG-1.4) > gemini
 */
export async function getDefaultEngineType(): Promise<RemovalEngineType> {
    const engines = await getAvailableEngines();
    
    // 优先使用本地 Transformers 引擎
    const transformers = engines.find(e => e.type === 'transformers');
    if (transformers?.available) {
        return 'transformers';
    }
    
    // 使用 Gemini 作为备选
    return 'gemini';
}
