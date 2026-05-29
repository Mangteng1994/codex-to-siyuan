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
} = require('../src/formatter');
const {
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

test('classic mode filters to user text + final assistant output (with last_assistant_message)', () => {
  const normalized = buildComplexNormalized();
  const lastAssistantMessage = 'the hook-provided response';

  const filtered = filterMessagesBySyncMode(normalized, 'classic', lastAssistantMessage);
  const markdown = formatMessages(filtered, TEMPLATE);

  // Should contain user text
  assert.match(markdown, /run a command/);

  // Should contain last_assistant_message
  assert.match(markdown, /the hook-provided response/);

  // Should NOT contain tool use, tool result, or intermediate assistant text
  assert.equal(markdown.includes('Tool:'), false);
  assert.equal(markdown.includes('Tool Result'), false);
  assert.equal(markdown.includes('before tool'), false);
  assert.equal(markdown.includes('/home/user'), false);
  assert.equal(markdown.includes('final answer'), false);

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

// ── Old config compatibility ──────────────────────────────────────

test('undefined syncMode defaults to classic', () => {
  const normalized = buildComplexNormalized();
  const lastAssistantMessage = 'compat answer';

  const filtered = filterMessagesBySyncMode(normalized, undefined, lastAssistantMessage);
  const markdown = formatMessages(filtered, TEMPLATE);

  assert.match(markdown, /run a command/);
  assert.match(markdown, /compat answer/);
  assert.equal(markdown.includes('Tool:'), false);
  assert.equal(markdown.includes('before tool'), false);
});

test('invalid syncMode defaults to classic', () => {
  const normalized = buildComplexNormalized();
  const lastAssistantMessage = 'invalid mode fallback';

  const filtered = filterMessagesBySyncMode(normalized, 'bogus', lastAssistantMessage);
  const markdown = formatMessages(filtered, TEMPLATE);

  assert.match(markdown, /run a command/);
  assert.match(markdown, /invalid mode fallback/);
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
