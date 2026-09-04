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

// Substring that marks the upstream Hermes bug where the stream-retry path
// rebuilds the Anthropic-wire client without threading api_key through, so
// the SDK throws TypeError at construction. See circe-dj docs and the
// pending Hermes bug report — pattern mirrors closed OpenAI-wire fix #44006.
// The exact string is the Anthropic SDK's own error text, distinctive
// enough that a substring match won't false-positive on normal log lines.
const HERMES_AUTH_REBUILD_PATTERN = 'Could not resolve authentication method';

// Rate-limit auto-restarts to avoid tight loops if the pattern is somehow
// misdiagnosed. Keep it forgiving (a real fleet member should never trip
// this three times in a session) but hard-capped.
const AUTO_RESTART_WINDOW_MS = 5 * 60 * 1000;
const AUTO_RESTART_MAX_IN_WINDOW = 3;
// Suppression window: multiple stderr lines from the same failure burst
// arrive within a fraction of a second. Ignore repeat matches inside this
// window so a single failure counts as one restart, not three.
const AUTO_RESTART_DEBOUNCE_MS = 2000;

// Classify an ACP option object. `kind` is the strongest signal (per ACP spec
// options carry allow_once / allow_always / reject_once / reject_always);
// fall back to name/optionId keyword matching for less strict servers.
const isAllowOption  = (o) =>
  (o?.kind?.startsWith('allow'))  || /allow|approve|yes|accept|permit/i.test(o?.name || o?.optionId || '');
const isRejectOption = (o) =>
  (o?.kind?.startsWith('reject')) || /reject|deny|no|cancel|decline|refuse/i.test(o?.name || o?.optionId || '');

class AcpClient {
  constructor({ profile, cwd = os.homedir(), onUpdate, onExit, onPermissionRequest, onAutoRestart, accessMode = 'unlocked' }) {
    this.profile = profile;
    this.cwd = cwd;
    this.onUpdate = onUpdate || (() => {});
    this.onExit = onExit || (() => {});
    this.onPermissionRequest = onPermissionRequest || (() => {});
    this.onAutoRestart = onAutoRestart || (() => {});
    this.accessMode = ACCESS_MODES.includes(accessMode) ? accessMode : 'unlocked';
    this._nextId = 1;
    this._pending = new Map();
    this._stdoutBuf = '';
    this._stderrBuf = '';
    this._ready = null;
    this._child = null;
    // Outstanding permission requests waiting on the user (mode='ask').
    // key: internal requestKey (string), value: { rpcId, params }
    this._pendingPermissions = new Map();
    this._nextPermKey = 1;
    // Auto-restart bookkeeping.
    this._autoRestartTimes = []; // wall-clock ms of prior triggers
    this._lastAutoRestartTriggerAt = 0;
    this._autoRestarting = false;
    // Promise that resolves when the current auto-restart finishes (or
    // rejects if it gives up). prompt() awaits this so a call that was
    // in-flight when the restart began gets absorbed instead of surfacing
    // an "acp auto-restart in progress" AcpError to the renderer.
    this._autoRestartPromise = null;
    // Set to true by stop() so we don't try to auto-restart a client the
    // window was closing anyway.
    this._stopped = false;
    // Track the last session id from newSession/loadSession so the renderer
    // can decide whether to resume after we auto-restart. Optional — the
    // renderer is authoritative, but exposing this simplifies its logic.
    this._lastSessionId = null;
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
      const s = b.toString();
      process.stderr.write(`[acp:${this.profile}] ${s}`);
      this._onStderr(s);
    });
    this._child.on('exit', (code) => {
      for (const [, p] of this._pending) {
        p.reject(new Error(`hermes acp exited (${code})`));
      }
      this._pending.clear();
      // If we're mid-auto-restart, swallow the exit — a fresh child is
      // about to spawn; firing onExit here would tear down the tile the
      // user is trying to keep. If the auto-restart itself fails, we surface
      // it via a distinct autoRestart('givingUp', ...) event instead.
      if (this._autoRestarting) return;
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
    this._lastSessionId = r.sessionId;
    return r.sessionId;
  }

  async loadSession(sessionId) {
    await this._ready;
    this._lastSessionId = sessionId;
    return this._send('session/load', {
      cwd: this.cwd,
      sessionId,
      mcpServers: [],
    });
  }

  async prompt(sessionId, text) {
    await this._ready;
    try {
      return await this._send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
    } catch (err) {
      // The user's in-flight prompt got caught by auto-restart. Wait for
      // the restart to settle and reissue against the same session id —
      // _attemptAutoRestart already called session/load, so the sessionId
      // is still live. Only retry once; a second consecutive restart
      // means something worse is happening and the caller should see it.
      if (!err || !err.autoRestartInProgress) throw err;
      const settled = await (this._autoRestartPromise || Promise.resolve({ ok: false }));
      if (!settled || !settled.ok) throw err;
      return this._send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
    }
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
    this._stopped = true;
    this.cancelPendingPermissions();
    if (this._child) {
      this._child.kill();
      this._child = null;
    }
  }

  // Scan stderr for the Hermes stream-retry auth-rebuild pattern. Buffer
  // partial lines so a match split across two chunks still fires. Rate-limit
  // triggers so a burst of identical stderr from one failure counts once.
  _onStderr(chunk) {
    this._stderrBuf += chunk;
    // Cap the buffer so a chatty child can't grow it unbounded; only the
    // tail matters for pattern detection.
    if (this._stderrBuf.length > 16 * 1024) {
      this._stderrBuf = this._stderrBuf.slice(-8 * 1024);
    }
    if (!this._stderrBuf.includes(HERMES_AUTH_REBUILD_PATTERN)) return;
    // Consume up through the last newline so we don't retrigger on the
    // same buffered text next chunk.
    const lastNl = this._stderrBuf.lastIndexOf('\n');
    if (lastNl >= 0) this._stderrBuf = this._stderrBuf.slice(lastNl + 1);
    const now = Date.now();
    if (now - this._lastAutoRestartTriggerAt < AUTO_RESTART_DEBOUNCE_MS) return;
    this._lastAutoRestartTriggerAt = now;
    // Fire and forget; the coroutine handles its own errors via events.
    this._attemptAutoRestart('hermes-auth-rebuild').catch((err) => {
      try { log.error(`acp auto-restart crashed [${this.profile}]`, err); } catch {}
    });
  }

  // Kill the child, drop pending RPC promises, spawn a fresh one, and
  // re-init the protocol. Rate-limited. Emits onAutoRestart('detected'),
  // then either ('restarted', {sessionId}) on success or ('givingUp', {reason}).
  async _attemptAutoRestart(reason) {
    if (this._stopped) return;
    if (this._autoRestarting) return;
    // Rate limit: prune expired entries, then bail if we've hit the cap.
    const now = Date.now();
    this._autoRestartTimes = this._autoRestartTimes.filter((t) => now - t < AUTO_RESTART_WINDOW_MS);
    if (this._autoRestartTimes.length >= AUTO_RESTART_MAX_IN_WINDOW) {
      try {
        this.onAutoRestart({ phase: 'givingUp', reason: 'rate-limit', trigger: reason });
      } catch {}
      log.warn(
        `acp auto-restart rate-limited [${this.profile}] ` +
        `(${this._autoRestartTimes.length} in ${AUTO_RESTART_WINDOW_MS / 1000}s)`,
      );
      return;
    }
    this._autoRestartTimes.push(now);
    this._autoRestarting = true;
    // Publish a settle-tracking promise BEFORE we reject in-flight pending
    // calls. prompt() (and any other caller that survives a restart) will
    // await this promise to reissue its RPC against the resumed session
    // instead of surfacing an AcpError to the renderer.
    let settleRestart;
    this._autoRestartPromise = new Promise((res) => { settleRestart = res; });
    const sessionId = this._lastSessionId;
    try {
      this.onAutoRestart({ phase: 'detected', reason, sessionId });
    } catch {}
    log.warn(`acp auto-restart begin [${this.profile}] reason=${reason} sessionId=${sessionId || '(none)'}`);
    try {
      // Reject anything still in flight so awaiters unblock — the child is
      // about to die and their responses will never come. Tag the error
      // so prompt() (and any other caller that wants to survive a restart)
      // can distinguish this from a real failure and retry after the
      // restart settles.
      for (const [, p] of this._pending) {
        const err = new Error(`acp auto-restart in progress (${reason})`);
        err.autoRestartInProgress = true;
        try { p.reject(err); } catch {}
      }
      this._pending.clear();
      this.cancelPendingPermissions();
      // Reset transport state.
      this._stdoutBuf = '';
      this._stderrBuf = '';
      this._ready = null;
      // Detach ALL listeners on the old child before killing it. Its
      // 'exit' event is emitted asynchronously and would otherwise fire
      // AFTER start() spawns the new child, walking the shared _pending
      // map and rejecting the new child's in-flight 'initialize' as
      // "hermes acp exited (null)". stdout/stderr on a dying pipe could
      // likewise leak into the fresh transport buffers.
      if (this._child) {
        const dying = this._child;
        try { dying.removeAllListeners(); } catch {}
        try { dying.stdout && dying.stdout.removeAllListeners(); } catch {}
        try { dying.stderr && dying.stderr.removeAllListeners(); } catch {}
        try { dying.kill(); } catch {}
        this._child = null;
      }
      try {
        this.onAutoRestart({ phase: 'restarting', reason, sessionId });
      } catch {}
      // Fresh spawn + protocol init. start() sets this._ready.
      this.start();
      await this._ready;
      // If the tile had a live session, tell Hermes to resume it so the
      // renderer's history and next prompt continue to work.
      if (sessionId) {
        try {
          await this._send('session/load', {
            cwd: this.cwd,
            sessionId,
            mcpServers: [],
          });
        } catch (loadErr) {
          log.warn(`acp auto-restart session/load failed [${this.profile}] ${loadErr.message}`);
          // Fall through — the renderer can decide to newSession if load failed.
        }
      }
      log.info(`acp auto-restart ok [${this.profile}] sessionId=${sessionId || '(none)'}`);
      try {
        this.onAutoRestart({ phase: 'restarted', reason, sessionId });
      } catch {}
      settleRestart({ ok: true, sessionId });
    } catch (err) {
      log.error(`acp auto-restart failed [${this.profile}]`, err);
      try {
        this.onAutoRestart({ phase: 'givingUp', reason: err.message || String(err), trigger: reason });
      } catch {}
      settleRestart({ ok: false, error: err });
    } finally {
      this._autoRestarting = false;
      this._autoRestartPromise = null;
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
