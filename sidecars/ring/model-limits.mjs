// 平台上下文压缩截断阈值定义（真实平台限制，而非模型原生窗口大小）
export const PLATFORM_CONTEXT_LIMITS = {
  // Gemini 4 Argon (256K)
  'MODEL_PLACEHOLDER_M417': 256_000, // High (gemini-4-argon-high)
  'MODEL_PLACEHOLDER_M418': 256_000, // Medium (gemini-4-argon-medium)
  'MODEL_PLACEHOLDER_M419': 256_000, // Low (gemini-4-argon-low)
  // Gemini 3.8 Flash (256K)
  'MODEL_PLACEHOLDER_M318': 256_000, // High (gemini-3.8-flash-high)
  'MODEL_PLACEHOLDER_M319': 256_000, // Medium (gemini-3.8-flash-medium)
  'MODEL_PLACEHOLDER_M320': 256_000, // Low (gemini-3.8-flash-low)
  'MODEL_PLACEHOLDER_M322': 256_000,
  // Gemini 3.7 Flash
  'MODEL_PLACEHOLDER_M298': 256_000,
  'MODEL_PLACEHOLDER_M299': 256_000,
  'MODEL_PLACEHOLDER_M300': 256_000,
  // Gemini 3.6 Flash
  'MODEL_PLACEHOLDER_M71': 256_000,
  'MODEL_PLACEHOLDER_M72': 256_000,
  'MODEL_PLACEHOLDER_M73': 256_000,
  'MODEL_PLACEHOLDER_M264': 256_000,
  'MODEL_PLACEHOLDER_M265': 256_000,
  'MODEL_PLACEHOLDER_M266': 256_000,
  'MODEL_PLACEHOLDER_M196': 256_000,
  // Gemini 3.5 Flash
  'MODEL_PLACEHOLDER_M84': 256_000,
  'MODEL_PLACEHOLDER_M20': 256_000,
  'MODEL_PLACEHOLDER_M187': 256_000,
  // Gemini 3.1 Pro / Pro 系列 (128K)
  'MODEL_PLACEHOLDER_M16': 128_000,
  'MODEL_PLACEHOLDER_M37': 128_000,
  'MODEL_PLACEHOLDER_M36': 128_000,
  'MODEL_PLACEHOLDER_M18': 128_000,
  'MODEL_PLACEHOLDER_M47': 128_000,
  // Claude 5.5 系列 (256K)
  'MODEL_PLACEHOLDER_M400': 256_000, // Claude Opus 5.5 Low (claude-opus-5-5-low)
  'MODEL_PLACEHOLDER_M401': 256_000, // Claude Opus 5.5 Medium (claude-opus-5-5-medium)
  'MODEL_PLACEHOLDER_M402': 256_000, // Claude Opus 5.5 High (claude-opus-5-5-high)
  'MODEL_PLACEHOLDER_M403': 256_000, // Claude Sonnet 5.5 Low (claude-sonnet-5-5-low)
  'MODEL_PLACEHOLDER_M404': 256_000, // Claude Sonnet 5.5 Medium (claude-sonnet-5-5-medium)
  'MODEL_PLACEHOLDER_M405': 256_000, // Claude Sonnet 5.5 High (claude-sonnet-5-5-high)
  // Claude 4.6 系列 (Thinking) (160K)
  'MODEL_PLACEHOLDER_M35': 160_000,
  'MODEL_PLACEHOLDER_M26': 160_000,
  // GPT-OSS 120B (80K)
  'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 80_000, // GPT-OSS 120B Medium (gpt-oss-120b-medium)
};

export const DEFAULT_PLATFORM_LIMIT = 256_000;

/**
 * 判断指定模型是否为已知且明确匹配的模型
 */
export function isKnownModel(modelId = '', customOverrides = {}) {
  if (!modelId || typeof modelId !== 'string') return false;
  const cleanId = modelId.trim();
  if (customOverrides && Object.hasOwn(customOverrides, cleanId)) return true;
  if (Object.hasOwn(PLATFORM_CONTEXT_LIMITS, cleanId)) return true;

  const idUpper = cleanId.toUpperCase();
  if (Object.hasOwn(PLATFORM_CONTEXT_LIMITS, idUpper)) return true;

  const idLower = cleanId.toLowerCase();
  if (
    idLower.includes('claude') ||
    idLower.includes('opus') ||
    idLower.includes('sonnet') ||
    idLower.includes('pro') ||
    idLower.includes('flash') ||
    idLower.includes('lite') ||
    idLower.includes('argon') ||
    idLower.includes('gpt-oss') ||
    idLower.includes('120b')
  ) {
    return true;
  }
  return false;
}

/**
 * 根据模型 ID 或名称推导平台的上下文压缩阈值
 * 严格遵照平台实际截断规则，杜绝用原生 1M/2M 窗口冒充平台阈值
 */
export function getPlatformTruncationLimit(modelId = '', customOverrides = {}) {
  if (!modelId || typeof modelId !== 'string') {
    return DEFAULT_PLATFORM_LIMIT;
  }
  const cleanId = modelId.trim();

  // 1. 用户/动态自定义覆盖优先
  if (customOverrides && Object.hasOwn(customOverrides, cleanId)) {
    const override = customOverrides[cleanId];
    if (typeof override === 'number' && override > 0) return override;
  }

  // 2. 精确常量字典匹配（大小写无关，以 PLATFORM_CONTEXT_LIMITS 为唯一权威数据源）
  if (Object.hasOwn(PLATFORM_CONTEXT_LIMITS, cleanId)) {
    return PLATFORM_CONTEXT_LIMITS[cleanId];
  }
  const idUpper = cleanId.toUpperCase();
  if (Object.hasOwn(PLATFORM_CONTEXT_LIMITS, idUpper)) {
    return PLATFORM_CONTEXT_LIMITS[idUpper];
  }

  const idLower = cleanId.toLowerCase();

  // 3. 字符串关键字推导
  if (idLower.includes('gpt-oss') || idLower.includes('120b')) {
    return 80_000;
  }

  if (idLower.includes('claude') || idLower.includes('opus') || idLower.includes('sonnet')) {
    if (/(?:^|[-_\s])5[._-]5(?:$|[-_\s(])/.test(idLower)) {
      return 256_000;
    }
    return 160_000;
  }

  if (idLower.includes('pro')) {
    return 128_000;
  }

  if (idLower.includes('flash') || idLower.includes('lite') || idLower.includes('argon')) {
    const versionMatch = idLower.match(/(\d+\.\d+)/) || idLower.match(/_(\d+)_(\d+)_/);
    const version = versionMatch
      ? parseFloat(versionMatch.length > 2 ? `${versionMatch[1]}.${versionMatch[2]}` : versionMatch[1])
      : NaN;
    if (!Number.isNaN(version) && version < 3.5) {
      return 128_000;
    }
    return 256_000;
  }

  return DEFAULT_PLATFORM_LIMIT;
}
