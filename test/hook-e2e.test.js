const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { getStatePath } = require('../src/state');

function writeJsonl(filePath, entries) {
  fs.appendFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}

function startFakeSiYuan() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, body });
      const data = req.url === '/api/filetree/createDocWithMd'
        ? 'doc-e2e'
        : [{ id: 'block-e2e' }];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: '', data }));
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function runHook(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'hook.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('hook first run creates doc from non-response_item first user and appends second turn once', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-e2e-'));
  const sessionId = `e2e-${Date.now()}-${Math.random()}`;
  const statePath = getStatePath(sessionId);
  const transcriptPath = path.join(tempDir, 'session.jsonl');
  const configPath = path.join(tempDir, 'config.json');
  const fake = await startFakeSiYuan();

  try {
    fs.rmSync(statePath, { force: true });
    fs.writeFileSync(configPath, JSON.stringify({
      notebook: 'notebook-e2e',
      siyuanUrl: fake.baseUrl,
      siyuanToken: 'token-e2e',
      syncMode: 'classic',
      parentPath: '/Codex Sessions',
      pathTemplate: '${parentPath}/${date}/${title}',
      template: '## ${role} (${time})\n\n${content}\n\n---\n',
      headerTemplate: '# ${projectName}\n\n- Session ID: ${sessionId}\n\n---\n',
    }), 'utf8');

    writeJsonl(transcriptPath, [
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      {
        timestamp: '2026-05-31T02:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<environment_context><cwd>C:\\demo</cwd></environment_context>\n\n你好',
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
    ]);

    const env = {
      CODEX_TO_SIYUAN_CONFIG: configPath,
      CODEX_TO_SIYUAN_DEBUG: '1',
      CODEX_TO_SIYUAN_DEBUG_NEEDLE: '你好',
    };
    const first = await runHook({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: 'C:\\demo',
    }, env);

    assert.equal(first.code, 0);
    assert.match(first.stderr, /hook summary start/);
    assert.equal(first.stderr.includes(`sessionId=${sessionId}`), true);
    assert.equal(first.stderr.includes(`transcriptPath=${transcriptPath}`), true);
    assert.match(first.stderr, /previousByteOffset=0/);
    assert.match(first.stderr, /newByteOffset=\d+/);
    assert.match(first.stderr, /rawParsedMessages=2/);
    assert.match(first.stderr, /hook summary normalized: normalizedMessages=2/);
    assert.match(first.stderr, /filteredMessages=2/);
    assert.match(first.stderr, /raw parsed message\[0\]: role=user, turnId=turn-1, source=payload\.message, text="你好"/);
    assert.match(first.stderr, /filtered message\[0\]: role=user, turnId=turn-1, source=payload\.message, text="你好"/);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].url, '/api/filetree/createDocWithMd');
    assert.match(fake.requests[0].body.markdown, /## 🧑 User/);
    assert.match(fake.requests[0].body.markdown, /你好/);
    assert.match(fake.requests[0].body.markdown, /## 🤖 Codex/);
    assert.match(fake.requests[0].body.markdown, /第一轮回复/);
    assert.equal(fake.requests[0].body.markdown.includes('environment_context'), false);

    writeJsonl(transcriptPath, [
      { type: 'turn_context', payload: { turn_id: 'turn-2' } },
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

    const second = await runHook({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: 'C:\\demo',
    }, env);

    assert.equal(second.code, 0);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1].url, '/api/block/appendBlock');
    assert.match(fake.requests[1].body.data, /## 🧑 User/);
    assert.match(fake.requests[1].body.data, /你好/);
    assert.match(fake.requests[1].body.data, /## 🤖 Codex/);
    assert.match(fake.requests[1].body.data, /第二轮回复/);
    assert.equal(fake.requests[1].body.data.includes('第一轮回复'), false);
  } finally {
    await new Promise(resolve => fake.server.close(resolve));
    fs.rmSync(statePath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
