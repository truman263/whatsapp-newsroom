import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import * as zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const COMPOSE = path.join(HERE, 'compose.yaml');
const ENV_FILE = path.join(HERE, '.env.runtime');
const RESULTS_FILE = path.join(HERE, 'runtime-results.json');
const BRIDGE_DIR = path.join(ROOT, 'wordpress', 'newsroom-bridge');

process.env.COMPOSE_PROJECT_NAME = 'newsroom-media-authority-proof';
process.env.DOCKER_COMPOSE_PROJECT_NAME = 'newsroom-media-authority-proof';

const FROZEN_HASHES = {
  'includes/class-newsroom-bridge-db.php': '1362CB101031088B78E27D54B78EDFAC6488D9F979979A3786916839811A20FA',
  'includes/class-newsroom-bridge-reconciliation.php': '6A7CE8AEC4AB3040804C217F00341275EAD25EA78570FC4CC93F47CDE03A373A',
  'includes/class-newsroom-bridge-rest.php': '965608C6063540985D23F9A83A679C49EEE1543238C595A850100755F9CF609A',
};

const MEDIA_KAT = {
  keyId: 'media-local-v1',
  timestamp: '1750000000',
  route: '/newsroom-media/v1/media',
  mediaKey: '01234567-89ab-47cd-8e01-23456789abcd',
  filename: 'hero.png',
  mime: 'image/png',
  secretB64u: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
  bodySha256: '78ced3511f8d2005e2193fc28699dd0e80282fa5ab11a5e7c0161e2bb55396f2',
  filenameSha256: '290617ed3bab229d65d4f128ba0956bc68fd773814a6537d376fea89c4743eb6',
  postSignature: '3ecd3243c3c7bd67d002c9f6f31b950ddd326a0f7fe05c09a8f96c79857283cd',
  getSignature: 'd8f7a00fd0a1121e25dad834884e8bb90f15aae170e301d079573d19b6299238',
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MEDIA_KEY_ID = 'media-local-v1';
const DRAFT_KEY_ID = 'draft-local-v1';

const KNOWN_SECRETS = [];
const EVIDENCE = [];

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function hmacSha256(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}
function nowTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}
function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}
function decodeSecret(b64u) {
  return Buffer.from(b64u.replace(/-/g, '+').replace(/_/g, '/') + '=', 'base64');
}

let crc32Table = null;
function crc32(buf) {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      crc32Table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function makePng(width, height, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const idx = row + 1 + x * 3;
      raw[idx] = (seed + x * 3 + y) & 0xff;
      raw[idx + 1] = (seed * 2 + x + y) & 0xff;
      raw[idx + 2] = (seed * 3 + x * 5 + y * 7) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([PNG_MAGIC, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function makeBigPng(minBytes) {
  let width = 96;
  while (width < 4096) {
    const height = 96;
    const rawLen = height * (1 + width * 3);
    const raw = Buffer.alloc(rawLen);
    raw.set(crypto.randomBytes(rawLen));
    const idat = zlib.deflateSync(raw);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const png = Buffer.concat([PNG_MAGIC, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
    if (png.length >= minBytes) return png;
    width += 48;
  }
  throw new Error('makeBigPng failed');
}
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function runSync(file, args, opts = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const REPO_SCAN_SKIP = new Set(['.git', 'node_modules', '.env.runtime', 'runtime-results.json']);
function findRepoFiles(root) {
  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (REPO_SCAN_SKIP.has(e.name)) continue;
      const p = dir + '/' + e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}
function repoFileTextContains(file, needle) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (st.size > 2 * 1024 * 1024) return false;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size);
    const read = fs.readSync(fd, buf, 0, st.size, 0);
    if (read < st.size) return false;
    if (buf.includes(0)) return false;
    return buf.toString('utf8').includes(needle);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
function compose(args, opts = {}) {
  return runSync('docker', ['compose', '--env-file', ENV_FILE, '-f', COMPOSE, ...args], opts);
}
function composeExec(args) {
  return compose(['exec', '-T', 'cli', ...args]);
}
function cli(args) {
  return composeExec(['wp', ...args]);
}
function wpEval(code) {
  const res = cli(['eval', code]);
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr };
}
function wpdb(sql) {
  const res = cli(['db', 'query', sql, '--skip-column-names']);
  if (res.status !== 0) throw new Error('db query failed: ' + sql + '\n' + res.stderr);
  return res.stdout;
}
function queryLines(sql) {
  return wpdb(sql).split(/\r?\n/).filter((line) => line !== '');
}
function queryScalar(sql) {
  const lines = queryLines(sql);
  return lines.length ? lines[0].trim() : '';
}

function allocatePort(startAt) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => (p >= startAt + 64 ? reject(new Error('no free port')) : tryPort(p + 1)));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(p)));
    };
    tryPort(startAt);
  });
}
function waitForHttp(url, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) return resolve(res.statusCode);
        res.on('end', () => (Date.now() > deadline ? reject(new Error('timeout waiting for ' + url)) : setTimeout(attempt, 1500)));
      });
      req.on('error', () => (Date.now() > deadline ? reject(new Error('timeout waiting for ' + url)) : setTimeout(attempt, 1500)));
    };
    attempt();
  });
}
function httpJson(method, url, { headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', (err) => resolve({ status: 0, body: Buffer.alloc(0), error: String(err && err.message ? err.message : err) }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: Buffer.alloc(0), error: 'timeout' }); });
    req.on('error', (err) => resolve({ status: 0, body: Buffer.alloc(0), error: String(err && err.message ? err.message : err) }));
    if (body !== null) req.write(body);
    req.end();
  });
}
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function errCode(body) {
  const j = safeJson(Buffer.isBuffer(body) ? body.toString() : body);
  return j && j.code ? j.code : '';
}

function evidence(key, name, passed, details = '') {
  const clean = String(details);
  const idx = EVIDENCE.findIndex((e) => e.key === key);
  const entry = { key, name, passed: !!passed, details: clean };
  if (idx >= 0) EVIDENCE[idx] = entry;
  else EVIDENCE.push(entry);
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${key}: ${name}`);
  if (!passed && clean) console.log(`      ${clean.slice(0, 700)}`);
}

function mediaCanonical({ keyId, method, route, timestamp, mediaKey, filename = null, mime = null, body }) {
  const upper = String(method).toUpperCase();
  const filenameHash = upper === 'GET' ? '-' : sha256Hex(filename ?? '');
  const mimeValue = upper === 'GET' ? '-' : (mime ?? '');
  const bodyHash = sha256Hex(body && body.length ? body : Buffer.alloc(0));
  return ['newsroom-media-hmac-v1', keyId, upper, route, timestamp, mediaKey, filenameHash, mimeValue, bodyHash].join('\n');
}
function mediaHeaders({ keyId, secret, method, route, timestamp, mediaKey, filename = null, mime = null, body }) {
  const headers = {
    'X-Newsroom-Media-Auth-Version': '1',
    'X-Newsroom-Media-Key-Id': keyId,
    'X-Newsroom-Media-Timestamp': timestamp,
    'X-Newsroom-Media-Signature': hmacSha256(secret, mediaCanonical({ keyId, method, route, timestamp, mediaKey, filename, mime, body })),
  };
  if (String(method).toUpperCase() === 'POST') {
    headers['X-Newsroom-Media-Key'] = mediaKey;
    headers['X-Newsroom-Media-Filename'] = filename;
    headers['X-Newsroom-Media-Mime'] = mime;
    headers['Content-Type'] = 'application/octet-stream';
  }
  return headers;
}
function draftHeaders({ keyId, secret, method, route, timestamp, body }) {
  const headers = {
    'X-Newsroom-Auth-Version': '1',
    'X-Newsroom-Key-Id': keyId,
    'X-Newsroom-Timestamp': timestamp,
    'X-Newsroom-Signature': hmacSha256(secret, draftCanonical({ keyId, method, route, timestamp, body })),
  };
  if (String(method).toUpperCase() === 'POST') headers['Content-Type'] = 'application/json';
  return headers;
}
function draftCanonical({ keyId, method, route, timestamp, body }) {
  return ['newsroom-hmac-v1', keyId, String(method).toUpperCase(), route, timestamp, sha256Hex(body && body.length ? body : Buffer.alloc(0))].join('\n');
}
const mediaRouteGet = (mediaKey) => `/newsroom-media/v1/media/${mediaKey}`;

class MediaHmacError extends Error {
  constructor(code, status, info) {
    super(`MediaHmacError(${code}, ${status})`);
    this.code = code;
    this.status = status;
    this.info = info;
  }
}
class FetchTransport {
  constructor(timeoutMs = 8000) {
    this.timeoutMs = timeoutMs;
  }
  async send({ method, url, headers, body, timeoutMs }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || this.timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal, redirect: 'manual' });
      const text = await res.text();
      return { status: res.status, text };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('net:timeout');
      throw new Error('net:' + ((err.cause && err.cause.code) || err.message));
    } finally {
      clearTimeout(timer);
    }
  }
}

function classifyPost(status, text) {
  const json = safeJson(text);
  if (status === 0) return { kind: 'uncertain', json: null };
  if (status === 201 && json && typeof json === 'object') return { kind: 'created', json };
  if (status === 200 && json && json.status === 'attachment') return { kind: 'replayed', json };
  if (status === 200 && json && json.status === 'reserved') return { kind: 'retriable', json };
  if ((status === 201 || status === 200) && !json) return { kind: 'uncertain', json: null };
  if (status === 401) return { kind: 'auth', json };
  if (status === 409) return { kind: 'conflict', json };
  if (status === 404) return { kind: 'notfound', json };
  if (status === 503) return { kind: 'retriable', json };
  if (status >= 400 && status < 500) return { kind: 'contract', json };
  if (status >= 500) return { kind: 'uncertain', json };
  return { kind: 'unexpected', json };
}
function classifyGet(status, text) {
  const json = safeJson(text);
  if (status === 0) return { kind: 'unavailable', json: null };
  if (status === 200 && json && json.status === 'attachment') return { kind: 'attachment', json };
  if (status === 200 && json && json.status === 'reserved') return { kind: 'reserved', json };
  if (status === 404) return { kind: 'notfound', json };
  if (status === 401) return { kind: 'auth', json };
  if (status >= 400 && status < 500) return { kind: 'fail', json };
  return { kind: 'unavailable', json };
}

async function createMedia({ baseUrl, keyId, secret, mediaKey, filename, mime, body, transport, attemptLimit = 5, getAttempts = 3 }) {
  const route = '/newsroom-media/v1/media';
  const url = baseUrl + '/wp-json' + route;
  const tr = transport || new FetchTransport();

  const postOnce = (ts) => tr.send({ method: 'POST', url, headers: mediaHeaders({ keyId, secret, method: 'POST', route, timestamp: ts, mediaKey, filename, mime, body }), body });
  const getOnce = (ts) => {
    const groute = mediaRouteGet(mediaKey);
    return tr.send({ method: 'GET', url: baseUrl + '/wp-json' + groute, headers: mediaHeaders({ keyId, secret, method: 'GET', route: groute, timestamp: ts, mediaKey, body: Buffer.alloc(0) }) });
  };

  async function reconcile() {
    for (let i = 0; i < getAttempts; i++) {
      const res = await getOnce(nowTimestamp());
      const cls = classifyGet(res.status, res.text);
      if (cls.kind === 'attachment') return { kind: 'RECOVERED', httpStatus: res.status, json: cls.json };
      if (cls.kind === 'reserved') { await sleep(120); continue; }
      if (cls.kind === 'notfound') {
        const retry = await postOnce(nowTimestamp());
        const r2 = classifyPost(retry.status, retry.text);
        if (r2.kind === 'created' || r2.kind === 'replayed') return { kind: 'RECOVERED', httpStatus: retry.status, json: r2.json };
        if (r2.kind === 'conflict') throw new MediaHmacError('CONFLICT', retry.status, r2.json);
        if (r2.kind === 'auth') throw new MediaHmacError('AUTHENTICATION_FAILURE', retry.status, r2.json);
        if (r2.kind === 'contract') throw new MediaHmacError('CONTRACT_FAILURE', retry.status, r2.json);
        throw new MediaHmacError('UNCERTAIN_OUTCOME', retry.status, r2.json);
      }
      if (cls.kind === 'auth') throw new MediaHmacError('AUTHENTICATION_FAILURE', res.status, cls.json);
      if (cls.kind === 'fail') throw new MediaHmacError('CONTRACT_FAILURE', res.status, cls.json);
      await sleep(120);
    }
    throw new MediaHmacError('UNCERTAIN_OUTCOME', 0, { attempts: getAttempts });
  }

  let lastRes = null;
  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    let res;
    try {
      res = await postOnce(nowTimestamp());
    } catch {
      return reconcile();
    }
    lastRes = res;
    const cls = classifyPost(res.status, res.text);
    if (cls.kind === 'created') return { kind: 'CREATED', httpStatus: res.status, json: cls.json };
    if (cls.kind === 'replayed') return { kind: 'REPLAYED', httpStatus: res.status, json: cls.json };
    if (cls.kind === 'retriable') { await sleep(180); continue; }
    if (cls.kind === 'uncertain') return reconcile();
    if (cls.kind === 'conflict') throw new MediaHmacError('CONFLICT', res.status, cls.json);
    if (cls.kind === 'auth') throw new MediaHmacError('AUTHENTICATION_FAILURE', res.status, cls.json);
    if (cls.kind === 'contract') throw new MediaHmacError('CONTRACT_FAILURE', res.status, cls.json);
    if (cls.kind === 'notfound') throw new MediaHmacError('NOT_FOUND', res.status, cls.json);
    throw new MediaHmacError('UNEXPECTED_RESPONSE', res.status, cls.json);
  }
  throw new MediaHmacError('WORDPRESS_UNAVAILABLE', lastRes ? lastRes.status : 503, null);
}

async function getMedia({ baseUrl, keyId, secret, mediaKey, transport }) {
  const groute = mediaRouteGet(mediaKey);
  const tr = transport || new FetchTransport();
  const headers = mediaHeaders({ keyId, secret, method: 'GET', route: groute, timestamp: nowTimestamp(), mediaKey, body: Buffer.alloc(0) });
  const res = await tr.send({ method: 'GET', url: baseUrl + '/wp-json' + groute, headers });
  const cls = classifyGet(res.status, res.text);
  return { httpStatus: res.status, kind: cls.kind, json: cls.json };
}

function startProxy(targetUrl, decide) {
  const target = new URL(targetUrl);
  const counts = { POST: 0, GET: 0 };
  const requestOrder = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => res.destroy());
    req.on('end', () => {
      const method = String(req.method || 'GET').toUpperCase();
      counts[method] = (counts[method] || 0) + 1;
      requestOrder.push(method);
      const body = Buffer.concat(chunks);
      const ctx = {
        method,
        url: req.url || '/',
        headers: { ...req.headers },
        body,
        target,
        forward() {
          return new Promise((resolve, reject) => {
            const hopByHop = ['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host'];
            const headers = {};
            for (const [k, v] of Object.entries(ctx.headers)) {
              if (!hopByHop.includes(k) && typeof v === 'string') headers[k] = v;
            }
            const upstream = http.request(
              { hostname: target.hostname, port: target.port, path: ctx.url, method: ctx.method, headers },
              (up) => {
                const upChunks = [];
                up.on('data', (c) => upChunks.push(c));
                up.on('end', () => resolve({ status: up.statusCode, headers: up.headers, body: Buffer.concat(upChunks) }));
              }
            );
            upstream.on('error', reject);
            if (ctx.body && ctx.body.length) upstream.write(ctx.body);
            upstream.end();
          });
        },
      };
      Promise.resolve()
        .then(() => decide(ctx))
        .then((action) => {
          if (!action) { res.writeHead(502, { 'content-type': 'text/plain' }); return res.end('proxy no action'); }
          if (action.type === 'reply') {
            const b = Buffer.isBuffer(action.body) ? action.body : Buffer.from(String(action.body ?? ''), 'utf8');
            res.writeHead(action.status || 200, action.headers || { 'content-type': 'text/plain' });
            return res.end(b);
          }
          if (action.type === 'destroy' || action.type === 'drop') return res.socket && res.socket.destroy();
          if (action.type === 'forward') return ctx.forward().then(
            (up) => { res.writeHead(up.status, up.headers); res.end(up.body); },
            () => res.destroy()
          );
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('proxy error');
        })
        .catch(() => res.destroy());
    });
  });
  server.on('error', () => {});
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        counts,
        requestOrder,
        close() { return new Promise((r) => server.close(() => r())); },
      });
    });
    server.on('error', reject);
  });
}

function sha256FileAbs(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex').toUpperCase();
}
function frozenHashBad() {
  const bad = [];
  for (const [rel, expected] of Object.entries(FROZEN_HASHES)) {
    let actual = null;
    try {
      actual = sha256FileAbs(path.join(BRIDGE_DIR, rel));
    } catch {
      actual = null;
    }
    if (actual !== expected) bad.push(`${rel}:${actual}`);
  }
  return bad;
}

function assertDocker() {
  const info = runSync('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (info.status !== 0) throw new Error('docker daemon unavailable: ' + info.stderr.slice(0, 300));
}

function writeRuntimeEnv({ port, mediaSecretB64u, draftSecretB64u }) {
  const pass = () => crypto.randomBytes(24).toString('hex');
  const secrets = {
    dbPassword: pass(),
    dbRootPassword: pass(),
    adminPassword: pass(),
    draftUserPassword: pass(),
    mediaUserPassword: pass(),
    authorPassword: pass(),
  };
  const draftRing = JSON.stringify([{ id: DRAFT_KEY_ID, secret: draftSecretB64u }]);
  const mediaRing = JSON.stringify([{ id: MEDIA_KEY_ID, secret: mediaSecretB64u }]);
  const lines = [
    `RUNTIME_DB_PASSWORD=${secrets.dbPassword}`,
    `RUNTIME_DB_ROOT_PASSWORD=${secrets.dbRootPassword}`,
    `NEWSROOM_TEST_PORT=${port}`,
    `NEWSROOM_BRIDGE_USER_ID=2`,
    `NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED=1`,
    `NEWSROOM_BRIDGE_HMAC_ENABLED=1`,
    `NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED=1`,
    `NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON=${draftRing}`,
    `TEST_MEDIA_USER_ID=3`,
    `TEST_MEDIA_HMAC_ENABLED=1`,
    `TEST_MEDIA_SECURITY_LOGGING_ENABLED=1`,
    `TEST_MEDIA_SERVICE_LOCKDOWN_ENABLED=1`,
    `TEST_MEDIA_HMAC_KEYS_JSON=${mediaRing}`,
    `TEST_MEDIA_MAX_BYTES=500000`,
  ];
  fs.mkdirSync(HERE, { recursive: true });
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
  return secrets;
}

async function provision(ctx) {
  let pull = compose(['pull']);
  if (pull.status !== 0) throw new Error('compose pull failed: ' + pull.stderr.slice(0, 500));
  let up = compose(['up', '-d']);
  if (up.status !== 0) throw new Error('compose up failed: ' + up.stderr.slice(0, 500));

  await waitForHttp(ctx.baseUrl);

  const inst = cli(['core', 'install', `--url=${ctx.baseUrl}`, '--title=Media Authority Proof', '--admin_user=runtime_admin', `--admin_password=${ctx.secrets.adminPassword}`, '--admin_email=admin@example.invalid', '--skip-email']);
  if (inst.status !== 0) throw new Error('core install failed: ' + inst.stderr.slice(0, 500));

  const rewrite = cli(['rewrite', 'structure', '/%postname%/', '--hard']);
  if (rewrite.status !== 0) throw new Error('rewrite failed: ' + rewrite.stderr.slice(0, 500));

  const catRes = cli(['term', 'create', 'category', 'Proof Category', '--porcelain']);
  const categoryId = Number(catRes.stdout.trim());
  if (!Number.isInteger(categoryId) || categoryId <= 0) throw new Error('category creation failed: ' + catRes.stderr);
  ctx.categoryId = categoryId;

  const draftRole = wpEval("add_role( 'newsroom_draft_service', 'Newsroom Draft Service', array( 'read' => true, 'edit_posts' => true, 'assign_categories' => true ) ); echo 'ok';");
  const mediaRole = wpEval("add_role( 'newsroom_media_service', 'Newsroom Media Service', array( 'read' => true, 'upload_files' => true ) ); echo 'ok';");
  if (draftRole.status !== 0 || mediaRole.status !== 0) throw new Error('role creation failed');

  const draftUser = cli(['user', 'create', 'runtime_service', 'service@example.invalid', '--role=newsroom_draft_service', `--user_pass=${ctx.secrets.draftUserPassword}`, '--porcelain']);
  if (draftUser.status !== 0 || draftUser.stdout.trim() !== '2') throw new Error('draft service user must be id 2, got: ' + draftUser.stdout);
  const mediaUser = cli(['user', 'create', 'runtime_media_service', 'media@example.invalid', '--role=newsroom_media_service', `--user_pass=${ctx.secrets.mediaUserPassword}`, '--porcelain']);
  if (mediaUser.status !== 0 || mediaUser.stdout.trim() !== '3') throw new Error('media service user must be id 3, got: ' + mediaUser.stdout);
  const authorUser = cli(['user', 'create', 'runtime_author', 'author@example.invalid', '--role=author', `--user_pass=${ctx.secrets.authorPassword}`, '--porcelain']);
  if (authorUser.status !== 0 || authorUser.stdout.trim() !== '4') throw new Error('author user must be id 4, got: ' + authorUser.stdout);

  const appPw = cli(['user', 'application-password', 'create', 'runtime_author', 'media-proof', '--porcelain']);
  const appGroups = (appPw.stdout || '').match(/[A-Za-z0-9]{4}/g) || [];
  ctx.secrets.appPassword = appGroups.join('');
  if (ctx.secrets.appPassword.length < 24) throw new Error('application password missing: ' + appPw.stdout);

  const bridgeAct = cli(['plugin', 'activate', 'newsroom-bridge']);
  const mediaAct = cli(['plugin', 'activate', 'media-newsroom-proof']);
  if (bridgeAct.status !== 0) throw new Error('bridge activate failed: ' + bridgeAct.stderr.slice(0, 500));
  if (mediaAct.status !== 0) throw new Error('media plugin activate failed: ' + mediaAct.stderr.slice(0, 500));
}

async function runProof(ctx) {
  const { baseUrl, mediaSecretBytes, mediaSecretB64u, draftSecretBytes, draftSecretB64u, secrets, categoryId } = ctx;
  const secret = mediaSecretBytes;
  const draftSecret = draftSecretBytes;

  const createdMeta = new Map();
  const createdKeys = new Set();
  const track = (key, filename, mime, body) => {
    createdMeta.set(key, { filenameSha: sha256Hex(filename), mime, bodySha: sha256Hex(body), length: body.length });
    createdKeys.add(key);
  };
  const expectedFingerprint = (key) => {
    const m = createdMeta.get(key);
    return sha256Hex(`media-payload-v1\n${m.bodySha}\n${m.filenameSha}\n${m.mime}`);
  };

  const fixtures = {
    pngA: makePng(1, 1, 120),
    pngB: makePng(1, 1, 200),
    gif: GIF_1PX,
    bigPng: makeBigPng(200000),
    random: crypto.randomBytes(96),
    huge: Buffer.alloc(500001, 7),
    empty: Buffer.alloc(0),
  };

  const phpLint = [];
  const lintTargets = [
    'media-newsroom-proof.php',
    'includes/class-test-only-media-config.php',
    'includes/class-test-only-media-store.php',
    'includes/class-test-only-media-auth.php',
    'includes/class-test-only-media-controller.php',
  ];
  for (const f of lintTargets) {
    const r = composeExec(['php', '-l', `/var/www/html/wp-content/plugins/media-newsroom-proof/${f}`]);
    phpLint.push({ f, status: r.status });
  }

  const mediaTable = queryScalar("SHOW TABLES LIKE 'wp_newsroom_media'");
  const mediaCols = queryLines('SHOW COLUMNS FROM wp_newsroom_media').map((l) => l.split('\t')[0]).sort().join(',');
  const expectedCols = ['actor_user_id', 'attachment_id', 'content_length', 'created_at', 'media_key', 'payload_hash', 'reservation_token', 'updated_at'].join(',');
  const draftTable = queryScalar("SHOW TABLES LIKE 'wp_newsroom_reconciliation'");
  const routesText = wpEval(`echo implode( '|', array_keys( rest_get_server()->get_routes() ) );`).stdout;
  evidence(
    'activation_and_schema',
    'Plugin activation and dedicated reconciliation schema',
    phpLint.every((l) => l.status === 0) && mediaTable.startsWith('wp_newsroom_media') && mediaCols === expectedCols && draftTable.startsWith('wp_newsroom_reconciliation') && routesText.includes('/newsroom-media/v1/media'),
    JSON.stringify({ lint: phpLint.map((l) => (l.status === 0 ? 'ok' : 'ERROR')), mediaTable, mediaCols, draftTable, mediaRoutes: routesText.includes('/newsroom-media/v1/media') })
  );

  const katBody = Buffer.concat([PNG_MAGIC, Buffer.from('FIXTURE-BYTES', 'ascii')]);
  const katPost = mediaCanonical({ keyId: MEDIA_KAT.keyId, method: 'POST', route: MEDIA_KAT.route, timestamp: MEDIA_KAT.timestamp, mediaKey: MEDIA_KAT.mediaKey, filename: MEDIA_KAT.filename, mime: MEDIA_KAT.mime, body: katBody });
  const katGet = mediaCanonical({ keyId: MEDIA_KAT.keyId, method: 'GET', route: mediaRouteGet(MEDIA_KAT.mediaKey), timestamp: MEDIA_KAT.timestamp, mediaKey: MEDIA_KAT.mediaKey, filename: null, mime: null, body: Buffer.alloc(0) });
  const katOk = hmacSha256(decodeSecret(MEDIA_KAT.secretB64u), katPost) === MEDIA_KAT.postSignature
    && hmacSha256(decodeSecret(MEDIA_KAT.secretB64u), katGet) === MEDIA_KAT.getSignature
    && sha256Hex(katBody) === MEDIA_KAT.bodySha256
    && sha256Hex(MEDIA_KAT.filename) === MEDIA_KAT.filenameSha256;
  evidence('canonical_kat_vector', 'Documented KAT vector reproduces exactly in the Node canonical/signing builder', katOk, JSON.stringify({ match: katOk, post: MEDIA_KAT.postSignature, get: MEDIA_KAT.getSignature }));
  if (!katOk) throw new Error('KAT vector mismatch');

  const xTs = nowTimestamp();
  const xKey = crypto.randomUUID();
  const xCanonical = mediaCanonical({ keyId: MEDIA_KEY_ID, method: 'POST', route: '/newsroom-media/v1/media', timestamp: xTs, mediaKey: xKey, filename: 'hero.png', mime: 'image/png', body: fixtures.pngA });
  const xNode = hmacSha256(secret, xCanonical);
  const xPhp = wpEval(`echo hash_hmac( 'sha256', "${xCanonical}", hex2bin( "${secret.toString('hex')}" ) );`);
  evidence(
    'cross_language_canonical',
    'PHP hash_hmac over the identical canonical equals the Node signature builder',
    xPhp.status === 0 && xPhp.stdout === xNode,
    JSON.stringify({ php: xPhp.stdout, node: xNode, match: xPhp.stdout === xNode })
  );

  async function upload(key, filename, mime, body, opts = {}) {
    const res = await createMedia({ baseUrl, keyId: MEDIA_KEY_ID, secret, mediaKey: key, filename, mime, body, ...opts }).catch((err) => ({ kind: 'ERROR', code: err.code, status: err.status, info: err.info }));
    if (res.kind !== 'ERROR') track(key, filename, mime, body);
    return res;
  }
  async function signedPostRaw({ key, filename = 'hero.png', mime = 'image/png', body }) {
    const headers = mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method: 'POST', route: '/newsroom-media/v1/media', timestamp: nowTimestamp(), mediaKey: key, filename, mime, body });
    return httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', { headers, body });
  }
  const signedGet = (key) => getMedia({ baseUrl, keyId: MEDIA_KEY_ID, secret, mediaKey: key });

  const mainKey = MEDIA_KAT.mediaKey;
  const main = await upload(mainKey, 'hero.png', 'image/png', fixtures.pngA);
  evidence(
    'create_media_201',
    'Signed positive upload returns 201 with deterministic DTO',
    main.kind === 'CREATED' && main.json && main.json.status === 'attachment' && main.json.replayed === false && typeof main.json.attachment_id === 'number',
    JSON.stringify(main.kind === 'CREATED' ? main.json : { kind: main.kind, code: main.code, status: main.status, info: main.info })
  );
  if (main.kind !== 'CREATED') throw new Error('positive upload failed: ' + main.code);

  const gotten = await signedGet(mainKey);
  evidence(
    'get_media_200_reconciliation',
    'Signed GET reconciles the committed attachment',
    gotten.kind === 'attachment' && gotten.json && gotten.json.attachment_id === main.json.attachment_id,
    JSON.stringify(gotten.json || { kind: gotten.kind })
  );

  const replay = await upload(mainKey, 'hero.png', 'image/png', fixtures.pngA);
  evidence(
    'idempotent_replay_200',
    'Identical payload replay returns 200 with the same attachment',
    replay.kind === 'REPLAYED' && replay.json && replay.json.replayed === true && replay.json.attachment_id === main.json.attachment_id,
    JSON.stringify(replay.json || { kind: replay.kind })
  );

  const conflictKey = '12345678-90ab-48cd-9e01-23456789abcd';
  const conflictBase = await upload(conflictKey, 'hero.png', 'image/png', fixtures.pngA);
  if (conflictBase.kind !== 'CREATED') throw new Error('conflict base failed: ' + conflictBase.code);
  const conflict2 = await upload(conflictKey, 'hero.png', 'image/png', fixtures.pngB);
  evidence(
    'payload_conflict_409',
    'Same key different payload yields 409 idempotency conflict and never overwrites',
    conflict2.kind === 'ERROR' && conflict2.code === 'CONFLICT' && conflict2.status === 409,
    JSON.stringify({ first: conflictBase.kind, second: conflict2.code, status: conflict2.status })
  );

  // ---------------- draft authority crossover --------------------------------
  const draftRoute = '/newsroom/v1/drafts';
  const draftPayload = { draft_key: crypto.randomUUID(), title: 'Proof Draft Fixture', content: 'Proof draft content for the disposable runtime.', excerpt: '', categories: [categoryId] };
  async function draftProbe(method, route, payload) {
    const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : Buffer.alloc(0);
    const headers = draftHeaders({ keyId: DRAFT_KEY_ID, secret: draftSecret, method, route, timestamp: nowTimestamp(), body });
    return httpJson(method, baseUrl + '/wp-json' + route, { headers, body: method === 'GET' ? null : body });
  }
  async function mediaProbeCross(method, route, payload) {
    const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : Buffer.alloc(0);
    const headers = mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method, route, timestamp: nowTimestamp(), mediaKey: crypto.randomUUID(), filename: 'hero.png', mime: 'image/png', body });
    return httpJson(method, baseUrl + '/wp-json' + route, { headers, body: method === 'GET' ? null : body });
  }

  const draftCreate = await draftProbe('POST', draftRoute, draftPayload);
  evidence(
    'draft_authority_unaffected',
    'Production draft boundary still signs and creates drafts; media plugin does not shadow it',
    draftCreate.status === 201,
    JSON.stringify({ status: draftCreate.status, code: errCode(draftCreate.body) || 'ok' })
  );

  const draftOnMedia = await draftProbe('POST', '/newsroom-media/v1/media', null);
  const mediaOnDraft = await mediaProbeCross('POST', draftRoute, draftPayload);
  const draftGetOk = await draftProbe('GET', `${draftRoute}/${draftPayload.draft_key}`, null);
  const unsignedMedia = await httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', { headers: { 'content-type': 'application/octet-stream' }, body: fixtures.pngA });
  const unsignedDraft = await httpJson('POST', baseUrl + '/wp-json' + draftRoute, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(draftPayload) });
  evidence(
    'cross_authority_401_isolation',
    'Exact 401 isolation: draft/media authorities never accept the other side credential or unsigned traffic',
    draftOnMedia.status === 401 && mediaOnDraft.status === 401 && draftGetOk.status === 200 && unsignedMedia.status === 401 && unsignedDraft.status === 401,
    JSON.stringify({ draftKeyOnMediaRoute: draftOnMedia.status, mediaKeyOnDraftRoute: mediaOnDraft.status, draftGet: draftGetOk.status, unsignedMedia: unsignedMedia.status, unsignedDraft: unsignedDraft.status })
  );

  const wrongSig = await httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', {
    headers: {
      ...mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method: 'POST', route: '/newsroom-media/v1/media', timestamp: nowTimestamp(), mediaKey: crypto.randomUUID(), filename: 'hero.png', mime: 'image/png', body: fixtures.pngA }),
      'X-Newsroom-Media-Signature': '0'.repeat(64),
    },
    body: fixtures.pngA,
  });
  evidence('authentication_failure_401', 'Wrong signature rejected with 401', wrongSig.status === 401, JSON.stringify({ status: wrongSig.status }));

  const oldTs = String(Number(nowTimestamp()) - 3600);
  const oldTsRes = await httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', {
    headers: mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method: 'POST', route: '/newsroom-media/v1/media', timestamp: oldTs, mediaKey: crypto.randomUUID(), filename: 'hero.png', mime: 'image/png', body: fixtures.pngA }),
    body: fixtures.pngA,
  });
  evidence('timestamp_window_401', 'Stale timestamp rejected with 401', oldTsRes.status === 401, JSON.stringify({ status: oldTsRes.status, skew: -3600 }));

  const filenameProbes = [
    ['../x.png', '../x.png', 'image/png', fixtures.pngA, 'path-traversal'],
    ['..', '..', 'image/png', fixtures.pngA, 'dotdot'],
    ['evil.php', 'evil.php', 'image/png', fixtures.pngA, 'php-extension'],
    ['hero.png.php', 'hero.png.php', 'image/png', fixtures.pngA, 'hidden-extension'],
    ['hero.jpg', 'hero.jpg', 'image/png', fixtures.pngA, 'ext-mime-mismatch'],
  ];
  const filenameResults = [];
  for (const [, filename, mime, body, label] of filenameProbes) {
    const res = await httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', {
      headers: mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method: 'POST', route: '/newsroom-media/v1/media', timestamp: nowTimestamp(), mediaKey: crypto.randomUUID(), filename, mime, body }),
      body,
    });
    filenameResults.push({ label, status: res.status, code: errCode(res.body) });
  }
  evidence(
    'filename_attack_400',
    'Filename attacks rejected at auth or pipeline boundary',
    filenameResults.every((p) => p.status === 401 || p.status === 400),
    JSON.stringify(filenameResults)
  );

  const gifClaim = await httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', {
    headers: mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method: 'POST', route: '/newsroom-media/v1/media', timestamp: nowTimestamp(), mediaKey: crypto.randomUUID(), filename: 'anim.gif', mime: 'image/gif', body: fixtures.pngA }),
    body: fixtures.pngA,
  });
  const unsupportedMime = await httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', {
    headers: mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method: 'POST', route: '/newsroom-media/v1/media', timestamp: nowTimestamp(), mediaKey: crypto.randomUUID(), filename: 'movie.mp4', mime: 'video/mp4', body: fixtures.random }),
    body: fixtures.random,
  });
  evidence(
    'mime_mismatch_400',
    'Claimed MIME must match server-detected image content; unsupported MIME never reaches the pipeline',
    gifClaim.status === 400 && unsupportedMime.status === 401,
    JSON.stringify({ pngClaimedAsGif: gifClaim.status, unsupported: unsupportedMime.status, codes: [errCode(gifClaim.body), errCode(unsupportedMime.body)] })
  );

  const sizeEmpty = await httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', {
    headers: mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method: 'POST', route: '/newsroom-media/v1/media', timestamp: nowTimestamp(), mediaKey: crypto.randomUUID(), filename: 'empty.png', mime: 'image/png', body: fixtures.empty }),
    body: fixtures.empty,
  });
  const sizeOver = await httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', {
    headers: mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method: 'POST', route: '/newsroom-media/v1/media', timestamp: nowTimestamp(), mediaKey: crypto.randomUUID(), filename: 'huge.png', mime: 'image/png', body: fixtures.huge }),
    body: fixtures.huge,
  });
  const bigKey = crypto.randomUUID();
  const sizeBig = await httpJson('POST', baseUrl + '/wp-json/newsroom-media/v1/media', {
    headers: mediaHeaders({ keyId: MEDIA_KEY_ID, secret, method: 'POST', route: '/newsroom-media/v1/media', timestamp: nowTimestamp(), mediaKey: bigKey, filename: 'big.png', mime: 'image/png', body: fixtures.bigPng }),
    body: fixtures.bigPng,
  });
  const bigJson = safeJson(sizeBig.body.toString());
  evidence(
    'size_boundary_400_413',
    'Empty body 400, over-limit 413 (checked before content validation), valid large image accepted',
    sizeEmpty.status === 400 && sizeOver.status === 413 && sizeBig.status === 201,
    JSON.stringify({ empty: sizeEmpty.status, overMax: sizeOver.status, bigValid: sizeBig.status, bytes: { big: fixtures.bigPng.length, over: fixtures.huge.length } })
  );
  if (sizeBig.status === 201 && bigJson && bigJson.media_key) track(bigKey, 'big.png', 'image/png', fixtures.bigPng);

  // ---------------- loss / recovery via byte-proxies -------------------------
  const proxyKeys = {
    afterCommit: 'c3d4e5f6-789a-4bcd-8e01-23456789abef',
    notDelivered: 'd4e5f6a7-8901-4bcd-8f01-23456789abef',
    noBlind: 'e5f6a7b8-9012-4cde-8a01-23456789abef',
    mangle: 'f6a7b8c9-0123-4def-8b01-23456789abef',
  };

  track(proxyKeys.afterCommit, 'hero.png', 'image/png', fixtures.pngA);
  const p1 = await startProxy(baseUrl, async (c) => (c.method === 'POST' ? ((await c.forward()), { type: 'destroy' }) : { type: 'forward' }));
  const r1 = await createMedia({ baseUrl: p1.baseUrl, keyId: MEDIA_KEY_ID, secret, mediaKey: proxyKeys.afterCommit, filename: 'hero.png', mime: 'image/png', body: fixtures.pngA });
  evidence(
    'response_loss_recovery',
    'Response loss after commit recovers via signed GET with no duplicate POST',
    r1.kind === 'RECOVERED' && p1.counts.POST === 1 && p1.counts.GET >= 1,
    JSON.stringify({ kind: r1.kind, httpStatus: r1.httpStatus, postCount: p1.counts.POST, getCount: p1.counts.GET })
  );
  await p1.close();

  track(proxyKeys.notDelivered, 'hero.png', 'image/png', fixtures.pngA);
  let first = true;
  const p2 = await startProxy(baseUrl, async (c) => {
    if (c.method === 'POST' && first) { first = false; return { type: 'drop' }; }
    return { type: 'forward' };
  });
  const r2 = await createMedia({ baseUrl: p2.baseUrl, keyId: MEDIA_KEY_ID, secret, mediaKey: proxyKeys.notDelivered, filename: 'hero.png', mime: 'image/png', body: fixtures.pngA });
  evidence(
    'not_delivered_retry',
    'First POST not delivered; GET 404 then a single fresh-signed POST retry succeeds',
    r2.kind === 'RECOVERED' && r2.httpStatus === 201 && p2.counts.POST === 2 && p2.counts.GET >= 1,
    JSON.stringify({ kind: r2.kind, httpStatus: r2.httpStatus, postCount: p2.counts.POST, getCount: p2.counts.GET })
  );
  await p2.close();

  const p3 = await startProxy(baseUrl, async (c) => {
    if (c.method === 'POST') return { type: 'drop' };
    if (c.method === 'GET') return { type: 'reply', status: 503, body: 'proxy busy', headers: { 'content-type': 'text/plain' } };
    return { type: 'forward' };
  });
  let noBlindErr = null;
  try {
    await createMedia({ baseUrl: p3.baseUrl, keyId: MEDIA_KEY_ID, secret, mediaKey: proxyKeys.noBlind, filename: 'hero.png', mime: 'image/png', body: fixtures.pngA });
  } catch (err) {
    noBlindErr = err;
  }
  evidence(
    'get_uncertain_no_blind_post',
    'GET uncertainty after POST loss never blind-posts a second request',
    noBlindErr && noBlindErr.code === 'UNCERTAIN_OUTCOME' && p3.counts.POST === 1 && p3.counts.GET === 3,
    JSON.stringify({ postCount: p3.counts.POST, getCount: p3.counts.GET, code: noBlindErr && noBlindErr.code })
  );
  await p3.close();

  track(proxyKeys.mangle, 'hero.png', 'image/png', fixtures.pngA);
  const p4 = await startProxy(baseUrl, async (c) => {
    if (c.method === 'POST') { await c.forward(); return { type: 'reply', status: 201, body: '{this is not json', headers: { 'content-type': 'application/json' } }; }
    return { type: 'forward' };
  });
  const r4 = await createMedia({ baseUrl: p4.baseUrl, keyId: MEDIA_KEY_ID, secret, mediaKey: proxyKeys.mangle, filename: 'hero.png', mime: 'image/png', body: fixtures.pngA });
  evidence(
    'mangled_response_rejection',
    'Malformed POST response is treated as uncertain and recovered via signed GET, no duplicate POST',
    r4.kind === 'RECOVERED' && p4.counts.POST === 1 && p4.counts.GET >= 1,
    JSON.stringify({ kind: r4.kind, httpStatus: r4.httpStatus, postCount: p4.counts.POST, getCount: p4.counts.GET })
  );
  await p4.close();

  // ---------------- concurrency ------------------------------------------------
  const concurrentKey = 'fedcba99-bbbb-4ccc-8ddd-eeeeffff0001';
  track(concurrentKey, 'hero.png', 'image/png', fixtures.pngA);
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () => createMedia({ baseUrl, keyId: MEDIA_KEY_ID, secret, mediaKey: concurrentKey, filename: 'hero.png', mime: 'image/png', body: fixtures.pngA, attemptLimit: 6 }))
  );
  const createdC = concurrent.filter((r) => r.kind === 'CREATED').length;
  const replayedC = concurrent.filter((r) => r.kind === 'REPLAYED').length;
  const ids = new Set(concurrent.map((r) => r.json && r.json.attachment_id));
  const rowC = Number(queryScalar(`SELECT COUNT(*) FROM wp_newsroom_media WHERE media_key='${concurrentKey}'`));
  evidence(
    'concurrent_identical_idempotency',
    'Parallel identical uploads yield exactly one attachment, one row, one id',
    createdC === 1 && replayedC === concurrent.length - 1 && ids.size === 1 && rowC === 1,
    JSON.stringify({ created: createdC, replayed: replayedC, uniqueIds: ids.size, rows: rowC })
  );

  const ccKey = 'fedcba99-bbbb-4ccc-8ddd-eeeeffff0002';
  const cc = await Promise.all([
    createMedia({ baseUrl, keyId: MEDIA_KEY_ID, secret, mediaKey: ccKey, filename: 'hero.png', mime: 'image/png', body: fixtures.pngA, attemptLimit: 6 }).catch((err) => ({ kind: 'ERROR', code: err.code, status: err.status, json: err.info })),
    createMedia({ baseUrl, keyId: MEDIA_KEY_ID, secret, mediaKey: ccKey, filename: 'hero.png', mime: 'image/png', body: fixtures.pngB, attemptLimit: 6 }).catch((err) => ({ kind: 'ERROR', code: err.code, status: err.status, json: err.info })),
  ]);
  const ccCreated = cc.filter((r) => r.kind === 'CREATED').length;
  const ccConflict = cc.filter((r) => r.kind === 'ERROR' && r.code === 'CONFLICT').length;
  const ccUnavailable = cc.filter((r) => r.kind === 'ERROR' && r.code === 'WORDPRESS_UNAVAILABLE').length;
  const ccRowHash = queryScalar(`SELECT payload_hash FROM wp_newsroom_media WHERE media_key='${ccKey}'`);
  for (const [label, body] of [['A', fixtures.pngA], ['B', fixtures.pngB]]) {
    const fp = sha256Hex(`media-payload-v1\n${sha256Hex(body)}\n${sha256Hex('hero.png')}\nimage/png`);
    if (fp === ccRowHash) track(ccKey, 'hero.png', 'image/png', body);
  }
  evidence(
    'concurrent_conflict_deterministic',
    'Parallel different-payload uploads have a single deterministic winner; the loser conflicts',
    ccCreated === 1 && ccConflict + ccUnavailable === 1,
    JSON.stringify({ created: ccCreated, conflicts: ccConflict, unavailable: ccUnavailable })
  );

  // ---------------- capabilities ------------------------------------------------
  const capsDraft = JSON.parse(wpEval("$u = get_user_by( 'id', 2 ); echo wp_json_encode( array_filter( (array) $u->allcaps ) );").stdout);
  const capsMedia = JSON.parse(wpEval("$u = get_user_by( 'id', 3 ); echo wp_json_encode( array_filter( (array) $u->allcaps ) );").stdout);
  const appPwMedia = wpEval("$u = get_user_by( 'id', 3 ); echo wp_is_application_passwords_available_for_user( $u ) ? 'yes' : 'no';").stdout;
  const draftShape = capsDraft.read === true && capsDraft.edit_posts === true && capsDraft.upload_files !== true && !capsDraft.publish_posts && !capsDraft.manage_options && !capsDraft.edit_users;
  const mediaShape = capsMedia.read === true && capsMedia.upload_files === true && !capsMedia.edit_posts && !capsMedia.publish_posts && !capsMedia.manage_options && !capsMedia.edit_users && !capsMedia.unfiltered_html && !capsMedia.activate_plugins;
  evidence(
    'separate_service_users',
    'Draft and media service identities are separate users with disjoint minimum capabilities',
    draftShape && mediaShape && appPwMedia === 'no',
    JSON.stringify({ draftCaps: Object.keys(capsDraft).filter((k) => capsDraft[k] === true), mediaCaps: Object.keys(capsMedia).filter((k) => capsMedia[k] === true), mediaAppPasswords: appPwMedia })
  );

  wpEval("$u = get_user_by( 'id', 3 ); $u->add_cap( 'manage_options' );");
  const creepRes = await upload(crypto.randomUUID(), 'hero.png', 'image/png', fixtures.pngA);
  wpEval("$u = get_user_by( 'id', 3 ); $u->remove_cap( 'manage_options' );");
  const cleanRes = await upload(crypto.randomUUID(), 'hero.png', 'image/png', fixtures.pngA);
  evidence(
    'service_policy_enforced',
    'Service policy is enforced live: privilege creep on the media identity is rejected with 401, restoration re-allows',
    creepRes.kind === 'ERROR' && creepRes.code === 'AUTHENTICATION_FAILURE' && creepRes.status === 401 && cleanRes.kind === 'CREATED',
    JSON.stringify({ withManageOptions: creepRes.code, afterRestore: cleanRes.kind })
  );

  // ---------------- non-authority usage of the media secret ---------------------
  const probeOpts = { keyId: MEDIA_KEY_ID, secret, method: 'POST', timestamp: nowTimestamp(), mediaKey: crypto.randomUUID(), filename: 'hero.png', mime: 'image/png' };
  const pubRes = await httpJson('POST', baseUrl + '/wp-json/wp/v2/posts', {
    headers: mediaHeaders({ ...probeOpts, route: '/wp/v2/posts', body: Buffer.from('{"title":"x"}') }),
    body: '{"title":"x"}',
  });
  const coreMediaRes = await httpJson('POST', baseUrl + '/wp-json/wp/v2/media', {
    headers: mediaHeaders({ ...probeOpts, route: '/wp/v2/media', body: fixtures.pngA }),
    body: fixtures.pngA,
  });
  const batchRes = await httpJson('POST', baseUrl + '/wp-json/batch/v1', {
    headers: mediaHeaders({ ...probeOpts, route: '/batch/v1', body: Buffer.from('{"requests":[]}') }),
    body: '{"requests":[]}',
  });
  const basicMediaUser = `Basic ${Buffer.from(`runtime_media_service:${ctx.secrets.mediaUserPassword}`).toString('base64')}`;
  const basicDraftUser = `Basic ${Buffer.from(`runtime_service:${ctx.secrets.draftUserPassword}`).toString('base64')}`;
  const basicMediaRes = await httpJson('POST', baseUrl + '/wp-json/wp/v2/media', {
    headers: { authorization: basicMediaUser, 'content-type': 'application/octet-stream' },
    body: fixtures.pngA,
  });
  const basicDraftRes = await httpJson('POST', baseUrl + '/wp-json' + draftRoute, {
    headers: { authorization: basicDraftUser, 'content-type': 'application/json' },
    body: JSON.stringify(draftPayload),
  });
  evidence(
    'no_generic_credential',
    'Media HMAC never authenticates publication/core/batch; locked service logins are rejected',
    pubRes.status === 401 && coreMediaRes.status === 401 && batchRes.status === 401 && basicMediaRes.status === 401 && basicDraftRes.status === 401,
    JSON.stringify({ wpV2Posts: pubRes.status, wpV2Media: coreMediaRes.status, batch: batchRes.status, mediaLoginAsBasic: basicMediaRes.status, draftLoginAsBasic: basicDraftRes.status })
  );

  const xmlCall = (user, pass) => {
    const e = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<methodCall><methodName>wp.getUsersBlogs</methodName><params><param><value><string>${e(user)}</string></value></param><param><value><string>${e(pass)}</string></value></param></params></methodCall>`;
  };
  const xmlMedia = await httpJson('POST', baseUrl + '/xmlrpc.php', { headers: { 'content-type': 'text/xml' }, body: xmlCall('runtime_media_service', ctx.secrets.mediaUserPassword) });
  const xmlAuthor = await httpJson('POST', baseUrl + '/xmlrpc.php', { headers: { 'content-type': 'text/xml' }, body: xmlCall('runtime_author', ctx.secrets.authorPassword) });
  const xmlAuthorApp = await httpJson('POST', baseUrl + '/xmlrpc.php', { headers: { 'content-type': 'text/xml' }, body: xmlCall('runtime_author', ctx.secrets.appPassword) });
  const xmlBodyText = (res) => (Buffer.isBuffer(res.body) ? res.body.toString() : String(res.body ?? ''));
  const isXmlFault = (res) => xmlBodyText(res).includes('<fault>');
  const isXmlSuccess = (res) => { const t = xmlBodyText(res); return /<methodResponse>\s*<params>/.test(t) && !t.includes('<fault>'); };
  evidence(
    'xmlrpc_and_app_passwords_isolated',
    'Media identity has no XML-RPC path; ordinary author login and application passwords still work',
    isXmlFault(xmlMedia) && isXmlSuccess(xmlAuthor) && isXmlSuccess(xmlAuthorApp),
    JSON.stringify({ xmlrpcMediaFault: isXmlFault(xmlMedia), xmlrpcAuthorOk: isXmlSuccess(xmlAuthor), xmlrpcAuthorAppOk: isXmlSuccess(xmlAuthorApp), mediaBody: String(xmlMedia.body).slice(0, 220) })
  );

  // ---------------- crash windows ------------------------------------------------
  const setFault = (phase) => { const r = cli(['option', 'update', 'test_media_fault_phase', phase]); if (r.status !== 0) throw new Error('fault option failed'); };
  const clearFault = () => cli(['option', 'delete', 'test_media_fault_phase']);
  const ageRow = (key, seconds) => wpdb(`UPDATE wp_newsroom_media SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${seconds} SECOND) WHERE media_key = '${key}'`);
  const gc = () => { const out = wpEval('echo wp_json_encode( Test_Only_Media_Plugin::controller_instance()->garbage_collect() );'); return safeJson(out.stdout) || null; };
  const fault = async (phase, key) => {
    track(key, 'hero.png', 'image/png', fixtures.pngA);
    setFault(phase);
    const res = await signedPostRaw({ key, body: fixtures.pngA });
    clearFault();
    return res;
  };

  const faultKeys = {
    afterReservation: 'ab12cd34-4567-4e89-8f01-23456789abcd',
    afterFile: 'bc23de45-5678-4f90-8a11-23456789abce',
    afterInsert: 'cd34ef56-6789-4a01-8b22-23456789abcf',
    duringMetadata: 'de45fa67-789a-4b12-8c33-23456789abd0',
    afterMapping: 'ef56ab78-89ab-4c23-8d44-23456789abd1',
  };

  const f1 = await fault('after_reservation', faultKeys.afterReservation);
  const g1 = await signedGet(faultKeys.afterReservation);
  ageRow(faultKeys.afterReservation, 65);
  const f1b = await upload(faultKeys.afterReservation, 'hero.png', 'image/png', fixtures.pngA);
  evidence(
    'crash_window_after_reservation',
    'Crash after reservation: reserved observable, stale reclaim re-owns, single row final',
    (f1.status === 500 || f1.status === 0) && g1.kind === 'reserved' && f1b.kind === 'CREATED' && Number(queryScalar(`SELECT COUNT(*) FROM wp_newsroom_media WHERE media_key='${faultKeys.afterReservation}'`)) === 1,
    JSON.stringify({ fault: f1.status, get: g1.kind, recover: f1b.kind })
  );

  const f2 = await fault('after_file', faultKeys.afterFile);
  const g2 = await signedGet(faultKeys.afterFile);
  const gc2 = await gc();
  const fileCountAfterGc = Number(queryScalar('SELECT COUNT(*) FROM wp_posts p WHERE p.post_status = \'inherit\' AND p.post_type = \'attachment\' AND EXISTS (SELECT 1 FROM wp_postmeta pm WHERE pm.post_id = p.ID AND pm.meta_key = \'_newsroom_media_file\')'));
  ageRow(faultKeys.afterFile, 65);
  const f2b = await upload(faultKeys.afterFile, 'hero.png', 'image/png', fixtures.pngA);
  evidence(
    'crash_window_after_file',
    'Crash after file write: orphan file garbage-collected, stale reclaim re-owns',
    (f2.status === 500 || f2.status === 0) && g2.kind === 'reserved' && gc2 && gc2.deleted_files >= 1 && f2b.kind === 'CREATED',
    JSON.stringify({ fault: f2.status, get: g2.kind, gc: gc2, attachmentsTouchingMedia: fileCountAfterGc, recover: f2b.kind })
  );

  const f3 = await fault('after_insert', faultKeys.afterInsert);
  const g3 = await signedGet(faultKeys.afterInsert);
  const gc3 = await gc();
  const g3b = await signedGet(faultKeys.afterInsert);
  evidence(
    'crash_window_after_insert',
    'Crash after insert: GC adopts the attachment into the reserved row, signed GET recovers',
    (f3.status === 500 || f3.status === 0) && g3.kind === 'reserved' && gc3 && gc3.adopted === 1 && g3b.kind === 'attachment',
    JSON.stringify({ fault: f3.status, getBefore: g3.kind, gc: gc3, getAfter: g3b.kind })
  );

  const f4 = await fault('during_metadata', faultKeys.duringMetadata);
  const g4 = await signedGet(faultKeys.duringMetadata);
  const f4b = await upload(faultKeys.duringMetadata, 'hero.png', 'image/png', fixtures.pngA);
  evidence(
    'crash_window_during_metadata',
    'Crash during metadata: clean self-deletion, next upload is a fresh deterministic create',
    (f4.status === 500 || f4.status === 0) && g4.kind === 'notfound' && f4b.kind === 'CREATED',
    JSON.stringify({ fault: f4.status, get: g4.kind, recover: f4b.kind })
  );

  const f5 = await fault('after_mapping', faultKeys.afterMapping);
  const g5 = await signedGet(faultKeys.afterMapping);
  evidence(
    'crash_window_after_mapping',
    'Crash after mapping commit: durable row, signed GET recovers, no orphan',
    (f5.status === 500 || f5.status === 0) && g5.kind === 'attachment' && Number(queryScalar(`SELECT COUNT(*) FROM wp_newsroom_media WHERE media_key='${faultKeys.afterMapping}'`)) === 1,
    JSON.stringify({ fault: f5.status, get: g5.kind })
  );

  const orphanKey = 'fa16ab78-89ab-4c23-8d44-23456789abd2';
  track(orphanKey, 'orphan.png', 'image/png', fixtures.pngA);
  setFault('after_file');
  await signedPostRaw({ key: orphanKey, filename: 'orphan.png', body: fixtures.pngA });
  clearFault();
  const gcOrphan = await gc();
  const orphanAttachmentCount = Number(queryScalar(`SELECT COUNT(*) FROM wp_posts p WHERE p.post_status='inherit' AND p.post_type='attachment' AND EXISTS (SELECT 1 FROM wp_postmeta pm WHERE pm.post_id=p.ID AND pm.meta_key='_newsroom_media_key' AND pm.meta_value='${orphanKey}')`));
  ageRow(orphanKey, 65);
  const orphanRecover = await upload(orphanKey, 'orphan.png', 'image/png', fixtures.pngA);
  evidence(
    'orphan_detection_recovery',
    'Orphan attachments and files are detected and removed; reclaimed key re-uploads cleanly',
    gcOrphan && gcOrphan.deleted_files >= 1 && orphanAttachmentCount === 0 && orphanRecover.kind === 'CREATED',
    JSON.stringify({ gc: gcOrphan, attachmentLeftBehind: orphanAttachmentCount, recover: orphanRecover.kind })
  );

  // ---------------- durability, filesystem, secrets ------------------------------
  const rows = queryLines('SELECT media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token FROM wp_newsroom_media');
  const rowData = rows.map((l) => l.split('\t'));
  let fpMismatch = 0;
  let actorMismatch = 0;
  let lenMismatch = 0;
  let reservedLeft = 0;
  const committedIds = [];
  for (const r of rowData) {
    const [key, attachmentId, payloadHash, contentLength, actor, resToken] = r;
    const expecting = createdKeys.has(key) ? expectedFingerprint(key) : null;
    if (!createdKeys.has(key)) fpMismatch++;
    if (createdKeys.has(key) && payloadHash !== expecting) fpMismatch++;
    if (actor !== '3') actorMismatch++;
    const meta = createdMeta.get(key);
    if (meta && String(meta.length) !== contentLength) lenMismatch++;
    if (attachmentId === 'NULL' || attachmentId === '') { reservedLeft++; } else { committedIds.push(attachmentId); if (resToken !== 'NULL' && resToken !== '') reservedLeft++; }
  }
  const createdKeysOk = [...createdKeys].length === rowData.length;
  const uniqueCommitted = new Set(committedIds).size;
  evidence(
    'database_integrity',
    'Reconciliation rows equal the exact created set, fingerprinted and actor-bound, single attachment per key',
    createdKeysOk && fpMismatch === 0 && actorMismatch === 0 && lenMismatch === 0 && reservedLeft === 0 && uniqueCommitted === committedIds.length,
    JSON.stringify({ rows: rowData.length, keys: createdKeys.size, fpMismatch, actorMismatch, lenMismatch, reservedLeft, uniqueCommitted, committed: committedIds.length })
  );

  const keyList = [...createdKeys].map((k) => `'${k}'`).join(',');
  const fileInfo = safeJson(wpEval(`global $wpdb; $out = array(); $keys = array(${keyList});
    foreach ( $keys as $k ) { $rid = $wpdb->get_var( $wpdb->prepare( 'SELECT attachment_id FROM wp_newsroom_media WHERE media_key = %s', $k ) ); if ( ! $rid ) { $out[$k] = array( 'row' => false ); continue; }
      $f = get_post_meta( (int) $rid, '_newsroom_media_file', true );
      $ex = is_string( $f ) && '' !== $f && file_exists( $f );
      $out[$k] = array( 'id' => (int) $rid, 'file' => (string) $f, 'exists' => $ex, 'sha' => $ex ? hash_file( 'sha256', $f ) : '', 'meta_key' => (string) get_post_meta( (int) $rid, '_newsroom_media_key', true ), 'post_type' => get_post_type( (int) $rid ) ); }
    echo wp_json_encode( $out );`).stdout);
  const fsProblems = [];
  for (const k of createdKeys) {
    const info = fileInfo[k];
    if (!info || info.row === false) { fsProblems.push(`${k}:no-row`); continue; }
    if (!info.exists) { fsProblems.push(`${k}:missing-file`); continue; }
    if (info.meta_key !== k) { fsProblems.push(`${k}:meta-mismatch`); continue; }
    if (info.post_type !== 'attachment') { fsProblems.push(`${k}:not-attachment`); continue; }
    const meta = createdMeta.get(k);
    if (meta && info.sha !== meta.bodySha) { fsProblems.push(`${k}:sha-mismatch`); continue; }
  }
  const gcFinal = await gc();
  evidence(
    'filesystem_integrity',
    'Uploaded files exist, match body hashes exactly, media meta bound, GC reports no leftovers',
    fsProblems.length === 0 && gcFinal && gcFinal.adopted === 0 && gcFinal.deleted_attachments === 0 && gcFinal.deleted_files === 0,
    JSON.stringify({ problems: fsProblems.slice(0, 20), finalGc: gcFinal, files: Object.keys(fileInfo).length })
  );

  const logs = compose(['logs', '--no-color', 'wordpress']);
  const logText = logs.stdout + '\n' + logs.stderr;
  const securityLines = logText.split(/\r?\n/).filter((l) => l.includes('newsroom_media_security') || l.includes('newsroom_bridge_security'));
  const leakedSecurity = securityLines.filter((l) => {
    const clean = l.replace(/^[a-z0-9:%\-. /]+(stdout|stderr)\s*/i, '');
    return KNOWN_SECRETS.some((s) => s && s.length >= 8 && clean.includes(s));
  });
  const mediaSuccessLogged = securityLines.some((l) => l.includes('newsroom_media_security') && l.includes('authentication_success'));
  const draftSuccessLogged = securityLines.some((l) => l.includes('newsroom_bridge_security') && l.includes('authentication_success'));
  evidence(
    'no_secret_logging',
    'Security log lines carry no secrets or signatures; both authorities log their successes',
    leakedSecurity.length === 0 && securityLines.length > 0 && mediaSuccessLogged && draftSuccessLogged,
    JSON.stringify({ securityLines: securityLines.length, mediaSuccess: mediaSuccessLogged, draftSuccess: draftSuccessLogged, leaked: leakedSecurity.length })
  );

  const dbSecretHits = {};
  const textCols = queryLines('SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN (\'char\',\'varchar\',\'text\',\'mediumtext\',\'longtext\',\'blob\',\'mediumblob\',\'longblob\')');
  for (const [table, column] of textCols.map((l) => l.split('\t'))) {
    for (const s of KNOWN_SECRETS.filter((x) => x && x.length >= 8)) {
      const count = Number(queryScalar(`SELECT COUNT(*) FROM \`${table}\` WHERE INSTR(\`${column}\`, '${s}') > 0`));
      if (count > 0) dbSecretHits[`${table}.${column}`] = (dbSecretHits[`${table}.${column}`] || 0) + count;
    }
  }
  evidence('no_secret_database', 'No runtime secret stored in any WordPress database column', Object.keys(dbSecretHits).length === 0, JSON.stringify(dbSecretHits));

  const webrootHits = {};
  for (const s of KNOWN_SECRETS.filter((x) => x && x.length >= 8)) {
    const grep = composeExec(['sh', '-lc', `grep -rF --binary-files=without-match -e "${s}" /var/www/html/wp-config.php /var/www/html/wp-content/plugins /var/www/html/wp-content/themes /var/www/html/wp-content/uploads 2>/dev/null | head -n 3`]);
    if (grep.stdout && grep.stdout.trim() !== '') webrootHits[s] = grep.stdout.trim();
  }
  evidence('no_secret_webroot', 'No runtime secret materialises in WordPress webroot files', Object.keys(webrootHits).length === 0, JSON.stringify(webrootHits));

  // ---------------- ordinary user non-regression ---------------------------------
  const authorBasic = `Basic ${Buffer.from(`runtime_author:${ctx.secrets.appPassword}`).toString('base64')}`;
  let authorUpload = { status: 0 };
  let authorPost = { status: 0 };
  try {
    const form = new FormData();
    form.append('file', new Blob([fixtures.pngA], { type: 'image/png' }), 'author-upload.png');
    form.append('title', 'Author Upload Fixture');
    authorUpload = await (async () => {
      const res = await fetch(baseUrl + '/wp-json/wp/v2/media', { method: 'POST', headers: { authorization: authorBasic }, body: form });
      return { status: res.status };
    })();
  } catch {}
  try {
    authorPost = await (async () => {
      const res = await fetch(baseUrl + '/wp-json/wp/v2/posts', { method: 'POST', headers: { authorization: authorBasic, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Author Post Fixture', status: 'draft' }) });
      return { status: res.status };
    })();
  } catch {}
  evidence(
    'ordinary_user_non_regression',
    'Ordinary author media upload, post creation, and login paths work untouched by the media authority',
    authorUpload.status === 201 && authorPost.status === 201 && isXmlSuccess(xmlAuthorApp),
    JSON.stringify({ authorMediaUpload: authorUpload.status, authorPostCreate: authorPost.status, authorLoginXmlRpc: isXmlSuccess(xmlAuthorApp) })
  );
}

async function cleanup() {
  const down = compose(['down', '--volumes', '--remove-orphans']);
  const containers = compose(['ps', '-a', '--format', '{{.Names}}']);
  const volumes = runSync('docker', ['volume', 'ls', '--format', '{{.Name}}']);
  const leftoverContainers = (containers.stdout || '').split(/\r?\n/).filter((n) => n.includes('newsroom-media-authority-proof'));
  const leftoverVolumes = (volumes.stdout || '').split(/\r?\n/).filter((n) => n.includes('newsroom-media-authority-proof'));
  if (fs.existsSync(ENV_FILE)) fs.rmSync(ENV_FILE);
  evidence(
    'strict_cleanup',
    'Compose teardown removes project containers, volumes, and the disposable runtime env',
    down.status === 0 && leftoverContainers.length === 0 && leftoverVolumes.length === 0 && !fs.existsSync(ENV_FILE),
    JSON.stringify({ composeDown: down.status, leftoverContainers: leftoverContainers.length, leftoverVolumes: leftoverVolumes.length, envRemoved: !fs.existsSync(ENV_FILE) })
  );
}

async function main() {
  assertDocker();
  const preBad = frozenHashBad();
  if (preBad.length) throw new Error('frozen bridge source changed before proof: ' + preBad.join('; '));

  const port = await allocatePort(18382);
  console.log(`[harness] port ${port}; project newsroom-media-authority-proof`);

  const mediaSecretBytes = crypto.randomBytes(32);
  const mediaSecretB64u = base64Url(mediaSecretBytes);
  const draftSecretBytes = crypto.randomBytes(32);
  const draftSecretB64u = base64Url(draftSecretBytes);
  KNOWN_SECRETS.push(mediaSecretB64u, draftSecretB64u);

  const secrets = writeRuntimeEnv({ port, mediaSecretB64u, draftSecretB64u });
  for (const s of Object.values(secrets)) KNOWN_SECRETS.push(s);

  const ctx = {
    baseUrl: `http://127.0.0.1:${port}`,
    mediaSecretBytes,
    mediaSecretB64u,
    draftSecretBytes,
    draftSecretB64u,
    secrets,
  };

  await provision(ctx);
  KNOWN_SECRETS.push(ctx.secrets.appPassword);

  try {
    await runProof(ctx);
  } finally {
    const postBad = frozenHashBad();
    const bridgeGit = runSync('git', ['status', '--porcelain', '--', 'wordpress/newsroom-bridge'], { cwd: ROOT });
    evidence(
      'final_integrity',
      'Frozen draft source byte-identical to the frozen values before and after the whole proof',
      postBad.length === 0 && bridgeGit.stdout.trim() === '',
      JSON.stringify({ frozenHashesChanged: postBad, bridgeGitDirty: bridgeGit.stdout.trim() !== '' })
    );

    const repoHits = {};
    const repoFiles = findRepoFiles(ROOT);
    for (const s of KNOWN_SECRETS.filter((x) => x && x.length >= 8)) {
      const hits = repoFiles.filter((f) => repoFileTextContains(f, s));
      if (hits.length) repoHits[s] = hits.slice(0, 5);
    }
    evidence(
      'repository_secret_scan',
      'No runtime secret or password was ever written into the repository',
      Object.keys(repoHits).length === 0,
      JSON.stringify({ hits: Object.keys(repoHits).length, samples: repoHits })
    );

    await cleanup();

    const failures = EVIDENCE.filter((e) => !e.passed).map((e) => e.key);
    const summary = {
      round: '2B.3B',
      suite: 'wordpress/runtime/media-authority-proof',
      finishedAt: new Date().toISOString(),
      total: EVIDENCE.length,
      passed: EVIDENCE.length - failures.length,
      failures,
      protected_hashes: runSync('git', ['status', '--porcelain', '--', 'wordpress/newsroom-bridge'], { cwd: ROOT }).stdout.trim() === '' ? 'unchanged' : 'CHANGED',
      results: Object.fromEntries(EVIDENCE.map((e) => [e.key, e.passed])),
      evidence: EVIDENCE.map((e) => ({ key: e.key, passed: e.passed })),
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(summary, null, 2));
    console.log(`\nRESULT: ${summary.passed}/${summary.total} passed`);
    if (summary.failures.length) {
      console.log('FAILED GROUPS: ' + summary.failures.join(', '));
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('HARNESS FATAL:', err && err.stack ? err.stack : err);
  try {
    if (fs.existsSync(ENV_FILE)) fs.rmSync(ENV_FILE);
  } catch {}
  process.exitCode = 1;
});