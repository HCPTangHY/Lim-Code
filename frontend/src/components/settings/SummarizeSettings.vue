<script setup lang="ts">
/**
 * SummarizeSettings - 总结设置面板
 * 配置上下文总结功能
 */

import { reactive, ref, computed, onMounted, watch } from 'vue'
import { CustomCheckbox, CustomSelect, type SelectOption } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import type { ModelInfo } from '@/types'

const { t } = useI18n()

// 渠道配置类型
interface ChannelConfig {
  id: string
  name: string
  type: string
  enabled: boolean
  model: string
  models: ModelInfo[]
}

// 渠道列表
const channels = ref<ChannelConfig[]>([])
const isLoadingChannels = ref(false)

// 总结配置
const summarizeConfig = reactive({
  // 自动总结
  autoSummarize: false,
  // 触发阈值（百分比）
  autoSummarizeThreshold: 80,
  // 总结提示词
  summarizePrompt: '请将以上对话内容进行总结，保留关键信息和上下文要点，去除冗余内容。',
  // 保留最近 N 轮不总结
  keepRecentRounds: 2,
  // 使用专门的总结模型
  useSeparateModel: false,
  // 总结用的渠道 ID
  summarizeChannelId: '',
  // 总结用的模型 ID
  summarizeModelId: ''
})

// 已启用的渠道选项
const enabledChannelOptions = computed<SelectOption[]>(() => {
  return channels.value
    .filter(c => c.enabled)
    .map(c => ({
      value: c.id,
      label: c.name,
      description: c.type
    }))
})

// 当前选择的渠道
const selectedChannel = computed(() => {
  return channels.value.find(c => c.id === summarizeConfig.summarizeChannelId)
})

// 当前渠道的模型选项
const modelOptions = computed<SelectOption[]>(() => {
  if (!selectedChannel.value || !selectedChannel.value.models) {
    return []
  }
  return selectedChannel.value.models.map(m => ({
    value: m.id,
    label: m.name || m.id,
    description: m.description
  }))
})

// 加载渠道列表
async function loadChannels() {
  isLoadingChannels.value = true
  try {
    const ids = await sendToExtension<string[]>('config.listConfigs', {})
    const loadedChannels: ChannelConfig[] = []
    
    for (const id of ids) {
      const config = await sendToExtension<ChannelConfig>('config.getConfig', { configId: id })
      if (config) {
        loadedChannels.push(config)
      }
    }
    
    channels.value = loadedChannels
  } catch (error) {
    console.error('Failed to load channels:', error)
  } finally {
    isLoadingChannels.value = false
  }
}

// 加载配置
async function loadConfig() {
  try {
    const response = await sendToExtension<any>('getSummarizeConfig', {})
    if (response) {
      Object.assign(summarizeConfig, response)
    }
  } catch (error) {
    console.error('Failed to load summarize config:', error)
  }
}

// 更新配置字段（即时保存）
async function updateConfigField(field: string, value: any) {
  // 先更新本地值
  (summarizeConfig as any)[field] = value
  
  // 保存到后端
  try {
    await sendToExtension('updateSummarizeConfig', {
      config: { ...summarizeConfig }
    })
  } catch (error) {
    console.error('Failed to save summarize config:', error)
  }
}

// 更新渠道选择
async function updateChannelId(channelId: string) {
  summarizeConfig.summarizeChannelId = channelId
  // 切换渠道时，清空模型选择
  summarizeConfig.summarizeModelId = ''
  
  // 保存到后端
  try {
    await sendToExtension('updateSummarizeConfig', {
      config: { ...summarizeConfig }
    })
  } catch (error) {
    console.error('Failed to save summarize config:', error)
  }
}

// 更新模型选择
async function updateModelId(modelId: string) {
  summarizeConfig.summarizeModelId = modelId
  
  // 保存到后端
  try {
    await sendToExtension('updateSummarizeConfig', {
      config: { ...summarizeConfig }
    })
  } catch (error) {
    console.error('Failed to save summarize config:', error)
  }
}

// 监听专用模型开关
watch(() => summarizeConfig.useSeparateModel, (enabled) => {
  if (!enabled) {
    // 关闭时清空渠道和模型选择
    summarizeConfig.summarizeChannelId = ''
    summarizeConfig.summarizeModelId = ''
  }
})

// 初始化
onMounted(async () => {
  await Promise.all([loadConfig(), loadChannels()])
})
</script>

<template>
  <div class="summarize-settings">
    <!-- 功能说明 -->
    <div class="feature-description">
      <i class="codicon codicon-info"></i>
      <p>
        {{ t('components.settings.summarizeSettings.description') }}
      </p>
    </div>
    
    <!-- 手动总结说明 -->
    <div class="section">
      <h5 class="section-title">
        <i class="codicon codicon-fold"></i>
        {{ t('components.settings.summarizeSettings.manualSection.title') }}
      </h5>
      <p class="section-description">
        {{ t('components.settings.summarizeSettings.manualSection.description') }}
      </p>
    </div>
    
    <!-- 自动总结设置 -->
    <div class="section">
      <h5 class="section-title">
        <i class="codicon codicon-zap"></i>
        {{ t('components.settings.summarizeSettings.autoSection.title') }}
        <span class="badge coming-soon">{{ t('components.settings.summarizeSettings.autoSection.comingSoon') }}</span>
      </h5>
      
      <div class="form-group disabled">
        <CustomCheckbox
          v-model="summarizeConfig.autoSummarize"
          :label="t('components.settings.summarizeSettings.autoSection.enable')"
          :disabled="true"
        />
        <p class="field-hint">{{ t('components.settings.summarizeSettings.autoSection.enableHint') }}</p>
      </div>
      
      <div class="form-group disabled">
        <label>{{ t('components.settings.summarizeSettings.autoSection.threshold') }}</label>
        <div class="threshold-input">
          <input
            type="number"
            v-model.number="summarizeConfig.autoSummarizeThreshold"
            min="50"
            max="95"
            disabled
          />
          <span class="unit">{{ t('components.settings.summarizeSettings.autoSection.thresholdUnit') }}</span>
        </div>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.autoSection.thresholdHint') }}</p>
      </div>
    </div>
    
    <!-- 总结选项 -->
    <div class="section">
      <h5 class="section-title">
        <i class="codicon codicon-settings"></i>
        {{ t('components.settings.summarizeSettings.optionsSection.title') }}
      </h5>
      
      <div class="form-group">
        <label>{{ t('components.settings.summarizeSettings.optionsSection.keepRounds') }}</label>
        <div class="rounds-input">
          <input
            type="number"
            :value="summarizeConfig.keepRecentRounds"
            min="0"
            max="10"
            @input="(e: any) => updateConfigField('keepRecentRounds', Number(e.target.value))"
          />
          <span class="unit">{{ t('components.settings.summarizeSettings.optionsSection.keepRoundsUnit') }}</span>
        </div>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.optionsSection.keepRoundsHint') }}</p>
      </div>
      
      <div class="form-group">
        <label>{{ t('components.settings.summarizeSettings.optionsSection.prompt') }}</label>
        <textarea
          :value="summarizeConfig.summarizePrompt"
          rows="3"
          :placeholder="t('components.settings.summarizeSettings.optionsSection.promptPlaceholder')"
          @input="(e: any) => updateConfigField('summarizePrompt', e.target.value)"
        ></textarea>
        <p class="field-hint">{{ t('components.settings.summarizeSettings.optionsSection.promptHint') }}</p>
      </div>
    </div>
    
    <!-- 专用总结模型 -->
    <div class="section">
      <h5 class="section-title">
        <i class="codicon codicon-beaker"></i>
        {{ t('components.settings.summarizeSettings.modelSection.title') }}
      </h5>
      
      <div class="form-group">
        <CustomCheckbox
          :model-value="summarizeConfig.useSeparateModel"
          :label="t('components.settings.summarizeSettings.modelSection.useSeparate')"
          @update:model-value="(v: boolean) => updateConfigField('useSeparateModel', v)"
        />
        <p class="field-hint">
          {{ t('components.settings.summarizeSettings.modelSection.useSeparateHint') }}
        </p>
      </div>
      
      <div class="default-model-hint" v-if="!summarizeConfig.useSeparateModel">
        <i class="codicon codicon-info"></i>
        <span>{{ t('components.settings.summarizeSettings.modelSection.currentModelHint') }}</span>
      </div>
      
      <template v-if="summarizeConfig.useSeparateModel">
        <!-- 渠道选择 -->
        <div class="form-group">
          <label>{{ t('components.settings.summarizeSettings.modelSection.selectChannel') }}</label>
          <CustomSelect
            :model-value="summarizeConfig.summarizeChannelId"
            :options="enabledChannelOptions"
            :placeholder="t('components.settings.summarizeSettings.modelSection.selectChannelPlaceholder')"
            @update:model-value="updateChannelId"
          />
          <p class="field-hint">{{ t('components.settings.summarizeSettings.modelSection.selectChannelHint') }}</p>
        </div>
        
        <!-- 模型选择 -->
        <div class="form-group">
          <label>{{ t('components.settings.summarizeSettings.modelSection.selectModel') }}</label>
          <CustomSelect
            :model-value="summarizeConfig.summarizeModelId"
            :options="modelOptions"
            :disabled="!summarizeConfig.summarizeChannelId"
            :placeholder="t('components.settings.summarizeSettings.modelSection.selectModelPlaceholder')"
            @update:model-value="updateModelId"
          />
          <p class="field-hint">
            {{ t('components.settings.summarizeSettings.modelSection.selectModelHint') }}
          </p>
        </div>
        
        <!-- 选择状态提示 -->
        <div v-if="!summarizeConfig.summarizeChannelId || !summarizeConfig.summarizeModelId" class="warning-hint">
          <i class="codicon codicon-warning"></i>
          <span>{{ t('components.settings.summarizeSettings.modelSection.warningHint') }}</span>
        </div>
      </template>
    </div>
    
  </div>
</template>

<style scoped>
.summarize-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 功能说明 */
.feature-description {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textLink-foreground);
  border-radius: 0 4px 4px 0;
}

.feature-description .codicon {
  flex-shrink: 0;
  color: var(--vscode-textLink-foreground);
}

.feature-description p {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-foreground);
  line-height: 1.5;
}

/* 分区 */
.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.section-title .codicon {
  font-size: 14px;
}

.section-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
}

/* 徽章 */
.badge {
  padding: 2px 6px;
  font-size: 10px;
  font-weight: normal;
  border-radius: 10px;
  margin-left: auto;
}

.badge.coming-soon {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

/* 表单组 */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-group.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.form-group label {
  font-size: 12px;
  color: var(--vscode-foreground);
}

.form-group input[type="number"],
.form-group textarea {
  padding: 6px 10px;
  font-size: 13px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
}

/* 隐藏数字输入框的上下箭头 */
.form-group input[type="number"] {
  appearance: textfield;
  -moz-appearance: textfield; /* Firefox */
}

.form-group input[type="number"]::-webkit-outer-spin-button,
.form-group input[type="number"]::-webkit-inner-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}

.form-group input[type="number"]:focus,
.form-group textarea:focus {
  border-color: var(--vscode-focusBorder);
}

.form-group textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}

.field-hint {
  margin: 0;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

/* 阈值输入 */
.threshold-input,
.rounds-input {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 120px;
}

.threshold-input input,
.rounds-input input {
  flex: 1;
  min-width: 0;
}

.unit {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* 默认模型提示 */
.default-model-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--vscode-textBlockQuote-background);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.default-model-hint .codicon {
  font-size: 14px;
  color: var(--vscode-textLink-foreground);
}

/* 警告提示 */
.warning-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--vscode-inputValidation-warningBackground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  border-radius: 4px;
  font-size: 12px;
  color: var(--vscode-foreground);
  margin-top: 8px;
}

.warning-hint .codicon {
  font-size: 14px;
  color: var(--vscode-list-warningForeground);
}

</style>