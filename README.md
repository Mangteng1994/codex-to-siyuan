# Codex Session Sync

[中文说明](https://github.com/Mangteng1994/codex-to-siyuan/blob/master/README_zh_CN.md)

> **基于 [yongnianliu/claude-to-siyuan](https://github.com/yongnianliu/claude-to-siyuan) 改造**，将 Claude Code Stop Hook 适配为 Codex Stop Hook，实现将 Codex 对话自动保存到思源笔记。

A SiYuan plugin that automatically saves Codex conversations to SiYuan notes via Stop hook.

## Features

- 🔄 **Incremental Sync** — Only appends new content after each conversation turn
- 📁 **Date-based Organization** — Auto-creates `/Codex Sessions/YYYY-MM-DD/` structure
- ⚙️ **Settings UI** — Configure everything through SiYuan's plugin settings panel
- 🔧 **One-click Hook Install** — Install/uninstall the Codex hook directly from SiYuan
- 🔒 **Zero Dependencies** — Uses only Node.js built-in modules
- 🛡️ **Non-blocking** — All errors handled silently, never interferes with Codex

## Installation

### From SiYuan Bazaar (Recommended)
1. Open SiYuan → Settings → Bazaar → Plugins
2. Search for "Codex Session Sync"
3. Click Install

### Manual Installation
1. Download the latest release
2. Extract to `{SiYuan workspace}/data/plugins/codex-to-siyuan/`
3. Restart SiYuan

## Setup

1. **Open Plugin Settings**: Click the `</>` icon in SiYuan's top bar → Settings
2. **Select Notebook**: Choose which notebook to save sessions to
3. **Install Hook**: Click "Install Hook" to register the Codex Stop hook (writes to `~/.codex/hooks.json`)
4. **Start Codex**: The hook activates on next Codex session

## How It Works

```
Codex conversation
    ↓ (Stop hook triggers after each turn)
hook.js receives hook data via stdin
    ↓ (parses transcript incrementally)
Formats as Markdown
    ↓
Creates/appends to SiYuan document
    ↓
/Codex Sessions/2026-05-28/project-name - first message...
```

## Configuration

All settings are available through the plugin's settings panel in SiYuan:

| Setting | Description | Default |
|---------|-------------|---------|
| Target Notebook | Which notebook to save to | (required) |
| Document Path | Parent path for session docs | `/Codex Sessions` |
| Message Template | Per-message format | `## ${role} (${time})\n\n${content}\n\n---\n` |
| Header Template | New document header | See settings |
| Sync Content Mode | Controls what is saved per turn | `classic` |

### Sync Content Mode

| Mode | Description |
|------|-------------|
| `classic` | **Default**. Saves user input + final Codex output |
| `minimal` | Saves final Codex output only |
| `full` | Saves the complete process (including tool calls & results), same as old behavior |

### Template Variables

**Message Template**: `${role}`, `${time}`, `${content}`

**Header Template**: `${projectName}`, `${date}`, `${time}`, `${sessionId}`

## Codex Hook Configuration

The plugin writes a Stop hook to `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/siyuan/data/plugins/codex-to-siyuan/hook.js",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SIYUAN_TOKEN` | Override SiYuan API token |
| `CODEX_TO_SIYUAN_CONFIG` | Custom config file path |

## Testing

```bash
node --test test/*.test.js
```

## Credits

This project is a fork of [yongnianliu/claude-to-siyuan](https://github.com/yongnianliu/claude-to-siyuan), adapted to work with Codex Stop hooks instead of Claude Code Stop hooks.


## Changelog

### v0.9.6 (2026-05-30)

- **Added** Sync Content Mode with three options:
  - `classic` (default): user input + final Codex output
  - `minimal`: final Codex output only
  - `full`: complete process (same as previous behavior)
- Old configs without this field default to classic mode, fully backward compatible

## License

MIT
