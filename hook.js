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
const { formatMessages, generateDocHeader, formatDate } = require('./src/formatter');
const SiYuanAPI = require('./src/siyuan-api');
const { loadState, saveState, cleanupStaleStates } = require('./src/state');

// ── Symlink-safe path resolution ──────────────────────────────────
const SCRIPT_DIR = path.dirname(process.argv[1] || __filename);

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

  // mode === 'classic': user messages + final assistant output
  const userMessages = normalizedMessages
    .filter(msg => msg && msg.role === 'user' && Array.isArray(msg.parts))
    .map(msg => ({
      ...msg,
      parts: msg.parts.filter(p => p && p.type === 'text' && p.text && String(p.text).trim()),
    }))
    .filter(msg => msg.parts.length > 0);

  return finalAssistant ? [...userMessages, finalAssistant] : userMessages;
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
  const port = config.siyuanPort || '6806';
  const siyuanUrl = config.siyuanUrl || `http://127.0.0.1:${port}`;
  const token = config.siyuanToken || getSiYuanToken();

  // 3. Cleanup stale state files (best-effort)
  cleanupStaleStates();

  // 4. Load or initialize session state
  let state = loadState(sessionId);
  const isFirstRun = !state;

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

  const syncMode = config.syncMode || 'classic';
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
    const projectName = path.basename(cwd);
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
    const dailyPath = api.getDailyPath(parentPath, today);
    const docPath = `${dailyPath}/${title}`;

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

module.exports = { buildFallbackAssistantMessage, buildFinalAssistantMessage, filterMessagesBySyncMode };
