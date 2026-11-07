import { getPlatformTruncationLimit, DEFAULT_PLATFORM_LIMIT, isKnownModel } from './model-limits.mjs';

// 步骤类型常量（对齐 Antigravity Language Server 协议）
export const StepType = {
  USER_INPUT: 'CORTEX_STEP_TYPE_USER_INPUT',
  PLANNER_RESPONSE: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  CHECKPOINT: 'CORTEX_STEP_TYPE_CHECKPOINT',
  INVOKE_SUBAGENT: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
  GENERATE_IMAGE: 'CORTEX_STEP_TYPE_GENERATE_IMAGE',
};

// 触发上下文压缩检测的最小 Token 骤降阈值
export const COMPRESSION_MIN_DROP = 5000;

// 系统 Prompt / 环境基础开销（当没有 Checkpoint 时的基准托底）
export const SYSTEM_PROMPT_OVERHEAD = 10_000;

/**
 * 根据纯文本内容估算 Token 数量
 * ASCII 字符：~4 字符/Token
 * 非 ASCII 字符（中文、日文、特殊符号等）：~1.5 字符/Token
 */
export function estimateTokensFromText(text = '') {
  if (!text || typeof text !== 'string') return 0;
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) {
      asciiChars++;
    } else {
      nonAsciiChars++;
    }
  }
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.5);
}

/**
 * 解析用户输入步骤文本
 */
function parseUserInputText(step) {
  const ui = step.userInput;
  if (!ui || typeof ui !== 'object') return '';
  return typeof ui.userResponse === 'string' ? ui.userResponse : '';
}

/**
 * 解析 Planner 响应步骤文本（包含响应文本、思考文本、工具调用入参）
 */
function parsePlannerResponseText(step) {
  const pr = step.plannerResponse;
  if (!pr || typeof pr !== 'object') return '';
  const responseText = typeof pr.response === 'string' ? pr.response : '';
  const thinkingText = typeof pr.thinking === 'string' ? pr.thinking : '';
  let toolCallsText = '';
  if (Array.isArray(pr.toolCalls)) {
    for (const tc of pr.toolCalls) {
      if (tc && typeof tc.argumentsJson === 'string') {
        toolCallsText += tc.argumentsJson;
      }
    }
  }
  return responseText + thinkingText + toolCallsText;
}

/**
 * 从步骤元数据中安全提取实际 modelUsage 硬件级指标
 */
export function extractModelUsage(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const mu = meta.modelUsage;
  if (!mu || typeof mu !== 'object' || Array.isArray(mu)) return null;

  const parseCount = (val) => {
    if (val === undefined || val === null) return 0;
    const num = Number(val);
    return Number.isSafeInteger(num) && num >= 0 ? num : null;
  };

  const inputTokens = parseCount(mu.inputTokens);
  const outputTokens = parseCount(mu.outputTokens);
  const cacheReadTokens = parseCount(mu.cacheReadTokens);
  const cacheCreationTokens = parseCount(mu.cacheCreationTokens);

  if (inputTokens === null || outputTokens === null || cacheReadTokens === null || cacheCreationTokens === null) {
    return null;
  }

  if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0) {
    return {
      model: typeof mu.model === 'string' ? mu.model : '',
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    };
  }
  return null;
}

/**
 * 核心纯函数：分析 steps 列表，计算上下文占用状态
 * @param {Array} steps - 轨迹步骤列表
 * @param {Object} [options] - 可选参数
 * @param {string} [options.fallbackModel] - 外部指定的会话初始模型
 * @param {string} [options.selectedModel] - 外部指定的用户主选模型（决定分母）
 * @param {Object} [options.customLimits] - 自定义平台阈值映射
 * @returns {Object} 计算结果
 */
export function processTrajectorySteps(steps = [], options = {}) {
  const initialSelected = options.selectedModel || '';
  const fallbackModel = options.fallbackModel || '';
  const isTruncated = !!options.isTruncated;
  if (!Array.isArray(steps) || steps.length === 0) {
    const emptyModel = initialSelected || fallbackModel;
    const limit = emptyModel ? getPlatformTruncationLimit(emptyModel, options.customLimits) : DEFAULT_PLATFORM_LIMIT;
    const known = isKnownModel(emptyModel, options.customLimits);
    return {
      ready: false, // 无有效步骤，处于中性等待状态
      contextUsed: 0,
      contextLimit: limit,
      usageRatio: 0,
      model: emptyModel,
      selectedModel: emptyModel,
      executionModel: '',
      checkpointModel: '',
      isEstimated: true,
      compressionDetected: false,
      compressionDrop: 0,
      isOverLimit: false,
      source: 'none',
      stepCount: 0,
      lastStepIndex: -1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      isUnknownModel: !known && !!emptyModel,
      isTruncated,
    };
  }

  // 模型身份三层解耦：
  // 1. selectedModel: 用户主选模型（决定 contextLimit 分母，仅受 USER_INPUT 主配置驱动）
  // 2. executionModel: 执行当前具体步骤的模型（用于记录最后运行特征）
  // 3. checkpointModel: 生成真实用量快照的物理模型
  let selectedModel = initialSelected;
  let executionModel = '';
  let checkpointModel = '';

  let lastModelUsage = null;
  let usageSource = 'none'; // 'checkpoint' | 'planner' | 'estimated'

  let prevCheckpointInputTokens = -1;
  let compressionDetected = false;
  let compressionDrop = 0;

  let estimationDeltaSinceSnapshot = 0;
  let toolCallOutputsSinceSnapshot = 0;

  const updateCompressionState = (currentInputTotal) => {
    if (prevCheckpointInputTokens > 0 && currentInputTotal < prevCheckpointInputTokens) {
      const drop = prevCheckpointInputTokens - currentInputTotal;
      if (drop > COMPRESSION_MIN_DROP) {
        compressionDetected = true;
        compressionDrop = Math.max(compressionDrop, drop);
        prevCheckpointInputTokens = currentInputTotal;
        return;
      }
    }
    // 方案 L1（会话级持久烙印）：一旦触发过上下文压缩，全生命周期保持 compressionDetected = true，
    // 不再因后续多轮对话重新涨回水位或新增 Token 而被动清空，确保高水位时稳定呈现紫红二次超限阶梯
    prevCheckpointInputTokens = currentInputTotal;
  };

  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    if (!step || typeof step !== 'object') continue;

    const stepType = step.type || '';
    const meta = step.metadata;
    const stepModel = (meta && typeof meta.generatorModel === 'string') ? meta.generatorModel : '';

    // 记录执行模型（最后发生执行的模型）
    if (stepModel) {
      executionModel = stepModel;
    }
    const rm = meta?.requestedModel;
    if (rm && typeof rm.model === 'string' && rm.model) {
      executionModel = rm.model;
    }

    // 1. 用户输入处理：仅当在 USER_INPUT 中明确指定主计划模型时，才更新主模型 selectedModel
    if (stepType === StepType.USER_INPUT) {
      const text = parseUserInputText(step);
      estimationDeltaSinceSnapshot += estimateTokensFromText(text);

      const ui = step.userInput;
      const userConfig = ui?.userConfig;
      const plannerConfig = userConfig?.plannerConfig;
      const selected = plannerConfig?.planModel || plannerConfig?.modelName;
      if (typeof selected === 'string' && selected) {
        selectedModel = selected;
      }
    }

    // 2. Planner 步骤增量估算
    if (stepType === StepType.PLANNER_RESPONSE) {
      const text = parsePlannerResponseText(step);
      estimationDeltaSinceSnapshot += estimateTokensFromText(text);
    }

    // 3. 先累加增量 toolCallOutputTokens（若当前步骤包含权威快照，将在下方步驟 4/5 中被统一重置归零）
    if (meta) {
      const rawToolOut = meta.toolCallOutputTokens;
      const toolOut = (rawToolOut !== undefined && rawToolOut !== null) ? Number(rawToolOut) : 0;
      if (Number.isSafeInteger(toolOut) && toolOut > 0) {
        toolCallOutputsSinceSnapshot += toolOut;
      }
    }

    // 4. Checkpoint 处理（权威全量快照）
    if (stepType === StepType.CHECKPOINT && meta) {
      const usage = extractModelUsage(meta);
      if (usage) {
        checkpointModel = usage.model;
        if (!selectedModel && usage.model) {
          selectedModel = usage.model;
        }

        const currentInputTotal = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
        updateCompressionState(currentInputTotal);

        lastModelUsage = usage;
        usageSource = 'checkpoint';
        // 遇到 Checkpoint 后，之前的估算与当前步工具增量全部清空归零，以 Checkpoint 为新基准
        estimationDeltaSinceSnapshot = 0;
        toolCallOutputsSinceSnapshot = 0;
      }
    }

    // 5. Planner 自身若携带 modelUsage 快照
    if (stepType === StepType.PLANNER_RESPONSE && meta) {
      const usage = extractModelUsage(meta);
      if (usage) {
        checkpointModel = usage.model;
        if (!selectedModel && usage.model) {
          selectedModel = usage.model;
        }

        const currentInputTotal = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
        updateCompressionState(currentInputTotal);

        lastModelUsage = usage;
        usageSource = 'planner';
        estimationDeltaSinceSnapshot = 0;
        toolCallOutputsSinceSnapshot = 0;
      }
    }
  }

  // 严禁子 Agent 或普通步骤篡改分母：
  // 决定分母容量（contextLimit）的标尺严格遵从：selectedModel -> checkpointModel -> executionModel -> fallback
  const effectiveCapacityModel = selectedModel || checkpointModel || executionModel || initialSelected || fallbackModel;
  const contextLimit = getPlatformTruncationLimit(effectiveCapacityModel, options.customLimits);
  const known = isKnownModel(effectiveCapacityModel, options.customLimits);
  const isUnknownModel = !known && !!effectiveCapacityModel;

  const stepCount = steps.length;
  const lastStepIndex = steps.length - 1;

  // 优先级 1：有 modelUsage 快照基准
  if (lastModelUsage) {
    // Antigravity Cortex 协议实测口径：
    // inputTokens 为本轮未命中缓存的新增输入 Token，cacheReadTokens 为命中 Prefix Cache 的历史上下文 Token，
    // cacheCreationTokens 为新建缓存的输入 Token；完整上下文物理占用 = 三者之和 + outputTokens
    const totalInputTokens = lastModelUsage.inputTokens + lastModelUsage.cacheReadTokens + lastModelUsage.cacheCreationTokens;
    const baseUsed = totalInputTokens + lastModelUsage.outputTokens;
    // 方案 C：已有权威快照时，结算前只叠加服务端给出的 toolCallOutputTokens，
    // 不再叠加本地字符启发式估算的文本增量（误差来源），文本增量等下一次结算由服务端账单体现
    const totalUsed = baseUsed + toolCallOutputsSinceSnapshot;
    const ratio = contextLimit > 0 ? totalUsed / contextLimit : 0;

    return {
      ready: true,
      contextUsed: Math.max(0, Math.round(totalUsed)),
      contextLimit,
      usageRatio: Math.min(Math.max(ratio, 0), 1),
      model: effectiveCapacityModel,
      selectedModel: selectedModel || effectiveCapacityModel,
      executionModel: executionModel || effectiveCapacityModel,
      checkpointModel: checkpointModel || lastModelUsage.model,
      isEstimated: toolCallOutputsSinceSnapshot > 0,
      compressionDetected,
      compressionDrop,
      isOverLimit: totalUsed >= contextLimit,
      source: usageSource,
      stepCount,
      lastStepIndex,
      inputTokens: lastModelUsage.inputTokens,
      outputTokens: lastModelUsage.outputTokens,
      cacheReadTokens: lastModelUsage.cacheReadTokens,
      cacheCreationTokens: lastModelUsage.cacheCreationTokens,
      isUnknownModel,
      isTruncated,
    };
  }

  // 优先级 2：托底估算（会话刚开启尚未形成 checkpoint / usage snapshot）
  const estimatedUsed = SYSTEM_PROMPT_OVERHEAD + toolCallOutputsSinceSnapshot + estimationDeltaSinceSnapshot;
  const ratio = contextLimit > 0 ? estimatedUsed / contextLimit : 0;

  return {
    ready: true,
    contextUsed: Math.max(0, Math.round(estimatedUsed)),
    contextLimit,
    usageRatio: Math.min(Math.max(ratio, 0), 1),
    model: effectiveCapacityModel,
    selectedModel: selectedModel || effectiveCapacityModel,
    executionModel: executionModel || effectiveCapacityModel,
    checkpointModel: '',
    isEstimated: true,
    compressionDetected: false,
    compressionDrop: 0,
    isOverLimit: estimatedUsed >= contextLimit,
    source: 'estimated',
    stepCount,
    lastStepIndex,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    isUnknownModel,
    isTruncated,
  };
}
