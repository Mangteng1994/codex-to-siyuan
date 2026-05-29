# AGENTS.md

## 项目概述

这是一个思源笔记插件，通过 Claude Code 的 Stop Hook 机制，在每次对话结束后自动将对话记录同步到思源笔记中。插件在思源集市中名为「Claude Code 会话同步」，内部标识为 `claude-to-siyuan`。

## 对话风格

**默认启用 `caveman` skill 的 `wenyan-full` 模式**。在此项目中，AI 助手默认以文言文风格进行回复——言简意赅、惜字如金，同时保持技术准确性。

## 项目结构

```
├── index.js              # 思源插件入口（注册设置面板、顶栏按钮、IPC 消息监听）
├── hook.js               # Hook 独立入口（由 Claude Code Stop Hook 调用，读取 stdin JSON 作为输入）
├── plugin.json           # 思源插件清单
├── package.json          # Node.js 包描述（无依赖，纯 Node 内置模块）
├── src/
│   ├── parser.js         # JSONL 会话记录解析器（增量读取 + 多轮消息解析）
│   ├── formatter.js      # Markdown 格式化器（支持模板变量 ${role}/${time}/${content}）
│   ├── siyuan-api.js     # 思源 API 客户端（创建文档、追加块、笔记本查询）
│   └── state.js          # 会话状态管理（文件系统存储 byte offset 等状态）
├── test/
│   ├── parser.test.js    # 解析器单元测试
│   ├── formatter.test.js # 格式化器单元测试
│   └── siyuan-api.test.js# API 客户端单元测试
├── i18n/
│   ├── zh_CN.json        # 简体中文本地化
│   └── en_US.json        # 英文本地化
├── README.md             # 英文说明
└── README_zh_CN.md       # 中文说明
```

## 核心架构

### 两条执行路径

1. **思源插件侧（index.js）**：在思源内部运行，负责 UI（设置面板、顶栏按钮）和 Hook 的安装/卸载。
2. **Hook 侧（hook.js）**：由 Claude Code 在对话结束时作为独立进程调用，负责读取会话记录 → 格式化 → 写入思源。

两者的配置通过思源插件的 `data/storage.json` 共享：`hook.js` 从 `{workspace}/data/storage/petal/claude-to-siyuan/config.json` 读取配置。

### 数据流

```
Claude Code 对话结束
  → Stop Hook 调用 hook.js（通过 stdin 传入 session_id、transcript_path、cwd）
    → parser.js 从上次 byte offset 增量读取 JSONL
    → formatter.js 用模板格式化为 Markdown
    → siyuan-api.js 创建/追加到思源文档
    → state.js 保存 session_id 对应的新 byte offset
```

## 编码规范

### 通用规则

- **语言**：所有注释和文档使用**中文**，变量名、函数名使用英文。
- **零依赖原则**：不使用任何 npm 依赖，仅使用 Node.js 内置模块（fs、path、http/https、crypto 等）。
- **安全不阻塞**：Hook 侧所有错误必须静默处理，绝对不能阻止 Claude Code 正常退出。`hook.js` 的 `main()` 必须 `.catch()` 后 `process.exit(0)`。
- **向后兼容**：修改代码时确保与思源最低版本 `3.2.0` 兼容，支持 Windows/Linux/macOS 三个平台。

### 代码风格

- 使用 CommonJS（`require`/`module.exports`），不使用 ES Module。
- 使用 `const` 声明不可变变量，`let` 声明可变变量，不使用 `var`。
- 每个文件顶部用 JSDoc 注释说明文件用途。
- 函数参数使用 JSDoc `@param` / `@returns` 标注类型。

### 文件命名

- 源文件使用短横线命名：`siyuan-api.js`、`parser.js`
- 测试文件规则：`test/<module>.test.js`
- JSON 配置全部使用小写+短横线：`plugin.json`、`hook.js`

## 关键约定

### parser.js

- `parseTranscript(filePath, byteOffset)` 返回 `{ messages, newByteOffset }`
- 消息结构：`{ role: 'user'|'assistant', timestamp: string|null, parts: Array }`
- 每个 part 结构：`{ type: 'text'|'tool_use'|'tool_result', text?: string, name?: string, input?: string }`
- 只处理 `type === 'user'` 和 `type === 'assistant'` 的条目，忽略 system 等其他类型
- 解析失败的行静默跳过

### formatter.js

- `formatMessages(messages, template)` 返回完整 Markdown 字符串
- 模板变量：`${role}` → `🧑 User` / `🤖 Claude`，`${time}` → `HH:MM:SS`，`${content}` → 格式化后的内容
- markdown 代码块标记为：\`\`\`text、\`\`\`json、\`\`\`sh、\`\`\`python 等无前缀形式
- tool_use block 渲染为引用块 `> Tool: ...`
- tool_result block 截断到 300 字符

### siyuan-api.js

- API 基路径：`/api/`（POST 请求，JSON 格式）
- 核心方法：`createDocWithMsg(notebook, path, markdown)`、`appendBlock(docId, markdown)`、`listNotebooks()`
- 鉴权：通过 HTTP Header `Authorization: Token {token}`
- 所有方法返回 Promise

### state.js

- 状态文件路径：`{os.tmpdir()}/claude-to-siyuan-states/`
- 状态结构：`{ sessionId, docId, lastByteOffset, createdAt }`
- 文件名：`{hash(sessionId)}.json`（通过 crypto.createHash('md5')）
- 48 小时以上的状态文件自动清理（`cleanupStaleStates()`）

### hook.js

- 从 stdin 读取 JSON（Claude Code 传入的 hook 上下文）
- 必填字段：`session_id`、`transcript_path`
- 配置读取优先级：环境变量 `CLAUDE_TO_SIYUAN_CONFIG` > 思源 data/storage 路径 > 家目录 `.claude-to-siyuan/config.json`
- Token 读取优先级：`SIYUAN_TOKEN` 环境变量 > 思源 conf/conf.json > 家目录旧配置 > 空字符串
- 使用 `SCRIPT_DIR`（通过 `fs.realpathSync` 获取）而非 `__dirname`，以避免符号链接场景下的路径错误

### index.js（思源插件入口）

- 注册设置面板（`this.addSetting`）
- 注册顶栏按钮（`this.addTopBar`）
- 监听 IPC 消息实现 Hook 安装/卸载
- 配置持久化到 `this.data`（思源插件的内置存储）
- 使用 `require` 延迟加载 src 模块（思源插件加载时 `__dirname` 上下文特殊）

## 测试

```bash
# 运行所有测试
node --test test/*.test.js

# 运行单个测试文件
node --test test/parser.test.js
```

- 使用 Node.js 内置 `node:test` 和 `node:assert`（无外部测试框架）
- 测试覆盖核心解析、格式化、API 调用逻辑
- 更新代码后必须运行全部测试确保不破坏现有功能

## 本地化

- 所有用户可见字符串必须在 `i18n/zh_CN.json` 和 `i18n/en_US.json` 中定义
- 在代码中使用 `this.i18n.keyName` 引用
- 新增功能时同时添加中英文 key

## 常见修改指引

| 需求 | 涉及文件 |
|------|----------|
| 新增消息类型支持 | `src/parser.js` + `src/formatter.js` |
| 修改消息格式 | `src/formatter.js` |
| 新增 API 方法 | `src/siyuan-api.js` |
| 新增设置项 | `index.js` + `i18n/zh_CN.json` + `i18n/en_US.json` |
| 修改 Hook 行为 | `hook.js` + `src/parser.js` |
| 修改默认模板 | `hook.js` 中的 `DEFAULT_TEMPLATE` / `DEFAULT_HEADER_TEMPLATE` |

## 发布流程

1. 更新 `plugin.json` 中的 `version` 字段
2. 更新 `package.json` 中的 `version` 字段
3. 将插件文件夹打包为 zip（确保 plugin.json 在根目录）
4. 提交到思源集市或 GitHub Release
