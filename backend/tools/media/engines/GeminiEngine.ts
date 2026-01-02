/**
 * Gemini 抠图引擎
 * 
 * 使用 Gemini Image API 生成遮罩，然后应用遮罩生成透明图
 * 这是原有的实现方式，保留作为备选
 */

import type { IRemovalEngine, RemovalEngineConfig, RemovalResult, RemovalEngineType } from './types';
import { createProxyFetch } from '../../../modules/channel/proxyFetch';
import { getSharp } from '../../../modules/dependencies';

/**
 * Gemini API 响应类型
 */
interface GeminiImageResponse {
    candidates?: Array<{
        content?: {
            parts?: Array<{
                text?: string;
                inlineData?: {
                    mimeType: string;
                    data: string;
                };
            }>;
        };
    }>;
    error?: {
        code: number;
        message: string;
    };
}

/**
 * Gemini 抠图引擎
 */
export class GeminiEngine implements IRemovalEngine {
    readonly name = 'Gemini Image API';
    readonly type: RemovalEngineType = 'gemini';
    
    private readonly defaultModel = 'gemini-2.0-flash-exp-image-generation';
    private readonly defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    
    async isAvailable(): Promise<boolean> {
        // Gemini 需要 sharp 来处理遮罩
        const sharp = await getSharp();
        return sharp !== null;
    }
    
    async removeBackground(
        imageBuffer: Buffer,
        config: RemovalEngineConfig,
        abortSignal?: AbortSignal
    ): Promise<RemovalResult> {
        const apiKey = config.apiKey;
        if (!apiKey) {
            return {
                success: false,
                error: 'Gemini API Key not configured'
            };
        }
        
        // 获取 sharp
        const sharp = await getSharp();
        if (!sharp) {
            return {
                success: false,
                error: 'sharp library not installed. Please install it in Settings -> Extension Dependencies'
            };
        }
        
        const model = config.model || this.defaultModel;
        const baseUrl = config.apiUrl || this.defaultBaseUrl;
        const url = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`;
        
        try {
            if (abortSignal?.aborted) {
                return { success: false, error: 'Request cancelled' };
            }
            
            // 1. 生成遮罩图
            const base64Data = imageBuffer.toString('base64');
            const mimeType = await this.detectMimeType(imageBuffer, sharp);
            
            const maskPrompt = this.buildMaskPrompt(config.subjectDescription);
            
            const requestBody = {
                contents: [{
                    role: 'user',
                    parts: [
                        { text: maskPrompt },
                        {
                            inline_data: {
                                mime_type: mimeType,
                                data: base64Data
                            }
                        }
                    ]
                }],
                generationConfig: {
                    responseModalities: ['IMAGE']
                }
            };
            
            const fetchFn = createProxyFetch(config.proxyUrl);
            
            const response = await fetchFn(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: abortSignal
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                return {
                    success: false,
                    error: `Gemini API error: ${response.status} - ${errorText}`
                };
            }
            
            const data = await response.json() as GeminiImageResponse;
            
            if (data.error) {
                return {
                    success: false,
                    error: `Gemini API error: ${data.error.message}`
                };
            }
            
            // 提取遮罩图
            const maskImage = this.extractMaskFromResponse(data);
            if (!maskImage) {
                return {
                    success: false,
                    error: 'Failed to generate mask. Content may have been filtered.'
                };
            }
            
            // 2. 应用遮罩
            const maskBuffer = Buffer.from(maskImage.data, 'base64');
            const resultBuffer = await this.applyMask(imageBuffer, maskBuffer, sharp);
            
            return {
                success: true,
                imageBuffer: resultBuffer,
                maskBuffer: maskBuffer
            };
            
        } catch (error) {
            if (abortSignal?.aborted) {
                return { success: false, error: 'Request cancelled' };
            }
            
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            if (errorMessage.includes('aborted') || errorMessage.includes('cancelled')) {
                return { success: false, error: 'Request cancelled' };
            }
            
            return {
                success: false,
                error: `Gemini API request failed: ${errorMessage}`
            };
        }
    }
    
    /**
     * 检测图片 MIME 类型
     */
    private async detectMimeType(buffer: Buffer, sharp: any): Promise<string> {
        try {
            const metadata = await sharp(buffer).metadata();
            switch (metadata.format) {
                case 'jpeg': return 'image/jpeg';
                case 'png': return 'image/png';
                case 'webp': return 'image/webp';
                default: return 'image/png';
            }
        } catch {
            return 'image/png';
        }
    }
    
    /**
     * 构建遮罩生成提示词
     */
    private buildMaskPrompt(subjectDescription?: string): string {
        let prompt = `Generate a binary mask image for background removal.

CRITICAL REQUIREMENTS:
- Main subject/foreground: Pure BLACK color (#000000)
- Background: Pure WHITE color (#FFFFFF)
- NO gradients, NO gray colors, NO anti-aliasing
- Sharp, clean edges between subject and background
- The mask should precisely outline the main subject
- Keep the original aspect ratio unchanged`;

        if (subjectDescription) {
            prompt += `\n\nThe main subject to keep is: ${subjectDescription}`;
        }
        
        return prompt;
    }
    
    /**
     * 从响应中提取遮罩图
     */
    private extractMaskFromResponse(response: GeminiImageResponse): { data: string; mimeType: string } | null {
        if (response.candidates) {
            for (const candidate of response.candidates) {
                if (candidate.content?.parts) {
                    for (const part of candidate.content.parts) {
                        if (part.inlineData) {
                            return {
                                data: part.inlineData.data,
                                mimeType: part.inlineData.mimeType
                            };
                        }
                    }
                }
            }
        }
        return null;
    }
    
    /**
     * 应用遮罩生成透明图
     */
    private async applyMask(originalBuffer: Buffer, maskBuffer: Buffer, sharp: any): Promise<Buffer> {
        const originalMeta = await sharp(originalBuffer).metadata();
        const width = originalMeta.width!;
        const height = originalMeta.height!;
        
        // 缩放遮罩到原图尺寸
        const resizedMask = await sharp(maskBuffer)
            .resize(width, height)
            .greyscale()
            .raw()
            .toBuffer();
        
        // 获取原图 RGBA 数据
        const originalRgba = await sharp(originalBuffer)
            .ensureAlpha()
            .raw()
            .toBuffer();
        
        // 应用遮罩：黑色区域保留，白色区域透明
        const resultData = Buffer.alloc(width * height * 4);
        
        for (let i = 0; i < width * height; i++) {
            const maskValue = resizedMask[i];
            const srcOffset = i * 4;
            const dstOffset = i * 4;
            
            resultData[dstOffset] = originalRgba[srcOffset];
            resultData[dstOffset + 1] = originalRgba[srcOffset + 1];
            resultData[dstOffset + 2] = originalRgba[srcOffset + 2];
            // 黑色 (0) = 不透明 (255), 白色 (255) = 透明 (0)
            resultData[dstOffset + 3] = maskValue < 128 ? 255 : 0;
        }
        
        // 输出为 PNG
        return await sharp(resultData, {
            raw: { width, height, channels: 4 }
        })
            .png()
            .toBuffer();
    }
}
