const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = child_process.spawn(cmd, args, { env: process.env });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

async function detectZscalerRoot(exec = defaultExec) {
  try {
    const r = await exec('security', [
      'find-certificate',
      '-a',
      '-c',
      'Zscaler',
      '-p',
      '/Library/Keychains/System.keychain',
    ]);
    const pem = (r && r.stdout) || '';
    if (pem.includes('BEGIN CERTIFICATE')) return { present: true, pem };
    return { present: false };
  } catch {
    return { present: false };
  }
}

async function resolveCertifiBundlePath(exec = defaultExec) {
  try {
    const r = await exec('python3', [
      '-c',
      'import certifi; print(certifi.where())',
    ]);
    const p = ((r && r.stdout) || '').trim();
    return p || null;
  } catch {
    return null;
  }
}

async function setupCaTrust(opts) {
  const {
    userDataDir,
    log,
    exec = defaultExec,
    readFile = (p) => fs.readFileSync(p, 'utf8'),
  } = opts;
  const notes = [];
  try {
    const det = await detectZscalerRoot(exec);
    if (!det.present) {
      log.info('caTrust: no Zscaler root found; skipping');
      return { ok: true, note: 'no-zscaler' };
    }
    fs.mkdirSync(userDataDir, { recursive: true });
    const zPath = path.join(userDataDir, 'zscaler-root.pem');
    fs.writeFileSync(zPath, det.pem);
    notes.push(`wrote ${zPath}`);

    const certifiPath = await resolveCertifiBundlePath(exec);
    const bPath = path.join(userDataDir, 'python-ca-bundle.pem');
    let certifiContent = null;
    if (certifiPath) {
      try {
        certifiContent = readFile(certifiPath);
      } catch {
        // certifi file not readable, fall back to zscaler-only
      }
    }
    if (certifiContent) {
      fs.writeFileSync(bPath, certifiContent + det.pem);
      notes.push(`wrote ${bPath} (certifi + zscaler)`);
    } else {
      fs.writeFileSync(bPath, det.pem);
      notes.push(`wrote ${bPath} (zscaler only — certifi unresolved)`);
      log.warn('caTrust: certifi.where() unresolvable; SSL_CERT_FILE points to zscaler-only bundle');
    }

    if (process.env.NODE_EXTRA_CA_CERTS) {
      log.info(`caTrust: NODE_EXTRA_CA_CERTS already set (${process.env.NODE_EXTRA_CA_CERTS}); leaving alone`);
    } else {
      process.env.NODE_EXTRA_CA_CERTS = zPath;
      notes.push(`set NODE_EXTRA_CA_CERTS=${zPath}`);
    }
    if (process.env.SSL_CERT_FILE) {
      log.info(`caTrust: SSL_CERT_FILE already set (${process.env.SSL_CERT_FILE}); leaving alone`);
    } else {
      process.env.SSL_CERT_FILE = bPath;
      notes.push(`set SSL_CERT_FILE=${bPath}`);
    }
    log.info(`caTrust: ${notes.join('; ')}`);
    return { ok: true };
  } catch (err) {
    log.error('caTrust setup failed:', err.message);
    return { ok: false, note: err.message };
  }
}

module.exports = { setupCaTrust, detectZscalerRoot, resolveCertifiBundlePath };
