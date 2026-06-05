/**
 * JSONL session transcript parser.
 * Extracts user & assistant messages from a session transcript file.
 */

const fs = require('fs');
const TOOL_LIKE_TYPES = new Set([
  'function_call',
  'function_call_output',
  'tool_call',
  'tool_use',
  'tool_result',
  'tool_output',
]);

/**
 * 剥离 Codex 自动注入的 AGENTS/INSTRUCTIONS 文本。
 * 不删除普通用户正文里提到的 “AGENTS.md 文件”。
 * @param {string} text
 * @returns {string}
 */
function stripLeadingAgentsInstructionHeader(text) {
  let cleaned = String(text || '');
  let matched = true;

  while (matched) {
    matched = false;
    cleaned = cleaned.replace(/^\s*# AGENTS\.md instructions for [^\r\n]*(?:\r?\n)+/i, () => {
      matched = true;
      return '';
    });
  }

  return cleaned;
}

/**
 * 剥离 Codex 自动注入的 AGENTS/INSTRUCTIONS 文本。
 * @param {string} text
 * @returns {string}
 */
function stripCodexInjectedInstructions(text) {
  let cleaned = String(text || '');

  cleaned = cleaned.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/g, '');

  const endTag = '</INSTRUCTIONS>';
  let endIndex = cleaned.indexOf(endTag);
  while (endIndex !== -1) {
    const prefix = cleaned.slice(0, endIndex);
    const looksLikeInjected = prefix.includes('<INSTRUCTIONS>')
      || prefix.includes('# AGENTS.md instructions for')
      || prefix.includes('AGENTS.md instructions for');

    if (!looksLikeInjected) {
      break;
    }

    cleaned = cleaned.slice(endIndex + endTag.length).replace(/^\s+/, '');
    endIndex = cleaned.indexOf(endTag);
  }

  cleaned = stripLeadingAgentsInstructionHeader(cleaned);
  return cleaned;
}

/**
 * 对连续重复行去重，避免首轮用户输入被写成两行相同内容。
 * @param {string} text
 * @returns {string}
 */
function dedupeConsecutiveDuplicateLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const deduped = [];

  for (const line of lines) {
    const prev = deduped[deduped.length - 1];
    if (prev !== undefined && prev === line && line.trim()) {
      continue;
    }
    deduped.push(line);
  }

  return deduped.join('\n');
}

/**
 * 如果所有非空行完全相同，则折叠成单行。
 * @param {string} text
 * @returns {string}
 */
function collapseRepeatedOnlyText(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const nonEmptyLines = lines
    .map(line => line.trim())
    .filter(Boolean);

  if (nonEmptyLines.length <= 1) {
    return raw;
  }

  const first = nonEmptyLines[0];
  if (nonEmptyLines.every(line => line === first)) {
    return first;
  }

  return raw;
}

/**
 * 清理消息文本中的环境上下文块与注入指令。
 * @param {string} text
 * @returns {string}
 */
function cleanMessageText(text) {
  const withoutEnvironment = String(text || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>\s*/g, '')
    .replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>\s*/g, '')
    .replace(/<subagent_notification>[\s\S]*?<\/subagent_notification>\s*/g, '');
  const withoutInjectedInstructions = stripCodexInjectedInstructions(withoutEnvironment);
  const deduped = dedupeConsecutiveDuplicateLines(withoutInjectedInstructions);
  return collapseRepeatedOnlyText(deduped).trim();
}

/**
 * Parse a JSONL transcript file starting from a given byte offset.
 *
 * @param {string} filePath    - Path to the .jsonl transcript file
 * @param {number} [byteOffset=0] - Byte offset to start reading from (for incremental processing)
 * @returns {{messages: Array, newByteOffset: number}}
 */
function parseTranscript(filePath, byteOffset = 0) {
  const content = fs.readFileSync(filePath, 'utf8');
  const bytes = Buffer.from(content, 'utf8');

  // If we have a byte offset, skip to that position
  const startContent = byteOffset > 0
    ? Buffer.from(bytes.subarray(byteOffset)).toString('utf8')
    : content;

  const lines = startContent.split('\n').filter(line => line.trim());
  const messages = [];
  let currentTurnId = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      currentTurnId = getTurnId(entry) || currentTurnId;

      const msg = parseEntry(entry, currentTurnId);
      if (msg) messages.push(msg);
    } catch (e) {
      debugSkip('malformed_json', null, null, e.message);
      // Skip malformed lines silently
    }
  }

  // New byte offset = total file size
  const newByteOffset = bytes.length;

  return { messages, newByteOffset };
}

/**
 * Parse a JSONL entry from Claude-style or Codex-style transcript.
 * @param {object} entry - Parsed JSON line
 * @param {string|null} [turnId] - Current Codex turn ID
 * @returns {object|null} Structured message or null
 */
function parseEntry(entry, turnId = null) {
  if (entry.type === 'user' || entry.type === 'assistant') {
    return parseMessage(entry, turnId);
  }

  const explicitUserMessage = parseExplicitUserEntry(entry, turnId);
  if (explicitUserMessage) {
    return explicitUserMessage;
  }

  const codexMessage = parseCodexEntry(entry, turnId);
  if (codexMessage) {
    return codexMessage;
  }

  debugSkip(entry.type, entry.payload && entry.payload.type, entry.payload && entry.payload.role, 'unhandled entry', entry);
  return null;
}

/**
 * Parse a single JSONL entry into a structured message.
 * @param {object} entry - Parsed JSON line
 * @param {string|null} [turnId] - Current turn ID
 * @returns {object|null} Structured message or null
 */
function parseMessage(entry, turnId = null) {
  const role = entry.type; // 'user' or 'assistant'
  const timestamp = entry.timestamp || null;

  const extracted = extractLegacyMessageParts(entry, role);
  const parts = extracted.parts;

  if (parts.length === 0) return null;
  debugParsedMessage(entry, role, entry.turn_id || turnId || null, parts, extracted.source);

  return { role, timestamp, parts, turnId: entry.turn_id || turnId || null, source: extracted.source };
}

/**
 * Parse explicit non-response_item user message structures observed in Codex transcripts.
 * @param {object} entry
 * @param {string|null} [turnId]
 * @returns {object|null}
 */
function parseExplicitUserEntry(entry, turnId = null) {
  const payload = entry && entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const timestamp = entry && entry.timestamp || null;
  const resolvedTurnId = getTurnId(entry) || turnId || null;
  const entryType = String(entry && entry.type || '').toLowerCase();
  const payloadType = String(payload && payload.type || '').toLowerCase();

  if (entryType === 'turn_input') {
    return buildExplicitUserMessage(entry, timestamp, resolvedTurnId, [
      ['entry.input', entry && entry.input],
      ['entry.content', entry && entry.content],
      ['entry.text', entry && entry.text],
      ['entry.message.content', entry && entry.message && entry.message.content],
      ['entry.message', entry && entry.message],
    ]);
  }

  if (entryType === 'user_message') {
    return buildExplicitUserMessage(entry, timestamp, resolvedTurnId, [
      ['entry.message.content', entry && entry.message && entry.message.content],
      ['entry.message', entry && entry.message],
      ['entry.text', entry && entry.text],
      ['entry.input', entry && entry.input],
      ['entry.content', entry && entry.content],
    ]);
  }

  if ((entryType === 'event_msg' || entryType === 'codex_event') && payloadType === 'user_message') {
    return buildExplicitUserMessage(entry, timestamp, resolvedTurnId, [
      ['payload.message.content', payload && payload.message && payload.message.content],
      ['payload.message', payload && payload.message],
      ['payload.text', payload && payload.text],
      ['payload.input', payload && payload.input],
      ['payload.content', payload && payload.content],
    ]);
  }

  // payload.type === 'turn_input' with payload.role === 'user'
  // catches {type:"some_new_codex_event", payload:{type:"turn_input",role:"user",input:"..."}}
  if (payloadType === 'turn_input' && String(payload.role || '').toLowerCase() === 'user') {
    return buildExplicitUserMessage(entry, timestamp, resolvedTurnId, [
      ['payload.input', payload && payload.input],
      ['payload.content', payload && payload.content],
      ['payload.text', payload && payload.text],
      ['payload.message.content', payload && payload.message && payload.message.content],
      ['payload.message', payload && payload.message],
    ]);
  }

  return null;
}

/**
 * Build explicit user message from prioritized sources.
 * @param {object} entry
 * @param {string|null} timestamp
 * @param {string|null} turnId
 * @param {Array<[string, *]>} sources
 * @returns {object|null}
 */
function buildExplicitUserMessage(entry, timestamp, turnId, sources) {
  for (const [source, value] of sources) {
    const parts = extractTextPartsFromValue(value);
    if (parts.length > 0) {
      debugParsedMessage(entry, 'user', turnId, parts, source);
      return { role: 'user', timestamp, parts, turnId, source };
    }
  }
  return null;
}

/**
 * Parse a Codex entry into the same structured message shape.
 * @param {object} entry - Parsed JSON line
 * @param {string|null} [turnId] - Current turn ID
 * @returns {object|null} Structured message or null
 */
function parseCodexEntry(entry, turnId = null) {
  if (entry.type !== 'response_item') {
    return null;
  }

  const payload = entry.payload || {};
  const timestamp = entry.timestamp || null;
  const resolvedTurnId = payload.turn_id || entry.turn_id || turnId || null;

  if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    const msg = parseCodexMessage(payload.role, timestamp, payload.content, resolvedTurnId, 'payload.content', entry);
    if (msg) return msg;
    return null;
  }

  if (payload.role === 'user' && isUserInputPayloadType(payload.type)) {
    const extracted = extractUserInputPayloadParts(payload);
    if (extracted.parts.length > 0) {
      debugParsedMessage(entry, 'user', resolvedTurnId, extracted.parts, extracted.source);
      return {
        role: 'user',
        timestamp,
        parts: extracted.parts,
        turnId: resolvedTurnId,
        source: extracted.source,
      };
    }
  }

  if (payload.type === 'reasoning' || payload.type === 'message_delta') {
    return null;
  }

  const toolUse = parseCodexToolUse(payload);
  if (toolUse) {
    return { role: 'assistant', timestamp, parts: [toolUse], turnId: resolvedTurnId };
  }

  const toolResult = parseCodexToolResult(payload);
  if (toolResult) {
    return { role: 'assistant', timestamp, parts: [toolResult], turnId: resolvedTurnId };
  }

  const text = extractCodexReadableText(payload);
  if (text) {
    const parts = [{ type: 'text', text }];
    debugParsedMessage(entry, 'assistant', resolvedTurnId, parts, 'payload.text|payload.content|payload.summary');
    return {
      role: 'assistant',
      timestamp,
      parts,
      turnId: resolvedTurnId,
      source: 'payload.text|payload.content|payload.summary',
    };
  }

  debugSkip(entry.type, payload.type, payload.role, 'unhandled codex payload', entry);
  return null;
}

/**
 * Parse Codex message content blocks.
 * @param {string} role - user or assistant
 * @param {string|null} timestamp
 * @param {string|Array} rawContent
 * @param {string|null} [turnId] - Current turn ID
 * @param {string} [source]
 * @param {object} [entry]
 * @returns {object|null} Structured message or null
 */
function parseCodexMessage(role, timestamp, rawContent, turnId = null, source = 'payload.content', entry = null) {
  if (!rawContent) return null;

  const parts = extractTextPartsFromValue(rawContent);

  if (parts.length === 0) return null;
  debugParsedMessage(entry, role, turnId, parts, source);

  return { role, timestamp, parts, turnId, source };
}

/**
 * Extract legacy user/assistant entry content by priority.
 * @param {object} entry
 * @param {string} role
 * @returns {{parts:Array, source:string}}
 */
function extractLegacyMessageParts(entry, role) {
  const sources = [
    ['entry.message.content', entry && entry.message && entry.message.content],
    ['entry.content', entry && entry.content],
    ['entry.text', entry && entry.text],
    ['entry.input', entry && entry.input],
  ];

  for (const [source, value] of sources) {
    const parts = extractTextPartsFromValue(value, { includeTools: role === 'assistant' });
    if (parts.length > 0) {
      return { parts, source };
    }
  }

  return { parts: [], source: '' };
}

/**
 * Whether payload type is an official user-input message container.
 * @param {string} type
 * @returns {boolean}
 */
function isUserInputPayloadType(type) {
  return ['input', 'turn_input', 'user_input'].includes(String(type || '').toLowerCase());
}

/**
 * Extract user input payload content by priority, one source only.
 * @param {object} payload
 * @returns {{parts:Array, source:string}}
 */
function extractUserInputPayloadParts(payload) {
  const sources = [
    ['payload.input', payload && payload.input],
    ['payload.content', payload && payload.content],
    ['payload.message.content', payload && payload.message && payload.message.content],
  ];

  for (const [source, value] of sources) {
    const parts = extractTextPartsFromValue(value);
    if (parts.length > 0) {
      return { parts, source };
    }
  }

  return { parts: [], source: '' };
}

/**
 * Extract text/tool parts from one selected source.
 * @param {*} value
 * @param {object} [options]
 * @param {boolean} [options.includeTools=false]
 * @returns {Array}
 */
function extractTextPartsFromValue(value, options = {}) {
  if (!value) return [];
  const includeTools = options.includeTools === true;

  if (typeof value === 'string') {
    const text = cleanMessageText(value);
    return text ? [{ type: 'text', text }] : [];
  }

  if (Array.isArray(value)) {
    const parts = [];
    for (const block of value) {
      if (!block) continue;
      if (typeof block === 'string') {
        const text = cleanMessageText(block);
        if (text) parts.push({ type: 'text', text });
        continue;
      }

      const type = String(block.type || '').toLowerCase();
      const text = block.text || block.input_text || block.output_text || '';
      if ((type === 'text' || type === 'input_text' || type === 'output_text') && text) {
        const sanitized = cleanMessageText(text);
        if (sanitized) parts.push({ type: 'text', text: sanitized });
      } else if (includeTools && type === 'tool_use') {
        parts.push({
          type: 'tool_use',
          name: block.name || 'unknown',
          input: summarizeToolInput(block.input),
        });
      } else if (includeTools && type === 'tool_result') {
        const resultText = extractToolResultText(block);
        if (resultText) parts.push({ type: 'tool_result', text: resultText });
      }
    }

    return parts;
  }

  if (typeof value === 'object') {
    const type = String(value.type || '').toLowerCase();
    const text = value.text || value.input_text || value.output_text || '';
    if ((type === 'text' || type === 'input_text' || type === 'output_text') && text) {
      const sanitized = cleanMessageText(text);
      return sanitized ? [{ type: 'text', text: sanitized }] : [];
    }
    return [];
  }
  return [];
}

/**
 * Parse Codex tool-call-like payloads.
 * @param {object} payload
 * @returns {object|null}
 */
function parseCodexToolUse(payload) {
  const toolTypes = new Set(['function_call', 'tool_call', 'tool_use']);
  if (!toolTypes.has(payload.type)) return null;

  const name = payload.name || payload.tool_name || payload.call_name || 'unknown';
  const input = payload.arguments !== undefined
    ? payload.arguments
    : (payload.input !== undefined ? payload.input : payload.params);

  return {
    type: 'tool_use',
    name,
    input: summarizeToolInput(input),
  };
}

/**
 * Parse Codex tool-result-like payloads.
 * @param {object} payload
 * @returns {object|null}
 */
function parseCodexToolResult(payload) {
  const resultTypes = new Set(['function_call_output', 'tool_result', 'tool_output']);
  if (!resultTypes.has(payload.type)) return null;

  const text = payload.output !== undefined
    ? payload.output
    : (payload.content !== undefined ? payload.content : payload.result);
  const resultText = extractAnyText(text, 300);
  if (!resultText) return null;

  return { type: 'tool_result', text: resultText };
}

/**
 * Extract readable text from non-message Codex payloads.
 * @param {object} payload
 * @returns {string}
 */
function extractCodexReadableText(payload) {
  return '';
}

/**
 * Get a turn id from transcript metadata entries.
 * @param {object} entry
 * @returns {string|null}
 */
function getTurnId(entry) {
  if (entry.turn_id) return entry.turn_id;
  const payload = entry.payload || {};
  if (payload.turn_id) return payload.turn_id;
  if (payload.type === 'task_started' && payload.turn_id) return payload.turn_id;
  if (entry.type === 'turn_context' && payload.turn_id) return payload.turn_id;
  return null;
}

/**
 * Merge messages by turn when possible, otherwise merge consecutive same-role messages.
 * @param {Array} messages
 * @returns {Array}
 */
function normalizeMessages(messages) {
  const normalized = [];
  let index = 0;

  function trace(msg) {
    try {
      const fs = require('fs');
      const path = require('path');
      const lp = path.join(__dirname, '..', '..', '..', '..', 'temp', 'codex-norm-trace.log');
      fs.appendFileSync(lp, msg + '\n', 'utf8');
    } catch {}
  }
  trace('=== NORM START: ' + messages.length + ' msgs ===');
  trace('INPUT: ' + JSON.stringify(messages.map(m => ({r:m.role,t:!!m.turnId,p:Array.isArray(m.parts)?m.parts.length:0}))));

  while (index < messages.length) {
    const message = messages[index];
    if (!isValidMessage(message)) {
      index += 1;
      continue;
    }

    if (message.turnId) {
      const turnMessages = [];
      const turnId = message.turnId;

      while (index < messages.length && messages[index] && messages[index].turnId === turnId) {
        if (isValidMessage(messages[index])) {
          turnMessages.push(messages[index]);
        }
        index += 1;
      }

      const turnMerged = mergeTurnMessages(turnMessages);
      trace('TURN[' + turnId + ']: merge in=' + turnMessages.length + ' out=' + turnMerged.length + ' roles=' + JSON.stringify(turnMerged.map(m=>m.role)));
      normalized.push(...turnMerged);
      trace('NORMALIZED now: ' + JSON.stringify(normalized.map(m=>m.role)));
      continue;
    }

    appendOrMergeConsecutive(normalized, message);
    index += 1;
  }

  trace('=== NORM END: ' + JSON.stringify(normalized.map(m=>m.role)) + ' ===');
  return normalized;
}

/**
 * Check whether a message is usable for formatting.
 * @param {object} message
 * @returns {boolean}
 */
function isValidMessage(message) {
  return Boolean(message && message.role && Array.isArray(message.parts) && message.parts.length > 0);
}

/**
 * Merge messages within one turn so each role appears once per turn.
 * @param {Array} messages
 * @returns {Array}
 */
function mergeTurnMessages(messages) {
  const merged = [];
  const byRole = {};

  // DEBUG
  try {
    const fs = require('fs'); const path = require('path');
    const lp = path.join(__dirname, '..', '..', '..', '..', 'temp', 'codex-merge-debug.log');
    fs.appendFileSync(lp, 'MERGE IN: ' + JSON.stringify(messages.map(m => ({role:m.role,partsLen:m.parts?m.parts.length:0}))) + '\n', 'utf8');
  } catch {}

  for (const message of messages) {
    if (byRole[message.role]) {
      byRole[message.role].parts = mergeParts(byRole[message.role].parts, message.parts);
    } else {
      const copy = copyMessage(message);
      byRole[message.role] = copy;
      merged.push(copy);
    }
  }

  // DEBUG
  try {
    const fs = require('fs'); const path = require('path');
    const lp = path.join(__dirname, '..', '..', '..', '..', 'temp', 'codex-merge-debug.log');
    fs.appendFileSync(lp, 'MERGE OUT: ' + JSON.stringify(merged.map(m => ({role:m.role,partsLen:m.parts?m.parts.length:0}))) + '\n', 'utf8');
  } catch {}

  return merged;
}

/**
 * Append a message, merging with the previous message when roles match.
 * @param {Array} messages
 * @param {object} message
 */
function appendOrMergeConsecutive(messages, message) {
  const last = messages[messages.length - 1];
  if (last && shouldMergeMessages(last, message)) {
    last.parts = mergeParts(last.parts, message.parts);
  } else {
    messages.push(copyMessage(message));
  }
}

/**
 * Decide whether two messages should merge.
 * @param {object} prev
 * @param {object} next
 * @returns {boolean}
 */
function shouldMergeMessages(prev, next) {
  if (prev.role !== next.role) return false;
  if (prev.turnId && next.turnId) return prev.turnId === next.turnId;
  return true;
}

/**
 * Make a shallow copy of a message.
 * @param {object} message
 * @returns {object}
 */
function copyMessage(message) {
  return {
    role: message.role,
    timestamp: message.timestamp || null,
    parts: message.parts.slice(),
    turnId: message.turnId || null,
    source: message.source || null,
  };
}

/**
 * Append parts, separating adjacent text parts with a blank line.
 * @param {Array} prevParts
 * @param {Array} nextParts
 * @returns {Array}
 */
function mergeParts(prevParts, nextParts) {
  const parts = prevParts.slice();

  for (const part of nextParts) {
    if (part && part.type === 'text' && hasDuplicateTextPart(parts, part.text)) {
      continue;
    }

    const last = parts[parts.length - 1];
    if (last && last.type === 'text' && part.type === 'text') {
      last.text = `${last.text}\n\n${part.text}`;
    } else {
      parts.push(part);
    }
  }

  return parts;
}

/**
 * Whether parts already include the same normalized text.
 * @param {Array} parts
 * @param {string} text
 * @returns {boolean}
 */
function hasDuplicateTextPart(parts, text) {
  const target = normalizeTextForCompare(text);
  if (!target) return false;
  return parts.some((part) => {
    if (!part || part.type !== 'text') return false;

    if (normalizeTextForCompare(part.text) === target) {
      return true;
    }

    const chunks = splitTextIntoCompareChunks(part.text);
    return chunks.includes(target);
  });
}

/**
 * Normalize text for duplicate comparison.
 * @param {string} text
 * @returns {string}
 */
function normalizeTextForCompare(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

/**
 * 将文本按空行或换行拆为可比较片段。
 * @param {string} text
 * @returns {Array<string>}
 */
function splitTextIntoCompareChunks(text) {
  return String(text || '')
    .split(/\r?\n\s*\r?\n|\r?\n/g)
    .map(chunk => normalizeTextForCompare(chunk))
    .filter(Boolean);
}

/**
 * Summarize tool input for display (truncate large inputs).
 * @param {*} input
 * @returns {string}
 */
function summarizeToolInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return truncate(input, 500);

  try {
    const str = JSON.stringify(input, null, 2);
    return truncate(str, 500);
  } catch {
    return '[complex input]';
  }
}

/**
 * Extract readable text from a tool_result block.
 * @param {object} block
 * @returns {string}
 */
function extractToolResultText(block) {
  if (!block.content) return '';

  if (typeof block.content === 'string') return truncate(block.content, 300);

  if (Array.isArray(block.content)) {
    const texts = block.content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text);
    return truncate(texts.join('\n'), 300);
  }

  return '';
}

/**
 * Extract text from strings, text blocks, arrays, or simple objects.
 * @param {*} value
 * @param {number} max
 * @returns {string}
 */
function extractAnyText(value, max) {
  if (!value) return '';
  if (typeof value === 'string') return truncate(value, max);

  if (Array.isArray(value)) {
    const texts = value
      .map(item => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        if (item.text) return item.text;
        if (item.output) return item.output;
        if (item.content) return extractAnyText(item.content, max);
        return '';
      })
      .filter(Boolean);
    return truncate(texts.join('\n'), max);
  }

  if (typeof value === 'object') {
    if (value.text) return truncate(String(value.text), max);
    if (value.output) return truncate(String(value.output), max);
    if (value.content) return extractAnyText(value.content, max);
  }

  return truncate(String(value), max);
}

/**
 * Log skipped entries when debug is enabled.
 * @param {string|null} entryType
 * @param {string|null} payloadType
 * @param {string|null} payloadRole
 * @param {string} reason
 * @param {object} [entry]
 */

/**
 * Print a structured summary of a single transcript entry for debug.
 * Only called when CODEX_TO_SIYUAN_DEBUG=1 and needle matches.
 * @param {object} entry
 * @param {string} label - Reason label
 */
function debugEntryStructure(entry, label) {
  if (process.env.CODEX_TO_SIYUAN_DEBUG !== '1') return;
  const payload = entry && entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const item = entry && entry.item && typeof entry.item === 'object' ? entry.item : {};
  const msg = entry && entry.message && typeof entry.message === 'object' ? entry.message : {};

  process.stderr.write(
    `[codex-to-siyuan] STRUCT ${label}:` +
    ` entry.type=${JSON.stringify(entry.type)}` +
    ` payload.type=${JSON.stringify(payload.type)}` +
    ` payload.role=${JSON.stringify(payload.role)}` +
    ` item.type=${JSON.stringify(item.type)}` +
    ` entry.keys=[${Object.keys(entry || {}).slice(0, 15).join(',')}]` +
    ` payload.keys=[${Object.keys(payload).slice(0, 10).join(',')}]` +
    ` item.keys=[${Object.keys(item).slice(0, 10).join(',')}]` +
    ` msg.keys=[${Object.keys(msg).slice(0, 10).join(',')}]` +
    `\n`
  );

  const needle = getDebugNeedle();
  if (!needle) return;

  // Scan common nested paths for the needle
  const scanPaths = [
    ['entry.message', entry.message],
    ['entry.message.content', entry.message && entry.message.content],
    ['entry.content', entry.content],
    ['entry.text', entry.text],
    ['entry.input', entry.input],
    ['payload.message', payload.message],
    ['payload.message.content', payload.message && payload.message.content],
    ['payload.content', payload.content],
    ['payload.text', payload.text],
    ['payload.input', payload.input],
    ['payload.items', payload.items],
    ['payload.item', payload.item],
    ['item.content', item.content],
    ['item.text', item.text],
    ['item.input', item.input],
  ];

  for (const [path, value] of scanPaths) {
    if (value === undefined || value === null) continue;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (str.includes(needle)) {
      const preview = str.length > 120 ? str.slice(0, 120) + '...' : str;
      process.stderr.write(
        `[codex-to-siyuan] STRUCT HIT: path=${path}, preview=${JSON.stringify(preview)}\n`
      );
    }
  }
}

function debugSkip(entryType, payloadType, payloadRole, reason, entry) {
  if (process.env.CODEX_TO_SIYUAN_DEBUG !== '1') return;
  const payload = entry && entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const item = entry && entry.item && typeof entry.item === 'object' ? entry.item : {};
  const needle = getDebugNeedle();
  const matches = needle ? findTextMatches(entry, needle) : [];
  const suspicious = needle ? [] : findSuspiciousTextFields(entry);
  if (needle && matches.length > 0) {
    debugEntryStructure(entry, reason);
  }
  process.stderr.write(
    `[codex-to-siyuan] skipped transcript entry: entry.type=${entryType || ''}, payload.type=${payloadType || ''}, payload.role=${payloadRole || ''}, entry.keys=${listKeys(entry)}, payload.keys=${listKeys(payload)}, item.keys=${listKeys(item)}, needle=${needle || ''}, matches=${matches.join('|')}, suspicious=${suspicious.join('|')}, reason=${reason}\n`
  );
}

/**
 * Log parsed messages in debug mode.
 * @param {object|null} entry
 * @param {string} role
 * @param {string|null} turnId
 * @param {Array} parts
 * @param {string} source
 */
function debugParsedMessage(entry, role, turnId, parts, source) {
  if (process.env.CODEX_TO_SIYUAN_DEBUG !== '1') return;
  const payload = entry && entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  const item = entry && entry.item && typeof entry.item === 'object' ? entry.item : {};
  const text = parts
    .filter((part) => part && part.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n')
    .slice(0, 80);
  process.stderr.write(
    `[codex-to-siyuan] parsed transcript entry: entry.type=${entry?.type || ''}, payload.type=${payload.type || ''}, payload.role=${payload.role || ''}, item.type=${item.type || ''}, role=${role || ''}, turnId=${turnId || ''}, source=${source || ''}, text=${JSON.stringify(text)}\n`
  );
}

/**
 * Get optional debug needle.
 * @returns {string}
 */
function getDebugNeedle() {
  return String(process.env.CODEX_TO_SIYUAN_DEBUG_NEEDLE || '').trim();
}

/**
 * Find string fields containing a needle for debug output.
 * @param {*} value
 * @param {string} needle
 * @param {string} [path]
 * @param {number} [depth]
 * @returns {Array<string>}
 */
function findTextMatches(value, needle, path = 'entry', depth = 0) {
  if (!value || depth > 5) return [];
  if (typeof value === 'string') {
    return value.includes(needle) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findTextMatches(item, needle, `${path}[${index}]`, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.keys(value).flatMap((key) => findTextMatches(value[key], needle, `${path}.${key}`, depth + 1));
  }
  return [];
}

/**
 * Find suspicious text-bearing fields for skipped-entry debug output.
 * @param {*} value
 * @param {string} [path]
 * @param {number} [depth]
 * @returns {Array<string>}
 */
function findSuspiciousTextFields(value, path = 'entry', depth = 0) {
  if (!value || depth > 5) return [];

  if (typeof value === 'string') {
    const leaf = path.split('.').pop() || '';
    if (/^(text|content|input|message|prompt)$/i.test(leaf)) {
      return [`${path}=${JSON.stringify(value.slice(0, 80))}`];
    }
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSuspiciousTextFields(item, `${path}[${index}]`, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.keys(value).flatMap((key) => findSuspiciousTextFields(value[key], `${path}.${key}`, depth + 1));
  }

  return [];
}

/**
 * List object keys for debug output.
 * @param {*} value
 * @returns {string}
 */
function listKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.keys(value).slice(0, 20).join('|');
}

/**
 * Truncate a string to a max length, appending "…" if truncated.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}

module.exports = {
  cleanMessageText,
  stripLeadingAgentsInstructionHeader,
  stripCodexInjectedInstructions,
  dedupeConsecutiveDuplicateLines,
  collapseRepeatedOnlyText,
  parseTranscript,
  parseEntry,
  parseMessage,
  parseCodexEntry,
  normalizeMessages,
  truncate,
};
