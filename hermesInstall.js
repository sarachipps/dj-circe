const child_process = require('node:child_process');

function runVersion() {
  return new Promise((resolve) => {
    let child;
    try {
      child = child_process.spawn('hermes', ['--version']);
    } catch (err) {
      resolve({ present: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', () => resolve({ present: false }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ present: false });
        return;
      }
      const m = stdout.match(/(\d+\.\d+\.\d+)/);
      resolve({
        present: true,
        version: m ? m[1] : stdout.trim() || undefined,
      });
    });
  });
}

async function detect() {
  return runVersion();
}

async function install(onProgress) {
  return new Promise((resolve) => {
    const cmd =
      'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash';
    let child;
    try {
      child = child_process.spawn('bash', ['-lc', cmd], {
        env: process.env,
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    const emit = (buf) => {
      if (typeof onProgress !== 'function') return;
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.length) onProgress(line);
      }
    };

    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `install exited ${code}` });
    });
  });
}

module.exports = { detect, install };
