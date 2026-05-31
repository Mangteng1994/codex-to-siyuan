const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldSyncProject,
  filterMessages,
  renderPathTemplate,
  hasLeadingAssistantOnlySegment,
  isSessionFirstRun,
  shouldDeferFirstFallbackWrite,
  preserveStateForDeferredFirstWrite,
} = require('../hook');

test('项目白名单为空时默认允许同步', () => {
  assert.equal(shouldSyncProject('C:\\work\\demo', {}), true);
});

test('项目白名单命中时允许同步', () => {
  assert.equal(shouldSyncProject('C:\\work\\demo-app', {
    includeProjectPatterns: 'demo\nteam-*',
  }), true);
});

test('项目黑名单优先级高于白名单', () => {
  assert.equal(shouldSyncProject('C:\\work\\demo-secret', {
    includeProjectPatterns: 'demo\n*secret*',
    excludeProjectPatterns: '*secret*',
  }), false);
});

test('项目未命中白名单时跳过同步', () => {
  assert.equal(shouldSyncProject('C:\\work\\other-app', {
    includeProjectPatterns: 'demo\nteam-*',
  }), false);
});

test('内容过滤会移除命中 part，并删除空消息', () => {
  const messages = [
    {
      role: 'user',
      parts: [
        { type: 'text', text: '保留内容' },
        { type: 'text', text: '请忽略 AGENTS.md 全文' },
      ],
    },
    {
      role: 'assistant',
      parts: [
        { type: 'tool_use', name: 'shell_command', input: '{"file":"C:/repo/AGENTS.md"}' },
      ],
    },
    {
      role: 'assistant',
      parts: [
        { type: 'text', text: '正常回复' },
      ],
    },
  ];

  const filtered = filterMessages(messages, {
    excludeContentPatterns: 'AGENTS.md',
  });

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].parts.length, 1);
  assert.equal(filtered[0].parts[0].text, '保留内容');
  assert.equal(filtered[1].parts[0].text, '正常回复');
});

test('路径模板渲染保持默认目录结构，并支持自定义项目层级', () => {
  assert.equal(renderPathTemplate('${parentPath}/${date}/${title}', {
    parentPath: '/Codex Sessions',
    date: '2026-05-31',
    projectName: 'demo',
    title: 'hello',
    sessionId: 'sid-1',
  }), '/Codex Sessions/2026-05-31/hello');

  assert.equal(renderPathTemplate('${parentPath}/${projectName}/${date}/${title}', {
    parentPath: '/Codex Sessions',
    date: '2026-05-31',
    projectName: 'demo',
    title: 'hello',
    sessionId: 'sid-1',
  }), '/Codex Sessions/demo/2026-05-31/hello');
});

test('首轮经典模式在没有 user 文本时，应延迟 assistant fallback 落库', () => {
  assert.equal(shouldDeferFirstFallbackWrite({
    isFirstRun: true,
    syncMode: 'classic',
    normalizedMessages: [
      {
        role: 'assistant',
        parts: [{ type: 'text', text: '在。可试之。' }],
      },
    ],
  }), true);
});

test('首轮经典模式有 user 文本时，不应延迟写入', () => {
  assert.equal(shouldDeferFirstFallbackWrite({
    isFirstRun: true,
    syncMode: 'classic',
    normalizedMessages: [
      {
        role: 'user',
        parts: [{ type: 'text', text: '测试' }],
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', text: '在。可试之。' }],
      },
    ],
  }), false);
});

test('极简模式允许首轮 assistant-only fallback 直接写入', () => {
  assert.equal(shouldDeferFirstFallbackWrite({
    isFirstRun: true,
    syncMode: 'minimal',
    normalizedMessages: [
      {
        role: 'assistant',
        parts: [{ type: 'text', text: '只写最终回答' }],
      },
    ],
  }), false);
});

test('首轮 defer 时必须保留原 lastByteOffset，避免跳过第一轮 transcript', () => {
  const state = {
    sessionId: 'sid-1',
    docId: null,
    lastByteOffset: 120,
    lastFallbackHash: 'abc',
  };

  const next = preserveStateForDeferredFirstWrite({
    ...state,
    lastByteOffset: 999,
  }, 120);

  assert.equal(next.lastByteOffset, 120);
  assert.equal(next.lastFallbackHash, 'abc');
  assert.equal(next.docId, null);
});

test('只要 docId 为空，已保存 state 的 session 下次仍视为首轮', () => {
  assert.equal(isSessionFirstRun(null), true);
  assert.equal(isSessionFirstRun({ sessionId: 'sid-1', lastByteOffset: 10 }), true);
  assert.equal(isSessionFirstRun({ sessionId: 'sid-1', docId: null, lastByteOffset: 10 }), true);
  assert.equal(isSessionFirstRun({ sessionId: 'sid-1', docId: 'doc-1', lastByteOffset: 10 }), false);
});

test('首轮 classic 如果前导 assistant-only 后面才有 user，应识别为不能推进 offset', () => {
  assert.equal(hasLeadingAssistantOnlySegment([
    { role: 'assistant', turnId: 'turn-1', parts: [{ type: 'text', text: '第一轮回复' }] },
    { role: 'user', turnId: 'turn-2', parts: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', turnId: 'turn-2', parts: [{ type: 'text', text: '第二轮回复' }] },
  ]), true);

  assert.equal(hasLeadingAssistantOnlySegment([
    { role: 'user', turnId: 'turn-1', parts: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', turnId: 'turn-1', parts: [{ type: 'text', text: '第一轮回复' }] },
  ]), false);
});


test('路径模板支持 sessionIdShort 变量替换', () => {
  assert.equal(renderPathTemplate('${parentPath}/${date}/${title}-${sessionIdShort}', {
    parentPath: '/Codex Sessions',
    date: '2026-05-31',
    title: 'hello-你好',
    sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
    sessionIdShort: 'abcdef12',
  }), '/Codex Sessions/2026-05-31/hello-你好-abcdef12');

  // Default template should also work with sessionIdShort
  assert.equal(renderPathTemplate('${parentPath}/${date}/${title}-${sessionIdShort}', {
    parentPath: '/Codex Sessions',
    date: '2026-05-31',
    title: 'demo - 你好',
    sessionId: '12345678-abcd',
    sessionIdShort: '12345678',
  }), '/Codex Sessions/2026-05-31/demo - 你好-12345678');
});

test('旧路径模板不含 sessionIdShort 时仍可正常渲染', () => {
  // Old template without sessionIdShort still works (just leaves the variable as-is)
  // But in practice, the fallback mechanism handles path conflicts
  assert.equal(renderPathTemplate('${parentPath}/${date}/${title}', {
    parentPath: '/Codex Sessions',
    date: '2026-05-31',
    title: 'hello',
    sessionId: 'sid-1',
    sessionIdShort: 'sid-1',
  }), '/Codex Sessions/2026-05-31/hello');
});
