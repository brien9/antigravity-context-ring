import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokensFromText,
  processTrajectorySteps,
  StepType,
  SYSTEM_PROMPT_OVERHEAD,
} from '../sidecars/ring/context-calculator.mjs';
import {
  getPlatformTruncationLimit,
  isKnownModel,
  isCatalogedModel,
  normalizeModelLookupKey,
  MODEL_ID_ALIASES,
  resolveModelFamilyKey,
  isSameModelFamily,
  isPlanExecutePartnerModel,
  isCompatibleRuntimeModel,
} from '../sidecars/ring/model-limits.mjs';

test('estimateTokensFromText: 中英文字符权重准确计算', () => {
  // 12 个 ASCII 字符: 12 / 4 = 3 tokens
  assert.equal(estimateTokensFromText('Hello World!'), 3);

  // 6 个中文汉字: 6 / 1.5 = 4 tokens
  assert.equal(estimateTokensFromText('你好世界测试'), 4);

  // 空文本
  assert.equal(estimateTokensFromText(''), 0);
  assert.equal(estimateTokensFromText(null), 0);
});

test('getPlatformTruncationLimit: 严格映射平台真实截断阈值', () => {
  // Gemini 4 Hydrogen (线上 AICode Mendel 默认 256K 截断) - M525..M528 & M432..M434 & 别名 & 带 UI 徽章标签
  for (const id of [
    'MODEL_PLACEHOLDER_M525',
    'MODEL_PLACEHOLDER_M526',
    'MODEL_PLACEHOLDER_M527',
    'MODEL_PLACEHOLDER_M528',
    'MODEL_PLACEHOLDER_M432',
    'MODEL_PLACEHOLDER_M433',
    'MODEL_PLACEHOLDER_M434',
    'gemini-4-hydrogen',
    'gemini-4-hydrogen-high',
    'gemini-4-hydrogen-medium',
    'gemini-4-hydrogen-low',
    'gemini-4-hydrogen-xhigh',
    'Gemini 4 Hydrogen (Medium) 新',
  ]) {
    assert.equal(getPlatformTruncationLimit(id), 256_000, `${id} 默认线上基线必须映射为 256K`);
    assert.equal(isKnownModel(id), true, `${id} 必须识别为已知模型`);
  }

  // Gemini 4 Argon -> 256,000 (256k)
  assert.equal(getPlatformTruncationLimit('MODEL_PLACEHOLDER_M417'), 256_000);
  // Orchestrator (Argon) -> 256,000
  for (const id of ['MODEL_PLACEHOLDER_M667', 'MODEL_PLACEHOLDER_M668', 'gemini-pro-orchestrator-g1-pro', 'Orchestrator (Argon)']) {
    assert.equal(getPlatformTruncationLimit(id), 256_000, `${id} 必须映射为 256K`);
    assert.equal(isKnownModel(id), true, `${id} 必须识别为已知模型`);
  }
  // Gemini 4 Carbon -> 256,000
  for (const id of ['MODEL_PLACEHOLDER_M670', 'gemini-4-carbon-disabled', 'gemini-4-carbon-low', 'gemini-4-carbon-medium', 'gemini-4-carbon-high']) {
    assert.equal(getPlatformTruncationLimit(id), 256_000, `${id} 必须映射为 256K`);
    assert.equal(isKnownModel(id), true, `${id} 必须识别为已知模型`);
  }
  // Gemini 3.8 Flash High -> 256,000 (256k)
  assert.equal(getPlatformTruncationLimit('MODEL_PLACEHOLDER_M318'), 256_000);
  // Claude Opus/Sonnet 5.5 (含 max 别名) -> 256,000 (256k)
  for (const id of ['MODEL_PLACEHOLDER_M402', 'MODEL_PLACEHOLDER_M405', 'claude-opus-5-5-max', 'claude-opus-5.5-max']) {
    assert.equal(getPlatformTruncationLimit(id), 256_000, `${id} 必须映射为 256K`);
  }
  // GPT-OSS 120B -> 80,000
  for (const id of ['MODEL_OPENAI_GPT_OSS_120B_MEDIUM', 'gpt-oss-120b', 'gpt-oss-120b-medium', 'GPT-OSS 120B (Medium) 注意']) {
    assert.equal(getPlatformTruncationLimit(id), 80_000, `${id} 必须映射为 80K`);
    assert.equal(isKnownModel(id), true, `${id} 必须识别为已知模型`);
  }
  // Legacy M26 / M35 -> 160,000
  assert.equal(getPlatformTruncationLimit('MODEL_PLACEHOLDER_M26'), 160_000);
  assert.equal(getPlatformTruncationLimit('MODEL_PLACEHOLDER_M35'), 160_000);
  // Gemini 2.5 Flash / Pro & M50 / M18 / M148 / M198 -> 128,000
  for (const id of [
    'MODEL_GOOGLE_GEMINI_2_5_FLASH',
    'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
    'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
    'MODEL_GOOGLE_GEMINI_2_5_PRO',
    'MODEL_PLACEHOLDER_M50',
    'MODEL_PLACEHOLDER_M18',
    'MODEL_PLACEHOLDER_M148',
    'MODEL_PLACEHOLDER_M198',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
  ]) {
    assert.equal(getPlatformTruncationLimit(id), 128_000, `${id} 必须映射为 128K`);
    assert.equal(isKnownModel(id), true, `${id} 必须识别为已知模型`);
  }

  // 未知或未来新增模型自适应兜底 -> 256,000
  assert.equal(getPlatformTruncationLimit('MODEL_FUTURE_UNKNOWN'), 256_000);
  // 支持自定义覆盖 (customOverrides) 与动态别名映射 (dynamicAliases)
  assert.equal(getPlatformTruncationLimit('CUSTOM_MODEL', { 'CUSTOM_MODEL': 128_000 }), 128_000);
  assert.equal(
    getPlatformTruncationLimit('future-hydrogen-tier', {}, new Map([['future-hydrogen-tier', 'MODEL_PLACEHOLDER_M525']])),
    256_000
  );
  assert.equal(MODEL_ID_ALIASES['claude-opus-5-5-max'], 'MODEL_PLACEHOLDER_M402');
  assert.equal(normalizeModelLookupKey('Gemini 4 Hydrogen (Medium) (Unavailable)'), 'gemini-4-hydrogen-medium');
  assert.equal(resolveModelFamilyKey('MODEL_PLACEHOLDER_M525'), 'FAMILY_HYDROGEN');
  assert.equal(isSameModelFamily('MODEL_PLACEHOLDER_M525', 'Gemini 4 Hydrogen (Medium) 新'), true);
  assert.equal(isSameModelFamily('MODEL_PLACEHOLDER_M525', 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM'), false);
});

test('processTrajectorySteps: 空步骤或未初始化会话返回中性状态', () => {
  const result = processTrajectorySteps([]);
  assert.equal(result.ready, false);
  assert.equal(result.contextUsed, 0);
  assert.equal(result.usageRatio, 0);
  assert.equal(result.source, 'none');
});

test('processTrajectorySteps: 单个真实 Checkpoint 精准取值', () => {
  const steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 100_000,
          outputTokens: 2_000,
          cacheReadTokens: 40_000,
          cacheCreationTokens: 500,
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps);
  assert.equal(result.ready, true);
  // 真实 Cortex 协议：完整物理占用 = inputTokens(未缓存新增) + cacheReadTokens(缓存命中) + cacheCreationTokens(缓存创建) + outputTokens
  // = 100000 + 40000 + 500 + 2000 = 142500
  assert.equal(result.contextUsed, 142_500);
  assert.equal(result.inputTokens, 100_000);
  assert.equal(result.cacheReadTokens, 40_000);
  assert.equal(result.cacheCreationTokens, 500);
  assert.equal(result.contextLimit, 256_000);
  // 142500 / 256000 ≈ 0.556640625
  assert.ok(Math.abs(result.usageRatio - (142_500 / 256_000)) < 0.0001);
  assert.equal(result.isEstimated, false);
  assert.equal(result.compressionDetected, false);
});

test('processTrajectorySteps: Checkpoint 后的增量估算准确叠加', () => {
  const steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 100_000,
          outputTokens: 2_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    },
    {
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '这是用户追问的问题' // 9 个汉字 -> 9 / 1.5 = 6 tokens
      }
    },
    {
      type: StepType.PLANNER_RESPONSE,
      plannerResponse: {
        response: '这是回答文本', // 6 汉字 -> 4 tokens
        thinking: '思考中', // 3 汉字 -> 2 tokens
      }
    }
  ];

  const result = processTrajectorySteps(steps);
  assert.equal(result.ready, true);
  // 方案 C：已有快照时不再叠加本地字符估算的文本增量，结算前保持权威基准 100000 + 2000
  assert.equal(result.contextUsed, 102_000);
  assert.equal(result.isEstimated, false);

  // 服务端给出的 toolCallOutputTokens 仍需在结算前即时叠加
  const withTool = processTrajectorySteps([
    ...steps,
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', metadata: { toolCallOutputTokens: 30_000 } }
  ]);
  assert.equal(withTool.contextUsed, 132_000);
  assert.equal(withTool.isEstimated, true);
});

test('processTrajectorySteps: 上下文压缩识别 (Token 大幅下降)', () => {
  const steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 240_000, // 达到压缩线
          outputTokens: 2_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    },
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 50_000, // 压缩后锐减到 50,000
          outputTokens: 1_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps);
  assert.equal(result.ready, true);
  assert.equal(result.compressionDetected, true);
  assert.equal(result.compressionDrop, 190_000);
  assert.equal(result.contextUsed, 51_000);
});

test('processTrajectorySteps: 模型切换动态适配阈值', () => {
  const steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318', // 256K
          inputTokens: 64_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    },
    {
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '切换到自定义阈值模型',
        userConfig: {
          plannerConfig: {
            planModel: 'CUSTOM_TEST_MODEL' // 动态适配为 128K
          }
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps, { customLimits: { 'CUSTOM_TEST_MODEL': 128_000 } });
  assert.equal(result.ready, true);
  assert.equal(result.model, 'CUSTOM_TEST_MODEL');
  assert.equal(result.contextLimit, 128_000);
  // 64000 / 128000 = 50%
  assert.ok(result.usageRatio >= 0.5);
});

test('processTrajectorySteps: 会话撤销/回退自然恢复，不制造递增假象', () => {
  const step1 = {
    type: StepType.CHECKPOINT,
    metadata: {
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318',
        inputTokens: 50_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }
    }
  };
  const step2 = {
    type: StepType.USER_INPUT,
    userInput: { userResponse: '一段之后被撤销的内容' },
    metadata: { toolCallOutputTokens: 2_000 } // 方案 C：以服务端工具输出增量验证回退
  };

  const beforeUndo = processTrajectorySteps([step1, step2]);
  const afterUndo = processTrajectorySteps([step1]); // 用户在界面点击撤销/步骤被删除

  assert.ok(afterUndo.contextUsed < beforeUndo.contextUsed);
  assert.equal(afterUndo.contextUsed, 51_000);
});

test('processTrajectorySteps: 极限超长对话溢出触发 isOverLimit', () => {
  const steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318', // 256K
          inputTokens: 257_000, // 超过 256K
          outputTokens: 1_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps);
  assert.equal(result.ready, true);
  assert.equal(result.isOverLimit, true);
  assert.equal(result.usageRatio, 1); // 圆环按 100% 封闭渲染
  assert.equal(result.contextUsed, 258_000);
});

test('processTrajectorySteps: Planner 响应携带 modelUsage 时的压缩捕获', () => {
  const steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 200_000,
          outputTokens: 2_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    },
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 40_000, // 大幅回落
          outputTokens: 1_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps);
  assert.equal(result.ready, true);
  assert.equal(result.compressionDetected, true);
  assert.equal(result.compressionDrop, 160_000);
  assert.equal(result.contextUsed, 41_000);
});

test('processTrajectorySteps [阶段三]: 模型三层解耦，子 Agent 轻量模型严禁篡改主圆环分母', () => {
  const steps = [
    // 1. 用户在输入框中明确选择主模型 (自定义 128K 阈值)
    {
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '请帮我调研代码库并启动子 Agent',
        userConfig: {
          plannerConfig: {
            planModel: 'CUSTOM_MAIN_128K' // 主模型分母 128K
          }
        }
      }
    },
    // 2. 主模型生成 Checkpoint 快照
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'CUSTOM_MAIN_128K',
          inputTokens: 60_000,
          outputTokens: 1_000,
          cacheReadTokens: 10_000,
          cacheCreationTokens: 0,
        }
      }
    },
    // 3. 启动子 Agent (使用 Flash 256K 或轻量模型) 执行具体繁重调研
    {
      type: StepType.INVOKE_SUBAGENT,
      metadata: {
        generatorModel: 'MODEL_PLACEHOLDER_M318', // Flash 256K
        requestedModel: { model: 'MODEL_PLACEHOLDER_M318' },
        toolCallOutputTokens: 2_000
      }
    },
    // 4. 子 Agent 工具返回
    {
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        generatorModel: 'MODEL_PLACEHOLDER_M318',
      },
      plannerResponse: {
        response: '子 Agent 调研完毕',
        thinking: '整理报告',
      }
    }
  ];

  const result = processTrajectorySteps(steps, { customLimits: { 'CUSTOM_MAIN_128K': 128_000 } });
  assert.equal(result.ready, true);
  // 核心校验：分母必须牢牢锁定在用户主选的主模型 128K，绝不能被子 Agent 的 256K 冲垮！
  assert.equal(result.selectedModel, 'CUSTOM_MAIN_128K');
  assert.equal(result.contextLimit, 128_000);
  // 执行模型正确记录为子 Agent 的模型
  assert.equal(result.executionModel, 'MODEL_PLACEHOLDER_M318');
  assert.equal(result.checkpointModel, 'CUSTOM_MAIN_128K');
  // 权威用量: 60000 input + 10000 cacheRead + 1000 output + 2000 tool + 估算(11 汉字 -> 8 tokens) = 73008
  assert.ok(result.contextUsed > 72_000 && result.contextUsed < 75_000);
  // 占比应该基于 128K 分母: ~73008 / 128000 ≈ 57.0%
  assert.ok(result.usageRatio > 0.54 && result.usageRatio < 0.60);
});

test('processTrajectorySteps [阶段三]: Cache Read 与 Cache Creation 物理 Token 精准核算', () => {
  const steps = [
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: 50_000,
          outputTokens: 2_500,
          cacheReadTokens: 30_000,
          cacheCreationTokens: 1_200,
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps);
  assert.equal(result.ready, true);
  assert.equal(result.inputTokens, 50_000);
  assert.equal(result.outputTokens, 2_500);
  assert.equal(result.cacheReadTokens, 30_000);
  assert.equal(result.cacheCreationTokens, 1_200);
  // 权威物理占用总量: 50000 input + 30000 cacheRead + 1200 cacheCreation + 2500 output = 83700
  assert.equal(result.contextUsed, 83_700);
  assert.equal(result.stepCount, 1);
  assert.equal(result.lastStepIndex, 0);
});

test('processTrajectorySteps [阶段三]: 超长会话多步骤聚合与步数索引严密性', () => {
  const steps = [];
  // 构造 1500 个步骤的超长大数组
  for (let i = 0; i < 1500; i++) {
    steps.push({
      type: StepType.PLANNER_RESPONSE,
      plannerResponse: { response: 'a' }
    });
  }

  const result = processTrajectorySteps(steps, { selectedModel: 'MODEL_PLACEHOLDER_M318' });
  assert.equal(result.ready, true);
  assert.equal(result.stepCount, 1500);
  assert.equal(result.lastStepIndex, 1499);
  assert.equal(result.contextLimit, 256_000);
});

test('processTrajectorySteps [审查加固]: 未知模型无法识别时显式标记 isUnknownModel，不虚假包装', () => {
  const steps = [
    {
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '使用私有化微调模型',
        userConfig: {
          plannerConfig: { planModel: 'custom-internal-oss-qwen-72b-v2' }
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps);
  assert.equal(result.ready, true);
  assert.equal(result.isUnknownModel, true);
  assert.equal(result.contextLimit, 256_000); // 兜底 256K
});

test('processTrajectorySteps [审查加固]: 长会话被截断时必须显式输出 isTruncated，拒绝伪装精确', () => {
  const steps = [
    {
      type: StepType.USER_INPUT,
      userInput: { userResponse: '一段超长对话' }
    }
  ];

  const result = processTrajectorySteps(steps, { isTruncated: true });
  assert.equal(result.ready, true);
  assert.equal(result.isTruncated, true);
});

test('processTrajectorySteps: Hydrogen 256K / GPT-OSS 80K 真实截断线与 runtimeMaxContextTokens 校准及防串切保护', () => {
  // 1. Gemini 4 Hydrogen (线上默认 256K): 128,000 Tokens 占 50%，256,000 Tokens 触发超限
  const hydrogenRes = processTrajectorySteps([
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M525',
          inputTokens: 124_000,
          outputTokens: 4_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ]);
  assert.equal(hydrogenRes.contextLimit, 256_000);
  assert.equal(hydrogenRes.contextUsed, 128_000);
  assert.equal(hydrogenRes.usageRatio, 0.5);
  assert.equal(hydrogenRes.isOverLimit, false);

  // 2. GPT-OSS 120B (80K): 80,000 Tokens 触发 isOverLimit
  const ossRes = processTrajectorySteps([
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
          inputTokens: 78_000,
          outputTokens: 2_000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ]);
  assert.equal(ossRes.contextLimit, 80_000);
  assert.equal(ossRes.usageRatio, 1);
  assert.equal(ossRes.isOverLimit, true);

  // 3. options.dynamicModelAliases 透传：空步骤或有步骤时均通过动态别名解析真实截断上限
  const aliases = new Map([['custom-oss-alias', 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM']]);
  const emptyAliasRes = processTrajectorySteps([], {
    selectedModel: 'custom-oss-alias',
    dynamicModelAliases: aliases,
    dynamicKnownModels: new Set(['custom-oss-alias']),
  });
  assert.equal(emptyAliasRes.contextLimit, 80_000);
  assert.equal(emptyAliasRes.isUnknownModel, false);

  // 4. runtimeMaxContextTokens 运行时动态覆盖（如远端实验放开 Hydrogen 到 512K 或 840K，同族切换生效）
  const runtimeOverrideRes = processTrajectorySteps([
    {
      stepIndex: 0,
      type: StepType.USER_INPUT,
      userInput: { userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M526' } } }
    },
    {
      stepIndex: 1,
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M525',
          inputTokens: 256_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ], {
    runtimeMaxContextTokens: 512_000,
    runtimeContextModel: 'MODEL_PLACEHOLDER_M525',
  });
  assert.equal(runtimeOverrideRes.contextLimit, 512_000, '同族 Hydrogen 模型必须采纳运行时下发的 512K 上限');
  assert.equal(runtimeOverrideRes.usageRatio, 0.5);
  assert.equal(runtimeOverrideRes.isOverLimit, false);

  // 5. 防串切保护：用户刚切换到 GPT-OSS (80K) 发送请求，旧步尾游标仍指向 M525 (256K) 时，拒绝错覆盖
  const crossModelSwitchRes = processTrajectorySteps([
    {
      stepIndex: 0,
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M525',
          inputTokens: 40_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    },
    {
      stepIndex: 1,
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: 'switch to gpt-oss',
        userConfig: { plannerConfig: { planModel: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' } }
      }
    }
  ], {
    runtimeMaxContextTokens: 256_000,
    runtimeContextModel: 'MODEL_PLACEHOLDER_M525',
  });
  assert.equal(crossModelSwitchRes.selectedModel, 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
  assert.equal(crossModelSwitchRes.contextLimit, 80_000, '跨族切换后绝不允许旧模型的 runtimeMaxContextTokens 覆盖新模型上限');

  // 6. 用户显式 customLimits 优先级必须高于 runtimeMaxContextTokens
  const customPriorityRes = processTrajectorySteps([
    {
      stepIndex: 0,
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M525',
          inputTokens: 50_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ], {
    customLimits: { 'MODEL_PLACEHOLDER_M525': 100_000 },
    runtimeMaxContextTokens: 256_000,
    runtimeContextModel: 'MODEL_PLACEHOLDER_M525',
  });
  assert.equal(customPriorityRes.contextLimit, 100_000, '用户显式 customLimits 必须优先于 runtimeMaxContextTokens');
});

test('model-limits: 新内部模型别名、容量角标后缀剥离、Claude 4 (160K) 与 dynamicLimits 四级优先级验证', () => {
  // 1. 内部流转别名与 UI Extra / 1M 后缀完整映射为 256K 且精确编目
  for (const id of [
    'gemini-4-argon-trial',
    'gemini-flash-worker-agy',
    'Gemini Flash',
    'gemini-3.8-flash-tiered',
    'gemini-3.5-flash-lite',
    'gemini-4-hydrogen-extra',
    'Gemini 4 Hydrogen (Extra) 新',
    'Claude Opus 5.5 Extra · 1M',
    'Claude Sonnet 5.5 (Extra) · 256K',
    'Claude Opus 5.5 (High) (1M)',
  ]) {
    assert.equal(getPlatformTruncationLimit(id), 256_000, `${id} 必须映射为 256K`);
    assert.equal(isKnownModel(id), true, `${id} 必须识别为已知模型`);
    assert.equal(isCatalogedModel(id), true, `${id} 必须识别为已编目模型`);
  }

  // 2. Claude 4 / 4.5 / 3.7 / 3.5 系列映射为 160K，与前端对齐
  for (const id of [
    'MODEL_CLAUDE_4_SONNET',
    'MODEL_CLAUDE_4_5_SONNET',
    'claude-4-sonnet',
    'claude-4.5-sonnet',
    'Claude 4 Sonnet',
    'Claude 4.5 Sonnet (High)',
    'claude-3.7-sonnet',
    'claude-3.5-sonnet',
  ]) {
    assert.equal(getPlatformTruncationLimit(id), 160_000, `${id} 必须映射为 160K`);
    assert.equal(isKnownModel(id), true);
    assert.equal(isCatalogedModel(id), true);
  }

  // 3. 容量角标剥离且不误伤自定义模型 ID
  assert.equal(normalizeModelLookupKey('Claude Opus 5.5 Extra · 1M'), 'claude-opus-5.5-extra');
  assert.equal(normalizeModelLookupKey('Gemini 4 Hydrogen (Extra) · 256K'), 'gemini-4-hydrogen-extra');
  assert.equal(normalizeModelLookupKey('CUSTOM_MAIN_128K'), 'custom-main-128k');

  // 4. getPlatformTruncationLimit 优先级：customOverrides > dynamicLimits > PLATFORM_CONTEXT_LIMITS > DEFAULT_PLATFORM_LIMIT
  const dynLimits = new Map([
    ['MODEL_PLACEHOLDER_M402', 840_000],
    ['future-quantum-model', 512_000],
  ]);
  const dynAliases = new Map([
    ['Claude Opus 5.5 (High)', 'MODEL_PLACEHOLDER_M402'],
  ]);
  assert.equal(
    getPlatformTruncationLimit('MODEL_PLACEHOLDER_M402', {}, dynAliases, dynLimits),
    840_000,
    'dynamicLimits (840K) 必须优先于静态 PLATFORM_CONTEXT_LIMITS (256K)'
  );
  assert.equal(
    getPlatformTruncationLimit('Claude Opus 5.5 (High)', {}, dynAliases, dynLimits),
    840_000,
    '通过别名解析到 M402 后同样应命中 dynamicLimits (840K)'
  );
  assert.equal(
    getPlatformTruncationLimit('MODEL_PLACEHOLDER_M402', { 'MODEL_PLACEHOLDER_M402': 200_000 }, dynAliases, dynLimits),
    200_000,
    'customOverrides (200K) 必须优先于 dynamicLimits (840K)'
  );
  assert.equal(
    getPlatformTruncationLimit('future-quantum-model', {}, null, dynLimits),
    512_000,
    '未在静态表中的新模型应直接命中 dynamicLimits (512K)'
  );

  // 5. Plan-Execute 绑定搭档关系验证
  assert.equal(isPlanExecutePartnerModel('MODEL_PLACEHOLDER_M668', 'MODEL_PLACEHOLDER_M669'), true);
  assert.equal(isPlanExecutePartnerModel('Orchestrator (Argon)', 'gemini-flash-worker-agy'), true);
  assert.equal(isPlanExecutePartnerModel('MODEL_PLACEHOLDER_M667', 'Gemini Flash'), true);
  assert.equal(isPlanExecutePartnerModel('MODEL_PLACEHOLDER_M668', 'MODEL_PLACEHOLDER_M318'), false);
  assert.equal(isCompatibleRuntimeModel('MODEL_PLACEHOLDER_M668', 'MODEL_PLACEHOLDER_M669'), true);
});

test('processTrajectorySteps: Swarm Worker 0 USER_INPUT 独立会话（SYSTEM_MESSAGE 估算与权威快照覆盖借用模型）', () => {
  // 1. 首轮尚无快照时，CORTEX_STEP_TYPE_SYSTEM_MESSAGE 文本必须纳入估算
  const briefText = 'You have just started. Your assignment is recorded on the board for @worker-1.';
  const initialWorkerSteps = [
    {
      stepIndex: 0,
      type: StepType.SYSTEM_MESSAGE,
      systemMessage: { message: briefText }
    },
    {
      stepIndex: 1,
      type: StepType.PLANNER_RESPONSE,
      plannerResponse: { response: 'Reading the board now.' }
    }
  ];
  const estRes = processTrajectorySteps(initialWorkerSteps);
  const expectedEst = SYSTEM_PROMPT_OVERHEAD +
    estimateTokensFromText(briefText) +
    estimateTokensFromText('Reading the board now.');
  assert.equal(estRes.ready, true);
  assert.equal(estRes.source, 'estimated');
  assert.equal(estRes.contextUsed, expectedEst, 'SYSTEM_MESSAGE 文本必须计入首轮无快照时的估算');

  // 2. Worker 会话 0 USER_INPUT，前端 DOM 从主窗格借用了错误的 GPT-OSS (80K) 作为 options.selectedModel，
  //    但 Worker 自身权威快照明确运行在 MODEL_PLACEHOLDER_M525 (Hydrogen) 且尾游标下发 512K：
  //    必须由权威快照重锚定 selectedModel，并正常采纳 512K runtimeMaxContextTokens！
  const activeWorkerSteps = [
    ...initialWorkerSteps,
    {
      stepIndex: 2,
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M525',
          inputTokens: 90_000,
          outputTokens: 2_000,
          cacheReadTokens: 36_000,
          cacheCreationTokens: 0,
        }
      },
      plannerResponse: { response: 'Done.' }
    }
  ];
  const workerRes = processTrajectorySteps(activeWorkerSteps, {
    selectedModel: 'GPT-OSS 120B (Medium)', // 模拟前端从主窗格误借的 80K 提示
    runtimeMaxContextTokens: 512_000,
    runtimeContextModel: 'MODEL_PLACEHOLDER_M525',
  });
  assert.equal(workerRes.selectedModel, 'MODEL_PLACEHOLDER_M525', '0 USER_INPUT 的 Worker 会话必须由权威快照覆盖外部借用的错误 selectedModel');
  assert.equal(workerRes.contextLimit, 512_000, '重锚定为 M525 后必须解除 80K 锁死并成功应用 512K 运行时限额');
  assert.equal(workerRes.contextUsed, 128_000);
  assert.equal(workerRes.usageRatio, 0.25);
  assert.equal(workerRes.isOverLimit, false);
});

test('processTrajectorySteps: Orchestrator (Argon) (M668 <-> M669) 双模型交替执行防篡改、尾游标校准与压缩断崖捕获', () => {
  // 模拟实机 Orchestrator 会话：
  // Step 0: USER_INPUT 指定 M668
  // Step 1: Plan 步 (M668, 30K)
  // Step 2: USER_INPUT (未携带 planModel)
  // Step 3: Execute 步 (M669, 180K) -> 不得将 selectedModel 篡改为 M669！
  // Step 4: Plan 步触发自动压缩 (M668, 40K, 暴跌 140K) -> 不得因 M669->M668 视为切模型而漏报压缩！
  const orchSteps = [
    {
      stepIndex: 0,
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '设计并实现完整模块',
        userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M668' } }
      }
    },
    {
      stepIndex: 1,
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M668',
          inputTokens: 30_000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    },
    {
      stepIndex: 2,
      type: StepType.USER_INPUT,
      userInput: { userResponse: '继续执行任务' } // 未携带 plannerConfig
    },
    {
      stepIndex: 3,
      type: StepType.CHECKPOINT,
      metadata: {
        generatorModel: 'MODEL_PLACEHOLDER_M669',
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M669',
          inputTokens: 30_000,
          outputTokens: 1_000,
          cacheReadTokens: 150_000,
          cacheCreationTokens: 0,
        }
      }
    },
  ];

  // 1. 处于 M669 执行步时：selectedModel 仍保持 M668，且允许 M669 尾游标校准分母
  const midExecRes = processTrajectorySteps(orchSteps, {
    runtimeMaxContextTokens: 512_000,
    runtimeContextModel: 'MODEL_PLACEHOLDER_M669',
  });
  assert.equal(midExecRes.selectedModel, 'MODEL_PLACEHOLDER_M668', 'M669 执行子模型严禁篡改主模型 M668');
  assert.equal(midExecRes.executionModel, 'MODEL_PLACEHOLDER_M669');
  assert.equal(midExecRes.checkpointModel, 'MODEL_PLACEHOLDER_M669');
  assert.equal(midExecRes.contextLimit, 512_000, 'M669 尾游标必须被识别为 M668 的兼容搭档并成功校准分母');
  assert.equal(midExecRes.compressionDetected, false);

  // 2. 从 M669 (180K input) 切回 M668 (40K input) 时发生压缩断崖：必须准确捕获压缩
  const afterCompressSteps = [
    ...orchSteps,
    {
      stepIndex: 4,
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M668',
          inputTokens: 40_000,
          outputTokens: 800,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
      }
    }
  ];
  const compressedRes = processTrajectorySteps(afterCompressSteps);
  assert.equal(compressedRes.selectedModel, 'MODEL_PLACEHOLDER_M668');
  assert.equal(compressedRes.compressionDetected, true, 'M669 -> M668 交界处的真实压缩断崖绝不能被误判为切模型而吞掉');
  assert.equal(compressedRes.compressionDrop, 140_000);
  assert.equal(compressedRes.contextUsed, 40_800);
});
