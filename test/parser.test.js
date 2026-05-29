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
  formatOneMessage,
  formatToolUse,
  formatToolResult,
  generateDocHeader,
  sanitizePathSegment,
} = require('../src/formatter');
const { buildFallbackAssistantMessage } = require('../hook');

const TEMPLATE = '## ${role} (${time})\n\n${content}\n\n---\n';

function writeJsonl(entries) {
  const filePath = path.join(os.tmpdir(), `codex-to-siyuan-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return filePath;
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
