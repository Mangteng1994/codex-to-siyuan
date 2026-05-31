/**
 * JSONL session transcript parser.
 * Extracts user & assistant messages from a session transcript file.
 */

const fs = require('fs');

/**
 * 清理消息文本中的环境上下文块。
 * @param {string} text
 * @returns {string}
 */
function cleanMessageText(text) {
  return String(text || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>\s*/g, '')
    .trim();
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

  const codexMessage = parseCodexEntry(entry, turnId);
  if (codexMessage) {
    return codexMessage;
  }

  debugSkip(entry.type, entry.payload && entry.payload.type, entry.payload && entry.payload.name, 'unhandled entry');
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

  // Handle different message content formats
  const message = entry.message || {};
  const rawContent = message.content;

  if (!rawContent) return null;

  const parts = [];

  if (typeof rawContent === 'string') {
    const text = cleanMessageText(rawContent);
    if (text) parts.push({ type: 'text', text });
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (block.type === 'text' && block.text) {
        const text = cleanMessageText(block.text);
        if (text) parts.push({ type: 'text', text });
      } else if (block.type === 'tool_use') {
        parts.push({
          type: 'tool_use',
          name: block.name || 'unknown',
          input: summarizeToolInput(block.input),
        });
      } else if (block.type === 'tool_result') {
        // Include tool results with a brief summary
        const resultText = extractToolResultText(block);
        if (resultText) {
          parts.push({ type: 'tool_result', text: resultText });
        }
      }
    }
  }

  if (parts.length === 0) return null;

  return { role, timestamp, parts, turnId: entry.turn_id || turnId || null };
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
    return parseCodexMessage(payload.role, timestamp, payload.content, resolvedTurnId);
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
    return {
      role: payload.role === 'user' ? 'user' : 'assistant',
      timestamp,
      parts: [{ type: 'text', text }],
      turnId: resolvedTurnId,
    };
  }

  debugSkip(entry.type, payload.type, payload.name, 'unhandled codex payload');
  return null;
}

/**
 * Parse Codex message content blocks.
 * @param {string} role - user or assistant
 * @param {string|null} timestamp
 * @param {string|Array} rawContent
 * @param {string|null} [turnId] - Current turn ID
 * @returns {object|null} Structured message or null
 */
function parseCodexMessage(role, timestamp, rawContent, turnId = null) {
  if (!rawContent) return null;

  const parts = [];

  if (typeof rawContent === 'string') {
    const text = cleanMessageText(rawContent);
    if (text) parts.push({ type: 'text', text });
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      const text = block.text || '';
      if ((block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') && text) {
        const sanitized = cleanMessageText(text);
        if (sanitized) parts.push({ type: 'text', text: sanitized });
      }
    }
  }

  if (parts.length === 0) return null;

  return { role, timestamp, parts, turnId };
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
  if (payload.type === 'reasoning' || payload.type === 'message_delta') {
    const text = extractAnyText(payload.text || payload.content || payload.summary, 500);
    return cleanMessageText(text);
  }

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

      normalized.push(...mergeTurnMessages(turnMessages));
      continue;
    }

    appendOrMergeConsecutive(normalized, message);
    index += 1;
  }

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

  for (const message of messages) {
    if (byRole[message.role]) {
      byRole[message.role].parts = mergeParts(byRole[message.role].parts, message.parts);
    } else {
      const copy = copyMessage(message);
      byRole[message.role] = copy;
      merged.push(copy);
    }
  }

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
 * @param {string|null} payloadName
 * @param {string} reason
 */
function debugSkip(entryType, payloadType, payloadName, reason) {
  if (process.env.CODEX_TO_SIYUAN_DEBUG !== '1') return;
  process.stderr.write(
    `[codex-to-siyuan] skipped transcript entry: entry.type=${entryType || ''}, payload.type=${payloadType || ''}, payload.name=${payloadName || ''}, reason=${reason}\n`
  );
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
  parseTranscript,
  parseEntry,
  parseMessage,
  parseCodexEntry,
  normalizeMessages,
  truncate,
};
