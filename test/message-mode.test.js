const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseTranscript,
  normalizeMessages,
} = require('../src/parser');
const {
  formatMessages,
  generateDocHeader,
} = require('../src/formatter');
const {
  buildClassicModeMessages,
  buildFinalAssistantMessage,
  filterMessagesBySyncMode,
} = require('../hook');

const TEMPLATE = '## ${role} (${time})\n\n${content}\n\n---\n';

function writeJsonl(entries) {
  const filePath = path.join(os.tmpdir(), `codex-mode-test-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return filePath;
}

/** Build a complex transcript with user, assistant text, tool_use, tool_result */
function buildComplexNormalized() {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-1' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run a command' }] },
    },
    {
      timestamp: '2026-05-29T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'before tool' }] },
    },
    {
      timestamp: '2026-05-29T01:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell_command', arguments: { command: 'pwd' } },
    },
    {
      timestamp: '2026-05-29T01:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', output: '/home/user' },
    },
    {
      timestamp: '2026-05-29T01:00:04.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final answer' }] },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);
  return normalizeMessages(messages);
}

// ── Classic mode ──────────────────────────────────────────────────

test('classic mode按 turn 保留 transcript 中的 user 与 assistant，不用全局 last_assistant_message 覆盖', () => {
  const normalized = buildComplexNormalized();
  const lastAssistantMessage = 'the hook-provided response';

  const filtered = filterMessagesBySyncMode(normalized, 'classic', lastAssistantMessage);
  const markdown = formatMessages(filtered, TEMPLATE);

  // Should contain user text
  assert.match(markdown, /run a command/);

  // Should contain transcript last assistant text for this turn
  assert.match(markdown, /final answer/);

  // Should NOT contain tool use, tool result, or intermediate assistant text
  assert.equal(markdown.includes('Tool:'), false);
  assert.equal(markdown.includes('Tool Result'), false);
  assert.equal(markdown.includes('before tool'), false);
  assert.equal(markdown.includes('/home/user'), false);
  assert.equal(markdown.includes('the hook-provided response'), false);

  // Should have exactly 2 messages: user + assistant
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].role, 'user');
  assert.equal(filtered[1].role, 'assistant');
});

test('classic mode uses last assistant text as final when no last_assistant_message', () => {
  const normalized = buildComplexNormalized();

  const filtered = filterMessagesBySyncMode(normalized, 'classic', null);
  const markdown = formatMessages(filtered, TEMPLATE);

  // Should contain user text
  assert.match(markdown, /run a command/);

  // Should contain last assistant text ("final answer")
  assert.match(markdown, /final answer/);

  // Should NOT contain tool use, tool result, or intermediate assistant text
  assert.equal(markdown.includes('Tool:'), false);
  assert.equal(markdown.includes('Tool Result'), false);
  assert.equal(markdown.includes('before tool'), false);
  assert.equal(markdown.includes('/home/user'), false);

  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].role, 'user');
  assert.equal(filtered[1].role, 'assistant');
});

test('classic mode keeps each turn user + last assistant when补读两个 turn', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-1' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user1' }] },
    },
    {
      timestamp: '2026-05-29T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'assistant1' }] },
    },
    { type: 'turn_context', payload: { turn_id: 'turn-2' } },
    {
      timestamp: '2026-05-29T01:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user2' }] },
    },
    {
      timestamp: '2026-05-29T01:00:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'assistant2' }] },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);
  const normalized = normalizeMessages(messages);
  const filtered = filterMessagesBySyncMode(normalized, 'classic', null);
  const markdown = formatMessages(filtered, TEMPLATE);

  assert.deepEqual(filtered.map((msg) => [msg.role, msg.parts[0].text]), [
    ['user', 'user1'],
    ['assistant', 'assistant1'],
    ['user', 'user2'],
    ['assistant', 'assistant2'],
  ]);
  assert.match(markdown, /user1[\s\S]*assistant1[\s\S]*user2[\s\S]*assistant2/);
});

test('classic mode without turnId uses message order segmentation and keeps earlier assistant', () => {
  const normalized = [
    { role: 'user', timestamp: '2026-05-29T01:00:00.000Z', parts: [{ type: 'text', text: 'user1' }] },
    { role: 'assistant', timestamp: '2026-05-29T01:00:01.000Z', parts: [{ type: 'text', text: 'assistant1' }] },
    { role: 'user', timestamp: '2026-05-29T01:00:02.000Z', parts: [{ type: 'text', text: 'user2' }] },
    { role: 'assistant', timestamp: '2026-05-29T01:00:03.000Z', parts: [{ type: 'text', text: 'assistant2' }] },
  ];

  const filtered = buildClassicModeMessages(normalized);

  assert.deepEqual(filtered.map((msg) => [msg.role, msg.parts[0].text]), [
    ['user', 'user1'],
    ['assistant', 'assistant1'],
    ['user', 'user2'],
    ['assistant', 'assistant2'],
  ]);
});

test('classic mode skips assistant-only segment at document start', () => {
  const normalized = [
    { role: 'assistant', timestamp: '2026-05-29T01:00:00.000Z', parts: [{ type: 'text', text: 'assistant1' }], turnId: 'turn-a' },
    { role: 'user', timestamp: '2026-05-29T01:00:01.000Z', parts: [{ type: 'text', text: 'user2' }], turnId: 'turn-b' },
    { role: 'assistant', timestamp: '2026-05-29T01:00:02.000Z', parts: [{ type: 'text', text: 'assistant2' }], turnId: 'turn-b' },
  ];

  const filtered = buildClassicModeMessages(normalized);

  assert.deepEqual(filtered.map((msg) => [msg.role, msg.parts[0].text]), [
    ['user', 'user2'],
    ['assistant', 'assistant2'],
  ]);
  assert.equal(filtered.some((msg) => msg.parts[0].text === 'assistant1'), false);
});

test('classic mode regression: first two turns with duplicate mirrored user entry stay ordered and deduped', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-1' } },
    {
      timestamp: '2026-05-31T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'turn_input',
        role: 'user',
        input: '<environment_context><cwd>C:\\\\demo</cwd></environment_context>\n\n嘻嘻',
      },
    },
    {
      timestamp: '2026-05-31T01:00:00.100Z',
      type: 'response_item',
      payload: {
        type: 'user_input_event',
        role: 'user',
        input: '嘻嘻',
      },
    },
    {
      timestamp: '2026-05-31T01:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '嘻嘻。有何欲修此插件，直言即可。' }],
      },
    },
    { type: 'turn_context', payload: { turn_id: 'turn-2' } },
    {
      timestamp: '2026-05-31T01:01:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '嘻嘻 不嘻嘻' }],
      },
    },
    {
      timestamp: '2026-05-31T01:01:00.100Z',
      type: 'response_item',
      payload: {
        type: 'turn_input',
        role: 'user',
        input: '嘻嘻 不嘻嘻',
      },
    },
    {
      timestamp: '2026-05-31T01:01:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '然则不嘻嘻……' }],
      },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);
  const normalized = normalizeMessages(messages);
  const filtered = filterMessagesBySyncMode(normalized, 'classic', null);
  const markdown = formatMessages(filtered, TEMPLATE);

  assert.deepEqual(filtered.map((msg) => [msg.role, msg.parts[0].text]), [
    ['user', '嘻嘻'],
    ['assistant', '嘻嘻。有何欲修此插件，直言即可。'],
    ['user', '嘻嘻 不嘻嘻'],
    ['assistant', '然则不嘻嘻……'],
  ]);
  assert.equal((markdown.match(/嘻嘻 不嘻嘻/g) || []).length, 1);
  assert.match(markdown, /嘻嘻[\s\S]*嘻嘻。有何欲修此插件，直言即可。[\s\S]*嘻嘻 不嘻嘻[\s\S]*然则不嘻嘻……/);
});

test('classic mode parses first turn user from non-response_item structure', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-real-1' } },
    {
      timestamp: '2026-05-31T02:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        text: '<environment_context><cwd>C:\\\\demo</cwd></environment_context>\n\n你好',
      },
    },
    {
      timestamp: '2026-05-31T02:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '第一轮回复' }],
      },
    },
    { type: 'turn_context', payload: { turn_id: 'turn-real-2' } },
    {
      timestamp: '2026-05-31T02:01:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '你好' }],
      },
    },
    {
      timestamp: '2026-05-31T02:01:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '第二轮回复' }],
      },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);
  const normalized = normalizeMessages(messages);
  const filtered = filterMessagesBySyncMode(normalized, 'classic', null);

  assert.deepEqual(filtered.map((msg) => [msg.role, msg.parts[0].text]), [
    ['user', '你好'],
    ['assistant', '第一轮回复'],
    ['user', '你好'],
    ['assistant', '第二轮回复'],
  ]);
});

// ── Minimal mode ──────────────────────────────────────────────────

test('minimal mode returns only final assistant output (with last_assistant_message)', () => {
  const normalized = buildComplexNormalized();
  const lastAssistantMessage = 'minimal answer';

  const filtered = filterMessagesBySyncMode(normalized, 'minimal', lastAssistantMessage);
  const markdown = formatMessages(filtered, TEMPLATE);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].role, 'assistant');
  assert.match(markdown, /minimal answer/);

  // Should NOT contain user text, tools, etc.
  assert.equal(markdown.includes('run a command'), false);
  assert.equal(markdown.includes('Tool:'), false);
  assert.equal(markdown.includes('Tool Result'), false);
  assert.equal(markdown.includes('before tool'), false);
  assert.equal(markdown.includes('final answer'), false);
});

test('minimal mode uses last assistant text when no last_assistant_message', () => {
  const normalized = buildComplexNormalized();

  const filtered = filterMessagesBySyncMode(normalized, 'minimal', null);
  const markdown = formatMessages(filtered, TEMPLATE);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].role, 'assistant');
  assert.match(markdown, /final answer/);

  // Should NOT contain user text, tools, etc.
  assert.equal(markdown.includes('run a command'), false);
  assert.equal(markdown.includes('Tool:'), false);
  assert.equal(markdown.includes('Tool Result'), false);
  assert.equal(markdown.includes('before tool'), false);
});

// ── Full mode ─────────────────────────────────────────────────────

test('full mode keeps all content including tool_use and tool_result', () => {
  const normalized = buildComplexNormalized();

  const filtered = filterMessagesBySyncMode(normalized, 'full', null);
  const markdown = formatMessages(filtered, TEMPLATE);

  // Should contain everything
  assert.match(markdown, /run a command/);
  assert.match(markdown, /before tool/);
  assert.match(markdown, /\*\*🔧 Tool: shell_command\*\*/);
  assert.match(markdown, /\*\*📋 Tool Result\*\*/);
  assert.match(markdown, /\/home\/user/);
  assert.match(markdown, /final answer/);
});

test('classic/full mode user text is cleaned when transcript starts with environment_context', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-env-2' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '<environment_context><cwd>C:\\\\demo</cwd><shell>powershell</shell></environment_context>\n\n测试',
        }],
      },
    },
    {
      timestamp: '2026-05-29T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    },
  ]);
  const { messages } = parseTranscript(filePath, 0);
  const normalized = normalizeMessages(messages);

  const classicMarkdown = formatMessages(filterMessagesBySyncMode(normalized, 'classic', null), TEMPLATE);
  const fullMarkdown = formatMessages(normalized, TEMPLATE);

  assert.match(classicMarkdown, /测试/);
  assert.equal(classicMarkdown.includes('<environment_context>'), false);
  assert.match(fullMarkdown, /测试/);
  assert.equal(fullMarkdown.includes('<environment_context>'), false);
});

test('新会话首轮延迟后，文档标题仍使用第一条 user 文本', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-title-1' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '<environment_context><cwd>C:\\\\demo</cwd></environment_context>\n\n你好',
        }],
      },
    },
    {
      timestamp: '2026-05-29T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '世界' }] },
    },
    { type: 'turn_context', payload: { turn_id: 'turn-title-2' } },
    {
      timestamp: '2026-05-29T01:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第二轮' }] },
    },
    {
      timestamp: '2026-05-29T01:00:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '继续' }] },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);
  const normalized = normalizeMessages(messages);
  const filtered = filterMessagesBySyncMode(normalized, 'classic', null);
  const firstUserMsg = filtered.find((msg) => msg.role === 'user');
  const firstText = firstUserMsg ? firstUserMsg.parts.find((part) => part.type === 'text')?.text || '' : '';
  const { title } = generateDocHeader({
    projectName: 'codex-to-siyuan',
    sessionId: 'sid-title',
    headerTemplate: '# ${projectName}',
    firstUserMessage: firstText,
  });

  assert.match(title, /你好/);
  assert.equal(title.includes('environment_context'), false);
});

// ── Old config compatibility ──────────────────────────────────────

test('undefined syncMode defaults to classic', () => {
  const normalized = buildComplexNormalized();
  const lastAssistantMessage = 'compat answer';

  const filtered = filterMessagesBySyncMode(normalized, undefined, lastAssistantMessage);
  const markdown = formatMessages(filtered, TEMPLATE);

  assert.match(markdown, /run a command/);
  assert.match(markdown, /final answer/);
  assert.equal(markdown.includes('compat answer'), false);
  assert.equal(markdown.includes('Tool:'), false);
  assert.equal(markdown.includes('before tool'), false);
});

test('invalid syncMode defaults to classic', () => {
  const normalized = buildComplexNormalized();
  const lastAssistantMessage = 'invalid mode fallback';

  const filtered = filterMessagesBySyncMode(normalized, 'bogus', lastAssistantMessage);
  const markdown = formatMessages(filtered, TEMPLATE);

  assert.match(markdown, /run a command/);
  assert.match(markdown, /final answer/);
  assert.equal(markdown.includes('invalid mode fallback'), false);
  assert.equal(markdown.includes('Tool:'), false);
});

// ── buildFinalAssistantMessage ────────────────────────────────────

test('buildFinalAssistantMessage returns last_assistant_message when present', () => {
  const normalized = buildComplexNormalized();
  const result = buildFinalAssistantMessage('hook message', normalized);

  assert.notEqual(result, null);
  assert.equal(result.role, 'assistant');
  assert.equal(result.parts[0].text, 'hook message');
});

test('buildFinalAssistantMessage falls back to last normalized assistant text', () => {
  const normalized = buildComplexNormalized();
  const result = buildFinalAssistantMessage(null, normalized);

  assert.notEqual(result, null);
  assert.equal(result.role, 'assistant');
  assert.equal(result.parts[0].text, 'final answer');
});

test('buildFinalAssistantMessage returns null when no assistant text at all', () => {
  const normalized = [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }];
  const result = buildFinalAssistantMessage(null, normalized);

  assert.equal(result, null);
});

test('buildFinalAssistantMessage ignores empty/whitespace last_assistant_message', () => {
  const normalized = buildComplexNormalized();
  const result = buildFinalAssistantMessage('   ', normalized);

  assert.notEqual(result, null);
  // Should fall back to last normalized text since whitespace is trimmed away
  assert.equal(result.parts[0].text, 'final answer');
});
