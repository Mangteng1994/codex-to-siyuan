/**
 * SiYuan REST API client
 * Uses only Node.js built-in http module — zero external dependencies.
 */

const http = require('http');
const https = require('https');

class SiYuanAPI {
  /**
   * @param {string} baseUrl - e.g. "http://127.0.0.1:6806"
   * @param {string} token  - SiYuan API token
   */
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  /**
   * Low-level POST helper.
   * @param {string} endpoint - e.g. "/api/filetree/createDocWithMd"
   * @param {object} body
   * @returns {Promise<object>} parsed response JSON
   */
  _post(endpoint, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.baseUrl);
      const payload = JSON.stringify(body);
      const mod = url.protocol === 'https:' ? https : http;

      const req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Token ${this.token}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code !== 0) {
              reject(new Error(`SiYuan API error [${endpoint}]: code=${json.code}, msg=${json.msg}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`Failed to parse SiYuan response [${endpoint}]: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => {
        req.destroy(new Error(`Request timeout [${endpoint}]`));
      });
      req.write(payload);
      req.end();
    });
  }

  /**
   * Create a new document with Markdown content.
   * @param {string} notebook - Notebook ID
   * @param {string} path     - Document path, e.g. "/Codex Sessions/2026-03-21/my-doc"
   * @param {string} markdown - Markdown content
   * @returns {Promise<string>} Created document ID
   */
  async createDocWithMd(notebook, path, markdown) {
    const res = await this._post('/api/filetree/createDocWithMd', {
      notebook,
      path,
      markdown,
    });
    return res.data; // document ID string
  }

  /**
   * Append a Markdown block to an existing document.
   * @param {string} parentID - Document (block) ID to append to
   * @param {string} markdown - Markdown content to append
   * @returns {Promise<object>} API response data
   */
  async appendBlock(parentID, markdown) {
    const res = await this._post('/api/block/appendBlock', {
      dataType: 'markdown',
      data: markdown,
      parentID,
    });
    return res.data;
  }

  /**
   * Search documents by keyword.
   * @param {string} keyword
   * @returns {Promise<Array>} Array of matching documents
   */
  async searchDocs(keyword) {
    const res = await this._post('/api/filetree/searchDocs', {
      k: keyword,
    });
    return res.data || [];
  }

  /**
   * Ensure the daily folder path exists by creating a placeholder doc,
   * then return the path prefix.
   *
   * SiYuan auto-creates parent "folders" when a doc is created at a nested path,
   * so we just need to return the correctly formatted path.
   *
   * @param {string} parentPath - e.g. "/Codex Sessions"
   * @param {string} date       - e.g. "2026-03-21"
   * @returns {string} Full path prefix, e.g. "/Codex Sessions/2026-03-21"
   */
  getDailyPath(parentPath, date) {
    return `${parentPath.replace(/\/+$/, '')}/${date}`;
  }
}

module.exports = SiYuanAPI;
