<?php
/**
 * Plugin Name: Newsroom Bridge
 * Description: Private idempotent WordPress draft creation and reconciliation boundary.
 * Version: 1.2.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'NEWSROOM_BRIDGE_VERSION', '1.2.0' );
define( 'NEWSROOM_BRIDGE_SCHEMA_VERSION', '2' );

require_once __DIR__ . '/includes/class-newsroom-bridge-key-ring-json.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-security-config.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-service-user.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-auth.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-db.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-reconciliation.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-rest.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-media-config.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-media-service-user.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-media-auth.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-media-db.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-media-reconciliation.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-media-rest.php';

define( 'NEWSROOM_BRIDGE_MEDIA_SCHEMA_VERSION', '1' );

$newsroom_bridge_security_config = Newsroom_Bridge_Security_Config::from_constants();
$newsroom_bridge_service_user    = new Newsroom_Bridge_Service_User( $newsroom_bridge_security_config );
$newsroom_bridge_auth            = new Newsroom_Bridge_Auth( $newsroom_bridge_security_config, $newsroom_bridge_service_user );
$newsroom_bridge_service_user->register();
$newsroom_bridge_auth->register();
unset( $newsroom_bridge_security_config, $newsroom_bridge_service_user, $newsroom_bridge_auth );

$newsroom_bridge_media_config = Newsroom_Bridge_Media_Config::from_constants();
$newsroom_bridge_media_service_user = new Newsroom_Bridge_Media_Service_User( $newsroom_bridge_media_config );
$newsroom_bridge_media_auth = new Newsroom_Bridge_Media_Auth( $newsroom_bridge_media_config, $newsroom_bridge_media_service_user );
$newsroom_bridge_media_service_user->register();
$newsroom_bridge_media_auth->register();
unset( $newsroom_bridge_media_config, $newsroom_bridge_media_service_user );

register_activation_hook( __FILE__, array( 'Newsroom_Bridge_DB', 'install' ) );
register_activation_hook( __FILE__, array( 'Newsroom_Bridge_Media_DB', 'install' ) );

add_action(
	'rest_api_init',
	static function () use ( $newsroom_bridge_media_auth ) {
		$database       = new Newsroom_Bridge_DB();
		$reconciliation = new Newsroom_Bridge_Reconciliation( $database );
		$rest           = new Newsroom_Bridge_REST( $reconciliation );
		$rest->register_routes();

		$media_config   = Newsroom_Bridge_Media_Config::from_constants();
		$media_database = new Newsroom_Bridge_Media_DB();
		$media_rest     = new Newsroom_Bridge_Media_REST(
			$newsroom_bridge_media_auth,
			new Newsroom_Bridge_Media_Reconciliation( $media_database, $media_config ),
			$media_database,
			$media_config
		);
		$media_rest->register();
		$media_rest->register_routes();
	}
);
