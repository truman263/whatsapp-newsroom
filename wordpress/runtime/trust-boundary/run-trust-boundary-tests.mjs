import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(runtimeDir, '..', '..', '..');
const composeFile = resolve(runtimeDir, 'compose.yaml');
const envFile = resolve(runtimeDir, '.env.runtime');
const resultsFile = resolve(runtimeDir, 'runtime-results.json');
const pluginDir = resolve(repoRoot, 'wordpress', 'newsroom-bridge');
const projectName = 'newsroom-trust-boundary';
const approvedHashes = {
  'includes/class-newsroom-bridge-db.php': '1362cb101031088b78e27d54b78edfac6488d9f979979a3786916839811a20fa',
  'includes/class-newsroom-bridge-reconciliation.php': '6a7ce8aec4ab3040804c217f00341275ead25ea78570fc4cc93f47cde03a373a',
  'includes/class-newsroom-bridge-rest.php': '965608c6063540985d23f9a83a679c49eee1543238c595a850100755f9cf609a',
  'newsroom-bridge.php': '04d08c7ea2bcc48f3bfc145fe0975683deae2fd71fcdb12ad2575f4e95aae5dc',
};
const requiredServiceCapabilities = ['read', 'edit_posts'];
const forbiddenServiceCapabilities = [
  'publish_posts', 'edit_others_posts', 'edit_published_posts', 'delete_posts', 'delete_published_posts',
  'delete_others_posts', 'delete_private_posts', 'edit_private_posts', 'upload_files', 'manage_categories',
  'manage_options', 'edit_users', 'create_users', 'delete_users', 'promote_users', 'list_users',
  'activate_plugins', 'install_plugins', 'update_plugins', 'delete_plugins', 'edit_plugins', 'switch_themes',
  'edit_themes', 'install_themes', 'update_themes', 'delete_themes', 'edit_files', 'unfiltered_html',
  'manage_network', 'manage_network_users', 'manage_network_plugins', 'manage_network_themes',
  'manage_network_options', 'setup_network',
];
const expectedEvidenceGroups = [
  'cleanup_failure_propagation_guards',
  'current_author_generic_write_surface',
  'custom_role_only_insufficient',
  'service_user_lockdown',
  'valid_hmac_bridge_create_and_get',
  'get_zero_body_and_content_type_contract',
  'content_type_contract',
  'route_query_and_method_override_contract',
  'duplicate_header_stack_characterization',
  'canonical_key_ring_contract',
  'timestamp_boundaries_and_formats',
  'invalid_and_tampered_hmac_matrix',
  'signed_replay_and_expiry',
  'hmac_core_rest_and_batch_bypass_denied',
  'dangerous_capability_drift_fails_closed',
  'xmlrpc_backend_credentials_denied',
  'ordinary_user_non_regression',
  'final_service_user_model',
];

const knownSecrets = [];
const evidence = {
  started_at: new Date().toISOString(),
  commit: '0629041',
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

const draftHmacKeyId = 'draft-local-v1';
let draftHmacSecret = '';

function bridgeHashes() {
  return Object.fromEntries(Object.keys(approvedHashes).map((relativePath) => [
    relativePath,
    createHash('sha256').update(readFileSync(resolve(pluginDir, relativePath))).digest('hex'),
  ]));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(name, details = {}) {
  evidence.results.push({ name, status: 'PASS', details });
  process.stdout.write(`PASS ${name}\n`);
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

let port = 0;
let runtimeEnv = {};
let serviceUserId = '';
function compose(args, options = {}) {
  return run(
    'docker',
    ['compose', '--project-name', projectName, '--env-file', envFile, '--file', composeFile, ...args],
    {
      ...options,
      cwd: runtimeDir,
      env: { ...process.env, ...runtimeEnv, NEWSROOM_BRIDGE_USER_ID: serviceUserId },
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

function sqlEscape(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "''");
}

function postCountByTitle(title) {
  return Number(db(`SELECT COUNT(*) FROM wp_posts WHERE post_type = 'post' AND post_title = '${sqlEscape(title)}'`));
}

function postInfo(postId) {
  const row = db(`SELECT CONCAT_WS(CHAR(9), ID, post_type, post_status, post_author, post_title, post_content) FROM wp_posts WHERE ID = ${Number(postId)}`);
  if (!row) return null;
  const [id, type, status, author, title, content] = row.split(String.raw`\t`);
  return { id: Number(id), type, status, author: Number(author), title, content };
}

function revisionCount(postId) {
  return Number(db(`SELECT COUNT(*) FROM wp_posts WHERE post_parent = ${Number(postId)} AND post_type = 'revision'`));
}

function attachmentCount() {
  return Number(db("SELECT COUNT(*) FROM wp_posts WHERE post_type = 'attachment'"));
}

function postCategoryIds(postId) {
  const output = wp(['post', 'term', 'list', String(postId), 'category', '--field=term_id']);
  return output ? output.split(/\r?\n/).map(Number).sort((a, b) => a - b) : [];
}

function reconciliationInfo(draftKey) {
  const escaped = sqlEscape(draftKey);
  const count = Number(db(`SELECT COUNT(*) FROM wp_newsroom_reconciliation WHERE draft_key = '${escaped}'`));
  const row = db(`SELECT CONCAT_WS(CHAR(9), draft_key, post_id, payload_hash, actor_user_id, IFNULL(reservation_token, '<NULL>')) FROM wp_newsroom_reconciliation WHERE draft_key = '${escaped}'`);
  if (!row) return { count, row: null };
  const [storedDraftKey, postId, payloadHash, actorUserId, reservationToken] = row.split(String.raw`\t`);
  return {
    count,
    row: {
      draftKey: storedDraftKey,
      postId: Number(postId),
      payloadHash,
      actorUserId: Number(actorUserId),
      reservationToken: reservationToken === '<NULL>' ? null : reservationToken,
    },
  };
}

function capabilitySnapshot(userId) {
  const names = [...requiredServiceCapabilities, ...forbiddenServiceCapabilities];
  const encoded = Buffer.from(JSON.stringify(names), 'utf8').toString('base64');
  const raw = wp(['eval', `$u=get_user_by('id',${Number(userId)});$names=json_decode(base64_decode('${encoded}'),true);$out=array();foreach($names as $name){$out[$name]=user_can($u,$name);}echo wp_json_encode($out);`]);
  return JSON.parse(raw);
}

function assertServiceCapabilityPolicy(capabilities, label) {
  assert(requiredServiceCapabilities.every((name) => capabilities[name] === true), `${label} lacks a required capability.`);
  assert(forbiddenServiceCapabilities.every((name) => capabilities[name] === false), `${label} has a forbidden capability.`);
}

function keyRingIsValid(entries) {
  const encoded = Buffer.from(JSON.stringify(entries), 'utf8').toString('base64');
  return wp(['eval', `$ring=json_decode(base64_decode('${encoded}'),true);echo false===newsroom_tb_validate_key_ring($ring)?'0':'1';`], { sensitive: true, label: 'Test key-ring validation' }) === '1';
}

function noncanonicalBase64url(encoded) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const index = alphabet.indexOf(encoded.at(-1));
  assert(index >= 0 && index % 4 === 0, 'Generated HMAC key was unexpectedly noncanonical.');
  return `${encoded.slice(0, -1)}${alphabet[index + 1]}`;
}

let baseUrl = '';

function basicAuthorization(auth) {
  if (!auth) return undefined;
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
}

async function request(method, route, { auth, payload, body, headers = {}, timeout = 60000 } = {}) {
  const url = new URL(route, baseUrl);
  assertLocalUrl(url);
  const requestHeaders = { connection: 'close', ...headers };
  let requestBody = body;
  if (payload !== undefined) {
    requestBody = JSON.stringify(payload);
    requestHeaders['content-type'] = 'application/json';
  }
  const authorization = basicAuthorization(auth);
  if (authorization) requestHeaders.authorization = authorization;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : requestBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || error?.name || 'unknown';
    const logs = compose(['logs', '--no-color', '--tail', '30', 'wordpress'], { label: 'Local HTTP transport diagnostic logs', allowFailure: true }).stdout.trim();
    throw new Error(`Local HTTP ${method.toUpperCase()} ${url.pathname} failed before a response (${cause}).${logs ? ` WordPress log tail: ${redact(logs)}` : ''}`);
  }
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function rawHttpRequest(method, route, headerPairs, body = '') {
  assert(route.startsWith('/'), 'Raw HTTP route must be origin-relative.');
  const bodyBytes = Buffer.from(body);
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectRequest(new Error('Raw HTTP request timed out.'));
    }, 30000);
    socket.once('connect', () => {
      const lines = [
        `${method} ${route} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
        `Content-Length: ${bodyBytes.length}`,
        ...headerPairs.map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ];
      socket.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), bodyBytes]));
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', (error) => {
      clearTimeout(timeout);
      rejectRequest(error);
    });
    socket.once('end', () => {
      clearTimeout(timeout);
      const response = Buffer.concat(chunks).toString('latin1');
      const match = /^HTTP\/1\.[01] ([0-9]{3})/.exec(response);
      if (!match) {
        rejectRequest(new Error('Raw HTTP response had no status line.'));
        return;
      }
      resolveRequest({ status: Number(match[1]), raw: response });
    });
  });
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

function canonicalHmac(method, route, timestamp, rawBody, keyId, encodedSecret) {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const canonical = ['newsroom-hmac-v1', keyId, method.toUpperCase(), route, String(timestamp), bodyHash].join('\n');
  return createHmac('sha256', Buffer.from(encodedSecret, 'base64url')).update(canonical, 'utf8').digest('hex');
}

function hmacHeaders(method, route, rawBody, {
  timestamp = Math.floor(Date.now() / 1000),
  keyId = runtimeEnv.NEWSROOM_HMAC_DRAFT_KEY_ID,
  secret = runtimeEnv.NEWSROOM_HMAC_DRAFT_SECRET,
  signature,
  version = '1',
} = {}) {
  return {
    'x-newsroom-auth-version': version,
    'x-newsroom-key-id': keyId,
    'x-newsroom-timestamp': String(timestamp),
    'x-newsroom-signature': signature ?? canonicalHmac(method, route, String(timestamp), rawBody, keyId, secret),
  };
}

function hmacHeaderPairs(method, route, rawBody, options = {}) {
  return Object.entries(hmacHeaders(method, route, rawBody, options)).map(([name, value]) => [name, value]);
}

async function alignToFreshSecond() {
  while (Date.now() % 1000 > 100) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return Math.floor(Date.now() / 1000);
}

async function signedRequest(method, route, { payload, rawBody, sendMethod = method, sendRoute = route, authOptions = {}, headers = {} } = {}) {
  const body = rawBody ?? (payload === undefined ? '' : JSON.stringify(payload));
  const signedHeaders = hmacHeaders(method, route, body, authOptions);
  return request(sendMethod, `/wp-json${sendRoute}`, {
    body: ['GET', 'HEAD'].includes(sendMethod.toUpperCase()) ? undefined : body,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...signedHeaders, ...headers },
  });
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function xmlValue(value) {
  if (typeof value === 'boolean') return `<boolean>${value ? 1 : 0}</boolean>`;
  if (Number.isInteger(value)) return `<int>${value}</int>`;
  if (Array.isArray(value)) return `<array><data>${value.map((item) => `<value>${xmlValue(item)}</value>`).join('')}</data></array>`;
  if (value && typeof value === 'object') {
    return `<struct>${Object.entries(value).map(([key, item]) => `<member><name>${xmlEscape(key)}</name><value>${xmlValue(item)}</value></member>`).join('')}</struct>`;
  }
  return `<string>${xmlEscape(value ?? '')}</string>`;
}

async function xmlrpc(methodName, params, headers = {}) {
  const body = `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(methodName)}</methodName><params>${params.map((param) => `<param><value>${xmlValue(param)}</value></param>`).join('')}</params></methodCall>`;
  const response = await request('POST', '/xmlrpc.php', { body, headers: { 'content-type': 'text/xml', ...headers } });
  const raw = response.body?.raw ?? '';
  const fault = /<fault>/i.test(raw);
  const stringMatches = [...raw.matchAll(/<string>([\s\S]*?)<\/string>/gi)].map((match) => match[1]);
  return { status: response.status, raw, fault, strings: stringMatches };
}

async function passwordLogin(username, password) {
  const body = new URLSearchParams({ log: username, pwd: password, redirect_to: `${baseUrl}/wp-admin/` }).toString();
  const response = await fetch(`${baseUrl}/wp-login.php`, {
    method: 'POST',
    headers: { connection: 'close', 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  return {
    status: response.status,
    location: response.headers.get('location') ?? '',
    hasAuthCookie: /wordpress_(?:sec_|logged_in_)/i.test(response.headers.get('set-cookie') ?? ''),
  };
}

function parseXmlPostId(response) {
  const candidate = response.strings.find((value) => /^[1-9][0-9]*$/.test(value));
  return candidate ? Number(candidate) : 0;
}

function expectExactStatus(response, expectedStatus, label) {
  assert(response && Number.isInteger(response.status), `${label} returned no concrete HTTP status.`);
  assert(response.status === expectedStatus, `${label} expected HTTP ${expectedStatus}, received HTTP ${response.status}.`);
}

function expectAuthenticationFailure(response, label) {
  expectExactStatus(response, 401, label);
}

function expectAuthorizationFailure(response, label) {
  expectExactStatus(response, 403, label);
}

function expectNoWordPressAuthenticationArtifact(response, label) {
  assert(response?.headers && typeof response.headers.get === 'function', `${label} exposed no inspectable response headers.`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert(!/wordpress_(?:sec_|logged_in_)/i.test(setCookie), `${label} issued a WordPress authentication cookie.`);
}

function successfulCommandOutput(result, label) {
  assert(result && Number.isInteger(result.status), `${label} returned no command status.`);
  assert(result.status === 0, `${label} failed with exit ${result.status}.`);
  assert(typeof result.stdout === 'string', `${label} returned no inspectable stdout.`);
  return result.stdout.trim();
}

function commandResultIsRejected(result) {
  try {
    successfulCommandOutput(result, 'Cleanup guard self-test');
    return false;
  } catch {
    return true;
  }
}

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
let fatalError = null;
let envCreated = false;

try {
  port = await availablePort(18181);
  baseUrl = `http://127.0.0.1:${port}`;
  assertLocalUrl(baseUrl);
  draftHmacSecret = randomBytes(32).toString('base64url');
  runtimeEnv = {
    NEWSROOM_TEST_PORT: String(port),
    RUNTIME_DB_PASSWORD: randomSecret(),
    RUNTIME_DB_ROOT_PASSWORD: randomSecret(),
    RUNTIME_ADMIN_PASSWORD: randomSecret(),
    RUNTIME_SERVICE_PASSWORD: randomSecret(),
    RUNTIME_UNRELATED_PASSWORD: randomSecret(),
    NEWSROOM_HMAC_DRAFT_KEY_ID: draftHmacKeyId,
    NEWSROOM_HMAC_DRAFT_SECRET: draftHmacSecret,
    NEWSROOM_HMAC_DRAFT_KEY_RING_JSON: JSON.stringify([{ id: draftHmacKeyId, secret: draftHmacSecret }]),
  };
  knownSecrets.push(...Object.values(runtimeEnv).filter((value) => value !== String(port) && value !== runtimeEnv.NEWSROOM_HMAC_DRAFT_KEY_ID));
  writeFileSync(envFile, Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  envCreated = true;

  evidence.hashes_before = bridgeHashes();
  assert(JSON.stringify(evidence.hashes_before) === JSON.stringify(approvedHashes), 'Production bridge source hashes did not match the approved baseline before the proof.');
  assert(commandResultIsRejected({ status: 1, stdout: '' }), 'A failed cleanup command was interpreted as successful empty output.');
  assert(commandResultIsRejected({ stdout: '' }), 'A cleanup command with missing status was interpreted as successful.');
  assert(commandResultIsRejected({ status: 0 }), 'A cleanup command with missing stdout was interpreted as successful.');
  pass('cleanup_failure_propagation_guards', {
    nonzero_status_rejected: true,
    missing_status_rejected: true,
    missing_stdout_rejected: true,
  });

  compose(['pull'], { label: 'Digest-pinned image pull' });
  compose(['up', '-d', 'db', 'wordpress', 'cli'], { label: 'Trust-boundary runtime startup' });
  await waitForHttp();

  wp([
    'core', 'install', `--url=${baseUrl}`, '--title=Newsroom Trust Boundary Runtime',
    '--admin_user=runtime_admin', `--admin_password=${runtimeEnv.RUNTIME_ADMIN_PASSWORD}`,
    '--admin_email=runtime-admin@example.invalid', '--skip-email',
  ], { sensitive: true, label: 'WordPress core installation' });
  wp(['rewrite', 'structure', '/%postname%/', '--hard'], { label: 'REST permalink configuration' });
  wp(['user', 'create', 'runtime_service', 'runtime-service@example.invalid', '--role=author', `--user_pass=${runtimeEnv.RUNTIME_SERVICE_PASSWORD}`, '--porcelain'], { sensitive: true, label: 'Service Author creation' });
  wp(['user', 'create', 'runtime_unrelated', 'runtime-unrelated@example.invalid', '--role=author', `--user_pass=${runtimeEnv.RUNTIME_UNRELATED_PASSWORD}`, '--porcelain'], { sensitive: true, label: 'Unrelated Author creation' });

  const adminId = Number(wp(['user', 'get', 'runtime_admin', '--field=ID']));
  serviceUserId = wp(['user', 'get', 'runtime_service', '--field=ID']);
  const serviceId = Number(serviceUserId);
  const unrelatedId = Number(wp(['user', 'get', 'runtime_unrelated', '--field=ID']));
  const categoryId = Number(wp(['term', 'create', 'category', 'Trust Boundary Category', '--slug=trust-boundary-category', '--porcelain']));

  compose(['up', '-d', '--force-recreate', 'wordpress', 'cli'], { label: 'Service identity configuration' });
  await waitForHttp();
  wp(['plugin', 'activate', 'newsroom-bridge'], { label: 'Approved bridge activation' });

  const serviceAppPassword = wp(['user', 'application-password', 'create', String(serviceId), 'trust-boundary-baseline', '--porcelain'], { sensitive: true, label: 'Service Application Password creation' });
  const unrelatedAppPassword = wp(['user', 'application-password', 'create', String(unrelatedId), 'trust-boundary-unrelated', '--porcelain'], { sensitive: true, label: 'Unrelated Application Password creation' });
  const adminAppPassword = wp(['user', 'application-password', 'create', String(adminId), 'trust-boundary-admin', '--porcelain'], { sensitive: true, label: 'Administrator Application Password creation' });
  knownSecrets.push(serviceAppPassword, unrelatedAppPassword, adminAppPassword);
  const serviceAuth = { username: 'runtime_service', password: serviceAppPassword };
  const unrelatedAuth = { username: 'runtime_unrelated', password: unrelatedAppPassword };
  const adminAuth = { username: 'runtime_admin', password: adminAppPassword };

  evidence.fixture = {
    administrator: { id: adminId, role: 'administrator' },
    service: { id: serviceId, initial_role: 'author', reduced_role: 'newsroom_draft_service' },
    unrelated: { id: unrelatedId, role: 'author' },
    category_id: categoryId,
  };
  evidence.runtime = {
    url: baseUrl,
    wordpress_version: wp(['core', 'version']),
    php_version: compose(['exec', '-T', 'wordpress', 'php', '-r', 'echo PHP_VERSION;'], { label: 'WordPress PHP version' }).stdout.trim(),
    mariadb_version: db('SELECT VERSION()'),
    wp_cli_version: wp(['cli', 'version']),
    wordpress_image: run('docker', ['image', 'inspect', '--format', '{{.Id}}', 'wordpress:7.1-php8.2-apache@sha256:75c755113d8644a08519270d77e0c8bd14b7bea23910e3d165056870093869a2'], { label: 'WordPress image inspection' }).stdout.trim(),
    mariadb_image: run('docker', ['image', 'inspect', '--format', '{{.Id}}', 'mariadb:10.11@sha256:ce66c7be32a03aabe7241d0a10993a2db827ef652a35d25727d92a832ac8ef73'], { label: 'MariaDB image inspection' }).stdout.trim(),
    cli_image: run('docker', ['image', 'inspect', '--format', '{{.Id}}', 'wordpress:cli@sha256:2b5e9d4d3e51909dca1aaa4732e9f5e5bf0377c2114dbd8ff39f060bff202586'], { label: 'CLI image inspection' }).stdout.trim(),
  };

  const baselineLogin = await passwordLogin('runtime_service', runtimeEnv.RUNTIME_SERVICE_PASSWORD);
  if (!(baselineLogin.status === 302 && baselineLogin.hasAuthCookie)) {
    const baselineLoginLogs = compose(['logs', '--no-color', '--tail', '40', 'wordpress'], { label: 'Baseline login diagnostic log capture', allowFailure: true }).stdout.trim();
    throw new Error(`Baseline service-user password login did not succeed before lockdown (HTTP ${baselineLogin.status}, auth_cookie=${baselineLogin.hasAuthCookie}, redirect=${baselineLogin.location || 'none'}).${baselineLoginLogs ? ` WordPress log tail: ${redact(baselineLoginLogs)}` : ''}`);
  }

  const baselineTitle = `Current Author Surface ${randomUUID().slice(0, 8)}`;
  const baselineCreate = await request('POST', '/wp-json/wp/v2/posts', { auth: serviceAuth, payload: { title: baselineTitle, content: 'Current Author write-surface proof.', status: 'draft', categories: [categoryId] } });
  assert(baselineCreate.status === 201 && Number(baselineCreate.body?.id) > 0, 'Current Author Application Password could not create a core draft.');
  const baselinePostId = Number(baselineCreate.body.id);
  const baselineUpdate = await request('POST', `/wp-json/wp/v2/posts/${baselinePostId}`, { auth: serviceAuth, payload: { title: `${baselineTitle} Updated` } });
  assert(baselineUpdate.status === 200 && postInfo(baselinePostId)?.title === `${baselineTitle} Updated`, 'Current Author core update surface was not proven.');
  const baselineAutosaveContent = 'Current Author autosave surface proof.';
  const baselineRevisionCountBeforeAutosave = revisionCount(baselinePostId);
  const baselineAutosave = await request('POST', `/wp-json/wp/v2/posts/${baselinePostId}/autosaves`, { auth: serviceAuth, payload: { content: 'Current Author autosave surface proof.' } });
  const baselineRevisionCountAfterAutosave = revisionCount(baselinePostId);
  const durableAutosavePost = postInfo(baselinePostId);
  assert(
    [200, 201].includes(baselineAutosave.status)
      && Number(baselineAutosave.body?.id) === baselinePostId
      && durableAutosavePost?.content === baselineAutosaveContent,
    `Current Author autosave surface did not durably update the author-owned draft: HTTP ${baselineAutosave.status}.`,
  );
  assert(baselineRevisionCountAfterAutosave === baselineRevisionCountBeforeAutosave, 'WordPress 7.1 author-owned draft autosave unexpectedly changed revision count instead of updating the parent draft.');
  const baselinePublish = await request('POST', `/wp-json/wp/v2/posts/${baselinePostId}`, { auth: serviceAuth, payload: { status: 'publish' } });
  assert(baselinePublish.status === 200 && postInfo(baselinePostId)?.status === 'publish', 'Current Author direct publication surface was not proven.');
  const revisions = await request('GET', `/wp-json/wp/v2/posts/${baselinePostId}/revisions?context=edit`, { auth: serviceAuth });
  assert(revisions.status === 200 && Array.isArray(revisions.body), 'Current Author revision surface was not readable.');
  assert(revisions.body.length > 0, 'Current Author revision read returned no durable revision fixture.');
  const revisionId = Number(revisions.body[0].id);
  const revisionBeforeDelete = postInfo(revisionId);
  assert(revisionBeforeDelete?.type === 'revision', 'Revision deletion fixture was not durable before the request.');
  const revisionDelete = await request('DELETE', `/wp-json/wp/v2/posts/${baselinePostId}/revisions/${revisionId}?force=true`, { auth: serviceAuth });
  const revisionAfterDelete = postInfo(revisionId);
  assert(
    revisionDelete.status === 403
      && revisionDelete.body?.code === 'rest_cannot_delete'
      && revisionAfterDelete?.id === revisionBeforeDelete.id,
    `Current Author revision-delete denial or durable retention changed: HTTP ${revisionDelete.status}.`,
  );
  const baselineDelete = await request('DELETE', `/wp-json/wp/v2/posts/${baselinePostId}?force=true`, { auth: serviceAuth });
  assert(baselineDelete.status === 200 && postInfo(baselinePostId) === null, 'Current Author core deletion surface was not proven.');

  const mediaCreate = await request('POST', '/wp-json/wp/v2/media', {
    auth: serviceAuth,
    body: gif,
    headers: { 'content-type': 'image/gif', 'content-disposition': 'attachment; filename=current-author.gif' },
  });
  assert(
    mediaCreate.status === 201
      && Number(mediaCreate.body?.id) > 0
      && postInfo(Number(mediaCreate.body.id))?.type === 'attachment',
    `Current Author media upload did not create a durable attachment: HTTP ${mediaCreate.status}.`,
  );
  wp(['post', 'delete', String(mediaCreate.body.id), '--force'], { label: 'Baseline media cleanup' });

  const batchTitle = `Current Author Batch ${randomUUID().slice(0, 8)}`;
  const batchCreate = await request('POST', '/wp-json/batch/v1', {
    auth: serviceAuth,
    payload: { requests: [{ method: 'POST', path: '/wp/v2/posts', body: { title: batchTitle, content: 'Batch surface proof.', status: 'draft' } }] },
  });
  const batchInner = batchCreate.body?.responses?.[0];
  assert(
    batchCreate.status === 207
      && batchInner?.status === 201
      && Number(batchInner?.body?.id) > 0
      && postInfo(Number(batchInner.body.id))?.status === 'draft'
      && postInfo(Number(batchInner.body.id))?.title === batchTitle,
    `Current Author batch create was not durably proven: HTTP ${batchCreate.status}.`,
  );
  wp(['post', 'delete', String(batchInner.body.id), '--force'], { label: 'Baseline batch post cleanup' });

  const xmlAuth = await xmlrpc('wp.getUsersBlogs', ['runtime_service', serviceAppPassword]);
  assert(xmlAuth.status === 200 && !xmlAuth.fault, 'Current service Application Password did not authenticate to XML-RPC.');
  const xmlTitle = `Current Author XMLRPC ${randomUUID().slice(0, 8)}`;
  const xmlCreate = await xmlrpc('wp.newPost', [0, 'runtime_service', serviceAppPassword, { post_type: 'post', post_status: 'draft', post_title: xmlTitle, post_content: 'XML-RPC surface proof.' }]);
  const xmlPostId = parseXmlPostId(xmlCreate);
  assert(!xmlCreate.fault && xmlPostId > 0 && postInfo(xmlPostId)?.status === 'draft', 'Current service Application Password could not create an XML-RPC draft.');
  const xmlPublish = await xmlrpc('wp.editPost', [0, 'runtime_service', serviceAppPassword, xmlPostId, { post_status: 'publish' }]);
  assert(!xmlPublish.fault && postInfo(xmlPostId)?.status === 'publish', 'Current service Application Password could not publish through XML-RPC.');
  const xmlDelete = await xmlrpc('wp.deletePost', [0, 'runtime_service', serviceAppPassword, xmlPostId]);
  assert(!xmlDelete.fault && postInfo(xmlPostId)?.status === 'trash', 'Current service Application Password did not move the XML-RPC post to trash.');
  wp(['post', 'delete', String(xmlPostId), '--force'], { label: 'Baseline XML-RPC post cleanup' });

  pass('current_author_generic_write_surface', {
    password_login: 'allowed', core_create: 201, core_update: 200, autosave: baselineAutosave.status,
    autosave_id: baselinePostId, autosave_persistence: 'author_owned_parent_draft_update', publish: 200, revision_delete: revisionDelete.status,
    revision_delete_code: revisionDelete.body.code, revision_retained: true, delete: 200, media_upload: 201, batch_create: 201,
    xmlrpc_auth: 'allowed', xmlrpc_create: 'allowed', xmlrpc_publish: 'allowed', xmlrpc_delete_to_trash: 'allowed',
  });

  wp(['eval', "add_role('newsroom_draft_service','Newsroom Draft Service',array('read'=>true,'edit_posts'=>true));"], { label: 'Reduced role creation' });
  wp(['user', 'set-role', String(serviceId), 'newsroom_draft_service'], { label: 'Reduced role assignment' });
  const reducedCaps = capabilitySnapshot(serviceId);
  assertServiceCapabilityPolicy(reducedCaps, 'Reduced role');

  const reducedTitle = `Reduced Role Draft ${randomUUID().slice(0, 8)}`;
  const reducedCreate = await request('POST', '/wp-json/wp/v2/posts', { auth: serviceAuth, payload: { title: reducedTitle, content: 'Reduced role still has edit_posts.', status: 'draft' } });
  assert(reducedCreate.status === 201 && Number(reducedCreate.body?.id) > 0, 'Reduced edit_posts role did not retain direct draft creation as hypothesized.');
  const reducedId = Number(reducedCreate.body.id);
  const reducedBeforeUpdate = postInfo(reducedId);
  const reducedUpdatedTitle = `${reducedTitle} Updated`;
  const reducedUpdatedContent = 'Reduced role durably updated both title and content.';
  const reducedUpdate = await request('POST', `/wp-json/wp/v2/posts/${reducedId}`, {
    auth: serviceAuth,
    payload: { title: reducedUpdatedTitle, content: reducedUpdatedContent },
  });
  const reducedAfterUpdate = postInfo(reducedId);
  assert(
    reducedUpdate.status === 200
      && reducedBeforeUpdate?.author === serviceId
      && reducedAfterUpdate?.title === reducedUpdatedTitle
      && reducedAfterUpdate?.content === reducedUpdatedContent
      && reducedAfterUpdate?.author === reducedBeforeUpdate.author
      && reducedAfterUpdate?.status === 'draft',
    'Reduced edit_posts role did not durably update title/content while preserving author and draft status.',
  );
  const reducedPublish = await request('POST', `/wp-json/wp/v2/posts/${reducedId}`, { auth: serviceAuth, payload: { status: 'publish' } });
  expectAuthorizationFailure(reducedPublish, 'Reduced-role direct publication');
  assert(postInfo(reducedId)?.status === 'draft', 'Reduced-role denied publication changed durable post status.');
  const reducedDelete = await request('DELETE', `/wp-json/wp/v2/posts/${reducedId}?force=true`, { auth: serviceAuth });
  expectAuthorizationFailure(reducedDelete, 'Reduced-role direct deletion');
  assert(postInfo(reducedId)?.id === reducedId, 'Reduced-role denied deletion removed the durable post.');
  const reducedAttachmentCountBefore = attachmentCount();
  const reducedMedia = await request('POST', '/wp-json/wp/v2/media', {
    auth: serviceAuth, body: gif, headers: { 'content-type': 'image/gif', 'content-disposition': 'attachment; filename=reduced-role.gif' },
  });
  expectAuthorizationFailure(reducedMedia, 'Reduced-role direct media upload');
  assert(attachmentCount() === reducedAttachmentCountBefore, 'Reduced-role denied media upload created an attachment.');
  const reducedXmlTitle = `Reduced Role XMLRPC ${randomUUID().slice(0, 8)}`;
  const reducedXmlCreate = await xmlrpc('wp.newPost', [0, 'runtime_service', serviceAppPassword, { post_type: 'post', post_status: 'draft', post_title: reducedXmlTitle, post_content: 'Reduced role XML-RPC draft.' }]);
  const reducedXmlId = parseXmlPostId(reducedXmlCreate);
  assert(!reducedXmlCreate.fault && reducedXmlId > 0, 'Reduced edit_posts role did not retain XML-RPC draft creation.');
  const reducedXmlPublish = await xmlrpc('wp.editPost', [0, 'runtime_service', serviceAppPassword, reducedXmlId, { post_status: 'publish' }]);
  assert(reducedXmlPublish.fault && postInfo(reducedXmlId)?.status === 'draft', 'Reduced role unexpectedly retained XML-RPC publication.');
  wp(['post', 'delete', String(reducedId), '--force'], { label: 'Reduced role REST cleanup' });
  wp(['post', 'delete', String(reducedXmlId), '--force'], { label: 'Reduced role XML-RPC cleanup' });
  pass('custom_role_only_insufficient', {
    capabilities: reducedCaps, core_draft_create: reducedCreate.status, core_draft_update: reducedUpdate.status,
    direct_publish: reducedPublish.status, direct_delete: reducedDelete.status, media_upload: reducedMedia.status,
    xmlrpc_draft_create: 'allowed', xmlrpc_publish: 'denied', conclusion: 'REMOVING publish_posts ALONE DOES NOT CLOSE THE TRUST BOUNDARY',
  });

  wp(['plugin', 'activate', 'newsroom-trust-boundary-shim'], { label: 'Test-only trust-boundary shim activation' });
  const applicationPasswordsAvailable = wp(['eval', `$u=get_user_by('id',${serviceId}); echo wp_is_application_passwords_available_for_user($u)?'1':'0';`]);
  assert(applicationPasswordsAvailable === '0', 'Service-user Application Password availability remained enabled.');
  const oldAppRest = await request('GET', '/wp-json/wp/v2/users/me?context=edit', { auth: serviceAuth });
  expectAuthenticationFailure(oldAppRest, 'Existing service Application Password');
  const oldAppXml = await xmlrpc('wp.getUsersBlogs', ['runtime_service', serviceAppPassword]);
  assert(oldAppXml.fault, 'Existing service Application Password remained usable for XML-RPC.');
  const lockedLogin = await passwordLogin('runtime_service', runtimeEnv.RUNTIME_SERVICE_PASSWORD);
  assert(!(lockedLogin.status === 302 && lockedLogin.hasAuthCookie), 'Service-user interactive password login remained usable.');
  const lockedPasswordXml = await xmlrpc('wp.getUsersBlogs', ['runtime_service', runtimeEnv.RUNTIME_SERVICE_PASSWORD]);
  assert(lockedPasswordXml.fault, 'Service-user ordinary password remained usable for XML-RPC.');
  wp(['user', 'application-password', 'delete', String(serviceId), '--all'], { sensitive: true, label: 'Legacy service Application Password revocation' });
  const remainingServiceAppPasswords = Number(wp(['user', 'application-password', 'list', String(serviceId), '--format=count']));
  assert(remainingServiceAppPasswords === 0, 'A service-user Application Password remained after local revocation.');

  const serviceRecreation = await request('POST', `/wp-json/wp/v2/users/${serviceId}/application-passwords`, {
    auth: adminAuth,
    payload: { name: 'locked-service-recreation-proof' },
  });
  let serviceRecreationResult = 'denied';
  if (serviceRecreation.status === 201) {
    const recreatedPassword = String(serviceRecreation.body?.password ?? '').replaceAll(' ', '');
    assert(recreatedPassword.length > 0, 'Administrator-created service Application Password was not returned for unusability proof.');
    knownSecrets.push(recreatedPassword);
    const recreatedAuth = { username: 'runtime_service', password: recreatedPassword };
    const recreatedRest = await request('GET', '/wp-json/wp/v2/users/me?context=edit', { auth: recreatedAuth });
    const recreatedXml = await xmlrpc('wp.getUsersBlogs', ['runtime_service', recreatedPassword]);
    expectAuthenticationFailure(recreatedRest, 'Recreated locked-user Application Password REST authentication');
    assert(recreatedXml.fault, 'Recreated locked-user Application Password authenticated to XML-RPC.');
    serviceRecreationResult = 'stored_but_unusable';
  } else {
    assert(
      [401, 403, 501].includes(serviceRecreation.status),
      `Administrator service Application Password recreation expected denial/unavailability, received HTTP ${serviceRecreation.status}.`,
    );
  }
  wp(['user', 'application-password', 'delete', String(serviceId), '--all'], { sensitive: true, label: 'Recreated service Application Password cleanup' });
  const finalServiceAppPasswordCount = Number(wp(['user', 'application-password', 'list', String(serviceId), '--format=count']));
  assert(finalServiceAppPasswordCount === 0, 'A recreated service-user Application Password remained after cleanup.');

  const unrelatedRecreation = await request('POST', `/wp-json/wp/v2/users/${unrelatedId}/application-passwords`, {
    auth: adminAuth,
    payload: { name: 'unrelated-recreation-proof' },
  });
  assert(unrelatedRecreation.status === 201 && typeof unrelatedRecreation.body?.password === 'string', 'Unrelated Author Application Password creation regressed.');
  const unrelatedRecreatedPassword = unrelatedRecreation.body.password.replaceAll(' ', '');
  knownSecrets.push(unrelatedRecreatedPassword);
  const unrelatedRecreatedAuth = { username: 'runtime_unrelated', password: unrelatedRecreatedPassword };
  const unrelatedRecreatedRest = await request('GET', '/wp-json/wp/v2/users/me?context=edit', { auth: unrelatedRecreatedAuth });
  assert(unrelatedRecreatedRest.status === 200, 'New unrelated Author Application Password was not usable.');
  wp(['user', 'application-password', 'delete', String(unrelatedId), String(unrelatedRecreation.body.uuid)], { sensitive: true, label: 'Unrelated recreated Application Password cleanup' });
  pass('service_user_lockdown', {
    application_passwords_available: false, existing_application_password_rest: oldAppRest.status,
    existing_application_password_xmlrpc: 'denied', ordinary_password_login: 'denied', ordinary_password_xmlrpc: 'denied',
    administrator_recreation_http: serviceRecreation.status, administrator_recreation_result: serviceRecreationResult,
    recreated_application_password_rest: serviceRecreationResult === 'stored_but_unusable' ? 'denied' : 'not_created',
    recreated_application_password_xmlrpc: serviceRecreationResult === 'stored_but_unusable' ? 'denied' : 'not_created',
    unrelated_recreation_http: unrelatedRecreation.status, unrelated_recreated_password: 'usable',
    retained_application_passwords: finalServiceAppPasswordCount,
  });

  const draftKey = randomUUID();
  const draftPayload = { draft_key: draftKey, title: `HMAC Draft ${randomUUID().slice(0, 8)}`, content: 'Route-scoped HMAC draft proof.', excerpt: '', categories: [categoryId] };
  const draftRaw = JSON.stringify(draftPayload);
  const signedTimestamp = Math.floor(Date.now() / 1000);
  const validCreate = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: draftRaw, authOptions: { timestamp: signedTimestamp } });
  if (validCreate.status !== 201 || Number(validCreate.body?.post_id) <= 0) {
    const logTail = compose(['logs', '--no-color', '--tail', '30', 'wordpress'], { label: 'HMAC diagnostic log capture', allowFailure: true }).stdout.trim();
    throw new Error(`Valid HMAC bridge create returned HTTP ${validCreate.status}.${logTail ? ` WordPress log tail: ${redact(logTail)}` : ''}`);
  }
  const mappedPostId = Number(validCreate.body.post_id);
  const validGet = await signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`);
  const durableHmacPost = postInfo(mappedPostId);
  const durableHmacCategories = postCategoryIds(mappedPostId);
  const durableMapping = reconciliationInfo(draftKey);
  const expectedPayloadHash = createHash('sha256').update(JSON.stringify({
    contract_version: 1,
    title: draftPayload.title,
    content: draftPayload.content,
    excerpt: draftPayload.excerpt,
    categories: [...draftPayload.categories].sort((a, b) => a - b),
  })).digest('hex');
  assert(
    validGet.status === 200
      && Number(validGet.body?.post_id) === mappedPostId
      && validGet.body?.status === 'draft'
      && postCountByTitle(draftPayload.title) === 1
      && durableHmacPost?.type === 'post'
      && durableHmacPost.status === 'draft'
      && durableHmacPost.author === serviceId
      && durableHmacPost.title === draftPayload.title
      && durableHmacPost.content === draftPayload.content
      && JSON.stringify(durableHmacCategories) === JSON.stringify(draftPayload.categories)
      && durableMapping.count === 1
      && durableMapping.row?.draftKey === draftKey
      && durableMapping.row.postId === mappedPostId
      && durableMapping.row.payloadHash === expectedPayloadHash
      && durableMapping.row.actorUserId === serviceId
      && durableMapping.row.reservationToken === null,
    'Valid signed bridge creation did not satisfy the durable post/reconciliation contract.',
  );
  pass('valid_hmac_bridge_create_and_get', {
    create_http: validCreate.status, get_http: validGet.status, post_id: mappedPostId, status: validGet.body.status,
    author: durableHmacPost.author, categories: durableHmacCategories, mapping_count: durableMapping.count,
    payload_hash_verified: true, reservation_token: null,
  });

  const concreteGetRoute = `/newsroom/v1/drafts/${draftKey}`;
  const getContractStateBefore = {
    post: postInfo(mappedPostId),
    mapping: reconciliationInfo(draftKey),
    matchingPosts: postCountByTitle(draftPayload.title),
  };
  const signedGetBody = '{"unexpected":"body"}';
  const getWithBody = await rawHttpRequest(
    'GET',
    `/wp-json${concreteGetRoute}`,
    hmacHeaderPairs('GET', concreteGetRoute, signedGetBody),
    signedGetBody,
  );
  const getWithContentType = await rawHttpRequest(
    'GET',
    `/wp-json${concreteGetRoute}`,
    [...hmacHeaderPairs('GET', concreteGetRoute, ''), ['content-type', 'application/json']],
  );
  const getWithBodyAndContentType = await rawHttpRequest(
    'GET',
    `/wp-json${concreteGetRoute}`,
    [...hmacHeaderPairs('GET', concreteGetRoute, signedGetBody), ['content-type', 'application/json']],
    signedGetBody,
  );
  for (const [label, response] of Object.entries({ getWithBody, getWithContentType, getWithBodyAndContentType })) {
    expectAuthenticationFailure(response, label);
  }
  const getContractStateAfter = {
    post: postInfo(mappedPostId),
    mapping: reconciliationInfo(draftKey),
    matchingPosts: postCountByTitle(draftPayload.title),
  };
  assert(
    JSON.stringify(getContractStateAfter) === JSON.stringify(getContractStateBefore),
    'Rejected GET body or Content-Type variant changed durable post/reconciliation state.',
  );
  pass('get_zero_body_and_content_type_contract', {
    zero_body_no_content_type: validGet.status,
    nonempty_body: getWithBody.status,
    content_type: getWithContentType.status,
    body_and_content_type: getWithBodyAndContentType.status,
    durable_state_unchanged: true,
  });

  const charsetDraft = {
    ...draftPayload,
    draft_key: randomUUID(),
    title: `JSON Charset ${randomUUID().slice(0, 8)}`,
    content: 'Case-insensitive UTF-8 Content-Type proof.',
  };
  const charsetRaw = JSON.stringify(charsetDraft);
  const charsetCreate = await signedRequest('POST', '/newsroom/v1/drafts', {
    rawBody: charsetRaw,
    headers: { 'content-type': 'Application/JSON; Charset=UTF-8' },
  });
  assert(
    charsetCreate.status === 201
      && postInfo(Number(charsetCreate.body?.post_id))?.status === 'draft'
      && postCountByTitle(charsetDraft.title) === 1,
    'Approved application/json charset form did not create a durable draft.',
  );

  const contentTypeCases = [
    ['missing', null],
    ['text_plain', 'text/plain'],
    ['form', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=newsroom-proof'],
    ['malformed', 'application/json; charset'],
    ['unsupported_charset', 'application/json; charset=iso-8859-1'],
    ['comma_joined', 'application/json, application/json'],
  ];
  const contentTypeResults = { application_json: validCreate.status, application_json_utf8: charsetCreate.status };
  for (const [name, contentType] of contentTypeCases) {
    const payload = {
      ...draftPayload,
      draft_key: randomUUID(),
      title: `Content Type ${name} ${randomUUID().slice(0, 8)}`,
    };
    const raw = JSON.stringify(payload);
    const headers = hmacHeaders('POST', '/newsroom/v1/drafts', raw);
    const response = contentType === null
      ? await request('POST', '/wp-json/newsroom/v1/drafts', { body: Buffer.from(raw), headers })
      : await request('POST', '/wp-json/newsroom/v1/drafts', { body: raw, headers: { ...headers, 'content-type': contentType } });
    assert(response.status === 401 && postCountByTitle(payload.title) === 0 && reconciliationInfo(payload.draft_key).count === 0, `${name} Content-Type did not fail closed without state.`);
    contentTypeResults[name] = response.status;
  }
  pass('content_type_contract', contentTypeResults);

  const concreteRouteA = `/newsroom/v1/drafts/${draftKey}`;
  const concreteRouteB = `/newsroom/v1/drafts/${randomUUID()}`;
  const concreteKeyTamper = await signedRequest('GET', concreteRouteA, { sendRoute: concreteRouteB });
  assert(concreteKeyTamper.status === 401, 'Concrete reconciliation draft-key path was not bound to the signature.');

  const routeVariants = {
    trailing_slash: `${concreteRouteA}/`,
    duplicate_slash: `/newsroom//v1/drafts/${draftKey}`,
    multiple_leading_slash: `//newsroom/v1/drafts/${draftKey}`,
    case_variation: `/Newsroom/v1/drafts/${draftKey}`,
    percent_encoded: `/newsroom/v1/dr%61fts/${draftKey}`,
  };
  const routeVariantResults = { concrete_key_tamper: concreteKeyTamper.status };
  for (const [name, sendRoute] of Object.entries(routeVariants)) {
    const response = await signedRequest('GET', concreteRouteA, { sendRoute });
    assert([401, 404].includes(response.status), `${name} route representation did not fail closed: HTTP ${response.status}.`);
    routeVariantResults[name] = response.status;
  }
  const queryTamper = await signedRequest('GET', concreteRouteA, { sendRoute: `${concreteRouteA}?context=edit` });
  const queryRouting = await request('GET', `/?rest_route=${encodeURIComponent(concreteRouteA)}`, { headers: hmacHeaders('GET', concreteRouteA, '') });
  assert(queryTamper.status === 401 && queryRouting.status === 401, 'Unsigned query or query-based REST routing did not fail closed.');
  routeVariantResults.unsigned_query = queryTamper.status;
  routeVariantResults.rest_route_query = queryRouting.status;

  const overridePayload = {
    ...draftPayload,
    draft_key: randomUUID(),
    title: `Method Override ${randomUUID().slice(0, 8)}`,
  };
  const overrideRaw = JSON.stringify(overridePayload);
  const headerOverride = await signedRequest('POST', '/newsroom/v1/drafts', {
    rawBody: overrideRaw,
    headers: { 'x-http-method-override': 'DELETE' },
  });
  const queryOverride = await signedRequest('POST', '/newsroom/v1/drafts', {
    rawBody: overrideRaw,
    sendRoute: '/newsroom/v1/drafts?_method=DELETE',
  });
  const formOverrideBody = `_method=DELETE&draft_key=${encodeURIComponent(overridePayload.draft_key)}`;
  const formOverride = await request('POST', '/wp-json/newsroom/v1/drafts', {
    body: formOverrideBody,
    headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', formOverrideBody), 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert(
    headerOverride.status === 401
      && queryOverride.status === 401
      && formOverride.status === 401
      && postCountByTitle(overridePayload.title) === 0
      && reconciliationInfo(overridePayload.draft_key).count === 0,
    'A WordPress method override bypassed the HMAC method contract or created state.',
  );
  pass('route_query_and_method_override_contract', {
    ...routeVariantResults,
    x_http_method_override: headerOverride.status,
    query_method_override: queryOverride.status,
    form_method_override: formOverride.status,
  });

  const duplicateHeaderResults = {};
  for (const duplicateName of ['x-newsroom-auth-version', 'x-newsroom-key-id', 'x-newsroom-timestamp', 'x-newsroom-signature']) {
    const pairs = [];
    for (const pair of hmacHeaderPairs('GET', concreteRouteA, '')) {
      pairs.push(pair);
      if (pair[0] === duplicateName) pairs.push(pair);
    }
    const response = await rawHttpRequest('GET', `/wp-json${concreteRouteA}`, pairs);
    assert([200, 401].includes(response.status), `Duplicate ${duplicateName} produced an unexpected HTTP ${response.status}.`);
    duplicateHeaderResults[duplicateName] = response.status === 401 ? 'visible_and_rejected' : 'collapsed_before_php_ingress_required';
  }
  const visibleAmbiguity = await request('GET', `/wp-json${concreteRouteA}`, {
    headers: { ...hmacHeaders('GET', concreteRouteA, ''), 'x-newsroom-key-id': `${draftHmacKeyId},other` },
  });
  assert(visibleAmbiguity.status === 401, 'Comma-joined authentication header ambiguity was not rejected.');
  pass('duplicate_header_stack_characterization', {
    ...duplicateHeaderResults,
    comma_joined_ambiguity: visibleAmbiguity.status,
    production_ingress_rejection_required: true,
  });

  const noncanonicalSecret = noncanonicalBase64url(draftHmacSecret);
  assert(keyRingIsValid([{ id: draftHmacKeyId, secret: draftHmacSecret }]), 'Canonical valid HMAC key ring was rejected.');
  assert(!keyRingIsValid([]), 'Empty HMAC key ring was accepted.');
  assert(!keyRingIsValid([{ id: draftHmacKeyId, secret: 'not-base64url' }]), 'Malformed base64url HMAC secret was accepted.');
  assert(!keyRingIsValid([{ id: draftHmacKeyId, secret: randomBytes(31).toString('base64url') }]), 'Wrong-length HMAC secret was accepted.');
  assert(!keyRingIsValid([{ id: draftHmacKeyId, secret: noncanonicalSecret }]), 'Noncanonical base64url HMAC secret was accepted.');
  assert(!keyRingIsValid([{ id: draftHmacKeyId, secret: draftHmacSecret }, { id: draftHmacKeyId, secret: randomBytes(32).toString('base64url') }]), 'Duplicate HMAC key ID was accepted.');
  assert(!keyRingIsValid([{ id: draftHmacKeyId, secret: draftHmacSecret }, { id: 'second-key', secret: 'malformed' }]), 'Malformed second HMAC key-ring entry was accepted.');
  pass('canonical_key_ring_contract', {
    canonical_valid: true, empty_rejected: true, malformed_base64url_rejected: true,
    wrong_length_rejected: true, noncanonical_rejected: true, duplicate_id_rejected: true,
    malformed_second_entry_rejected: true,
  });

  const pastBoundaryNow = await alignToFreshSecond();
  const pastBoundary = await signedRequest('GET', concreteRouteA, { authOptions: { timestamp: pastBoundaryNow - 300 } });
  const pastExpiredNow = await alignToFreshSecond();
  const pastExpired = await signedRequest('GET', concreteRouteA, { authOptions: { timestamp: pastExpiredNow - 301 } });
  const futureBoundaryNow = await alignToFreshSecond();
  const futureBoundary = await signedRequest('GET', concreteRouteA, { authOptions: { timestamp: futureBoundaryNow + 300 } });
  const futureExpiredNow = await alignToFreshSecond();
  const futureExpired = await signedRequest('GET', concreteRouteA, { authOptions: { timestamp: futureExpiredNow + 301 } });
  assert(pastBoundary.status === 200 && pastExpired.status === 401 && futureBoundary.status === 200 && futureExpired.status === 401, 'Inclusive ±300-second timestamp boundary contract failed.');
  const malformedTimestamps = {
    negative: '-1',
    decimal: `${Math.floor(Date.now() / 1000)}.0`,
    scientific: '1e10',
    oversized: '999999999999999999999999999999999999',
  };
  const malformedTimestampResults = {};
  for (const [name, timestamp] of Object.entries(malformedTimestamps)) {
    const response = await signedRequest('GET', concreteRouteA, { authOptions: { timestamp } });
    assert(response.status === 401, `${name} timestamp was not rejected.`);
    malformedTimestampResults[name] = response.status;
  }
  pass('timestamp_boundaries_and_formats', {
    past_300: pastBoundary.status, past_301: pastExpired.status,
    future_300: futureBoundary.status, future_301: futureExpired.status,
    ...malformedTimestampResults,
  });

  const noAuthPayload = { ...draftPayload, draft_key: randomUUID(), title: `No HMAC ${randomUUID().slice(0, 8)}` };
  const noAuth = await request('POST', '/wp-json/newsroom/v1/drafts', { payload: noAuthPayload });
  const wrongSecretPayload = { ...draftPayload, draft_key: randomUUID(), title: `Wrong Secret ${randomUUID().slice(0, 8)}` };
  const wrongSecret = await signedRequest('POST', '/newsroom/v1/drafts', { payload: wrongSecretPayload, authOptions: { secret: randomBytes(32).toString('base64url') } });
  const bodyA = JSON.stringify({ ...draftPayload, draft_key: randomUUID(), title: `Body A ${randomUUID().slice(0, 8)}` });
  const bodyBPayload = { ...draftPayload, draft_key: randomUUID(), title: `Body B ${randomUUID().slice(0, 8)}` };
  const bodyB = JSON.stringify(bodyBPayload);
  const bodyTamper = await request('POST', '/wp-json/newsroom/v1/drafts', { body: bodyB, headers: { 'content-type': 'application/json', ...hmacHeaders('POST', '/newsroom/v1/drafts', bodyA) } });
  const methodTamperBody = JSON.stringify({ ...draftPayload, draft_key: randomUUID(), title: `Method Tamper ${randomUUID().slice(0, 8)}` });
  const methodTamper = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: methodTamperBody, sendMethod: 'GET' });
  const routeTamperPayload = { title: `Route Tamper ${randomUUID().slice(0, 8)}`, content: 'Must not create.', status: 'draft' };
  const routeTamperRaw = JSON.stringify(routeTamperPayload);
  const routeTamper = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: routeTamperRaw, sendRoute: '/wp/v2/posts' });
  const expiredPayload = { ...draftPayload, draft_key: randomUUID(), title: `Expired ${randomUUID().slice(0, 8)}` };
  const expired = await signedRequest('POST', '/newsroom/v1/drafts', { payload: expiredPayload, authOptions: { timestamp: Math.floor(Date.now() / 1000) - 301 } });
  const malformedTimestampPayload = { ...draftPayload, draft_key: randomUUID(), title: `Malformed Time ${randomUUID().slice(0, 8)}` };
  const malformedTimestampRaw = JSON.stringify(malformedTimestampPayload);
  const malformedTimestamp = await request('POST', '/wp-json/newsroom/v1/drafts', { body: malformedTimestampRaw, headers: { 'content-type': 'application/json', ...hmacHeaders('POST', '/newsroom/v1/drafts', malformedTimestampRaw), 'x-newsroom-timestamp': 'not-a-timestamp' } });
  const unknownKeyPayload = { ...draftPayload, draft_key: randomUUID(), title: `Unknown Key ${randomUUID().slice(0, 8)}` };
  const unknownKey = await signedRequest('POST', '/newsroom/v1/drafts', { payload: unknownKeyPayload, authOptions: { keyId: 'unknown-local-key' } });
  const malformedSignaturePayload = { ...draftPayload, draft_key: randomUUID(), title: `Malformed Signature ${randomUUID().slice(0, 8)}` };
  const malformedSignature = await signedRequest('POST', '/newsroom/v1/drafts', { payload: malformedSignaturePayload, authOptions: { signature: 'not-a-signature' } });
  for (const [label, response] of Object.entries({ noAuth, wrongSecret, bodyTamper, methodTamper, routeTamper, expired, malformedTimestamp, unknownKey, malformedSignature })) {
    expectAuthenticationFailure(response, label);
  }
  assert(postCountByTitle(bodyBPayload.title) === 0 && postCountByTitle(routeTamperPayload.title) === 0, 'A tampered HMAC request created a post.');
  pass('invalid_and_tampered_hmac_matrix', {
    no_auth: noAuth.status, wrong_secret: wrongSecret.status, body_tamper: bodyTamper.status,
    method_tamper: methodTamper.status, route_tamper: routeTamper.status, expired_timestamp: expired.status,
    malformed_timestamp: malformedTimestamp.status, unknown_key: unknownKey.status, malformed_signature: malformedSignature.status,
  });

  const replay = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: draftRaw, authOptions: { timestamp: signedTimestamp } });
  assert(replay.status === 200 && replay.body?.replayed === true && Number(replay.body?.post_id) === mappedPostId && postCountByTitle(draftPayload.title) === 1, 'Signed replay did not resolve through durable draft idempotency.');
  const expiredReplay = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: draftRaw, authOptions: { timestamp: Math.floor(Date.now() / 1000) - 301 } });
  expectAuthenticationFailure(expiredReplay, 'Expired signed replay');
  assert(postCountByTitle(draftPayload.title) === 1, 'Expired signed replay changed durable post count.');
  pass('signed_replay_and_expiry', { in_window_http: replay.status, replayed: true, expired_http: expiredReplay.status, durable_posts: 1 });

  const coreDraftTitle = `HMAC Core Draft ${randomUUID().slice(0, 8)}`;
  const coreDraftBody = JSON.stringify({ title: coreDraftTitle, content: 'Must not create.', status: 'draft' });
  const hmacCoreDraft = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: coreDraftBody, sendRoute: '/wp/v2/posts' });
  const corePublishTitle = `HMAC Core Publish ${randomUUID().slice(0, 8)}`;
  const corePublishBody = JSON.stringify({ title: corePublishTitle, content: 'Must not publish.', status: 'publish' });
  const hmacCorePublish = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: corePublishBody, sendRoute: '/wp/v2/posts' });
  expectAuthenticationFailure(hmacCoreDraft, 'HMAC core draft bypass');
  expectAuthenticationFailure(hmacCorePublish, 'HMAC core publish bypass');
  expectNoWordPressAuthenticationArtifact(hmacCoreDraft, 'HMAC core draft bypass');
  expectNoWordPressAuthenticationArtifact(hmacCorePublish, 'HMAC core publish bypass');
  assert(postCountByTitle(coreDraftTitle) === 0 && postCountByTitle(corePublishTitle) === 0, 'HMAC headers created a core post.');

  const seedId = Number(wp(['post', 'create', '--post_type=post', '--post_status=draft', '--post_title=HMAC Bypass Seed', `--post_author=${serviceId}`, '--porcelain']));
  const seedBefore = postInfo(seedId);
  const seedRevisionCountBefore = revisionCount(seedId);
  const attachmentCountBeforeBypass = attachmentCount();
  const updateBody = JSON.stringify({ title: 'HMAC Bypass Seed Changed' });
  const hmacUpdate = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: updateBody, sendRoute: `/wp/v2/posts/${seedId}` });
  const hmacDelete = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: '', sendMethod: 'DELETE', sendRoute: `/wp/v2/posts/${seedId}?force=true` });
  const autosaveBody = JSON.stringify({ content: 'Must not autosave.' });
  const hmacAutosave = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: autosaveBody, sendRoute: `/wp/v2/posts/${seedId}/autosaves` });
  const hmacMedia = await request('POST', '/wp-json/wp/v2/media', {
    body: gif,
    headers: { 'content-type': 'image/gif', 'content-disposition': 'attachment; filename=hmac-bypass.gif', ...hmacHeaders('POST', '/newsroom/v1/drafts', gif) },
  });
  const credentialBody = JSON.stringify({ name: 'hmac-credential-bypass' });
  const hmacCredentialCreate = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: credentialBody, sendRoute: `/wp/v2/users/${serviceId}/application-passwords` });
  for (const [label, response] of Object.entries({ hmacUpdate, hmacDelete, hmacAutosave, hmacMedia, hmacCredentialCreate })) {
    expectAuthenticationFailure(response, label);
    expectNoWordPressAuthenticationArtifact(response, label);
  }
  const seedAfter = postInfo(seedId);
  assert(seedAfter?.id === seedBefore?.id && seedAfter?.title === seedBefore?.title && seedAfter?.status === seedBefore?.status, 'HMAC core update/delete attempt changed the seeded post.');
  assert(revisionCount(seedId) === seedRevisionCountBefore, 'HMAC core autosave denial created a durable revision/autosave.');
  assert(attachmentCount() === attachmentCountBeforeBypass, 'HMAC core media denial created a durable attachment.');
  const applicationPasswordsAfterBypass = Number(wp(['user', 'application-password', 'list', String(serviceId), '--format=count']));
  assert(applicationPasswordsAfterBypass === 0, 'HMAC credential-management bypass created a service-user Application Password.');

  const batchBypassTitle = `HMAC Batch Outer ${randomUUID().slice(0, 8)}`;
  const batchBypassDraftKey = randomUUID();
  const batchBypassBody = JSON.stringify({ requests: [{ method: 'POST', path: '/wp/v2/posts', body: { draft_key: batchBypassDraftKey, title: batchBypassTitle, status: 'draft' } }] });
  const batchOuterHmac = await signedRequest('POST', '/newsroom/v1/drafts', { rawBody: batchBypassBody, sendRoute: '/batch/v1' });
  expectAuthenticationFailure(batchOuterHmac, 'HMAC outer batch bypass');
  expectNoWordPressAuthenticationArtifact(batchOuterHmac, 'HMAC outer batch bypass');
  const innerTitle = `HMAC Batch Inner ${randomUUID().slice(0, 8)}`;
  const innerDraftKey = randomUUID();
  const innerBody = { draft_key: innerDraftKey, title: innerTitle, content: 'Inner batch HMAC must be ignored.', status: 'draft' };
  const innerRaw = JSON.stringify(innerBody);
  const batchInnerHmac = await request('POST', '/wp-json/batch/v1', {
    payload: { requests: [{ method: 'POST', path: '/wp/v2/posts', headers: hmacHeaders('POST', '/newsroom/v1/drafts', innerRaw), body: innerBody }] },
  });
  const innerResponse = batchInnerHmac.body?.responses?.[0];
  const innerStatus = innerResponse?.status;
  const innerCode = innerResponse?.body?.code;
  assert(
    batchInnerHmac.status === 207
      && innerResponse && typeof innerResponse === 'object'
      && Number.isInteger(innerStatus)
      && innerStatus === 401
      && innerCode === 'rest_cannot_create'
      && postCountByTitle(batchBypassTitle) === 0
      && postCountByTitle(innerTitle) === 0
      && reconciliationInfo(batchBypassDraftKey).count === 0
      && reconciliationInfo(innerDraftKey).count === 0,
    'Outer or embedded batch HMAC established a WordPress user or created a post.',
  );
  wp(['post', 'delete', String(seedId), '--force'], { label: 'Core bypass seed cleanup' });
  pass('hmac_core_rest_and_batch_bypass_denied', {
    core_draft: hmacCoreDraft.status, core_publish: hmacCorePublish.status, update: hmacUpdate.status,
    delete: hmacDelete.status, autosave: hmacAutosave.status, media: hmacMedia.status, credential_create: hmacCredentialCreate.status,
    outer_batch: batchOuterHmac.status, inner_batch_outer: batchInnerHmac.status, inner_request: innerStatus, inner_code: innerCode,
    created_posts: 0, created_application_passwords: applicationPasswordsAfterBypass,
  });

  wp(['user', 'add-cap', String(serviceId), 'manage_options'], { label: 'Dangerous capability drift injection' });
  const driftedCapabilities = capabilitySnapshot(serviceId);
  assert(driftedCapabilities.manage_options === true, 'Dangerous capability drift fixture was not established.');
  const capabilityDriftRequest = await signedRequest('GET', concreteRouteA);
  assert(capabilityDriftRequest.status === 401, 'HMAC authentication did not fail closed for dangerous capability drift.');
  wp(['user', 'remove-cap', String(serviceId), 'manage_options'], { label: 'Dangerous capability drift restoration' });
  const restoredCapabilities = capabilitySnapshot(serviceId);
  assertServiceCapabilityPolicy(restoredCapabilities, 'Restored draft service user');
  const capabilityRestoredRequest = await signedRequest('GET', concreteRouteA);
  assert(capabilityRestoredRequest.status === 200, 'HMAC authentication did not recover after capability drift restoration.');
  pass('dangerous_capability_drift_fails_closed', {
    injected_capability: 'manage_options', drift_http: capabilityDriftRequest.status,
    restored_http: capabilityRestoredRequest.status, restored_policy_exact: true,
  });

  const hmacAsPassword = await xmlrpc('wp.getUsersBlogs', ['runtime_service', runtimeEnv.NEWSROOM_HMAC_DRAFT_SECRET], hmacHeaders('POST', '/newsroom/v1/drafts', ''));
  const hmacXmlCreateTitle = `HMAC XMLRPC ${randomUUID().slice(0, 8)}`;
  const hmacXmlCreate = await xmlrpc('wp.newPost', [0, 'runtime_service', runtimeEnv.NEWSROOM_HMAC_DRAFT_SECRET, { post_type: 'post', post_status: 'publish', post_title: hmacXmlCreateTitle }], hmacHeaders('POST', '/newsroom/v1/drafts', ''));
  assert(hmacAsPassword.fault && hmacXmlCreate.fault && postCountByTitle(hmacXmlCreateTitle) === 0, 'HMAC credential authenticated to XML-RPC or created a post.');
  pass('xmlrpc_backend_credentials_denied', {
    ordinary_service_password: 'denied', legacy_application_password: 'denied', hmac_secret: 'denied', hmac_post_create_publish: 'denied',
  });

  const restRoot = await request('GET', '/wp-json/');
  assert(restRoot.status === 200, 'Global REST API was disabled by the shim.');
  const adminTitle = `Admin Nonregression ${randomUUID().slice(0, 8)}`;
  const adminCreate = await request('POST', '/wp-json/wp/v2/posts', { auth: adminAuth, payload: { title: adminTitle, content: 'Administrator remains normal.', status: 'draft' } });
  assert(adminCreate.status === 201, 'Administrator core REST behavior regressed.');
  const unrelatedTitle = `Author Nonregression ${randomUUID().slice(0, 8)}`;
  const unrelatedCreate = await request('POST', '/wp-json/wp/v2/posts', { auth: unrelatedAuth, payload: { title: unrelatedTitle, content: 'Unrelated Author remains normal.', status: 'draft' } });
  assert(unrelatedCreate.status === 201, 'Unrelated Author core REST behavior regressed.');
  const unrelatedXml = await xmlrpc('wp.getUsersBlogs', ['runtime_unrelated', unrelatedAppPassword]);
  assert(!unrelatedXml.fault, 'Global XML-RPC or unrelated-user Application Password behavior regressed.');
  const unrelatedLogin = await passwordLogin('runtime_unrelated', runtimeEnv.RUNTIME_UNRELATED_PASSWORD);
  assert(unrelatedLogin.status === 302 && unrelatedLogin.hasAuthCookie, 'Unrelated Author interactive login behavior regressed.');
  wp(['post', 'delete', String(adminCreate.body.id), '--force'], { label: 'Administrator non-regression cleanup' });
  wp(['post', 'delete', String(unrelatedCreate.body.id), '--force'], { label: 'Author non-regression cleanup' });
  pass('ordinary_user_non_regression', {
    global_rest: restRoot.status, administrator_core_create: adminCreate.status, unrelated_author_core_create: unrelatedCreate.status,
    unrelated_xmlrpc_application_password: 'allowed', unrelated_password_login: 'allowed', identity_scoping_proven_end_to_end: true,
  });

  const finalServiceCaps = capabilitySnapshot(serviceId);
  assertServiceCapabilityPolicy(finalServiceCaps, 'Final draft service user');
  const finalServiceApplicationPasswords = Number(wp(['user', 'application-password', 'list', String(serviceId), '--format=count']));
  assert(finalServiceApplicationPasswords === 0, 'Final draft service user retained an Application Password.');
  pass('final_service_user_model', { capabilities: finalServiceCaps, application_passwords: finalServiceApplicationPasswords, password_login: 'denied', namespace_scope: ['POST /newsroom/v1/drafts', 'GET /newsroom/v1/drafts/{draft_key}'] });
  const completedGroups = evidence.results.filter((result) => result.status === 'PASS').map((result) => result.name);
  assert(JSON.stringify(completedGroups) === JSON.stringify(expectedEvidenceGroups), 'The complete ordered evidence-group matrix did not execute.');
} catch (error) {
  fatalError = redact(error?.stack || error?.message || error);
  evidence.results.push({ name: 'fatal', status: 'FAIL', details: { error: fatalError } });
  process.stderr.write(`FAIL ${redact(error?.message || error)}\n`);
} finally {
  try {
    evidence.hashes_after = bridgeHashes();
    evidence.source_hashes_unchanged = JSON.stringify(evidence.hashes_before) === JSON.stringify(evidence.hashes_after);
  } catch (hashError) {
    const message = redact(hashError?.message || hashError);
    evidence.source_hashes_unchanged = false;
    evidence.results.push({ name: 'source_integrity_finalization', status: 'FAIL', details: { error: message } });
    if (!fatalError) fatalError = message;
  }

  const cleanupFailures = [];
  let composeDownResult = null;
  let containerQueryResult = null;
  let volumeQueryResult = null;
  let containersRemaining = null;
  let volumesRemaining = null;
  const composeCleanupRequired = envCreated || existsSync(envFile);

  try {
    if (composeCleanupRequired) {
      composeDownResult = compose(['down', '-v', '--remove-orphans'], { label: 'Trust-boundary runtime cleanup', allowFailure: true });
      successfulCommandOutput(composeDownResult, 'Trust-boundary runtime cleanup');
    }
  } catch (cleanupError) {
    cleanupFailures.push(`compose_down: ${redact(cleanupError?.message || cleanupError)}`);
  }

  try {
    containerQueryResult = run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.ID}}'], { label: 'Container cleanup verification', allowFailure: true });
    const containerOutput = successfulCommandOutput(containerQueryResult, 'Container cleanup verification');
    containersRemaining = containerOutput ? containerOutput.split('\n') : [];
  } catch (containerError) {
    cleanupFailures.push(`container_query: ${redact(containerError?.message || containerError)}`);
  }

  try {
    volumeQueryResult = run('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${projectName}`, '--format', '{{.Name}}'], { label: 'Volume cleanup verification', allowFailure: true });
    const volumeOutput = successfulCommandOutput(volumeQueryResult, 'Volume cleanup verification');
    volumesRemaining = volumeOutput ? volumeOutput.split('\n') : [];
  } catch (volumeError) {
    cleanupFailures.push(`volume_query: ${redact(volumeError?.message || volumeError)}`);
  }

  try {
    if (envCreated || existsSync(envFile)) rmSync(envFile, { force: true });
  } catch (envCleanupError) {
    cleanupFailures.push(`env_cleanup: ${redact(envCleanupError?.message || envCleanupError)}`);
  }

  const envRuntimeAbsent = !existsSync(envFile);
  if (!envRuntimeAbsent) cleanupFailures.push('env_cleanup: .env.runtime remains present.');
  evidence.cleanup = {
    compose_down: {
      status: composeDownResult?.status ?? (composeCleanupRequired ? null : 0),
      result: composeDownResult?.status === 0 || !composeCleanupRequired ? 'PASS' : 'FAIL',
      not_required: !composeCleanupRequired,
    },
    container_query: { status: containerQueryResult?.status ?? null, result: containerQueryResult?.status === 0 ? 'PASS' : 'FAIL' },
    containers_remaining: containersRemaining,
    volume_query: { status: volumeQueryResult?.status ?? null, result: volumeQueryResult?.status === 0 ? 'PASS' : 'FAIL' },
    volumes_remaining: volumesRemaining,
    env_runtime_absent: envRuntimeAbsent,
    failures: cleanupFailures,
  };
  evidence.finished_at = new Date().toISOString();
  writeFileSync(resultsFile, JSON.stringify(evidence, null, 2) + '\n');
}

const cleanupSucceeded = evidence.cleanup.compose_down.result === 'PASS'
  && evidence.cleanup.container_query.result === 'PASS'
  && Array.isArray(evidence.cleanup.containers_remaining)
  && evidence.cleanup.containers_remaining.length === 0
  && evidence.cleanup.volume_query.result === 'PASS'
  && Array.isArray(evidence.cleanup.volumes_remaining)
  && evidence.cleanup.volumes_remaining.length === 0
  && evidence.cleanup.env_runtime_absent === true
  && evidence.cleanup.failures.length === 0;

if (fatalError || !evidence.source_hashes_unchanged || !cleanupSucceeded) {
  process.exitCode = 1;
} else {
  process.stdout.write(`PASS trust-boundary suite (${evidence.results.filter((result) => result.status === 'PASS').length} checks)\n`);
}
