const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const caTrust = require('../caTrust');

function mkTmpUD(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circe-cat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_PEM = '-----BEGIN CERTIFICATE-----\nZFake\n-----END CERTIFICATE-----\n';
const FAKE_CERTIFI = '-----BEGIN CERTIFICATE-----\nCertifi1\n-----END CERTIFICATE-----\n';

function fakeExec(map) {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (!(key in map)) throw new Error(`unexpected exec: ${key}`);
    const v = map[key];
    if (v instanceof Error) throw v;
    return v;
  };
}

test('detectZscalerRoot: returns present:true with PEM when security has certs', async () => {
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: FAKE_PEM, code: 0 },
  });
  const r = await caTrust.detectZscalerRoot(exec);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.pem, FAKE_PEM);
});

test('detectZscalerRoot: returns present:false when security returns empty', async () => {
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: '', code: 0 },
  });
  const r = await caTrust.detectZscalerRoot(exec);
  assert.strictEqual(r.present, false);
});

test('detectZscalerRoot: returns present:false when security fails', async () => {
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      new Error('command not found'),
  });
  const r = await caTrust.detectZscalerRoot(exec);
  assert.strictEqual(r.present, false);
});

test('setupCaTrust: writes both bundle files and sets env when Zscaler present', async (t) => {
  const originalNode = process.env.NODE_EXTRA_CA_CERTS;
  const originalSsl = process.env.SSL_CERT_FILE;
  delete process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.SSL_CERT_FILE;
  t.after(() => {
    if (originalNode === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalNode;
    if (originalSsl === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = originalSsl;
  });
  const ud = mkTmpUD(t);
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: FAKE_PEM, code: 0 },
    'python3 -c import certifi; print(certifi.where())': { stdout: '/fake/certifi.pem\n', code: 0 },
  });
  const readFake = (p) => (p === '/fake/certifi.pem' ? FAKE_CERTIFI : fs.readFileSync(p, 'utf8'));
  const result = await caTrust.setupCaTrust({
    userDataDir: ud,
    hermesBin: '/fake/hermes',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exec,
    readFile: readFake,
  });
  assert.strictEqual(result.ok, true);
  const zPath = path.join(ud, 'zscaler-root.pem');
  const bPath = path.join(ud, 'python-ca-bundle.pem');
  assert.strictEqual(fs.readFileSync(zPath, 'utf8'), FAKE_PEM);
  assert.strictEqual(fs.readFileSync(bPath, 'utf8'), FAKE_CERTIFI + FAKE_PEM);
  assert.strictEqual(process.env.NODE_EXTRA_CA_CERTS, zPath);
  assert.strictEqual(process.env.SSL_CERT_FILE, bPath);
});

test('setupCaTrust: falls back to zscaler-only bundle when certifi unresolvable', async (t) => {
  const originalNode = process.env.NODE_EXTRA_CA_CERTS;
  const originalSsl = process.env.SSL_CERT_FILE;
  delete process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.SSL_CERT_FILE;
  t.after(() => {
    if (originalNode === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalNode;
    if (originalSsl === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = originalSsl;
  });
  const ud = mkTmpUD(t);
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: FAKE_PEM, code: 0 },
    'python3 -c import certifi; print(certifi.where())': new Error('no certifi'),
  });
  const result = await caTrust.setupCaTrust({
    userDataDir: ud,
    hermesBin: '/fake/hermes',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exec,
  });
  assert.strictEqual(result.ok, true);
  const bPath = path.join(ud, 'python-ca-bundle.pem');
  assert.strictEqual(fs.readFileSync(bPath, 'utf8'), FAKE_PEM);
  assert.strictEqual(process.env.SSL_CERT_FILE, bPath);
});

test('setupCaTrust: skips silently when no Zscaler root', async (t) => {
  const originalNode = process.env.NODE_EXTRA_CA_CERTS;
  const originalSsl = process.env.SSL_CERT_FILE;
  delete process.env.NODE_EXTRA_CA_CERTS;
  delete process.env.SSL_CERT_FILE;
  t.after(() => {
    if (originalNode === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalNode;
    if (originalSsl === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = originalSsl;
  });
  const ud = mkTmpUD(t);
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: '', code: 0 },
  });
  const result = await caTrust.setupCaTrust({
    userDataDir: ud,
    hermesBin: '/fake/hermes',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exec,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(process.env.NODE_EXTRA_CA_CERTS, undefined);
  assert.strictEqual(process.env.SSL_CERT_FILE, undefined);
});

test('setupCaTrust: does not override user-set NODE_EXTRA_CA_CERTS', async (t) => {
  const originalNode = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = '/user/preferred.pem';
  t.after(() => {
    if (originalNode === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalNode;
  });
  const ud = mkTmpUD(t);
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: FAKE_PEM, code: 0 },
    'python3 -c import certifi; print(certifi.where())': { stdout: '/fake/certifi.pem\n', code: 0 },
  });
  const readFake = (p) => (p === '/fake/certifi.pem' ? FAKE_CERTIFI : fs.readFileSync(p, 'utf8'));
  await caTrust.setupCaTrust({
    userDataDir: ud,
    hermesBin: '/fake/hermes',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exec,
    readFile: readFake,
  });
  assert.strictEqual(process.env.NODE_EXTRA_CA_CERTS, '/user/preferred.pem');
});

test('setupCaTrust: does not override user-set SSL_CERT_FILE', async (t) => {
  const originalSsl = process.env.SSL_CERT_FILE;
  const originalNode = process.env.NODE_EXTRA_CA_CERTS;
  process.env.SSL_CERT_FILE = '/user/preferred-bundle.pem';
  delete process.env.NODE_EXTRA_CA_CERTS;
  t.after(() => {
    if (originalSsl === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = originalSsl;
    if (originalNode === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = originalNode;
  });
  const ud = mkTmpUD(t);
  const exec = fakeExec({
    'security find-certificate -a -c Zscaler -p /Library/Keychains/System.keychain':
      { stdout: FAKE_PEM, code: 0 },
    'python3 -c import certifi; print(certifi.where())': { stdout: '/fake/certifi.pem\n', code: 0 },
  });
  const readFake = (p) => (p === '/fake/certifi.pem' ? FAKE_CERTIFI : fs.readFileSync(p, 'utf8'));
  await caTrust.setupCaTrust({
    userDataDir: ud,
    hermesBin: '/fake/hermes',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exec,
    readFile: readFake,
  });
  assert.strictEqual(process.env.SSL_CERT_FILE, '/user/preferred-bundle.pem');
});
