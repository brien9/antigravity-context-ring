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

  const result = processTrajectorySteps(steps, { customLimits: { 'gemini-2.5-pro': 128_000 } });
  assert.equal(result.selectedModel, 'gemini-2.5-pro', 'PLANNER_RESPONSE 携带的 model 必须重锚定 selectedModel');
  assert.equal(result.contextLimit, 128_000, '容量限制必须重锚定为 gemini-2.5-pro 的 128K (Pro系列真实截断阈值)');
});

test('【最终封板 9】docs/llms.txt 克隆仓库地址统一为当前活跃账号 brien9', () => {
  const llmsTxt = readFileSync(resolve(__dirname, '../docs/llms.txt'), 'utf8');
  assert.ok(
    llmsTxt.includes('git clone https://github.com/brien9/antigravity-context-ring.git'),
    'docs/llms.txt 必须包含当前活跃的 brien9 仓库克隆地址'
  );
  assert.ok(
    !llmsTxt.includes('https://github.com/uuo310/antigravity-context-ring.git'),
    'docs/llms.txt 绝不得包含旧的 uuo310 残留链接'
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

  // 场景 B: textContent 带有前缀 "选择模型: Claude Sonnet 5.5"
  const hB = createHarness({
    parentHierarchy: 'welcome-text',
    initialModelText: '选择模型: Claude Sonnet 5.5',
    initialAriaLabel: ''
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 40));
    const tipB = hB.getShadowText('tooltip-text');
    assert.match(tipB, /0\.0K \/ 256\.0K/, '应成功提取 Claude Sonnet 5.5 并应用 256K 分母');
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

test('【最终封板 13】侧边 /btw (sideQuestionView) 独立生命周期：草稿防父会话 Fiber 串台、hideModelSelector 挂载、借用主模型提示与分叉轨迹计算', async () => {
  const PARENT_CID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  const CHILD_CID = '502ca08b-fa3f-4069-9114-26fcb6752930';

  function buildSideQuestionHarness({
    sideCascadeAttr = null,
    hasEmptyEl = true,
    hideModelSelector = true,
    mainModelText = 'GPT-OSS 120B (Medium)',
    getSnapshot = async () => null
  }) {
    const rpcCalls = [];
    const shadowByBox = new Map();

    const makeShadow = (boxId) => {
      const sMap = new Map();
      for (const id of ['ring-bar', 'tooltip-text', 'context-ring', 'ring-container', 'tooltip']) {
        sMap.set(id, {
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
      shadowByBox.set(boxId, sMap);
      return {
        innerHTML: '',
        getElementById: (id) => sMap.get(id),
        querySelector: () => ({ style: {} })
      };
    };

    const mockBody = { isConnected: true, parentElement: null };

    // 主窗格结构（单主窗格依赖父会话 PARENT_CID）
    const mainConvView = {
      isConnected: true,
      parentElement: mockBody,
      matches: (sel) => sel.includes('conversation-view'),
      closest: (sel) => sel.includes('conversation-view') ? mainConvView : null,
      hasAttribute: (attr) => attr === 'data-cascade-id',
      getAttribute: (attr) => attr === 'data-cascade-id' ? PARENT_CID : '',
    };
    const mainFlex = {
      isConnected: true,
      insertedNodes: [],
      contains(n) { return this.insertedNodes.includes(n); },
      insertBefore(n) { if (!this.insertedNodes.includes(n)) this.insertedNodes.push(n); }
    };
    const mainProvider = {
      getState: () => ({ conversationId: PARENT_CID, turns: [{ id: 't1' }], trajectorySlice: { totalStepsLength: 88 } }),
      onDidChange: () => () => {}
    };
    const mainBox = {
      _paneKey: 'main',
      isConnected: true,
      parentElement: mainConvView,
      __reactFiber$test: { memoizedProps: { cascadeContext: { state: { agentStateProvider: mainProvider } } } },
      getClientRects: () => [{ width: 500, height: 100 }],
      hasAttribute: () => false,
      closest: (sel) => sel.includes('conversation-view') ? mainConvView : null,
      querySelector: (sel) => sel.includes('model-selector-trigger') ? mainModel : null,
      contains: (n) => mainFlex.insertedNodes.includes(n) || n === mainModel || n === mainEditor
    };
    const mainModel = {
      isConnected: true,
      parentElement: mainFlex,
      textContent: mainModelText,
      getAttribute: () => '',
      getClientRects: () => [{ width: 90, height: 24 }],
      closest: (sel) => sel.includes('agent-input-box') ? mainBox : (sel.includes('flex-1') ? mainFlex : null)
    };
    const mainEditor = {
      isConnected: true,
      getClientRects: () => [{ width: 450, height: 50 }],
      addEventListener() {},
      removeEventListener() {},
      closest: (sel) => sel.includes('agent-input-box') ? mainBox : null
    };

    // 侧边 /btw (`sideQuestionView`) DOM 与外层 <X5> Fiber（草稿态时外层 Fiber 仍持有父会话 PARENT_CID！）
    const emptyEl = hasEmptyEl ? {
      isConnected: true,
      getClientRects: () => [{ width: 300, height: 120 }],
      closest: () => null,
    } : null;
    const sideConvEl = {
      isConnected: true,
      hasAttribute: (attr) => attr === 'data-cascade-id' && !!sideCascadeAttr,
      getAttribute: (attr) => attr === 'data-cascade-id' ? sideCascadeAttr : '',
      getClientRects: () => [{ width: 320, height: 300 }],
    };
    const sideContentRoot = {
      isConnected: true,
      parentElement: mockBody,
      querySelector: (sel) => {
        if (sel.includes('side-question-tab-conversation')) return sideConvEl;
        if (sel.includes('side-question-tab-empty')) return emptyEl;
        return null;
      },
      closest: (sel) => sel.includes('side-question-tab-content') ? sideContentRoot : null,
    };

    const sideFooterLeft = {
      isConnected: true,
      appendedNodes: [],
      contains(n) { return this.appendedNodes.includes(n); },
      appendChild(n) { if (!this.appendedNodes.includes(n)) this.appendedNodes.push(n); },
      insertBefore(n) { if (!this.appendedNodes.includes(n)) this.appendedNodes.push(n); },
    };
    const sideSendBtn = {
      isConnected: true,
      parentElement: {
        isConnected: true,
        insertBefore() {}
      },
    };
    // 关键验证：草稿态 <X5> Fiber 注入的是父会话 PARENT_CID 与 turns，必须被侧边栏优先守卫拦截！
    const sideFiberProvider = {
      getState: () => ({
        conversationId: sideCascadeAttr || PARENT_CID,
        turns: sideCascadeAttr ? [{ id: 'sq1' }] : [{ id: 'parent-t1' }],
        trajectorySlice: { totalStepsLength: sideCascadeAttr ? 103 : 88 }
      }),
      onDidChange: () => () => {}
    };
    const sideComposerWrapper = {
      isConnected: true,
      parentElement: sideContentRoot,
      closest: (sel) => {
        if (sel.includes('side-question-tab-content')) return sideContentRoot;
        if (sel.includes('side-question-tab-composer') || sel.includes('data-side-panel-composer')) return sideComposerWrapper;
        return null;
      }
    };
    const sideBox = {
      _paneKey: 'side',
      isConnected: true,
      parentElement: sideComposerWrapper,
      __reactFiber$test: { memoizedProps: { cascadeContext: { state: { agentStateProvider: sideFiberProvider } } } },
      getClientRects: () => [{ width: 360, height: 80 }],
      hasAttribute: (attr) => attr === 'data-side-panel-composer',
      closest: (sel) => {
        if (sel.includes('side-question-tab-content')) return sideContentRoot;
        if (sel.includes('side-question-tab-composer') || sel.includes('data-side-panel-composer')) return sideComposerWrapper;
        return null;
      },
      querySelector: (sel) => {
        if (sel.includes('agy-composer-footer')) return sideFooterLeft;
        if (sel.includes('send-button')) return sideSendBtn;
        return null;
      },
      contains: (n) => sideFooterLeft.appendedNodes.includes(n) || n === sideFooterLeft || n === sideSendBtn || n === sideEditor
    };
    const sideEditor = {
      isConnected: true,
      getClientRects: () => [{ width: 340, height: 48 }],
      addEventListener() {},
      removeEventListener() {},
      closest: (sel) => sel.includes('agent-input-box') ? sideBox : null
    };

    let createdCount = 0;
    const pendingNodes = [];

    globalThis.location = { pathname: `/c/${PARENT_CID}` };
    globalThis.window = {
      top: null,
      innerWidth: 1440,
      __agContextRingHost: {
        getSnapshot: async (req) => {
          const cid = typeof req === 'string' ? req : req?.conversationId;
          rpcCalls.push({ cid, req });
          return getSnapshot(cid, req);
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
      activeElement: sideEditor,
      addEventListener() {},
      removeEventListener() {},
      querySelector: (sel) => {
        if (sel.includes('side-question-tab-content')) return sideContentRoot;
        return mainBox;
      },
      querySelectorAll: (sel) => {
        if (sel.includes('contenteditable')) return [mainEditor, sideEditor];
        if (sel.includes('model-selector-trigger')) return hideModelSelector ? [mainModel] : [mainModel];
        return [];
      },
      createElement: () => {
        createdCount++;
        const nodeKey = createdCount === 1 ? 'main' : 'side';
        const node = {
          id: '',
          style: {},
          isConnected: true,
          previousElementSibling: nodeKey === 'main' ? mainModel : null,
          addEventListener() {},
          remove() { this.isConnected = false; },
          attachShadow: () => makeShadow(nodeKey)
        };
        pendingNodes.push(node);
        return node;
      }
    };
    globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };

    return {
      rpcCalls,
      sideFooterLeft,
      getMainTip: () => shadowByBox.get('main')?.get('tooltip-text')?.textContent ?? '',
      getSideTip: () => shadowByBox.get('side')?.get('tooltip-text')?.textContent ?? '',
      cleanup() {
        globalThis.window?.__agContextRingDispose?.();
        delete globalThis.location;
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.localStorage;
        delete globalThis.getComputedStyle;
        delete globalThis.MutationObserver;
      }
    };
  }

  // 场景 A：/btw 草稿态 + hideModelSelector=true，外层 Fiber 误携带 PARENT_CID
  const hDraft = buildSideQuestionHarness({
    sideCascadeAttr: null,
    hasEmptyEl: true,
    hideModelSelector: true,
    mainModelText: 'GPT-OSS 120B (Medium)',
    getSnapshot: async (cid) => ({
      ready: true,
      cid,
      conversationId: cid,
      ratio: 0.5,
      used: 40000,
      limit: 80000,
      usedK: '40.0K',
      limitK: '80.0K',
      percent: '50.0%',
      tooltip: '50.0% · 40.0K / 80.0K 上下文已使用'
    })
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(hDraft.sideFooterLeft.appendedNodes.length, 1, 'hideModelSelector=true 时必须将圆环挂载到 .agy-composer-footer 内');
    assert.equal(hDraft.getSideTip(), '将继承主会话 · 50.0% · 40.0K / 80.0K', '有父会话缓存时，草稿态 /btw 应 0 RPC 预显示继承水位并借用主窗格 GPT-OSS 80K 提示');
    const sideRpcCalls = hDraft.rpcCalls.filter(c => c.cid !== PARENT_CID);
    assert.equal(sideRpcCalls.length, 0, '草稿态 /btw 绝不能发起父会话或子会话 RPC');
    assert.equal(hDraft.rpcCalls.length, 1, '仅有主窗格发起 1 次 PARENT_CID 快照请求');
    assert.equal(hDraft.getMainTip(), '50.0% · 40.0K / 80.0K 上下文已使用');
  } finally {
    hDraft.cleanup();
  }

  // 场景 B：/btw 已发送变成独立子会话 CHILD_CID，无模型按钮且并发主窗格运行
  const hActive = buildSideQuestionHarness({
    sideCascadeAttr: CHILD_CID,
    hasEmptyEl: false,
    hideModelSelector: true,
    mainModelText: 'Gemini 4 Hydrogen (High)',
    getSnapshot: async (cid) => {
      if (cid === CHILD_CID) {
        return {
          ready: true,
          cid: CHILD_CID,
          conversationId: CHILD_CID,
          ratio: 188464 / 256000,
          used: 188464,
          limit: 256000,
          usedK: '188.5K',
          limitK: '256.0K',
          percent: '73.6%',
          tooltip: '73.6% · 188.5K / 256.0K 上下文已使用'
        };
      }
      return {
        ready: true,
        cid: PARENT_CID,
        conversationId: PARENT_CID,
        ratio: 0.4,
        used: 102400,
        limit: 256000,
        usedK: '102.4K',
        limitK: '256.0K',
        percent: '40.0%',
        tooltip: '40.0% · 102.4K / 256.0K 上下文已使用'
      };
    }
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(hActive.sideFooterLeft.appendedNodes.length, 1, '活跃态 /btw 必须挂载到 footer 内');
    assert.ok(hActive.rpcCalls.some(c => c.cid === CHILD_CID), '必须精确向子会话 CHILD_CID 请求快照');
    assert.equal(hActive.getSideTip(), '73.6% · 188.5K / 256.0K 上下文已使用', '/btw 圆环应独立渲染子会话 188.5K / 256.0K 用量');
    assert.equal(hActive.getMainTip(), '40.0% · 102.4K / 256.0K 上下文已使用', '主窗格应保持显示父会话 40.0%');
  } finally {
    hActive.cleanup();
  }

  // 场景 C：/btw 分叉轨迹（继承父前缀 0..87 + CORTEX_STEP_TYPE_SYSTEM_MESSAGE@88 + 子问答步 89..102）准确计算
  const forkedSideSteps = [
    {
      stepIndex: 87,
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M525',
          inputTokens: 175000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        }
      },
      plannerResponse: { response: 'parent tail' }
    },
    {
      stepIndex: 88,
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      systemMessage: { message: 'Side question instructions' }
    },
    {
      stepIndex: 89,
      type: StepType.USER_INPUT,
      userInput: {
        userResponse: '/btw explain this branch',
        userConfig: { plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M525' } }
      }
    },
    {
      stepIndex: 90,
      type: StepType.PLANNER_RESPONSE,
      metadata: {
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M525',
          inputTokens: 188000,
          outputTokens: 464,
          cacheReadTokens: 0,
          cacheCreationTokens: 0
        }
      },
      plannerResponse: { response: 'child answer' }
    }
  ];
  const forkedCalc = processTrajectorySteps(forkedSideSteps, {
    runtimeMaxContextTokens: 256_000,
    runtimeContextModel: 'MODEL_PLACEHOLDER_M525'
  });
  assert.equal(forkedCalc.contextUsed, 188464);
  assert.equal(forkedCalc.contextLimit, 256_000);
  assert.equal(forkedCalc.compressionDetected, false);
});

test('【最终封板 14】右侧 Subagent / Swarm Worker 标签页 (subagentView) 防误判：不误入 /btw 草稿态、支持兄弟节点 data-cascade-id 回退且不干扰单主窗格 URL 回退', async () => {
  const MAIN_CID = '11111111-aaaa-bbbb-cccc-222222222222';
  const WORKER_CID = '61193f61-546d-40fa-8c7b-ad12b02bc82b';

  const rpcCalls = [];
  const shadowByPane = new Map();
  const makeShadow = (key) => {
    const sMap = new Map();
    for (const id of ['ring-bar', 'tooltip-text', 'context-ring', 'ring-container', 'tooltip']) {
      sMap.set(id, {
        id,
        style: {},
        textContent: '',
        hidden: true,
        classList: { add() {}, remove() {} },
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 18, height: 18 })
      });
    }
    shadowByPane.set(key, sMap);
    return {
      innerHTML: '',
      getElementById: (id) => sMap.get(id),
      querySelector: () => ({ style: {} })
    };
  };

  const mockBody = { isConnected: true, parentElement: null };

  // 主窗格：模拟 Fiber 尚未就绪、依赖单主窗格 location.pathname 回退获取 MAIN_CID
  const mainConvView = {
    isConnected: true,
    parentElement: mockBody,
    matches: (sel) => sel.includes('conversation-view'),
    closest: (sel) => sel.includes('conversation-view') ? mainConvView : null,
    hasAttribute: () => false,
    getAttribute: () => ''
  };
  const mainFlex = {
    isConnected: true,
    insertedNodes: [],
    contains(n) { return this.insertedNodes.includes(n); },
    insertBefore(n) { if (!this.insertedNodes.includes(n)) this.insertedNodes.push(n); }
  };
  const mainBox = {
    isConnected: true,
    parentElement: mainConvView,
    getClientRects: () => [{ width: 500, height: 100 }],
    hasAttribute: () => false,
    closest: (sel) => sel.includes('conversation-view') ? mainConvView : null,
    querySelector: (sel) => sel.includes('model-selector-trigger') ? mainModel : null,
    contains: (n) => mainFlex.insertedNodes.includes(n) || n === mainModel || n === mainEditor
  };
  const mainModel = {
    isConnected: true,
    parentElement: mainFlex,
    textContent: 'Gemini 4 Argon High · 256K',
    getAttribute: () => '',
    getClientRects: () => [{ width: 90, height: 24 }],
    closest: (sel) => sel.includes('agent-input-box') ? mainBox : (sel.includes('flex-1') ? mainFlex : null)
  };
  const mainEditor = {
    isConnected: true,
    getClientRects: () => [{ width: 450, height: 50 }],
    addEventListener() {},
    removeEventListener() {},
    closest: (sel) => sel.includes('agent-input-box') ? mainBox : null
  };

  // 右侧 subagentView：外层 [data-media-drop-scope="subpane"] 下包含同级兄弟 [data-testid="subagent-tab-conversation"][data-cascade-id] 与 [data-side-panel-composer]
  const subagentConvSibling = {
    isConnected: true,
    hasAttribute: (attr) => attr === 'data-cascade-id',
    getAttribute: (attr) => attr === 'data-cascade-id' ? WORKER_CID : ''
  };
  const subpaneRoot = {
    isConnected: true,
    parentElement: mockBody,
    hasAttribute: (attr) => attr === 'data-media-drop-scope',
    getAttribute: (attr) => attr === 'data-media-drop-scope' ? 'subpane' : '',
    querySelector: (sel) => {
      if (sel.includes('subagent-tab-conversation')) return subagentConvSibling;
      return null;
    },
    closest: (sel) => sel.includes('subpane') ? subpaneRoot : null
  };
  const subagentComposerWrapper = {
    isConnected: true,
    parentElement: subpaneRoot,
    hasAttribute: (attr) => attr === 'data-side-panel-composer',
    matches: (sel) => sel.includes('data-side-panel-composer'),
    closest: (sel) => {
      if (sel.includes('subpane')) return subpaneRoot;
      if (sel.includes('data-side-panel-composer')) return subagentComposerWrapper;
      return null;
    }
  };
  const subFooterLeft = {
    isConnected: true,
    appendedNodes: [],
    contains(n) { return this.appendedNodes.includes(n); },
    appendChild(n) { if (!this.appendedNodes.includes(n)) this.appendedNodes.push(n); }
  };
  const subagentBox = {
    isConnected: true,
    parentElement: subagentComposerWrapper,
    // 模拟 Fiber 尚未挂载或仅挂载了 selectedModel，验证兄弟节点 DOM [data-testid="subagent-tab-conversation"][data-cascade-id] 依然能提取出 WORKER_CID
    __reactFiber$test: {
      memoizedProps: {
        cascadeContext: {
          state: {
            selectedModel: { label: 'GPT-OSS 120B (Medium) · 80K (Notice)' }
          }
        }
      }
    },
    getClientRects: () => [{ width: 360, height: 80 }],
    hasAttribute: () => false,
    closest: (sel) => {
      if (sel.includes('subpane')) return subpaneRoot;
      if (sel.includes('data-side-panel-composer')) return subagentComposerWrapper;
      return null;
    },
    querySelector: (sel) => sel.includes('agy-composer-footer') ? subFooterLeft : null,
    contains: (n) => subFooterLeft.appendedNodes.includes(n) || n === subFooterLeft || n === subagentEditor
  };
  const subagentEditor = {
    isConnected: true,
    getClientRects: () => [{ width: 340, height: 48 }],
    addEventListener() {},
    removeEventListener() {},
    closest: (sel) => sel.includes('agent-input-box') ? subagentBox : null
  };

  let createdIdx = 0;
  globalThis.location = { pathname: `/c/${MAIN_CID}` };
  globalThis.window = {
    top: null,
    innerWidth: 1440,
    __agContextRingHost: {
      getSnapshot: async (req) => {
        const cid = typeof req === 'string' ? req : req?.conversationId;
        rpcCalls.push({ cid, fallbackModel: req?.fallbackModel });
        if (cid === WORKER_CID) {
          return {
            ready: true,
            cid: WORKER_CID,
            conversationId: WORKER_CID,
            ratio: 0.3,
            used: 24000,
            limit: 80000,
            usedK: '24.0K',
            limitK: '80.0K',
            percent: '30.0%',
            tooltip: '30.0% · 24.0K / 80.0K 上下文已使用'
          };
        }
        return {
          ready: true,
          cid: MAIN_CID,
          conversationId: MAIN_CID,
          ratio: 0.2,
          used: 51200,
          limit: 256000,
          usedK: '51.2K',
          limitK: '256.0K',
          percent: '20.0%',
          tooltip: '20.0% · 51.2K / 256.0K 上下文已使用'
        };
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
    activeElement: subagentEditor,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => mainBox,
    querySelectorAll: (sel) => {
      if (sel.includes('contenteditable')) return [mainEditor, subagentEditor];
      if (sel.includes('model-selector-trigger')) return [mainModel];
      return [];
    },
    createElement: () => {
      createdIdx++;
      const key = createdIdx === 1 ? 'main' : 'subagent';
      return {
        id: '',
        style: {},
        isConnected: true,
        previousElementSibling: key === 'main' ? mainModel : null,
        addEventListener() {},
        remove() { this.isConnected = false; },
        attachShadow: () => makeShadow(key)
      };
    }
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.MutationObserver = class { observe() {} disconnect() {} };

  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 50));

    const mainTip = shadowByPane.get('main')?.get('tooltip-text')?.textContent ?? '';
    const subTip = shadowByPane.get('subagent')?.get('tooltip-text')?.textContent ?? '';

    assert.equal(subTip, '30.0% · 24.0K / 80.0K 上下文已使用', 'subagentView 绝不能被误判为 0% 新会话草稿，必须正确拉取 WORKER_CID 用量');
    assert.equal(mainTip, '20.0% · 51.2K / 256.0K 上下文已使用', '右侧打开 subagentView 时不得阻塞单主窗格的 URL 回退');

    const workerCall = rpcCalls.find(c => c.cid === WORKER_CID);
    assert.ok(workerCall, '必须向 WORKER_CID 发起 RPC 请求');
    assert.equal(workerCall.fallbackModel, 'GPT-OSS 120B (Medium)', '无模型按钮的 subagentView 应从 Fiber selectedModel 直读模型提示并剥离 · 80K 与 (Notice)');
  } finally {
    globalThis.window?.__agContextRingDispose?.();
    delete globalThis.location;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
    delete globalThis.getComputedStyle;
    delete globalThis.MutationObserver;
  }
});

test('【最终封板 15】新版欢迎页 home-greeting、Best-of-N 多选态模型直读与动态模型限额自学习持久化闭环', async () => {
  const { inferClientModelLimit, updateClientModelLimits, clearClientModelLimits } = installAgContextRingWidget;

  // 1. 验证 updateClientModelLimits 内存 + localStorage('ag_ring_model_limits_v1') 持久化与 data-context-window 优先级
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k)
  };

  try {
    clearClientModelLimits();
    // 默认静态基线：Claude Opus 5.5 为 256K
    assert.equal(inferClientModelLimit('Claude Opus 5.5 Extra · 1M'), 256_000);

    // 当 DOM 触发器携带 data-context-window="840000" 或 "840K" 时优先采用 DOM 标注值
    const fakeTriggerEl = {
      getAttribute: (attr) => attr === 'data-context-window' ? '840K' : ''
    };
    assert.equal(inferClientModelLimit('Claude Opus 5.5 Extra · 1M', fakeTriggerEl), 840_000, 'DOM data-context-window 应具备最高优先级');

    // 模拟后端下发 modelLimits 自学习（如实验分支 claude-1m_840k 下发 840000）
    updateClientModelLimits({ 'Claude Opus 5.5 Extra': 840_000, 'future-gemini-5-ultra': 512_000 });
    assert.ok(store.has('ag_ring_model_limits_v1'), '自学习限额必须持久化到 localStorage ag_ring_model_limits_v1');
    assert.equal(inferClientModelLimit('Claude Opus 5.5 Extra · 1M (New)'), 840_000, '剥离 · 1M 与 (New) 后应命中动态学习的 840K 限额');
    assert.equal(inferClientModelLimit('Future Gemini 5 Ultra'), 512_000, '未来新模型应直接命中自学习缓存');

    // 2. 验证新版 home-greeting 欢迎词 ("Hey K, what should we build today?") + Best-of-N ("3 models selected") 从 Fiber selectedModel 直读并应用动态限额
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
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 18, height: 18 })
      });
    }
    const mockBody = { isConnected: true, parentElement: null };
    const homeView = {
      isConnected: true,
      parentElement: mockBody,
      textContent: 'Hey K, what should we build today?',
      matches: (sel) => sel.includes('agy-home'),
      closest: () => null,
      querySelector: (sel) => sel.includes('home-greeting') ? { isConnected: true } : null,
      querySelectorAll: () => []
    };
    const flexContainer = {
      isConnected: true,
      insertedNodes: [],
      contains(n) { return this.insertedNodes.includes(n); },
      insertBefore(n) { if (!this.insertedNodes.includes(n)) this.insertedNodes.push(n); }
    };
    const box = {
      isConnected: true,
      parentElement: homeView,
      __reactFiber$home: {
        memoizedProps: {
          cascadeContext: {
            state: {
              selectedModel: { label: 'Claude Opus 5.5 Extra · 1M (New)' }
            }
          }
        }
      },
      getClientRects: () => [{ width: 400, height: 100 }],
      closest: () => null,
      contains: () => true
    };
    const modelEl = {
      isConnected: true,
      parentElement: flexContainer,
      textContent: '3 models selected',
      getAttribute: () => '',
      getClientRects: () => [{ width: 80, height: 24 }],
      closest: (sel) => sel.includes('agent-input-box') ? box : (sel.includes('flex-1') ? flexContainer : null)
    };
    const editorEl = {
      isConnected: true,
      getClientRects: () => [{ width: 380, height: 60 }],
      addEventListener() {},
      removeEventListener() {},
      closest: (sel) => sel.includes('agent-input-box') ? box : null
    };

    globalThis.location = { pathname: '/' };
    globalThis.window = {
      top: null,
      innerWidth: 1440,
      __agContextRingHost: { getSnapshot: async () => null },
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
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    globalThis.MutationObserver = class { observe() {} disconnect() {} };

    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 40));
    const tip = shadowMap.get('tooltip-text')?.textContent ?? '';
    assert.equal(tip, '新会话 · 0.0K / 840.0K 上下文未占用', 'Best-of-N 3 models selected 下应从 Fiber selectedModel 直读并应用动态 840K 限额');
  } finally {
    globalThis.window?.__agContextRingDispose?.();
    clearClientModelLimits();
    delete globalThis.location;
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
    delete globalThis.getComputedStyle;
    delete globalThis.MutationObserver;
  }
});

test('【最终封板 16】/btw 草稿态方案 A（预显示继承父会话基底）：按自身模型重算百分比、0 用量回退 0.0%、多主窗格防盲猜与发送后脱钩父会话', async () => {
  const PARENT_CID = 'cccccccc-1111-2222-3333-dddddddddddd';
  const CHILD_CID = 'eeeeeeee-4444-5555-6666-ffffffffffff';

  function buildPlanAHarness({
    parentUsed = 76800,
    parentLimit = 256000,
    mainModelText = 'Gemini 4 Hydrogen (High)',
    sideModelText = 'GPT-OSS 120B (Medium)',
    sideFiberParentId = PARENT_CID,
    hasSideFiberContext = true,
    extraMainPane = false
  } = {}) {
    const rpcCalls = [];
    const shadowByBox = new Map();
    const editorListeners = new Map();
    let isDraft = true;
    let sideCascadeAttr = null;

    const makeShadow = (key) => {
      const sMap = new Map();
      for (const id of ['ring-bar', 'tooltip-text', 'context-ring', 'ring-container', 'tooltip']) {
        sMap.set(id, {
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
      shadowByBox.set(key, sMap);
      return {
        innerHTML: '',
        getElementById: (id) => sMap.get(id),
        querySelector: () => ({ style: {} })
      };
    };

    const mockBody = { isConnected: true, parentElement: null };

    const createMainPane = (cid, paneKey) => {
      const convView = {
        isConnected: true,
        parentElement: mockBody,
        matches: (sel) => sel.includes('conversation-view'),
        closest: (sel) => sel.includes('conversation-view') ? convView : null,
        hasAttribute: (attr) => attr === 'data-cascade-id',
        getAttribute: (attr) => attr === 'data-cascade-id' ? cid : '',
      };
      const flex = {
        isConnected: true,
        insertedNodes: [],
        contains(n) { return this.insertedNodes.includes(n); },
        insertBefore(n) { if (!this.insertedNodes.includes(n)) this.insertedNodes.push(n); }
      };
      const provider = {
        getState: () => ({ conversationId: cid, turns: [{ id: 't1' }], trajectorySlice: { totalStepsLength: 20 } }),
        onDidChange: () => () => {}
      };
      const box = {
        _paneKey: paneKey,
        isConnected: true,
        parentElement: convView,
        __reactFiber$test: { memoizedProps: { cascadeContext: { state: { agentStateProvider: provider } } } },
        getClientRects: () => [{ width: 500, height: 100 }],
        hasAttribute: () => false,
        closest: (sel) => sel.includes('conversation-view') ? convView : null,
        querySelector: (sel) => sel.includes('model-selector-trigger') ? model : null,
        contains: (n) => flex.insertedNodes.includes(n) || n === model || n === editor
      };
      const model = {
        isConnected: true,
        parentElement: flex,
        textContent: mainModelText,
        getAttribute: () => '',
        getClientRects: () => [{ width: 90, height: 24 }],
        closest: (sel) => sel.includes('agent-input-box') ? box : (sel.includes('flex-1') ? flex : null)
      };
      const editor = {
        isConnected: true,
        getClientRects: () => [{ width: 450, height: 50 }],
        addEventListener() {},
        removeEventListener() {},
        closest: (sel) => sel.includes('agent-input-box') ? box : null
      };
      return { box, model, editor, flex };
    };

    const main1 = createMainPane(PARENT_CID, 'main1');
    const main2 = extraMainPane ? createMainPane('22222222-3333-4444-5555-666666666666', 'main2') : null;

    const emptyEl = {
      isConnected: true,
      getClientRects: () => isDraft ? [{ width: 300, height: 120 }] : [],
      closest: () => null,
    };
    const sideConvEl = {
      isConnected: true,
      hasAttribute: (attr) => attr === 'data-cascade-id' && !!sideCascadeAttr,
      getAttribute: (attr) => attr === 'data-cascade-id' ? sideCascadeAttr : '',
      getClientRects: () => [{ width: 320, height: 300 }],
    };
    const sideContentRoot = {
      isConnected: true,
      parentElement: mockBody,
      querySelector: (sel) => {
        if (sel.includes('side-question-tab-conversation')) return sideConvEl;
        if (sel.includes('side-question-tab-empty')) return isDraft ? emptyEl : null;
        return null;
      },
      closest: (sel) => sel.includes('side-question-tab-content') ? sideContentRoot : null,
    };
    const sideFlex = {
      isConnected: true,
      insertedNodes: [],
      contains(n) { return this.insertedNodes.includes(n); },
      insertBefore(n) { if (!this.insertedNodes.includes(n)) this.insertedNodes.push(n); }
    };
    const sideComposerWrapper = {
      isConnected: true,
      parentElement: sideContentRoot,
      closest: (sel) => {
        if (sel.includes('side-question-tab-content')) return sideContentRoot;
        if (sel.includes('side-question-tab-composer') || sel.includes('data-side-panel-composer')) return sideComposerWrapper;
        return null;
      }
    };
    const sideFiberProvider = hasSideFiberContext ? {
      getState: () => ({
        conversationId: sideCascadeAttr || PARENT_CID,
        turns: [{ id: 't' }],
        trajectorySlice: { totalStepsLength: 20 }
      }),
      onDidChange: () => () => {}
    } : null;

    const sideBox = {
      _paneKey: 'side',
      isConnected: true,
      parentElement: sideComposerWrapper,
      __reactFiber$test: (sideFiberParentId || sideFiberProvider) ? {
        memoizedProps: {
          ...(sideFiberParentId ? { parentCascadeId: sideFiberParentId } : {}),
          ...(sideFiberProvider ? { cascadeContext: { state: { agentStateProvider: sideFiberProvider } } } : {})
        }
      } : null,
      getClientRects: () => [{ width: 360, height: 80 }],
      hasAttribute: (attr) => attr === 'data-side-panel-composer',
      closest: (sel) => {
        if (sel.includes('side-question-tab-content')) return sideContentRoot;
        if (sel.includes('side-question-tab-composer') || sel.includes('data-side-panel-composer')) return sideComposerWrapper;
        return null;
      },
      querySelector: (sel) => {
        if (sel.includes('model-selector-trigger')) return sideModel;
        return null;
      },
      contains: (n) => sideFlex.insertedNodes.includes(n) || n === sideModel || n === sideEditor
    };
    const sideModel = {
      isConnected: true,
      parentElement: sideFlex,
      textContent: sideModelText,
      getAttribute: () => '',
      getClientRects: () => [{ width: 85, height: 24 }],
      closest: (sel) => sel.includes('agent-input-box') ? sideBox : (sel.includes('flex-1') ? sideFlex : null)
    };
    const sideEditor = {
      isConnected: true,
      getClientRects: () => [{ width: 340, height: 48 }],
      addEventListener(ev, fn) { editorListeners.set(ev, fn); },
      removeEventListener() {},
      closest: (sel) => sel.includes('agent-input-box') ? sideBox : null
    };

    const allEditors = main2 ? [main1.editor, main2.editor, sideEditor] : [main1.editor, sideEditor];
    const allModels = main2 ? [main1.model, main2.model, sideModel] : [main1.model, sideModel];
    let createdCount = 0;
    const expectedKeys = main2 ? ['main1', 'main2', 'side'] : ['main1', 'side'];

    globalThis.location = { pathname: `/c/${PARENT_CID}` };
    globalThis.window = {
      top: null,
      innerWidth: 1440,
      __agContextRingHost: {
        getSnapshot: async (req) => {
          const cid = typeof req === 'string' ? req : req?.conversationId;
          rpcCalls.push(cid);
          if (cid === CHILD_CID) {
            return {
              ready: true,
              cid: CHILD_CID,
              conversationId: CHILD_CID,
              ratio: 20000 / 80000,
              used: 20000,
              limit: 80000,
              usedK: '20.0K',
              limitK: '80.0K',
              percent: '25.0%',
              tooltip: '25.0% · 20.0K / 80.0K 上下文已使用'
            };
          }
          return {
            ready: true,
            cid,
            conversationId: cid,
            ratio: parentUsed / parentLimit,
            used: parentUsed,
            limit: parentLimit,
            usedK: (parentUsed / 1000).toFixed(1) + 'K',
            limitK: (parentLimit / 1000).toFixed(1) + 'K',
            percent: ((parentUsed / parentLimit) * 100).toFixed(1) + '%',
            tooltip: `${((parentUsed / parentLimit) * 100).toFixed(1)}% · ${(parentUsed / 1000).toFixed(1)}K / ${(parentLimit / 1000).toFixed(1)}K 上下文已使用`
          };
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
      activeElement: sideEditor,
      addEventListener() {},
      removeEventListener() {},
      querySelector: (sel) => {
        if (sel.includes('side-question-tab-content')) return sideContentRoot;
        return main1.box;
      },
      querySelectorAll: (sel) => {
        if (sel.includes('contenteditable')) return allEditors;
        if (sel.includes('model-selector-trigger')) return allModels;
        return [];
      },
      createElement: () => {
        const key = expectedKeys[createdCount++] || `extra-${createdCount}`;
        return {
          id: '',
          style: {},
          isConnected: true,
          previousElementSibling: key === 'side' ? sideModel : (key === 'main2' ? main2?.model : main1.model),
          addEventListener() {},
          remove() { this.isConnected = false; },
          attachShadow: () => makeShadow(key)
        };
      }
    };
    globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    globalThis.getComputedStyle = () => ({ visibility: 'visible' });
    globalThis.MutationObserver = class { observe() {} disconnect() {} };

    return {
      rpcCalls,
      getSideTip: () => shadowByBox.get('side')?.get('tooltip-text')?.textContent ?? '',
      getSideBarOpacity: () => shadowByBox.get('side')?.get('ring-bar')?.style?.opacity ?? '',
      sendFirstMessageAndFocus() {
        isDraft = false;
        sideCascadeAttr = CHILD_CID;
        editorListeners.get('focus')?.();
      },
      cleanup() {
        globalThis.window?.__agContextRingDispose?.();
        delete globalThis.location;
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.localStorage;
        delete globalThis.getComputedStyle;
        delete globalThis.MutationObserver;
      }
    };
  }

  // 1. 有父会话缓存且 /btw 自身模型上限(80K)不同于主窗格(256K)：按 /btw 自身模型重算百分比并附带接近截断提示，且发送后切为子会话独立跟踪
  const h1 = buildPlanAHarness({
    parentUsed: 76800,
    parentLimit: 256000,
    mainModelText: 'Gemini 4 Hydrogen (High)',
    sideModelText: 'GPT-OSS 120B (Medium)',
    sideFiberParentId: PARENT_CID
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(h1.getSideTip(), '将继承主会话 · 96.0% · 76.8K / 80.0K 接近截断', '草稿态 /btw 应按自身 80K 模型重算父会话 76.8K 水位为 96.0%');
    assert.equal(h1.getSideBarOpacity(), '1', '继承预览水位 > 0 时圆环必须可见');
    assert.deepEqual(h1.rpcCalls, [PARENT_CID], '草稿态 /btw 绝不能发起额外 RPC');

    // 发送第一条消息后变为子会话 CHILD_CID，立即脱钩父会话
    h1.sendFirstMessageAndFocus();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(h1.rpcCalls.includes(CHILD_CID), '发送第一条消息后必须向子会话 CHILD_CID 发起独立同步');
    assert.equal(h1.getSideTip(), '25.0% · 20.0K / 80.0K 上下文已使用', '切为子会话后应彻底脱钩父会话，渲染子会话独立用量');
  } finally {
    h1.cleanup();
  }

  // 2. 父会话 used === 0 时，正常回退 0.0% 草稿文案
  const h2 = buildPlanAHarness({
    parentUsed: 0,
    parentLimit: 80000,
    mainModelText: 'GPT-OSS 120B (Medium)',
    sideModelText: 'GPT-OSS 120B (Medium)',
    sideFiberParentId: PARENT_CID
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h2.getSideTip(), '新会话 · 0.0K / 80.0K 上下文未占用', '父会话用量为 0 时应回退标准 0.0% 草稿提示');
  } finally {
    h2.cleanup();
  }

  // 3. 无 Fiber parentCascadeId 且多主窗格并存时，绝不盲猜父会话，回退 0.0%
  const h3 = buildPlanAHarness({
    parentUsed: 102400,
    parentLimit: 256000,
    sideFiberParentId: null,
    hasSideFiberContext: false,
    extraMainPane: true
  });
  try {
    installAgContextRingWidget();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h3.getSideTip(), '新会话 · 0.0K / 80.0K 上下文未占用', '多主窗格且无 Fiber parentCascadeId 时绝不盲猜父会话');
  } finally {
    h3.cleanup();
  }
});


