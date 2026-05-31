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


// ── New tests for sessionIdShort, fallback, and routing ──────────

function startFakeSiYuanWithFallback() {
  const requests = [];
  let createCount = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, body });
      let data, code = 0, msg = '';

      if (req.url === '/api/filetree/createDocWithMd') {
        createCount += 1;
        if (createCount === 1) {
          code = 405;
          msg = 'path exists';
          data = null;
        } else {
          code = 0;
          msg = '';
          data = 'doc-fallback';
        }
      } else {
        data = [{ id: 'block-e2e' }];
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code, msg, data }));
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

function startFakeSiYuanMultiSession() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, body });
      const data = req.url === '/api/filetree/createDocWithMd'
        ? `doc-${Date.now()}-${requests.length}`
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

test('两个不同 session 第一句都是"你好"，docPath 必须不同', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-uniq-'));
  const fake = await startFakeSiYuanMultiSession();
  const session1 = `e2e-aaa-${Date.now()}`;
  const session2 = `e2e-bbb-${Date.now()}`;
  const transcript1 = path.join(tempDir, 'session1.jsonl');
  const transcript2 = path.join(tempDir, 'session2.jsonl');
  const configPath = path.join(tempDir, 'config.json');
  const state1 = getStatePath(session1);
  const state2 = getStatePath(session2);

  try {
    fs.rmSync(state1, { force: true });
    fs.rmSync(state2, { force: true });
    fs.writeFileSync(configPath, JSON.stringify({
      notebook: 'notebook-uniq',
      siyuanUrl: fake.baseUrl,
      siyuanToken: 'token-uniq',
      syncMode: 'classic',
      parentPath: '/Codex Sessions',
      pathTemplate: '${parentPath}/${date}/${title}-${sessionIdShort}',
      template: '## ${role} (${time})\n\n${content}\n\n---\n',
      headerTemplate: '# ${projectName}\n\n---\n',
    }), 'utf8');

    const entries = [
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      {
        timestamp: '2026-05-31T03:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: '<environment_context><cwd>C:\\demo</cwd></environment_context>\n\n你好' },
      },
      {
        timestamp: '2026-05-31T03:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回复' }] },
      },
    ];

    fs.writeFileSync(transcript1, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fs.writeFileSync(transcript2, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const env = {
      CODEX_TO_SIYUAN_CONFIG: configPath,
      CODEX_TO_SIYUAN_DEBUG: '1',
    };

    const r1 = await runHook({ session_id: session1, transcript_path: transcript1, cwd: 'C:\\demo' }, env);
    const r2 = await runHook({ session_id: session2, transcript_path: transcript2, cwd: 'C:\\demo' }, env);

    assert.equal(r1.code, 0);
    assert.equal(r2.code, 0);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[0].url, '/api/filetree/createDocWithMd');
    assert.equal(fake.requests[1].url, '/api/filetree/createDocWithMd');

    // Both docPaths should contain the title ending with sessionIdShort
    const path1 = fake.requests[0].body.path;
    const path2 = fake.requests[1].body.path;

    assert.equal(path1.includes('你好'), true, `path1 should contain 你好: ${path1}`);
    assert.equal(path2.includes('你好'), true, `path2 should contain 你好: ${path2}`);
    // Paths must differ (different sessionIdShort)
    assert.notEqual(path1, path2, `docPaths should differ: ${path1} vs ${path2}`);
    // Each path should end with 8-char sessionIdShort
    // Each path should end with the session's first 8 chars
    const sid1Short = session1.slice(0, 8);
    const sid2Short = session2.slice(0, 8);
    assert.equal(path1.endsWith(`-${sid1Short}`), true, `path1 should end with -${sid1Short}: ${path1}`);
    assert.equal(path2.endsWith(`-${sid2Short}`), true, `path2 should end with -${sid2Short}: ${path2}`);
  } finally {
    await new Promise(resolve => fake.server.close(resolve));
    fs.rmSync(state1, { force: true });
    fs.rmSync(state2, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('createDocWithMd 首次 path exists 后 fallback 到 sessionIdShort 成功', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-fb-'));
  const sessionId = `e2e-fb-${Date.now()}-ccc`;
  const statePath = getStatePath(sessionId);
  const transcriptPath = path.join(tempDir, 'session.jsonl');
  const configPath = path.join(tempDir, 'config.json');
  const fake = await startFakeSiYuanWithFallback();

  try {
    fs.rmSync(statePath, { force: true });
    fs.writeFileSync(configPath, JSON.stringify({
      notebook: 'notebook-fb',
      siyuanUrl: fake.baseUrl,
      siyuanToken: 'token-fb',
      syncMode: 'classic',
      parentPath: '/Codex Sessions',
      // Old-style pathTemplate without sessionIdShort
      pathTemplate: '${parentPath}/${date}/${title}',
      template: '## ${role} (${time})\n\n${content}\n\n---\n',
      headerTemplate: '# ${projectName}\n\n---\n',
    }), 'utf8');

    writeJsonl(transcriptPath, [
      { type: 'turn_context', payload: { turn_id: 'turn-fb-1' } },
      {
        timestamp: '2026-05-31T04:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: '<environment_context><cwd>C:\\demo</cwd></environment_context>\n\n你好' },
      },
      {
        timestamp: '2026-05-31T04:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回复' }] },
      },
    ]);

    const env = {
      CODEX_TO_SIYUAN_CONFIG: configPath,
      CODEX_TO_SIYUAN_DEBUG: '1',
    };

    const result = await runHook({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: 'C:\\demo',
    }, env);

    assert.equal(result.code, 0);
    // First request: createDocWithMd with old path → fails
    // Second request: createDocWithMd with fallback path → succeeds
    assert.equal(fake.requests.length, 2, `Expected 2 requests, got ${fake.requests.length}`);
    assert.equal(fake.requests[0].url, '/api/filetree/createDocWithMd');
    assert.equal(fake.requests[1].url, '/api/filetree/createDocWithMd');

    // Fallback path should end with -sessionIdShort
    const fallbackPath = fake.requests[1].body.path;
    const sessionIdShort = sessionId.slice(0, 8);
    assert.equal(fallbackPath.endsWith(`-${sessionIdShort}`), true,
      `Fallback path should end with -${sessionIdShort}: ${fallbackPath}`);

    // Original path should NOT end with sessionIdShort
    const originalPath = fake.requests[0].body.path;
    assert.notEqual(originalPath, fallbackPath,
      `Original and fallback paths must differ: ${originalPath} vs ${fallbackPath}`);

    // State should be saved with fallback docId
    const savedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(savedState.docId, 'doc-fallback');
  } finally {
    await new Promise(resolve => fake.server.close(resolve));
    fs.rmSync(statePath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('createDocWithMd 非 path-exists 错误时不推进 state', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-ne-'));
  const sessionId = `e2e-ne-${Date.now()}-ddd`;
  const statePath = getStatePath(sessionId);
  const transcriptPath = path.join(tempDir, 'session.jsonl');
  const configPath = path.join(tempDir, 'config.json');

  // Fake server that always returns a non-path-exists error
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Return a generic API error (not path-exists)
      res.end(JSON.stringify({ code: 500, msg: 'internal server error', data: null }));
    });
  });

  const fake = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${port}` });
    });
  });

  try {
    fs.rmSync(statePath, { force: true });
    fs.writeFileSync(configPath, JSON.stringify({
      notebook: 'notebook-ne',
      siyuanUrl: fake.baseUrl,
      siyuanToken: 'token-ne',
      syncMode: 'classic',
      parentPath: '/Codex Sessions',
      pathTemplate: '${parentPath}/${date}/${title}',
      template: '## ${role} (${time})\n\n${content}\n\n---\n',
      headerTemplate: '# ${projectName}\n\n---\n',
    }), 'utf8');

    writeJsonl(transcriptPath, [
      { type: 'turn_context', payload: { turn_id: 'turn-ne-1' } },
      {
        timestamp: '2026-05-31T05:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: '<environment_context><cwd>C:\\demo</cwd></environment_context>\n\n你好' },
      },
      {
        timestamp: '2026-05-31T05:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回复' }] },
      },
    ]);

    const env = {
      CODEX_TO_SIYUAN_CONFIG: configPath,
      CODEX_TO_SIYUAN_DEBUG: '1',
    };

    const result = await runHook({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: 'C:\\demo',
    }, env);

    assert.equal(result.code, 0);
    // Should have tried createDocWithMd but not retried (non-path-exists error)
    assert.equal(fake.requests.length, 1, `Expected 1 request, got ${fake.requests.length}`);
    assert.equal(fake.requests[0].url, '/api/filetree/createDocWithMd');

    // State should NOT have docId set (failure was not path-exists)
    // State file may not exist because we return without saving on non-path-exists error
    let savedState = null;
    try {
      savedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      // State file not saved is also valid behavior
    }
    if (savedState) {
      assert.equal(savedState.docId || null, null, 'docId should remain null after non-path-exists failure');
    }
  } finally {
    await new Promise(resolve => fake.server.close(resolve));
    fs.rmSync(statePath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assistant-only first turn without last_assistant_message saves state without creating doc', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-nomsg-'));
  const sessionId = `e2e-nomsg-${Date.now()}-eee`;
  const statePath = getStatePath(sessionId);
  const transcriptPath = path.join(tempDir, 'session.jsonl');
  const configPath = path.join(tempDir, 'config.json');
  const debugLogPath = path.join(os.tmpdir(), 'codex-to-siyuan-debug.log');

  try { fs.rmSync(debugLogPath, { force: true }); } catch {}
  const fake = await startFakeSiYuanMultiSession();

  try {
    fs.rmSync(statePath, { force: true });
    fs.writeFileSync(configPath, JSON.stringify({
      notebook: 'notebook-nomsg',
      siyuanUrl: fake.baseUrl,
      siyuanToken: 'token-nomsg',
      syncMode: 'classic',
      parentPath: '/Codex Sessions',
      pathTemplate: '${parentPath}/${date}/${title}-${sessionIdShort}',
      template: '## ${role} (${time})\
\
${content}\
\
---\
',
      headerTemplate: '# ${projectName}\
\
---\
',
    }), 'utf8');

    writeJsonl(transcriptPath, [
      { type: 'turn_context', payload: { turn_id: 'turn-nomsg-1' } },
      {
        timestamp: '2026-05-31T06:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '自动回复' }] },
      },
    ]);

    const env = {
      CODEX_TO_SIYUAN_CONFIG: configPath,
      CODEX_TO_SIYUAN_DEBUG: '1',
    };

    const r1 = await runHook({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: 'C:\demo',
    }, env);

    assert.equal(r1.code, 0);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.docId || null, null);

    assert.equal(fs.existsSync(debugLogPath), true, 'Debug log file should exist');
    const debugContent = fs.readFileSync(debugLogPath, 'utf8');
    assert.match(debugContent, /hook entry: sessionId=/);
    assert.match(debugContent, /filteredMessages=0/);
  } finally {
    await new Promise(resolve => fake.server.close(resolve));
    fs.rmSync(statePath, { force: true });
    try { fs.rmSync(debugLogPath, { force: true }); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assistant-only first turn WITH last_assistant_message creates doc via fallback', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-fbmsg-'));
  const sessionId = `e2e-fbmsg-${Date.now()}-fff`;
  const statePath = getStatePath(sessionId);
  const transcriptPath = path.join(tempDir, 'session.jsonl');
  const configPath = path.join(tempDir, 'config.json');
  const debugLogPath = path.join(os.tmpdir(), 'codex-to-siyuan-debug.log');

  try { fs.rmSync(debugLogPath, { force: true }); } catch {}
  const fake = await startFakeSiYuanMultiSession();

  try {
    fs.rmSync(statePath, { force: true });
    fs.writeFileSync(configPath, JSON.stringify({
      notebook: 'notebook-fbmsg',
      siyuanUrl: fake.baseUrl,
      siyuanToken: 'token-fbmsg',
      syncMode: 'classic',
      parentPath: '/Codex Sessions',
      pathTemplate: '${parentPath}/${date}/${title}-${sessionIdShort}',
      template: '## ${role} (${time})\
\
${content}\
\
---\
',
      headerTemplate: '# ${projectName}\
\
---\
',
    }), 'utf8');

    writeJsonl(transcriptPath, [
      { type: 'turn_context', payload: { turn_id: 'turn-fbmsg-1' } },
      {
        timestamp: '2026-05-31T07:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'auto reply' }] },
      },
    ]);

    const env = {
      CODEX_TO_SIYUAN_CONFIG: configPath,
      CODEX_TO_SIYUAN_DEBUG: '1',
    };

    const r1 = await runHook({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: 'C:\demo',
      last_assistant_message: 'hello from fallback',
    }, env);

    assert.equal(r1.code, 0);
    assert.equal(fake.requests.length >= 1, true);
    assert.equal(fake.requests[0].url, '/api/filetree/createDocWithMd');
    assert.match(fake.requests[0].body.markdown, /hello from fallback/);
  } finally {
    await new Promise(resolve => fake.server.close(resolve));
    fs.rmSync(statePath, { force: true });
    try { fs.rmSync(debugLogPath, { force: true }); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

