<?php
/**
 * Plugin Name: Newsroom Bridge
 * Description: Private idempotent WordPress draft creation and reconciliation boundary.
 * Version: 1.0.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'NEWSROOM_BRIDGE_VERSION', '1.0.0' );
define( 'NEWSROOM_BRIDGE_SCHEMA_VERSION', '2' );

require_once __DIR__ . '/includes/class-newsroom-bridge-db.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-reconciliation.php';
require_once __DIR__ . '/includes/class-newsroom-bridge-rest.php';

register_activation_hook( __FILE__, array( 'Newsroom_Bridge_DB', 'install' ) );

add_action(
	'rest_api_init',
	static function () {
		$database       = new Newsroom_Bridge_DB();
		$reconciliation = new Newsroom_Bridge_Reconciliation( $database );
		$rest           = new Newsroom_Bridge_REST( $reconciliation );
		$rest->register_routes();
	}
);
