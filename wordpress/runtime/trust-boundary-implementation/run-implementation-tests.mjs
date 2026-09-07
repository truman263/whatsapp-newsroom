import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
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
const projectName = 'newsroom-trust-boundary-implementation';
const repositoryScanCandidates = [
  'docs/DEVELOPMENT_ROADMAP.md',
  'docs/WORDPRESS_CONTRACT.md',
  'docs/WORDPRESS_TRUST_BOUNDARY_DESIGN.md',
  'docs/WORDPRESS_TRUST_BOUNDARY_IMPLEMENTATION.md',
  'wordpress/newsroom-bridge/README.md',
  'wordpress/newsroom-bridge/newsroom-bridge.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-auth.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-db.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-key-ring-json.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-reconciliation.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-rest.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-security-config.php',
  'wordpress/newsroom-bridge/includes/class-newsroom-bridge-service-user.php',
  'wordpress/runtime/trust-boundary-implementation/.gitignore',
  'wordpress/runtime/trust-boundary-implementation/README.md',
  'wordpress/runtime/trust-boundary-implementation/compose.yaml',
  'wordpress/runtime/trust-boundary-implementation/run-implementation-tests.mjs',
  'wordpress/runtime/trust-boundary-implementation/test-probe/database-audit.php',
  'wordpress/runtime/trust-boundary-implementation/test-probe/durable-state.php',
  'wordpress/runtime/trust-boundary-implementation/test-probe/execution-tests.php',
  'wordpress/runtime/trust-boundary-implementation/test-probe/newsroom-trust-boundary-implementation-probe.php',
];
const frozenHashes = {
  'includes/class-newsroom-bridge-db.php': '1362cb101031088b78e27d54b78edfac6488d9f979979a3786916839811a20fa',
  'includes/class-newsroom-bridge-reconciliation.php': '6a7ce8aec4ab3040804c217f00341275ead25ea78570fc4cc93f47cde03a373a',
  'includes/class-newsroom-bridge-rest.php': '965608c6063540985d23f9a83a679c49eee1543238c595a850100755f9cf609a',
};
const requiredCapabilities = ['read', 'edit_posts'];
const forbiddenCapabilities = [
  'publish_posts', 'edit_others_posts', 'edit_published_posts', 'edit_private_posts', 'delete_posts',
  'delete_published_posts', 'delete_others_posts', 'delete_private_posts', 'upload_files', 'manage_categories',
  'manage_options', 'edit_users', 'create_users', 'delete_users', 'promote_users', 'list_users',
  'activate_plugins', 'install_plugins', 'update_plugins', 'delete_plugins', 'edit_plugins', 'switch_themes',
  'edit_themes', 'install_themes', 'update_themes', 'delete_themes', 'edit_files', 'unfiltered_html',
  'manage_network', 'manage_network_users', 'manage_network_plugins', 'manage_network_themes',
  'manage_network_options', 'setup_network',
];

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
function exactStatuses(responses, expected) {
  return responses.length === Object.values(expected).reduce((sum, count) => sum + count, 0)
    && responses.every((response) => Object.hasOwn(expected, response.status))
    && Object.entries(expected).every(([status, count]) => responses.filter((response) => response.status === Number(status)).length === count);
}
function pass(name, details = {}) { evidence.results.push({ name, status: 'PASS', details }); process.stdout.write(`PASS ${name}\n`); }
function randomSecret(bytes = 30) { return randomBytes(bytes).toString('base64url'); }
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
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
        resolveRequest({ status: response.statusCode ?? 0, body: parsed, headers: response.headers, rawHeaders: response.rawHeaders });
      });
    });
    outgoing.setTimeout(60000, () => outgoing.destroy(new Error('request timeout')));
    outgoing.on('error', rejectRequest);
    if (payload.length > 0) outgoing.write(payload);
    outgoing.end();
  });
}

function basic(username, password) { return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`; }
function hmacHeaders(method, route, body = '', { keyId = runtimeEnv.HMAC_KEY_ID, secret = runtimeEnv.HMAC_SECRET, timestamp = Math.floor(Date.now() / 1000), signature } = {}) {
  const canonical = ['newsroom-hmac-v1', keyId, method.toUpperCase(), route, String(timestamp), createHash('sha256').update(body).digest('hex')].join('\n');
  return {
    'X-Newsroom-Auth-Version': '1', 'X-Newsroom-Key-Id': keyId, 'X-Newsroom-Timestamp': String(timestamp),
    'X-Newsroom-Signature': signature ?? createHmac('sha256', Buffer.from(secret, 'base64url')).update(canonical).digest('hex'),
  };
}
function signedRequest(method, route, { body = '', headers = {}, auth = {} } = {}) {
  return request(method, `/wp-json${route}`, { body, headers: { ...hmacHeaders(method, route, body, auth), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers } });
}

function xmlEscape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function xmlValue(value) {
  if (typeof value === 'number') return `<int>${value}</int>`;
  if (typeof value === 'boolean') return `<boolean>${value ? 1 : 0}</boolean>`;
  if (Array.isArray(value)) return `<array><data>${value.map((item) => `<value>${xmlValue(item)}</value>`).join('')}</data></array>`;
  if (value && typeof value === 'object') return `<struct>${Object.entries(value).map(([key, item]) => `<member><name>${xmlEscape(key)}</name><value>${xmlValue(item)}</value></member>`).join('')}</struct>`;
  return `<string>${xmlEscape(value)}</string>`;
}
async function xmlrpc(methodName, parameters) {
  const body = `<?xml version="1.0"?><methodCall><methodName>${methodName}</methodName><params>${parameters.map((item) => `<param><value>${xmlValue(item)}</value></param>`).join('')}</params></methodCall>`;
  const response = await request('POST', '/xmlrpc.php', { body, headers: { 'content-type': 'text/xml' } });
  return { ...response, fault: typeof response.body?.raw === 'string' && response.body.raw.includes('<fault>') };
}
async function passwordLogin(username, password) {
  const body = new URLSearchParams({ log: username, pwd: password, 'wp-submit': 'Log In', redirect_to: `${baseUrl}/wp-admin/` }).toString();
  const response = await request('POST', '/wp-login.php', { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const cookies = (response.headers['set-cookie'] ?? []).map((cookie) => cookie.split(';', 1)[0]);
  return { ...response, cookies, cookieHeader: cookies.join('; '), hasAuthCookie: cookies.some((cookie) => cookie.startsWith('wordpress_logged_in_')) };
}

function postInfo(id) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),ID,post_status,post_author,post_title,post_content) FROM wp_posts WHERE ID=${Number(id)} AND post_type='post'`);
  if (!row) return null;
  const [postId, status, author, title, content] = row.split(String.raw`\t`);
  return { id: Number(postId), status, author: Number(author), title, content };
}
function postCount(title) { return Number(db(`SELECT COUNT(*) FROM wp_posts WHERE post_type='post' AND post_title='${sqlEscape(title)}'`)); }
function attachmentCount() { return Number(db("SELECT COUNT(*) FROM wp_posts WHERE post_type='attachment'")); }
function revisionCount(id) { return Number(db(`SELECT COUNT(*) FROM wp_posts WHERE post_parent=${Number(id)} AND post_type='revision'`)); }
function applicationPasswordCount(id) { return Number(wp(['user', 'application-password', 'list', String(id), '--format=count'])); }
function mapping(key) {
  const row = db(`SELECT CONCAT_WS(CHAR(9),post_id,payload_hash,actor_user_id,IFNULL(reservation_token,'<NULL>')) FROM wp_newsroom_reconciliation WHERE draft_key='${sqlEscape(key)}'`);
  if (!row) return null;
  const [postId, payloadHash, actorId, token] = row.split(String.raw`\t`);
  return { postId: Number(postId), payloadHash, actorId: Number(actorId), token: token === '<NULL>' ? null : token };
}
function mappingCount(key) { return Number(db(`SELECT COUNT(*) FROM wp_newsroom_reconciliation WHERE draft_key='${sqlEscape(key)}'`)); }
function categories(id) { const output = wp(['post', 'term', 'list', String(id), 'category', '--field=term_id']); return output ? output.split(/\r?\n/).map(Number).sort((a, b) => a - b) : []; }
function expect401(response, label) { assert(response.status === 401 && response.body?.code === 'newsroom_hmac_authentication_failed', `${label} was not the generic exact 401 contract (HTTP ${response.status}).`); }
function durableState() {
  const value = wp(['eval-file', '/var/www/html/wp-content/plugins/newsroom-trust-boundary-implementation-probe/durable-state.php'], { label: 'durable state snapshot' });
  const parsed = JSON.parse(value);
  assert(parsed && typeof parsed === 'object', 'Durable state snapshot was missing.');
  return parsed;
}
async function durableNegative(name, operation) {
  const before = durableState();
  const response = await operation();
  expect401(response, name);
  const after = durableState();
  assert(JSON.stringify(after) === JSON.stringify(before), `${name} changed durable state.`);
  return response;
}

async function recreate(overrides = {}) {
  runtimeEnv = { ...runtimeEnv, ...overrides };
  writeRuntimeEnv();
  compose(['up', '-d', '--force-recreate', 'wordpress', 'cli'], { sensitive: true, label: 'configuration recreation' });
  await waitForHttp();
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
  port = await availablePort(18281);
  baseUrl = `http://127.0.0.1:${port}`;
  assertLoopback(baseUrl);
  runtimeEnv = {
    NEWSROOM_TEST_PORT: String(port), RUNTIME_DB_PASSWORD: randomSecret(), RUNTIME_DB_ROOT_PASSWORD: randomSecret(),
    ADMIN_PASSWORD: randomSecret(), SERVICE_PASSWORD: randomSecret(), UNRELATED_PASSWORD: randomSecret(),
    NEWSROOM_BRIDGE_USER_ID: '3', NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: '1', NEWSROOM_BRIDGE_HMAC_ENABLED: '1',
    NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED: '1', HMAC_KEY_ID: 'draft-local-v1', HMAC_SECRET: randomSecret(32),
  };
  runtimeEnv.NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON = JSON.stringify([{ id: runtimeEnv.HMAC_KEY_ID, secret: runtimeEnv.HMAC_SECRET }]);
  knownSecrets.push(...Object.values(runtimeEnv).filter((value) => !['3', '1', runtimeEnv.HMAC_KEY_ID, String(port)].includes(value)));
  writeRuntimeEnv();

  assert(JSON.stringify(protectedHashes()) === JSON.stringify(frozenHashes), 'Frozen reconciliation hashes differ before runtime.');
  compose(['up', '-d', 'db', 'wordpress', 'cli'], { sensitive: true, label: 'runtime startup' });
  await waitForHttp();
  wp(['core', 'install', `--url=${baseUrl}`, '--title=Newsroom Implementation Runtime', '--admin_user=runtime_admin', `--admin_password=${runtimeEnv.ADMIN_PASSWORD}`, '--admin_email=admin@example.invalid', '--skip-email'], { sensitive: true });
  wp(['rewrite', 'structure', '/%postname%/', '--hard']);
  wp(['user', 'create', 'runtime_unrelated', 'unrelated@example.invalid', '--role=author', `--user_pass=${runtimeEnv.UNRELATED_PASSWORD}`, '--porcelain'], { sensitive: true });
  wp(['eval', "add_role('newsroom_draft_service','Newsroom Draft Service',array('read'=>true,'edit_posts'=>true));"]);
  wp(['user', 'create', 'runtime_service', 'service@example.invalid', '--role=newsroom_draft_service', `--user_pass=${runtimeEnv.SERVICE_PASSWORD}`, '--porcelain'], { sensitive: true });
  const adminId = Number(wp(['user', 'get', 'runtime_admin', '--field=ID']));
  const unrelatedId = Number(wp(['user', 'get', 'runtime_unrelated', '--field=ID']));
  const serviceId = Number(wp(['user', 'get', 'runtime_service', '--field=ID']));
  assert(serviceId === 3, 'Fixture service-user ID does not match isolated configuration.');
  const categoryIds = ['A', 'B', 'C'].map((suffix) => Number(wp(['term', 'create', 'category', `Runtime Category ${suffix}`, `--slug=runtime-${suffix.toLowerCase()}`, '--porcelain'])));
  const adminApp = wp(['user', 'application-password', 'create', String(adminId), 'runtime-admin', '--porcelain'], { sensitive: true });
  const unrelatedApp = wp(['user', 'application-password', 'create', String(unrelatedId), 'runtime-unrelated', '--porcelain'], { sensitive: true });
  const serviceApp = wp(['user', 'application-password', 'create', String(serviceId), 'runtime-legacy-service', '--porcelain'], { sensitive: true });
  knownSecrets.push(adminApp, unrelatedApp, serviceApp);
  const adminAuth = basic('runtime_admin', adminApp);
  const unrelatedAuth = basic('runtime_unrelated', unrelatedApp);
  const serviceAuth = basic('runtime_service', serviceApp);
  knownSecrets.push(adminAuth, unrelatedAuth, serviceAuth);

  wp(['plugin', 'activate', 'newsroom-bridge', 'newsroom-trust-boundary-implementation-probe']);
  assert(wp(['plugin', 'get', 'newsroom-bridge', '--field=version']) === '1.1.0', 'Plugin version is not 1.1.0.');
  assert(wp(['option', 'get', 'newsroom_bridge_schema_version']) === '2', 'Reconciliation schema version changed.');
  const newsroomTables = db("SHOW TABLES LIKE 'wp_newsroom%'").split(/\r?\n/).filter(Boolean);
  assert(JSON.stringify(newsroomTables) === JSON.stringify(['wp_newsroom_reconciliation']), 'Unexpected newsroom database table exists.');
  pass('activation_and_schema', { plugin: '1.1.0', schema: '2', tables: newsroomTables.length });

  const caps = JSON.parse(wp(['eval', `$u=get_user_by('id',${serviceId});$n=json_decode(base64_decode('${Buffer.from(JSON.stringify([...requiredCapabilities, ...forbiddenCapabilities])).toString('base64')}'),true);$o=array();foreach($n as $c){$o[$c]=user_can($u,$c);}echo wp_json_encode($o);`]));
  assert(requiredCapabilities.every((cap) => caps[cap] === true) && forbiddenCapabilities.every((cap) => caps[cap] === false), 'Reduced service capability contract failed.');
  pass('service_capability_policy', { required: requiredCapabilities, forbidden_count: forbiddenCapabilities.length });

  const parserMatrix = wp(['eval', `$v=NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON;$a=json_decode($v,true);$s=$a[0]['secret'];$i=$a[0]['id'];$alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';$last=strpos($alphabet,substr($s,-1));$noncanonical=substr($s,0,-1).$alphabet[$last+1];$cases=array('valid'=>$v,'reordered'=>wp_json_encode(array(array('secret'=>$s,'id'=>$i))),'empty'=>'[]','json'=>'{','object'=>wp_json_encode(array('id'=>$i,'secret'=>$s)),'missing_id'=>wp_json_encode(array(array('secret'=>$s))),'missing_secret'=>wp_json_encode(array(array('id'=>$i))),'extra'=>wp_json_encode(array(array('id'=>$i,'secret'=>$s,'extra'=>true))),'bad_secret'=>wp_json_encode(array(array('id'=>$i,'secret'=>'bad'))),'wrong_length'=>wp_json_encode(array(array('id'=>$i,'secret'=>rtrim(strtr(base64_encode(str_repeat('x',31)),'+/','-_'),'=')))),'noncanonical'=>wp_json_encode(array(array('id'=>$i,'secret'=>$noncanonical))),'duplicate'=>wp_json_encode(array($a[0],$a[0])),'secondary'=>wp_json_encode(array($a[0],array('id'=>'secondary','secret'=>'bad'))));$o=array();foreach($cases as $k=>$j){$o[$k]=false!==Newsroom_Bridge_Security_Config::parse_key_ring_json($j);}echo wp_json_encode($o);`], { sensitive: true });
  const parsedMatrix = JSON.parse(parserMatrix);
  assert(parsedMatrix.valid === true && parsedMatrix.reordered === true && Object.entries(parsedMatrix).filter(([key]) => !['valid', 'reordered'].includes(key)).every(([, value]) => value === false), 'Complete-ring validation matrix failed.');
  pass('key_ring_validation', parsedMatrix);
  const strictParserMatrix = JSON.parse(wp(['eval', `$a=json_decode(NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON,true);$s=$a[0]['secret'];$i=$a[0]['id'];$e='{"id":"'.$i.'","secret":"'.$s.'"}';$c=array('whitespace'=>' [ { "secret" : "'.$s.'" , "id" : "'.$i.'" } ] ','escaped_name'=>'[{"\\u0069d":"'.$i.'","secret":"'.$s.'"}]','numeric_object'=>'{"0":'.$e.'}','duplicate_id_member'=>'[{"id":"bad","id":"'.$i.'","secret":"'.$s.'"}]','escaped_duplicate_id'=>'[{"id":"bad","\\u0069d":"'.$i.'","secret":"'.$s.'"}]','duplicate_secret_member'=>'[{"id":"'.$i.'","secret":"bad","secret":"'.$s.'"}]','trailing'=>'['.$e.']x');$o=array();foreach($c as $k=>$j){$o[$k]=false!==Newsroom_Bridge_Security_Config::parse_key_ring_json($j);}echo wp_json_encode($o);`], { sensitive: true }));
  assert(strictParserMatrix.whitespace === true && strictParserMatrix.escaped_name === true && Object.entries(strictParserMatrix).filter(([key]) => !['whitespace', 'escaped_name'].includes(key)).every(([, value]) => value === false), 'Strict JSON structural matrix failed.');
  pass('strict_key_ring_structure', strictParserMatrix);
  const parserFixtureSecret = 'A'.repeat(43);
  const parserEntry = `{"id":"fixture","secret":"${parserFixtureSecret}"}`;
  const escapeCases = {
    escaped_duplicate_secret: `[{"id":"fixture","secret":"${parserFixtureSecret}","\\u0073ecret":"${parserFixtureSecret}"}]`,
    lone_high_surrogate: `[{"id":"\\ud800","secret":"${parserFixtureSecret}"}]`,
    lone_low_surrogate: `[{"id":"\\udc00","secret":"${parserFixtureSecret}"}]`,
    bad_escape: `[{"id":"\\q","secret":"${parserFixtureSecret}"}]`,
    short_unicode: `[{"id":"\\u006","secret":"${parserFixtureSecret}"}]`,
    raw_control: `[{"id":"a\nb","secret":"${parserFixtureSecret}"}]`,
    terminal_backslash: '[{"id":"fixture' + '\\',
    secondary_escape: `[${parserEntry},{"id":"\\q","secret":"${parserFixtureSecret}"}]`,
    trailing_comma: `[${parserEntry},]`,
    escaped_quote: `[{"id":"a\\"b","secret":"${parserFixtureSecret}"}]`,
  };
  const escapeResults = JSON.parse(wp(['eval', `$c=json_decode(base64_decode('${Buffer.from(JSON.stringify(escapeCases)).toString('base64')}'),true);$o=array();foreach($c as $n=>$j){$o[$n]=false!==Newsroom_Bridge_Security_Config::parse_key_ring_json($j);}echo wp_json_encode($o);`]));
  assert(Object.keys(escapeResults).length === Object.keys(escapeCases).length && Object.values(escapeResults).every((value) => value === false), 'Malformed JSON escape matrix failed.');
  pass('key_ring_escape_regressions', escapeResults);
  const lockdownTable = JSON.parse(wp(['eval', `$r=new ReflectionClass('Newsroom_Bridge_Security_Config');$props=array();foreach(array('service_user_id'=>3,'service_user_id_valid'=>true,'key_ring'=>array('x'=>str_repeat('x',32)),'key_ring_valid'=>true,'logging_enabled'=>false)as$n=>$v){$p=$r->getProperty($n);$p->setAccessible(true);$props[$n]=array($p,$v);}$states=array('absent_absent'=>array(null,null),'absent_false'=>array(null,false),'absent_true'=>array(null,true),'absent_malformed'=>array(null,'invalid'),'false_absent'=>array(false,null),'true_absent'=>array(true,null),'malformed_absent'=>array('invalid',null),'false_false'=>array(false,false),'false_true'=>array(false,true),'false_malformed'=>array(false,'invalid'),'true_false'=>array(true,false),'true_true'=>array(true,true),'true_malformed'=>array(true,'invalid'),'malformed_false'=>array('invalid',false),'malformed_true'=>array('invalid',true),'malformed_malformed'=>array('invalid','invalid'));$o=array();foreach($states as$n=>$s){$c=$r->newInstanceWithoutConstructor();foreach($props as$x){$x[0]->setValue($c,$x[1]);}$p=$r->getProperty('hmac_state');$p->setAccessible(true);$p->setValue($c,$s[0]);$p=$r->getProperty('lockdown_state');$p->setAccessible(true);$p->setValue($c,$s[1]);$o[$n]=array('lockdown'=>$c->effective_lockdown_is_enabled(),'hmac'=>$c->hmac_prerequisites_are_valid());}echo wp_json_encode($o);`]));
  const expectedLockdownTable = { absent_absent: [false, false], absent_false: [false, false], absent_true: [true, false], absent_malformed: [true, false], false_absent: [false, false], true_absent: [true, false], malformed_absent: [true, false], false_false: [false, false], false_true: [true, false], false_malformed: [true, false], true_false: [true, false], true_true: [true, true], true_malformed: [true, false], malformed_false: [true, false], malformed_true: [true, false], malformed_malformed: [true, false] };
  assert(Object.entries(expectedLockdownTable).every(([name, expected]) => lockdownTable[name]?.lockdown === expected[0] && lockdownTable[name]?.hmac === expected[1]), 'Lockdown/HMAC truth table failed.');
  pass('lockdown_hmac_truth_table', lockdownTable);

  await recreate({ NEWSROOM_BRIDGE_HMAC_ENABLED: '0', NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: '0' });
  const disabledPayload = { draft_key: randomUUID(), title: `Disabled Stage ${randomUUID()}`, content: 'Existing bridge behavior.', excerpt: '', categories: [categoryIds[0]] };
  const disabled = await request('POST', '/wp-json/newsroom/v1/drafts', { body: JSON.stringify(disabledPayload), headers: { authorization: serviceAuth, 'content-type': 'application/json' } });
  assert(disabled.status === 201, `Explicitly disabled hardening rewrote existing bridge behavior (HTTP ${disabled.status}).`);
  await recreate({ NEWSROOM_BRIDGE_HMAC_ENABLED: '0', NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: 'malformed' });
  const malformedLockdownRest = await request('GET', '/wp-json/wp/v2/users/me', { headers: { authorization: serviceAuth } });
  const malformedLockdownLogin = await passwordLogin('runtime_service', runtimeEnv.SERVICE_PASSWORD);
  const malformedLockdownHmac = await signedRequest('GET', `/newsroom/v1/drafts/${randomUUID()}`);
  const malformedLockdownUnrelated = await request('GET', '/wp-json/wp/v2/users/me', { headers: { authorization: unrelatedAuth } });
  assert(malformedLockdownRest.status === 401 && !malformedLockdownLogin.hasAuthCookie && malformedLockdownHmac.status === 401 && malformedLockdownUnrelated.status === 200, 'Malformed-lockdown staged behavior failed closed or affected an unrelated user.');
  await recreate({ NEWSROOM_BRIDGE_HMAC_ENABLED: '1', NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: '1' });
  pass('staged_enablement', { disabled_bridge_behavior: disabled.status, malformed_lockdown: { service_rest: 401, service_login: 'denied', hmac: 401, unrelated: 200 }, enabled: true });

  const serviceRest = await request('GET', '/wp-json/wp/v2/users/me', { headers: { authorization: serviceAuth } });
  assert(serviceRest.status === 401, `Legacy service Application Password was not denied with HTTP 401 (HTTP ${serviceRest.status}).`);
  assert((await xmlrpc('wp.getUsersBlogs', ['runtime_service', serviceApp])).fault, 'Legacy service Application Password authenticated to XML-RPC.');
  assert(!(await passwordLogin('runtime_service', runtimeEnv.SERVICE_PASSWORD)).hasAuthCookie, 'Service password authenticated interactively.');
  assert((await xmlrpc('wp.getUsersBlogs', ['runtime_service', runtimeEnv.SERVICE_PASSWORD])).fault, 'Service password authenticated to XML-RPC.');
  const createServiceApp = await request('POST', `/wp-json/wp/v2/users/${serviceId}/application-passwords`, { body: JSON.stringify({ name: 'blocked' }), headers: { authorization: adminAuth, 'content-type': 'application/json' } });
  assert(createServiceApp.status === 501, 'Service Application Password creation was available.');
  const unrelatedMe = await request('GET', '/wp-json/wp/v2/users/me', { headers: { authorization: unrelatedAuth } });
  assert(unrelatedMe.status === 200, 'Unrelated Author Application Password regressed.');
  assert((await passwordLogin('runtime_unrelated', runtimeEnv.UNRELATED_PASSWORD)).hasAuthCookie, 'Unrelated Author password login regressed.');
  assert(!(await xmlrpc('wp.getUsersBlogs', ['runtime_unrelated', unrelatedApp])).fault, 'Unrelated XML-RPC authentication regressed.');
  pass('identity_scoped_lockdown', { service_rest: 401, service_xmlrpc: 'denied', service_login: 'denied', unrelated: 'functional' });

  const draftKey = randomUUID();
  const payload = { draft_key: draftKey, title: `Production HMAC ${randomUUID()}`, content: 'Exact production HMAC body.', excerpt: '', categories: [categoryIds[1], categoryIds[0], categoryIds[1]] };
  const raw = JSON.stringify(payload);
  const created = await signedRequest('POST', '/newsroom/v1/drafts', { body: raw });
  if (created.status !== 201 || created.body?.replayed !== false) {
    const logTail = compose(['logs', '--no-color', '--tail', '80', 'wordpress'], { allowFailure: true, sensitive: true }).stdout;
    throw new Error(`Valid HMAC POST failed (HTTP ${created.status}). Safe log tail: ${redact(logTail)}`);
  }
  const postId = Number(created.body.post_id);
  assert(!created.headers['set-cookie'], 'HMAC create issued an authentication cookie.');
  const stored = postInfo(postId);
  const mapped = mapping(draftKey);
  const canonicalHash = createHash('sha256').update(JSON.stringify({ contract_version: 1, title: payload.title, content: payload.content, excerpt: '', categories: [categoryIds[0], categoryIds[1]] })).digest('hex');
  assert(stored?.status === 'draft' && stored.author === serviceId && stored.title === payload.title && stored.content === payload.content, 'HMAC draft postcondition failed.');
  assert(JSON.stringify(categories(postId)) === JSON.stringify([categoryIds[0], categoryIds[1]]) && mapped?.postId === postId && mapped.payloadHash === canonicalHash && mapped.token === null, 'HMAC reconciliation/category postcondition failed.');
  const lookup = await signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`);
  assert(lookup.status === 200 && Number(lookup.body?.post_id) === postId && !lookup.headers['set-cookie'], 'Valid zero-body/no-Content-Type GET failed or issued a cookie.');
  const replay = await signedRequest('POST', '/newsroom/v1/drafts', { body: raw });
  assert(replay.status === 200 && replay.body?.replayed === true && postCount(payload.title) === 1, 'Signed replay created a duplicate.');
  const conflictRaw = JSON.stringify({ ...payload, content: 'Conflicting content.' });
  const conflict = await signedRequest('POST', '/newsroom/v1/drafts', { body: conflictRaw });
  assert(conflict.status === 409 && mapping(draftKey)?.payloadHash === canonicalHash, 'Idempotency conflict did not preserve the mapping.');
  pass('valid_hmac_reconciliation', { post: 201, get: 200, replay: 200, conflict: 409, author: serviceId });

  const cookieLogin = await passwordLogin('runtime_unrelated', runtimeEnv.UNRELATED_PASSWORD);
  assert(cookieLogin.hasAuthCookie && cookieLogin.cookieHeader, 'Could not establish disposable unrelated-user cookie session.');
  knownSecrets.push(cookieLogin.cookieHeader, ...cookieLogin.cookies.map((cookie) => cookie.slice(cookie.indexOf('=') + 1)));
  const noncePage = await request('GET', '/wp-admin/?newsroom_probe_nonce=1', { headers: { cookie: cookieLogin.cookieHeader } });
  const restNonce = noncePage.headers['x-newsroom-test-nonce'];
  assert(typeof restNonce === 'string' && restNonce.length > 0, 'Could not obtain the test-only REST nonce for the cookie session.');
  const cookieConflictPayload = { draft_key: randomUUID(), title: `Cookie Conflict ${randomUUID()}`, content: 'must not persist', excerpt: '', categories: [categoryIds[0]] };
  const cookieConflictRaw = JSON.stringify(cookieConflictPayload);
  await durableNegative('cookie conflict without nonce', () => signedRequest('POST', '/newsroom/v1/drafts', { body: cookieConflictRaw, headers: { cookie: cookieLogin.cookieHeader } }));
  await durableNegative('cookie conflict with nonce', () => signedRequest('POST', '/newsroom/v1/drafts', { body: cookieConflictRaw, headers: { cookie: cookieLogin.cookieHeader, 'x-wp-nonce': restNonce } }));
  await durableNegative('Application Password Authorization conflict', () => request('POST', '/wp-json/newsroom/v1/drafts', { body: cookieConflictRaw, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', cookieConflictRaw), authorization: unrelatedAuth, 'content-type': 'application/json' } }));
  const ordinaryCookie = await request('GET', '/wp-json/wp/v2/users/me', { headers: { cookie: cookieLogin.cookieHeader, 'x-wp-nonce': restNonce } });
  const ordinaryApplicationPassword = await request('GET', '/wp-json/wp/v2/users/me', { headers: { authorization: unrelatedAuth } });
  assert(ordinaryCookie.status === 200 && ordinaryApplicationPassword.status === 200, 'Ordinary unrelated cookie or Application Password behavior regressed.');
  pass('prior_cookie_and_authorization_conflicts', { cookie_without_nonce: 401, cookie_with_nonce: 401, application_password_authorization: 401, ordinary_cookie: 200, ordinary_application_password: 200, durable_state: 'unchanged' });

  const durablePayload = { draft_key: randomUUID(), title: `Durable Negative ${randomUUID()}`, content: 'must not persist', excerpt: '', categories: [categoryIds[0]] };
  const durableRaw = JSON.stringify(durablePayload);
  const durableProtocolCases = [
    ['bad signature durable', () => signedRequest('POST', '/newsroom/v1/drafts', { body: durableRaw, auth: { signature: '0'.repeat(64) } })],
    ['wrong key durable', () => signedRequest('POST', '/newsroom/v1/drafts', { body: durableRaw, auth: { keyId: 'unknown-durable-key' } })],
    ['expired timestamp durable', () => signedRequest('POST', '/newsroom/v1/drafts', { body: durableRaw, auth: { timestamp: Math.floor(Date.now() / 1000) - 301 } })],
    ['route tamper durable', () => request('POST', '/wp-json/newsroom/v1/drafts/', { body: durableRaw, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', durableRaw), 'content-type': 'application/json' } })],
    ['method tamper durable', () => request('PUT', '/wp-json/newsroom/v1/drafts', { body: durableRaw, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', durableRaw), 'content-type': 'application/json' } })],
    ['content type durable', () => request('POST', '/wp-json/newsroom/v1/drafts', { body: durableRaw, headers: hmacHeaders('POST', '/newsroom/v1/drafts', durableRaw) })],
    ['query durable', () => request('POST', '/wp-json/newsroom/v1/drafts?x=1', { body: durableRaw, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', durableRaw), 'content-type': 'application/json' } })],
    ['method override durable', () => signedRequest('POST', '/newsroom/v1/drafts', { body: durableRaw, headers: { 'x-http-method-override': 'DELETE' } })],
  ];
  for (const [name, operation] of durableProtocolCases) await durableNegative(name, operation);
  pass('protocol_negative_durable_state', { cases: durableProtocolCases.length, post_mapping_meta_relationships_credentials: 'unchanged' });

  const negatives = [];
  async function negative(name, operation) { await durableNegative(name, operation); negatives.push(name); }
  await negative('missing auth', () => request('POST', '/wp-json/newsroom/v1/drafts', { body: raw, headers: { 'content-type': 'application/json' } }));
  await negative('wrong secret', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { secret: randomSecret(32) } }));
  await negative('unknown key', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { keyId: 'unknown-key' } }));
  await negative('malformed key', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { keyId: 'Bad Key' } }));
  await negative('malformed signature', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { signature: 'A'.repeat(64) } }));
  await negative('tampered body', () => request('POST', '/wp-json/newsroom/v1/drafts', { body: `${raw} `, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', raw), 'content-type': 'application/json' } }));
  await negative('method tamper', () => request('PUT', '/wp-json/newsroom/v1/drafts', { body: raw, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', raw), 'content-type': 'application/json' } }));
  await negative('route case tamper', () => request('POST', '/wp-json/Newsroom/v1/drafts', { body: raw, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', raw), 'content-type': 'application/json' } }));
  await negative('trailing slash', () => request('POST', '/wp-json/newsroom/v1/drafts/', { body: raw, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', raw), 'content-type': 'application/json' } }));
  await negative('percent-encoded route', () => request('POST', '/wp-json/newsroom/v1/%64rafts', { body: raw, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', raw), 'content-type': 'application/json' } }));
  await negative(
    'UUID route tamper',
    () => request('GET', `/wp-json/newsroom/v1/drafts/${randomUUID()}`, { headers: hmacHeaders('GET', `/newsroom/v1/drafts/${draftKey}`, '') }),
  );
  await negative('past expiry', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { timestamp: Math.floor(Date.now() / 1000) - 301 } }));
  await negative('future expiry', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { timestamp: Math.floor(Date.now() / 1000) + 600 } }));
  await negative('negative timestamp', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { timestamp: '-1' } }));
  await negative('decimal timestamp', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { timestamp: '1000000000.0' } }));
  await negative('malformed timestamp', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { timestamp: '1e10' } }));
  await negative('oversized timestamp', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, auth: { timestamp: '9999999999999' } }));
  await negative('query', () => request('POST', '/wp-json/newsroom/v1/drafts?x=1', { body: raw, headers: { ...hmacHeaders('POST', '/newsroom/v1/drafts', raw), 'content-type': 'application/json' } }));
  await negative('method override', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, headers: { 'X-HTTP-Method-Override': 'DELETE' } }));
  const contentTypes = [null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json; charset=iso-8859-1', 'application/json; charset="utf-8"', 'application/json; charset=utf-8; profile=x', 'application/json, text/plain'];
  for (const contentType of contentTypes) {
    const headers = hmacHeaders('POST', '/newsroom/v1/drafts', raw);
    if (contentType !== null) headers['content-type'] = contentType;
    await negative(`content type ${contentType ?? 'missing'}`, () => request('POST', '/wp-json/newsroom/v1/drafts', { body: raw, headers }));
  }
  await negative('comma header', () => signedRequest('POST', '/newsroom/v1/drafts', { body: raw, headers: { 'X-Newsroom-Key-Id': `${runtimeEnv.HMAC_KEY_ID},${runtimeEnv.HMAC_KEY_ID}` } }));
  const duplicateHeaders = hmacHeaders('POST', '/newsroom/v1/drafts', raw);
  duplicateHeaders['X-Newsroom-Key-Id'] = [runtimeEnv.HMAC_KEY_ID, runtimeEnv.HMAC_KEY_ID];
  duplicateHeaders['content-type'] = 'application/json';
  await negative('duplicate key header', () => request('POST', '/wp-json/newsroom/v1/drafts', { body: raw, headers: duplicateHeaders }));
  await negative('GET body', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`, { body: 'x' }));
  await negative('GET content type', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`, { headers: { 'content-type': 'application/json' } }));
  const charsetPayload = { draft_key: randomUUID(), title: `Charset ${randomUUID()}`, content: 'Accepted normalized media type.', excerpt: '', categories: [categoryIds[0]] };
  const charsetRaw = JSON.stringify(charsetPayload);
  const charsetAccepted = await signedRequest('POST', '/newsroom/v1/drafts', { body: charsetRaw, headers: { 'content-type': 'Application/JSON ; Charset = UTF-8' } });
  assert(charsetAccepted.status === 201, 'Approved case-insensitive JSON charset form was rejected.');
  const timestampBoundaries = JSON.parse(wp(['eval', `$m=new ReflectionMethod('Newsroom_Bridge_Auth','timestamp_is_within_window');$m->setAccessible(true);$n=2000000000;$o=array();foreach(array(-301,-300,300,301)as$s){$o[(string)$s]=$m->invoke(null,(string)($n+$s),$n);}echo wp_json_encode($o);`]));
  assert(timestampBoundaries['-301'] === false && timestampBoundaries['-300'] === true && timestampBoundaries['300'] === true && timestampBoundaries['301'] === false, 'Exact deterministic timestamp boundaries failed.');
  const past299 = await signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`, { auth: { timestamp: Math.floor(Date.now() / 1000) - 299 } });
  const future299 = await signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`, { auth: { timestamp: Math.floor(Date.now() / 1000) + 299 } });
  assert(past299.status === 200 && future299.status === 200, 'Near-boundary HTTP timestamp regression failed.');
  pass('authentication_negative_matrix', { exact_401: negatives.length, exact_boundaries: timestampBoundaries, near_boundary_http: 'accepted', alternate_json_content_type: 201, duplicate_header: 401 });

  const seedTitle = `Admin Seed ${randomUUID()}`;
  const seedCreate = await request('POST', '/wp-json/wp/v2/posts', { body: JSON.stringify({ title: seedTitle, content: 'seed', status: 'draft' }), headers: { authorization: adminAuth, 'content-type': 'application/json' } });
  assert(seedCreate.status === 201, 'Administrator seed failed.');
  const seedId = Number(seedCreate.body.id);
  const attachmentsBefore = attachmentCount();
  const revisionsBefore = revisionCount(seedId);
  const serviceAppsBefore = applicationPasswordCount(serviceId);
  const bypasses = [
    ['core draft', 'POST', '/wp/v2/posts', JSON.stringify({ title: 'blocked draft', status: 'draft' })],
    ['core publish', 'POST', '/wp/v2/posts', JSON.stringify({ title: 'blocked publish', status: 'publish' })],
    ['update', 'POST', `/wp/v2/posts/${seedId}`, JSON.stringify({ title: 'changed' })],
    ['delete', 'DELETE', `/wp/v2/posts/${seedId}`, ''],
    ['autosave', 'POST', `/wp/v2/posts/${seedId}/autosaves`, JSON.stringify({ content: 'changed' })],
    ['media', 'POST', '/wp/v2/media', 'data'],
    ['application passwords', 'POST', `/wp/v2/users/${serviceId}/application-passwords`, JSON.stringify({ name: 'blocked' })],
    ['batch', 'POST', '/batch/v1', JSON.stringify({ requests: [] })],
  ];
  for (const [name, method, route, body] of bypasses) await durableNegative(name, () => request(method, `/wp-json${route}`, { body, headers: { ...hmacHeaders(method, route, body), 'content-type': 'application/json' } }));
  assert(postInfo(seedId)?.title === seedTitle && postCount('blocked draft') === 0 && postCount('blocked publish') === 0 && attachmentCount() === attachmentsBefore && revisionCount(seedId) === revisionsBefore && applicationPasswordCount(serviceId) === serviceAppsBefore, 'A core bypass changed durable post, revision, attachment, or credential state.');
  const embeddedBody = JSON.stringify({ requests: [{ method: 'POST', path: '/wp/v2/posts', headers: hmacHeaders('POST', '/newsroom/v1/drafts', raw), body: { title: 'embedded blocked', status: 'draft' } }] });
  const beforeEmbedded = durableState();
  const embedded = await request('POST', '/wp-json/batch/v1', { body: embeddedBody, headers: { 'content-type': 'application/json' } });
  if (embedded.status !== 207 || embedded.body?.responses?.[0]?.status !== 401 || postCount('embedded blocked') !== 0) {
    throw new Error(`Embedded batch assertion failed: outer=${embedded.status}, inner=${embedded.body?.responses?.[0]?.status ?? 'missing'}, code=${embedded.body?.responses?.[0]?.body?.code ?? embedded.body?.code ?? 'missing'}, durable=${postCount('embedded blocked')}.`);
  }
  assert(JSON.stringify(durableState()) === JSON.stringify(beforeEmbedded), 'Embedded batch changed durable state.');
  pass('core_and_batch_isolation', { bypasses: bypasses.length, outer_batch_hmac: 401, embedded_outer: 207, embedded_inner: 401 });

  wp(['option', 'update', 'newsroom_test_nested_dispatch', '1']);
  const nestedPayload = { draft_key: randomUUID(), title: `Nested ${randomUUID()}`, content: 'nested defence', excerpt: '', categories: [categoryIds[0]] };
  const nested = await signedRequest('POST', '/newsroom/v1/drafts', { body: JSON.stringify(nestedPayload) });
  const nestedStatuses = JSON.parse(nested.headers['x-newsroom-nested-statuses'] ?? 'null');
  assert(nested.status === 201 && nestedStatuses && Object.keys(nestedStatuses).length === 5 && Object.values(nestedStatuses).every((status) => status === 401) && postCount(nestedPayload.title) === 1 && postCount('Nested forbidden sentinel') === 0 && !nested.headers['set-cookie'], 'Nested REST dispatch defence failed or issued a cookie.');
  wp(['option', 'delete', 'newsroom_test_nested_dispatch']);
  pass('nested_dispatch_attacks', { ...nestedStatuses, outer: 201, forbidden_posts: 0, auth_cookie: Boolean(nested.headers['set-cookie']) });

  const executionResults = JSON.parse(wp(['eval-file', '/var/www/html/wp-content/plugins/newsroom-trust-boundary-implementation-probe/execution-tests.php', draftKey], { label: 'in-process authority lifecycle tests' }));
  assert(Object.keys(executionResults).length === 17 && Object.values(executionResults).every((result) => typeof result === 'number' ? result === 401 : result.restored === true && result.inactive === true && result.redispatch === 401), 'In-process authority restoration evidence failed.');
  pass('exception_safe_authority_lifecycle', { cases: Object.keys(executionResults).length, immediate_restoration: true, proof_reuse: 401 });

  wp(['cap', 'add', 'newsroom_draft_service', 'manage_options']);
  await negative('dangerous capability drift', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`));
  wp(['cap', 'remove', 'newsroom_draft_service', 'manage_options']);
  wp(['cap', 'remove', 'newsroom_draft_service', 'edit_posts']);
  await negative('missing required capability', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`));
  wp(['cap', 'add', 'newsroom_draft_service', 'edit_posts']);
  wp(['option', 'update', 'newsroom_test_force_app_password_available', '1']);
  await negative('unexpected App Password availability', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`));
  wp(['option', 'delete', 'newsroom_test_force_app_password_available']);
  const priorAuthHeaders = { ...hmacHeaders('GET', `/newsroom/v1/drafts/${draftKey}`), authorization: unrelatedAuth };
  await negative('prior authentication conflict', () => request('GET', `/wp-json/newsroom/v1/drafts/${draftKey}`, { headers: priorAuthHeaders }));
  await recreate({ NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: '0' });
  await negative('HMAC enabled without explicit lockdown', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`));
  const misconfiguredServiceRest = await request('GET', '/wp-json/wp/v2/users/me', { headers: { authorization: serviceAuth } });
  assert(misconfiguredServiceRest.status === 401, `Effective lockdown did not deny the service credential with HTTP 401 (HTTP ${misconfiguredServiceRest.status}).`);
  await recreate({ NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: 'malformed' });
  await negative('malformed lockdown flag', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`));
  await recreate({ NEWSROOM_BRIDGE_HMAC_ENABLED: 'malformed', NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: '0' });
  const malformedHmacServiceRest = await request('GET', '/wp-json/wp/v2/users/me', { headers: { authorization: serviceAuth } });
  assert(malformedHmacServiceRest.status === 401, 'Malformed HMAC flag did not retain effective service lockdown.');
  await negative('malformed HMAC flag', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`));
  await recreate({ NEWSROOM_BRIDGE_HMAC_ENABLED: '1', NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: '1' });
  await recreate({ NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED: '1', NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON: '[]' });
  await negative('empty runtime ring', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`));
  await recreate({ NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON: JSON.stringify([{ id: runtimeEnv.HMAC_KEY_ID, secret: runtimeEnv.HMAC_SECRET }]), NEWSROOM_BRIDGE_USER_ID: '999999' });
  await negative('missing configured user', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`));
  await recreate({ NEWSROOM_BRIDGE_USER_ID: 'bad' });
  await negative('malformed user ID', () => signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`));
  await recreate({ NEWSROOM_BRIDGE_USER_ID: String(serviceId) });
  assert((await signedRequest('GET', `/newsroom/v1/drafts/${draftKey}`)).status === 200, 'Valid configuration did not recover.');
  pass('configuration_failure_matrix', { exact_401: 10, effective_lockdown: true, recovered: true });

  const concurrencyPayload = { draft_key: randomUUID(), title: `Concurrent Same ${randomUUID()}`, content: 'same', excerpt: '', categories: [categoryIds[2]] };
  const concurrencyRaw = JSON.stringify(concurrencyPayload);
  const sameResponses = await Promise.all(Array.from({ length: 20 }, () => signedRequest('POST', '/newsroom/v1/drafts', { body: concurrencyRaw })));
  const sameMapping = mapping(concurrencyPayload.draft_key);
  const sameIds = sameResponses.map((response) => Number(response.body?.post_id));
  const sameExpectedHash = createHash('sha256').update(JSON.stringify({ contract_version: 1, title: concurrencyPayload.title, content: concurrencyPayload.content, excerpt: '', categories: concurrencyPayload.categories })).digest('hex');
  assert(exactStatuses(sameResponses, { 201: 1, 200: 19 }) && sameIds.every((id) => id > 0 && id === sameIds[0]) && postCount(concurrencyPayload.title) === 1 && mappingCount(concurrencyPayload.draft_key) === 1 && sameMapping?.postId === sameIds[0] && sameMapping?.token === null && sameMapping?.payloadHash === sameExpectedHash, 'Twenty-request identical concurrency failed.');
  const conflictKey = randomUUID();
  const variantA = { draft_key: conflictKey, title: `Concurrent A ${randomUUID()}`, content: 'A', excerpt: '', categories: [categoryIds[0]] };
  const variantB = { draft_key: conflictKey, title: `Concurrent B ${randomUUID()}`, content: 'B', excerpt: '', categories: [categoryIds[1]] };
  const conflicting = await Promise.all([...Array.from({ length: 10 }, () => signedRequest('POST', '/newsroom/v1/drafts', { body: JSON.stringify(variantA) })), ...Array.from({ length: 10 }, () => signedRequest('POST', '/newsroom/v1/drafts', { body: JSON.stringify(variantB) }))]);
  const expectedConflictHashes = [variantA, variantB].map((variant) => createHash('sha256').update(JSON.stringify({ contract_version: 1, title: variant.title, content: variant.content, excerpt: '', categories: variant.categories })).digest('hex'));
  const conflictingMapping = mapping(conflictKey);
  const createdConflict = conflicting.filter((response) => response.status === 201);
  const successfulConflictIds = conflicting.filter((response) => [200, 201].includes(response.status)).map((response) => Number(response.body?.post_id));
  const winnerPost = postInfo(Number(createdConflict[0]?.body?.post_id));
  const winnerIndex = winnerPost?.title === variantA.title ? 0 : winnerPost?.title === variantB.title ? 1 : -1;
  assert(exactStatuses(conflicting, { 201: 1, 200: 9, 409: 10 }) && winnerIndex >= 0 && conflictingMapping?.payloadHash === expectedConflictHashes[winnerIndex] && successfulConflictIds.length === 10 && successfulConflictIds.every((id) => id > 0 && id === conflictingMapping?.postId) && postCount(variantA.title) + postCount(variantB.title) === 1 && mappingCount(conflictKey) === 1 && conflictingMapping?.token === null, 'Twenty-request conflicting concurrency or independently identified winning-hash proof failed.');
  const winnerRequestIndex = Math.floor(conflicting.findIndex((response) => response.status === 201) / 10);
  assert(winnerIndex === winnerRequestIndex && conflicting.every((response, index) => Math.floor(index / 10) === winnerIndex ? [200, 201].includes(response.status) : response.status === 409), 'Concurrency outcomes did not match the winning request payload.');
  const falsePositive = [201, ...Array(10).fill(409), ...Array(9).fill(500)].map((status) => ({ status }));
  assert(!exactStatuses(falsePositive, { 201: 1, 200: 9, 409: 10 }), 'Old concurrency false-positive vector passed.');
  const losingVariant = winnerIndex === 0 ? variantB : variantA;
  const beforeLosingRetry = { ...conflictingMapping };
  const losingRetry = await signedRequest('POST', '/newsroom/v1/drafts', { body: JSON.stringify(losingVariant) });
  const afterLosingRetry = mapping(conflictKey);
  assert(losingRetry.status === 409 && JSON.stringify(afterLosingRetry) === JSON.stringify(beforeLosingRetry) && postCount(variantA.title) + postCount(variantB.title) === 1 && mappingCount(conflictKey) === 1, 'Post-concurrency losing retry changed the winning mapping or post.');
  const recovery = await signedRequest('GET', `/newsroom/v1/drafts/${conflictKey}`);
  assert(recovery.status === 200 && mapping(conflictKey)?.postId === Number(recovery.body?.post_id), 'Reconciliation-before-retry recovery failed.');
  pass('reconciliation_concurrency_regression', { identical: { created: 1, replayed: 19, other: 0, post: 1, mapping: 1, token: null }, conflicting: { created: 1, replayed: 9, conflict: 10, other: 0, post: 1, mapping: 1, token: null, winner_hash_independent: true }, losing_retry: 409, recovery: 200, old_false_positive_rejected: true, request_variant_verified: true });

  assert((await xmlrpc('wp.getUsersBlogs', ['runtime_service', runtimeEnv.HMAC_SECRET])).fault, 'HMAC secret authenticated to XML-RPC.');
  const hmacXmlTitle = `HMAC XMLRPC ${randomUUID()}`;
  assert((await xmlrpc('wp.newPost', [0, 'runtime_service', runtimeEnv.HMAC_SECRET, { post_type: 'post', post_status: 'publish', post_title: hmacXmlTitle }])).fault && postCount(hmacXmlTitle) === 0, 'HMAC secret created or published through XML-RPC.');
  const ordinaryAdmin = await request('GET', '/wp-json/wp/v2/users/me', { headers: { authorization: adminAuth } });
  const adminNormalTitle = `Admin Normal ${randomUUID()}`;
  const unrelatedNormalTitle = `Author Normal ${randomUUID()}`;
  const adminNormal = await request('POST', '/wp-json/wp/v2/posts', { body: JSON.stringify({ title: adminNormalTitle, content: 'normal', status: 'draft' }), headers: { authorization: adminAuth, 'content-type': 'application/json' } });
  const unrelatedNormal = await request('POST', '/wp-json/wp/v2/posts', { body: JSON.stringify({ title: unrelatedNormalTitle, content: 'normal', status: 'draft' }), headers: { authorization: unrelatedAuth, 'content-type': 'application/json' } });
  assert(ordinaryAdmin.status === 200 && unrelatedMe.status === 200 && adminNormal.status === 201 && unrelatedNormal.status === 201, 'Ordinary users regressed.');
  wp(['post', 'delete', String(adminNormal.body.id), '--force']);
  wp(['post', 'delete', String(unrelatedNormal.body.id), '--force']);
  pass('xmlrpc_and_ordinary_user_non_regression', { hmac_xmlrpc: 'denied', hmac_xmlrpc_create: 'denied', admin_rest: 200, admin_create: 201, unrelated_rest: 200, unrelated_create: 201 });

  const signatureHeaders = hmacHeaders('GET', `/newsroom/v1/drafts/${draftKey}`, '');
  const signatureSentinel = signatureHeaders['X-Newsroom-Signature'];
  knownSecrets.push(signatureSentinel, Buffer.from(runtimeEnv.HMAC_SECRET, 'base64url').toString('hex'), payload.content, raw, cookieConflictRaw);
  const signatureProbe = await request('GET', `/wp-json/newsroom/v1/drafts/${draftKey}`, { headers: signatureHeaders });
  assert(signatureProbe.status === 200, 'Generated-signature logging sentinel request failed.');
  const logs = compose(['logs', '--no-color', 'wordpress'], { sensitive: true }).stdout;
  const logLeakCounts = knownSecrets.map((secret) => secret && logs.includes(secret) ? 1 : 0);
  assert(logs.includes('newsroom_bridge_security') && logLeakCounts.every((count) => count === 0), 'Security log sentinel leakage test failed.');
  const databaseAudit = JSON.parse(wp(['eval-file', '/var/www/html/wp-content/plugins/newsroom-trust-boundary-implementation-probe/database-audit.php'], { sensitive: true, label: 'database secret persistence audit' }));
  assert(databaseAudit.tables > 0 && databaseAudit.columns > 0 && databaseAudit.encoded_matches === 0 && databaseAudit.raw_matches === 0 && databaseAudit.query_errors === 0 && databaseAudit.injected_query_error_rejected === true, 'Database secret persistence audit failed or accepted a query error.');
  const repositoryAudit = repositorySecretOccurrences(runtimeEnv.HMAC_SECRET);
  assert(repositoryAudit.count === 0 && repositoryAudit.rootEnvExcluded === true, 'Generated HMAC secret persisted in approved repository artifacts or root environment isolation failed.');
  pass('safe_logging_and_secret_persistence', { logging: { sentinels_examined: logLeakCounts.length, matches: 0 }, database: databaseAudit, repository: { files_examined: repositoryAudit.filesExamined, matches: repositoryAudit.count, root_env_excluded: true } });

  wp(['user', 'application-password', 'delete', String(serviceId), '--all'], { sensitive: true });
  assert(Number(wp(['user', 'application-password', 'list', String(serviceId), '--format=count'])) === 0, 'Service Application Password records remain.');
  assert(JSON.stringify(protectedHashes()) === JSON.stringify(frozenHashes), 'Frozen reconciliation hashes changed during runtime.');
  evidence.runtime = { wordpress: wp(['core', 'version']), php: compose(['exec', '-T', 'wordpress', 'php', '-r', 'echo PHP_VERSION;']).stdout.trim(), mariadb: db('SELECT VERSION()'), wp_cli: wp(['cli', 'version']), loopback: true };
  pass('final_integrity', { protected_hashes: 'unchanged', application_passwords: 0, schema: '2' });
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

if (fatalError) process.exitCode = 1;
else process.stdout.write(`PASS implementation suite (${evidence.results.length} evidence groups)\n`);
