<?php
/**
 * Plugin Name: Newsroom Draft Sync Proof (TEST-ONLY)
 * Description: TEST-ONLY disposable prototype that layers the draft-sync PUT
 * route and featured-media assignment onto the FROZEN production Newsroom
 * Bridge classes (Round 2B.4A). NEVER DEPLOY.
 * Version: 0.1.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 *
 * This prototype mounts the production newsroom-bridge plugin READ-ONLY (the
 * production plugin is NOT activated here) and re-uses its frozen classes
 * verbatim for the draft create/lookup surface and the whole media boundary.
 * The ONLY new code is the sync surface:
 *
 *   - PUT  /newsroom/v1/drafts/{draft_key}          full-state sync
 *   - GET  /newsroom/v1/drafts/{draft_key}/state    canonical sync state
 *
 * and the test-only HMAC auth that extends the frozen draft allow-list with
 * those two routes. Nothing here is production code and nothing is deployed.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'NEWSROOM_BRIDGE_VERSION', '1.2.0' );
define( 'NEWSROOM_BRIDGE_SCHEMA_VERSION', '2' );
define( 'NEWSROOM_BRIDGE_MEDIA_SCHEMA_VERSION', '1' );
define( 'NEWSROOM_DRAFT_SYNC_PROOF', true );

$newsroom_proof_bridge_root = WP_PLUGIN_DIR . '/newsroom-bridge';

require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-key-ring-json.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-security-config.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-service-user.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-db.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-reconciliation.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-rest.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-media-config.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-media-service-user.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-media-auth.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-media-db.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-media-reconciliation.php';
require_once $newsroom_proof_bridge_root . '/includes/class-newsroom-bridge-media-rest.php';

require_once __DIR__ . '/includes/class-test-draft-sync-auth.php';
require_once __DIR__ . '/includes/class-test-draft-sync-rest.php';

unset( $newsroom_proof_bridge_root );

$newsroom_proof_security_config = Newsroom_Bridge_Security_Config::from_constants();
$newsroom_proof_service_user    = new Newsroom_Bridge_Service_User( $newsroom_proof_security_config );
$newsroom_proof_sync_auth       = new Newsroom_Bridge_Draft_Sync_Auth( $newsroom_proof_security_config, $newsroom_proof_service_user );
$newsroom_proof_service_user->register();
$newsroom_proof_sync_auth->register();
unset( $newsroom_proof_security_config, $newsroom_proof_service_user, $newsroom_proof_sync_auth );

$newsroom_proof_media_config         = Newsroom_Bridge_Media_Config::from_constants();
$newsroom_proof_media_service_user   = new Newsroom_Bridge_Media_Service_User( $newsroom_proof_media_config );
$newsroom_proof_media_auth           = new Newsroom_Bridge_Media_Auth( $newsroom_proof_media_config, $newsroom_proof_media_service_user );
$newsroom_proof_media_service_user->register();
$newsroom_proof_media_auth->register();
unset( $newsroom_proof_media_config, $newsroom_proof_media_service_user );

register_activation_hook( __FILE__, array( 'Newsroom_Bridge_DB', 'install' ) );
register_activation_hook( __FILE__, array( 'Newsroom_Bridge_Media_DB', 'install' ) );

add_action(
	'rest_api_init',
	static function () use ( $newsroom_proof_media_auth ) {
		$database       = new Newsroom_Bridge_DB();
		$reconciliation = new Newsroom_Bridge_Reconciliation( $database );
		$rest           = new Newsroom_Bridge_REST( $reconciliation );
		$rest->register_routes();

		$sync = new Newsroom_Bridge_Draft_Sync_REST( $database, new Newsroom_Bridge_Media_DB(), $reconciliation );
		$sync->register_routes();

		$media_config   = Newsroom_Bridge_Media_Config::from_constants();
		$media_database = new Newsroom_Bridge_Media_DB();
		$media_rest     = new Newsroom_Bridge_Media_REST(
			$newsroom_proof_media_auth,
			new Newsroom_Bridge_Media_Reconciliation( $media_database, $media_config ),
			$media_database,
			$media_config
		);
		$media_rest->register();
		$media_rest->register_routes();
	}
);