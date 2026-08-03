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

async function install(_onProgress) {
  return {
    ok: false,
    error:
      'Automated install not yet wired — install Hermes manually and restart Circe.',
  };
}

module.exports = { detect, install };
