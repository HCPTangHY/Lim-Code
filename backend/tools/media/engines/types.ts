/**
 * 抠图引擎类型定义
 */

/**
 * 抠图引擎类型
 * - transformers: 本地 Transformers.js + RMBG-1.4（推荐，本地运行）
 * - gemini: Gemini API 生成遮罩（备选）
 */
export type RemovalEngineType = 'transformers' | 'gemini';

/**
 * 抠图引擎配置
 */
export interface RemovalEngineConfig {
    /** 引擎类型 */
    type: RemovalEngineType;
    /** API Key（用于 Gemini） */
    apiKey?: string;
    /** API URL */
    apiUrl?: string;
    /** 代理 URL */
    proxyUrl?: string;
    /** 模型名称 */
    model?: string;
    /** 主体描述（用于 Gemini） */
    subjectDescription?: string;
    /** 是否返回遮罩图 */
    returnMask?: boolean;
}

/**
 * 抠图结果
 */
export interface RemovalResult {
    /** 是否成功 */
    success: boolean;
    /** 结果图片（透明 PNG）Buffer */
    imageBuffer?: Buffer;
    /** 遮罩图 Buffer（可选） */
    maskBuffer?: Buffer;
    /** 错误信息 */
    error?: string;
}

/**
 * 抠图引擎接口
 */
export interface IRemovalEngine {
    /** 引擎名称 */
    readonly name: string;
    
    /** 引擎类型 */
    readonly type: RemovalEngineType;
    
    /**
     * 检查引擎是否可用
     */
    isAvailable(): Promise<boolean>;
    
    /**
     * 执行抠图
     * 
     * @param imageBuffer 原图 Buffer
     * @param config 配置
     * @param abortSignal 取消信号
     * @returns 抠图结果
     */
    removeBackground(
        imageBuffer: Buffer,
        config: RemovalEngineConfig,
        abortSignal?: AbortSignal
    ): Promise<RemovalResult>;
}

/**
 * 本地引擎信息
 */
export interface LocalEngineInfo {
    /** 引擎类型 */
    type: RemovalEngineType;
    /** 显示名称 */
    displayName: string;
    /** 描述 */
    description: string;
    /** 所需依赖 */
    dependencies: string[];
    /** 模型大小（大约） */
    modelSize: string;
    /** 推荐级别 */
    recommended: boolean;
}

/**
 * 可用的本地引擎列表
 */
export const LOCAL_ENGINES: LocalEngineInfo[] = [
    {
        type: 'transformers',
        displayName: 'RMBG-1.4 (Transformers.js)',
        description: '本地运行，无需 API，基于 IS-Net 架构，首次使用需下载模型',
        dependencies: ['@huggingface/transformers', 'sharp'],
        modelSize: '~180MB',
        recommended: true
    }
];
