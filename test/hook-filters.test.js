const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldSyncProject,
  filterMessages,
  renderPathTemplate,
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
