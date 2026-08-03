const child_process = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const HERMES_BIN = path.join(os.homedir(), '.local', 'bin', 'hermes');

function runVersion() {
  return new Promise((resolve) => {
    let child;
    try {
      child = child_process.spawn(HERMES_BIN, ['--version']);
    } catch (err) {
      // spawn threw synchronously (ENOENT on the binary path);
      // treat exactly like the async error path below.
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
        path: HERMES_BIN,
      });
    });
  });
}

async function detect() {
  return runVersion();
}

async function install(_onProgress) {
  // v1 placeholder — see spec §10. Automated install is a future task;
  // for now we tell the user to install Hermes manually and restart.
  return {
    ok: false,
    error:
      'Automated install not yet wired — install Hermes manually and restart Circe.',
  };
}

module.exports = { detect, install };
