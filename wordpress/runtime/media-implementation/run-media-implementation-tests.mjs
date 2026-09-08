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
const projectName = 'newsroom-media-implementation';
const tscBinary = resolve(repoRoot, 'apps/api/node_modules/typescript/bin/tsc');
const harnessTsconfig = resolve(repoRoot, 'apps/api/tsconfig.wordpress-media-harness.json');
const clientBuild = resolve(runtimeDir, '.build', 'wordpress-media.client.js');
const repositoryScanCandidates = [
  'apps/api/src/app.module.ts',
  'apps/api/src/config/configuration.ts',
  'apps/api/src/config/env.schema.ts',
  'apps/api/tsconfig.wordpress-media-harness.json',
  '.env.example',
  'apps/api/src/modules/wordpress-media/wordpress-media.client.ts',
  'apps/api/src/modules/wordpress-media/wordpress-media.client.spec.ts',
  'apps/api/src/modules/wordpress-media/wordpress-media.errors.ts',
  'apps/api/src/modules/wordpress-media/wordpress-media-hmac.ts',
  'apps/api/src/modules/wordpress-media/wordpress-media-hmac.spec.ts',
  'apps/api/src/modules/wordpress-media/wordpress-media.module.ts',
  'apps/api/src/modules/wordpress-media/wordpress-media.types.ts',
  'wordpress/newsroom-bridge/newsroom-bridge.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-auth.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-config.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-db.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-reconciliation.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-rest.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-media-service-user.php',
  'wordpress/runtime/media-implementation/.gitignore',
  'wordpress/runtime/media-implementation/compose.yaml',
  'wordpress/runtime/media-implementation/README.md',
  'wordpress/runtime/media-implementation/run-media-implementation-tests.mjs',
  'wordpress/runtime/media-implementation/fixtures/newsroom-media-fault-harness.php',
  'docs/DEVELOPMENT_ROADMAP.md',
  'docs/WORDPRESS_MEDIA_IMPLEMENTATION.md',
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
function makeGif1px() {
  const lsw = (value) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
  const header = Buffer.from('GIF89a', 'ascii');
  const screen = Buffer.concat([lsw(1), lsw(1), Buffer.from([0x00, 0x00, 0x00])]);
  const image = Buffer.concat([Buffer.from([0x2c]), lsw(0), lsw(0), lsw(1), lsw(1), Buffer.from([0x00, 0x02, 0x44, 0x01, 0x00, 0x3b])]);
  return Buffer.concat([header, screen, image]);
}
const MEDIA_KEY = '01234567-89ab-47cd-8e01-23456789abcd';

const knownSecrets = [];
const evidence = { started_at: new Date().toISOString(), results: [], runtime: {}, cleanup: {} };
let runtimeEnv = {};
let port = 0;
let baseUrl = '';
let categoryId = 0;
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
function mediaProductionHashes() {
  return Object.fromEntries([
    'newsroom-bridge.php',
    'includes/class-newsroom-bridge-media-auth.php',
    'includes/class-newsroom-bridge-media-config.php',
    'includes/class-newsroom-bridge-media-db.php',
    'includes/class-newsroom-bridge-media-reconciliation.php',
    'includes/class-newsroom-bridge-media-rest.php',
    'includes/class-newsroom-bridge-media-service-user.php',
  ].map((path) => [path, sha256(resolve(pluginDir, path))]));
}
function sqlEscape(value) { return String(value).replaceAll('\\', '\\\\').replaceAll("'", "''"); }

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
function queryScalar(query) { const value = db(query); return value; }
function transient(tx, key) { return wp(['transient', tx, key], { label: `transient ${tx}` }); }
function faultPhase(phase) { return phase ? wp(['option', 'update', 'test_media_fault_phase', phase], { label: 'fault set' }) : wp(['option', 'delete', 'test_media_fault_phase'], { label: 'fault clear', allowFailure: true }); }
function forceGarbageCollect() { transient('delete', 'newsroom_bridge_media_gc_gate'); }

function request(method, path, { headers = {}, body } = {}) {
  const url = new URL(path, baseUrl);
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

function helperMediaRow(mediaKey) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),media_key,COALESCE(attachment_id,'NULL'),payload_hash,content_length,actor_user_id,COALESCE(reservation_token,'NULL')) FROM wp_newsroom_media WHERE media_key='${sqlEscape(mediaKey)}'`);
  if (!row) return null;
  const [key, attachmentId, payloadHash, contentLength, actorUserId, reservationToken] = row.split(String.raw`\t`);
  return {
    mediaKey: key,
    attachmentId: attachmentId === 'NULL' ? null : Number(attachmentId),
    payloadHash,
    contentLength: Number(contentLength),
    actorUserId: Number(actorUserId),
    reservationToken: reservationToken === 'NULL' ? null : reservationToken,
  };
}
function mediaRowCount(mediaKey) { return Number(queryScalar(`SELECT COUNT(*) FROM wp_newsroom_media WHERE media_key='${sqlEscape(mediaKey)}'`)); }
function draftRow(draftKey) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),draft_key,COALESCE(post_id,'NULL'),payload_hash,actor_user_id,COALESCE(reservation_token,'NULL')) FROM wp_newsroom_reconciliation WHERE draft_key='${sqlEscape(draftKey)}'`);
  if (!row) return null;
  const [key, postId, payloadHash, actorUserId, reservationToken] = row.split(String.raw`\t`);
  return { draftKey: key, postId: postId === 'NULL' ? null : Number(postId), payloadHash, actorUserId: Number(actorUserId), reservationToken: reservationToken === 'NULL' ? null : reservationToken };
}
function mediaTotalRows() { return Number(queryScalar('SELECT COUNT(*) FROM wp_newsroom_media')); }
function attachmentInfo(id) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),ID,post_status,post_type,post_mime_type,post_author) FROM wp_posts WHERE ID=${Number(id)}`);
  if (!row) return null;
  const [postId, status, type, mime, author] = row.split(String.raw`\t`);
  return { id: Number(postId), status, type, mime, author: Number(author) };
}
function attachmentCountFor(mediaKey) {
  return Number(db(`SELECT COUNT(*) FROM wp_postmeta pm INNER JOIN wp_posts p ON p.ID = pm.post_id WHERE pm.meta_key='_newsroom_media_key' AND pm.meta_value='${sqlEscape(mediaKey)}' AND p.post_type='attachment'`));
}
function attachmentFileMeta(attachmentId) { return db(`SELECT meta_value FROM wp_postmeta WHERE post_id=${Number(attachmentId)} AND meta_key='_newsroom_media_file'`); }
function attachmentKeyMeta(attachmentId) { return db(`SELECT meta_value FROM wp_postmeta WHERE post_id=${Number(attachmentId)} AND meta_key='_newsroom_media_key'`); }
function uploadBaseDir() { return wpEval('echo wp_upload_dir()["basedir"];'); }
function managedMediaDir() {
  const base = uploadBaseDir();
  const sub = wpEval('echo wp_upload_dir()["subdir"];');
  return `${base}${sub}/newsroom-media`;
}
function fileExists(subpath) {
  const full = `${managedMediaDir()}/${subpath}`;
  return wpEval(`echo file_exists(${JSON.stringify(full)}) ? '1' : '0';`);
}
function fileSha(subpath) {
  const full = `${managedMediaDir()}/${subpath}`;
  return wpEval(`echo hash_file( 'sha256', ${JSON.stringify(full)} ) ?: '';`);
}
function mediaDirEntries() {
  const full = managedMediaDir();
  return wpEval(`$d = ${JSON.stringify(full)}; if ( ! is_dir( $d ) ) { echo ''; exit; } foreach ( scandir( $d ) as $e ) { if ( $e === '.' || $e === '..' ) continue; echo $e, "\\n"; }`);
}
function userCap(userId, cap) { return wpEval(`echo user_can( ${Number(userId)}, '${sqlEscape(cap)}' ) ? '1' : '0';`); }
function userLogin(userId) { return wpEval(`$u = get_user_by( 'id', ${Number(userId)} ); echo $u ? get_userdata( ${Number(userId)} )->user_login : '';`); }

function rawSignedRequest(method, route, { keyId, secret, mediaKey, filename = null, mime = null, body = Buffer.alloc(0), headers = {} } = {}) {
  const mediaHmac = requireModule(resolve(runtimeDir, '.build', 'wordpress-media-hmac.js'));
  const timestamp = String(Math.floor(Date.now() / 1000));
  return request(method, `/wp-json${route}${method === 'GET' ? '?' : ''}`, {
    headers: {
      ...mediaHmac.signNewsroomMediaRequest({ keyId, secret: mediaHmac.decodeMediaHmacSecret(secret), method, route, timestamp, mediaKey, filename, mime, body }),
      ...(method === 'POST' ? { 'content-type': 'application/octet-stream' } : {}),
      ...headers,
    },
    body: method === 'POST' ? body : undefined,
  });
}

function rawCrossSignedGet(route, { keyId, secret, mediaKey }) {
  const mediaHmac = requireModule(resolve(runtimeDir, '.build', 'wordpress-media-hmac.js'));
  const bytes = mediaHmac.decodeMediaHmacSecret(secret);
  const [pathOnly = route, query = ''] = route.split('?');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = ['newsroom-media-hmac-v1', keyId, 'GET', pathOnly, timestamp, mediaKey, '-', '-', createHash('sha256').update(Buffer.alloc(0)).digest('hex')].join('\n');
  const signature = createHmac('sha256', bytes).update(canonical).digest('hex');
  return request('GET', `/wp-json${pathOnly}?${query}`, {
    headers: {
      'x-newsroom-media-auth-version': '1',
      'x-newsroom-media-key-id': keyId,
      'x-newsroom-media-timestamp': timestamp,
      'x-newsroom-media-signature': signature,
      'x-newsroom-media-key': mediaKey,
      'x-newsroom-media-filename': '',
      'x-newsroom-media-mime': '',
    },
  });
}

function rawDraftSignedRequest(method, route, { keyId, secret, draftKey, body = Buffer.alloc(0) } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = ['newsroom-hmac-v1', keyId, method, route, timestamp, sha256Buffer(body)].join('\n');
  const signature = createHmac('sha256', decodeDraftSecret(secret)).update(canonical).digest('hex');
  return request(method, `/wp-json${route}`, {
    headers: {
      'x-newsroom-auth-version': '1',
      'x-newsroom-key-id': keyId,
      'x-newsroom-timestamp': timestamp,
      'x-newsroom-signature': signature,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    body: method === 'POST' ? body : undefined,
  });
}
function decodeDraftSecret(b64u) { return Buffer.from(b64u.replace(/-/g, '+').replace(/_/g, '/') + '=', 'base64'); }

function signedMediaGetClean(targetKey, keyId, secret) {
  const mediaHmac = requireModule(resolve(runtimeDir, '.build', 'wordpress-media-hmac.js'));
  const bytes = mediaHmac.decodeMediaHmacSecret(secret);
  const route = `/newsroom-media/v1/media/${targetKey}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const canonical = ['newsroom-media-hmac-v1', keyId, 'GET', route, timestamp, targetKey, '-', '-', createHash('sha256').update(Buffer.alloc(0)).digest('hex')].join('\n');
  const signature = createHmac('sha256', bytes).update(canonical).digest('hex');
  return request('GET', `/wp-json${route}`, {
    headers: {
      'x-newsroom-media-auth-version': '1',
      'x-newsroom-media-key-id': keyId,
      'x-newsroom-media-timestamp': timestamp,
      'x-newsroom-media-signature': signature,
    },
  });
}

function fingerprint(input) {
  const bodySha = sha256Buffer(input.body);
  const filenameSha = createHash('sha256').update(input.filename).digest('hex');
  return createHash('sha256').update(['media-payload-v1', bodySha, filenameSha, input.mime].join('\n')).digest('hex');
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

function passthrough(upstreamBase) {
  return createProxy(async (entry, { upstream, respond }) => {
    const result = await upstream();
    respond(result.status, result.text, { 'content-type': result.headers['content-type'] ?? 'application/octet-stream' });
  }, upstreamBase);
}
function dropAfterCommit(upstreamBase) {
  return createProxy(async (entry, { upstream, respond, destroy }) => {
    const result = await upstream();
    if (entry.method === 'POST') { destroy(); return; }
    respond(result.status, result.text, { 'content-type': result.headers['content-type'] ?? 'application/json' });
  }, upstreamBase);
}
function dropBeforeDelivery(upstreamBase) {
  return createProxy(async (entry, { destroy }) => destroy(), upstreamBase);
}
function dropPostThenPassthrough(upstreamBase) {
  let droppedFirstPost = false;
  return createProxy(async (entry, { upstream, respond, destroy }) => {
    if (entry.method === 'POST' && !droppedFirstPost) {
      droppedFirstPost = true;
      destroy();
      return;
    }
    const result = await upstream();
    respond(result.status, result.text, { 'content-type': result.headers['content-type'] ?? 'application/json' });
  }, upstreamBase);
}
function post500GetPass(upstreamBase) {
  return createProxy(async (entry, { upstream, respond }) => {
    const result = await upstream();
    if (entry.method === 'POST') { respond(500, '{}', { 'content-type': 'application/json' }); return; }
    respond(result.status, result.text, { 'content-type': result.headers['content-type'] ?? 'application/json' });
  }, upstreamBase);
}
function dropPostGet503(upstreamBase) {
  return createProxy(async (entry, { upstream, respond, destroy }) => {
    if (entry.method === 'GET') { respond(503, JSON.stringify({ code: 'wp_service_unavailable' }), { 'content-type': 'application/json' }); return; }
    await upstream();
    destroy();
  }, upstreamBase);
}
function mangleCreationResponse(upstreamBase, mutated) {
  return createProxy(async (entry, { upstream, respond }) => {
    const result = await upstream();
    if (entry.method === 'POST') { respond(201, mutated, { 'content-type': 'application/json' }); return; }
    respond(result.status, result.text, { 'content-type': result.headers['content-type'] ?? 'application/json' });
  }, upstreamBase);
}
function redirectResponse(upstreamBase, location) {
  return createProxy(async (entry, { respond }) => { respond(302, '', { location }); }, upstreamBase);
}
function stallProxy(upstreamBase) {
  return createProxy(async () => {}, upstreamBase);
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
    assert(existsSync(clientBuild), 'Compiled WordPressMediaClient is missing.');
    const { WordPressMediaClient } = requireModule(clientBuild);
    const { WordPressMediaError } = requireModule(resolve(runtimeDir, '.build', 'wordpress-media.errors.js'));
    const { signNewsroomMediaRequest, decodeMediaHmacSecret } = requireModule(resolve(runtimeDir, '.build', 'wordpress-media-hmac.js'));

    port = await availablePort(18391);
    baseUrl = `http://127.0.0.1:${port}`;
    assertLoopback(baseUrl);
    const mediaKeyId = 'media-local-v1';
    const mediaSecret = randomSecret();
    const draftKeyId = 'draft-local-v1';
    const draftSecret = randomSecret();
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
    const productionSnapshot = mediaProductionHashes();

    compose(['pull'], { label: 'Docker image pull' });
    compose(['up', '-d', 'db', 'wordpress', 'cli'], { sensitive: true, label: 'runtime startup' });
    await waitForHttp();

    wp(['core', 'install', `--url=${baseUrl}`, '--title=Newsroom Media Implementation Runtime', '--admin_user=runtime_admin', `--admin_password=${runtimeEnv.ADMIN_PASSWORD}`, '--admin_email=admin@example.invalid', '--skip-email'], { sensitive: true });
    wp(['rewrite', 'structure', '/%postname%/', '--hard']);
    wpEval("add_role( 'newsroom_media_service', 'Newsroom Media Service', array( 'read' => true, 'upload_files' => true ) ); echo 'ok';");
    wpEval("add_role( 'newsroom_draft_service', 'Newsroom Draft Service', array( 'read' => true, 'edit_posts' => true, 'assign_categories' => true ) ); echo 'ok';");
    const mediaUserId = Number(wp(['user', 'create', 'runtime_media', 'media@example.invalid', '--role=newsroom_media_service', `--user_pass=${runtimeEnv.ADMIN_PASSWORD}`, '--porcelain'], { sensitive: true }));
    const draftUserId = Number(wp(['user', 'create', 'runtime_draft', 'draft@example.invalid', '--role=newsroom_draft_service', `--user_pass=${runtimeEnv.ADMIN_PASSWORD}`, '--porcelain'], { sensitive: true }));
    const authorUserId = Number(wp(['user', 'create', 'runtime_author', 'author@example.invalid', '--role=author', `--user_pass=${runtimeEnv.ADMIN_PASSWORD}`, '--porcelain'], { sensitive: true }));
    assert(mediaUserId === 2 && draftUserId === 3 && authorUserId === 4, 'User fixture IDs do not match the isolated plan.');
    categoryId = Number(wp(['term', 'create', 'category', 'Implementation Runtime Category', '--porcelain']));
    assert(Number.isInteger(categoryId) && categoryId > 0, 'Draft fixture category could not be created.');
    wp(['plugin', 'activate', 'newsroom-bridge']);
    const pluginHeaderVersion = wp(['plugin', 'get', 'newsroom-bridge', '--field=version']);
    const pluginConstantVersion = wpEval('echo defined( \'NEWSROOM_BRIDGE_VERSION\' ) && defined( \'NEWSROOM_BRIDGE_MEDIA_SCHEMA_VERSION\' ) ? NEWSROOM_BRIDGE_VERSION . \'|\' . NEWSROOM_BRIDGE_MEDIA_SCHEMA_VERSION : \'\';');
    assert(pluginHeaderVersion === '1.2.0' && pluginConstantVersion === '1.2.0|1', `Plugin header/runtime version disagreement (header=${pluginHeaderVersion}, runtime=${pluginConstantVersion}).`);
    assert(wp(['option', 'get', 'newsroom_bridge_media_schema_version']) === '1', 'Media schema version changed.');
    assert(wp(['option', 'get', 'newsroom_bridge_schema_version']) === '2', 'Draft schema version changed.');
    const newsroomTables = db("SHOW TABLES LIKE 'wp_newsroom%'").split(/\r?\n/).filter(Boolean);
    assert(JSON.stringify(newsroomTables) === JSON.stringify(['wp_newsroom_media', 'wp_newsroom_reconciliation']), 'Unexpected newsroom database tables exist.');

    const mediaCapsOk = userCap(mediaUserId, 'read') === '1' && userCap(mediaUserId, 'upload_files') === '1'
      && userCap(mediaUserId, 'edit_posts') === '0' && userCap(mediaUserId, 'publish_posts') === '0'
      && userCap(mediaUserId, 'manage_options') === '0' && userCap(mediaUserId, 'unfiltered_html') === '0'
      && userCap(mediaUserId, 'activate_plugins') === '0' && userCap(mediaUserId, 'delete_posts') === '0';
    const draftCapsOk = userCap(draftUserId, 'read') === '1' && userCap(draftUserId, 'edit_posts') === '1' && userCap(draftUserId, 'upload_files') === '0';
    assert(mediaCapsOk && draftCapsOk, 'Media/draft service policies do not match the approved capability model.');
    pass('activation_and_schema', { plugin: '1.2.0', plugin_version_agrees: true, media_schema: '1', draft_schema: '2', tables: newsroomTables, media_user: mediaUserId, draft_user: draftUserId });

    const draftCreateInput = (draftKey, headline, content, categoryIds = [categoryId]) => ({
      draft_key: draftKey, title: headline, content, excerpt: '', categories: categoryIds,
    });
    const draftPost = (draftKey, headline, content) => rawDraftSignedRequest('POST', '/newsroom/v1/drafts', {
      keyId: draftKeyId, secret: draftSecret, draftKey, body: Buffer.from(JSON.stringify(draftCreateInput(draftKey, headline, content)), 'utf8'),
    });
    const draftGet = (draftKey) => rawDraftSignedRequest('GET', `/newsroom/v1/drafts/${draftKey}`, { keyId: draftKeyId, secret: draftSecret, draftKey });

    const draftKeyA = randomUUID();
    const draftCreated = await draftPost(draftKeyA, 'Production Draft Create', 'Draft body A');
    assert(draftCreated.status === 201, `Draft HMAC POST did not return 201 (status ${draftCreated.status}, text ${draftCreated.text.slice(0, 160)}).`);
    const draftCreatedBody = JSON.parse(draftCreated.text);
    assert(draftCreatedBody.draft_key === draftKeyA && typeof draftCreatedBody.post_id === 'number' && draftCreatedBody.status === 'draft' && draftCreatedBody.replayed === false, 'Draft create DTO is malformed.');
    const draftCreatedRow = draftRow(draftKeyA);
    assert(draftCreatedRow && draftCreatedRow.postId === draftCreatedBody.post_id && draftCreatedRow.actorUserId === draftUserId && draftCreatedRow.reservationToken === null, 'Draft create response did not match the committed reconciliation row.');
    pass('draft_create_201', { http: 201, author: draftUserId, durable: 1 });

    const draftReconciled = await draftGet(draftKeyA);
    assert(draftReconciled.status === 200, `Draft signed GET did not reconcile (status ${draftReconciled.status}).`);
    const draftReconciledBody = JSON.parse(draftReconciled.text);
    assert(draftReconciledBody.draft_key === draftKeyA && draftReconciledBody.post_id === draftCreatedBody.post_id && draftReconciledBody.status === 'draft', 'Draft GET did not return the committed mapping.');
    pass('draft_get_reconcile', { http: 200, post_id: draftReconciledBody.post_id });

    const draftReplay = await draftPost(draftKeyA, 'Production Draft Create', 'Draft body A');
    assert(draftReplay.status === 200, `Identical draft replay did not return 200 (status ${draftReplay.status}).`);
    const draftReplayBody = JSON.parse(draftReplay.text);
    assert(draftReplayBody.replayed === true && draftReplayBody.post_id === draftCreatedBody.post_id, 'Draft replay did not preserve the existing post mapping.');
    pass('draft_replay_200', { http: 200, replayed: true, post_id: draftReplayBody.post_id });

    const draftConflict = await draftPost(draftKeyA, 'Production Draft Create', 'Conflicting draft body');
    assert(draftConflict.status === 409, `Changed-payload draft POST did not conflict (status ${draftConflict.status}, text ${draftConflict.text.slice(0, 160)}).`);
    pass('draft_conflict_409', { http: 409, preserved_post: draftReconciledBody.post_id });

    const draftAppPassword = wpEval(`echo wp_is_application_passwords_available_for_user( get_user_by( 'id', ${draftUserId} ) ) ? 'available' : 'denied';`);
    const draftPasswordLogin = wpEval(`$u = wp_authenticate( 'runtime_draft', ${JSON.stringify(runtimeEnv.ADMIN_PASSWORD)} ); echo is_wp_error( $u ) ? 'denied' : 'ok';`);
    assert(draftAppPassword === 'denied' && draftPasswordLogin === 'denied', 'Draft identity is not locked down for generic credentials.');
    assert(userCap(draftUserId, 'upload_files') === '0' && userCap(draftUserId, 'publish_posts') === '0', 'Draft identity holds upload/publish capabilities it must lack.');
    pass('draft_identity_lockdown', { app_passwords: 'denied', password_login: 'denied', upload_files: false, publish_posts: false });

    const draftAnonGet = await request('GET', `/wp-json/newsroom/v1/drafts/${draftKeyA}`);
    assert(draftAnonGet.status === 401, `Unsigned draft GET was not rejected (status ${draftAnonGet.status}).`);
    const draftSignedCore = await rawDraftSignedRequest('GET', '/wp/v2/settings', { keyId: draftKeyId, secret: draftSecret, draftKey: draftKeyA });
    assert(draftSignedCore.status === 401, `Draft credential was not rejected on a non-whitelisted core route (status ${draftSignedCore.status}).`);
    const mediaSignedCore = await rawCrossSignedGet('/wp/v2/settings', { keyId: mediaKeyId, secret: mediaSecret, mediaKey: randomUUID() });
    assert(mediaSignedCore.status === 401, `Media credential was not rejected on a core route (status ${mediaSignedCore.status}).`);
    const mediaSignedDraft = await rawCrossSignedGet(`/newsroom/v1/drafts/${draftKeyA}`, { keyId: mediaKeyId, secret: mediaSecret, mediaKey: randomUUID() });
    assert(mediaSignedDraft.status === 401, `Media credential was not rejected on the draft route (status ${mediaSignedDraft.status}).`);
    pass('draft_core_isolation', { unsigned_get: 401, draft_to_core: 401, media_to_core: 401, media_to_draft: 401 });

    const clientOptions = () => ({ baseUrl, keyId: mediaKeyId, secret: mediaSecret, requestTimeoutMs: 5000, reconciliationAttempts: 3, reconciliationDelayMs: 20, maxBytes: 500000 });
    const client = new WordPressMediaClient(clientOptions());
    const upload = (input) => client.uploadMedia({ mediaKey: input.mediaKey, filename: input.filename, mimeType: input.mime, body: input.body });

    const pngA = makePng(4, 4);
    const pngB = makePng(4, 4, 0x42);
    const gif1 = makeGif1px();
    const bigBody = Buffer.alloc(500000 + 1);

    const key1 = randomUUID();
    const created = await upload({ mediaKey: key1, filename: 'hero.png', mime: 'image/png', body: pngA });
    assert(created.outcome === 'CREATED' && created.mediaKey === key1 && created.status === 'attachment' && created.attachmentId > 0, `Media creation outcome did not match the contract (got ${JSON.stringify(created)}).`);
    const row1 = helperMediaRow(key1);
    assert(row1 && row1.payloadHash === fingerprint({ mediaKey: key1, filename: 'hero.png', mime: 'image/png', body: pngA }) && row1.contentLength === pngA.length && row1.actorUserId === mediaUserId && row1.reservationToken === null, 'Reconciliation row postconditions failed.');
    const attach1 = attachmentInfo(created.attachmentId);
    assert(attach1 && attach1.type === 'attachment' && attach1.mime === 'image/png' && attach1.author === mediaUserId && attach1.status === 'inherit', 'Attachment postconditions failed.');
    assert(attachmentKeyMeta(created.attachmentId) === key1 && attachmentFileMeta(created.attachmentId).includes('/newsroom-media/hero.png'), 'Attachment media meta is not bound to the managed file.');
    assert(fileExists('hero.png') === '1', 'Uploaded file is missing from the media-managed directory.');
    assert(fileSha('hero.png') === sha256Buffer(pngA), 'Uploaded file bytes differ from the signed raw body.');
    assert(mediaRowCount(key1) === 1 && attachmentCountFor(key1) === 1, 'Duplicate durable rows created on first upload.');
    pass('create_201', { outcome: 'CREATED', attachment: created.attachmentId, managed_path: '/newsroom-media/hero.png', bytes_exact: true });

    const lookup = await client.getMediaByKey(key1);
    assert(lookup.mediaKey === key1 && lookup.status === 'attachment' && lookup.attachmentId === created.attachmentId, 'Signed GET postcondition failed.');
    pass('get_media_200', { http: 200, attachment_id: lookup.attachmentId });

    const replay = await upload({ mediaKey: key1, filename: 'hero.png', mime: 'image/png', body: pngA });
    assert(replay.outcome === 'REPLAYED' && replay.attachmentId === created.attachmentId, 'Signed replay did not return the existing attachment.');
    assert(mediaRowCount(key1) === 1 && attachmentCountFor(key1) === 1, 'Signed replay duplicated durable state.');
    pass('signed_replay', { outcome: 'REPLAYED', media: 1, attachment: 1 });

    const conflictInput = { mediaKey: key1, filename: 'hero.png', mime: 'image/png', body: pngB };
    let conflictError = null;
    try { await upload(conflictInput); } catch (error) { conflictError = error; }
    assert(conflictError instanceof WordPressMediaError && conflictError.code === 'CONFLICT' && conflictError.httpStatus === 409, 'Same-key conflicting payload was not rejected with CONFLICT.');
    assert(helperMediaRow(key1)?.payloadHash === fingerprint({ mediaKey: key1, filename: 'hero.png', mime: 'image/png', body: pngA }) && mediaRowCount(key1) === 1, 'Idempotency conflict changed the preserved mapping.');
    pass('conflict_409', { code: 'CONFLICT', preserved: true });

    const unauthorized = new WordPressMediaClient({ ...clientOptions(), keyId: 'client-unknown-a' });
    let authError = null;
    try { await unauthorized.uploadMedia({ mediaKey: randomUUID(), filename: 'hero.png', mimeType: 'image/png', body: pngA }); } catch (error) { authError = error; }
    assert(authError instanceof WordPressMediaError && authError.code === 'AUTHENTICATION_FAILURE' && authError.httpStatus === 401, 'Unknown-key POST was not rejected with AUTHENTICATION_FAILURE/401.');
    let authGetError = null;
    try { await unauthorized.getMediaByKey(key1); } catch (error) { authGetError = error; }
    assert(authGetError instanceof WordPressMediaError && authGetError.code === 'AUTHENTICATION_FAILURE' && authGetError.httpStatus === 401, 'Unknown-key GET was not rejected with AUTHENTICATION_FAILURE/401.');
    pass('authentication_failure_401', { post: { code: 'AUTHENTICATION_FAILURE', http: 401 }, get: { code: 'AUTHENTICATION_FAILURE', http: 401 } });

    let oversized = null;
    try { await upload({ mediaKey: randomUUID(), filename: 'big.png', mime: 'image/png', body: bigBody }); } catch (error) { oversized = error; }
    assert(oversized instanceof WordPressMediaError && oversized.code === 'PAYLOAD_REJECTED' && oversized.httpStatus === 413, 'Oversized body was not rejected with PAYLOAD_REJECTED/413.');
    pass('payload_rejected_413', { code: 'PAYLOAD_REJECTED', http: 413, length: bigBody.length });

    const mismatch = await rawSignedRequest('POST', '/newsroom-media/v1/media', { keyId: mediaKeyId, secret: mediaSecret, mediaKey: randomUUID(), filename: 'trick.png', mime: 'image/png', body: gif1 });
    assert(mismatch.status === 400, `GIF bytes claimed as PNG were not rejected with 400 (status ${mismatch.status}, text ${mismatch.text.slice(0, 120)}).`);
    const terribleName = await rawSignedRequest('POST', '/newsroom-media/v1/media', { keyId: mediaKeyId, secret: mediaSecret, mediaKey: randomUUID(), filename: 'evil.png.php', mime: 'image/png', body: pngA });
    assert(terribleName.status === 400, `Extension-mismatched filename was not rejected with 400 (status ${terribleName.status}, text ${terribleName.text.slice(0, 120)}).`);
    pass('content_validation_400', { mime_mismatch: 400, extension_mismatch: 400, durable_rows_unchanged: mediaTotalRows() });

    const crossDraftRoute = `/newsroom/v1/drafts/${randomUUID()}`;
    const feedMediaSignedToDraft = await rawCrossSignedGet(crossDraftRoute, { keyId: mediaKeyId, secret: mediaSecret, mediaKey: key1 });
    assert(feedMediaSignedToDraft.status === 401, 'Media-signed request on the draft route was not rejected with 401.');
    const feedDraftSignedToMedia = rawSignedRequest('GET', `/newsroom-media/v1/media/${key1}`, { keyId: draftKeyId, secret: draftSecret, mediaKey: key1 });
    const draftCross = await feedDraftSignedToMedia;
    assert(draftCross.status === 401, 'Draft-signed request on the media route was not rejected with 401.');
    pass('cross_route_rejection', { media_headers_to_draft: 401, draft_headers_to_media: 401 });

    const collection = await rawCrossSignedGet('/newsroom-media/v1/media', { keyId: mediaKeyId, secret: mediaSecret, mediaKey: key1 });
    const badKey = await rawCrossSignedGet(`/newsroom-media/v1/media/${'a'.repeat(36)}`, { keyId: mediaKeyId, secret: mediaSecret, mediaKey: 'a'.repeat(36) });
    assert(collection.status === 401 && badKey.status === 401, `Collection or invalid-key lookups were not rejected with 401 (status ${collection.status}, ${badKey.status}).`);
    const queryGet = await rawCrossSignedGet(`/newsroom-media/v1/media/${key1}?ignored=1`, { keyId: mediaKeyId, secret: mediaSecret, mediaKey: key1 });
    assert(queryGet.status === 401, `A query string on a signed media GET was not rejected with 401 (status ${queryGet.status}).`);
    pass('route_1044_and_query', { collection: 401, invalid_key: 401, signed_get_with_query: 401 });

    const appPasswordMedia = wpEval(`echo wp_is_application_passwords_available_for_user( get_user_by( 'id', ${mediaUserId} ) ) ? 'available' : 'denied';`);
    const appPasswordAuthor = wpEval(`echo wp_is_application_passwords_available_for_user( get_user_by( 'id', ${authorUserId} ) ) ? 'available' : 'denied';`);
    assert(appPasswordMedia === 'denied' && appPasswordAuthor === 'available', 'Application-password availability diverges from the media policy.');
    const authMedia = wpEval(`$u = wp_authenticate( 'runtime_media', ${JSON.stringify(runtimeEnv.ADMIN_PASSWORD)} ); echo is_wp_error( $u ) ? 'denied' : 'ok';`);
    const authAuthor = wpEval(`$u = wp_authenticate( 'runtime_author', ${JSON.stringify(runtimeEnv.ADMIN_PASSWORD)} ); echo is_wp_error( $u ) ? 'denied' : 'ok';`);
    assert(authMedia === 'denied' && authAuthor === 'ok', 'Generic authentication lockdown is not scoped to the media identity.');
    pass('service_lockdown', { app_passwords: { media: 'denied', author: 'available' }, password_login: { media: 'denied', author: 'ok' } });

    const xmlrpcMedia = await request('POST', '/xmlrpc.php', { headers: { 'content-type': 'text/xml' }, body: `<?xml version="1.0"?><methodCall><methodName>wp.getUsersBlogs</methodName><params><param><value>runtime_media</value></param><param><value>${runtimeEnv.ADMIN_PASSWORD}</value></param></params></methodCall>` });
    const xmlrpcAuthor = await request('POST', '/xmlrpc.php', { headers: { 'content-type': 'text/xml' }, body: `<?xml version="1.0"?><methodCall><methodName>wp.getUsersBlogs</methodName><params><param><value>runtime_author</value></param><param><value>${runtimeEnv.ADMIN_PASSWORD}</value></param></params></methodCall>` });
    const xmlrpcMediaFault = xmlrpcMedia.text.includes('<fault>');
    const xmlrpcAuthorFault = xmlrpcAuthor.text.includes('<fault>');
    assert(xmlrpcMediaFault && !xmlrpcAuthorFault, `XML-RPC denial is not enforced or leaked to regular users (media ${xmlrpcMedia.status} fault=${xmlrpcMediaFault}, author ${xmlrpcAuthor.status} fault=${xmlrpcAuthorFault}).`);
    pass('xmlrpc_403', { media: `${xmlrpcMedia.status}${xmlrpcMediaFault ? '-fault' : ''}`, author: `${xmlrpcAuthor.status}${xmlrpcAuthorFault ? '-fault' : ''}` });

    const recordingProxy = passthrough(baseUrl);
    await recordingProxy.listen();
    const recordingClient = new WordPressMediaClient({ ...clientOptions(), baseUrl: recordingProxy.url() });
    const recordedKey = randomUUID();
    const recordedInput = { mediaKey: recordedKey, filename: 'recorded.png', mimeType: 'image/png', body: pngA };
    await recordingClient.uploadMedia(recordedInput);
    await recordingClient.getMediaByKey(recordedKey);
    await recordingProxy.close();
    const postEntry = recordingProxy.requests.find((entry) => entry.method === 'POST');
    const getEntry = recordingProxy.requests.find((entry) => entry.method === 'GET');
    assert(postEntry && getEntry, 'Recording proxy did not capture POST and GET.');
    const genericHeaders = ['authorization', 'cookie', 'x-wp-nonce'];
    const hasGeneric = (entry) => Object.keys(entry.headers).some((name) => genericHeaders.includes(name.toLowerCase()));
    assert(!hasGeneric(postEntry) && !hasGeneric(getEntry), 'Client request carried a generic authentication header.');
    assert(postEntry.headers['x-newsroom-media-auth-version'] === '1' && postEntry.headers['x-newsroom-media-key-id'] === mediaKeyId && /^[0-9]{10}$/.test(postEntry.headers['x-newsroom-media-timestamp'] ?? '') && /^[0-9a-f]{64}$/.test(postEntry.headers['x-newsroom-media-signature'] ?? ''), 'POST media HMAC headers are malformed.');
    assert(postEntry.headers['content-type'] === 'application/octet-stream' && getEntry.headers['content-type'] === undefined && postEntry.body.length === pngA.length && getEntry.body.length === 0, 'POST/GET wire format differs from the approved media contract.');
    assert(Buffer.compare(postEntry.body, pngA) === 0, 'POST body bytes differ from the signed exact buffer.');
    pass('no_generic_auth_headers', { post: 'hmac-only, octet-stream, exact bytes', get: 'hmac-only, no content type, no body', generic: 0 });

    const redirectTarget = `${baseUrl}/wp-json/wp/v2/settings`;
    const redirectProxy = redirectResponse(baseUrl, redirectTarget);
    await redirectProxy.listen();
    const redirectClient = new WordPressMediaClient({ ...clientOptions(), baseUrl: redirectProxy.url() });
    let redirectError = null;
    try { await redirectClient.uploadMedia({ mediaKey: randomUUID(), filename: 'hero.png', mimeType: 'image/png', body: pngA }); } catch (error) { redirectError = error; }
    await redirectProxy.close();
    assert(redirectError instanceof WordPressMediaError && redirectError.code === 'CONTRACT_FAILURE', 'Manual-redirect 3xx was not classified as CONTRACT_FAILURE.');
    assert(redirectProxy.requests.length === 1 && redirectProxy.requests[0]?.clientStatus === 302, 'Client followed the redirect or issued a second request.');
    const redirectHasleak = Object.keys(redirectProxy.requests[0]?.headers ?? {}).some((name) => genericHeaders.includes(name.toLowerCase()));
    assert(!redirectHasleak, 'Redirected request carried a generic authentication header.');
    pass('redirect_no_hmac_leak', { first_request: 302, requests: redirectProxy.requests.length, redirected_path_hits: 0 });

    const mangleKey = randomUUID();
    const mangleInput = { mediaKey: mangleKey, filename: 'hero.png', mimeType: 'image/png', body: pngA };
    const mangleProxy = mangleCreationResponse(baseUrl, JSON.stringify({ attachment_id: 999 }));
    await mangleProxy.listen();
    const mangleClient = new WordPressMediaClient({ ...clientOptions(), baseUrl: mangleProxy.url() });
    let mangleError = null;
    try { await mangleClient.uploadMedia(mangleInput); } catch (error) { mangleError = error; }
    await mangleProxy.close();
    assert(mangleError instanceof WordPressMediaError && mangleError.code === 'UNEXPECTED_RESPONSE', 'Malformed creation DTO was not rejected as UNEXPECTED_RESPONSE.');
    const mangleKey2 = randomUUID();
    const mangleProxy2 = mangleCreationResponse(baseUrl, 'not-json-at-all');
    await mangleProxy2.listen();
    const mangleClient2 = new WordPressMediaClient({ ...clientOptions(), baseUrl: mangleProxy2.url() });
    let mangleError2 = null;
    try { await mangleClient2.uploadMedia({ mediaKey: mangleKey2, filename: 'hero.png', mimeType: 'image/png', body: pngA }); } catch (error) { mangleError2 = error; }
    await mangleProxy2.close();
    assert(mangleError2 instanceof WordPressMediaError && mangleError2.code === 'UNEXPECTED_RESPONSE', 'Non-JSON creation response was not rejected as UNEXPECTED_RESPONSE.');
    assert(helperMediaRow(mangleKey)?.attachmentId && helperMediaRow(mangleKey2)?.attachmentId, 'Malformed-response scenarios lost their upstream durable state.');
    pass('malformed_response_rejection', { missing_keys: 'UNEXPECTED_RESPONSE', non_json: 'UNEXPECTED_RESPONSE', durable_preserved: true });

    const droppedProxy = dropAfterCommit(baseUrl);
    await droppedProxy.listen();
    const droppedClient = new WordPressMediaClient({ ...clientOptions(), baseUrl: droppedProxy.url() });
    const droppedKey = randomUUID();
    const droppedFile = 'aftmap.png';
    const droppedInput = { mediaKey: droppedKey, filename: droppedFile, mimeType: 'image/png', body: pngA };
    const recovered = await droppedClient.uploadMedia(droppedInput);
    await droppedProxy.close();
    assert(recovered.outcome === 'RECOVERED' && recovered.attachmentId > 0, 'Response loss after mapping did not reconcile to the committed attachment.');
    const droppedRow = helperMediaRow(droppedKey);
    assert(droppedRow && droppedRow.attachmentId === recovered.attachmentId && droppedRow.reservationToken === null, 'After-mapping recovery durable row is not mapped with reservation cleared.');
    const droppedAttachment = attachmentInfo(recovered.attachmentId);
    assert(droppedAttachment && droppedAttachment.status === 'inherit' && droppedAttachment.type === 'attachment' && droppedAttachment.mime === 'image/png' && droppedAttachment.author === mediaUserId, 'After-mapping recovery attachment is not valid/preserved.');
    const droppedFileCount = mediaDirEntries().split(/\r?\n/).filter((entry) => entry === droppedFile).length;
    assert(droppedFileCount === 1 && fileExists(droppedFile) === '1' && fileSha(droppedFile) === sha256Buffer(pngA), 'After-mapping recovery managed file is not present exactly once with the exact bytes.');
    assert(mediaRowCount(droppedKey) === 1 && attachmentCountFor(droppedKey) === 1, 'After-mapping recovery left duplicate durable rows or attachments.');
    const droppedPosts = droppedProxy.requests.filter((entry) => entry.method === 'POST').length;
    const droppedGets = droppedProxy.requests.filter((entry) => entry.method === 'GET').length;
    assert(droppedPosts === 1 && droppedGets >= 1, 'After-mapping recovery did not POST once and GET to reconcile.');
    const afterMapGet = await client.getMediaByKey(droppedKey);
    assert(afterMapGet.attachmentId === recovered.attachmentId && afterMapGet.status === 'attachment', 'After-mapping signed GET did not recover the same attachment.');
    const afterMapRetry = await upload({ mediaKey: droppedKey, filename: droppedFile, mime: 'image/png', body: pngA });
    assert(afterMapRetry.outcome === 'REPLAYED' && afterMapRetry.attachmentId === recovered.attachmentId, 'Post-recovery retry created a second attachment.');
    assert(mediaRowCount(droppedKey) === 1 && attachmentCountFor(droppedKey) === 1 && mediaDirEntries().split(/\r?\n/).filter((entry) => entry === droppedFile).length === 1, 'Post-recovery retry duplicated row, attachment, or file.');
    pass('after_mapping_recovery', { outcome: 'RECOVERED', posts: droppedPosts, gets: droppedGets, row_mapped: true, reservation_token: null, attachment_valid: true, file_once: true, replay_after: 'REPLAYED', durable: { media: 1, attachment: 1, file: 1 } });

    const retryProxy = dropPostThenPassthrough(baseUrl);
    await retryProxy.listen();
    const retryClient = new WordPressMediaClient({ ...clientOptions(), baseUrl: retryProxy.url() });
    const retryKey = randomUUID();
    const retried = await retryClient.uploadMedia({ mediaKey: retryKey, filename: 'hero.png', mimeType: 'image/png', body: pngA });
    await retryProxy.close();
    const retryPosts = retryProxy.requests.filter((entry) => entry.method === 'POST').length;
    const retryGets = retryProxy.requests.filter((entry) => entry.method === 'GET').length;
    assert(retried.outcome === 'CREATED' && retryPosts === 2 && retryGets === 1, 'Undelivered-POST GET-404 retry did not issue exactly two POSTs and one GET.');
    assert(mediaRowCount(retryKey) === 1 && attachmentCountFor(retryKey) === 1, 'Retried media durable state is inconsistent.');
    const retryPost = retryProxy.requests[2];
    const retryVerified = retryPost.body.length === pngA.length && Buffer.compare(retryPost.body, pngA) === 0
      && retryPost.headers['x-newsroom-media-key'] === retryKey
      && retryPost.headers['x-newsroom-media-auth-version'] === '1'
      && retryPost.headers['x-newsroom-media-key-id'] === mediaKeyId
      && /^[0-9a-f]{64}$/.test(retryPost.headers['x-newsroom-media-signature'] ?? '');
    const retrySimpleCanonical = ['newsroom-media-hmac-v1', mediaKeyId, 'POST', '/newsroom-media/v1/media', retryPost.headers['x-newsroom-media-timestamp'], retryKey, createHash('sha256').update(Buffer.from('hero.png', 'utf8')).digest('hex'), 'image/png', createHash('sha256').update(pngA).digest('hex')].join('\n');
    const retrySignatureMatches = createHmac('sha256', requireModule(resolve(runtimeDir, '.build', 'wordpress-media-hmac.js')).decodeMediaHmacSecret(mediaSecret)).update(retrySimpleCanonical).digest('hex') === retryPost.headers['x-newsroom-media-signature'];
    assert(retryVerified && retrySignatureMatches, 'Retried POST did not carry a preserved key/bytes with an independently verifiable fresh signature.');
    pass('uncertainty_b_get404_retry', { client_posts: retryPosts, gets: retryGets, outcome: 'CREATED', re_signed: true });

    const blindProxy = dropPostGet503(baseUrl);
    await blindProxy.listen();
    const blindClient = new WordPressMediaClient({ ...clientOptions(), baseUrl: blindProxy.url(), reconciliationAttempts: 2 });
    const blindKey = randomUUID();
    const blindInput = { mediaKey: blindKey, filename: 'hero.png', mimeType: 'image/png', body: pngA };
    let blindError = null;
    try { await blindClient.uploadMedia(blindInput); } catch (error) { blindError = error; }
    await blindProxy.close();
    const blindPosts = blindProxy.requests.filter((entry) => entry.method === 'POST').length;
    const blindGets = blindProxy.requests.filter((entry) => entry.method === 'GET').length;
    assert(blindError instanceof WordPressMediaError && blindError.code === 'IN_PROGRESS', 'GET-503 recovery did not surface the definite IN_PROGRESS classification.');
    assert(blindPosts === 1 && blindGets === 1, 'GET-503 recovery issued a blind second POST or an extra GET.');
    assert(helperMediaRow(blindKey)?.attachmentId && mediaRowCount(blindKey) === 1, 'Uncertain recovery durable state is inconsistent (upstream committed).');
    pass('uncertainty_d_no_blind_post', { client_posts: blindPosts, gets: blindGets, code: 'IN_PROGRESS', durable: 1 });

    const fiveProxy = post500GetPass(baseUrl);
    await fiveProxy.listen();
    const fiveClient = new WordPressMediaClient({ ...clientOptions(), baseUrl: fiveProxy.url() });
    const fiveKey = randomUUID();
    const fiveResult = await fiveClient.uploadMedia({ mediaKey: fiveKey, filename: 'hero.png', mimeType: 'image/png', body: pngA });
    await fiveProxy.close();
    assert(fiveResult.outcome === 'RECOVERED' && fiveResult.attachmentId > 0, 'POST-500 uncertainty did not recover through a signed GET.');
    pass('uncertainty_c_post500_get', { outcome: 'RECOVERED', posts: 1, gets: 1 });

    const stall = stallProxy(baseUrl);
    await stall.listen();
    const stallClient = new WordPressMediaClient({ ...clientOptions(), baseUrl: stall.url(), requestTimeoutMs: 300, reconciliationAttempts: 2, reconciliationDelayMs: 10 });
    let stallError = null;
    const stallStarted = Date.now();
    try { await stallClient.uploadMedia({ mediaKey: randomUUID(), filename: 'hero.png', mimeType: 'image/png', body: pngA }); } catch (error) { stallError = error; }
    const stallElapsed = Date.now() - stallStarted;
    await stall.close();
    assert(stallError instanceof WordPressMediaError && stallError.code === 'UNCERTAIN_OUTCOME', 'Bounded-unavailable scenario did not raise UNCERTAIN_OUTCOME.');
    assert(stall.requests.length === 3 && stall.requests.filter((entry) => entry.method === 'POST').length === 1, 'Bounded-unavailable request counts are not bounded to POST + reconciliationAttempts GETs.');
    assert(stallElapsed < 6000, 'Bounded-unavailable client exceeded the request budget.');
    pass('bounded_unavailable', { requests: stall.requests.length, post: 1, gets: 2, code: 'UNCERTAIN_OUTCOME', elapsed_ms: stallElapsed });

    const reservedKey = randomUUID();
    const reservedPayload = { mediaKey: reservedKey, filename: 'hero.png', mime: 'image/png', body: pngA };
    const reservedFingerprint = fingerprint(reservedPayload);
    db(`INSERT INTO wp_newsroom_media (media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token, created_at, updated_at) VALUES ('${reservedKey}', NULL, '${reservedFingerprint}', ${pngA.length}, ${mediaUserId}, '11111111-1111-4111-8111-111111111111', UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
    let reservedGet = null;
    try { await client.getMediaByKey(reservedKey); } catch (error) { reservedGet = error; }
    assert(reservedGet instanceof WordPressMediaError && reservedGet.code === 'IN_PROGRESS', 'A reserved mapping did not surface as IN_PROGRESS.');
    db(`UPDATE wp_newsroom_media SET updated_at = DATE_SUB( UTC_TIMESTAMP(), INTERVAL 65 SECOND ) WHERE media_key = '${reservedKey}'`);
    const reclaimed = await upload(reservedPayload);
    assert(reclaimed.outcome === 'CREATED' && reclaimed.attachmentId > 0, 'Stale-reservation reclaim did not continue as the new owner.');
    assert(helperMediaRow(reservedKey)?.reservationToken === null && mediaRowCount(reservedKey) === 1, 'Reclaimed reservation did not commit cleanly.');
    pass('reserved_get_and_stale_reclaim', { get_reserved: 'IN_PROGRESS', reclaim: 'CREATED', durable: 1 });

    const concurrentResults = [];
    const identicalKey = randomUUID();
    const identicalPayload = { mediaKey: identicalKey, filename: 'hero.png', mime: 'image/png', body: pngA };
    for (let i = 0; i < 10; i += 1) {
      concurrentResults.push(upload(identicalPayload).then((value) => ({ key: identicalKey, outcome: value.outcome, error: null }), (error) => ({ key: identicalKey, outcome: null, error: error.wordpressMediaErrorCode ?? error.code ?? error.message })));
    }
    const conflictingKey = randomUUID();
    for (let i = 0; i < 10; i += 1) {
      concurrentResults.push(upload({ mediaKey: conflictingKey, filename: 'hero.png', mime: 'image/png', body: makePng(6 + i, 6 + i, 0x33) }).then((value) => ({ key: conflictingKey, outcome: value.outcome, error: null }), (error) => ({ key: conflictingKey, outcome: null, error: error instanceof WordPressMediaError ? error.code : String(error?.message ?? error) })));
    }
    const settled = await Promise.all(concurrentResults);
    const identicalOutcomes = settled.filter((result) => result.key === identicalKey);
    const conflictingOutcomes = settled.filter((result) => result.key === conflictingKey);
    assert(identicalOutcomes.length === 10 && identicalOutcomes.filter((result) => result.error === null).length === 10, 'Concurrent identical uploads produced an unexpected error.');
    assert(identicalOutcomes.filter((result) => result.outcome === 'CREATED').length === 1 && identicalOutcomes.filter((result) => result.outcome === 'REPLAYED').length === 9, 'Concurrent identical uploads did not resolve to exactly one creator.');
    assert(mediaRowCount(identicalKey) === 1 && attachmentCountFor(identicalKey) === 1, 'Concurrent identical uploads left duplicate durable state.');
    assert(conflictingOutcomes.length === 10 && conflictingOutcomes.filter((result) => result.error === null || result.error === 'CONFLICT').length === 10, 'Concurrent conflicting uploads produced an unexpected error type.');
    assert(conflictingOutcomes.filter((result) => result.error === null).length === 1 && conflictingOutcomes.filter((result) => result.error === 'CONFLICT').length === 9, 'Concurrent conflicting uploads did not resolve to exactly one conflict winner.');
    assert(mediaRowCount(conflictingKey) === 1 && attachmentCountFor(conflictingKey) === 1, 'Concurrent conflicting uploads left duplicate durable state.');
    pass('concurrency_10_10', { identical_created: 1, identical_replayed: 9, conflict_winner: 1, conflict_409: 9, durable: { identical: 1, conflicting: 1 } });

    const adoptionKey = randomUUID();
    const adoptionPayload = { mediaKey: adoptionKey, filename: 'adopt.png', mime: 'image/png', body: pngA };
    const adoptionFingerprint = fingerprint(adoptionPayload);
    db(`INSERT INTO wp_newsroom_media (media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token, created_at, updated_at) VALUES ('${adoptionKey}', NULL, '${adoptionFingerprint}', ${pngA.length}, ${mediaUserId}, '22222222-2222-4222-8222-222222222222', UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
    const adoptionAttachment = Number(wpEval(`@mkdir( ${JSON.stringify(managedMediaDir())}, 0755, true ); echo '1';`));
    void adoptionAttachment;
    wpEval(`
      $to = ${JSON.stringify(managedMediaDir())} . '/adopt.png';
      $bytes = base64_decode( '${Buffer.from(pngA).toString('base64')}' );
      file_put_contents( $to, $bytes );
      $id = wp_insert_attachment( array( 'post_mime_type' => 'image/png', 'post_status' => 'inherit' ), $to, 0, true );
      update_post_meta( $id, '_newsroom_media_key', '${sqlEscape(adoptionKey)}' );
      update_post_meta( $id, '_newsroom_media_file', $to );
      echo $id;
    `);
    let adoptedGetBefore = null;
    try { await client.getMediaByKey(adoptionKey); } catch (error) { adoptedGetBefore = error; }
    assert(adoptedGetBefore instanceof WordPressMediaError && adoptedGetBefore.code === 'IN_PROGRESS', 'Adoption fixture was not reserved before GC.');
    forceGarbageCollect();
    await client.getMediaByKey(adoptionKey);
    const adoptedRow = helperMediaRow(adoptionKey);
    assert(adoptedRow && adoptedRow.attachmentId > 0 && adoptedRow.reservationToken === null, 'GC adoption did not commit the reserved mapping to the claimed attachment.');
    assert(attachmentCountFor(adoptionKey) === 1, 'GC adoption left the media attachment unbound.');
    pass('gc_pass1_adoption', { adopted: true, committed: true });

    const orphanAttachmentKey = randomUUID();
    const orphanAttachmentId = Number(wpEval(`
      $to = ${JSON.stringify(managedMediaDir())} . '/orphan.png';
      file_put_contents( $to, base64_decode( '${Buffer.from(pngA).toString('base64')}' ) );
      $id = wp_insert_attachment( array( 'post_mime_type' => 'image/png', 'post_status' => 'inherit' ), $to, 0, true );
      update_post_meta( $id, '_newsroom_media_key', '${sqlEscape(orphanAttachmentKey)}' );
      update_post_meta( $id, '_newsroom_media_file', $to );
      echo $id;
    `));
    assert(orphanAttachmentId > 0 && attachmentCountFor(orphanAttachmentKey) === 1, 'Orphan attachment fixture was not created.');
    forceGarbageCollect();
    await client.getMediaByKey(key1);
    const orphanLeft = attachmentInfo(orphanAttachmentId);
    const orphanFileGone = fileExists('orphan.png') === '0';
    assert(orphanLeft === null && orphanFileGone, 'GC did not delete the orphan attachment and its managed file.');
    pass('gc_pass2_orphan_attachment', { attachment: 'deleted', file: 'deleted' });

    const sizedBaseKey = randomUUID();
    await upload({ mediaKey: sizedBaseKey, filename: 'sized.png', mime: 'image/png', body: pngA });
    wpEval(`
      $to = ${JSON.stringify(managedMediaDir())} . '/sized-150x150.png';
      file_put_contents( $to, base64_decode( '${Buffer.from(pngA).toString('base64')}' ) );
    `);
    wpEval(`file_put_contents( ${JSON.stringify(uploadBaseDir())} . '/unmanaged-friend.txt', 'keep' );`);
    wpEval(`file_put_contents( ${JSON.stringify(managedMediaDir())} . '/vagrant-orphan.txt', 'drop' );`);
    forceGarbageCollect();
    await client.getMediaByKey(sizedBaseKey);
    const sizedVariantGone = fileExists('sized-150x150.png') === '0';
    const rawOrphanGone = fileExists('vagrant-orphan.txt') === '0';
    const unmanagedKept = wpEval(`echo file_exists( ${JSON.stringify(uploadBaseDir())} . '/unmanaged-friend.txt' ) ? '1' : '0';`);
    assert(sizedVariantGone === false && rawOrphanGone === true && unmanagedKept === '1', 'GC sized-variant protection or directory boundary failed.');
    pass('gc_pass3_scoped_files', { sized_variant: 'kept', raw_orphan: 'deleted', unmanaged: 'untouched' });

    const faultPhases = ['after_reservation', 'after_file', 'after_insert', 'during_metadata'];
    for (const phase of faultPhases) {
      const faultKey = randomUUID();
      const faultFile = `fault-${phase}.png`;
      faultPhase(phase);
      let faultStatus = -1;
      try { faultStatus = (await rawSignedRequest('POST', '/newsroom-media/v1/media', { keyId: mediaKeyId, secret: mediaSecret, mediaKey: faultKey, filename: faultFile, mime: 'image/png', body: pngA })).status; } catch { faultStatus = 0; }
      faultPhase(null);
      assert([0, 500].includes(faultStatus), `Fault phase ${phase} did not interrupt the pipeline (status ${faultStatus}).`);
      assert(mediaRowCount(faultKey) === 0 && attachmentCountFor(faultKey) === 0, `Fault phase ${phase} left a durable row or attachment behind.`);
      if (phase !== 'after_reservation') {
        assert(fileExists(faultFile) === '1', `Fault phase ${phase} did not leave the written file behind.`);
        forceGarbageCollect();
        await client.getMediaByKey(key1);
        assert(fileExists(faultFile) === '0', `Fault phase ${phase} orphan file was not garbage-collected.`);
      }
      const fresh = await upload({ mediaKey: faultKey, filename: faultFile, mime: 'image/png', body: pngA });
      assert(fresh.outcome === 'CREATED' && fresh.attachmentId > 0 && mediaRowCount(faultKey) === 1, `Fault phase ${phase} did not recover with a fresh deterministic create.`);
      pass(`fault_window_${phase}`, { interrupted: faultStatus, durable: 0, gc: phase !== 'after_reservation' ? 'orphan_file_removed' : 'no_file_written', recover: 'CREATED' });
    }

    const gcRerun = await (async () => { forceGarbageCollect(); await client.getMediaByKey(key1); return 'ok'; })();
    assert(gcRerun === 'ok', 'GC rerun interrupted a media request.');
    pass('gc_idempotent_rerun', { rerun: 'ok' });

    const schemaNegative = async (name, corrupt, repair, expectCode) => {
      const candidate = randomUUID();
      const candidateFile = `${name}.png`;
      const baseRows = mediaTotalRows();
      corrupt();
      const post = await rawSignedRequest('POST', '/newsroom-media/v1/media', { keyId: mediaKeyId, secret: mediaSecret, mediaKey: candidate, filename: candidateFile, mime: 'image/png', body: pngA });
      const get = await signedMediaGetClean(key1, mediaKeyId, mediaSecret);
      assert(post.status === 503 && post.text.includes(expectCode), `Schema corruption ${name}: POST did not fail closed (status ${post.status}, text ${post.text.slice(0, 160)}).`);
      assert(get.status === 503 && get.text.includes(expectCode), `Schema corruption ${name}: GET did not fail closed (status ${get.status}, text ${get.text.slice(0, 160)}).`);
      assert(mediaRowCount(candidate) === 0 && attachmentCountFor(candidate) === 0 && fileExists(candidateFile) === '0', `Schema corruption ${name}: a media write occurred while fail-closed.`);
      assert(mediaTotalRows() === baseRows, `Schema corruption ${name}: durable row count changed while fail-closed.`);
      repair();
      const repairedPost = await rawSignedRequest('POST', '/newsroom-media/v1/media', { keyId: mediaKeyId, secret: mediaSecret, mediaKey: candidate, filename: candidateFile, mime: 'image/png', body: pngA });
      assert(repairedPost.status === 201, `Schema corruption ${name}: repair did not restore normal create (status ${repairedPost.status}, text ${repairedPost.text.slice(0, 160)}).`);
      const repairedRow = helperMediaRow(candidate);
      assert(repairedRow && repairedRow.attachmentId > 0 && repairedRow.reservationToken === null, `Schema corruption ${name}: repaired row is not committed.`);
      assert(mediaTotalRows() === baseRows + 1, `Schema corruption ${name}: repaired create did not add exactly one durable row.`);
      pass(`schema_negative_${name}`, { post_fail_closed: 503, code: expectCode, read_fail_closed: 503, writes_while_corrupt: 0, repaired_create: 201, durable_after_repair: 1 });
    };
    await schemaNegative('wrong_engine', () => db('ALTER TABLE wp_newsroom_media ENGINE=MyISAM'), () => db('ALTER TABLE wp_newsroom_media ENGINE=InnoDB'), 'newsroom_media_storage_error');
    await schemaNegative('missing_attachment_unique', () => db('ALTER TABLE wp_newsroom_media DROP INDEX attachment_id'), () => db('ALTER TABLE wp_newsroom_media ADD UNIQUE KEY attachment_id (attachment_id)'), 'newsroom_media_storage_error');
    await schemaNegative('missing_payload_hash_index', () => db('ALTER TABLE wp_newsroom_media DROP INDEX idx_payload_hash'), () => db('ALTER TABLE wp_newsroom_media ADD KEY idx_payload_hash (payload_hash)'), 'newsroom_media_storage_error');
    await schemaNegative('wrong_schema_version', () => wp(['option', 'update', 'newsroom_bridge_media_schema_version', '0']), () => wpEval('Newsroom_Bridge_Media_DB::install();'), 'newsroom_bridge_media_not_configured');

    const recordedSignatureValues = recordingProxy.requests.flatMap((entry) => (entry.headers['x-newsroom-media-signature'] ? [entry.headers['x-newsroom-media-signature']] : []));
    knownSecrets.push(...recordedSignatureValues);
    knownSecrets.push(Buffer.from(mediaSecret, 'base64url').toString('hex'), mediaSecret);
    knownSecrets.push(Buffer.from(draftSecret, 'base64url').toString('hex'), draftSecret);

    const logs = compose(['logs', '--no-color', 'wordpress'], { sensitive: true }).stdout;
    const excludedKnown = knownSecrets.filter((item) => item && item.length >= 8);
    const logLeakCounts = excludedKnown.map((item) => logs.includes(item) ? 1 : 0);
    const leakIndexes = logLeakCounts.map((count, index) => count === 1 ? index : -1).filter((index) => index >= 0);
    assert(logs.includes('newsroom_bridge_security') && logLeakCounts.every((count) => count === 0), `Security log sentinel leakage test failed: circular bytes=${logs.length}, leak_indexes=${JSON.stringify(leakIndexes)}.`);

    const textTables = [
      ["SELECT COUNT(*) FROM wp_options WHERE option_value LIKE '%${sqlEscape(mediaSecret)}%'", 'wp_options'],
      [`SELECT COUNT(*) FROM wp_postmeta pm INNER JOIN wp_posts p ON p.ID = pm.post_id WHERE pm.meta_value LIKE '%${sqlEscape(mediaSecret)}%' OR p.post_content LIKE '%${sqlEscape(mediaSecret)}%'`, 'wp_posts'],
    ];
    const databaseAudit = Object.fromEntries(textTables.map(([query, table]) => [table, Number(db(query))]));
    assert(Object.values(databaseAudit).every((count) => count === 0), 'Generated media secret persisted in the runtime database.');

    const repositoryAuditDraft = repositorySecretOccurrences(mediaSecret);
    const repositoryAuditMedia = repositorySecretOccurrences(draftSecret);
    assert(repositoryAuditDraft.count === 0 && repositoryAuditMedia.count === 0, 'Generated secrets persisted in approved repository artifacts.');
    pass('no_secret_sentinels', { log_matches: 0, database: databaseAudit, repository_matches: { media: 0, draft: 0 }, repository_files: repositoryAuditDraft.filesExamined, root_env_excluded: true });

    const finalKey = randomUUID();
    const health = await upload({ mediaKey: finalKey, filename: 'hero.png', mime: 'image/png', body: pngA });
    assert(health.outcome === 'CREATED' && health.attachmentId > 0, 'Normal client operation did not recover after fault scenarios.');

    assert(JSON.stringify(protectedHashes()) === JSON.stringify(frozenHashes), 'Frozen reconciliation hashes changed during runtime.');
    assert(JSON.stringify(mediaProductionHashes()) === JSON.stringify(productionSnapshot), 'Production media sources changed during runtime.');
    evidence.runtime = { wordpress: wp(['core', 'version']), php: compose(['exec', '-T', 'wordpress', 'php', '-r', 'echo PHP_VERSION;']).stdout.trim(), mariadb: db('SELECT VERSION()'), wp_cli: wp(['cli', 'version']), loopback: true, media_schema: wp(['option', 'get', 'newsroom_bridge_media_schema_version']) };
    pass('final_integrity', { protected_hashes: 'unchanged', media_source_hashes: 'unchanged', media_schema: '1', health: health.outcome });
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
    process.stderr.write(`FAIL media implementation suite (${evidence.results.length} evidence groups)\n`);
    process.exit(1);
  }
  process.stdout.write(`PASS media implementation suite (${evidence.results.length} evidence groups)\n`);
  process.exit(0);
})();