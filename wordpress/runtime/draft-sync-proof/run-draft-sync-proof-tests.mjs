import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireModule = createRequire(import.meta.url);

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(runtimeDir, '..', '..', '..');
const composeFile = resolve(runtimeDir, 'compose.yaml');
const envFile = resolve(runtimeDir, '.env.runtime');
const resultsFile = resolve(runtimeDir, 'runtime-results.json');
const pluginDir = resolve(repoRoot, 'wordpress', 'newsroom-bridge');
const projectName = 'newsroom-draft-sync-proof';
const tscBinary = resolve(repoRoot, 'apps/api/node_modules/typescript/bin/tsc');
const harnessTsconfig = resolve(repoRoot, 'apps/api/tsconfig.wordpress-draft-sync-harness.json');
const clientBuild = resolve(runtimeDir, '.build', 'wordpress-draft.client.js');
const repositoryScanCandidates = [
  'apps/api/src/modules/wordpress-draft/wordpress-hmac.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-hmac.spec.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.types.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.module.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.errors.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.client.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.client.spec.ts',
  'apps/api/tsconfig.wordpress-draft-sync-harness.json',
  'wordpress/newsroom-bridge/newsroom-bridge.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-auth.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-db.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-reconciliation.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-rest.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-auth.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-config.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-db.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-reconciliation.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-rest.php',
  'wordpress/runtime/draft-sync-proof/.gitignore',
  'wordpress/runtime/draft-sync-proof/compose.yaml',
  'wordpress/runtime/draft-sync-proof/README.md',
  'wordpress/runtime/draft-sync-proof/run-draft-sync-proof-tests.mjs',
  'wordpress/runtime/draft-sync-proof/fixtures/newsroom-draft-sync-fault-harness.php',
  'wordpress/runtime/draft-sync-proof/bridge/newsroom-draft-sync-proof.php',
  'wordpress/runtime/draft-sync-proof/bridge/includes/class-test-draft-sync-auth.php',
  'wordpress/runtime/draft-sync-proof/bridge/includes/class-test-draft-sync-rest.php',
  'docs/DEVELOPMENT_ROADMAP.md',
  'docs/WORDPRESS_DRAFT_SYNC_DESIGN.md',
];
const frozenHashes = {
  'includes/class-newsroom-bridge-db.php': '1362cb101031088b78e27d54b78edfac6488d9f979979a3786916839811a20fa',
  'includes/class-newsroom-bridge-reconciliation.php': '6a7ce8aec4ab3040804c217f00341275ead25ea78570fc4cc93f47cde03a373a',
  'includes/class-newsroom-bridge-rest.php': '965608c6063540985d23f9a83a679c49eee1543238c595a850100755f9cf609a',
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}
function makePng(width, height, seed = 0x00) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((1 + width * 4) * height, seed);
  const idat = deflateSync(raw);
  return Buffer.concat([PNG_MAGIC, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

const KAT_KEY = '01234567-89ab-47cd-8e01-23456789abcd';
const KAT = {
  keyId: 'draft-local-v1',
  secretB64Url: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI',
  timestamp: '1750000000',
  method: 'PUT',
  route: `/newsroom/v1/drafts/${KAT_KEY}`,
  body: `{"draft_key":"${KAT_KEY}","title":"Sync KAT Title","content":"KAT body","excerpt":"","categories":[1],"featured_media_key":null}`,
  bodySha: '640dfc46a02b12fab568f9bb5bf07728111079991c4c12c2dab579d31d7f1bab',
  canonical: `newsroom-hmac-v1\ndraft-local-v1\nPUT\n/newsroom/v1/drafts/${KAT_KEY}\n1750000000\n640dfc46a02b12fab568f9bb5bf07728111079991c4c12c2dab579d31d7f1bab`,
  signature: 'ed1ec9db1f911e63b6f22a9ab310fae9c47756ce08211e0e00561553ea6df965',
};

const knownSecrets = [];
const evidence = { started_at: new Date().toISOString(), results: [], runtime: {}, cleanup: {} };
let runtimeEnv = {};
let port = 0;
let baseUrl = '';
let categoryIds = {};
let envCreated = false;
let fatalError = '';

function redact(value) {
  let output = String(value ?? '');
  for (const secret of knownSecrets) if (secret) output = output.split(secret).join('[REDACTED]');
  return output;
}

function run(command, args, { cwd = repoRoot, env = process.env, label = command, sensitive = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    const detail = sensitive ? '[sensitive output suppressed]' : redact(result.stderr || result.stdout).trim();
    throw new Error(`${label} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function pass(name, details = {}) { evidence.results.push({ name, status: 'PASS', details }); process.stdout.write(`PASS ${name}\n`); }
function randomSecret(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
function sha256Buffer(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function protectedHashes() { return Object.fromEntries(Object.keys(frozenHashes).map((path) => [path, sha256(resolve(pluginDir, path))])); }
function productionHashes() {
  return Object.fromEntries([
    'newsroom-bridge.php',
    'includes/class-newsroom-bridge-auth.php',
    'includes/class-newsroom-bridge-security-config.php',
    'includes/class-newsroom-bridge-service-user.php',
    'includes/class-newsroom-bridge-key-ring-json.php',
    'includes/class-newsroom-bridge-db.php',
    'includes/class-newsroom-bridge-reconciliation.php',
    'includes/class-newsroom-bridge-rest.php',
    'includes/class-newsroom-bridge-media-config.php',
    'includes/class-newsroom-bridge-media-service-user.php',
    'includes/class-newsroom-bridge-media-auth.php',
    'includes/class-newsroom-bridge-media-db.php',
    'includes/class-newsroom-bridge-media-reconciliation.php',
    'includes/class-newsroom-bridge-media-rest.php',
  ].map((path) => [path, sha256(resolve(pluginDir, path))]));
}
function sqlEscape(value) { return String(value).replaceAll('\\', '\\\\').replaceAll("'", "''"); }
function decodeDraftSecret(encoded) { return Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4), 'base64'); }
function base64UrlEncode(buffer) { return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function stateFingerprint(state) {
  const canonical = { contract_version: 1, title: state.title, content: state.content, excerpt: state.excerpt, categories: [...state.categories].sort((a, b) => a - b), featured_media_key: state.featured_media_key };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function payloadFingerprint(payload) {
  const canonical = { contract_version: 1, title: payload.title, content: payload.content, excerpt: payload.excerpt, categories: [...payload.categories].sort((a, b) => a - b) };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function availablePort(start) {
  for (let candidate = start; candidate < start + 100; candidate += 1) {
    const free = await new Promise((done) => {
      const server = net.createServer();
      server.once('error', () => done(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => done(true)));
    });
    if (free) return candidate;
  }
  throw new Error('No loopback test port is available.');
}

function assertLoopback(url) {
  const host = new URL(url).hostname;
  assert(['127.0.0.1', 'localhost', '::1'].includes(host), `Refusing non-loopback target ${host}.`);
}

function writeRuntimeEnv() {
  writeFileSync(envFile, Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  envCreated = true;
}

function compose(args, options = {}) {
  return run('docker', ['compose', '--project-name', projectName, '--env-file', envFile, '--file', composeFile, ...args], {
    ...options, cwd: runtimeDir, env: { ...process.env, ...runtimeEnv }, label: options.label ?? `compose ${args[0] ?? ''}`,
  });
}
function wp(args, options = {}) { return compose(['exec', '-T', 'cli', 'wp', ...args], { ...options, label: options.label ?? `wp ${args[0] ?? ''}` }).stdout.trim(); }
function wpEval(script, options = {}) { return wp(['eval', script], options); }
function db(query) { return wp(['db', 'query', query, '--skip-column-names', '--silent'], { label: 'database query' }).trim(); }
function transient(tx, key) { return wp(['transient', tx, key], { label: `transient ${tx}` }); }
function faultPhase(phase) { return phase ? wp(['option', 'update', 'test_draft_sync_fault_phase', phase], { label: 'fault set' }) : wp(['option', 'delete', 'test_draft_sync_fault_phase'], { label: 'fault clear', allowFailure: true }); }

function request(method, path, { headers = {}, body, base = baseUrl } = {}) {
  const url = new URL(path, base);
  assertLoopback(url);
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return new Promise((resolveRequest, rejectRequest) => {
    const requestHeaders = { connection: 'close', ...headers };
    if (payload.length > 0 && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'content-length')) requestHeaders['content-length'] = String(payload.length);
    const outgoing = http.request(url, { method, headers: requestHeaders }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveRequest({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    outgoing.setTimeout(60000, () => outgoing.destroy(new Error('request timeout')));
    outgoing.on('error', rejectRequest);
    if (payload.length > 0) outgoing.write(payload);
    outgoing.end();
  });
}

async function waitForHttp() {
  let consecutiveSuccesses = 0;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await request('GET', '/');
      consecutiveSuccesses = [200, 302].includes(response.status) ? consecutiveSuccesses + 1 : 0;
      if (consecutiveSuccesses >= 3) return;
    } catch {
      consecutiveSuccesses = 0;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error('Disposable WordPress did not become ready.');
}

function draftRow(draftKey) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),draft_key,COALESCE(post_id,'NULL'),payload_hash,actor_user_id,COALESCE(reservation_token,'NULL')) FROM wp_newsroom_reconciliation WHERE draft_key='${sqlEscape(draftKey)}'`);
  if (!row) return null;
  const [key, postId, payloadHash, actorUserId, reservationToken] = row.split(String.raw`\t`);
  return { draftKey: key, postId: postId === 'NULL' ? null : Number(postId), payloadHash, actorUserId: Number(actorUserId), reservationToken: reservationToken === 'NULL' ? null : reservationToken };
}
function mediaRow(mediaKey) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),media_key,COALESCE(attachment_id,'NULL'),payload_hash,actor_user_id,COALESCE(reservation_token,'NULL')) FROM wp_newsroom_media WHERE media_key='${sqlEscape(mediaKey)}'`);
  if (!row) return null;
  const [key, attachmentId, payloadHash, actorUserId, reservationToken] = row.split(String.raw`\t`);
  return { mediaKey: key, attachmentId: attachmentId === 'NULL' ? null : Number(attachmentId), payloadHash, actorUserId: Number(actorUserId), reservationToken: reservationToken === 'NULL' ? null : reservationToken };
}
function queryScalar(query) { return db(query); }
function mediaRowCount(mediaKey) { return Number(queryScalar(`SELECT COUNT(*) FROM wp_newsroom_media WHERE media_key='${sqlEscape(mediaKey)}'`)); }
function postInfo(postId) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),ID,post_status,post_author,post_title,post_content,post_excerpt) FROM wp_posts WHERE ID=${Number(postId)}`);
  if (!row) return null;
  const [id, status, author, title, content, excerpt] = row.split(String.raw`\t`);
  return { id: Number(id), status, author: Number(author), title, content, excerpt };
}
function postCategoryIds(postId) {
  const value = db(`SELECT GROUP_CONCAT(t.term_id ORDER BY t.term_id SEPARATOR ',') FROM wp_term_relationships tr INNER JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id INNER JOIN wp_terms t ON t.term_id = tt.term_id WHERE tr.object_id = ${Number(postId)} AND tt.taxonomy = 'category'`);
  return value ? value.split(',').map(Number) : [];
}
function postThumbnail(postId) { const value = db(`SELECT meta_value FROM wp_postmeta WHERE post_id=${Number(postId)} AND meta_key='_thumbnail_id'`); return value ? Number(value) : null; }
function attachmentInfo(id) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),ID,post_status,post_type,post_mime_type,post_author) FROM wp_posts WHERE ID=${Number(id)}`);
  if (!row) return null;
  const [postId, status, type, mime, author] = row.split(String.raw`\t`);
  return { id: Number(postId), status, type, mime, author: Number(author) };
}
function attachmentKeyMeta(attachmentId) { return db(`SELECT meta_value FROM wp_postmeta WHERE post_id=${Number(attachmentId)} AND meta_key='_newsroom_media_key'`); }
function attachmentFileMeta(attachmentId) { return db(`SELECT meta_value FROM wp_postmeta WHERE post_id=${Number(attachmentId)} AND meta_key='_newsroom_media_file'`); }
function managedMediaDir() {
  const base = wpEval('echo wp_upload_dir()["basedir"];');
  const sub = wpEval('echo wp_upload_dir()["subdir"];');
  return `${base}${sub}/newsroom-media`;
}
function userCap(userId, cap) { return wpEval(`echo user_can( ${Number(userId)}, '${sqlEscape(cap)}' ) ? '1' : '0';`); }

function rawDraftSignedRequest(method, route, { keyId, secret, body = Buffer.alloc(0), timestampSec = null, base = baseUrl } = {}) {
  const timestamp = timestampSec ?? String(Math.floor(Date.now() / 1000));
  const canonical = ['newsroom-hmac-v1', keyId, method, route, timestamp, sha256Buffer(body)].join('\n');
  const signature = createHmac('sha256', decodeDraftSecret(secret)).update(canonical).digest('hex');
  const headers = {
    'x-newsroom-auth-version': '1',
    'x-newsroom-key-id': keyId,
    'x-newsroom-timestamp': timestamp,
    'x-newsroom-signature': signature,
  };
  if (method === 'POST' || method === 'PUT') headers['content-type'] = 'application/json';
  return request(method, `/wp-json${route}`, { headers, body: method === 'GET' ? undefined : body, base });
}

function rawMediaSignedUpload({ keyId, secret, mediaKey, filename, mime, body }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = ['newsroom-media-hmac-v1', keyId, 'POST', '/newsroom-media/v1/media', timestamp, mediaKey,
    sha256Buffer(Buffer.from(filename, 'utf8')), mime, sha256Buffer(body)].join('\n');
  const signature = createHmac('sha256', decodeDraftSecret(secret)).update(canonical).digest('hex');
  return request('POST', '/wp-json/newsroom-media/v1/media', {
    headers: {
      'x-newsroom-media-auth-version': '1',
      'x-newsroom-media-key-id': keyId,
      'x-newsroom-media-timestamp': timestamp,
      'x-newsroom-media-signature': signature,
      'x-newsroom-media-key': mediaKey,
      'x-newsroom-media-filename': filename,
      'x-newsroom-media-mime': mime,
      'content-type': 'application/octet-stream',
    },
    body,
  });
}

function createProxy(handler, upstreamBase) {
  const requests = [];
  const server = http.createServer((clientRequest, clientResponse) => {
    const chunks = [];
    clientRequest.on('data', (chunk) => chunks.push(chunk));
    clientRequest.on('end', () => {
      const body = Buffer.concat(chunks);
      const entry = { method: clientRequest.method ?? '', path: clientRequest.url ?? '/', headers: { ...clientRequest.headers }, body, upstream: null, clientStatus: null, error: null };
      requests.push(entry);
      const upstream = () => new Promise((resolveUpstream, rejectUpstream) => {
        const target = new URL(clientRequest.url ?? '/', upstreamBase);
        assertLoopback(target);
        const outHeaders = { ...entry.headers, 'accept-encoding': 'identity' };
        delete outHeaders.host;
        delete outHeaders['content-length'];
        if (entry.body.length > 0) outHeaders['content-length'] = String(entry.body.length);
        const upstreamRequest = http.request(target, { method: clientRequest.method, headers: outHeaders }, (upstreamResponse) => {
          const pieces = [];
          upstreamResponse.on('data', (chunk) => pieces.push(chunk));
          upstreamResponse.on('end', () => {
            const upstreamResult = { status: upstreamResponse.statusCode ?? 0, text: Buffer.concat(pieces).toString('utf8'), headers: upstreamResponse.headers };
            entry.upstream = upstreamResult;
            resolveUpstream(upstreamResult);
          });
        });
        upstreamRequest.on('error', (error) => { entry.error = String(error?.message ?? error); rejectUpstream(error); });
        if (entry.body.length > 0) upstreamRequest.end(entry.body);
        else upstreamRequest.end();
      });
      const respond = (status, body, headers = {}) => {
        entry.clientStatus = status;
        clientResponse.statusCode = status;
        for (const [name, value] of Object.entries(headers)) clientResponse.setHeader(name, value);
        clientResponse.end(body === undefined || body === null ? undefined : body);
      };
      const destroy = () => { clientResponse.destroy(); };
      const helpers = { upstream, respond, destroy };
      Promise.resolve(handler(entry, helpers).catch((error) => { entry.error = String(error?.message ?? error); try { destroy(); } catch { /* best effort */ } })).catch(() => {});
    });
  });
  const listen = () => new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolveListen(); });
  });
  return { server, requests, listen, close: () => new Promise((resolveClose) => { server.closeAllConnections?.(); server.close(resolveClose); }), url: () => `http://127.0.0.1:${server.address().port}` };
}

function dropAfterCommit(upstreamBase) {
  return createProxy(async (entry, { upstream, respond, destroy }) => {
    const result = await upstream();
    if (entry.method === 'PUT') { destroy(); return; }
    respond(result.status, result.text, { 'content-type': result.headers['content-type'] ?? 'application/json' });
  }, upstreamBase);
}
function dropFirstPutThenPassthrough(upstreamBase) {
  let droppedFirstPut = false;
  return createProxy(async (entry, { upstream, respond, destroy }) => {
    if (entry.method === 'PUT' && !droppedFirstPut) {
      droppedFirstPut = true;
      destroy();
      return;
    }
    const result = await upstream();
    respond(result.status, result.text, { 'content-type': result.headers['content-type'] ?? 'application/json' });
  }, upstreamBase);
}

function repositorySecretOccurrences(secret) {
  assert(repositoryScanCandidates.length > 0, 'Repository scan candidate list is empty.');
  const rootEnv = resolve(repoRoot, '.env');
  const candidates = repositoryScanCandidates.map((path) => resolve(repoRoot, path));
  assert(!candidates.some((path) => path === rootEnv || (/^\.env(?:\.|$)/.test(path.slice(repoRoot.length + 1)) && !/^\.env\.example$/.test(path.slice(repoRoot.length + 1)))), 'Repository scan candidate includes a root environment file.');
  let count = 0;
  for (const path of candidates) {
    assert(path.startsWith(`${repoRoot}\\`) && existsSync(path), 'Repository scan candidate is missing or outside the repository.');
    if (readFileSync(path).includes(secret)) count += 1;
  }
  return { count, filesExamined: candidates.length, rootEnvExcluded: true };
}

(async () => {
  try {
    assert(existsSync(tscBinary), 'TypeScript compiler is not available for the harness build.');
    run('node', [tscBinary, '-p', harnessTsconfig], { label: 'client build' });
    assert(existsSync(clientBuild), 'Compiled WordPressDraftClient is missing.');
    const { WordPressDraftClient } = requireModule(clientBuild);
    const { WordPressDraftError } = requireModule(resolve(runtimeDir, '.build', 'wordpress-draft.errors.js'));

    port = await availablePort(18371);
    baseUrl = `http://127.0.0.1:${port}`;
    assertLoopback(baseUrl);
    const draftKeyId = 'draft-local-v1';
    const mediaKeyId = 'media-local-v1';
    const draftSecret = randomSecret();
    const mediaSecret = randomSecret();
    runtimeEnv = {
      NEWSROOM_TEST_PORT: String(port),
      RUNTIME_DB_PASSWORD: randomSecret(),
      RUNTIME_DB_ROOT_PASSWORD: randomSecret(),
      ADMIN_PASSWORD: randomSecret(),
      NEWSROOM_BRIDGE_USER_ID: '3',
      NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: '1',
      NEWSROOM_BRIDGE_HMAC_ENABLED: '1',
      NEWSROOM_BRIDGE_MEDIA_USER_ID: '2',
      NEWSROOM_BRIDGE_MEDIA_HMAC_ENABLED: '1',
      NEWSROOM_BRIDGE_MEDIA_SERVICE_LOCKDOWN_ENABLED: '1',
      NEWSROOM_BRIDGE_MEDIA_MAX_BYTES: '100000',
      NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED: '1',
    };
    runtimeEnv.NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON = JSON.stringify([{ id: draftKeyId, secret: draftSecret }]);
    runtimeEnv.NEWSROOM_BRIDGE_MEDIA_HMAC_KEYS_JSON = JSON.stringify([{ id: mediaKeyId, secret: mediaSecret }]);
    const nonSecretRuntimeValues = ['3', '2', '1', mediaKeyId, draftKeyId, String(port)];
    knownSecrets.push(...Object.values(runtimeEnv).filter((value) => !nonSecretRuntimeValues.includes(value) && value.length >= 8));
    writeRuntimeEnv();

    assert(JSON.stringify(protectedHashes()) === JSON.stringify(frozenHashes), 'Frozen reconciliation hashes differ before runtime.');
    const productionSnapshot = productionHashes();

    compose(['pull'], { label: 'Docker image pull' });
    compose(['up', '-d', 'db', 'wordpress', 'cli'], { sensitive: true, label: 'runtime startup' });
    await waitForHttp();

    const phpLintFiles = [
      '/var/www/html/wp-content/plugins/newsroom-draft-sync-proof/newsroom-draft-sync-proof.php',
      '/var/www/html/wp-content/plugins/newsroom-draft-sync-proof/includes/class-test-draft-sync-auth.php',
      '/var/www/html/wp-content/plugins/newsroom-draft-sync-proof/includes/class-test-draft-sync-rest.php',
      '/var/www/html/wp-content/mu-plugins/newsroom-draft-sync-fault-harness.php',
      '/var/www/html/wp-content/plugins/newsroom-bridge/includes/class-newsroom-bridge-db.php',
      '/var/www/html/wp-content/plugins/newsroom-bridge/includes/class-newsroom-bridge-reconciliation.php',
      '/var/www/html/wp-content/plugins/newsroom-bridge/includes/class-newsroom-bridge-rest.php',
    ];
    const phpLintResults = {};
    for (const file of phpLintFiles) {
      compose(['exec', '-T', 'wordpress', 'php', '-l', file], { allowFailure: false, label: `php lint ${file.split('/').pop()}` });
      phpLintResults[file.split('/').pop()] = 'ok';
    }
    const phpLintEngine = compose(['exec', '-T', 'wordpress', 'php', '-r', 'echo PHP_VERSION;'], { label: 'php engine' }).stdout.trim();
    pass('php_lint_runtime', { engine: phpLintEngine, files_linted: phpLintFiles.length, results: phpLintResults });

    wp(['core', 'install', `--url=${baseUrl}`, '--title=Newsroom Draft Sync Proof Runtime', '--admin_user=runtime_admin', `--admin_password=${runtimeEnv.ADMIN_PASSWORD}`, '--admin_email=admin@example.invalid', '--skip-email'], { sensitive: true });
    wpEval("foreach ( get_posts( array( 'post_type' => 'post', 'numberposts' => -1, 'post_status' => 'any' ) ) as $p ) { wp_delete_post( $p->ID, true ); } echo 'ok';");
    wp(['rewrite', 'structure', '/%postname%/', '--hard']);
    wpEval("add_role( 'newsroom_media_service', 'Newsroom Media Service', array( 'read' => true, 'upload_files' => true ) ); echo 'ok';");
    wpEval("add_role( 'newsroom_draft_service', 'Newsroom Draft Service', array( 'read' => true, 'edit_posts' => true, 'assign_categories' => true ) ); echo 'ok';");
    const mediaUserId = Number(wp(['user', 'create', 'runtime_media', 'media@example.invalid', '--role=newsroom_media_service', `--user_pass=${runtimeEnv.ADMIN_PASSWORD}`, '--porcelain'], { sensitive: true }));
    const draftUserId = Number(wp(['user', 'create', 'runtime_draft', 'draft@example.invalid', '--role=newsroom_draft_service', `--user_pass=${runtimeEnv.ADMIN_PASSWORD}`, '--porcelain'], { sensitive: true }));
    const authorUserId = Number(wp(['user', 'create', 'runtime_author', 'author@example.invalid', '--role=author', `--user_pass=${runtimeEnv.ADMIN_PASSWORD}`, '--porcelain'], { sensitive: true }));
    assert(mediaUserId === 2 && draftUserId === 3 && authorUserId === 4, 'User fixture IDs do not match the isolated plan.');
    categoryIds = {};
    for (const name of ['catA', 'catB', 'catC']) {
      const id = Number(wp(['term', 'create', 'category', name, '--porcelain']));
      assert(Number.isInteger(id) && id > 0, `Fixture category ${name} could not be created.`);
      categoryIds[name] = id;
    }

    wp(['plugin', 'activate', 'newsroom-draft-sync-proof']);
    const prodStatus = wp(['plugin', 'get', 'newsroom-bridge', '--field=status']);
    assert(prodStatus === 'inactive', 'Production newsroom-bridge plugin must stay inactive in the proof runtime.');
    const proofStatus = wp(['plugin', 'get', 'newsroom-draft-sync-proof', '--field=status']);
    const proofVersion = wp(['plugin', 'get', 'newsroom-draft-sync-proof', '--field=version']);
    const constantsOk = wpEval('echo defined( \'NEWSROOM_BRIDGE_VERSION\' ) && defined( \'NEWSROOM_BRIDGE_SCHEMA_VERSION\' ) && defined( \'NEWSROOM_BRIDGE_MEDIA_SCHEMA_VERSION\' ) && defined( \'NEWSROOM_DRAFT_SYNC_PROOF\' ) ? NEWSROOM_BRIDGE_VERSION . \'|\' . NEWSROOM_BRIDGE_SCHEMA_VERSION . \'|\' . NEWSROOM_BRIDGE_MEDIA_SCHEMA_VERSION : \'\';');
    assert(proofStatus === 'active' && proofVersion === '0.1.0' && constantsOk === '1.2.0|2|1', `Proof plugin activation disagreement (status=${proofStatus}, version=${proofVersion}, constants=${constantsOk}).`);
    assert(wp(['option', 'get', 'newsroom_bridge_schema_version']) === '2', 'Draft schema version changed.');
    assert(wp(['option', 'get', 'newsroom_bridge_media_schema_version']) === '1', 'Media schema version changed.');
    const newsroomTables = db("SHOW TABLES LIKE 'wp_newsroom%'").split(/\r?\n/).filter(Boolean);
    assert(JSON.stringify(newsroomTables) === JSON.stringify(['wp_newsroom_media', 'wp_newsroom_reconciliation']), 'Unexpected newsroom database tables exist.');

    const syncRouteInfo = wpEval(`
      $routes = rest_get_server()->get_routes();
      $checks = array(
        'sync_put' => isset( $routes['/newsroom/v1/drafts/(?P<draft_key>[a-f0-9-]{36})'] ),
        'sync_state' => isset( $routes['/newsroom/v1/drafts/(?P<draft_key>[a-f0-9-]{36})/state'] ),
      );
      echo $checks['sync_put'] && $checks['sync_state'] ? 'both' : 'missing';
    `);
    assert(syncRouteInfo === 'both', 'Sync routes were not registered on the proof server.');

    const draftCapsOk = userCap(draftUserId, 'read') === '1' && userCap(draftUserId, 'edit_posts') === '1'
      && userCap(draftUserId, 'assign_categories') === '1' && userCap(draftUserId, 'upload_files') === '0'
      && userCap(draftUserId, 'publish_posts') === '0' && userCap(draftUserId, 'manage_options') === '0'
      && userCap(draftUserId, 'unfiltered_html') === '0' && userCap(draftUserId, 'activate_plugins') === '0';
    const mediaCapsOk = userCap(mediaUserId, 'read') === '1' && userCap(mediaUserId, 'upload_files') === '1'
      && userCap(mediaUserId, 'edit_posts') === '0' && userCap(mediaUserId, 'publish_posts') === '0';
    assert(draftCapsOk && mediaCapsOk, 'Draft/media service policies do not match the approved capability model.');
    pass('activation_and_schema', { plugin: 'active', prototype: '0.1.0', bridge: '1.2.0', draft_schema: '2', media_schema: '1', tables: newsroomTables, routes: syncRouteInfo, draft_user: draftUserId, media_user: mediaUserId, production_plugin: 'inactive' });

    const pngA = makePng(4, 4);
    const pngB = makePng(4, 4, 0x42);

    const draftCreateInput = (draftKey, headline, content, excerpt = '', categoryIdsValue = [categoryIds.catA]) => ({
      draft_key: draftKey, title: headline, content, excerpt, categories: categoryIdsValue,
    });
    const syncInput = (draftKey, headline, content, excerpt = '', categoriesValue = [categoryIds.catA], featured = null, expectedVersion = undefined) => {
      const body = { draft_key: draftKey, title: headline, content, excerpt, categories: categoriesValue, featured_media_key: featured };
      if (expectedVersion !== undefined && expectedVersion !== null) body.expected_version = expectedVersion;
      return body;
    };
    const syncBody = (draftKey, headline, content, excerpt = '', categoriesValue = [categoryIds.catA], featured = null, expectedVersion = undefined) =>
      Buffer.from(JSON.stringify(syncInput(draftKey, headline, content, excerpt, categoriesValue, featured, expectedVersion)), 'utf8');
    const syncRoute = (draftKey) => `/newsroom/v1/drafts/${draftKey}`;
    const stateRoute = (draftKey) => `/newsroom/v1/drafts/${draftKey}/state`;

    const draftPostCreate = (draftKey, headline, content, excerpt = '', categoriesValue = [categoryIds.catA]) =>
      rawDraftSignedRequest('POST', '/newsroom/v1/drafts', { keyId: draftKeyId, secret: draftSecret, body: Buffer.from(JSON.stringify(draftCreateInput(draftKey, headline, content, excerpt, categoriesValue)), 'utf8') });
    const draftPutSync = (draftKey, headline, content, excerpt = '', categoriesValue = [categoryIds.catA], featured = null, expectedVersion = undefined, overrides = {}) =>
      rawDraftSignedRequest('PUT', syncRoute(draftKey), { keyId: draftKeyId, secret: draftSecret, body: syncBody(draftKey, headline, content, excerpt, categoriesValue, featured, expectedVersion), ...overrides });
    const draftGetState = (draftKey, overrides = {}) => rawDraftSignedRequest('GET', stateRoute(draftKey), { keyId: draftKeyId, secret: draftSecret, ...overrides });

    const clientOptions = () => ({ baseUrl, keyId: draftKeyId, secret: draftSecret, requestTimeoutMs: 5000, reconciliationAttempts: 3, reconciliationDelayMs: 20 });
    const client = new WordPressDraftClient(clientOptions());

    const draftKeyA = randomUUID();
    const clientCreated = await client.createDraft({ wordpressDraftKey: draftKeyA, headline: 'Frozen Client Create', body: 'Frozen client body A', excerpt: '', wordpressCategoryIds: [categoryIds.catA] });
    assert(clientCreated.outcome === 'CREATED' && clientCreated.wordpressDraftKey === draftKeyA && clientCreated.wordpressPostId > 0 && clientCreated.status === 'draft', 'Frozen draft client did not create the draft.');
    const clientCreatedRow = draftRow(draftKeyA);
    assert(clientCreatedRow && clientCreatedRow.postId === clientCreated.wordpressPostId && clientCreatedRow.actorUserId === draftUserId && clientCreatedRow.reservationToken === null, 'Frozen client create diverged from the committed reconciliation row.');
    pass('draft_client_create_201', { handler: 'committed Newsroom_Bridge_REST', loader: 'test-only plugin', outcome: 'CREATED', post_id: clientCreated.wordpressPostId, author: draftUserId });

    const clientRead = await client.getDraftByKey(draftKeyA);
    assert(clientRead.wordpressPostId === clientCreated.wordpressPostId && clientRead.status === 'draft', 'Frozen client get did not reconcile.');
    pass('draft_client_get_200', { handler: 'committed Newsroom_Bridge_REST', loader: 'test-only plugin', post_id: clientRead.wordpressPostId });

    const clientReplay = await client.createDraft({ wordpressDraftKey: draftKeyA, headline: 'Frozen Client Create', body: 'Frozen client body A', excerpt: '', wordpressCategoryIds: [categoryIds.catA] });
    assert(clientReplay.outcome === 'REPLAYED' && clientReplay.wordpressPostId === clientCreated.wordpressPostId, 'Frozen client replay did not preserve the existing post.');
    pass('draft_client_replay_200', { handler: 'committed Newsroom_Bridge_REST', loader: 'test-only plugin', outcome: 'REPLAYED', post_id: clientReplay.wordpressPostId });

    const conflicting = await draftPostCreate(draftKeyA, 'Frozen Client Create', 'Conflicting frozen client body');
    assert(conflicting.status === 409, `Changed-payload draft POST did not conflict (status ${conflicting.status}).`);
    pass('draft_bridge_conflict_409', { handler: 'committed Newsroom_Bridge_REST', loader: 'test-only plugin', http: 409, preserved_post: clientCreated.wordpressPostId });

    const mediaCreated = await rawMediaSignedUpload({ keyId: mediaKeyId, secret: mediaSecret, mediaKey: randomUUID(), filename: 'hero.png', mime: 'image/png', body: pngA });
    assert(mediaCreated.status === 201, `Media HMAC upload failed in the proof runtime (status ${mediaCreated.status}, text ${mediaCreated.text.slice(0, 160)}).`);
    const mediaCreatedBody = JSON.parse(mediaCreated.text);
    const mediaKeyA = mediaCreatedBody.media_key;
    const mediaAttachmentA = mediaCreatedBody.attachment_id;
    assert(typeof mediaKeyA === 'string' && typeof mediaAttachmentA === 'number' && mediaAttachmentA > 0, 'Media upload DTO is malformed.');
    pass('media_upload_201', { handler: 'committed Newsroom_Bridge_Media_REST', loader: 'test-only plugin', via: 'media-hmac', attachment: mediaAttachmentA });

    const katCanonical = ['newsroom-hmac-v1', KAT.keyId, KAT.method, KAT.route, KAT.timestamp, sha256Buffer(Buffer.from(KAT.body, 'utf8'))].join('\n');
    assert(katCanonical === KAT.canonical && sha256Buffer(Buffer.from(KAT.body, 'utf8')) === KAT.bodySha, 'KAT canonical or body hash disagrees with the recorded vector.');
    const katSignature = createHmac('sha256', decodeDraftSecret(KAT.secretB64Url)).update(KAT.canonical).digest('hex');
    assert(katSignature === KAT.signature, `KAT signature derivation disagrees with the recorded vector (got ${katSignature}).`);
    pass('kat_vector_offline', { canonical: KAT.canonical, body_sha256: KAT.bodySha, signature: KAT.signature, matches: true });

    const katKey = KAT_KEY;
    const katCreated = await draftPostCreate(katKey, 'Sync KAT Title', 'KAT body', '', [1]);
    assert(katCreated.status === 201, `KAT draft key could not be created for the live KAT (status ${katCreated.status}).`);
    const katPostId = JSON.parse(katCreated.text).post_id;
    const katLive = await rawDraftSignedRequest('PUT', syncRoute(katKey), { keyId: draftKeyId, secret: draftSecret, body: Buffer.from(KAT.body, 'utf8') });
    assert(katLive.status === 200, `Live KAT body did not sync (status ${katLive.status}, text ${katLive.text.slice(0, 160)}).`);
    const katLiveBody = JSON.parse(katLive.text);
    const expectedKatVersion = stateFingerprint({ title: 'Sync KAT Title', content: 'KAT body', excerpt: '', categories: [1], featured_media_key: null });
    assert(katLiveBody.applied_version === expectedKatVersion && katLiveBody.status === 'draft' && katLiveBody.post_id === katPostId, 'Live KAT applied version disagrees with the independent fingerprint.');
    const katMockedRow = draftRow(katKey);
    assert(katMockedRow && katMockedRow.postId === katPostId && katMockedRow.payloadHash === payloadFingerprint({ title: 'Sync KAT Title', content: 'KAT body', excerpt: '', categories: [1] }), 'KAT sync reconciliation row is inconsistent.');
    pass('kat_live_put_200', { http: 200, post_id: katPostId, applied_version: katLiveBody.applied_version, canonical_body_reused: true });

    const state1 = await draftGetState(katKey);
    assert(state1.status === 200, `State GET failed (status ${state1.status}).`);
    const state1Body = JSON.parse(state1.text);
    assert(state1Body.draft_key === katKey && state1Body.status === 'draft' && state1Body.title === 'Sync KAT Title'
      && state1Body.content === 'KAT body' && state1Body.excerpt === '' && JSON.stringify(state1Body.categories) === JSON.stringify([1])
      && state1Body.featured_media_key === null && state1Body.applied_version === expectedKatVersion, 'State GET does not reflect the applied canonical state.');
    pass('state_get_200', { applied_version: state1Body.applied_version, featured: null });

    const katReplay = await rawDraftSignedRequest('PUT', syncRoute(katKey), { keyId: draftKeyId, secret: draftSecret, body: Buffer.from(KAT.body, 'utf8') });
    assert(katReplay.status === 200, `Identical KAT replay was not 200 (status ${katReplay.status}).`);
    const katReplayBody = JSON.parse(katReplay.text);
    assert(katReplayBody.replayed === true && katReplayBody.post_id === katPostId && katReplayBody.applied_version === expectedKatVersion, 'KAT replay did not preserve the post and version.');
    assert(draftRow(katKey)?.payloadHash === payloadFingerprint({ title: 'Sync KAT Title', content: 'KAT body', excerpt: '', categories: [1] }), 'KAT replay changed the reconciliation fingerprint.');
    pass('sync_replay_200', { replayed: true, version_stable: true });

    const syncKey = randomUUID();
    const syncCreated = await draftPostCreate(syncKey, 'Initial Draft', 'Initial body', '', [categoryIds.catA]);
    assert(syncCreated.status === 201, `Sync fixture create failed (status ${syncCreated.status}).`);
    const syncPostId = JSON.parse(syncCreated.text).post_id;
    const fullState = { title: 'Full State Headline', content: 'Full state content body', excerpt: 'Full excerpt', categories: [categoryIds.catB, categoryIds.catA], featured_media_key: null };
    const fullPut = await draftPutSync(syncKey, fullState.title, fullState.content, fullState.excerpt, fullState.categories, null);
    assert(fullPut.status === 200, `Full-state sync failed (status ${fullPut.status}, text ${fullPut.text.slice(0, 160)}).`);
    const fullPutBody = JSON.parse(fullPut.text);
    const fullPutExpected = stateFingerprint(fullState);
    assert(fullPutBody.applied_version === fullPutExpected && fullPutBody.replayed === false, 'Full-state sync returned a wrong applied version.');
    const fullPost = postInfo(syncPostId);
    assert(fullPost && fullPost.title === fullState.title && fullPost.content === fullState.content && fullPost.excerpt === fullState.excerpt
      && fullPost.status === 'draft' && fullPost.author === draftUserId, 'Full-state sync did not write the exact post fields.');
    assert(JSON.stringify(postCategoryIds(syncPostId)) === JSON.stringify([categoryIds.catA, categoryIds.catB]), 'Full-state sync category assignment is not exact.');
    assert(draftRow(syncKey)?.payloadHash === payloadFingerprint(fullState), 'Full-state sync did not refresh the reconciliation fingerprint.');
    pass('full_state_put_200', { http: 200, applied_version: fullPutBody.applied_version, status: 'draft', author: draftUserId });

    const replaceTarget = { title: 'Category Replace Title', content: 'Category replace body', excerpt: '', categories: [categoryIds.catB], featured_media_key: null };
    const replacePut = await draftPutSync(syncKey, replaceTarget.title, replaceTarget.content, replaceTarget.excerpt, replaceTarget.categories, null);
    assert(replacePut.status === 200, `Category-exact replace failed (status ${replacePut.status}).`);
    assert(JSON.stringify(postCategoryIds(syncPostId)) === JSON.stringify([categoryIds.catB]), 'Category replacement did not discard catA exactly.');
    const replacePutState = JSON.parse((await draftGetState(syncKey)).text);
    assert(JSON.stringify(replacePutState.categories) === JSON.stringify([categoryIds.catB]) && replacePutState.applied_version === stateFingerprint(replaceTarget), 'Category-exact state is not consistent.');
    pass('exact_category_replacement', { after: [categoryIds.catB] });

    const multiTarget = { title: 'Multi Category Title', content: 'Multi category body', excerpt: '', categories: [categoryIds.catA, categoryIds.catC, categoryIds.catB], featured_media_key: null };
    const multiPut = await draftPutSync(syncKey, multiTarget.title, multiTarget.content, multiTarget.excerpt, multiTarget.categories, null);
    assert(multiPut.status === 200, `Multi-category sync failed (status ${multiPut.status}).`);
    assert(JSON.stringify(postCategoryIds(syncPostId)) === JSON.stringify([categoryIds.catA, categoryIds.catB, categoryIds.catC].sort((a, b) => a - b)), 'Multi-category sync did not assign every category exactly once.');
    pass('multi_category_assign', { categories: 3 });

    const mediaKeyB = randomUUID();
    const mediaBCreated = await rawMediaSignedUpload({ keyId: mediaKeyId, secret: mediaSecret, mediaKey: mediaKeyB, filename: 'featured.png', mime: 'image/png', body: makePng(8, 8, 0x11) });
    assert(mediaBCreated.status === 201, `Featured media fixture upload failed (status ${mediaBCreated.status}).`);
    const mediaAttachmentB = JSON.parse(mediaBCreated.text).attachment_id;
    assert(mediaRow(mediaKeyB)?.attachmentId === mediaAttachmentB && mediaRow(mediaKeyB)?.reservationToken === null, 'Featured media fixture row is not committed.');
    pass('media_featured_fixture', { media_key: mediaKeyB, attachment: mediaAttachmentB });

    const featuredBody = { title: 'Featured Set Title', content: 'Featured set body', excerpt: '', categories: [categoryIds.catA], featured_media_key: mediaKeyB };
    const featuredPut = await draftPutSync(syncKey, featuredBody.title, featuredBody.content, featuredBody.excerpt, featuredBody.categories, mediaKeyB);
    assert(featuredPut.status === 200, `Featured set failed (status ${featuredPut.status}, text ${featuredPut.text.slice(0, 160)}).`);
    assert(postThumbnail(syncPostId) === mediaAttachmentB, 'Featured set did not assign the resolved attachment id.');
    const featuredState = JSON.parse((await draftGetState(syncKey)).text);
    assert(featuredState.featured_media_key === mediaKeyB && featuredState.applied_version === stateFingerprint({ ...featuredBody, categories: [categoryIds.catA] }), 'Featured state does not report the bound media key.');
    const mediaBMeta = attachmentKeyMeta(mediaAttachmentB);
    assert(mediaBMeta === mediaKeyB, 'Featured assignment corrupted the media key binding.');
    pass('featured_set_by_media_key', { thumbnail: mediaAttachmentB, media_key: mediaKeyB });

    const featuredA = mediaKeyA;
    const swapPut = await draftPutSync(syncKey, featuredBody.title, featuredBody.content, featuredBody.excerpt, featuredBody.categories, featuredA);
    assert(swapPut.status === 200, `Featured swap A->B failed (status ${swapPut.status}).`);
    assert(postThumbnail(syncPostId) === mediaAttachmentA, 'Featured swap did not move the thumbnail to the new key.');
    const swapPrev = attachmentInfo(mediaAttachmentB);
    assert(swapPrev && swapPrev.type === 'attachment' && mediaRow(mediaKeyB)?.attachmentId === mediaAttachmentB, 'Featured swap harmed the previous attachment or its row.');
    pass('featured_swap_a_to_b', { previous_attachment_intact: true });

    const clearPut = await draftPutSync(syncKey, featuredBody.title, featuredBody.content, featuredBody.excerpt, featuredBody.categories, null);
    assert(clearPut.status === 200, `Featured clear failed (status ${clearPut.status}).`);
    assert(postThumbnail(syncPostId) === null, 'Featured clear did not remove _thumbnail_id.');
    const clearAttA = attachmentInfo(mediaAttachmentA);
    const clearAttB = attachmentInfo(mediaAttachmentB);
    assert(clearAttA && clearAttA.type === 'attachment' && clearAttB && clearAttB.type === 'attachment'
      && mediaRowCount(mediaKeyA) === 1 && mediaRowCount(mediaKeyB) === 1, 'Featured clear deleted an attachment or media row; it must only clear the pointer.');
    const clearedState = JSON.parse((await draftGetState(syncKey)).text);
    assert(clearedState.featured_media_key === null, 'Cleared state still reports a featured media key.');
    pass('featured_clear_null', { thumbnail: null, attachments_preserved: 2, media_rows: 2 });

    const casKey = randomUUID();
    const casCreated = await draftPostCreate(casKey, 'CAS Base', 'CAS base body', '', [categoryIds.catA]);
    assert(casCreated.status === 201, `CAS fixture create failed (status ${casCreated.status}).`);
    const casPostId = JSON.parse(casCreated.text).post_id;
    const casV1 = stateFingerprint({ title: 'CAS Base', content: 'CAS base body', excerpt: '', categories: [categoryIds.catA], featured_media_key: null });
    const casAgree = await draftPutSync(casKey, 'CAS Base', 'CAS base body', '', [categoryIds.catA], null, casV1);
    assert(casAgree.status === 200 && JSON.parse(casAgree.text).replayed === true, `CAS-echoed replay was not idempotent (status ${casAgree.status}, text ${casAgree.text.slice(0, 300)}).`);
    const casChanged = await draftPutSync(casKey, 'CAS Changed', 'CAS changed body', '', [categoryIds.catA], null, casV1);
    assert(casChanged.status === 200, `Fresh-version CAS change failed (status ${casChanged.status}).`);
    const casV2 = JSON.parse(casChanged.text).applied_version;
    assert(casV2 !== casV1, 'Changed sync returned an unchanged applied version.');
    const casStale = await draftPutSync(casKey, 'CAS Stale Write', 'CAS stale body', '', [categoryIds.catA], null, casV1);
    assert(casStale.status === 409 && casStale.text.includes('newsroom_draft_sync_stale_version'), `Stale expected_version was not rejected with 409 (status ${casStale.status}).`);
    const casPostAfterStale = postInfo(casPostId);
    assert(casPostAfterStale.title === 'CAS Changed', 'Stale rejection still wrote the stale payload.');
    const casFresh = await draftPutSync(casKey, 'CAS Fresh Write', 'CAS fresh body', '', [categoryIds.catA], null, casV2);
    assert(casFresh.status === 200 && JSON.parse(casFresh.text).applied_version === stateFingerprint({ title: 'CAS Fresh Write', content: 'CAS fresh body', excerpt: '', categories: [categoryIds.catA], featured_media_key: null }), 'Fresh-version retry was not applied.');
    pass('cas_stale_version_409', { stale_rejected: 409, fresh_applied: 200, v1: casV1, v2: casV2 });

    const concurrentKey = randomUUID();
    await draftPostCreate(concurrentKey, 'Concurrent Base', 'Concurrent base body', '', [categoryIds.catA]);
    const concurrentBody = { title: 'Concurrent Result', content: 'Concurrent result body', excerpt: '', categories: [categoryIds.catC, categoryIds.catA] };
    const concurrentResults = [];
    for (let i = 0; i < 10; i += 1) {
      concurrentResults.push(draftPutSync(concurrentKey, concurrentBody.title, concurrentBody.content, concurrentBody.excerpt, concurrentBody.categories).then(
        (value) => ({ outcome: null, error: null, status: value.status }),
        (error) => ({ outcome: null, error: String(error?.message ?? error), status: 0 }),
      ));
    }
    const concurrentSettled = await Promise.all(concurrentResults);
    assert(concurrentSettled.every((result) => result.status === 200), 'Concurrent identical syncs did not all complete.');
    const concurrentPost = postInfo(draftRow(concurrentKey).postId);
    assert(concurrentPost.title === concurrentBody.title && JSON.stringify(postCategoryIds(concurrentPost.id)) === JSON.stringify([categoryIds.catA, categoryIds.catC].sort((a, b) => a - b)), 'Concurrent identical syncs left an inconsistent final state.');
    const concurrentDuplicates = Number(queryScalar(`SELECT COUNT(*) FROM wp_posts WHERE post_type='post' AND post_title='${sqlEscape(concurrentBody.title)}' AND post_content='${sqlEscape(concurrentBody.content)}'`));
    assert(concurrentDuplicates === 1, `Concurrent identical syncs produced ${concurrentDuplicates} posts with the target title/content.`);
    pass('concurrency_identical_10', { requests: 10, all_200: true, final_state_exact: true, duplicate_posts: concurrentDuplicates - 1 });

    const conflictKey = randomUUID();
    const conflictCreated = await draftPostCreate(conflictKey, 'Conflict Base', 'Conflict base body', '', [categoryIds.catA]);
    assert(conflictCreated.status === 201, `Conflict fixture create failed (status ${conflictCreated.status}).`);
    const conflictV1 = JSON.parse((await draftGetState(conflictKey)).text).applied_version;
    const conflictResults = [];
    for (let i = 0; i < 10; i += 1) {
      conflictResults.push(draftPutSync(conflictKey, `Conflict Option ${i}`, `Conflict option body ${i}`, '', [categoryIds.catA], null, conflictV1).then(
        (value) => ({ status: value.status, text: value.text }),
        (error) => ({ status: 0, text: String(error?.message ?? error) }),
      ));
    }
    const conflictSettled = await Promise.all(conflictResults);
    const conflictWins = conflictSettled.filter((result) => result.status === 200);
    const conflictStale = conflictSettled.filter((result) => result.status === 409);
    assert(conflictWins.length === 1 && conflictStale.length === 9, `Conflicting CAS syncs did not resolve to exactly one winner (200=${conflictWins.length}, 409=${conflictStale.length}).`);
    assert(conflictStale.every((result) => result.text.includes('newsroom_draft_sync_stale_version')), 'Conflicting CAS syncs did not all reject with the stale-version code.');
    pass('concurrency_conflicting_cas_10', { winners: conflictWins.length, stale_409: conflictStale.length });

    const validationBodies = [
      { describe: 'missing_title', body: syncInput(syncKey, '', 'content', '', [categoryIds.catA], null) },
      { describe: 'empty_content', body: syncInput(syncKey, 'Title', '', '', [categoryIds.catA], null) },
      { describe: 'unsupported_field', body: { ...syncInput(syncKey, 'Title', 'Content', '', [categoryIds.catA], null), extra: 1 } },
      { describe: 'bad_categories', body: syncInput(syncKey, 'Title', 'Content', '', [], null) },
      { describe: 'missing_featured', body: (() => { const b = syncInput(syncKey, 'Title', 'Content', '', [categoryIds.catA], null); delete b.featured_media_key; return b; })() },
      { describe: 'bad_featured', body: syncInput(syncKey, 'Title', 'Content', '', [categoryIds.catA], 'not-a-uuid') },
      { describe: 'bad_expected_version', body: syncInput(syncKey, 'Title', 'Content', '', [categoryIds.catA], null, 'zz') },
    ];
    const priorPostRow = (() => { const p = postInfo(syncPostId); return { title: p.title, content: p.content, thumb: postThumbnail(syncPostId) }; })();
    for (const scenario of validationBodies) {
      const candidate = await rawDraftSignedRequest('PUT', syncRoute(syncKey), { keyId: draftKeyId, secret: draftSecret, body: Buffer.from(JSON.stringify(scenario.body), 'utf8') });
      assert(candidate.status === 400 || candidate.status === 409, `Validation scenario ${scenario.describe} was not rejected (status ${candidate.status}).`);
    }
    const afterValidationPost = postInfo(syncPostId);
    assert(afterValidationPost.title === priorPostRow.title && afterValidationPost.content === priorPostRow.content && postThumbnail(syncPostId) === priorPostRow.thumb, 'A validation rejection changed the synced draft.');
    pass('validation_400s', { scenarios: validationBodies.length, state_preserved: true });

    const unknownFeatured = await draftPutSync(syncKey, 'Title', 'Content', '', [categoryIds.catA], randomUUID());
    assert(unknownFeatured.status === 400 && unknownFeatured.text.includes('newsroom_draft_sync_media_key_not_found'), 'Unknown featured media key was not rejected with 400.');
    pass('featured_unknown_key_400', { code: 'newsroom_draft_sync_media_key_not_found' });

    const reservedMediaKey = randomUUID();
    db(`INSERT INTO wp_newsroom_media (media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token, created_at, updated_at) VALUES ('${reservedMediaKey}', NULL, '${'0'.repeat(64)}', 1, ${mediaUserId}, '11111111-1111-4111-8111-111111111111', UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
    const reservedFeatured = await draftPutSync(syncKey, 'Title', 'Content', '', [categoryIds.catA], reservedMediaKey);
    assert(reservedFeatured.status === 409 && reservedFeatured.text.includes('newsroom_draft_sync_media_key_in_progress'), 'Reserved featured media key was not rejected with 409.');
    db(`DELETE FROM wp_newsroom_media WHERE media_key='${reservedMediaKey}'`);
    pass('featured_reserved_key_409', { code: 'newsroom_draft_sync_media_key_in_progress' });

    const foreignMediaKey = randomUUID();
    db(`INSERT INTO wp_newsroom_media (media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token, created_at, updated_at) VALUES ('${foreignMediaKey}', NULL, '${'0'.repeat(64)}', 1, ${draftUserId}, NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
    const foreignFeatured = await draftPutSync(syncKey, 'Title', 'Content', '', [categoryIds.catA], foreignMediaKey);
    assert(foreignFeatured.status === 400 && foreignFeatured.text.includes('newsroom_draft_sync_media_not_owned'), 'Foreign-authority media key was not rejected with 400.');
    db(`DELETE FROM wp_newsroom_media WHERE media_key='${foreignMediaKey}'`);
    pass('featured_not_owned_400', { code: 'newsroom_draft_sync_media_not_owned' });

    const nonImageKey = randomUUID();
    const nonImageDir = sqlEscape(managedMediaDir());
    const nonImagePdfId = Number(wpEval(`
      @mkdir( ${JSON.stringify(managedMediaDir())}, 0755, true );
      $to = ${JSON.stringify(managedMediaDir())} . '/not-an-image.pdf';
      file_put_contents( $to, '%PDF-1.4 fake' );
      $id = wp_insert_attachment( array( 'post_mime_type' => 'application/pdf', 'post_status' => 'inherit', 'post_author' => ${mediaUserId} ), $to, 0, true );
      update_post_meta( $id, '_newsroom_media_key', '${sqlEscape(nonImageKey)}' );
      update_post_meta( $id, '_newsroom_media_file', $to );
      echo $id;
    `));
    assert(nonImagePdfId > 0, 'Non-image attachment fixture was not created.');
    db(`INSERT INTO wp_newsroom_media (media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token, created_at, updated_at) VALUES ('${nonImageKey}', ${nonImagePdfId}, '${'0'.repeat(64)}', 5, ${mediaUserId}, NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
    const nonImageFeatured = await draftPutSync(syncKey, 'Title', 'Content', '', [categoryIds.catA], nonImageKey);
    assert(nonImageFeatured.status === 400 && nonImageFeatured.text.includes('newsroom_draft_sync_media_not_image'), 'Non-image featured media key was not rejected with 400.');
    db(`DELETE FROM wp_newsroom_media WHERE media_key='${nonImageKey}'`);
    wpEval(`wp_delete_attachment( ${nonImagePdfId}, true ); echo 'ok';`);
    pass('featured_non_image_400', { code: 'newsroom_draft_sync_media_not_image' });

    const corruptKey = mediaKeyA;
    const corruptAttachment = mediaAttachmentA;
    wpEval(`delete_post_meta( ${corruptAttachment}, '_newsroom_media_key' ); echo 'ok';`);
    const corruptFeatured = await draftPutSync(syncKey, 'Title', 'Content', '', [categoryIds.catA], corruptKey);
    assert(corruptFeatured.status === 409 && corruptFeatured.text.includes('newsroom_draft_sync_media_corrupt'), 'Corrupt media mapping was not rejected with 409.');
    wpEval(`update_post_meta( ${corruptAttachment}, '_newsroom_media_key', '${sqlEscape(corruptKey)}' ); echo 'ok';`);
    assert((await draftPutSync(syncKey, 'Title', 'Content', '', [categoryIds.catA], corruptKey)).status === 200, 'Repaired media mapping did not recover.');
    pass('featured_corrupt_mapping_409', { code: 'newsroom_draft_sync_media_corrupt', repaired: 200 });

    const preservedPost = postInfo(syncPostId);
    const allPosts = db("SELECT GROUP_CONCAT(post_status SEPARATOR ',') FROM wp_posts WHERE post_type='post'");
    assert(preservedPost.status === 'draft' && preservedPost.author === draftUserId, 'Sync changed the draft status or author.');
    if (!allPosts.split(',').filter(Boolean).every((status) => status === 'draft')) {
      const nonDraftPosts = db("SELECT CONCAT_WS(CHAR(9),ID,post_status,post_title,post_author) FROM wp_posts WHERE post_type='post' AND post_status <> 'draft'");
      throw new Error(`A draft was published or moved to a non-draft status (posts: ${JSON.stringify(nonDraftPosts.split(String.raw`\n`).filter(Boolean)).slice(0, 500)}).`);
    }
    pass('status_author_no_publication', { status: 'draft', author: draftUserId, published: 0 });

    const lossKey = randomUUID();
    const lossCreated = await draftPostCreate(lossKey, 'Loss Base', 'Loss base body', '', [categoryIds.catA]);
    assert(lossCreated.status === 201, `Loss fixture create failed (status ${lossCreated.status}).`);
    const lossProxy = dropAfterCommit(baseUrl);
    await lossProxy.listen();
    let lossError = null;
    try {
      await rawDraftSignedRequest('PUT', syncRoute(lossKey), { keyId: draftKeyId, secret: draftSecret, body: syncBody(lossKey, 'Loss Applied', 'Loss applied body', '', [categoryIds.catA], null), base: lossProxy.url() });
    } catch (error) { lossError = error; }
    await lossProxy.close();
    assert(lossError !== null, 'Response-loss proxy did not drop the PUT response.');
    const lossState = JSON.parse((await draftGetState(lossKey)).text);
    assert(lossState.title === 'Loss Applied' && lossState.content === 'Loss applied body', 'Dropped-response PUT did not commit the full state.');
    const lossRetry = await draftPutSync(lossKey, 'Loss Applied', 'Loss applied body', '', [categoryIds.catA], null);
    assert(lossRetry.status === 200 && JSON.parse(lossRetry.text).replayed === true, 'Retry after response loss was not idempotent.');
    assert(draftRow(lossKey)?.postId === lossState.post_id, 'Response-loss recovery used a duplicate post.');
    pass('response_loss_recovery', { commit: true, retry_replayed: true, version_reachable: true });

    const undeliveredKey = randomUUID();
    const undeliveredCreated = await draftPostCreate(undeliveredKey, 'Undelivered Base', 'Undelivered base body', '', [categoryIds.catA]);
    assert(undeliveredCreated.status === 201, `Undelivered fixture create failed (status ${undeliveredCreated.status}).`);
    const undeliveredProxy = dropFirstPutThenPassthrough(baseUrl);
    await undeliveredProxy.listen();
    let undeliveredError = null;
    try {
      await rawDraftSignedRequest('PUT', syncRoute(undeliveredKey), { keyId: draftKeyId, secret: draftSecret, body: syncBody(undeliveredKey, 'Undelivered Body', 'Undelivered content', '', [categoryIds.catA], null), base: undeliveredProxy.url() });
    } catch (error) { undeliveredError = error; }
    const firstPutDestroyed = undeliveredProxy.requests.filter((entry) => entry.method === 'PUT').length === 1 && null === undeliveredProxy.requests[0]?.clientStatus;
    await undeliveredProxy.close();
    assert(undeliveredError !== null && firstPutDestroyed, 'Undelivered-first proxy did not drop the first PUT without upstream.');
    const undeliveredSecond = await draftPutSync(undeliveredKey, 'Undelivered Body', 'Undelivered content', '', [categoryIds.catA], null);
    assert(undeliveredSecond.status === 200, `Post-drop retry failed (status ${undeliveredSecond.status}).`);
    const undeliveredRow = draftRow(undeliveredKey);
    const undeliveredPost = postInfo(undeliveredRow.postId);
    const undeliveredDuplicates = Number(queryScalar(`SELECT COUNT(*) FROM wp_posts WHERE post_type='post' AND post_title='${sqlEscape('Undelivered Body')}' AND post_content='${sqlEscape('Undelivered content')}'`));
    assert(undeliveredPost.title === 'Undelivered Body' && undeliveredDuplicates === 1, 'Undelivered retry left a duplicated durable post.');
    pass('undelivered_retry', { first_dropped_before_upstream: true, second_applied: 200, duplicate_posts: undeliveredDuplicates - 1 });

    const faultKey = randomUUID();
    const faultCreated = await draftPostCreate(faultKey, 'Fault Base', 'Fault base body', '', [categoryIds.catA]);
    assert(faultCreated.status === 201, `Fault fixture create failed (status ${faultCreated.status}).`);
    const faultPostId = JSON.parse(faultCreated.text).post_id;
    const faultBaseTitle = postInfo(faultPostId).title;
    const faultBaseHash = draftRow(faultKey).payloadHash;
    faultPhase('during_update');
    let faultStatus = 0;
    try { faultStatus = (await draftPutSync(faultKey, 'Fault Injected Write', 'Fault injected body', '', [categoryIds.catA], null)).status; } catch { faultStatus = 0; }
    faultPhase(null);
    assert(faultStatus === 503, `during_update fault did not fail closed (status ${faultStatus}).`);
    const faultAfter = postInfo(faultPostId);
    assert(faultAfter.title === faultBaseTitle && draftRow(faultKey)?.payloadHash === faultBaseHash, 'during_update fault left partial state behind.');
    const faultRecover = await draftPutSync(faultKey, 'Fault Recovered Write', 'Fault recovered body', '', [categoryIds.catA], null);
    assert(faultRecover.status === 200 && postInfo(faultPostId).title === 'Fault Recovered Write', 'Clean retry after during_update fault did not recover.');
    pass('fault_partial_operation_rollback', { interrupted: 503, partial_state: 0, mapping_unchanged: true, recovered: 200 });

    const mismatchKey = randomUUID();
    const mismatchCreated = await draftPostCreate(mismatchKey, 'Mismatch Base', 'Mismatch base body', '', [categoryIds.catA]);
    assert(mismatchCreated.status === 201, `Mismatch fixture create failed (status ${mismatchCreated.status}).`);
    const mismatchPostId = JSON.parse(mismatchCreated.text).post_id;
    const mismatchBaseTitle = postInfo(mismatchPostId).title;
    faultPhase('mismatched_store');
    const mismatchPut = await draftPutSync(mismatchKey, 'Mismatch Injected', 'Mismatch injected body', '', [categoryIds.catA], null);
    faultPhase(null);
    assert(mismatchPut.status === 503 && mismatchPut.text.includes('newsroom_draft_sync_postcondition_failed'), `Postcondition mismatch was not fail-closed (status ${mismatchPut.status}).`);
    const mismatchAfter = postInfo(mismatchPostId);
    assert(mismatchAfter.title === mismatchBaseTitle, 'Postcondition mismatch persisted the corrupted title.');
    const mismatchRecover = await draftPutSync(mismatchKey, 'Mismatch Recovered', 'Mismatch recovered body', '', [categoryIds.catA], null);
    assert(mismatchRecover.status === 200 && postInfo(mismatchPostId).title === 'Mismatch Recovered', 'Clean retry after postcondition mismatch did not recover.');
    pass('fault_postcondition_mismatch', { code: 'newsroom_draft_sync_postcondition_failed', rollback: true, recovered: 200 });

    const appPasswordDraft = wpEval(`echo wp_is_application_passwords_available_for_user( get_user_by( 'id', ${draftUserId} ) ) ? 'available' : 'denied';`);
    const passwordLoginDraft = wpEval(`$u = wp_authenticate( 'runtime_draft', ${JSON.stringify(runtimeEnv.ADMIN_PASSWORD)} ); echo is_wp_error( $u ) ? 'denied' : 'ok';`);
    assert(appPasswordDraft === 'denied' && passwordLoginDraft === 'denied', 'Draft identity is not locked down for generic credentials.');
    pass('draft_identity_lockdown', { app_passwords: 'denied', password_login: 'denied' });

    const unsignedState = await request('GET', `/wp-json/newsroom/v1/drafts/${syncKey}/state`);
    assert(unsignedState.status === 401, `Unsigned state GET was not rejected (status ${unsignedState.status}).`);
    const unsignedPut = await request('PUT', `/wp-json/newsroom/v1/drafts/${syncKey}`, { headers: { 'content-type': 'application/json' }, body: syncBody(syncKey, 'X', 'Y', '', [categoryIds.catA], null) });
    assert(unsignedPut.status === 401, `Unsigned sync PUT was not rejected (status ${unsignedPut.status}).`);
    const signedCorePut = await rawDraftSignedRequest('PUT', `/wp/v2/posts/${syncPostId}`, { keyId: draftKeyId, secret: draftSecret, body: Buffer.from(JSON.stringify({ title: 'Core Intrusion' }), 'utf8') });
    assert(signedCorePut.status === 401, `Draft credential reached a core route (status ${signedCorePut.status}).`);
    const stateWithQuery = await rawDraftSignedRequest('GET', `${stateRoute(syncKey)}?x=1`, { keyId: draftKeyId, secret: draftSecret });
    assert(stateWithQuery.status === 401, `Query string on a signed state GET was not rejected (status ${stateWithQuery.status}).`);
    pass('core_rest_isolation', { unsigned_state: 401, unsigned_put: 401, draft_to_core: 401, signed_get_with_query: 401 });

    const mediaHeadersPut = await request('PUT', `/wp-json${syncRoute(syncKey)}`, {
      headers: {
        'x-newsroom-media-auth-version': '1',
        'x-newsroom-media-key-id': mediaKeyId,
        'x-newsroom-media-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-newsroom-media-signature': 'a'.repeat(64),
        'x-newsroom-media-key': randomUUID(),
        'x-newsroom-media-filename': 'x.png',
        'x-newsroom-media-mime': 'image/png',
        'content-type': 'application/json',
      },
      body: syncBody(syncKey, 'Media Signed', 'Media signed body', '', [categoryIds.catA], null),
    });
    assert(mediaHeadersPut.status === 401, `Media-credential PUT on the sync route was not rejected (status ${mediaHeadersPut.status}).`);
    const mediaHeadersState = await request('GET', `/wp-json${stateRoute(syncKey)}`, {
      headers: {
        'x-newsroom-media-auth-version': '1',
        'x-newsroom-media-key-id': mediaKeyId,
        'x-newsroom-media-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-newsroom-media-signature': 'a'.repeat(64),
        'x-newsroom-media-key': randomUUID(),
      },
    });
    assert(mediaHeadersState.status === 401, `Media-credential state GET was not rejected (status ${mediaHeadersState.status}).`);
    const draftSignedMedia = await rawDraftSignedRequest('GET', `/newsroom-media/v1/media/${mediaKeyA}`, { keyId: draftKeyId, secret: draftSecret });
    assert(draftSignedMedia.status === 401, `Draft credential reached a media route (status ${draftSignedMedia.status}).`);
    pass('cross_route_rejection', { media_to_sync_put: 401, media_to_state: 401, draft_to_media: 401 });

    const badSignature = '0'.repeat(64);
    const badSig = await request('PUT', `/wp-json${syncRoute(syncKey)}`, {
      headers: { 'x-newsroom-auth-version': '1', 'x-newsroom-key-id': draftKeyId, 'x-newsroom-timestamp': String(Math.floor(Date.now() / 1000)), 'x-newsroom-signature': badSignature, 'content-type': 'application/json' },
      body: syncBody(syncKey, 'Bad Signature', 'Bad signature body', '', [categoryIds.catA], null),
    });
    const tamperedTimestamp = String(Math.floor(Date.now() / 1000) - 1000);
    const tamperedCanonical = ['newsroom-hmac-v1', draftKeyId, 'PUT', syncRoute(syncKey), tamperedTimestamp, sha256Buffer(syncBody(syncKey, 'Stale', 'Stale body', '', [categoryIds.catA], null))].join('\n');
    const tamperedSig = createHmac('sha256', decodeDraftSecret(draftSecret)).update(tamperedCanonical).digest('hex');
    const staleRequest = await request('PUT', `/wp-json${syncRoute(syncKey)}`, {
      headers: { 'x-newsroom-auth-version': '1', 'x-newsroom-key-id': draftKeyId, 'x-newsroom-timestamp': tamperedTimestamp, 'x-newsroom-signature': tamperedSig, 'content-type': 'application/json' },
      body: syncBody(syncKey, 'Stale', 'Stale body', '', [categoryIds.catA], null),
    });
    const ghostSigned = await request('PUT', `/wp-json${syncRoute(syncKey)}`, {
      headers: { 'x-newsroom-auth-version': '1', 'x-newsroom-key-id': 'ghost-key', 'x-newsroom-timestamp': String(Math.floor(Date.now() / 1000)), 'x-newsroom-signature': badSignature, 'content-type': 'application/json' },
      body: syncBody(syncKey, 'Ghost Key', 'Ghost key body', '', [categoryIds.catA], null),
    });
    assert(badSig.status === 401, `Bad signature was not rejected (status ${badSig.status}).`);
    assert(staleRequest.status === 401, `Stale timestamp was not rejected (status ${staleRequest.status}).`);
    assert(ghostSigned.status === 401, `Unknown key id was not rejected (status ${ghostSigned.status}).`);
    pass('authentication_negatives', { bad_signature: 401, stale_timestamp: 401, unknown_key: 401 });

    const authorLockdown = await request('PUT', `/wp-json${syncRoute(syncKey)}`, {
      headers: { 'x-newsroom-auth-version': '1', 'x-newsroom-key-id': draftKeyId, 'x-newsroom-timestamp': String(Math.floor(Date.now() / 1000)), 'x-newsroom-signature': '0'.repeat(64), authorization: 'Basic Zm9vOmJhcg==' },
      body: syncBody(syncKey, 'Authorization Space', 'Authorization body', '', [categoryIds.catA], null),
    });
    assert(authorLockdown.status === 401, 'A signed sync with an Authorization header was not rejected.');
    pass('authorization_conflict_401', { http: 401 });

    knownSecrets.push(...Object.values(runtimeEnv).filter((value) => value && value.length >= 8));
    knownSecrets.push(Buffer.from(draftSecret, 'base64url').toString('hex'), draftSecret);
    knownSecrets.push(Buffer.from(mediaSecret, 'base64url').toString('hex'), mediaSecret);

    const logs = compose(['logs', '--no-color', 'wordpress'], { sensitive: true }).stdout;
    const excludedKnown = knownSecrets.filter((item) => item && item.length >= 8);
    const logLeakCounts = excludedKnown.map((item) => logs.includes(item) ? 1 : 0);
    const leakIndexes = logLeakCounts.map((count, index) => count === 1 ? index : -1).filter((index) => index >= 0);
    assert(logs.includes('newsroom_bridge_security') && logLeakCounts.every((count) => count === 0), `Security log sentinel leakage test failed: leak_indexes=${JSON.stringify(leakIndexes)}.`);

    const textTables = [
      [`SELECT COUNT(*) FROM wp_options WHERE option_value LIKE '%${sqlEscape(draftSecret)}%'`, 'wp_options'],
      [`SELECT COUNT(*) FROM wp_postmeta pm INNER JOIN wp_posts p ON p.ID = pm.post_id WHERE pm.meta_value LIKE '%${sqlEscape(draftSecret)}%' OR p.post_content LIKE '%${sqlEscape(draftSecret)}%'`, 'wp_posts'],
    ];
    const databaseAudit = Object.fromEntries(textTables.map(([query, table]) => [table, Number(db(query))]));
    assert(Object.values(databaseAudit).every((count) => count === 0), 'Generated draft secret persisted in the runtime database.');

    const repositoryAuditDraft = repositorySecretOccurrences(draftSecret);
    const repositoryAuditMedia = repositorySecretOccurrences(mediaSecret);
    assert(repositoryAuditDraft.count === 0 && repositoryAuditMedia.count === 0, 'Generated secrets persisted in approved repository artifacts.');
    pass('no_secret_sentinels', { log_matches: 0, database: databaseAudit, repository_matches: { draft: 0, media: 0 }, repository_files: repositoryAuditDraft.filesExamined, root_env_excluded: true });

    const finalKey = randomUUID();
    const finalHealth = await draftPostCreate(finalKey, 'Final Health', 'Final health body', '', [categoryIds.catA]);
    assert(finalHealth.status === 201, `Final health create failed (status ${finalHealth.status}).`);
    const finalSync = await draftPutSync(finalKey, 'Final Health', 'Final health body', '', [categoryIds.catA], null);
    assert(finalSync.status === 200, 'Final health sync failed after all fault scenarios.');
    const finalClient = await client.createDraft({ wordpressDraftKey: randomUUID(), headline: 'Final Client Health', body: 'Final client body', excerpt: '', wordpressCategoryIds: [categoryIds.catA] });
    assert(finalClient.outcome === 'CREATED', 'Frozen draft client failed after all fault scenarios.');

    assert(JSON.stringify(protectedHashes()) === JSON.stringify(frozenHashes), 'Frozen reconciliation hashes changed during runtime.');
    assert(JSON.stringify(productionHashes()) === JSON.stringify(productionSnapshot), 'Production newsroom source changed during runtime.');
    evidence.runtime = { wordpress: wp(['core', 'version']), php: compose(['exec', '-T', 'wordpress', 'php', '-r', 'echo PHP_VERSION;']).stdout.trim(), mariadb: db('SELECT VERSION()'), wp_cli: wp(['cli', 'version']), loopback: true, draft_schema: wp(['option', 'get', 'newsroom_bridge_schema_version']), media_schema: wp(['option', 'get', 'newsroom_bridge_media_schema_version']) };
    pass('final_integrity', { protected_hashes: 'unchanged', production_sources: 'unchanged', health: { create: 201, sync: 200, client: 'CREATED' } });
  } catch (error) {
    fatalError = redact(error?.stack || error?.message || error);
    evidence.results.push({ name: 'fatal', status: 'FAIL', details: { error: fatalError } });
    process.stderr.write(`FAIL ${redact(error?.message || error)}\n`);
    if (error?.stack) process.stderr.write(`${redact(error.stack)}\n`);
  } finally {
    const failures = [];
    let down = null; let containerQuery = null; let volumeQuery = null; let containers = null; let volumes = null;
    try { if (envCreated || existsSync(envFile)) { down = compose(['down', '-v', '--remove-orphans'], { allowFailure: true, sensitive: true }); if (down.status !== 0) throw new Error(`teardown exit ${down.status}`); } } catch (error) { failures.push(`compose_down: ${redact(error.message)}`); }
    try { containerQuery = run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.ID}}'], { allowFailure: true }); if (containerQuery.status !== 0) throw new Error(`container query exit ${containerQuery.status}`); containers = containerQuery.stdout.trim() ? containerQuery.stdout.trim().split(/\r?\n/) : []; } catch (error) { failures.push(`container_query: ${redact(error.message)}`); }
    try { volumeQuery = run('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Name}}'], { allowFailure: true }); if (volumeQuery.status !== 0) throw new Error(`volume query exit ${volumeQuery.status}`); volumes = volumeQuery.stdout.trim() ? volumeQuery.stdout.trim().split(/\r?\n/) : []; } catch (error) { failures.push(`volume_query: ${redact(error.message)}`); }
    try { rmSync(envFile, { force: true }); } catch (error) { failures.push(`env_cleanup: ${redact(error.message)}`); }
    if (!Array.isArray(containers) || containers.length) failures.push('container residue detected');
    if (!Array.isArray(volumes) || volumes.length) failures.push('volume residue detected');
    if (existsSync(envFile)) failures.push('.env.runtime remains');
    evidence.cleanup = { compose_down_status: down?.status ?? null, container_query_status: containerQuery?.status ?? null, containers_remaining: containers, volume_query_status: volumeQuery?.status ?? null, volumes_remaining: volumes, env_runtime_absent: !existsSync(envFile), failures };
    evidence.finished_at = new Date().toISOString();
    writeFileSync(resultsFile, JSON.stringify(evidence, null, 2) + '\n');
    if (failures.length && !fatalError) fatalError = failures.join('; ');
  }

  if (fatalError) process.exit(1);
  if (evidence.results.some((result) => result.status === 'FAIL')) {
    process.stderr.write(`FAIL draft sync proof suite (${evidence.results.length} evidence groups)\n`);
    process.exit(1);
  }
  process.stdout.write(`PASS draft sync proof suite (${evidence.results.length} evidence groups)\n`);
  process.exit(0);
})();
