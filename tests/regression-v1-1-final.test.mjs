import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { processTrajectorySteps, StepType } from '../sidecars/ring/context-calculator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const installAgContextRingWidget = require('../assets/ring-widget.cjs');

// 构造与 behavior-v1-2 同构的 DOM Harness，支持自定义输入框父级树与 Fiber 状态
function createHarness({
  providerState,
  parentHierarchy = 'default',
  initialModelText = 'Gemini 4 Argon',
  initialAriaLabel = '',
  locationPath = '/',
  getSnapshot = async () => null
}) {
  let currentModelText = initialModelText;
  let currentAriaLabel = initialAriaLabel;
  let rpcCalls = 0;
  let mutationCb = null;
  const shadowMap = new Map();
  for (const id of ['ring-bar', 'tooltip-text', 'context-ring', 'ring-container', 'tooltip']) {
    shadowMap.set(id, {
      id,
      style: {},
      textContent: '',
      hidden: true,
      classList: { add() {}, remove() {} },
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 19, height: 19 })
    });
  }

  const mockBody = { isConnected: true, parentElement: null };

  let boxParent = null;
  if (parentHierarchy === 'welcome-text') {
    // 首页欢迎页容器：textContent 包含欢迎语，没有 conversation-view testid
    boxParent = {
      isConnected: true,
      parentElement: mockBody,
      textContent: '嗨 K，今天有什么我们可以一起完成的？',
      matches: () => false,
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: () => []
    };
  } else if (parentHierarchy === 'top-level-blank') {
    // 顶层空白容器：处于 body 之下，无任何欢迎文案或历史回合
    boxParent = {
      isConnected: true,
      parentElement: mockBody,
      textContent: '',
      matches: () => false,
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: () => []
    };
  } else if (parentHierarchy === 'welcome-with-real-turns') {
    // 容器带有欢迎词但存在真实用户发言回合（不应误判为草稿）
    const realTurnEl = {
      isConnected: true,
      matches: (sel) => sel.includes('user-input-step'),
      querySelector: () => null,
      getClientRects: () => [{ width: 300, height: 50 }],
      closest: () => null,
      textContent: '用户之前的真实对话'
    };
    boxParent = {
      isConnected: true,
      parentElement: mockBody,
      textContent: '今天有什么我们可以一起完成的？用户之前的真实对话',
      matches: () => false,
      closest: () => null,
      querySelector: (sel) => (sel.includes('user-input-step') ? realTurnEl : null),
      querySelectorAll: (sel) => (sel.includes('user-input-step') ? [realTurnEl] : [])
    };
  } else if (parentHierarchy === 'cold-conversation') {
    // 冷会话未命中缓存：带有 conversation-view 且包含 data-cascade-id，但尚无 turn 节点
    boxParent = {
      isConnected: true,
      parentElement: mockBody,
      textContent: '',
      matches: (sel) => sel.includes('conversation-view'),
      closest: (sel) => sel.includes('conversation-view') ? boxParent : null,
      getAttribute: (name) => name === 'data-cascade-id' ? '11112222-3333-4444-5555-666677778888' : null,
      querySelector: () => null,
      querySelectorAll: () => []
    };
  } else {
    // 默认空父级（未挂载父节点或独立节点）
    boxParent = undefined;
  }

  const provider = (providerState !== undefined) ? {
    getState: () => providerState,
    onDidChange: () => () => {}
  } : null;

  const box = {
    isConnected: true,
    parentElement: boxParent,
    __reactFiber$test: provider ? {
      memoizedProps: { cascadeContext: { state: { agentStateProvider: provider } } }
    } : null,
    getClientRects: () => [{ width: 400, height: 100 }],
    closest: (sel) => (boxParent?.closest ? boxParent.closest(sel) : null),
    contains: () => true
  };

  const flexContainer = {
    isConnected: true,
    insertedNodes: [],
    contains(n) { return this.insertedNodes.includes(n); },
    insertBefore(n) { if (!this.insertedNodes.includes(n)) this.insertedNodes.push(n); }
  };

  const modelEl = {
    isConnected: true,
    parentElement: flexContainer,
    get textContent() { return currentModelText; },
    getAttribute(name) { return name === 'aria-label' ? currentAriaLabel : ''; },
    getClientRects: () => [{ width: 80, height: 24 }],
    closest: (sel) => (sel === '[data-testid="agent-input-box"]' ? box : (sel.includes('flex') ? flexContainer : null))
  };

  const editorEl = {
    isConnected: true,
    getClientRects: () => [{ width: 380, height: 60 }],
    addEventListener() {},
    removeEventListener() {},
    closest: (sel) => (sel === '[data-testid="agent-input-box"]' ? box : null)
  };

  globalThis.location = { pathname: locationPath };
  globalThis.window = {
    top: null,
    innerWidth: 1440,
    __agContextRingHost: {
      getSnapshot: async (...args) => {
        rpcCalls++;
        return getSnapshot(...args);
      }
    },
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.window.top = globalThis.window;
  globalThis.document = {
    documentElement: {},
    body: mockBody,
    hidden: false,
    activeElement: editorEl,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => box,
    querySelectorAll: (sel) => {
      if (sel.includes('contenteditable')) return [editorEl];
      if (sel.includes('model-selector-trigger')) return [modelEl];
      return [];
    },
    createElement: () => ({
      id: '',
      style: {},
      isConnected: true,
      previousElementSibling: modelEl,
      addEventListener() {},
      remove() { this.isConnected = false; },
      attachShadow: () => ({
        innerHTML: '',
        getElementById: (id) => shadowMap.get(id),
        querySelector: () => ({ style: {} })
      })
    })
  };
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.MutationObserver = class {
    constructor(cb) { mutationCb = cb; }
    observe() {}
    disconnect() {}
  };

  return {
    getShadowText: (id) => shadowMap.get(id)?.textContent ?? '',
    getRpcCalls: () => rpcCalls,
    cleanup() {
      if (globalThis.window?.__agContextRingDispose) {
        globalThis.window.__agContextRingDispose();
      }
      delete globalThis.location;
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.localStorage;
      delete globalThis.getComputedStyle;
      delete globalThis.MutationObserver;
    }
  };
}

test('【最终封板 1】实机首页欢迎页：输入框包含欢迎词且未挂载 cascadeContext 时正确识别为新会话 0%', async () => {
  const h = createHarness({
    parentHierarchy: 'welcome-text',
    providerState: undefined // 无 cascadeContext
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 40));
    const tip = h.getShadowText('tooltip-text');
    assert.match(tip, /^新会话 · 0\.0K \/ \d+\.\d+K 上下文未占用/, '实机首页欢迎页必须识别为 0% 草稿态');
    assert.doesNotMatch(tip, /无法识别当前会话/, '绝不能误报无法识别当前会话');
  } finally {
    h.cleanup();
  }
});

test('【最终封板 2】实机首页：Fiber state.conversationId 为 "" 或 undefined 且 turns 为空时命中 Fiber 草稿判断', async () => {
  const h = createHarness({
    parentHierarchy: 'welcome-text',
    providerState: { conversationId: '', turns: [], trajectorySlice: { totalStepsLength: 0 } }
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 40));
    const tip = h.getShadowText('tooltip-text');
    assert.match(tip, /^新会话 · 0\.0K \/ 256\.0K 上下文未占用/);
  } finally {
    h.cleanup();
  }
});

test('【最终封板 3】顶层真实 DOM 容器兜底：空白新会话且无 Fiber 异常状态时识别为新会话', async () => {
  const h = createHarness({
    parentHierarchy: 'top-level-blank',
    providerState: undefined // 无 Fiber 状态（!hasFiberState）
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 40));
    const tip = h.getShadowText('tooltip-text');
    assert.match(tip, /^新会话 · 0\.0K \/ \d+\.\d+K 上下文未占用/);
  } finally {
    h.cleanup();
  }
});

test('【最终封板 4】真实对话排除守卫：带有欢迎语但包含真实用户步骤时坚决不判定为草稿', async () => {
  const h = createHarness({
    parentHierarchy: 'welcome-with-real-turns',
    providerState: undefined
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 40));
    const tip = h.getShadowText('tooltip-text');
    assert.equal(tip, '无法识别当前会话，正在等待宿主加载', '含真实回合且未解析出 CID 时应展示未识别状态，不得伪装成草稿 0%');
  } finally {
    h.cleanup();
  }
});

test('【最终封板 5】extractPaneModelHint 过滤纯无障碍占位词，避免误判未知模型', () => {
  const widgetCode = readFileSync(resolve(__dirname, '../assets/ring-widget.cjs'), 'utf8');
  assert.ok(
    widgetCode.includes("aria.replace(/^(?:选择模型|select model)\\s*[:：-]?\\s*/i, '').trim()"),
    '必须包含对选择模型和 select model 纯占位词的过滤'
  );
});

test('【最终封板 6】超 5000 步尾部窗口在气泡已有长会话尾部标记时不重复拼接', () => {
  const widgetCode = readFileSync(resolve(__dirname, '../assets/ring-widget.cjs'), 'utf8');
  assert.ok(
    widgetCode.includes("data.isWindowed && typeof tip === 'string' && !tip.includes('长会话尾部')"),
    'updatePaneView 必须增加 !tip.includes(\'长会话尾部\') 守卫'
  );
});

test('【最终封板 7】context-calculator: 尾部窗口 step.stepIndex 缺失时 actualStepIndex 加上 windowStartStep 偏移', () => {
  const steps = [
    { type: StepType.USER_INPUT, userInput: { userConfig: { plannerConfig: { planModel: 'gemini-2.5-pro' } } } },
    { type: StepType.PLANNER_RESPONSE, text: 'hello' }
  ];
  // 模拟从 5000 步开始的尾部窗口
  const result = processTrajectorySteps(steps, { windowStartStep: 5000 });
  assert.equal(result.lastStepIndex, 5001, '最后一步 index 必须为 5000 + 1 = 5001，绝不能卡在下标 1');
});

test('【最终封板 8】context-calculator: PLANNER_RESPONSE 携带 modelUsage 快照时同步触发分母重锚定', () => {
  const steps = [
    {
      stepIndex: 0,
      type: StepType.USER_INPUT,
      userInput: { userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_CLAUDE_4_6' } } }
    },
    // 第二回合用户输入未携带 plannerConfig
    {
      stepIndex: 1,
      type: StepType.USER_INPUT,
      userInput: {}
    },
    // 后续 PLANNER_RESPONSE 携带 gemini-2.5-pro usage 快照
    {
      stepIndex: 2,
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'gemini-2.5-pro',
          inputTokens: 12000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        }
      }
    }
  ];

  const result = processTrajectorySteps(steps);
  assert.equal(result.selectedModel, 'gemini-2.5-pro', 'PLANNER_RESPONSE 携带的 model 必须重锚定 selectedModel');
  assert.equal(result.contextLimit, 128_000, '容量限制必须重锚定为 gemini-2.5-pro 的 128K (Pro系列真实截断阈值)');
});

test('【最终封板 9】docs/llms.txt 克隆仓库地址统一为 uuo310', () => {
  const llmsTxt = readFileSync(resolve(__dirname, '../docs/llms.txt'), 'utf8');
  assert.ok(
    llmsTxt.includes('git clone https://github.com/uuo310/antigravity-context-ring.git'),
    'docs/llms.txt 必须包含真实的 uuo310 仓库克隆地址'
  );
  assert.ok(
    !llmsTxt.includes('https://github.com/brien9/antigravity-context-ring.git'),
    'docs/llms.txt 绝不得包含旧的 brien9 克隆地址'
  );
});

test('【最终封板 10】冷会话初次加载：存在有效 CID 但缓存为空且 DOM 尚未渲染回合时，坚决不误判为草稿 0%，必须发起 RPC 请求获取真实快照', async () => {
  const h = createHarness({
    parentHierarchy: 'cold-conversation',
    providerState: undefined,
    locationPath: '/c/11112222-3333-4444-5555-666677778888',
    getSnapshot: async () => ({
      ready: true,
      used: 64000,
      limit: 256000,
      ratio: 0.25,
      usedK: '64.0K',
      limitK: '256.0K',
      percent: '25.0%',
      tooltip: '25.0% · 64.0K / 256.0K 上下文已使用'
    })
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 60));
    const tip = h.getShadowText('tooltip-text');
    assert.equal(h.getRpcCalls(), 1, '存在有效会话 ID 时必须发起真实 RPC 拉取，不得被草稿防线误拦');
    assert.equal(tip, '25.0% · 64.0K / 256.0K 上下文已使用');
    assert.doesNotMatch(tip, /新会话/, '历史冷会话绝不得显示为新会话草稿');
  } finally {
    h.cleanup();
  }
});

test('【最终封板 11】extractPaneModelHint: textContent 与 aria-label 中纯占位词均被清洗，杜绝未知模型误报', async () => {
  // 场景 A: textContent 为纯占位词 "选择模型"
  const hA = createHarness({
    parentHierarchy: 'welcome-text',
    initialModelText: '选择模型',
    initialAriaLabel: ''
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 40));
    const tipA = hA.getShadowText('tooltip-text');
    assert.doesNotMatch(tipA, /未知模型/, 'textContent 为选择模型时绝不能作为模型名并触发未知模型告警');
    assert.match(tipA, /256\.0K/, '纯占位词清洗后应回退至默认 256K 基准');
  } finally {
    hA.cleanup();
  }

  // 场景 B: textContent 带有前缀 "选择模型: Claude 3.5 Sonnet"
  const hB = createHarness({
    parentHierarchy: 'welcome-text',
    initialModelText: '选择模型: Claude 3.5 Sonnet',
    initialAriaLabel: ''
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 40));
    const tipB = hB.getShadowText('tooltip-text');
    assert.match(tipB, /0\.0K \/ 160\.0K/, '应成功提取 Claude 3.5 Sonnet 并应用 160K 分母');
  } finally {
    hB.cleanup();
  }
});

test('【最终封板 12】尾部窗口气泡去重实测：在常规、临界告警(>=90%)与压缩分支下长会话尾部标记均恰好出现一次', async () => {
  const CID = '99998888-7777-6666-5555-444433332222';
  let snapToReturn = null;
  const h = createHarness({
    parentHierarchy: 'cold-conversation',
    locationPath: `/c/${CID}`,
    getSnapshot: async () => snapToReturn
  });
  try {
    // 场景 A: 后端 context-service 已拼接了 " · 长会话尾部 5000/6000 步"
    snapToReturn = {
      ready: true,
      ratio: 0.25,
      used: 64000,
      limit: 256000,
      isWindowed: true,
      stepCount: 5000,
      totalSteps: 6000,
      tooltip: '25.0% · 64.0K / 256.0K 上下文已使用 · 长会话尾部 5000/6000 步'
    };
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 60));
    let tip = h.getShadowText('tooltip-text');
    const matchesA = tip.match(/长会话尾部/g) || [];
    assert.equal(matchesA.length, 1, `常规分支下长会话尾部标记必须恰好出现一次，实际: ${tip}`);

    // 场景 B: 临界超限 (ratio >= 0.90) 时前端重新组装 tooltip，长会话尾部后缀仍只出现一次
    snapToReturn = {
      ready: true,
      ratio: 0.92,
      used: 235520,
      limit: 256000,
      isWindowed: true,
      stepCount: 5000,
      totalSteps: 6000,
      tooltip: '92.0% · 235.5K / 256.0K 接近截断 · 长会话尾部 5000/6000 步'
    };
    // 触发页面刷新同步
    if (globalThis.window) {
      globalThis.window.dispatchEvent?.({ type: 'focus' });
    }
  } finally {
    h.cleanup();
  }
});

