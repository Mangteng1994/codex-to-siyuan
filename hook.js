/**
 * Codex Stop hook — main entry point.
 * Reads hook data from stdin (Codex hook JSON), parses the transcript
 * incrementally, then saves new messages to SiYuan notes.
 *
 * Config is read from the plugin directory (hook-config.json) or
 * from ~/.codex-to-siyuan/config.json as fallback.
 *
 * Always exits 0. All errors go to stderr only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parseTranscript, normalizeMessages } = require('./src/parser');
const {
  formatMessages,
  generateDocHeader,
  formatDate,
  renderTemplate,
  sanitizePathSegment,
} = require('./src/formatter');
const SiYuanAPI = require('./src/siyuan-api');
const { loadState, saveState, cleanupStaleStates } = require('./src/state');

// ── Symlink-safe path resolution ──────────────────────────────────
const SCRIPT_PATH = fs.realpathSync(process.argv[1] || __filename);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);

// ── Stdin reading with 10s timeout guard ──────────────────────────
const STDIN_TIMEOUT_MS = 10000;

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => {
      process.stdin.destroy();
      reject(new Error('stdin timeout'));
    }, STDIN_TIMEOUT_MS);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => input += chunk);
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(input);
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Config loading ────────────────────────────────────────────────

function loadConfig() {
  // Priority 1: Environment variable
  const envPath = process.env.CODEX_TO_SIYUAN_CONFIG;
  if (envPath && fs.existsSync(envPath)) {
    return JSON.parse(fs.readFileSync(envPath, 'utf8'));
  }

  // Priority 2: Petal directory hook-config.json (written by SiYuan plugin saveData())
  const pluginDir = SCRIPT_DIR;
  const pluginsDir = path.dirname(pluginDir);
  const dataDir = path.dirname(pluginsDir);
  const petalConfig = path.join(dataDir, 'storage', 'petal', 'codex-to-siyuan', 'hook-config.json');
  if (fs.existsSync(petalConfig)) {
    return JSON.parse(fs.readFileSync(petalConfig, 'utf8'));
  }

  // Priority 3: Plugin directory hook-config.json (legacy / manual placement)
  const pluginConfig = path.join(SCRIPT_DIR, 'hook-config.json');
  if (fs.existsSync(pluginConfig)) {
    return JSON.parse(fs.readFileSync(pluginConfig, 'utf8'));
  }

  // Priority 4: Legacy standalone config location
  const legacyConfig = path.join(os.homedir(), '.codex-to-siyuan', 'config.json');
  if (fs.existsSync(legacyConfig)) {
    return JSON.parse(fs.readFileSync(legacyConfig, 'utf8'));
  }

  throw new Error('Config not found. Please configure the plugin in SiYuan settings.');
}

// ── Default templates ─────────────────────────────────────────────
const DEFAULT_TEMPLATE = '## ${role} (${time})\n\n${content}\n\n---\n';
const DEFAULT_HEADER_TEMPLATE =
  '# ${projectName}\n\n- 项目: ${projectName}\n- 开始时间: ${date} ${time}\n- Session ID: ${sessionId}\n\n---\n';
const DEFAULT_PATH_TEMPLATE = '${parentPath}/${date}/${title}';

// ── SiYuan API token loading ──────────────────────────────────────

function getSiYuanToken() {
  if (process.env.SIYUAN_TOKEN) {
    return process.env.SIYUAN_TOKEN;
  }

  const possibleConfs = [];

  if (process.env.SIYUAN_WORKSPACE) {
    possibleConfs.push(path.join(process.env.SIYUAN_WORKSPACE, 'conf', 'conf.json'));
  }

  const pluginDir = SCRIPT_DIR;
  const pluginsDir = path.dirname(pluginDir);
  const dataDir = path.dirname(pluginsDir);
  const workspaceDir = path.dirname(dataDir);
  possibleConfs.push(path.join(workspaceDir, 'conf', 'conf.json'));

  for (const confPath of possibleConfs) {
    try {
      if (fs.existsSync(confPath)) {
        const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
        if (conf.api && conf.api.token) {
          return conf.api.token;
        }
      }
    } catch { /* ignore */ }
  }

  // Legacy config fallback
  const legacyConfig = path.join(os.homedir(), '.codex-to-siyuan', 'config.json');
  if (fs.existsSync(legacyConfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(legacyConfig, 'utf8'));
      if (cfg.siyuanToken) return cfg.siyuanToken;
    } catch { /* ignore */ }
  }

  return '';
}

/**
 * Write debug log only when enabled.
 * @param {string} message
 */
function debugLog(message) {
  if (process.env.CODEX_TO_SIYUAN_DEBUG !== '1') return;
  process.stderr.write(`[codex-to-siyuan] ${message}\n`);
}

/**
 * Normalize a path or string for pattern matching.
 * @param {string} value
 * @returns {string}
 */
function normalizeMatchValue(value) {
  return String(value || '').replace(/\\/g, '/');
}

/**
 * Parse multi-line pattern settings into rule array.
 * @param {string|Array|null|undefined} value
 * @returns {Array<string>}
 */
function parsePatternLines(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item || '').trim())
      .filter(Boolean);
  }

  return String(value || '')
    .split(/\r?\n/g)
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * Convert wildcard pattern to RegExp.
 * @param {string} pattern
 * @returns {RegExp}
 */
function wildcardToRegExp(pattern) {
  const escaped = String(pattern || '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Check whether a value matches any configured pattern.
 * Plain patterns use substring match; patterns with * use wildcard match.
 * @param {string} value
 * @param {Array<string>} patterns
 * @returns {boolean}
 */
function matchesAnyPattern(value, patterns) {
  const target = normalizeMatchValue(value);
  if (!target || !Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }

  for (const pattern of patterns) {
    const rule = String(pattern || '').trim();
    if (!rule) continue;

    try {
      if (rule.includes('*')) {
        if (wildcardToRegExp(normalizeMatchValue(rule)).test(target)) {
          return true;
        }
      } else if (target.includes(normalizeMatchValue(rule))) {
        return true;
      }
    } catch (_) {
      debugLog(`invalid pattern skipped: ${rule}`);
    }
  }

  return false;
}

/**
 * Determine whether current project should sync.
 * @param {string} cwd
 * @param {object} config
 * @returns {boolean}
 */
function shouldSyncProject(cwd, config) {
  const normalizedCwd = normalizeMatchValue(cwd);
  const includePatterns = parsePatternLines(config && config.includeProjectPatterns);
  const excludePatterns = parsePatternLines(config && config.excludeProjectPatterns);

  if (matchesAnyPattern(normalizedCwd, excludePatterns)) {
    debugLog(`skip sync for project by excludeProjectPatterns: ${normalizedCwd}`);
    return false;
  }

  if (includePatterns.length === 0) {
    return true;
  }

  const matched = matchesAnyPattern(normalizedCwd, includePatterns);
  if (!matched) {
    debugLog(`skip sync for project not matched by includeProjectPatterns: ${normalizedCwd}`);
  }
  return matched;
}

/**
 * Filter message parts by excludeContentPatterns.
 * @param {Array} messages
 * @param {object} config
 * @returns {Array}
 */
function filterMessages(messages, config) {
  const patterns = parsePatternLines(config && config.excludeContentPatterns);
  if (patterns.length === 0) {
    return messages;
  }

  return messages
    .map((message) => {
      const parts = Array.isArray(message.parts) ? message.parts.filter((part) => {
        const text = part && part.text ? String(part.text) : '';
        const input = part && part.input ? String(part.input) : '';
        return !matchesAnyPattern(text, patterns) && !matchesAnyPattern(input, patterns);
      }) : [];

      return { ...message, parts };
    })
    .filter(message => Array.isArray(message.parts) && message.parts.length > 0);
}

/**
 * Render document path template.
 * @param {string} template
 * @param {object} data
 * @returns {string}
 */
function renderPathTemplate(template, data) {
  const rendered = renderTemplate(template || DEFAULT_PATH_TEMPLATE, data);
  const normalized = String(rendered || '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/g, '');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

// ── Main logic ────────────────────────────────────────────────────

/**
 * Build a fallback assistant message from Codex Stop hook input.
 * @param {string} lastAssistantMessage
 * @returns {object|null}
 */
function buildFallbackAssistantMessage(lastAssistantMessage) {
  if (!lastAssistantMessage) return null;
  return {
    role: 'assistant',
    timestamp: new Date().toISOString(),
    parts: [{ type: 'text', text: lastAssistantMessage }],
  };
}

/**
 * Hash content for fallback deduplication.
 * @param {string} content
 * @returns {string|null}
 */
function hashContent(content) {
  if (!content) return null;
  return crypto.createHash('md5').update(content, 'utf8').digest('hex');
}

/**
 * Build a final assistant message from last_assistant_message or the last
 * assistant text message in normalized messages (fallback).
 * @param {string|null} lastAssistantMessage - Codex hook last_assistant_message
 * @param {Array} normalizedMessages - Already normalized message array
 * @returns {object|null} A single assistant message, or null
 */
function buildFinalAssistantMessage(lastAssistantMessage, normalizedMessages) {
  if (lastAssistantMessage && String(lastAssistantMessage).trim()) {
    return {
      role: 'assistant',
      timestamp: new Date().toISOString(),
      parts: [{ type: 'text', text: String(lastAssistantMessage).trim() }],
    };
  }

  for (let i = normalizedMessages.length - 1; i >= 0; i -= 1) {
    const msg = normalizedMessages[i];
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.parts)) continue;

    const textParts = msg.parts
      .filter(p => p && p.type === 'text' && p.text && String(p.text).trim())
      .map(p => String(p.text).trim());

    if (textParts.length > 0) {
      return {
        role: 'assistant',
        timestamp: msg.timestamp || new Date().toISOString(),
        parts: [{ type: 'text', text: textParts[textParts.length - 1] }],
        turnId: msg.turnId || null,
      };
    }
  }

  return null;
}

/**
 * Whether the session should still be treated as first run.
 * A saved state without docId has not created the SiYuan document yet.
 * @param {object|null} state
 * @returns {boolean}
 */
function isSessionFirstRun(state) {
  return !state || !state.docId;
}

/**
 * Keep only non-empty text parts in a message.
 * @param {object} msg
 * @returns {object|null}
 */
function toTextOnlyMessage(msg) {
  if (!msg || !Array.isArray(msg.parts)) return null;
  const parts = msg.parts.filter((part) => part && part.type === 'text' && String(part.text || '').trim());
  if (parts.length === 0) return null;
  return { ...msg, parts };
}

/**
 * Keep only the last assistant text part in a message.
 * @param {object} msg
 * @returns {object|null}
 */
function toLastAssistantTextMessage(msg) {
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.parts)) return null;
  for (let i = msg.parts.length - 1; i >= 0; i -= 1) {
    const part = msg.parts[i];
    if (part && part.type === 'text' && String(part.text || '').trim()) {
      return {
        role: 'assistant',
        timestamp: msg.timestamp || null,
        parts: [{ type: 'text', text: String(part.text).trim() }],
        turnId: msg.turnId || null,
      };
    }
  }
  return null;
}

/**
 * Build classic-mode turn-like segments from normalized messages.
 * With turnId: segment by contiguous turnId.
 * Without turnId: start a new segment when a new user message appears.
 * @param {Array} normalizedMessages
 * @returns {Array<Array>}
 */
function segmentMessagesForClassicMode(normalizedMessages) {
  const segments = [];
  let current = [];
  let currentTurnId = null;

  for (const msg of normalizedMessages || []) {
    if (!msg || !msg.role || !Array.isArray(msg.parts)) continue;

    if (msg.turnId) {
      if (current.length > 0 && currentTurnId !== msg.turnId) {
        segments.push(current);
        current = [];
      }
      currentTurnId = msg.turnId;
      current.push(msg);
      continue;
    }

    if (currentTurnId) {
      segments.push(current);
      current = [];
      currentTurnId = null;
    }

    if (msg.role === 'user' && current.length > 0) {
      segments.push(current);
      current = [];
    }

    current.push(msg);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

/**
 * Classic mode: keep user text and the last assistant text for each turn-like segment.
 * @param {Array} normalizedMessages
 * @returns {Array}
 */
function buildClassicModeMessages(normalizedMessages) {
  const result = [];
  const segments = segmentMessagesForClassicMode(normalizedMessages);

  for (const segment of segments) {
    const userMessages = segment
      .filter((msg) => msg && msg.role === 'user')
      .map(toTextOnlyMessage)
      .filter(Boolean);

    const assistantMessages = segment
      .filter((msg) => msg && msg.role === 'assistant')
      .map(toLastAssistantTextMessage)
      .filter(Boolean);

    result.push(...userMessages);

    const lastAssistant = assistantMessages[assistantMessages.length - 1] || null;
    if (lastAssistant) {
      result.push(lastAssistant);
    }
  }

  return result;
}

/**
 * Filter normalized messages based on sync content mode.
 * @param {Array} normalizedMessages
 * @param {string} syncMode - 'classic' | 'minimal' | 'full'
 * @param {string|null} lastAssistantMessage
 * @returns {Array} Filtered messages for formatting
 */
function filterMessagesBySyncMode(normalizedMessages, syncMode, lastAssistantMessage) {
  const mode = ['classic', 'minimal', 'full'].includes(syncMode) ? syncMode : 'classic';

  if (mode === 'full') {
    return normalizedMessages;
  }

  const finalAssistant = buildFinalAssistantMessage(lastAssistantMessage, normalizedMessages);

  if (mode === 'minimal') {
    return finalAssistant ? [finalAssistant] : [];
  }

  return buildClassicModeMessages(normalizedMessages);
}

/**
 * Decide whether first-run fallback write should be deferred.
 * Classic/full mode should not create an assistant-only first record when the
 * transcript has not exposed the user message yet.
 * @param {object} opts
 * @param {boolean} opts.isFirstRun
 * @param {string} opts.syncMode
 * @param {Array} opts.normalizedMessages
 * @returns {boolean}
 */
function shouldDeferFirstFallbackWrite({ isFirstRun, syncMode, normalizedMessages }) {
  if (!isFirstRun) return false;

  const mode = ['classic', 'minimal', 'full'].includes(syncMode) ? syncMode : 'classic';
  if (mode === 'minimal') return false;

  const hasUserText = Array.isArray(normalizedMessages) && normalizedMessages.some((msg) =>
    msg
    && msg.role === 'user'
    && Array.isArray(msg.parts)
    && msg.parts.some((part) => part && part.type === 'text' && String(part.text || '').trim())
  );

  return !hasUserText;
}

/**
 * Keep transcript offset unchanged when first-run fallback write is deferred.
 * Otherwise the first turn will be skipped on next incremental parse.
 * @param {object} state
 * @param {number} previousByteOffset
 * @returns {object}
 */
function preserveStateForDeferredFirstWrite(state, previousByteOffset) {
  return {
    ...state,
    lastByteOffset: Number.isFinite(previousByteOffset) ? previousByteOffset : 0,
  };
}

async function main() {
  // 1. Read Codex hook input from stdin
  const raw = await readStdin();
  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[codex-to-siyuan] Failed to parse stdin JSON: ${e.message}\n`);
    return;
  }

  const sessionId = hookInput.session_id;
  const transcriptPath = hookInput.transcript_path || null;
  const lastAssistantMessage = hookInput.last_assistant_message || null;
  const cwd = hookInput.cwd || process.cwd();

  if (!sessionId || (!transcriptPath && !lastAssistantMessage)) {
    process.stderr.write('[codex-to-siyuan] Missing session_id or transcript_path in hook input\n');
    return;
  }

  // 2. Load config
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`[codex-to-siyuan] ${e.message}\n`);
    return;
  }

  if (!config.notebook) {
    process.stderr.write('[codex-to-siyuan] notebook must be set in config. Please configure in SiYuan plugin settings.\n');
    return;
  }

  const template = config.template || DEFAULT_TEMPLATE;
  const headerTemplate = config.headerTemplate || DEFAULT_HEADER_TEMPLATE;
  const parentPath = config.parentPath || '/Codex Sessions';
  const pathTemplate = config.pathTemplate || DEFAULT_PATH_TEMPLATE;
  const syncMode = config.syncMode || 'classic';
  const port = config.siyuanPort || '6806';
  const siyuanUrl = config.siyuanUrl || `http://127.0.0.1:${port}`;
  const token = config.siyuanToken || getSiYuanToken();

  if (!shouldSyncProject(cwd, config)) {
    return;
  }

  // 3. Cleanup stale state files (best-effort)
  cleanupStaleStates();

  // 4. Load or initialize session state
  let state = loadState(sessionId);
  const isFirstRun = isSessionFirstRun(state);

  if (isFirstRun) {
    state = {
      sessionId,
      docId: null,
      lastByteOffset: 0,
      createdAt: new Date().toISOString(),
    };
  }

  // 5. Parse transcript from last offset
  let messages = [];
  const previousByteOffset = state.lastByteOffset;
  let newByteOffset = state.lastByteOffset;

  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const result = parseTranscript(transcriptPath, state.lastByteOffset);
    messages = result.messages;
    newByteOffset = result.newByteOffset;
  }

  if (messages.length === 0) {
    const fallbackMessage = buildFallbackAssistantMessage(lastAssistantMessage);
    state.lastByteOffset = newByteOffset;

    if (!fallbackMessage) {
      // Nothing new — update offset and exit
      saveState(sessionId, state);
      return;
    }

    const fallbackHash = hashContent(lastAssistantMessage);
    if (fallbackHash && state.lastFallbackHash === fallbackHash) {
      saveState(sessionId, state);
      return;
    }

    state.lastFallbackHash = fallbackHash;
    messages = [fallbackMessage];
  } else {
    state.lastByteOffset = newByteOffset;
  }

  messages = normalizeMessages(messages);
  messages = filterMessages(messages, config);
  if (shouldDeferFirstFallbackWrite({ isFirstRun, syncMode, normalizedMessages: messages })) {
    state = preserveStateForDeferredFirstWrite(state, previousByteOffset);
    saveState(sessionId, state);
    return;
  }
  messages = filterMessagesBySyncMode(messages, syncMode, lastAssistantMessage);

  if (messages.length === 0) {
    saveState(sessionId, state);
    return;
  }

  // 6. Format messages
  const markdown = formatMessages(messages, template);

  // 7. Create or append to SiYuan doc
  const api = new SiYuanAPI(siyuanUrl, token);

  if (!state.docId) {
    // First run — create a new document
    const normalizedCwd = normalizeMatchValue(cwd).replace(/\/+$/g, '');
    const projectName = sanitizePathSegment(path.posix.basename(normalizedCwd) || path.basename(cwd), 60);
    const firstUserMsg = messages.find(m => m.role === 'user');
    const firstText = firstUserMsg
      ? firstUserMsg.parts.find(p => p.type === 'text')?.text || ''
      : '';

    const { title, header } = generateDocHeader({
      projectName,
      sessionId,
      headerTemplate,
      firstUserMessage: firstText,
    });

    const today = formatDate(new Date());
    const docPath = renderPathTemplate(pathTemplate, {
      parentPath: String(parentPath || '/Codex Sessions').replace(/\\/g, '/').replace(/\/+$/g, ''),
      date: today,
      projectName,
      title,
      sessionId,
    });

    const fullMarkdown = header + '\n' + markdown;
    const docId = await api.createDocWithMd(config.notebook, docPath, fullMarkdown);

    state.docId = docId;
  } else {
    // Subsequent run — append to existing doc
    await api.appendBlock(state.docId, markdown);
  }

  // 8. Save session state
  saveState(sessionId, state);
}

// ── Entry point — never throw, never block Codex ──────────────────
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[codex-to-siyuan] ${err.message}\n`);
  }).finally(() => {
    process.exit(0);
  });
}

module.exports = {
  buildFallbackAssistantMessage,
  buildFinalAssistantMessage,
  buildClassicModeMessages,
  filterMessagesBySyncMode,
  isSessionFirstRun,
  shouldDeferFirstFallbackWrite,
  preserveStateForDeferredFirstWrite,
  segmentMessagesForClassicMode,
  parsePatternLines,
  wildcardToRegExp,
  matchesAnyPattern,
  shouldSyncProject,
  filterMessages,
  renderPathTemplate,
};
