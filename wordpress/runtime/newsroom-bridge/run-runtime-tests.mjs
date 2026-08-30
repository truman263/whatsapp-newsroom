import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const projectName = 'newsroom-bridge-runtime';
const knownSecrets = [];
const evidence = {
  started_at: new Date().toISOString(),
  commit: 'c12d179',
  results: [],
  runtime: {},
  fixture: {},
  hashes_before: {},
  hashes_after: {},
  cleanup: {},
};

function redact(value) {
  let output = String(value ?? '');
  for (const secret of knownSecrets) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
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

function randomSecret() {
  return randomBytes(30).toString('base64url');
}

function phpFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = resolve(directory, entry);
    if (statSync(fullPath).isDirectory()) files.push(...phpFiles(fullPath));
    else if (entry.endsWith('.php')) files.push(fullPath);
  }
  return files.sort();
}

function hashes() {
  return Object.fromEntries(
    phpFiles(pluginDir).map((file) => [
      file.slice(pluginDir.length + 1).replaceAll('\\', '/'),
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    ]),
  );
}

async function availablePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const free = await new Promise((resolveFree) => {
      const server = net.createServer();
      server.once('error', () => resolveFree(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolveFree(true)));
    });
    if (free) return port;
  }
  throw new Error('No loopback test port was available.');
}

function assertLocalUrl(url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`Refusing non-loopback runtime hostname: ${parsed.hostname}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(name, details = {}) {
  evidence.results.push({ name, status: 'PASS', details });
  process.stdout.write(`PASS ${name}\n`);
}

function countStatuses(responses) {
  const counts = {};
  for (const response of responses) counts[response.status] = (counts[response.status] ?? 0) + 1;
  return counts;
}

function sqlEscape(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "''");
}

function reconciliationPayloadHash(payload) {
  const categories = [...new Set(payload.categories.map((categoryId) => Number(categoryId)))].sort((left, right) => left - right);
  const canonical = {
    contract_version: 1,
    title: payload.title,
    content: payload.content,
    excerpt: payload.excerpt ?? '',
    categories,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

const port = await availablePort(18081);
const runtimeEnv = {
  NEWSROOM_TEST_PORT: String(port),
  RUNTIME_DB_PASSWORD: randomSecret(),
  RUNTIME_DB_ROOT_PASSWORD: randomSecret(),
  RUNTIME_ADMIN_PASSWORD: randomSecret(),
  RUNTIME_INTEGRATION_PASSWORD: randomSecret(),
  RUNTIME_OTHER_PASSWORD: randomSecret(),
};
knownSecrets.push(...Object.values(runtimeEnv).filter((value) => value !== String(port)));
writeFileSync(envFile, Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });

let integrationUserId = '';
function compose(args, options = {}) {
  return run(
    'docker',
    ['compose', '--project-name', projectName, '--env-file', envFile, '--file', composeFile, ...args],
    {
      ...options,
      cwd: runtimeDir,
      env: { ...process.env, ...runtimeEnv, NEWSROOM_BRIDGE_USER_ID: integrationUserId },
      label: options.label ?? `docker compose ${args[0] ?? ''}`,
    },
  );
}

function wp(args, options = {}) {
  return compose(['exec', '-T', 'cli', 'wp', ...args], { ...options, label: options.label ?? `wp ${args[0] ?? ''}` }).stdout.trim();
}

function db(query) {
  return wp(['db', 'query', query, '--skip-column-names', '--silent'], { label: 'WP-CLI database query' }).trim();
}

const baseUrl = `http://127.0.0.1:${port}`;
assertLocalUrl(baseUrl);

function authorization(auth) {
  if (!auth) return undefined;
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
}

async function request(method, route, { auth, payload, headers = {}, timeout = 60000 } = {}) {
  const url = new URL(route, baseUrl);
  assertLocalUrl(url);
  const requestHeaders = { ...headers };
  if (payload !== undefined) requestHeaders['content-type'] = 'application/json';
  const authHeader = authorization(auth);
  if (authHeader) requestHeaders.authorization = authHeader;
  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }
  return { status: response.status, body };
}

async function waitForHttp() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      if (response.status > 0) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error('Local WordPress HTTP service did not become ready.');
}

function mappingCount(key) {
  return Number(db(`SELECT COUNT(*) FROM wp_newsroom_reconciliation WHERE draft_key = '${sqlEscape(key)}'`));
}

function mapping(key) {
  const row = db(`SELECT CONCAT_WS(CHAR(9), draft_key, COALESCE(post_id, 'NULL'), payload_hash, actor_user_id, COALESCE(reservation_token, 'NULL')) FROM wp_newsroom_reconciliation WHERE draft_key = '${sqlEscape(key)}'`);
  if (!row) return null;
  const [draftKey, postId, payloadHash, actorUserId, reservationToken] = row.split(String.raw`\t`);
  return {
    draft_key: draftKey,
    post_id: postId === 'NULL' ? null : Number(postId),
    payload_hash: payloadHash,
    actor_user_id: Number(actorUserId),
    reservation_token: reservationToken === 'NULL' ? null : reservationToken,
  };
}

function postCountByTitle(title) {
  return Number(db(`SELECT COUNT(*) FROM wp_posts WHERE post_type = 'post' AND post_title = '${sqlEscape(title)}'`));
}

function postIdByTitle(title) {
  const value = db(`SELECT ID FROM wp_posts WHERE post_type = 'post' AND post_title = '${sqlEscape(title)}' ORDER BY ID DESC LIMIT 1`);
  return value ? Number(value) : null;
}

function postInfo(postId) {
  const row = db(`SELECT CONCAT_WS(CHAR(9), ID, post_type, post_status, post_author, post_title) FROM wp_posts WHERE ID = ${Number(postId)}`);
  if (!row) return null;
  const [id, type, status, author, title] = row.split(String.raw`\t`);
  return { id: Number(id), type, status, author: Number(author), title };
}

function postCategories(postId) {
  const value = db(`SELECT GROUP_CONCAT(tt.term_id ORDER BY tt.term_id SEPARATOR ',') FROM wp_term_relationships tr INNER JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id WHERE tr.object_id = ${Number(postId)} AND tt.taxonomy = 'category'`);
  return value ? value.split(',').map(Number) : [];
}

function newPayload(categoryIds, titlePrefix = 'Runtime Newsroom Bridge Test') {
  const marker = `${titlePrefix} ${randomUUID().slice(0, 8)}`;
  return {
    marker,
    payload: {
      draft_key: randomUUID(),
      title: marker,
      content: 'Disposable runtime validation content.',
      excerpt: 'Disposable runtime validation.',
      categories: categoryIds,
    },
  };
}

function expectError(response, status, code) {
  assert(response.status === status, `Expected HTTP ${status}, received ${response.status}.`);
  assert(response.body?.code === code, `Expected ${code}, received ${response.body?.code ?? 'no code'}.`);
}

async function lostResponseCreate(payload, auth) {
  let completeUpstream;
  const upstreamComplete = new Promise((resolveComplete) => { completeUpstream = resolveComplete; });
  const server = http.createServer((clientRequest, clientResponse) => {
    const chunks = [];
    clientRequest.on('data', (chunk) => chunks.push(chunk));
    clientRequest.on('end', () => {
      const body = Buffer.concat(chunks);
      const upstream = http.request(
        new URL('/wp-json/newsroom/v1/drafts', baseUrl),
        {
          method: 'POST',
          headers: {
            authorization: authorization(auth),
            'content-type': 'application/json',
            'content-length': String(body.length),
          },
        },
        (upstreamResponse) => {
          upstreamResponse.resume();
          upstreamResponse.on('end', () => {
            completeUpstream();
            clientResponse.destroy();
          });
        },
      );
      upstream.on('error', (error) => {
        completeUpstream();
        clientResponse.destroy(error);
      });
      upstream.end(body);
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  let clientLostResponse = false;
  try {
    await fetch(`http://127.0.0.1:${address.port}/drop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    clientLostResponse = true;
  }
  await upstreamComplete;
  await new Promise((resolveClose) => server.close(resolveClose));
  return clientLostResponse;
}

evidence.hashes_before = hashes();
let fatalError = null;

try {
  compose(['pull'], { label: 'Docker image pull' });
  compose(['up', '-d', 'db', 'wordpress', 'cli'], { label: 'Disposable runtime startup' });
  await waitForHttp();

  wp([
    'core', 'install', `--url=${baseUrl}`, '--title=Newsroom Bridge Runtime',
    '--admin_user=runtime_admin', `--admin_password=${runtimeEnv.RUNTIME_ADMIN_PASSWORD}`,
    '--admin_email=runtime-admin@example.invalid', '--skip-email',
  ], { sensitive: true, label: 'WordPress core installation' });
  wp(['rewrite', 'structure', '/%postname%/', '--hard'], { label: 'Local REST permalink configuration' });

  wp(['user', 'create', 'runtime_unrelated', 'runtime-unrelated@example.invalid', '--role=author', `--user_pass=${runtimeEnv.RUNTIME_OTHER_PASSWORD}`, '--porcelain'], { sensitive: true, label: 'Unrelated Author creation' });
  wp(['user', 'create', 'runtime_integration', 'runtime-integration@example.invalid', '--role=author', `--user_pass=${runtimeEnv.RUNTIME_INTEGRATION_PASSWORD}`, '--porcelain'], { sensitive: true, label: 'Integration Author creation' });

  const adminUserId = Number(wp(['user', 'get', 'runtime_admin', '--field=ID']));
  const unrelatedUserId = Number(wp(['user', 'get', 'runtime_unrelated', '--field=ID']));
  integrationUserId = wp(['user', 'get', 'runtime_integration', '--field=ID']);
  const integrationId = Number(integrationUserId);

  const categoryA = Number(wp(['term', 'create', 'category', 'Runtime Category A', '--slug=runtime-category-a', '--porcelain']));
  const categoryB = Number(wp(['term', 'create', 'category', 'Runtime Category B', '--slug=runtime-category-b', '--porcelain']));
  const categoryC = Number(wp(['term', 'create', 'category', 'Runtime Category C', '--slug=runtime-category-c', '--porcelain']));

  compose(['up', '-d', '--force-recreate', 'wordpress', 'cli'], { label: 'Integration identity configuration' });
  await waitForHttp();
  wp(['plugin', 'activate', 'newsroom-bridge-fault-injector'], { label: 'Fault injector activation' });
  wp(['plugin', 'activate', 'newsroom-bridge'], { label: 'Newsroom Bridge activation' });

  const integrationAppPassword = wp(['user', 'application-password', 'create', String(integrationId), 'runtime-harness', '--porcelain'], { sensitive: true, label: 'Integration Application Password creation' });
  const unrelatedAppPassword = wp(['user', 'application-password', 'create', String(unrelatedUserId), 'runtime-harness', '--porcelain'], { sensitive: true, label: 'Unrelated Application Password creation' });
  const adminAppPassword = wp(['user', 'application-password', 'create', String(adminUserId), 'runtime-harness', '--porcelain'], { sensitive: true, label: 'Administrator Application Password creation' });
  knownSecrets.push(integrationAppPassword, unrelatedAppPassword, adminAppPassword);

  const integrationAuth = { username: 'runtime_integration', password: integrationAppPassword };
  const unrelatedAuth = { username: 'runtime_unrelated', password: unrelatedAppPassword };
  const adminAuth = { username: 'runtime_admin', password: adminAppPassword };
  evidence.fixture = {
    administrator: { id: adminUserId, username: 'runtime_admin', role: 'administrator' },
    integration: { id: integrationId, username: 'runtime_integration', role: 'author' },
    unrelated: { id: unrelatedUserId, username: 'runtime_unrelated', role: 'author' },
    categories: { A: categoryA, B: categoryB, C: categoryC },
  };

  evidence.runtime = {
    wordpress_image: run('docker', ['image', 'inspect', '--format', '{{.Id}} {{join .RepoDigests ","}}', 'wordpress:7.1-php8.2-apache'], { label: 'WordPress image inspection' }).stdout.trim(),
    mariadb_image: run('docker', ['image', 'inspect', '--format', '{{.Id}} {{join .RepoDigests ","}}', 'mariadb:10.11'], { label: 'MariaDB image inspection' }).stdout.trim(),
    cli_image: run('docker', ['image', 'inspect', '--format', '{{.Id}} {{join .RepoDigests ","}}', 'wordpress:cli'], { label: 'WP-CLI image inspection' }).stdout.trim(),
    wordpress_version: wp(['core', 'version']),
    php_version: compose(['exec', '-T', 'wordpress', 'php', '-r', 'echo PHP_VERSION;'], { label: 'WordPress PHP version' }).stdout.trim(),
    mariadb_version: db('SELECT VERSION()'),
    wp_cli_version: wp(['cli', 'version']),
    url: baseUrl,
  };

  assert(wp(['plugin', 'get', 'newsroom-bridge', '--field=status']) === 'active', 'Newsroom Bridge is not active.');
  assert(wp(['plugin', 'get', 'newsroom-bridge', '--field=version']) === '1.0.0', 'Unexpected Newsroom Bridge version.');
  assert(wp(['option', 'get', 'newsroom_bridge_schema_version']) === '2', 'Unexpected schema version option.');
  const engine = db("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_newsroom_reconciliation'");
  assert(engine.toUpperCase() === 'INNODB', `Unexpected reconciliation engine ${engine}.`);
  const columns = db("SELECT CONCAT_WS(':', COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COALESCE(CHARACTER_MAXIMUM_LENGTH, ''), COLUMN_TYPE) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_newsroom_reconciliation' ORDER BY ORDINAL_POSITION").split('\n');
  const indexes = db("SELECT CONCAT_WS(':', INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wp_newsroom_reconciliation' ORDER BY INDEX_NAME, SEQ_IN_INDEX").split('\n');
  const requiredColumns = ['draft_key:char:NO:36:char(36)', 'post_id:bigint:YES::bigint(20) unsigned', 'payload_hash:char:NO:64:char(64)', 'actor_user_id:bigint:NO::bigint(20) unsigned', 'reservation_token:char:YES:36:char(36)', 'created_at:datetime:NO::datetime', 'updated_at:datetime:NO::datetime'];
  assert(JSON.stringify(columns) === JSON.stringify(requiredColumns), `Schema columns differ: ${JSON.stringify(columns)}`);
  assert(indexes.includes('PRIMARY:0:1:draft_key'), 'Primary key contract missing.');
  assert(indexes.some((value) => value.endsWith(':0:1:post_id') || value === 'post_id:0:1:post_id'), 'Unique post_id contract missing.');
  pass('plugin_activation_and_schema', { engine, columns, indexes, schema_version: 2, plugin_version: '1.0.0' });

  const discovery = await request('GET', '/wp-json/');
  assert(discovery.status === 200, 'REST discovery failed.');
  const namespaceIndexPresent = Object.hasOwn(discovery.body.routes, '/newsroom/v1');
  const customRoutes = Object.entries(discovery.body.routes).filter(([route]) => route.startsWith('/newsroom/v1/') && route !== '/newsroom/v1');
  assert(customRoutes.length === 2, `Unexpected Newsroom Bridge route count ${customRoutes.length}.`);
  const routeSummary = customRoutes.map(([route, contract]) => ({ route, methods: [...new Set(contract.endpoints.flatMap((endpoint) => endpoint.methods))].sort() }));
  const draftsRoute = routeSummary.find((route) => route.route === '/newsroom/v1/drafts');
  const lookupRoute = routeSummary.find((route) => route.route.includes('(?P<draft_key>'));
  assert(JSON.stringify(draftsRoute?.methods) === JSON.stringify(['POST']), 'Draft collection exposes unexpected methods.');
  assert(JSON.stringify(lookupRoute?.methods) === JSON.stringify(['GET']), 'Lookup route exposes unexpected methods.');
  pass('route_contract', { namespace_index_present: namespaceIndexPresent, routes: routeSummary });

  const authCase = newPayload([categoryA], 'Runtime Authorization');
  const unauthenticated = await request('POST', '/wp-json/newsroom/v1/drafts', { payload: authCase.payload });
  const unrelated = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: unrelatedAuth, payload: authCase.payload });
  const administrator = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: adminAuth, payload: authCase.payload });
  assert([401, 403].includes(unauthenticated.status), 'Unauthenticated request was not denied.');
  expectError(unrelated, 403, 'newsroom_bridge_forbidden');
  expectError(administrator, 403, 'newsroom_bridge_forbidden');
  assert(postCountByTitle(authCase.marker) === 0 && mappingCount(authCase.payload.draft_key) === 0, 'Denied authorization request created durable state.');
  pass('authorization_negative_matrix', { unauthenticated: unauthenticated.status, unrelated: unrelated.status, administrator: administrator.status });

  const baseline = newPayload([categoryA]);
  const first = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: baseline.payload });
  assert(first.status === 201 && first.body?.replayed === false && first.body?.status === 'draft' && Number(first.body?.post_id) > 0, 'First create response contract failed.');
  const firstMapping = mapping(baseline.payload.draft_key);
  const firstPost = postInfo(first.body.post_id);
  assert(postCountByTitle(baseline.marker) === 1 && mappingCount(baseline.payload.draft_key) === 1, 'First create durable counts failed.');
  assert(
    firstMapping?.post_id === Number(first.body.post_id)
      && firstMapping.payload_hash.length === 64
      && firstMapping.actor_user_id === integrationId
      && firstMapping.reservation_token === null,
    `First mapping invariant failed: ${JSON.stringify({ response_post_id: first.body.post_id, mapping: firstMapping, integration_id: integrationId })}`,
  );
  assert(firstPost?.type === 'post' && firstPost.status === 'draft' && firstPost.author === integrationId, 'First post invariant failed.');
  assert(JSON.stringify(postCategories(first.body.post_id)) === JSON.stringify([categoryA]), 'First category assignment failed.');
  const firstGet = await request('GET', `/wp-json/newsroom/v1/drafts/${baseline.payload.draft_key}`, { auth: integrationAuth });
  assert(firstGet.status === 200 && firstGet.body?.post_id === first.body.post_id && firstGet.body?.status === 'draft', 'GET reconciliation failed.');
  const firstReplay = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: baseline.payload });
  assert(firstReplay.status === 200 && firstReplay.body?.replayed === true && firstReplay.body?.post_id === first.body.post_id, 'Sequential replay failed.');
  assert(postCountByTitle(baseline.marker) === 1 && mappingCount(baseline.payload.draft_key) === 1, 'Sequential replay duplicated durable state.');
  pass('normal_create_get_replay', { create_http: first.status, get_http: firstGet.status, replay_http: firstReplay.status, post_id: first.body.post_id });

  const canonical = newPayload([categoryB, categoryA, categoryB], 'Runtime Canonical Categories');
  const canonicalFirst = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: canonical.payload });
  const canonicalReplayPayload = { ...canonical.payload, categories: [categoryA, categoryB] };
  const canonicalReplay = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: canonicalReplayPayload });
  assert(canonicalFirst.status === 201 && canonicalReplay.status === 200 && canonicalReplay.body?.replayed === true && canonicalReplay.body?.post_id === canonicalFirst.body?.post_id, 'Canonical category replay failed.');
  assert(JSON.stringify(postCategories(canonicalFirst.body.post_id)) === JSON.stringify([categoryA, categoryB]), 'Canonical category postcondition failed.');
  pass('category_canonicalization', { create_http: canonicalFirst.status, replay_http: canonicalReplay.status, categories: [categoryA, categoryB] });

  const conflictPayload = { ...baseline.payload, title: `${baseline.marker} changed` };
  const conflict = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: conflictPayload });
  expectError(conflict, 409, 'newsroom_idempotency_conflict');
  assert(postCountByTitle(baseline.marker) === 1 && postCountByTitle(conflictPayload.title) === 0 && mapping(baseline.payload.draft_key)?.post_id === first.body.post_id, 'Conflict altered durable state.');
  pass('idempotency_conflict', { http: conflict.status, code: conflict.body.code });

  const invalidCases = [];
  const invalidBase = newPayload([categoryA], 'Runtime Invalid');
  const cases = [
    { name: 'uppercase_uuid', payload: { ...invalidBase.payload, draft_key: invalidBase.payload.draft_key.toUpperCase() }, status: 400, code: 'newsroom_invalid_draft_key' },
    { name: 'empty_title', payload: { ...invalidBase.payload, draft_key: randomUUID(), title: '' }, status: 400, code: 'newsroom_invalid_payload' },
    { name: 'empty_categories', payload: { ...invalidBase.payload, draft_key: randomUUID(), categories: [] }, status: 400, code: 'newsroom_invalid_payload' },
    { name: 'nonexistent_category', payload: { ...invalidBase.payload, draft_key: randomUUID(), categories: [2147483647] }, status: 400, code: 'newsroom_category_not_found' },
    { name: 'unsupported_publish_status', payload: { ...invalidBase.payload, draft_key: randomUUID(), title: `${invalidBase.marker} publish`, status: 'publish' }, status: 400, code: 'newsroom_invalid_payload' },
  ];
  for (const testCase of cases) {
    const response = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: testCase.payload });
    expectError(response, testCase.status, testCase.code);
    invalidCases.push({ name: testCase.name, http: response.status, code: response.body.code });
  }
  assert(postCountByTitle(invalidBase.marker) === 0 && postCountByTitle(`${invalidBase.marker} publish`) === 0, 'Invalid input created a post.');
  pass('invalid_and_unsupported_input', { cases: invalidCases });

  const concurrent = newPayload([categoryA, categoryB], 'Runtime Concurrent Identical');
  const identicalResponses = await Promise.all(Array.from({ length: 20 }, () => request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: concurrent.payload, timeout: 120000 })));
  const identicalIds = [...new Set(identicalResponses.filter((response) => [200, 201].includes(response.status)).map((response) => response.body?.post_id))];
  assert(identicalResponses.every((response) => [200, 201].includes(response.status)), `Identical concurrency had unexpected statuses ${JSON.stringify(countStatuses(identicalResponses))}.`);
  assert(identicalIds.length === 1 && postCountByTitle(concurrent.marker) === 1 && mappingCount(concurrent.payload.draft_key) === 1 && mapping(concurrent.payload.draft_key)?.reservation_token === null, 'Identical concurrency durable invariant failed.');
  pass('concurrent_identical_20', { http_counts: countStatuses(identicalResponses), unique_post_ids: identicalIds, durable_posts: 1, durable_mappings: 1 });

  const conflicting = newPayload([categoryA], 'Runtime Concurrent Conflict X');
  const conflictX = conflicting.payload;
  const conflictY = { ...conflictX, title: conflictX.title.replace('Conflict X', 'Conflict Y'), content: 'Conflicting disposable payload Y.' };
  const conflictingResponses = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const variant = index % 2 === 0 ? 'X' : 'Y';
    const payload = variant === 'X' ? conflictX : conflictY;
    const response = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload, timeout: 120000 });
    return { variant, payload, response };
  }));
  const responseValues = conflictingResponses.map((outcome) => outcome.response);
  const createOutcomes = conflictingResponses.filter((outcome) => outcome.response.status === 201);
  assert(createOutcomes.length === 1, `Conflicting concurrency expected one HTTP 201, received ${createOutcomes.length}.`);
  const winningOutcome = createOutcomes[0];
  const expectedWinningHash = reconciliationPayloadHash(winningOutcome.payload);
  const losingVariant = winningOutcome.variant === 'X' ? 'Y' : 'X';
  assert(conflictingResponses.filter((outcome) => outcome.variant === winningOutcome.variant).every((outcome) => [200, 201].includes(outcome.response.status)), 'A winning-payload request did not create or replay successfully.');
  assert(conflictingResponses.filter((outcome) => outcome.variant === losingVariant).every((outcome) => outcome.response.status === 409 && outcome.response.body?.code === 'newsroom_idempotency_conflict'), 'A losing-payload request did not return the deterministic conflict contract.');
  assert(responseValues.every((response) => [200, 201, 409].includes(response.status)), `Conflicting concurrency had unexpected statuses ${JSON.stringify(countStatuses(responseValues))}.`);
  const durableConflictMapping = mapping(conflictX.draft_key);
  assert(postCountByTitle(conflictX.title) + postCountByTitle(conflictY.title) === 1 && mappingCount(conflictX.draft_key) === 1, 'Conflicting concurrency durable count invariant failed.');
  assert(durableConflictMapping?.payload_hash === expectedWinningHash, 'Durable mapping hash does not bind to the unique HTTP 201 payload.');
  assert(durableConflictMapping.reservation_token === null, 'Conflicting concurrency left a reservation token committed.');
  const successfulOutcomes = conflictingResponses.filter((outcome) => [200, 201].includes(outcome.response.status));
  assert(successfulOutcomes.every((outcome) => Number(outcome.response.body?.post_id) === durableConflictMapping.post_id), 'A successful conflicting-concurrency response referenced a different post ID.');
  const durableConflictPost = postInfo(durableConflictMapping.post_id);
  assert(durableConflictPost?.title === winningOutcome.payload.title, 'Durable post does not match the identified winning payload.');

  const immutableHash = durableConflictMapping.payload_hash;
  const immutablePostId = durableConflictMapping.post_id;
  const deterministicConflictPayload = winningOutcome.variant === 'X' ? conflictY : conflictX;
  const deterministicConflict = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: deterministicConflictPayload });
  expectError(deterministicConflict, 409, 'newsroom_idempotency_conflict');
  const mappingAfterConflict = mapping(conflictX.draft_key);
  assert(mappingAfterConflict?.payload_hash === immutableHash, 'A subsequent conflict changed the durable payload hash.');
  assert(mappingAfterConflict.post_id === immutablePostId, 'A subsequent conflict changed the durable mapped post ID.');
  assert(postCountByTitle(conflictX.title) + postCountByTitle(conflictY.title) === 1 && mappingCount(conflictX.draft_key) === 1, 'A subsequent conflict changed durable counts.');
  pass('concurrent_conflicting_20', {
    http_counts: countStatuses(responseValues),
    winner_variant: winningOutcome.variant,
    winner_title: winningOutcome.payload.title,
    expected_winning_hash: expectedWinningHash,
    durable_winning_hash: immutableHash,
    post_conflict_hash: mappingAfterConflict.payload_hash,
    durable_post_id: immutablePostId,
    successful_response_post_ids_consistent: true,
    post_conflict_hash_immutable: true,
    durable_posts: 1,
    durable_mappings: 1,
    final_reservation_token: null,
  });

  const throwFault = newPayload([categoryA], 'Runtime Fault Throw');
  const throwResponse = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: throwFault.payload, headers: { 'x-newsroom-test-fault': 'throw_after_insert' } });
  assert(throwResponse.body?.code === 'newsroom_draft_creation_failed' && postCountByTitle(throwFault.marker) === 0 && mappingCount(throwFault.payload.draft_key) === 0, 'Throw-after-insert rollback failed.');
  pass('fault_throw_after_insert', { http: throwResponse.status, code: throwResponse.body.code, durable_posts: 0, durable_mappings: 0 });

  const attachFault = newPayload([categoryA], 'Runtime Fault Attach');
  const attachResponse = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: attachFault.payload, headers: { 'x-newsroom-test-fault': 'attach_error' } });
  expectError(attachResponse, 503, 'newsroom_reconciliation_storage_error');
  assert(postCountByTitle(attachFault.marker) === 0 && mappingCount(attachFault.payload.draft_key) === 0, 'Attachment failure rollback failed.');
  pass('fault_mapping_attachment', { http: attachResponse.status, code: attachResponse.body.code, durable_posts: 0, durable_mappings: 0 });

  const categoryFault = newPayload([categoryA], 'Runtime Fault Category');
  const categoryResponse = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: categoryFault.payload, headers: { 'x-newsroom-test-fault': 'category_corruption', 'x-newsroom-test-category': String(categoryC) } });
  assert(categoryResponse.body?.code === 'newsroom_draft_creation_failed' && postCountByTitle(categoryFault.marker) === 0 && mappingCount(categoryFault.payload.draft_key) === 0, 'Category postcondition rollback failed.');
  pass('fault_category_postcondition', { http: categoryResponse.status, code: categoryResponse.body.code, durable_posts: 0, durable_mappings: 0 });

  const commitFault = newPayload([categoryA], 'Runtime Fault Commit');
  const commitResponse = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: commitFault.payload, headers: { 'x-newsroom-test-fault': 'commit_error' } });
  expectError(commitResponse, 503, 'newsroom_reconciliation_outcome_uncertain');
  const commitGet = await request('GET', `/wp-json/newsroom/v1/drafts/${commitFault.payload.draft_key}`, { auth: integrationAuth });
  expectError(commitGet, 404, 'newsroom_reconciliation_not_found');
  const commitRetry = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: commitFault.payload });
  assert(commitRetry.status === 201 && postCountByTitle(commitFault.marker) === 1 && mappingCount(commitFault.payload.draft_key) === 1, 'Uncertain-outcome recovery failed.');
  pass('fault_commit_uncertain_recovery', { fault_http: commitResponse.status, reconciliation_http: commitGet.status, retry_http: commitRetry.status, durable_posts: 1, durable_mappings: 1 });

  const readFault = newPayload([categoryA], 'Runtime Fault Read');
  const readCreate = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: readFault.payload });
  assert(readCreate.status === 201, 'Read-fault fixture creation failed.');
  const readError = await request('GET', `/wp-json/newsroom/v1/drafts/${readFault.payload.draft_key}`, { auth: integrationAuth, headers: { 'x-newsroom-test-fault': 'get_read_error' } });
  expectError(readError, 503, 'newsroom_reconciliation_storage_error');
  const readRecovery = await request('GET', `/wp-json/newsroom/v1/drafts/${readFault.payload.draft_key}`, { auth: integrationAuth });
  assert(readRecovery.status === 200, 'Mapping read did not recover after fault removal.');
  pass('fault_mapping_get_database_error', { fault_http: readError.status, code: readError.body.code, recovered_http: readRecovery.status });

  const tamperFault = newPayload([categoryA], 'Runtime Fault Tamper');
  const tamperResponse = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: tamperFault.payload, headers: { 'x-newsroom-test-fault': 'transaction_tamper' } });
  const tamperGet = await request('GET', `/wp-json/newsroom/v1/drafts/${tamperFault.payload.draft_key}`, { auth: integrationAuth });
  const tamperReplay = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: tamperFault.payload });
  expectError(tamperGet, 409, 'newsroom_reconciliation_corrupt');
  expectError(tamperReplay, 409, 'newsroom_reconciliation_corrupt');
  assert(postCountByTitle(tamperFault.marker) === 1 && mappingCount(tamperFault.payload.draft_key) === 1 && mapping(tamperFault.payload.draft_key)?.reservation_token !== null, 'Transaction tamper did not produce the expected fail-closed state.');
  const tamperPostId = mapping(tamperFault.payload.draft_key).post_id ?? postIdByTitle(tamperFault.marker);
  wp(['post', 'delete', String(tamperPostId), '--force'], { label: 'Tamper fixture cleanup' });
  db(`DELETE FROM wp_newsroom_reconciliation WHERE draft_key = '${tamperFault.payload.draft_key}'`);
  pass('fault_third_party_transaction_tamper', { initial_http: tamperResponse.status, lookup_http: tamperGet.status, replay_http: tamperReplay.status, classification: 'EXPECTED EXTERNAL LIMITATION', cleaned: true });

  const corruptKey = randomUUID();
  const corruptToken = randomUUID();
  db(`INSERT INTO wp_newsroom_reconciliation (draft_key, post_id, payload_hash, actor_user_id, reservation_token, created_at, updated_at) VALUES ('${corruptKey}', NULL, '${'a'.repeat(64)}', ${integrationId}, '${corruptToken}', UTC_TIMESTAMP(), UTC_TIMESTAMP())`);
  const corruptPayload = { ...newPayload([categoryA], 'Runtime Corrupt Mapping').payload, draft_key: corruptKey };
  const corruptPost = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: corruptPayload });
  const corruptGet = await request('GET', `/wp-json/newsroom/v1/drafts/${corruptKey}`, { auth: integrationAuth });
  expectError(corruptPost, 409, 'newsroom_reconciliation_corrupt');
  expectError(corruptGet, 409, 'newsroom_reconciliation_corrupt');
  assert(postCountByTitle(corruptPayload.title) === 0, 'Corrupt mapping created a replacement post.');
  db(`DELETE FROM wp_newsroom_reconciliation WHERE draft_key = '${corruptKey}'`);
  pass('committed_incomplete_mapping', { post_http: corruptPost.status, get_http: corruptGet.status, replacement_posts: 0 });

  const missing = newPayload([categoryA], 'Runtime Missing Target');
  const missingCreate = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: missing.payload });
  assert(missingCreate.status === 201, 'Missing-target fixture creation failed.');
  wp(['post', 'delete', String(missingCreate.body.post_id), '--force'], { label: 'Missing target deletion' });
  const missingGet = await request('GET', `/wp-json/newsroom/v1/drafts/${missing.payload.draft_key}`, { auth: integrationAuth });
  const missingReplay = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: missing.payload });
  expectError(missingGet, 409, 'newsroom_reconciliation_target_missing');
  expectError(missingReplay, 409, 'newsroom_reconciliation_target_missing');
  assert(postCountByTitle(missing.marker) === 0 && mappingCount(missing.payload.draft_key) === 1, 'Missing target was replaced or mapping removed.');
  pass('missing_target', { get_http: missingGet.status, replay_http: missingReplay.status, replacement_posts: 0, mapping_preserved: true });

  const laterStatus = newPayload([categoryA], 'Runtime Later Status');
  const laterCreate = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: laterStatus.payload });
  assert(laterCreate.status === 201, 'Later-status fixture creation failed.');
  wp(['post', 'update', String(laterCreate.body.post_id), '--post_status=publish'], { label: 'Local later-status change' });
  const laterGet = await request('GET', `/wp-json/newsroom/v1/drafts/${laterStatus.payload.draft_key}`, { auth: integrationAuth });
  assert(laterGet.status === 200 && laterGet.body?.post_id === laterCreate.body.post_id && laterGet.body?.status === 'publish', 'Later status was not reflected through stable mapping.');
  pass('later_status_change', { post_id: laterCreate.body.post_id, status: laterGet.body.status });

  db('ALTER TABLE wp_newsroom_reconciliation DROP INDEX post_id');
  const schemaFault = newPayload([categoryA], 'Runtime Schema Corruption');
  const schemaResponse = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: schemaFault.payload });
  expectError(schemaResponse, 503, 'newsroom_reconciliation_storage_error');
  assert(postCountByTitle(schemaFault.marker) === 0, 'Schema corruption allowed post creation.');
  db('ALTER TABLE wp_newsroom_reconciliation ADD UNIQUE KEY post_id (post_id)');
  pass('schema_index_corruption', { http: schemaResponse.status, code: schemaResponse.body.code, created_posts: 0, restored: true });

  db('ALTER TABLE wp_postmeta ENGINE=MyISAM');
  const engineFault = newPayload([categoryA], 'Runtime Nontransactional');
  const engineResponse = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: engineFault.payload });
  expectError(engineResponse, 503, 'newsroom_storage_not_transactional');
  assert(postCountByTitle(engineFault.marker) === 0, 'Nontransactional storage allowed post creation.');
  db('ALTER TABLE wp_postmeta ENGINE=InnoDB');
  pass('non_innodb_fail_closed', { table: 'wp_postmeta', http: engineResponse.status, code: engineResponse.body.code, restored: true });

  wp(['option', 'update', 'newsroom_bridge_schema_version', '999']);
  const versionFault = newPayload([categoryA], 'Runtime Schema Version');
  const versionResponse = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: versionFault.payload });
  expectError(versionResponse, 503, 'newsroom_bridge_not_configured');
  assert(postCountByTitle(versionFault.marker) === 0, 'Schema version mismatch allowed post creation.');
  wp(['option', 'update', 'newsroom_bridge_schema_version', '2']);
  pass('schema_version_mismatch', { http: versionResponse.status, code: versionResponse.body.code, restored: true });

  const persistence = newPayload([categoryA], 'Runtime Reactivation');
  const persistenceCreate = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: persistence.payload });
  assert(persistenceCreate.status === 201, 'Reactivation fixture creation failed.');
  wp(['plugin', 'deactivate', 'newsroom-bridge'], { label: 'Newsroom Bridge deactivation' });
  const mappingDuringDeactivation = mappingCount(persistence.payload.draft_key);
  wp(['plugin', 'activate', 'newsroom-bridge'], { label: 'Newsroom Bridge reactivation' });
  const persistenceGet = await request('GET', `/wp-json/newsroom/v1/drafts/${persistence.payload.draft_key}`, { auth: integrationAuth });
  assert(mappingDuringDeactivation === 1 && persistenceGet.status === 200 && persistenceGet.body?.post_id === persistenceCreate.body.post_id, 'Deactivate/reactivate did not preserve mapping.');
  pass('deactivate_reactivate_persistence', { mapping_while_inactive: mappingDuringDeactivation, get_http_after_activation: persistenceGet.status, post_id: persistenceGet.body.post_id });

  const lost = newPayload([categoryA], 'Runtime Lost Response');
  const responseWasLost = await lostResponseCreate(lost.payload, integrationAuth);
  assert(responseWasLost, 'Loopback proxy did not produce an unusable client response.');
  const lostGet = await request('GET', `/wp-json/newsroom/v1/drafts/${lost.payload.draft_key}`, { auth: integrationAuth });
  assert(lostGet.status === 200 && Number(lostGet.body?.post_id) > 0, 'Lost-response reconciliation did not recover the post.');
  const lostReplay = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: lost.payload });
  assert(lostReplay.status === 200 && lostReplay.body?.replayed === true && lostReplay.body?.post_id === lostGet.body.post_id && postCountByTitle(lost.marker) === 1 && mappingCount(lost.payload.draft_key) === 1, 'Lost-response replay duplicated state.');
  pass('lost_http_response_recovery', { client_response_unusable: true, reconciliation_http: lostGet.status, replay_http: lostReplay.status, durable_posts: 1, durable_mappings: 1 });

  const coreDraftTitle = `Runtime Core Draft ${randomUUID().slice(0, 8)}`;
  const coreDraft = await request('POST', '/wp-json/wp/v2/posts', { auth: integrationAuth, payload: { title: coreDraftTitle, content: 'Local core REST security characterization.', status: 'draft' } });
  assert(coreDraft.status === 201 && Number(coreDraft.body?.id) > 0, 'Direct core REST draft creation did not return a valid HTTP 201 post ID.');
  const coreDraftPost = postInfo(coreDraft.body.id);
  assert(coreDraftPost?.type === 'post' && coreDraftPost.author === integrationId && coreDraftPost.status === 'draft', 'Direct core REST draft durable postcondition failed.');
  const corePublishTitle = `Runtime Core Publish ${randomUUID().slice(0, 8)}`;
  const corePublish = await request('POST', '/wp-json/wp/v2/posts', { auth: integrationAuth, payload: { title: corePublishTitle, content: 'Local core REST publish characterization.', status: 'publish' } });
  assert(corePublish.status === 201 && Number(corePublish.body?.id) > 0, 'Direct core REST publication did not return a valid HTTP 201 post ID.');
  const corePublishPost = postInfo(corePublish.body.id);
  assert(corePublishPost?.type === 'post' && corePublishPost.author === integrationId && corePublishPost.status === 'publish', 'Direct core REST publish durable postcondition failed.');
  const capabilityJson = wp(['eval', `$u=get_user_by('id', ${integrationId}); echo wp_json_encode(array('edit_posts'=>user_can($u,'edit_posts'),'publish_posts'=>user_can($u,'publish_posts'),'upload_files'=>user_can($u,'upload_files'),'manage_categories'=>user_can($u,'manage_categories')));`]);
  const capabilities = JSON.parse(capabilityJson);
  if (Number(coreDraft.body?.id) > 0) wp(['post', 'delete', String(coreDraft.body.id), '--force'], { label: 'Core draft cleanup' });
  if (Number(corePublish.body?.id) > 0) wp(['post', 'delete', String(corePublish.body.id), '--force'], { label: 'Core publish cleanup' });
  pass('direct_core_rest_security_characterization', {
    draft_http: coreDraft.status,
    draft_created: true,
    draft_db_postcondition: { type: coreDraftPost.type, author: coreDraftPost.author, status: coreDraftPost.status },
    publish_http: corePublish.status,
    publish_created: true,
    publish_db_postcondition: { type: corePublishPost.type, author: corePublishPost.author, status: corePublishPost.status },
    capabilities,
    classification: corePublish.status === 201 ? 'PRODUCTION TRUST-BOUNDARY BLOCKER' : 'publish bypass not confirmed',
  });

  const cache = JSON.parse(wp(['eval', `echo wp_json_encode(array('external_object_cache'=>wp_using_ext_object_cache(),'drop_in_exists'=>file_exists(WP_CONTENT_DIR . '/object-cache.php')));`]));
  const hooks = JSON.parse(wp(['eval', `global $wp_filter; $out=array(); foreach(array('rest_insert_post','rest_after_insert_post','save_post','wp_after_insert_post') as $hook){$out[$hook]=array(); if(isset($wp_filter[$hook])){foreach($wp_filter[$hook]->callbacks as $priority=>$callbacks){foreach($callbacks as $callback){$fn=$callback['function']; if(is_string($fn)){$name=$fn;} elseif(is_array($fn)){$name=(is_object($fn[0])?get_class($fn[0]):$fn[0]).'::'.$fn[1];} elseif($fn instanceof Closure){$name='Closure';} else {$name='callable';} $out[$hook][]=array('priority'=>(int)$priority,'callback'=>$name);}}}} echo wp_json_encode($out);`]));
  pass('cache_and_hook_characterization', { cache, persistent_object_cache_tested: false, hooks, production_active_hook_inventory_required: true });

  const healthyAfterRestoration = newPayload([categoryA], 'Runtime Final Health');
  const healthyResponse = await request('POST', '/wp-json/newsroom/v1/drafts', { auth: integrationAuth, payload: healthyAfterRestoration.payload });
  assert(healthyResponse.status === 201, 'Normal bridge operation did not resume after defence tests.');
  pass('final_runtime_health', { http: healthyResponse.status, post_id: healthyResponse.body.post_id });
} catch (error) {
  fatalError = redact(error?.stack || error?.message || error);
  evidence.results.push({ name: 'fatal', status: 'FAIL', details: { error: fatalError } });
  process.stderr.write(`FAIL ${redact(error?.message || error)}\n`);
} finally {
  evidence.hashes_after = hashes();
  try {
    compose(['down', '-v', '--remove-orphans'], { label: 'Disposable runtime cleanup', allowFailure: true });
  } catch (cleanupError) {
    evidence.cleanup.error = redact(cleanupError?.message || cleanupError);
  }
  const containers = run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.ID}}'], { label: 'Container cleanup verification', allowFailure: true }).stdout.trim();
  const volumes = run('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Name}}'], { label: 'Volume cleanup verification', allowFailure: true }).stdout.trim();
  evidence.cleanup = { ...evidence.cleanup, containers_remaining: containers ? containers.split('\n') : [], volumes_remaining: volumes ? volumes.split('\n') : [] };
  evidence.finished_at = new Date().toISOString();
  evidence.source_hashes_unchanged = JSON.stringify(evidence.hashes_before) === JSON.stringify(evidence.hashes_after);
  writeFileSync(resultsFile, JSON.stringify(evidence, null, 2) + '\n');
  if (existsSync(envFile)) rmSync(envFile, { force: true });
}

if (fatalError || !evidence.source_hashes_unchanged || evidence.cleanup.containers_remaining.length || evidence.cleanup.volumes_remaining.length) {
  process.exitCode = 1;
} else {
  process.stdout.write(`PASS runtime suite (${evidence.results.filter((result) => result.status === 'PASS').length} checks)\n`);
}
