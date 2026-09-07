import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(runtimeDir, '..', '..', '..');
const composeFile = resolve(runtimeDir, 'compose.yaml');
const envFile = resolve(runtimeDir, '.env.runtime');
const resultsFile = resolve(runtimeDir, 'runtime-results.json');
const pluginDir = resolve(repoRoot, 'wordpress', 'newsroom-bridge');
const projectName = 'newsroom-backend-draft-adapter';
const tscBinary = resolve(repoRoot, 'apps/api/node_modules/typescript/bin/tsc');
const harnessTsconfig = resolve(repoRoot, 'apps/api/tsconfig.wordpress-draft-harness.json');
const clientBuild = resolve(runtimeDir, '.build', 'wordpress-draft.client.js');
const repositoryScanCandidates = [
  'apps/api/src/app.module.ts',
  'apps/api/src/config/configuration.ts',
  'apps/api/src/config/env.schema.ts',
  'apps/api/tsconfig.wordpress-draft-harness.json',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.client.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.client.spec.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.errors.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-hmac.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-hmac.spec.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.module.ts',
  'apps/api/src/modules/wordpress-draft/wordpress-draft.types.ts',
  'wordpress/runtime/backend-draft-adapter/.gitignore',
  'wordpress/runtime/backend-draft-adapter/compose.yaml',
  'wordpress/runtime/backend-draft-adapter/README.md',
  'wordpress/runtime/backend-draft-adapter/run-backend-draft-adapter-tests.mjs',
  'docs/WORDPRESS_BACKEND_DRAFT_ADAPTER.md',
  'docs/DEVELOPMENT_ROADMAP.md',
];
const frozenHashes = {
  'includes/class-newsroom-bridge-db.php': '1362cb101031088b78e27d54b78edfac6488d9f979979a3786916839811a20fa',
  'includes/class-newsroom-bridge-reconciliation.php': '6a7ce8aec4ab3040804c217f00341275ead25ea78570fc4cc93f47cde03a373a',
  'includes/class-newsroom-bridge-rest.php': '965608c6063540985d23f9a83a679c49eee1543238c595a850100755f9cf609a',
};

const knownSecrets = [];
const evidence = { started_at: new Date().toISOString(), results: [], runtime: {}, cleanup: {} };
let runtimeEnv = {};
let port = 0;
let baseUrl = '';
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
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function protectedHashes() { return Object.fromEntries(Object.keys(frozenHashes).map((path) => [path, sha256(resolve(pluginDir, path))])); }
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
function db(query) { return wp(['db', 'query', query, '--skip-column-names', '--silent'], { label: 'database query' }).trim(); }

function request(method, path, { headers = {}, body = '' } = {}) {
  const url = new URL(path, baseUrl);
  assertLoopback(url);
  return new Promise((resolveRequest, rejectRequest) => {
    const payload = Buffer.from(body);
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

function postInfo(id) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),ID,post_status,post_author,post_title,post_content) FROM wp_posts WHERE ID=${Number(id)} AND post_type='post'`);
  if (!row) return null;
  const [postId, status, author, title, content] = row.split(String.raw`\t`);
  return { id: Number(postId), status, author: Number(author), title, content };
}
function postIdByTitle(title) {
  const value = db(`SELECT ID FROM wp_posts WHERE post_type='post' AND post_title='${sqlEscape(title)}' ORDER BY ID LIMIT 1`);
  return value ? Number(value) : null;
}
function postCountByTitle(title) { return Number(db(`SELECT COUNT(*) FROM wp_posts WHERE post_type='post' AND post_title='${sqlEscape(title)}'`)); }
function mappingFor(draftKey) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),post_id,payload_hash) FROM wp_newsroom_reconciliation WHERE draft_key='${sqlEscape(draftKey)}'`);
  if (!row) return null;
  const [postId, payloadHash] = row.split(String.raw`\t`);
  return { postId: Number(postId), payloadHash };
}
function mappingCount(draftKey) { return Number(db(`SELECT COUNT(*) FROM wp_newsroom_reconciliation WHERE draft_key='${sqlEscape(draftKey)}'`)); }
function categoriesOf(id) {
  const value = db(`SELECT GROUP_CONCAT(tt.term_id ORDER BY tt.term_id SEPARATOR ',') FROM wp_term_relationships tr INNER JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id WHERE tr.object_id = ${Number(id)} AND tt.taxonomy='category'`);
  return value ? value.split(',').map(Number) : [];
}
function fingerprint(input) {
  return createHash('sha256')
    .update(JSON.stringify({ contract_version: 1, title: input.headline, content: input.body, excerpt: input.excerpt ?? '', categories: input.wordpressCategoryIds }))
    .digest('hex');
}

function createProxy(handler, upstreamBase) {
  const requests = [];
  const server = http.createServer((clientRequest, clientResponse) => {
    const chunks = [];
    clientRequest.on('data', (chunk) => chunks.push(chunk));
    clientRequest.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const entry = { method: clientRequest.method ?? '', path: clientRequest.url ?? '/', headers: { ...clientRequest.headers }, body, upstream: null, clientStatus: null, error: null };
      requests.push(entry);
      const upstream = () => new Promise((resolveUpstream, rejectUpstream) => {
        const target = new URL(clientRequest.url ?? '/', upstreamBase);
        assertLoopback(target);
        const outHeaders = { ...entry.headers, 'accept-encoding': 'identity' };
        delete outHeaders.host;
        delete outHeaders['content-length'];
        if (entry.body) outHeaders['content-length'] = String(Buffer.byteLength(entry.body));
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
        if (entry.body) upstreamRequest.end(entry.body);
        else upstreamRequest.end();
      });
      const respond = (status, body, headers = {}) => {
        entry.clientStatus = status;
        clientResponse.statusCode = status;
        for (const [name, value] of Object.entries(headers)) clientResponse.setHeader(name, value);
        clientResponse.end(body === undefined || body === null || body === '' ? undefined : String(body));
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
    respond(result.status, result.text, { 'content-type': result.headers['content-type'] ?? 'application/json' });
  }, upstreamBase);
}
function dropAfterCommit(upstreamBase) {
  return createProxy(async (entry, { upstream, respond, destroy }) => {
    const result = await upstream();
    if (entry.method === 'POST') {
      destroy();
      return;
    }
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
function dropPostGet503(upstreamBase) {
  return createProxy(async (entry, { upstream, respond, destroy }) => {
    if (entry.method === 'GET') {
      respond(503, JSON.stringify({ code: 'wp_service_unavailable' }), { 'content-type': 'application/json' });
      return;
    }
    await upstream();
    destroy();
  }, upstreamBase);
}
function mangleCreationResponse(upstreamBase, mutated) {
  return createProxy(async (entry, { upstream, respond }) => {
    const result = await upstream();
    if (entry.method === 'POST') {
      respond(201, mutated, { 'content-type': 'application/json' });
      return;
    }
    respond(result.status, result.text, { 'content-type': result.headers['content-type'] ?? 'application/json' });
  }, upstreamBase);
}
function redirectResponse(upstreamBase, location) {
  return createProxy(async (entry, { respond }) => {
    respond(302, '', { location });
  }, upstreamBase);
}

function repositorySecretOccurrences(secret) {
  assert(repositoryScanCandidates.length > 0, 'Repository scan candidate list is empty.');
  const rootEnv = resolve(repoRoot, '.env');
  const candidates = repositoryScanCandidates.map((path) => resolve(repoRoot, path));
  assert(!candidates.some((path) => path === rootEnv || /^\.env(?:\.|$)/.test(path.slice(repoRoot.length + 1))), 'Repository scan candidate includes a root environment file.');
  let count = 0;
  for (const path of candidates) {
    assert(path.startsWith(`${repoRoot}\\`) && existsSync(path), 'Repository scan candidate is missing or outside the repository.');
    if (readFileSync(path).includes(secret)) count += 1;
  }
  return { count, filesExamined: candidates.length, rootEnvExcluded: true };
}

try {
  assert(existsSync(tscBinary), 'TypeScript compiler is not available for the harness build.');

  run('node', [tscBinary, '-p', harnessTsconfig], { label: 'client build' });
  assert(existsSync(clientBuild), 'Compiled WordPressDraftClient is missing.');
  const requireModule = createRequire(import.meta.url);
  const { WordPressDraftClient } = requireModule(clientBuild);
  const { WordPressDraftError } = requireModule(resolve(runtimeDir, '.build', 'wordpress-draft.errors.js'));

  port = await availablePort(18381);
  baseUrl = `http://127.0.0.1:${port}`;
  assertLoopback(baseUrl);
  const keyId = 'draft-local-v1';
  const secret = randomSecret();
  runtimeEnv = {
    NEWSROOM_TEST_PORT: String(port),
    RUNTIME_DB_PASSWORD: randomSecret(),
    RUNTIME_DB_ROOT_PASSWORD: randomSecret(),
    ADMIN_PASSWORD: randomSecret(),
    NEWSROOM_BRIDGE_USER_ID: '3',
    NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: '1',
    NEWSROOM_BRIDGE_HMAC_ENABLED: '1',
    NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED: '1',
    HMAC_KEY_ID: keyId,
    HMAC_SECRET: secret,
  };
  runtimeEnv.NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON = JSON.stringify([{ id: keyId, secret }]);
  knownSecrets.push(...Object.values(runtimeEnv).filter((value) => !['3', '1', keyId, String(port)].includes(value)));
  writeRuntimeEnv();

  assert(JSON.stringify(protectedHashes()) === JSON.stringify(frozenHashes), 'Frozen reconciliation hashes differ before runtime.');
  compose(['pull'], { label: 'Docker image pull' });
  compose(['up', '-d', 'db', 'wordpress', 'cli'], { sensitive: true, label: 'runtime startup' });
  await waitForHttp();

  wp(['core', 'install', `--url=${baseUrl}`, '--title=Newsroom Backend Draft Adapter Runtime', '--admin_user=runtime_admin', `--admin_password=${runtimeEnv.ADMIN_PASSWORD}`, '--admin_email=admin@example.invalid', '--skip-email'], { sensitive: true });
  wp(['rewrite', 'structure', '/%postname%/', '--hard']);
  wp(['user', 'create', 'runtime_filler', 'filler@example.invalid', '--role=subscriber', '--porcelain'], { sensitive: true });
  wp(['eval', "add_role('newsroom_draft_service','Newsroom Draft Service',array('read'=>true,'edit_posts'=>true));"]);
  const serviceId = Number(wp(['user', 'create', 'runtime_service', 'service@example.invalid', '--role=newsroom_draft_service', `--user_pass=${runtimeEnv.ADMIN_PASSWORD}`, '--porcelain'], { sensitive: true }));
  assert(serviceId === 3, 'Fixture service-user ID does not match isolated configuration.');
  wp(['user', 'delete', 'runtime_filler', '--yes'], { sensitive: true, label: 'fixture user cleanup' });
  const categoryIds = ['A', 'B'].map((suffix) => Number(wp(['term', 'create', 'category', `Runtime Category ${suffix}`, `--slug=runtime-${suffix.toLowerCase()}`, '--porcelain'])));
  wp(['plugin', 'activate', 'newsroom-bridge']);
  assert(wp(['plugin', 'get', 'newsroom-bridge', '--field=version']) === '1.1.0', 'Plugin version is not 1.1.0.');
  assert(wp(['option', 'get', 'newsroom_bridge_schema_version']) === '2', 'Reconciliation schema version changed.');
  const newsroomTables = db("SHOW TABLES LIKE 'wp_newsroom%'").split(/\r?\n/).filter(Boolean);
  assert(JSON.stringify(newsroomTables) === JSON.stringify(['wp_newsroom_reconciliation']), 'Unexpected newsroom database table exists.');
  pass('activation_and_schema', { plugin: '1.1.0', schema: '2', tables: newsroomTables.length });

  const directOptions = () => ({ baseUrl, keyId, secret, requestTimeoutMs: 2000, reconciliationAttempts: 3, reconciliationDelayMs: 20 });
  const client = new WordPressDraftClient(directOptions());

  const createdDraftKey = randomUUID();
  const createInput = { wordpressDraftKey: createdDraftKey, headline: `Backend Draft Adapter ${randomUUID().slice(0, 8)}`, body: 'Interoperable HMAC body.', wordpressCategoryIds: [categoryIds[0]] };
  const created = await client.createDraft(createInput);
  const createdPostId = created.wordpressPostId;
  const createdPost = postInfo(createdPostId);
  const createdMapping = mappingFor(createdDraftKey);
  assert(created.outcome === 'CREATED' && created.wordpressDraftKey === createdDraftKey && created.status === 'draft' && createdPostId > 0, 'Node -> WordPress draft creation outcome did not match the contract.');
  assert(createdPost?.status === 'draft' && createdPost.author === serviceId && createdPost.title === createInput.headline && createdPost.content === createInput.body, 'HMAC-created durable postcondition failed.');
  assert(JSON.stringify(categoriesOf(createdPostId)) === JSON.stringify([categoryIds[0]]), 'HMAC-created category postcondition failed.');
  assert(createdMapping?.postId === createdPostId && createdMapping.payloadHash === fingerprint(createInput), 'HMAC reconciliation fingerprint postcondition failed.');
  assert(mappingCount(createdDraftKey) === 1, 'HMAC-created mapping count is not one.');
  pass('signer_verifier_interop', { create_201: true, author: serviceId, fingerprint: 'sha256', mapped: true });

  const lookup = await client.getDraftByKey(createdDraftKey);
  assert(lookup.wordpressPostId === createdPostId && lookup.wordpressDraftKey === createdDraftKey && lookup.status === 'draft', 'GET draft postcondition failed.');
  pass('get_draft_200', { http: 200, post_id: lookup.wordpressPostId });

  const replay = await client.createDraft(createInput);
  assert(replay.outcome === 'REPLAYED' && replay.wordpressPostId === createdPostId && postCountByTitle(createInput.headline) === 1 && mappingCount(createdDraftKey) === 1, 'Signed replay duplicated durable state.');
  pass('signed_replay', { outcome: 'REPLAYED', post: 1, mapping: 1 });

  const conflictInput = { ...createInput, headline: `Conflicting ${randomUUID().slice(0, 8)}` };
  let conflictError = null;
  try { await client.createDraft(conflictInput); } catch (error) { conflictError = error; }
  assert(conflictError instanceof WordPressDraftError && conflictError.code === 'CONFLICT', 'Same-key conflicting payload was not rejected with CONFLICT.');
  assert(postCountByTitle(conflictInput.headline) === 0 && mappingFor(createdDraftKey)?.payloadHash === fingerprint(createInput), 'Idempotency conflict changed the preserved mapping.');
  pass('conflict_409', { code: 'CONFLICT', preserved: true });

  const unauthorized = new WordPressDraftClient({ ...directOptions(), keyId: 'client-unknown-a' });
  let authError = null;
  try { await unauthorized.createDraft(createInput); } catch (error) { authError = error; }
  assert(authError instanceof WordPressDraftError && authError.code === 'AUTHENTICATION_FAILURE' && authError.httpStatus === 401, 'Unknown-key client was not rejected with AUTHENTICATION_FAILURE/401.');
  pass('authentication_failure_401', { code: 'AUTHENTICATION_FAILURE', http: 401 });

  const recordingProxy = passthrough(baseUrl);
  await recordingProxy.listen();
  const recordingClient = new WordPressDraftClient({ ...directOptions(), baseUrl: recordingProxy.url() });
  const recordedDraftKey = randomUUID();
  const recordedInput = { wordpressDraftKey: recordedDraftKey, headline: `Recorded ${randomUUID().slice(0, 8)}`, body: 'Header capture.', wordpressCategoryIds: [categoryIds[1]] };
  await recordingClient.createDraft(recordedInput);
  await recordingClient.getDraftByKey(recordedDraftKey);
  await recordingProxy.close();
  const recordedRequests = recordingProxy.requests;
  const postEntry = recordedRequests.find((entry) => entry.method === 'POST');
  const getEntry = recordedRequests.find((entry) => entry.method === 'GET');
  assert(postEntry && getEntry, 'Recording proxy did not capture POST and GET.');
  const genericHeaders = ['authorization', 'cookie', 'x-wp-nonce'];
  const hasGeneric = (entry) => Object.keys(entry.headers).some((name) => genericHeaders.includes(name.toLowerCase()));
  assert(postEntry && getEntry && !hasGeneric(postEntry) && !hasGeneric(getEntry), 'Client request carried a generic authentication header.');
  assert(postEntry.headers['x-newsroom-auth-version'] === '1' && postEntry.headers['x-newsroom-key-id'] === keyId && /^[0-9]{10}$/.test(postEntry.headers['x-newsroom-timestamp'] ?? '') && /^[0-9a-f]{64}$/.test(postEntry.headers['x-newsroom-signature'] ?? ''), 'POST newsroom HMAC headers are malformed.');
  assert(postEntry.headers['content-type'] === 'application/json' && getEntry.headers['content-type'] === undefined && postEntry.body !== '' && getEntry.body === '', 'POST/GET wire format differs from the approved contract.');
  pass('no_generic_auth_headers', { post: 'hmac-only', get: 'hmac-only, no content type, no body', generic: 0 });

  const droppedProxy = dropAfterCommit(baseUrl);
  await droppedProxy.listen();
  const droppedClient = new WordPressDraftClient({ ...directOptions(), baseUrl: droppedProxy.url() });
  const droppedDraftKey = randomUUID();
  const droppedInput = { wordpressDraftKey: droppedDraftKey, headline: `Dropped ${randomUUID().slice(0, 8)}`, body: 'Committed upstream, response dropped.', wordpressCategoryIds: [categoryIds[0]] };
  const recovered = await droppedClient.createDraft(droppedInput);
  await droppedProxy.close();
  assert(recovered.outcome === 'RECOVERED' && recovered.wordpressPostId > 0, 'Dropped-response reconciliation did not recover the committed draft.');
  assert(mappingCount(droppedDraftKey) === 1 && postCountByTitle(droppedInput.headline) === 1, 'Dropped-response recovery duplications or missing durable state.');
  const droppedPosts = droppedProxy.requests.filter((entry) => entry.method === 'POST').length;
  const droppedGets = droppedProxy.requests.filter((entry) => entry.method === 'GET').length;
  assert(droppedPosts === 1 && droppedGets >= 1 && droppedProxy.requests[0]?.upstream?.status === 201, 'Dropped-response client did not POST once and GET to reconcile.');
  pass('dropped_response_recovery', { outcome: 'RECOVERED', posts: 1, gets: droppedGets, upstream_post: 201 });

  const retryProxy = dropPostThenPassthrough(baseUrl);
  await retryProxy.listen();
  const retryClient = new WordPressDraftClient({ ...directOptions(), baseUrl: retryProxy.url() });
  const retryDraftKey = randomUUID();
  const retryInput = { wordpressDraftKey: retryDraftKey, headline: `Retry ${randomUUID().slice(0, 8)}`, body: 'POST dropped before delivery.', wordpressCategoryIds: [categoryIds[1]] };
  const retried = await retryClient.createDraft(retryInput);
  await retryProxy.close();
  const retryPosts = retryProxy.requests.filter((entry) => entry.method === 'POST').length;
  const retryGets = retryProxy.requests.filter((entry) => entry.method === 'GET').length;
  assert(retried.outcome === 'CREATED' && retryPosts === 2 && retryGets === 1, 'Undelivered-POST GET-404 retry did not issue exactly two POSTs and one GET.');
  assert(mappingCount(retryDraftKey) === 1 && postCountByTitle(retryInput.headline) === 1, 'Retried draft durable state is inconsistent.');
  pass('get_404_post_retry', { client_posts: retryPosts, upstream_posts: retryProxy.requests.filter((entry) => entry.method === 'POST' && entry.upstream).length, gets: retryGets, outcome: 'CREATED' });

  const blindProxy = dropPostGet503(baseUrl);
  await blindProxy.listen();
  const blindClient = new WordPressDraftClient({ ...directOptions(), baseUrl: blindProxy.url(), reconciliationAttempts: 2 });
  const blindDraftKey = randomUUID();
  const blindInput = { wordpressDraftKey: blindDraftKey, headline: `Blind ${randomUUID().slice(0, 8)}`, body: 'Uncertain recovery must not blind-POST.', wordpressCategoryIds: [categoryIds[0]] };
  let blindError = null;
  try { await blindClient.createDraft(blindInput); } catch (error) { blindError = error; }
  await blindProxy.close();
  const blindPosts = blindProxy.requests.filter((entry) => entry.method === 'POST').length;
  const blindGets = blindProxy.requests.filter((entry) => entry.method === 'GET').length;
  assert(blindError instanceof WordPressDraftError && blindError.code === 'UNCERTAIN_OUTCOME', 'GET-uncertain recovery did not raise UNCERTAIN_OUTCOME.');
  assert(blindPosts === 1 && blindGets === 2, 'GET-uncertain recovery issued a second (blind) POST or an unaccounted GET count.');
  assert(mappingCount(blindDraftKey) === 1 && postCountByTitle(blindInput.headline) === 1, 'Uncertain recovery durable state is inconsistent.');
  pass('get_uncertain_no_blind_post', { client_posts: blindPosts, gets: blindGets, code: 'UNCERTAIN_OUTCOME', durable_posts: 1 });

  const redirectTarget = `${baseUrl}/wp-json/wp/v2/settings`;
  const redirectProxy = redirectResponse(baseUrl, redirectTarget);
  await redirectProxy.listen();
  const redirectClient = new WordPressDraftClient({ ...directOptions(), baseUrl: redirectProxy.url() });
  const redirectKey = randomUUID();
  const redirectInput = { wordpressDraftKey: redirectKey, headline: `Redirect ${randomUUID().slice(0, 8)}`, body: 'redirect test', wordpressCategoryIds: [categoryIds[0]] };
  let redirectError = null;
  try { await redirectClient.createDraft(redirectInput); } catch (error) { redirectError = error; }
  await redirectProxy.close();
  assert(redirectError instanceof WordPressDraftError && redirectError.code === 'CONTRACT_FAILURE', 'Manual-redirect 3xx was not classified as CONTRACT_FAILURE.');
  assert(redirectProxy.requests.length === 1 && redirectProxy.requests[0]?.clientStatus === 302, 'Client followed the redirect or issued a second request.');
  const hasleak = Object.keys(redirectProxy.requests[0]?.headers ?? {}).some((name) => ['authorization', 'cookie', 'x-wp-nonce'].includes(name.toLowerCase()));
  assert(!hasleak, 'Redirected request carried a generic authentication header.');
  pass('redirect_no_hmac_leak', { first_request: 302, requests: redirectProxy.requests.length, redirected_path_hits: 0 });

  const mangleProxy = mangleCreationResponse(baseUrl, JSON.stringify({ post_id: 999 }));
  await mangleProxy.listen();
  const mangleClient = new WordPressDraftClient({ ...directOptions(), baseUrl: mangleProxy.url() });
  const mangleKey = randomUUID();
  const mangleInput = { wordpressDraftKey: mangleKey, headline: `Mangle ${randomUUID().slice(0, 8)}`, body: 'malformed DTO', wordpressCategoryIds: [categoryIds[1]] };
  let mangleError = null;
  try { await mangleClient.createDraft(mangleInput); } catch (error) { mangleError = error; }
  await mangleProxy.close();
  assert(mangleError instanceof WordPressDraftError && mangleError.code === 'UNEXPECTED_RESPONSE', 'Malformed creation response was not rejected as UNEXPECTED_RESPONSE.');

  const mangleProxy2 = mangleCreationResponse(baseUrl, 'not-json-at-all');
  await mangleProxy2.listen();
  const mangleClient2 = new WordPressDraftClient({ ...directOptions(), baseUrl: mangleProxy2.url() });
  const mangleKey2 = randomUUID();
  const mangleInput2 = { wordpressDraftKey: mangleKey2, headline: `Mangle2 ${randomUUID().slice(0, 8)}`, body: 'non JSON body', wordpressCategoryIds: [categoryIds[0]] };
  let mangleError2 = null;
  try { await mangleClient2.createDraft(mangleInput2); } catch (error) { mangleError2 = error; }
  await mangleProxy2.close();
  assert(mangleError2 instanceof WordPressDraftError && mangleError2.code === 'UNEXPECTED_RESPONSE', 'Non-JSON creation response was not rejected as UNEXPECTED_RESPONSE.');
  assert(mappingCount(mangleKey) === 1 && mappingCount(mangleKey2) === 1, 'Malformed-response scenario durable state is missing (upstream committed normally).');
  pass('malformed_response_rejection', { missing_keys: 'UNEXPECTED_RESPONSE', non_json: 'UNEXPECTED_RESPONSE' });

  const stallProxy = createProxy(async () => {}, baseUrl);
  await stallProxy.listen();
  const stallClient = new WordPressDraftClient({ ...directOptions(), baseUrl: stallProxy.url(), requestTimeoutMs: 300, reconciliationAttempts: 2, reconciliationDelayMs: 10 });
  const stallKey = randomUUID();
  const stallInput = { wordpressDraftKey: stallKey, headline: `Stall ${randomUUID().slice(0, 8)}`, body: 'bounded unavailable', wordpressCategoryIds: [categoryIds[1]] };
  let stallError = null;
  const stallStarted = Date.now();
  try { await stallClient.createDraft(stallInput); } catch (error) { stallError = error; }
  const stallElapsed = Date.now() - stallStarted;
  await stallProxy.close();
  assert(stallError instanceof WordPressDraftError && stallError.code === 'UNCERTAIN_OUTCOME', 'Bounded-unavailable scenario did not raise UNCERTAIN_OUTCOME.');
  assert(stallProxy.requests.length === 3 && stallProxy.requests.filter((entry) => entry.method === 'POST').length === 1, 'Bounded-unavailable request counts are not bounded to POST + reconciliationAttempts GETs.');
  assert(stallElapsed < 6000, 'Bounded-unavailable client exceeded the request budget.');
  pass('bounded_unavailable', { requests: stallProxy.requests.length, post: 1, gets: 2, code: 'UNCERTAIN_OUTCOME', elapsed_ms: stallElapsed });

  const recordedSignatureValues = recordedRequests.flatMap(
    (entry) => (entry.headers['x-newsroom-signature'] ? [entry.headers['x-newsroom-signature']] : []),
  );
  knownSecrets.push(...recordedSignatureValues);
  knownSecrets.push(Buffer.from(secret, 'base64url').toString('hex'), secret);

  const logs = compose(['logs', '--no-color', 'wordpress'], { sensitive: true }).stdout;
  const excludedKnown = knownSecrets.filter((item) => item && item.length >= 8);
  const logLeakCounts = excludedKnown.map((item) => logs.includes(item) ? 1 : 0);
  const leakIndexes = logLeakCounts.map((count, index) => count === 1 ? index : -1).filter((index) => index >= 0);
  assert(logs.includes('newsroom_bridge_security') && logLeakCounts.every((count) => count === 0), `Security log sentinel leakage test failed: prefix=${logs.includes('newsroom_bridge_security')}, log_bytes=${logs.length}, leak_indexes=${JSON.stringify(leakIndexes)}.`);

  const textTables = [
    ["SELECT COUNT(*) FROM wp_options WHERE option_value LIKE '%${sqlEscape(secret)}%'", 'wp_options'],
    ["SELECT COUNT(*) FROM wp_posts WHERE post_content LIKE '%${sqlEscape(secret)}%' OR post_title LIKE '%${sqlEscape(secret)}%' OR post_excerpt LIKE '%${sqlEscape(secret)}%'", 'wp_posts'],
  ];
  const databaseAudit = Object.fromEntries(textTables.map(([query, table]) => [table, Number(db(query))]));
  assert(Object.values(databaseAudit).every((count) => count === 0), 'Generated secret persisted in the runtime database.');

  const repositoryAudit = repositorySecretOccurrences(secret);
  assert(repositoryAudit.count === 0 && repositoryAudit.rootEnvExcluded === true, 'Generated secret persisted in approved repository artifacts.');
  pass('no_secret_sentinels', { logging_sentinels: logLeakCounts.length, log_matches: 0, database: databaseAudit, repository_matches: 0, repository_files: repositoryAudit.filesExamined, root_env_excluded: true });

  const healthKey = randomUUID();
  const healthInput = { wordpressDraftKey: healthKey, headline: `Health ${randomUUID().slice(0, 8)}`, body: 'final health', wordpressCategoryIds: [categoryIds[0]] };
  const health = await client.createDraft(healthInput);
  assert(health.outcome === 'CREATED' && health.wordpressPostId > 0, 'Normal client operation did not recover after fault scenarios.');

  assert(JSON.stringify(protectedHashes()) === JSON.stringify(frozenHashes), 'Frozen reconciliation hashes changed during runtime.');
  evidence.runtime = { wordpress: wp(['core', 'version']), php: compose(['exec', '-T', 'wordpress', 'php', '-r', 'echo PHP_VERSION;']).stdout.trim(), mariadb: db('SELECT VERSION()'), wp_cli: wp(['cli', 'version']), loopback: true };
  pass('final_integrity', { protected_hashes: 'unchanged', schema: '2', health: health.outcome });
} catch (error) {
  fatalError = redact(error?.stack || error?.message || error);
  evidence.results.push({ name: 'fatal', status: 'FAIL', details: { error: fatalError } });
  process.stderr.write(`FAIL ${redact(error?.message || error)}\n`);
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
  process.stderr.write(`FAIL backend draft adapter suite (${evidence.results.length} evidence groups)\n`);
  process.exit(1);
}
process.stdout.write(`PASS backend draft adapter suite (${evidence.results.length} evidence groups)\n`);
process.exit(0);