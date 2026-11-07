import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokensFromText,
  processTrajectorySteps,
  StepType
} from '../sidecars/ring/context-calculator.mjs';
import { getPlatformTruncationLimit } from '../sidecars/ring/model-limits.mjs';

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
  // Gemini 3.8 Flash High -> 256,000 (256k)
  assert.equal(getPlatformTruncationLimit('MODEL_PLACEHOLDER_M318'), 256_000);
  // Gemini 3.1 Pro -> 128,000 (128k)
  assert.equal(getPlatformTruncationLimit('MODEL_PLACEHOLDER_M16'), 128_000);
  // Claude 4.6 Thinking -> 160,000 (160k)
  assert.equal(getPlatformTruncationLimit('MODEL_PLACEHOLDER_M35'), 160_000);
  // Claude 5.5 -> 256,000 (256k)
  assert.equal(getPlatformTruncationLimit('MODEL_PLACEHOLDER_M402'), 256_000);
  // GPT-OSS 120B -> 80,000 (80k)
  assert.equal(getPlatformTruncationLimit('MODEL_OPENAI_GPT_OSS_120B_MEDIUM'), 80_000);
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
        userResponse: '切换到 Pro 模型',
        userConfig: {
          plannerConfig: {
            planModel: 'MODEL_PLACEHOLDER_M16' // 切换为 128K
          }
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps);
  assert.equal(result.ready, true);
  assert.equal(result.model, 'MODEL_PLACEHOLDER_M16');
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
    // 1. 用户在输入框中明确选择 Pro 模型 (128K)
    {
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '请帮我调研代码库并启动子 Agent',
        userConfig: {
          plannerConfig: {
            planModel: 'MODEL_PLACEHOLDER_M16' // Pro 128K
          }
        }
      }
    },
    // 2. 主模型生成 Checkpoint 快照
    {
      type: StepType.CHECKPOINT,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M16',
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

  const result = processTrajectorySteps(steps);
  assert.equal(result.ready, true);
  // 核心校验：分母必须牢牢锁定在用户主选的 Pro 128K，绝不能被子 Agent 的 256K 冲垮！
  assert.equal(result.selectedModel, 'MODEL_PLACEHOLDER_M16');
  assert.equal(result.contextLimit, 128_000);
  // 执行模型正确记录为子 Agent 的模型
  assert.equal(result.executionModel, 'MODEL_PLACEHOLDER_M318');
  assert.equal(result.checkpointModel, 'MODEL_PLACEHOLDER_M16');
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
