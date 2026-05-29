/**
 * codex-to-siyuan — SiYuan Plugin
 *
 * Provides settings UI and manages the Codex Stop hook that
 * saves conversation turns to SiYuan notes.
 */

const { Plugin, Setting, showMessage } = require('siyuan');

const PLUGIN_NAME = 'codex-to-siyuan';
const CONFIG_KEY = 'config.json';
const HOOK_CONFIG_KEY = 'hook-config.json';

const DEFAULT_TEMPLATE = '## ${role} (${time})\n\n${content}\n\n---\n';
const DEFAULT_HEADER_TEMPLATE =
  '# ${projectName}\n\n- 项目: ${projectName}\n- 开始时间: ${date} ${time}\n- Session ID: ${sessionId}\n\n---\n';

const DEFAULT_CONFIG = {
  notebook: '',
  parentPath: '/Codex Sessions',
  siyuanPort: '6806',
  template: DEFAULT_TEMPLATE,
  headerTemplate: DEFAULT_HEADER_TEMPLATE,
  syncMode: 'classic',
};

module.exports = class CodexToSiYuan extends Plugin {
  config = { ...DEFAULT_CONFIG };

  async onload() {
    // Load saved config
    const saved = await this.loadData(CONFIG_KEY);
    if (saved) {
      Object.assign(this.config, saved);
    }

    // Build settings UI
    this.initSettings();

    // Add top bar button
    this.addTopBar({
      icon: 'iconCode',
      title: this.i18n.topbar.title,
      position: 'right',
      callback: () => {
        if (!this.setting) {
          this.initSettings();
        }
        this.setting.open(this.name);
      },
    });
  }

  async onunload() {
    // Nothing to clean up
  }

  async uninstall() {
    // Uninstall hook when plugin is removed
    try {
      await this.doUninstallHook();
    } catch (_) {
      // Best-effort
    }
    // Delete plugin data from petal directory
    this.removeData(CONFIG_KEY).catch(() => {});
    this.removeData(HOOK_CONFIG_KEY).catch(() => {});
  }

  // ── Settings UI ─────────────────────────────────────────────────

  initSettings() {
    // Store references to inputs for reset on cancel
    const inputs = {};

    this.setting = new Setting({
      confirmCallback: async () => {
        this.config.notebook = inputs.notebook.value;
        this.config.parentPath = inputs.parentPath.value || '/Codex Sessions';
        this.config.siyuanPort = inputs.port.value || '6806';
        this.config.syncMode = inputs.syncMode.value || 'classic';
        this.config.template = inputs.template.value || DEFAULT_TEMPLATE;
        this.config.headerTemplate = inputs.header.value || DEFAULT_HEADER_TEMPLATE;
        await this.saveData(CONFIG_KEY, this.config);
        await this.writeHookConfig();
      },
      destroyCallback: () => {
        // Reset inputs to saved config values on cancel / close
        inputs.notebook.value = this.config.notebook;
        inputs.parentPath.value = this.config.parentPath;
        inputs.port.value = this.config.siyuanPort || '6806';
        inputs.syncMode.value = this.config.syncMode || 'classic';
        inputs.template.value = this.config.template;
        inputs.header.value = this.config.headerTemplate;
      },
    });

    // -- Hook status display --
    const hookStatusDiv = document.createElement('div');
    hookStatusDiv.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

    const statusSpan = document.createElement('span');
    statusSpan.style.cssText = 'font-size:14px;';

    const installBtn = document.createElement('button');
    installBtn.className = 'b3-button b3-button--text fn__size200';
    installBtn.textContent = this.i18n.setting.installHook;
    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      installBtn.textContent = '...';
      try {
        await this.doInstallHook();
        showMessage(this.i18n.setting.hookInstalledMsg);
        await this.refreshHookStatus(statusSpan);
      } catch (e) {
        showMessage(this.i18n.setting.hookInstallFailed + e.message, 6000, 'error');
      } finally {
        installBtn.disabled = false;
        installBtn.textContent = this.i18n.setting.installHook;
      }
    });

    const uninstallBtn = document.createElement('button');
    uninstallBtn.className = 'b3-button b3-button--text fn__size200';
    uninstallBtn.textContent = this.i18n.setting.uninstallHook;
    uninstallBtn.addEventListener('click', async () => {
      uninstallBtn.disabled = true;
      uninstallBtn.textContent = '...';
      try {
        await this.doUninstallHook();
        showMessage(this.i18n.setting.hookUninstalledMsg);
        await this.refreshHookStatus(statusSpan);
      } catch (e) {
        showMessage(this.i18n.setting.hookUninstallFailed + e.message, 6000, 'error');
      } finally {
        uninstallBtn.disabled = false;
        uninstallBtn.textContent = this.i18n.setting.uninstallHook;
      }
    });

    hookStatusDiv.appendChild(statusSpan);
    hookStatusDiv.appendChild(installBtn);
    hookStatusDiv.appendChild(uninstallBtn);

    // Refresh hook status asynchronously
    this.refreshHookStatus(statusSpan);

    // -- Notebook selector --
    const notebookSelect = document.createElement('select');
    notebookSelect.className = 'b3-select fn__block';
    notebookSelect.innerHTML = `<option value="">${this.i18n.setting.selectNotebook}</option>`;
    this.loadNotebooks(notebookSelect);
    inputs.notebook = notebookSelect;

    // -- Parent path input --
    const parentPathInput = document.createElement('input');
    parentPathInput.className = 'b3-text-field fn__block';
    parentPathInput.value = this.config.parentPath;
    parentPathInput.placeholder = '/Codex Sessions';
    inputs.parentPath = parentPathInput;

    // -- SiYuan port input --
    const portInput = document.createElement('input');
    portInput.className = 'b3-text-field fn__block';
    portInput.type = 'number';
    portInput.min = '1';
    portInput.max = '65535';
    portInput.value = this.config.siyuanPort || '6806';
    portInput.placeholder = '6806';
    inputs.port = portInput;
    // -- Sync content mode select --
    const syncModeSelect = document.createElement('select');
    syncModeSelect.className = 'b3-select fn__block';
    const syncModes = [
      { value: 'classic', label: this.i18n.setting.syncModeClassic },
      { value: 'minimal', label: this.i18n.setting.syncModeMinimal },
      { value: 'full', label: this.i18n.setting.syncModeFull },
    ];
    for (const mode of syncModes) {
      const opt = document.createElement('option');
      opt.value = mode.value;
      opt.textContent = mode.label;
      if (mode.value === (this.config.syncMode || 'classic')) {
        opt.selected = true;
      }
      syncModeSelect.appendChild(opt);
    }
    inputs.syncMode = syncModeSelect;


    // -- Codex hooks path display (read-only) --
    const codexPathDiv = document.createElement('div');
    codexPathDiv.style.cssText = 'font-family:monospace;font-size:13px;color:var(--b3-theme-on-surface);opacity:0.7;padding:6px 0;';
    codexPathDiv.textContent = '~/.codex/hooks.json';

    // -- Message template textarea --
    const templateInput = document.createElement('textarea');
    templateInput.className = 'b3-text-field fn__block';
    templateInput.style.height = '80px';
    templateInput.style.fontFamily = 'monospace';
    templateInput.value = this.config.template;
    inputs.template = templateInput;

    // -- Header template textarea --
    const headerInput = document.createElement('textarea');
    headerInput.className = 'b3-text-field fn__block';
    headerInput.style.height = '60px';
    headerInput.style.fontFamily = 'monospace';
    headerInput.value = this.config.headerTemplate;
    inputs.header = headerInput;

    // -- Test connection button --
    const testBtn = document.createElement('button');
    testBtn.className = 'b3-button b3-button--outline fn__size200';
    testBtn.textContent = this.i18n.setting.testConnection;
    testBtn.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/system/version', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const data = await resp.json();
        if (data.code === 0) {
          showMessage(this.i18n.setting.testSuccess);
        } else {
          showMessage(this.i18n.setting.testFailed + data.msg, 6000, 'error');
        }
      } catch (e) {
        showMessage(this.i18n.setting.testFailed + e.message, 6000, 'error');
      }
    });

    // -- Reset templates button --
    const resetBtn = document.createElement('button');
    resetBtn.className = 'b3-button b3-button--outline fn__size200';
    resetBtn.textContent = this.i18n.setting.resetBtn;
    resetBtn.addEventListener('click', () => {
      templateInput.value = DEFAULT_TEMPLATE;
      headerInput.value = DEFAULT_HEADER_TEMPLATE;
      showMessage(this.i18n.setting.resetDone);
    });

    // -- Add items to setting panel --
    this.setting.addItem({
      title: this.i18n.setting.hookStatus,
      direction: 'row',
      createActionElement: () => hookStatusDiv,
    });

    this.setting.addItem({
      title: this.i18n.setting.notebook,
      description: this.i18n.setting.notebookDesc,
      direction: 'row',
      createActionElement: () => notebookSelect,
    });

    this.setting.addItem({
      title: this.i18n.setting.parentPath,
      description: this.i18n.setting.parentPathDesc,
      direction: 'row',
      createActionElement: () => parentPathInput,
    });

    this.setting.addItem({
      title: this.i18n.setting.siyuanPort,
      description: this.i18n.setting.siyuanPortDesc,
      direction: 'row',
      createActionElement: () => portInput,
    });


    this.setting.addItem({
      title: this.i18n.setting.syncMode,
      description: this.i18n.setting.syncModeDesc,
      direction: 'row',
      createActionElement: () => syncModeSelect,
    });

    this.setting.addItem({
      title: this.i18n.setting.codexHooksPath,
      description: this.i18n.setting.codexHooksPathDesc,
      direction: 'row',
      createActionElement: () => codexPathDiv,
    });

    this.setting.addItem({
      title: this.i18n.setting.template,
      description: this.i18n.setting.templateDesc,
      direction: 'column',
      createActionElement: () => templateInput,
    });

    this.setting.addItem({
      title: this.i18n.setting.headerTemplate,
      description: this.i18n.setting.headerTemplateDesc,
      direction: 'column',
      createActionElement: () => headerInput,
    });

    this.setting.addItem({
      title: this.i18n.setting.testConnection,
      direction: 'row',
      createActionElement: () => testBtn,
    });

    this.setting.addItem({
      title: this.i18n.setting.resetTemplates,
      description: this.i18n.setting.resetTemplatesDesc,
      direction: 'row',
      createActionElement: () => resetBtn,
    });
  }

  // ── Notebook loading ────────────────────────────────────────────

  async loadNotebooks(selectEl) {
    try {
      const resp = await fetch('/api/notebook/lsNotebooks', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await resp.json();
      if (data.code === 0 && data.data && data.data.notebooks) {
        for (const nb of data.data.notebooks) {
          if (nb.closed) continue;
          const opt = document.createElement('option');
          opt.value = nb.id;
          opt.textContent = nb.name;
          if (nb.id === this.config.notebook) {
            opt.selected = true;
          }
          selectEl.appendChild(opt);
        }
      }
    } catch (e) {
      console.error(`[${PLUGIN_NAME}] ${this.i18n.setting.notebookLoadFailed}:`, e);
    }
  }

  // ── Helper: async Node.js execution ─────────────────────────────

  execNodeAsync(scriptPath) {
    return new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      exec(`node "${scriptPath}"`, { encoding: 'utf8', timeout: 10000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  }

  // ── Hook management ─────────────────────────────────────────────

  async getHookScriptPath() {
    const confResp = await fetch('/api/system/getConf', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const confData = await confResp.json();

    let workspacePath = '';
    if (confData.code === 0 && confData.data && confData.data.conf) {
      workspacePath = confData.data.conf.system.workspaceDir;
    }

    if (!workspacePath) {
      throw new Error('Could not determine SiYuan workspace path');
    }

    const sep = workspacePath.includes('\\') ? '\\' : '/';
    return workspacePath + sep + 'data' + sep + 'plugins' + sep + PLUGIN_NAME + sep + 'hook.js';
  }

  /**
   * Install the Codex Stop hook by writing to ~/.codex/hooks.json
   */
  async doInstallHook() {
    const hookPath = await this.getHookScriptPath();
    const normalizedPath = hookPath.replace(/\\/g, '/');

    await this.writeHookConfig();

    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tmpScript = path.join(os.tmpdir(), 'codex-siyuan-install.js');

    fs.writeFileSync(tmpScript, `
const fs = require('fs');
const path = require('path');
const os = require('os');
const hooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
const hookCommand = 'node "${normalizedPath}"';
let hooksConfig = {};
try {
  if (fs.existsSync(hooksPath)) {
    hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  }
} catch(e) { hooksConfig = {}; }
if (!hooksConfig.hooks) hooksConfig.hooks = {};
if (!hooksConfig.hooks.Stop) hooksConfig.hooks.Stop = [];
const exists = hooksConfig.hooks.Stop.some(entry =>
  entry.hooks && entry.hooks.some(h => h.command && h.command.includes('codex-to-siyuan'))
);
if (!exists) {
  hooksConfig.hooks.Stop.push({
    hooks: [{ type: 'command', command: hookCommand, timeout: 30 }]
  });
  const dir = path.dirname(hooksPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2), 'utf8');
}
`, 'utf8');

    try {
      await this.execNodeAsync(tmpScript);
    } finally {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
    }
  }

  /**
   * Uninstall the Codex Stop hook from ~/.codex/hooks.json
   */
  async doUninstallHook() {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tmpScript = path.join(os.tmpdir(), 'codex-siyuan-uninstall.js');

    fs.writeFileSync(tmpScript, `
const fs = require('fs');
const path = require('path');
const os = require('os');
const hooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
let hooksConfig = {};
try {
  hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
} catch(e) { process.exit(0); }
if (hooksConfig.hooks && hooksConfig.hooks.Stop) {
  hooksConfig.hooks.Stop = hooksConfig.hooks.Stop.filter(entry =>
    !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes('codex-to-siyuan')))
  );
  if (hooksConfig.hooks.Stop.length === 0) delete hooksConfig.hooks.Stop;
  if (Object.keys(hooksConfig.hooks).length === 0) delete hooksConfig.hooks;
  fs.writeFileSync(hooksPath, JSON.stringify(hooksConfig, null, 2), 'utf8');
}
`, 'utf8');

    try {
      await this.execNodeAsync(tmpScript);
    } finally {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
    }
  }

  /**
   * Check if Codex hook is installed
   */
  async checkHookStatus() {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const hooksPath = path.join(os.homedir(), '.codex', 'hooks.json');

      if (!fs.existsSync(hooksPath)) return false;
      const hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      return hooksConfig.hooks && hooksConfig.hooks.Stop && hooksConfig.hooks.Stop.some(entry =>
        entry.hooks && entry.hooks.some(h => h.command && h.command.includes('codex-to-siyuan'))
      );
    } catch {
      return false;
    }
  }

  /**
   * Refresh hook status display
   */
  async refreshHookStatus(statusSpan) {
    try {
      const installed = await this.checkHookStatus();
      statusSpan.textContent = installed
        ? this.i18n.setting.hookInstalled
        : this.i18n.setting.hookNotInstalled;
    } catch {
      statusSpan.textContent = this.i18n.setting.hookNotInstalled;
    }
  }

  // ── Hook config file ────────────────────────────────────────────

  async writeHookConfig() {
    const hookConfig = {
      notebook: this.config.notebook,
      parentPath: this.config.parentPath,
      siyuanPort: this.config.siyuanPort || '6806',
      template: this.config.template,
      headerTemplate: this.config.headerTemplate,
      syncMode: this.config.syncMode || 'classic',
    };

    await this.saveData(HOOK_CONFIG_KEY, hookConfig);
  }
};