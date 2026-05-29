/**
 * Per-session state tracker.
 * Stores state in OS temp directory so incremental appends work across Stop hook invocations.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_PREFIX = 'codex-siyuan-';
const STALE_HOURS = 24;

/**
 * Get the state file path for a given session.
 * @param {string} sessionId
 * @returns {string}
 */
function getStatePath(sessionId) {
  return path.join(os.tmpdir(), `${STATE_PREFIX}${sessionId}.json`);
}

/**
 * Load session state from disk. Returns null if no state exists.
 * @param {string} sessionId
 * @returns {object|null} {sessionId, docId, lastByteOffset, createdAt}
 */
function loadState(sessionId) {
  const filePath = getStatePath(sessionId);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save session state to disk.
 * @param {string} sessionId
 * @param {object} state - {sessionId, docId, lastByteOffset, createdAt}
 */
function saveState(sessionId, state) {
  const filePath = getStatePath(sessionId);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Clean up stale state files older than STALE_HOURS.
 * Runs silently — errors are ignored.
 */
function cleanupStaleStates() {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    const cutoff = Date.now() - STALE_HOURS * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith(STATE_PREFIX) || !file.endsWith('.json')) continue;

      const fullPath = path.join(tmpDir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
        }
      } catch {
        // Ignore per-file errors
      }
    }
  } catch {
    // Ignore cleanup errors entirely
  }
}

module.exports = { loadState, saveState, cleanupStaleStates, getStatePath };
