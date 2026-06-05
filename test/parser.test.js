const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  cleanMessageText,
  parseCodexEntry,
  parseTranscript,
  normalizeMessages,
} = require('../src/parser');
const {
  formatMessages,
  formatOneMessage,
  formatToolUse,
  formatToolResult,
  generateDocHeader,
  sanitizePathSegment,
  balanceMarkdownFences,
} = require('../src/formatter');
const { buildFallbackAssistantMessage } = require('../hook');

const TEMPLATE = '## ${role} (${time})\n\n${content}\n\n---\n';

function writeJsonl(entries) {
  const filePath = path.join(os.tmpdir(), `codex-to-siyuan-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return filePath;
}

function captureStderr(fn) {
  const originalWrite = process.stderr.write;
  let output = '';
  process.stderr.write = (chunk, encoding, callback) => {
    output += String(chunk);
    if (typeof callback === 'function') callback();
    return true;
  };

  try {
    fn();
  } finally {
    process.stderr.write = originalWrite;
  }

  return output;
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test('Claude-style user and assistant transcript still parses', () => {
  const filePath = writeJsonl([
    { timestamp: '2026-05-29T01:00:00.000Z', type: 'user', message: { content: 'hello' } },
    { timestamp: '2026-05-29T01:00:01.000Z', type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].parts[0].text, 'hello');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].parts[0].text, 'hi');
});

test('Codex response_item message parses user and assistant text', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-1' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] },
    },
    {
      timestamp: '2026-05-29T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].turnId, 'turn-1');
  assert.equal(messages[0].parts[0].text, 'question');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].parts[0].text, 'answer');
});

test('cleanMessageText removes environment_context and keeps real正文', () => {
  const raw = `
    <environment_context>
      <cwd>C:\\demo</cwd>
      <shell>powershell</shell>
      <current_date>2026-05-31</current_date>
      <timezone>Asia/Shanghai</timezone>
    </environment_context>

    测试
  `;

  assert.equal(cleanMessageText(raw), '测试');
});

test('cleanMessageText removes environment_context and keeps real user text 在吗', () => {
  const raw = `
<environment_context>
  <cwd>C:\\demo</cwd>
  <shell>powershell</shell>
</environment_context>

在吗
  `;

  assert.equal(cleanMessageText(raw), '在吗');
});

test('cleanMessageText returns empty when only environment_context exists', () => {
  const raw = `
    <environment_context>
      <cwd>C:\\demo</cwd>
      <shell>powershell</shell>
      <current_date>2026-05-31</current_date>
      <timezone>Asia/Shanghai</timezone>
    </environment_context>
  `;

  assert.equal(cleanMessageText(raw), '');
});

test('Codex user message strips environment_context before writing', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-env-1' } },
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
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].parts[0].text, '测试');
});

test('Codex user message parses from payload.input string when not in message.content', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-input-1' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'turn_input',
        role: 'user',
        input: '<environment_context><cwd>C:\\\\demo</cwd></environment_context>\n\n在吗',
      },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].turnId, 'turn-input-1');
  assert.equal(messages[0].parts[0].text, '在吗');
});

test('Codex user message parses from payload.message.content when payload.type is not message', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-input-2' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'input',
        role: 'user',
        message: {
          content: [{ type: 'input_text', text: '在吗' }],
        },
      },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].parts[0].text, '在吗');
});

test('metadata-like payload.input object is not misclassified as user text', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-input-3' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'turn_input',
        role: 'user',
        input: {
          cwd: 'C:\\demo',
          session_id: 'sid-1',
          model: 'gpt-x',
        },
      },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 0);
});

test('user-like event type is not misclassified as formal user message', () => {
  const filePath = writeJsonl([
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'user_context_event',
      payload: {
        type: 'user_context_event',
        input: '嘻嘻',
      },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 0);
});

test('debug skipped entry uses CODEX_TO_SIYUAN_DEBUG_NEEDLE instead of hardcoded text', () => {
  const filePath = writeJsonl([
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'metadata',
      payload: { type: 'cache', role: 'system', message: '你好' },
    },
  ]);
  const originalDebug = process.env.CODEX_TO_SIYUAN_DEBUG;
  const originalNeedle = process.env.CODEX_TO_SIYUAN_DEBUG_NEEDLE;

  process.env.CODEX_TO_SIYUAN_DEBUG = '1';
  process.env.CODEX_TO_SIYUAN_DEBUG_NEEDLE = '你好';
  let stderr = '';
  try {
    stderr = captureStderr(() => parseTranscript(filePath, 0));
  } finally {
    restoreEnv('CODEX_TO_SIYUAN_DEBUG', originalDebug);
    restoreEnv('CODEX_TO_SIYUAN_DEBUG_NEEDLE', originalNeedle);
  }

  assert.match(stderr, /skipped transcript entry/);
  assert.match(stderr, /entry\.type=metadata/);
  assert.match(stderr, /payload\.type=cache/);
  assert.match(stderr, /payload\.role=system/);
  assert.match(stderr, /needle=你好/);
  assert.match(stderr, /matches=entry\.payload\.message/);
  assert.equal(stderr.includes('嘻嘻'), false);
});

test('debug skipped entry without needle prints suspicious text fields', () => {
  const filePath = writeJsonl([
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'metadata',
      payload: { type: 'cache', content: '可疑文本' },
    },
  ]);
  const originalDebug = process.env.CODEX_TO_SIYUAN_DEBUG;
  const originalNeedle = process.env.CODEX_TO_SIYUAN_DEBUG_NEEDLE;

  process.env.CODEX_TO_SIYUAN_DEBUG = '1';
  delete process.env.CODEX_TO_SIYUAN_DEBUG_NEEDLE;
  let stderr = '';
  try {
    stderr = captureStderr(() => parseTranscript(filePath, 0));
  } finally {
    restoreEnv('CODEX_TO_SIYUAN_DEBUG', originalDebug);
    restoreEnv('CODEX_TO_SIYUAN_DEBUG_NEEDLE', originalNeedle);
  }

  assert.match(stderr, /skipped transcript entry/);
  assert.match(stderr, /entry\.keys=timestamp\|type\|payload/);
  assert.match(stderr, /payload\.keys=type\|content/);
  assert.match(stderr, /suspicious=entry\.payload\.content="可疑文本"/);
});

test('event_msg user_message parses first-turn user text', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-event-1' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        text: '<environment_context><cwd>C:\\\\demo</cwd></environment_context>\n\n你好',
      },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].turnId, 'turn-event-1');
  assert.equal(messages[0].source, 'payload.text');
  assert.equal(messages[0].parts[0].text, '你好');
});

test('codex_event user_message parses payload.message content', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-event-2' } },
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'codex_event',
      payload: {
        type: 'user_message',
        message: {
          content: [{ type: 'input_text', text: '你号码' }],
        },
      },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].parts[0].text, '你号码');
});

test('direct turn_input entry parses first-turn user text', () => {
  const filePath = writeJsonl([
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'turn_input',
      turn_id: 'turn-direct-1',
      input: '你好',
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].turnId, 'turn-direct-1');
  assert.equal(messages[0].parts[0].text, '你好');
});

test('same turn duplicate user text is deduped during normalization', () => {
  const normalized = normalizeMessages([
    { role: 'user', turnId: 'turn-dup', parts: [{ type: 'text', text: '嘻嘻 不嘻嘻' }] },
    { role: 'user', turnId: 'turn-dup', parts: [{ type: 'text', text: ' 嘻嘻   不嘻嘻 ' }] },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].parts[0].text, '嘻嘻 不嘻嘻');
});

test('user message with only environment_context is ignored', () => {
  const filePath = writeJsonl([
    {
      timestamp: '2026-05-29T01:00:00.000Z',
      type: 'user',
      message: {
        content: `
<environment_context>
  <cwd>C:\\SiYuanData\\data\\plugins\\siyuan-plugin-gitee-pages</cwd>
  <shell>powershell</shell>
  <current_date>2026-05-31</current_date>
  <timezone>Asia/Shanghai</timezone>
</environment_context>
        `,
      },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 0);
});

test('three assistant response_items after one user render as one Codex heading', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-2' } },
    {
      timestamp: '2026-05-29T02:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do work' }] },
    },
    {
      timestamp: '2026-05-29T02:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'phase one' }] },
    },
    {
      timestamp: '2026-05-29T02:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'phase two' }] },
    },
    {
      timestamp: '2026-05-29T02:00:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'phase three' }] },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);
  const markdown = formatMessages(normalizeMessages(messages), TEMPLATE);

  assert.equal((markdown.match(/🤖 Codex/g) || []).length, 1);
  assert.match(markdown, /phase one/);
  assert.match(markdown, /phase two/);
  assert.match(markdown, /phase three/);
});

test('merged assistant text parts are separated by blank lines', () => {
  const normalized = normalizeMessages([
    { role: 'assistant', timestamp: '2026-05-29T02:00:01.000Z', parts: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', timestamp: '2026-05-29T02:00:02.000Z', parts: [{ type: 'text', text: 'second' }] },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].parts[0].text, 'first\n\nsecond');
});

function assertNoDetailsHtml(markdown) {
  assert.equal(markdown.includes('<details>'), false);
  assert.equal(markdown.includes('</details>'), false);
  assert.equal(markdown.includes('<summary>'), false);
  assert.equal(markdown.includes('</summary>'), false);
}

test('formatToolUse renders Markdown without details HTML', () => {
  const markdown = formatToolUse({
    name: 'shell_command',
    input: '{\n  "command": "node --version"\n}',
  });

  assertNoDetailsHtml(markdown);
  assert.match(markdown, /\*\*🔧 Tool: shell_command\*\*/);
  assert.match(markdown, /```json\n\{\n  "command": "node --version"\n\}\n```/);
});

test('formatToolUse without input renders no empty code block', () => {
  const markdown = formatToolUse({ name: 'shell_command', input: '' });

  assertNoDetailsHtml(markdown);
  assert.equal(markdown, '**🔧 Tool: shell_command**');
  assert.equal(markdown.includes('```'), false);
});

test('formatToolResult renders Markdown without details HTML', () => {
  const markdown = formatToolResult({ text: 'v22.0.0' });

  assertNoDetailsHtml(markdown);
  assert.match(markdown, /\*\*📋 Tool Result\*\*/);
  assert.match(markdown, /```\nv22\.0\.0\n```/);
});

test('message template still renders heading content and separator', () => {
  const markdown = formatOneMessage({
    role: 'assistant',
    timestamp: '2026-05-29T06:11:00.000Z',
    parts: [{ type: 'text', text: 'content' }],
  }, TEMPLATE);

  assert.match(markdown, /^## 🤖 Codex \(\d\d:\d\d\)\n\ncontent\n\n---\n$/);
});

test('Codex tool_use and tool_result render as plain Markdown code blocks', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-3' } },
    {
      timestamp: '2026-05-29T03:00:01.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell_command', arguments: { command: 'node --version' } },
    },
    {
      timestamp: '2026-05-29T03:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'v22.0.0' },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);
  const markdown = formatMessages(normalizeMessages(messages), TEMPLATE);

  assertNoDetailsHtml(markdown);
  assert.match(markdown, /\*\*🔧 Tool: shell_command\*\*/);
  assert.match(markdown, /```json/);
  assert.match(markdown, /\*\*📋 Tool Result\*\*/);
  assert.match(markdown, /v22\.0\.0/);
});

test('same turn merges assistant messages and tool parts into one Codex block', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-4' } },
    {
      timestamp: '2026-05-29T04:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run command' }] },
    },
    {
      timestamp: '2026-05-29T04:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'before tool' }] },
    },
    {
      timestamp: '2026-05-29T04:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell_command', arguments: { command: 'pwd' } },
    },
    {
      timestamp: '2026-05-29T04:00:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after tool' }] },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);
  const markdown = formatMessages(normalizeMessages(messages), TEMPLATE);

  assert.equal((markdown.match(/🤖 Codex/g) || []).length, 1);
  assert.match(markdown, /before tool/);
  assert.match(markdown, /Tool: shell_command/);
  assert.match(markdown, /after tool/);
});

test('fallback assistant message can be built from last_assistant_message', () => {
  const message = buildFallbackAssistantMessage('final answer');

  assert.equal(message.role, 'assistant');
  assert.equal(message.parts[0].type, 'text');
  assert.equal(message.parts[0].text, 'final answer');
});


test('cleanMessageText removes turn_aborted blocks', () => {
  const raw = `用户文本
<turn_aborted>
The user interrupted...
</turn_aborted>
`;

  const cleaned = cleanMessageText(raw);
  assert.equal(cleaned.includes('turn_aborted'), false);
  assert.equal(cleaned.includes('The user interrupted'), false);
  assert.match(cleaned, /用户文本/);
});

test('cleanMessageText removes turn_aborted before environment_context', () => {
  const raw = `<turn_aborted>用户中断</turn_aborted>

<environment_context><cwd>C:\\demo</cwd></environment_context>

测试`;

  const cleaned = cleanMessageText(raw);
  assert.equal(cleaned.includes('turn_aborted'), false);
  assert.equal(cleaned.includes('用户中断'), false);
  assert.equal(cleaned.includes('environment_context'), false);
  assert.equal(cleaned, '测试');
});

test('cleanMessageText strips full AGENTS instructions block and keeps real user text', () => {
  const raw = `# AGENTS.md instructions for C:\\SiYuanData\\data\\plugins\\siyuan-plugin-gitee-pages

<INSTRUCTIONS>
## 全局代理规则

- 始终使用中文回复。

--- project-doc ---

# AGENTS.md — siyuan-plugin-gitee-pages

Repo = SiYuan desktop plugin.
</INSTRUCTIONS>
两个Agents.md`;

  const cleaned = cleanMessageText(raw);
  assert.equal(cleaned, '两个Agents.md');
});

test('cleanMessageText removes subagent_notification blocks', () => {
  const raw = `<subagent_notification>
worker done
</subagent_notification>

继续`;

  const cleaned = cleanMessageText(raw);
  assert.equal(cleaned.includes('subagent_notification'), false);
  assert.equal(cleaned, '继续');
});

test('cleanMessageText removes subagent_notification together with environment_context', () => {
  const raw = `<subagent_notification>done</subagent_notification>
<environment_context><cwd>C:\\demo</cwd></environment_context>

正文`;

  const cleaned = cleanMessageText(raw);
  assert.equal(cleaned.includes('subagent_notification'), false);
  assert.equal(cleaned.includes('environment_context'), false);
  assert.equal(cleaned, '正文');
});

test('cleanMessageText strips residual AGENTS instructions prefix before closing tag', () => {
  const raw = `xxx AGENTS.md instructions for C:\\repo
还有一些说明
</INSTRUCTIONS>
10`;

  assert.equal(cleanMessageText(raw), '10');
});

test('cleanMessageText keeps normal user text mentioning AGENTS.md file', () => {
  assert.equal(cleanMessageText('请阅读 AGENTS.md 文件'), '请阅读 AGENTS.md 文件');
});

test('cleanMessageText strips bare AGENTS instruction header and collapses repeated 10', () => {
  const raw = '# AGENTS.md instructions for C:\\repo\n\n10\n\n10';

  assert.equal(cleanMessageText(raw), '10');
});

test('cleanMessageText strips multiple leading bare AGENTS headers', () => {
  const raw = '# AGENTS.md instructions for C:\\global\n# AGENTS.md instructions for C:\\repo\n\n10\n\n10';

  assert.equal(cleanMessageText(raw), '10');
});

test('cleanMessageText keeps mixed text when lines are not all identical', () => {
  const raw = '10\n\n请解释';

  assert.equal(cleanMessageText(raw), '10\n\n请解释');
});

test('parseCodexEntry ignores reasoning and message_delta payloads', () => {
  const reasoning = parseCodexEntry({
    type: 'response_item',
    payload: {
      type: 'reasoning',
      role: 'assistant',
      text: '这段推理不该进入正文',
    },
  }, 'turn-reasoning');
  const delta = parseCodexEntry({
    type: 'response_item',
    payload: {
      type: 'message_delta',
      role: 'assistant',
      text: '这段增量也不该进入正文',
    },
  }, 'turn-reasoning');

  assert.equal(reasoning, null);
  assert.equal(delta, null);
});

test('normalizeMessages avoids duplicate 10 across merged text parts after AGENTS cleanup', () => {
  const normalized = normalizeMessages([
    {
      role: 'user',
      turnId: 't1',
      parts: [{ type: 'text', text: cleanMessageText('# AGENTS.md instructions for C:\\repo\n\n10') }],
    },
    {
      role: 'user',
      turnId: 't1',
      parts: [{ type: 'text', text: cleanMessageText('10') }],
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].parts.length, 1);
  assert.equal(normalized[0].parts[0].text, '10');
});

test('formatted assistant body excludes reasoning and message_delta transcript items', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-final-only' } },
    {
      timestamp: '2026-06-01T01:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '10' }] },
    },
    {
      timestamp: '2026-06-01T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', role: 'assistant', text: '隐藏推理' },
    },
    {
      timestamp: '2026-06-01T01:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message_delta', role: 'assistant', text: '增量输出' },
    },
    {
      timestamp: '2026-06-01T01:00:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最终回复' }] },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);
  const markdown = formatMessages(normalizeMessages(messages), TEMPLATE);

  assert.match(markdown, /最终回复/);
  assert.equal(markdown.includes('隐藏推理'), false);
  assert.equal(markdown.includes('增量输出'), false);
});

test('balanceMarkdownFences adds closing fence when odd count', () => {
  const text = '```javascript\nconst x = 1;\n';
  const balanced = balanceMarkdownFences(text);
  assert.match(balanced, /```$/m);
  const count = (balanced.match(/^[ \t]*```/gm) || []).length;
  assert.equal(count % 2, 0);
});

test('balanceMarkdownFences does not modify already-balanced fences', () => {
  const text = '```javascript\nconst x = 1;\n```\n';
  const balanced = balanceMarkdownFences(text);
  assert.equal(balanced, text);
});

test('balanceMarkdownFences handles text without any fences', () => {
  const text = 'plain text without fences';
  assert.equal(balanceMarkdownFences(text), text);
});

test('formatMessages auto-closes unclosed code fence to protect following headings', () => {
  const messages = [
    {
      role: 'assistant',
      timestamp: '2026-05-29T06:00:00.000Z',
      parts: [{ type: 'text', text: '```javascript\nconst x = 1;\n' }],
    },
    {
      role: 'user',
      timestamp: '2026-05-29T06:01:00.000Z',
      parts: [{ type: 'text', text: 'next question' }],
    },
  ];
  const markdown = formatMessages(messages, '## ${role} (${time})\n\n${content}\n\n---\n');
  assert.match(markdown, /```\n\n---\n/);
  assert.match(markdown, /## 🧑 User/);
});


test('debug needle scan finds skipped entry with matching text', () => {
  const oldDebug = process.env.CODEX_TO_SIYUAN_DEBUG;
  const oldNeedle = process.env.CODEX_TO_SIYUAN_DEBUG_NEEDLE;
  process.env.CODEX_TO_SIYUAN_DEBUG = '1';
  process.env.CODEX_TO_SIYUAN_DEBUG_NEEDLE = 'UNIQUE_NEEDLE_XYZ123';

  const filePath = writeJsonl([
    { type: 'unknown_event', payload: { type: 'custom_type', text: 'contains UNIQUE_NEEDLE_XYZ123 here' } },
    { type: 'user', message: { content: 'normal message' } },
  ]);

  let stderrOutput = '';
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { stderrOutput += String(chunk); return true; };

  try {
    parseTranscript(filePath, 0);
  } finally {
    process.stderr.write = orig;
    process.env.CODEX_TO_SIYUAN_DEBUG = oldDebug;
    process.env.CODEX_TO_SIYUAN_DEBUG_NEEDLE = oldNeedle;
  }

  // Should have printed structured debug for the matching entry
  assert.match(stderrOutput, /STRUCT unhandled entry/);
  assert.match(stderrOutput, /STRUCT HIT:/);
  assert.match(stderrOutput, /UNIQUE_NEEDLE_XYZ123/);
  assert.match(stderrOutput, /entry\.type=/);
  assert.match(stderrOutput, /payload\.type=/);
});


test('payload.type=turn_input with payload.role=user parses as user message', () => {
  const filePath = writeJsonl([
    { type: 'turn_context', payload: { turn_id: 'turn-input-nested' } },
    {
      timestamp: '2026-05-31T15:00:00.000Z',
      type: 'codex_event',
      payload: { type: 'turn_input', role: 'user', input: '<environment_context><cwd>C:\\demo</cwd></environment_context>\n\n测试首轮用户123' },
    },
    {
      timestamp: '2026-05-31T15:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到回复' }] },
    },
  ]);

  const { messages } = parseTranscript(filePath, 0);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].turnId, 'turn-input-nested');
  assert.match(messages[0].parts[0].text, /测试首轮用户123/);
  assert.equal(messages[0].parts[0].text.includes('environment_context'), false);

  assert.equal(messages[1].role, 'assistant');
  assert.match(messages[1].parts[0].text, /收到回复/);
});

test('document title removes unsafe path characters', () => {
  const unsafe = 'a/b\\c:d*e?f"g<h>i|j   k';
  const { title } = generateDocHeader({
    projectName: 'proj/name',
    sessionId: 'session',
    headerTemplate: '# ${projectName}',
    firstUserMessage: unsafe,
  });

  assert.equal(/[\\/:*?"<>|]/.test(title), false);
  assert.equal(/\s{2,}/.test(title), false);
  assert.equal(sanitizePathSegment(unsafe), 'a b c d e f g h i j k');
});
