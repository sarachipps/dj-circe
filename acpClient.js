const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { retryable } = require('./retryUtil');

function isRetryableAcpError(err) {
  if (!err) return false;
  if (/hermes acp exited/.test(err.message || '')) return false;
  if (err.code === -32601 || err.code === -32602) return false;
  const detail = (err.data && (err.data.detail || err.data.message)) || '';
  if (/unauthorized|forbidden|invalid token|expired/i.test(String(detail))) return false;
  if (err.code === -32603) return true;
  if (err.code === undefined) return true; // network/socket blip
  return false;
}

let log;
try {
  log = require('electron-log/main');
} catch (_) {
  log = {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
  };
}

const HERMES_BIN = path.join(os.homedir(), '.local', 'bin', 'hermes');
const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');

// Parse a Hermes-style .env file (KEY=value per line, no `export` prefix, no
// interpolation, `#` and blank lines ignored). Values may be single- or
// double-quoted. Returns {} on any read/parse failure — spawn continues
// with whatever env is already present.
function loadProfileEnv(profile) {
  const envPath = path.join(HERMES_HOME, 'profiles', profile, '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;                          // skip blanks / comments
      let val = m[2].trim();
      if (val.startsWith('#')) continue;
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[m[1]] = val;
    }
    return out;
  } catch (_) {
    return {};
  }
}

// Access modes for the write-gate.
//   'unlocked' — auto-approve every session/request_permission
//   'ask'      — park the request, ask the renderer, wait for the user
//   'locked'   — auto-deny every request
const ACCESS_MODES = ['locked', 'ask', 'unlocked'];

// Classify an ACP option object. `kind` is the strongest signal (per ACP spec
// options carry allow_once / allow_always / reject_once / reject_always);
// fall back to name/optionId keyword matching for less strict servers.
const isAllowOption  = (o) =>
  (o?.kind?.startsWith('allow'))  || /allow|approve|yes|accept|permit/i.test(o?.name || o?.optionId || '');
const isRejectOption = (o) =>
  (o?.kind?.startsWith('reject')) || /reject|deny|no|cancel|decline|refuse/i.test(o?.name || o?.optionId || '');

class AcpClient {
  constructor({ profile, cwd = os.homedir(), onUpdate, onExit, onPermissionRequest, accessMode = 'unlocked' }) {
    this.profile = profile;
    this.cwd = cwd;
    this.onUpdate = onUpdate || (() => {});
    this.onExit = onExit || (() => {});
    this.onPermissionRequest = onPermissionRequest || (() => {});
    this.accessMode = ACCESS_MODES.includes(accessMode) ? accessMode : 'unlocked';
    this._nextId = 1;
    this._pending = new Map();
    this._stdoutBuf = '';
    this._ready = null;
    this._child = null;
    // Outstanding permission requests waiting on the user (mode='ask').
    // key: internal requestKey (string), value: { rpcId, params }
    this._pendingPermissions = new Map();
    this._nextPermKey = 1;
  }

  setAccessMode(mode) {
    if (!ACCESS_MODES.includes(mode)) return;
    this.accessMode = mode;
  }

  /**
   * Called by the main process when the user picks a choice for a pending
   * permission request that was surfaced in 'ask' mode. `optionId` may be
   * null/undefined to indicate cancellation (treated as a reject).
   */
  resolvePermission(requestKey, optionId) {
    const entry = this._pendingPermissions.get(requestKey);
    if (!entry) return false;
    this._pendingPermissions.delete(requestKey);
    const { rpcId, params } = entry;
    const opts = (params && params.options) || [];
    if (optionId) {
      const match = opts.find((o) => (o.optionId || o.name) === optionId);
      this._reply(rpcId, {
        outcome: {
          outcome: 'selected',
          optionId: match ? match.optionId || match.name : optionId,
        },
      });
    } else {
      // Explicit cancel from the user → tell Hermes the request was cancelled.
      this._reply(rpcId, { outcome: { outcome: 'cancelled' } });
    }
    return true;
  }

  /** Cancel any still-pending permission prompts (e.g. tile closing). */
  cancelPendingPermissions() {
    for (const [key, entry] of this._pendingPermissions) {
      try {
        this._reply(entry.rpcId, { outcome: { outcome: 'cancelled' } });
      } catch {}
      this._pendingPermissions.delete(key);
    }
  }

  start() {
    if (this._child) return this._ready;
    const profileEnv = loadProfileEnv(this.profile);
    const spawnEnv = { ...process.env, ...profileEnv, HERMES_ACCEPT_HOOKS: '1' };
    // Diagnostic marker: writes a small file per spawn so auth/env issues
    // are traceable even when logs are misrouted. Does NOT log the key
    // itself — only whether it's set and its length.
    const _k = spawnEnv.ANTHROPIC_API_KEY;
    const diagLine =
      `[circe:spawn:${this.profile}] HERMES_HOME=${spawnEnv.HERMES_HOME || '(unset)'} ` +
      `ANTHROPIC_API_KEY=${_k ? 'set:' + _k.length + 'chars' : '(UNSET)'} ` +
      `PATH_has_local_bin=${(spawnEnv.PATH || '').includes('.local/bin')}`;
    log.info(diagLine);
    // Drop a marker file so we can confirm the spawn happened even if logging is misrouted.
    try {
      fs.writeFileSync(
        path.join(os.homedir(), '.hermes', `circe-last-spawn-${this.profile}.txt`),
        new Date().toISOString() + '\n' + diagLine + '\n',
      );
    } catch (_) {}
    this._child = spawn(
      HERMES_BIN,
      ['-p', this.profile, 'acp', '--accept-hooks'],
      {
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this._child.stdout.on('data', (b) => this._onStdout(b.toString()));
    this._child.stderr.on('data', (b) => {
      process.stderr.write(`[acp:${this.profile}] ${b}`);
    });
    this._child.on('exit', (code) => {
      for (const [, p] of this._pending) {
        p.reject(new Error(`hermes acp exited (${code})`));
      }
      this._pending.clear();
      this.onExit(code);
    });

    this._ready = this._send('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: 'hermes-tiles', version: '0.1' },
    });
    return this._ready;
  }

  async newSession(opts = {}) {
    await this._ready;
    const disabled = process.env.CIRCE_NO_RETRY === '1';
    const backoffMs = opts.backoffMs || [500, 1500];
    const r = await retryable(
      () => this._send('session/new', { cwd: this.cwd, mcpServers: [] }),
      {
        attempts: 3,
        backoffMs,
        isRetryable: isRetryableAcpError,
        onAttempt: (n, err) => {
          if (typeof opts.onRetry === 'function') opts.onRetry(n, err);
          try {
            log.warn(`acp newSession retry [${this.profile}] attempt=${n} code=${err.code} msg=${err.message}`);
          } catch {}
        },
        disabled,
      },
    );
    return r.sessionId;
  }

  async loadSession(sessionId) {
    await this._ready;
    return this._send('session/load', {
      cwd: this.cwd,
      sessionId,
      mcpServers: [],
    });
  }

  async prompt(sessionId, text) {
    await this._ready;
    return this._send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  async cancelSession(sessionId) {
    try {
      await this._send('session/cancel', { sessionId });
    } catch {}
  }

  async closeSession(sessionId) {
    try {
      await this._send('session/close', { sessionId });
    } catch {}
  }

  stop() {
    this.cancelPendingPermissions();
    if (this._child) {
      this._child.kill();
      this._child = null;
    }
  }

  _reply(id, result) {
    const line = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
    if (this._child && this._child.stdin.writable) this._child.stdin.write(line);
  }

  _replyError(id, code, message) {
    const line =
      JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n';
    if (this._child && this._child.stdin.writable) this._child.stdin.write(line);
  }

  _handlePermissionRequest(rpcId, params) {
    const opts = (params && params.options) || [];
    const mode = this.accessMode;

    if (mode === 'unlocked') {
      const allow = opts.find(isAllowOption) || opts[0];
      this._reply(rpcId, {
        outcome: {
          outcome: 'selected',
          optionId: allow ? allow.optionId || allow.name : 'allow',
        },
      });
      return;
    }

    if (mode === 'locked') {
      // Prefer an explicit reject option if the agent offered one; else outcome:'cancelled'.
      const reject = opts.find(isRejectOption);
      if (reject) {
        this._reply(rpcId, {
          outcome: {
            outcome: 'selected',
            optionId: reject.optionId || reject.name,
          },
        });
      } else {
        this._reply(rpcId, { outcome: { outcome: 'cancelled' } });
      }
      // Still surface it to the renderer for visibility (as an already-resolved event),
      // so the user sees *why* the agent said it couldn't do the thing.
      try {
        this.onPermissionRequest({
          requestKey: null,
          resolved: 'locked',
          toolCall: (params && params.toolCall) || null,
          options: opts,
        });
      } catch {}
      return;
    }

    // mode === 'ask' → park the request, tell the renderer, wait for resolvePermission().
    const requestKey = `p${this._nextPermKey++}`;
    this._pendingPermissions.set(requestKey, { rpcId, params });
    try {
      this.onPermissionRequest({
        requestKey,
        resolved: null,
        toolCall: (params && params.toolCall) || null,
        options: opts,
      });
    } catch (err) {
      // If we couldn't hand off to the UI, don't leave Hermes hanging forever.
      this._pendingPermissions.delete(requestKey);
      this._reply(rpcId, { outcome: { outcome: 'cancelled' } });
    }
  }

  _handleServerRequest(msg) {
    const { id, method, params } = msg;
    if (method === 'session/request_permission') {
      this._handlePermissionRequest(id, params);
      return;
    }
    if (method === 'fs/read_text_file') {
      try {
        const content = fs.readFileSync(params.path, 'utf8');
        this._reply(id, { content });
      } catch (err) {
        this._replyError(id, -32603, err.message);
      }
      return;
    }
    if (method === 'fs/write_text_file') {
      try {
        fs.writeFileSync(params.path, params.content);
        this._reply(id, {});
      } catch (err) {
        this._replyError(id, -32603, err.message);
      }
      return;
    }
    this._replyError(id, -32601, `method not implemented: ${method}`);
  }

  _send(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this._child.stdin.write(line);
    });
  }

  _onStdout(chunk) {
    this._stdoutBuf += chunk;
    let idx;
    while ((idx = this._stdoutBuf.indexOf('\n')) >= 0) {
      const line = this._stdoutBuf.slice(0, idx).trim();
      this._stdoutBuf = this._stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const p = this._pending.get(msg.id);
        if (!p) continue;
        this._pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message || 'rpc error');
          err.code = msg.error.code;
          err.data = msg.error.data;
          log.error(`acp rpc error [${this.profile}]`, msg.error);
          p.reject(err);
        }
        else p.resolve(msg.result);
      } else if (msg.method === 'session/update' && msg.params) {
        try {
          this.onUpdate(msg.params);
        } catch {}
      } else if (msg.method && msg.id !== undefined) {
        this._handleServerRequest(msg);
      }
    }
  }
}

module.exports = { AcpClient, __loadProfileEnvForTest: loadProfileEnv };
