/**
 * Transformers.js 本地抠图引擎
 * 
 * 使用 @huggingface/transformers 在本地运行 RMBG-1.4 模型
 * 
 * 特点：
 * - 完全本地运行，无 API 限制
 * - 模型大小约 180MB（首次下载）
 * - 无需登录或 Token
 */

import type { IRemovalEngine, RemovalEngineConfig, RemovalResult, RemovalEngineType } from './types';
import { DependencyManager } from '../../../modules/dependencies/DependencyManager';

const MODEL_ID = 'briaai/RMBG-1.4';

/**
 * Transformers.js 抠图引擎
 */
export class TransformersEngine implements IRemovalEngine {
    readonly name = 'Transformers.js (RMBG-1.4)';
    readonly type: RemovalEngineType = 'transformers';
    
    private segmenter: any = null;
    private isLoading = false;
    private loadError: string | null = null;
    
    async isAvailable(): Promise<boolean> {
        const depManager = DependencyManager.getInstance();
        
        // 检查 @huggingface/transformers 是否已安装
        const transformersInstalled = await depManager.isInstalled('@huggingface/transformers');
        if (!transformersInstalled) {
            return false;
        }
        
        // 检查 sharp 是否已安装（用于图像后处理）
        const sharpInstalled = await depManager.isInstalled('sharp');
        return sharpInstalled;
    }
    
    /**
     * 初始化模型
     */
    private async initModel(): Promise<void> {
        if (this.segmenter) {
            return;
        }
        
        if (this.isLoading) {
            // 等待加载完成
            while (this.isLoading) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (this.loadError) {
                throw new Error(this.loadError);
            }
            return;
        }
        
        this.isLoading = true;
        this.loadError = null;
        
        try {
            const depManager = DependencyManager.getInstance();
            
            // 动态加载 transformers
            const transformers = await depManager.load('@huggingface/transformers');
            const { pipeline, env } = transformers;
            
            // 配置环境 - 使用 HuggingFace 镜像（国内访问）
            env.remoteHost = 'https://hf-mirror.com';
            env.remotePathTemplate = '{model}/resolve/{revision}/';
            env.allowLocalModels = true;
            env.useBrowserCache = false;
            
            console.log(`[TransformersEngine] Loading model: ${MODEL_ID}`);
            
            // 使用 pipeline API 加载模型
            this.segmenter = await pipeline('image-segmentation', MODEL_ID);
            
            console.log(`[TransformersEngine] Model loaded successfully`);
            
        } catch (error) {
            this.loadError = error instanceof Error ? error.message : String(error);
            console.error('[TransformersEngine] Failed to load model:', this.loadError);
            throw error;
        } finally {
            this.isLoading = false;
        }
    }
    
    async removeBackground(
        imageBuffer: Buffer,
        config: RemovalEngineConfig,
        abortSignal?: AbortSignal
    ): Promise<RemovalResult> {
        try {
            if (abortSignal?.aborted) {
                return { success: false, error: 'Request cancelled' };
            }
            
            // 初始化模型
            await this.initModel();
            
            if (!this.segmenter) {
                return {
                    success: false,
                    error: 'Failed to initialize Transformers.js model'
                };
            }
            
            const depManager = DependencyManager.getInstance();
            const transformers = await depManager.load('@huggingface/transformers');
            const sharp = await depManager.load('sharp');
            const { RawImage } = transformers;
            
            // 获取原图信息
            const metadata = await sharp(imageBuffer).metadata();
            const width = metadata.width!;
            const height = metadata.height!;
            
            console.log(`[TransformersEngine] Processing image: ${width}x${height}`);
            
            if (abortSignal?.aborted) {
                return { success: false, error: 'Request cancelled' };
            }
            
            // 使用 RawImage.fromBlob 加载图片
            const image = await RawImage.fromBlob(new Blob([imageBuffer]));
            
            // 运行分割
            console.log('[TransformersEngine] Running segmentation...');
            const output = await this.segmenter(image);
            
            if (abortSignal?.aborted) {
                return { success: false, error: 'Request cancelled' };
            }
            
            if (!output || output.length === 0 || !output[0].mask) {
                return {
                    success: false,
                    error: 'Model did not return valid mask output'
                };
            }
            
            // 处理遮罩
            const maskImage = output[0].mask;
            const maskWidth = maskImage.width;
            const maskHeight = maskImage.height;
            const maskData = maskImage.data;
            const channels = maskImage.channels || 1;
            
            console.log(`[TransformersEngine] Mask: ${maskWidth}x${maskHeight}, channels: ${channels}`);
            
            // 提取灰度遮罩
            const grayscaleData = new Uint8Array(maskWidth * maskHeight);
            for (let i = 0; i < maskWidth * maskHeight; i++) {
                grayscaleData[i] = channels === 1 ? maskData[i] : maskData[i * channels];
            }
            
            // resize 并保持单通道灰度
            const resizedMask = await sharp(Buffer.from(grayscaleData), {
                raw: { width: maskWidth, height: maskHeight, channels: 1 }
            })
            .resize(width, height)
            .grayscale()
            .raw()
            .toBuffer();
            
            // 应用遮罩
            const resultBuffer = await this.applyMask(
                sharp,
                imageBuffer,
                resizedMask,
                width,
                height
            );
            
            // 生成遮罩 PNG（如果需要）
            let maskBuffer: Buffer | undefined;
            if (config.returnMask) {
                maskBuffer = await sharp(resizedMask, {
                    raw: { width, height, channels: 1 }
                }).png().toBuffer();
            }
            
            console.log('[TransformersEngine] Background removal completed');
            
            return {
                success: true,
                imageBuffer: resultBuffer,
                maskBuffer
            };
            
        } catch (error) {
            if (abortSignal?.aborted) {
                return { success: false, error: 'Request cancelled' };
            }
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('[TransformersEngine] Error:', errorMessage);
            
            return {
                success: false,
                error: `Transformers.js processing failed: ${errorMessage}`
            };
        }
    }
    
    /**
     * 将遮罩应用到图像，生成透明背景 PNG
     */
    private async applyMask(
        sharp: any,
        imageBuffer: Buffer,
        maskBuffer: Buffer,
        width: number,
        height: number
    ): Promise<Buffer> {
        // 获取原图 RGB 数据
        const rgbBuffer = await sharp(imageBuffer)
            .removeAlpha()
            .raw()
            .toBuffer();
        
        // 创建 RGBA 数据
        const rgbaBuffer = Buffer.alloc(width * height * 4);
        
        for (let i = 0; i < width * height; i++) {
            rgbaBuffer[i * 4 + 0] = rgbBuffer[i * 3 + 0];  // R
            rgbaBuffer[i * 4 + 1] = rgbBuffer[i * 3 + 1];  // G
            rgbaBuffer[i * 4 + 2] = rgbBuffer[i * 3 + 2];  // B
            rgbaBuffer[i * 4 + 3] = maskBuffer[i];         // A = mask
        }
        
        // 生成透明 PNG
        return await sharp(rgbaBuffer, {
            raw: { width, height, channels: 4 }
        }).png().toBuffer();
    }
}
