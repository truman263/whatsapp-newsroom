<?php
/**
 * Plugin Name: Media Newsroom Proof (TEST-ONLY)
 * Description: Disposable Round 2B.3B media-authority and idempotency prototype. NEVER DEPLOY.
 * Version: 0.0.0-test
 *
 * NOT PRODUCTION CODE. Do not copy, reuse, or deploy. The words "TEST-ONLY"
 * appear in every file. Production media implementation belongs to a later
 * round inside the approved production Newsroom Bridge architecture.
 *
 * Loads a media-scoped authentication boundary, a dedicated media
 * reconciliation table, and a bounded upload pipeline. The production
 * Newsroom Bridge is untouched and is mounted read-only by the disposable
 * runtime alongside this prototype.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // TEST-ONLY prototype.
}

final class Test_Only_Media_Plugin {
	private static $store;
	private static $auth;
	private static $controller;

	public static function bootstrap() {
		require_once __DIR__ . '/includes/class-test-only-media-config.php';
		require_once __DIR__ . '/includes/class-test-only-media-store.php';
		require_once __DIR__ . '/includes/class-test-only-media-auth.php';
		require_once __DIR__ . '/includes/class-test-only-media-controller.php';

		self::$store      = new Test_Only_Media_Store();
		self::$auth       = new Test_Only_Media_Auth( Test_Only_Media_Config::from_constants() );
		self::$controller = new Test_Only_Media_Controller( Test_Only_Media_Config::from_constants() );

		self::$store->install_schema();
		self::$auth->register();
		self::$controller->register();
		add_action( 'rest_api_init', array( self::$controller, 'register_routes' ) );
	}

	public static function store_instance() {
		return self::$store;
	}

	public static function auth_instance() {
		return self::$auth;
	}

	public static function controller_instance() {
		return self::$controller;
	}

	public static function install_schema() {
		require_once __DIR__ . '/includes/class-test-only-media-store.php';
		$store = new Test_Only_Media_Store();
		$store->install_schema();
	}
}

register_activation_hook( __FILE__, array( 'Test_Only_Media_Plugin', 'install_schema' ) );

add_action(
	'plugins_loaded',
	function () {
		Test_Only_Media_Plugin::bootstrap();
	},
	20
);