// 平台上下文压缩截断阈值定义（真实平台限制，而非模型原生窗口大小）
export const PLATFORM_CONTEXT_LIMITS = {
  // Gemini 4 Argon (512K - 2026-11 Antigravity 平台侧翻倍放开)
  'MODEL_PLACEHOLDER_M417': 512_000, // High (gemini-4-argon-high)
  'MODEL_PLACEHOLDER_M418': 512_000, // Medium (gemini-4-argon-medium)
  'MODEL_PLACEHOLDER_M419': 512_000, // Low (gemini-4-argon-low)
  // Gemini 4 Hydrogen (512K - 2026-11 Antigravity 平台侧翻倍放开，支持运行时 maxContextTokens 动态覆盖)
  'MODEL_PLACEHOLDER_M525': 512_000, // High (gemini-4-hydrogen-high)
  'MODEL_PLACEHOLDER_M526': 512_000, // Medium (gemini-4-hydrogen-medium)
  'MODEL_PLACEHOLDER_M527': 512_000, // Low (gemini-4-hydrogen-low)
  'MODEL_PLACEHOLDER_M528': 512_000, // XHigh / Extra (gemini-4-hydrogen-xhigh / gemini-4-hydrogen-extra)
  'MODEL_PLACEHOLDER_M529': 512_000,
  'MODEL_PLACEHOLDER_M432': 512_000, // Canonical Hydrogen
  'MODEL_PLACEHOLDER_M433': 512_000, // Canonical Hydrogen
  'MODEL_PLACEHOLDER_M434': 512_000, // Canonical Hydrogen
  // Orchestrator (Argon) (512K - 随 Argon 家族翻倍)
  'MODEL_PLACEHOLDER_M667': 512_000, // Canonical Orchestrator (Argon)
  'MODEL_PLACEHOLDER_M668': 512_000, // Orchestrator (Argon) (gemini-pro-orchestrator-g1-pro)
  // Gemini 4 Neon (512K - 2026-11 Antigravity v2.33 新增主力旗舰系列)
  'MODEL_PLACEHOLDER_M530': 512_000,
  'MODEL_PLACEHOLDER_M531': 512_000,
  'MODEL_PLACEHOLDER_M532': 512_000, // High (gemini-4-neon-high)
  'MODEL_PLACEHOLDER_M533': 512_000, // Medium (gemini-4-neon-medium)
  'MODEL_PLACEHOLDER_M534': 512_000, // Low (gemini-4-neon-low)
  'MODEL_PLACEHOLDER_M535': 512_000, // XHigh / Extra (gemini-4-neon-xhigh / gemini-4-neon-extra)
  'MODEL_PLACEHOLDER_M536': 512_000,
  // Orchestrator (Neon) (512K - 随 Neon 家族对齐)
  'MODEL_PLACEHOLDER_M537': 512_000, // Orchestrator (Neon) (gemini-pro-orchestrator-neon)
  // Gemini 4 Carbon (512K - 2026-11 Antigravity 平台侧翻倍放开)
  'MODEL_PLACEHOLDER_M670': 512_000, // Gemini 4 Carbon (gemini-4-carbon)
  // 内部 M408 家族 (归属 Gemini 4 Argon 族，512K)
  'MODEL_PLACEHOLDER_M408': 512_000,
  'MODEL_PLACEHOLDER_M409': 512_000,
  'MODEL_PLACEHOLDER_M410': 512_000,
  'MODEL_PLACEHOLDER_M411': 512_000,
  'MODEL_PLACEHOLDER_M412': 512_000,
  'MODEL_PLACEHOLDER_M413': 512_000,
  'MODEL_PLACEHOLDER_M420': 512_000,
  'MODEL_PLACEHOLDER_M421': 512_000,
  'MODEL_PLACEHOLDER_M422': 512_000,
  'MODEL_PLACEHOLDER_M423': 512_000,
  'MODEL_PLACEHOLDER_M424': 512_000,
  'MODEL_PLACEHOLDER_M427': 512_000,
  'MODEL_PLACEHOLDER_M428': 512_000,
  'MODEL_PLACEHOLDER_M429': 512_000,
  'MODEL_PLACEHOLDER_M430': 512_000,
  'MODEL_PLACEHOLDER_M431': 512_000,
  'MODEL_PLACEHOLDER_M437': 512_000,
  'MODEL_PLACEHOLDER_M438': 512_000,
  // Gemini 3.8 Flash (256K)
  'MODEL_PLACEHOLDER_M317': 256_000,
  'MODEL_PLACEHOLDER_M318': 256_000, // High (gemini-3.8-flash-high)
  'MODEL_PLACEHOLDER_M319': 256_000, // Medium (gemini-3.8-flash-medium)
  'MODEL_PLACEHOLDER_M320': 256_000, // Low (gemini-3.8-flash-low)
  'MODEL_PLACEHOLDER_M322': 256_000,
  'MODEL_PLACEHOLDER_M669': 256_000, // Orchestrator execution partner (gemini-flash-worker-agy)
  // Gemini 3.7 Flash
  'MODEL_PLACEHOLDER_M298': 256_000,
  'MODEL_PLACEHOLDER_M299': 256_000,
  'MODEL_PLACEHOLDER_M300': 256_000,
  'MODEL_PLACEHOLDER_M301': 256_000,
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
  // Claude 5.5 系列 (默认 256K，远端 claude-1m_840k 实验开启时由运行态 840K 动态覆盖)
  'MODEL_PLACEHOLDER_M400': 256_000, // Claude Opus 5.5 Low (claude-opus-5-5-low)
  'MODEL_PLACEHOLDER_M401': 256_000, // Claude Opus 5.5 Medium (claude-opus-5-5-medium)
  'MODEL_PLACEHOLDER_M402': 256_000, // Claude Opus 5.5 High (claude-opus-5-5-high)
  'MODEL_PLACEHOLDER_M403': 256_000, // Claude Sonnet 5.5 Low (claude-sonnet-5-5-low)
  'MODEL_PLACEHOLDER_M404': 256_000, // Claude Sonnet 5.5 Medium (claude-sonnet-5-5-medium)
  'MODEL_PLACEHOLDER_M405': 256_000, // Claude Sonnet 5.5 High (claude-sonnet-5-5-high)
  'MODEL_PLACEHOLDER_M406': 256_000,
  'MODEL_PLACEHOLDER_M407': 256_000,
  'MODEL_PLACEHOLDER_M341': 256_000,
  // Claude 4 / 4.5 / 3.7 / 3.5 系列 (160K，与前端 inferClientModelLimit 严格对齐)
  'MODEL_CLAUDE_4_SONNET': 160_000,
  'MODEL_CLAUDE_4_OPUS': 160_000,
  'MODEL_CLAUDE_4_5_SONNET': 160_000,
  'MODEL_CLAUDE_4_5_OPUS': 160_000,
  'MODEL_CLAUDE_3_7_SONNET': 160_000,
  'MODEL_CLAUDE_3_5_SONNET': 160_000,
  // 其他官方 LS model_profiles 中存在独立限额的模型
  'MODEL_PLACEHOLDER_M124': 256_000,
  'MODEL_PLACEHOLDER_M26': 160_000,
  'MODEL_PLACEHOLDER_M35': 160_000,
  'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': 80_000, // GPT-OSS 120B (Medium) (gpt-oss-120b-medium)
  'MODEL_GOOGLE_GEMINI_2_5_FLASH': 128_000,
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE': 128_000,
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING': 128_000,
  'MODEL_GOOGLE_GEMINI_2_5_PRO': 128_000,
  'MODEL_PLACEHOLDER_M50': 128_000,
  'MODEL_PLACEHOLDER_M18': 128_000,
  'MODEL_PLACEHOLDER_M148': 128_000,
  'MODEL_PLACEHOLDER_M198': 128_000,
};

export const DEFAULT_PLATFORM_LIMIT = 256_000;

// 归一化后的 API modelId / UI 显示名称到规范枚举键的映射
export const MODEL_ID_ALIASES = {
  'gemini-4-argon': 'MODEL_PLACEHOLDER_M418',
  'gemini-4-argon-high': 'MODEL_PLACEHOLDER_M417',
  'gemini-4-argon-medium': 'MODEL_PLACEHOLDER_M418',
  'gemini-4-argon-low': 'MODEL_PLACEHOLDER_M419',
  'gemini-4-argon-xhigh': 'MODEL_PLACEHOLDER_M417',
  'gemini-4-argon-extra': 'MODEL_PLACEHOLDER_M417',
  'gemini-4-argon-trial': 'MODEL_PLACEHOLDER_M418',
  'gemini-4-hydrogen': 'MODEL_PLACEHOLDER_M525',
  'gemini-4-hydrogen-high': 'MODEL_PLACEHOLDER_M525',
  'gemini-4-hydrogen-medium': 'MODEL_PLACEHOLDER_M526',
  'gemini-4-hydrogen-low': 'MODEL_PLACEHOLDER_M527',
  'gemini-4-hydrogen-xhigh': 'MODEL_PLACEHOLDER_M528',
  'gemini-4-hydrogen-extra': 'MODEL_PLACEHOLDER_M528',
  'gemini-4-neon': 'MODEL_PLACEHOLDER_M533',
  'gemini-4-neon-high': 'MODEL_PLACEHOLDER_M532',
  'gemini-4-neon-medium': 'MODEL_PLACEHOLDER_M533',
  'gemini-4-neon-low': 'MODEL_PLACEHOLDER_M534',
  'gemini-4-neon-xhigh': 'MODEL_PLACEHOLDER_M535',
  'gemini-4-neon-extra': 'MODEL_PLACEHOLDER_M535',
  'gemini-4-neon-trial': 'MODEL_PLACEHOLDER_M533',
  'orchestrator': 'MODEL_PLACEHOLDER_M668',
  'orchestrator-argon': 'MODEL_PLACEHOLDER_M668',
  'gemini-pro-orchestrator-g1-pro': 'MODEL_PLACEHOLDER_M668',
  'orchestrator-neon': 'MODEL_PLACEHOLDER_M537',
  'gemini-pro-orchestrator-neon': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-neon': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-neon-high': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-neon-medium': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-neon-low': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-neon-xhigh': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-neon-extra': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-argon': 'MODEL_PLACEHOLDER_M668',
  'orchestrator-gemini-4-argon-high': 'MODEL_PLACEHOLDER_M668',
  'orchestrator-gemini-4-argon-medium': 'MODEL_PLACEHOLDER_M668',
  'orchestrator-gemini-4-argon-low': 'MODEL_PLACEHOLDER_M668',
  'orchestrator-gemini-4-argon-xhigh': 'MODEL_PLACEHOLDER_M668',
  'orchestrator-gemini-4-argon-extra': 'MODEL_PLACEHOLDER_M668',
  'orchestrator-gemini-4-hydrogen': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-hydrogen-high': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-hydrogen-medium': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-hydrogen-low': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-hydrogen-xhigh': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-hydrogen-extra': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-carbon': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-carbon-high': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-carbon-medium': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-carbon-low': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-carbon-xhigh': 'MODEL_PLACEHOLDER_M537',
  'orchestrator-gemini-4-carbon-extra': 'MODEL_PLACEHOLDER_M537',
  'gemini-flash-worker-agy': 'MODEL_PLACEHOLDER_M669',
  'gemini-flash': 'MODEL_PLACEHOLDER_M669',
  'gemini-4-carbon': 'MODEL_PLACEHOLDER_M670',
  'gemini-4-carbon-low': 'MODEL_PLACEHOLDER_M670',
  'gemini-4-carbon-medium': 'MODEL_PLACEHOLDER_M670',
  'gemini-4-carbon-high': 'MODEL_PLACEHOLDER_M670',
  'gemini-4-carbon-xhigh': 'MODEL_PLACEHOLDER_M670',
  'gemini-4-carbon-extra': 'MODEL_PLACEHOLDER_M670',
  'gemini-4-carbon-disabled': 'MODEL_PLACEHOLDER_M670',
  'gemini-3.8-flash': 'MODEL_PLACEHOLDER_M319',
  'gemini-3.8-flash-high': 'MODEL_PLACEHOLDER_M318',
  'gemini-3.8-flash-medium': 'MODEL_PLACEHOLDER_M319',
  'gemini-3.8-flash-low': 'MODEL_PLACEHOLDER_M320',
  'gemini-3.8-flash-tiered': 'MODEL_PLACEHOLDER_M319',
  'gemini-3-8-flash': 'MODEL_PLACEHOLDER_M319',
  'gemini-3-8-flash-high': 'MODEL_PLACEHOLDER_M318',
  'gemini-3-8-flash-medium': 'MODEL_PLACEHOLDER_M319',
  'gemini-3-8-flash-low': 'MODEL_PLACEHOLDER_M320',
  'gemini-3-8-flash-tiered': 'MODEL_PLACEHOLDER_M319',
  'gemini-3.5-flash': 'MODEL_PLACEHOLDER_M84',
  'gemini-3.5-flash-lite': 'MODEL_PLACEHOLDER_M84',
  'gemini-3-5-flash': 'MODEL_PLACEHOLDER_M84',
  'gemini-3-5-flash-lite': 'MODEL_PLACEHOLDER_M84',
  'claude-opus-5-5': 'MODEL_PLACEHOLDER_M401',
  'claude-opus-5.5': 'MODEL_PLACEHOLDER_M401',
  'claude-opus-5-5-low': 'MODEL_PLACEHOLDER_M400',
  'claude-opus-5.5-low': 'MODEL_PLACEHOLDER_M400',
  'claude-opus-5-5-medium': 'MODEL_PLACEHOLDER_M401',
  'claude-opus-5.5-medium': 'MODEL_PLACEHOLDER_M401',
  'claude-opus-5-5-high': 'MODEL_PLACEHOLDER_M402',
  'claude-opus-5.5-high': 'MODEL_PLACEHOLDER_M402',
  'claude-opus-5-5-extra': 'MODEL_PLACEHOLDER_M402',
  'claude-opus-5.5-extra': 'MODEL_PLACEHOLDER_M402',
  'claude-opus-5-5-max': 'MODEL_PLACEHOLDER_M402',
  'claude-opus-5.5-max': 'MODEL_PLACEHOLDER_M402',
  'claude-sonnet-5-5': 'MODEL_PLACEHOLDER_M404',
  'claude-sonnet-5.5': 'MODEL_PLACEHOLDER_M404',
  'claude-sonnet-5-5-low': 'MODEL_PLACEHOLDER_M403',
  'claude-sonnet-5.5-low': 'MODEL_PLACEHOLDER_M403',
  'claude-sonnet-5-5-medium': 'MODEL_PLACEHOLDER_M404',
  'claude-sonnet-5.5-medium': 'MODEL_PLACEHOLDER_M404',
  'claude-sonnet-5-5-high': 'MODEL_PLACEHOLDER_M405',
  'claude-sonnet-5.5-high': 'MODEL_PLACEHOLDER_M405',
  'claude-sonnet-5-5-extra': 'MODEL_PLACEHOLDER_M405',
  'claude-sonnet-5.5-extra': 'MODEL_PLACEHOLDER_M405',
  'claude-4-sonnet': 'MODEL_CLAUDE_4_SONNET',
  'claude-4-opus': 'MODEL_CLAUDE_4_OPUS',
  'claude-4.5-sonnet': 'MODEL_CLAUDE_4_5_SONNET',
  'claude-4-5-sonnet': 'MODEL_CLAUDE_4_5_SONNET',
  'claude-4.5-opus': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-4-5-opus': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-sonnet-4': 'MODEL_CLAUDE_4_SONNET',
  'claude-opus-4': 'MODEL_CLAUDE_4_OPUS',
  'claude-sonnet-4.5': 'MODEL_CLAUDE_4_5_SONNET',
  'claude-sonnet-4-5': 'MODEL_CLAUDE_4_5_SONNET',
  'claude-opus-4.5': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-opus-4-5': 'MODEL_CLAUDE_4_5_OPUS',
  'claude-3.7-sonnet': 'MODEL_CLAUDE_3_7_SONNET',
  'claude-3-7-sonnet': 'MODEL_CLAUDE_3_7_SONNET',
  'claude-3.5-sonnet': 'MODEL_CLAUDE_3_5_SONNET',
  'claude-3-5-sonnet': 'MODEL_CLAUDE_3_5_SONNET',
  'gpt-oss-120b': 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
  'gpt-oss-120b-medium': 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
  'gemini-2.5-flash': 'MODEL_GOOGLE_GEMINI_2_5_FLASH',
  'gemini-2.5-flash-lite': 'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
  'gemini-2.5-flash-thinking': 'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
  'gemini-2.5-pro': 'MODEL_GOOGLE_GEMINI_2_5_PRO',
};

const KNOWN_MODEL_KEYWORDS = [
  'claude',
  'opus',
  'sonnet',
  'flash',
  'lite',
  'argon',
  'hydrogen',
  'neon',
  'carbon',
  'orchestrator',
  'gpt-oss',
  'gpt_oss',
  'gemini',
];

const UI_BADGE_TOKENS = new Set(['新', 'new', '注意', 'notice', 'unavailable', 'leaving', 'soon', 'deprecated', '即将下线', '即将停用', '即将移除', '1m', '2m']);

/**
 * 归一化模型标识或 UI 显示名（去括号、剥离 UI 状态与容量角标词并统一分隔符为连字符），用于跨表示法匹配
 */
export function normalizeModelLookupKey(modelId = '') {
  if (!modelId || typeof modelId !== 'string') return '';
  const normalized = modelId
    .trim()
    .toLowerCase()
    // 剥离 UI 容量后缀（如 "· 1M"、"· 256K"、"· 512K"、"(1M)"）
    .replace(/\s*[·•|]\s*\d+(?:\.\d+)?\s*[km]\b(?:\s*context)?/gi, ' ')
    .replace(/\(\s*\d+(?:\.\d+)?\s*[km]\b(?:\s*context)?\s*\)/gi, ' ')
    .replace(/[()（）·•|]/g, ' ')
    // 兼容紧凑拼接的中文状态词（如 "Medium新"、"Carbon注意"、"Medium即将下线"）
    .replace(/([a-z0-9])(注意|新|即将下线|即将停用|即将移除)(?=$|[\s_-])/g, '$1 $2')
    .replace(/(^|[\s_-])(注意|新|即将下线|即将停用|即将移除)([a-z0-9])/g, '$1$2 $3')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) return '';
  return normalized
    .split('-')
    .filter(token => token && !UI_BADGE_TOKENS.has(token))
    .join('-');
}

function lookupCustomOverride(customOverrides, cleanId) {
  if (!customOverrides || typeof customOverrides !== 'object') return undefined;
  if (Object.hasOwn(customOverrides, cleanId)) return customOverrides[cleanId];
  const upper = cleanId.toUpperCase();
  if (Object.hasOwn(customOverrides, upper)) return customOverrides[upper];
  const norm = normalizeModelLookupKey(cleanId);
  if (norm && Object.hasOwn(customOverrides, norm)) return customOverrides[norm];
  return undefined;
}

function lookupDynamicAlias(dynamicAliases, cleanId) {
  if (!dynamicAliases) return null;
  const upper = cleanId.toUpperCase();
  const norm = normalizeModelLookupKey(cleanId);
  if (dynamicAliases instanceof Map) {
    const val = dynamicAliases.get(cleanId) ||
      dynamicAliases.get(upper) ||
      (norm ? dynamicAliases.get(norm) : null) ||
      null;
    return typeof val === 'string' ? val : null;
  }
  if (typeof dynamicAliases === 'object') {
    if (Object.hasOwn(dynamicAliases, cleanId) && typeof dynamicAliases[cleanId] === 'string') return dynamicAliases[cleanId];
    if (Object.hasOwn(dynamicAliases, upper) && typeof dynamicAliases[upper] === 'string') return dynamicAliases[upper];
    if (norm && Object.hasOwn(dynamicAliases, norm) && typeof dynamicAliases[norm] === 'string') return dynamicAliases[norm];
  }
  return null;
}

function lookupDynamicLimit(dynamicLimits, cleanId) {
  if (!dynamicLimits || !cleanId) return undefined;
  const upper = cleanId.toUpperCase();
  const norm = normalizeModelLookupKey(cleanId);
  if (dynamicLimits instanceof Map) {
    const val = dynamicLimits.get(cleanId) ??
      dynamicLimits.get(upper) ??
      (norm ? dynamicLimits.get(norm) : undefined);
    return (typeof val === 'number' && Number.isFinite(val) && val > 0) ? val : undefined;
  }
  if (typeof dynamicLimits === 'object' && !(dynamicLimits instanceof Set)) {
    const raw = Object.hasOwn(dynamicLimits, cleanId)
      ? dynamicLimits[cleanId]
      : (Object.hasOwn(dynamicLimits, upper)
        ? dynamicLimits[upper]
        : (norm && Object.hasOwn(dynamicLimits, norm) ? dynamicLimits[norm] : undefined));
    return (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) ? raw : undefined;
  }
  return undefined;
}

export function resolveStaticCanonicalKey(modelId = '') {
  if (!modelId || typeof modelId !== 'string') return null;
  const cleanId = modelId.trim();
  if (!cleanId) return null;
  if (Object.hasOwn(PLATFORM_CONTEXT_LIMITS, cleanId)) return cleanId;
  const upper = cleanId.toUpperCase();
  if (Object.hasOwn(PLATFORM_CONTEXT_LIMITS, upper)) return upper;
  const norm = normalizeModelLookupKey(cleanId);
  if (norm && Object.hasOwn(MODEL_ID_ALIASES, norm)) {
    return MODEL_ID_ALIASES[norm];
  }
  if (norm && norm.startsWith('orchestrator-')) {
    const subModel = norm.slice('orchestrator-'.length);
    if (subModel.includes('argon')) return 'MODEL_PLACEHOLDER_M668';
    if (
      subModel.includes('neon') ||
      subModel.includes('hydrogen') ||
      subModel.includes('carbon') ||
      subModel.includes('gemini-4')
    ) {
      return 'MODEL_PLACEHOLDER_M537';
    }
    const subCanonical = resolveStaticCanonicalKey(subModel);
    if (subCanonical) return subCanonical;
    return 'MODEL_PLACEHOLDER_M537';
  }
  if (
    norm &&
    (
      /(?:^|-)claude-(?:(?:sonnet|opus)-)?(?:4(?:[.-]5)?|3[.-][57])(?=$|-)/.test(norm) ||
      /(?:^|-)claude-(?:4(?:[.-]5)?|3[.-][57])-(?:sonnet|opus)(?=$|-)/.test(norm)
    )
  ) {
    return 'MODEL_CLAUDE_4_SONNET';
  }
  return null;
}

function resolveCanonicalKey(cleanId, dynamicAliases = null) {
  const staticHit = resolveStaticCanonicalKey(cleanId);
  if (staticHit) return staticHit;
  if (dynamicAliases) {
    const aliasTarget = lookupDynamicAlias(dynamicAliases, cleanId);
    if (typeof aliasTarget === 'string' && aliasTarget.trim() && aliasTarget.trim() !== cleanId) {
      return resolveCanonicalKey(aliasTarget.trim(), null) || aliasTarget.trim();
    }
  }
  return null;
}

function hasDynamicModel(dynamicKnownModels, cleanId) {
  if (!dynamicKnownModels) return false;
  const norm = normalizeModelLookupKey(cleanId);
  if (dynamicKnownModels instanceof Set) {
    return dynamicKnownModels.has(cleanId) ||
      dynamicKnownModels.has(cleanId.toUpperCase()) ||
      (norm ? dynamicKnownModels.has(norm) : false);
  }
  if (dynamicKnownModels instanceof Map) {
    return dynamicKnownModels.has(cleanId) ||
      dynamicKnownModels.has(cleanId.toUpperCase()) ||
      (norm ? dynamicKnownModels.has(norm) : false);
  }
  if (typeof dynamicKnownModels === 'object') {
    return Object.hasOwn(dynamicKnownModels, cleanId) ||
      Object.hasOwn(dynamicKnownModels, cleanId.toUpperCase()) ||
      (norm ? Object.hasOwn(dynamicKnownModels, norm) : false);
  }
  return false;
}

/**
 * 判断模型是否已在显式配置、静态字典或动态目录中精确编目（不含宽泛关键词猜测）
 */
export function isCatalogedModel(
  modelId = '',
  customOverrides = {},
  dynamicAliases = null,
  dynamicKnownModels = null,
  dynamicLimits = null
) {
  if (!modelId || typeof modelId !== 'string') return false;
  const cleanId = modelId.trim();
  if (!cleanId) return false;
  if (lookupCustomOverride(customOverrides, cleanId) !== undefined) return true;
  if (resolveCanonicalKey(cleanId, dynamicAliases) !== null) return true;
  if (hasDynamicModel(dynamicKnownModels, cleanId)) return true;
  if (lookupDynamicLimit(dynamicLimits || dynamicAliases, cleanId) !== undefined) return true;
  return false;
}

/**
 * 判断指定模型是否为已知且明确匹配的模型
 */
export function isKnownModel(modelId = '', customOverrides = {}, dynamicKnownModels = null, dynamicLimits = null) {
  if (!modelId || typeof modelId !== 'string') return false;
  const cleanId = modelId.trim();
  if (!cleanId) return false;

  if (lookupCustomOverride(customOverrides, cleanId) !== undefined) return true;
  if (resolveCanonicalKey(cleanId) !== null) return true;
  if (hasDynamicModel(dynamicKnownModels, cleanId)) return true;
  if (lookupDynamicLimit(dynamicLimits || dynamicKnownModels, cleanId) !== undefined) return true;

  const idLower = cleanId.toLowerCase();
  return KNOWN_MODEL_KEYWORDS.some(kw => idLower.includes(kw));
}

/**
 * 根据模型 ID 或名称推导平台的上下文压缩阈值
 * 优先级：customOverrides > dynamicLimits > PLATFORM_CONTEXT_LIMITS > DEFAULT_PLATFORM_LIMIT
 * 严格遵照平台实际截断规则，杜绝用原生 1M/2M 窗口冒充平台阈值
 */
export function getPlatformTruncationLimit(modelId = '', customOverrides = {}, dynamicAliases = null, dynamicLimits = null) {
  if (!modelId || typeof modelId !== 'string') {
    return DEFAULT_PLATFORM_LIMIT;
  }
  const cleanId = modelId.trim();
  if (!cleanId) return DEFAULT_PLATFORM_LIMIT;

  // 1. 用户自定义覆盖优先 (customOverrides)
  const override = lookupCustomOverride(customOverrides, cleanId);
  if (typeof override === 'number' && override > 0) {
    return override;
  }

  const canonicalKey = resolveCanonicalKey(cleanId, dynamicAliases);
  if (canonicalKey) {
    const canonicalOverride = lookupCustomOverride(customOverrides, canonicalKey);
    if (typeof canonicalOverride === 'number' && canonicalOverride > 0) {
      return canonicalOverride;
    }
  }

  // 2. 运行态/动态自学习限额映射次之 (dynamicLimits，兼容第 3 或第 4 参数传入)
  const effectiveDynamicLimits = dynamicLimits || dynamicAliases;
  const directDynamicLimit = lookupDynamicLimit(effectiveDynamicLimits, cleanId);
  if (typeof directDynamicLimit === 'number' && directDynamicLimit > 0) {
    return directDynamicLimit;
  }
  if (canonicalKey) {
    const canonicalDynamicLimit = lookupDynamicLimit(effectiveDynamicLimits, canonicalKey);
    if (typeof canonicalDynamicLimit === 'number' && canonicalDynamicLimit > 0) {
      return canonicalDynamicLimit;
    }
  }

  // 3. 精确静态字典与规范化别名映射 (PLATFORM_CONTEXT_LIMITS)
  if (canonicalKey && Object.hasOwn(PLATFORM_CONTEXT_LIMITS, canonicalKey)) {
    return PLATFORM_CONTEXT_LIMITS[canonicalKey];
  }

  // 4. 平台统一在役截断基准（所有在役主力与未来新模型自适应兜底均为 256K）
  return DEFAULT_PLATFORM_LIMIT;
}

/**
 * 判断用户/调用方是否在 customOverrides 中为指定模型（或其别名/规范键）配置了显式自定义阈值
 */
export function hasCustomLimitOverride(modelId = '', customOverrides = {}, dynamicAliases = null) {
  if (!modelId || typeof modelId !== 'string' || !customOverrides || typeof customOverrides !== 'object') {
    return false;
  }
  const cleanId = modelId.trim();
  if (!cleanId) return false;
  const direct = lookupCustomOverride(customOverrides, cleanId);
  if (typeof direct === 'number' && direct > 0) {
    return true;
  }
  const canonicalKey = resolveCanonicalKey(cleanId, dynamicAliases);
  if (canonicalKey) {
    const canonicalOverride = lookupCustomOverride(customOverrides, canonicalKey);
    if (typeof canonicalOverride === 'number' && canonicalOverride > 0) {
      return true;
    }
  }
  return false;
}

/**
 * 将模型枚举 ID、UI 显示名或别名归纳到同一模型家族标识，用于运行时阈值覆盖时的防串切校验
 */
export function resolveModelFamilyKey(modelId = '', dynamicAliases = null) {
  if (!modelId || typeof modelId !== 'string') return '';
  const cleanId = modelId.trim();
  if (!cleanId) return '';
  const rawNorm = normalizeModelLookupKey(cleanId);
  const canonical = resolveCanonicalKey(cleanId, dynamicAliases);
  const norm = normalizeModelLookupKey(canonical || cleanId);
  if (!norm) return '';

  if (/(?:^|-)m(?:66[78]|537)(?=$|-)/.test(norm) || rawNorm.includes('orchestrator') || norm.includes('orchestrator')) {
    return 'FAMILY_ORCHESTRATOR';
  }
  if (/(?:^|-)m(?:52[5-9]|43[2-4])(?=$|-)/.test(norm) || norm.includes('hydrogen')) {
    return 'FAMILY_HYDROGEN';
  }
  if (/(?:^|-)m53[0-6](?=$|-)/.test(norm) || norm.includes('neon')) {
    return 'FAMILY_NEON';
  }
  if (/(?:^|-)m(?:41[7-9]|40[89]|41[0-3]|42[0-9]|43[01]|43[78])(?=$|-)/.test(norm) || norm.includes('argon')) {
    return 'FAMILY_ARGON';
  }
  if (/(?:^|-)m670(?=$|-)/.test(norm) || norm.includes('carbon')) {
    return 'FAMILY_CARBON';
  }
  if (
    /(?:^|-)m(?:31[7-9]|32[0-2]|669|124|301)(?=$|-)/.test(norm) ||
    norm.includes('gemini-3.8-flash') ||
    norm.includes('3.8-flash') ||
    norm.includes('3-8-flash') ||
    norm.includes('gemini-flash')
  ) {
    return 'FAMILY_FLASH_3_8';
  }
  if (/(?:^|-)m(?:84|20|187)(?=$|-)/.test(norm) || norm.includes('3.5-flash') || norm.includes('3-5-flash')) {
    return 'FAMILY_FLASH_3_5';
  }
  if (
    /(?:^|-)m(?:40[0-7]|341)(?=$|-)/.test(norm) ||
    norm.includes('claude-opus-5-5') ||
    norm.includes('claude-sonnet-5-5') ||
    norm.includes('claude-opus-5.5') ||
    norm.includes('claude-sonnet-5.5') ||
    norm.includes('claude-5-5') ||
    norm.includes('claude-5.5')
  ) {
    return 'FAMILY_CLAUDE_5_5';
  }
  if (
    norm.includes('claude-4') ||
    norm.includes('claude-sonnet-4') ||
    norm.includes('claude-opus-4') ||
    norm.includes('claude-3.7') ||
    norm.includes('claude-3-7') ||
    norm.includes('claude-3.5') ||
    norm.includes('claude-3-5')
  ) {
    return 'FAMILY_CLAUDE_4';
  }
  if (norm.includes('gpt-oss') || /(?:^|-)120b(?=$|-)/.test(norm)) {
    return 'FAMILY_GPT_OSS_120B';
  }
  if (/(?:^|-)m(?:50|18|148|198)(?=$|-)/.test(norm) || norm.includes('gemini-2.5') || norm.includes('gemini-2-5') || norm.includes('2.5-pro') || norm.includes('2.5-flash') || norm.includes('2-5-pro') || norm.includes('2-5-flash')) {
    return 'FAMILY_GEMINI_2_5';
  }
  if (/(?:^|-)m(?:26|35)(?=$|-)/.test(norm)) {
    return 'FAMILY_M26';
  }
  return canonical || norm;
}

/**
 * 判断两个模型标识是否属于同一模型家族（用于防止切换模型后旧步长上下文上限误覆盖新模型）
 */
export function isSameModelFamily(modelA = '', modelB = '', dynamicAliases = null) {
  const famA = resolveModelFamilyKey(modelA, dynamicAliases);
  const famB = resolveModelFamilyKey(modelB, dynamicAliases);
  if (!famA || !famB) return false;
  return famA === famB;
}

function isOrchestratorExecutionPartner(modelId = '', dynamicAliases = null) {
  if (!modelId || typeof modelId !== 'string') return false;
  const clean = modelId.trim();
  if (!clean) return false;
  const canonical = resolveCanonicalKey(clean, dynamicAliases);
  if (canonical === 'MODEL_PLACEHOLDER_M669') return true;
  const norm = normalizeModelLookupKey(canonical || clean);
  return /(?:^|-)m669(?=$|-)/.test(norm) || norm === 'gemini-flash-worker-agy' || norm === 'gemini-flash';
}

/**
 * 判断两个模型是否为同一会话下的 Plan-Execute 绑定搭档关系：
 * Orchestrator (Argon) (M667/M668) 在 plan-execute-config 中绑定执行模型 M669 (gemini-flash-worker-agy)，
 * 二者在单条轨迹中交替运行并共享同一累积上下文窗口。
 */
export function isPlanExecutePartnerModel(modelA = '', modelB = '', dynamicAliases = null) {
  if (!modelA || !modelB) return false;
  const famA = resolveModelFamilyKey(modelA, dynamicAliases);
  const famB = resolveModelFamilyKey(modelB, dynamicAliases);
  if (famA === 'FAMILY_ORCHESTRATOR' && isOrchestratorExecutionPartner(modelB, dynamicAliases)) {
    return true;
  }
  if (famB === 'FAMILY_ORCHESTRATOR' && isOrchestratorExecutionPartner(modelA, dynamicAliases)) {
    return true;
  }
  return false;
}

/**
 * 判断运行时尾游标模型与当前有效容量模型是否兼容（同模型族 或 Plan-Execute 绑定搭档）
 */
export function isCompatibleRuntimeModel(modelA = '', modelB = '', dynamicAliases = null) {
  if (isSameModelFamily(modelA, modelB, dynamicAliases)) return true;
  return isPlanExecutePartnerModel(modelA, modelB, dynamicAliases);
}

/**
 * 判断运行态尾游标 maxContextTokens 是否应覆盖当前解析出的容量上限：
 * - 同模型族或任一侧缺少模型标识时：运行态权威值全权覆盖（同时支持放开与收紧）
 * - 异构 Plan-Execute 搭档（如 M668 ⇄ M669）交叉时：仅在运行态限额不低于当前主分母时采纳，
 *   防止较低配额的执行子模型（如 Flash 256K）向下压低主规划模型（如 Argon 512K）造成分母抖动
 */
export function shouldApplyRuntimeLimit(
  capacityModel = '',
  runtimeModel = '',
  currentLimit = 0,
  runtimeLimit = 0,
  dynamicAliases = null
) {
  if (!Number.isSafeInteger(runtimeLimit) || runtimeLimit <= 0) {
    return false;
  }
  if (!runtimeModel || !capacityModel) {
    return true;
  }
  if (isSameModelFamily(capacityModel, runtimeModel, dynamicAliases)) {
    return true;
  }
  if (isPlanExecutePartnerModel(capacityModel, runtimeModel, dynamicAliases)) {
    return !(Number.isFinite(currentLimit) && currentLimit > 0) || runtimeLimit >= currentLimit;
  }
  return false;
}
