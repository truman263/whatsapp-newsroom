<?php
/**
 * Plugin Name: Newsroom Trust Boundary Implementation Probe
 * Description: TEST ONLY — NEVER DEPLOY. Observes nested dispatch and controlled policy drift.
 * Version: 0.1.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_filter(
	'wp_is_application_passwords_available_for_user',
	static function ( $available, $user ) {
		if (
			'1' === get_option( 'newsroom_test_force_app_password_available' )
			&& defined( 'NEWSROOM_BRIDGE_USER_ID' )
			&& $user instanceof WP_User
			&& (int) $user->ID === (int) NEWSROOM_BRIDGE_USER_ID
		) {
			return true;
		}

		return $available;
	},
	PHP_INT_MAX,
	2
);

add_action(
	'admin_init',
	static function () {
		if ( isset( $_GET['newsroom_probe_nonce'] ) && '1' === $_GET['newsroom_probe_nonce'] && get_current_user_id() > 0 ) {
			header( 'X-Newsroom-Test-Nonce: ' . wp_create_nonce( 'wp_rest' ) );
		}
	}
);


// Retain the actual server request, then attack from inside the direct core controller.
add_filter( 'rest_request_before_callbacks', static function ( $response, $handler, $request ) {
	if ( '/newsroom/v1/drafts' === $request->get_route() ) {
		$GLOBALS['newsroom_probe_request'] = $request;
	}
	return $response;
}, 10, 3 );
add_action( 'rest_insert_post', static function () {
	if ( '1' !== get_option( 'newsroom_test_nested_dispatch' ) || empty( $GLOBALS['newsroom_probe_request'] ) || ! empty( $GLOBALS['newsroom_probe_running'] ) ) {
		return;
	}
	$GLOBALS['newsroom_probe_running'] = true;
	$request = $GLOBALS['newsroom_probe_request'];
	$route = $request->get_route();
	$method = $request->get_method();
	$statuses = array();
	try {
		$statuses['recursive'] = rest_do_request( $request )->get_status();
		$request->set_route( '/wp/v2/posts' );
		$statuses['same_route_mutation'] = rest_do_request( $request )->get_status();
		$request->set_method( 'DELETE' );
		$statuses['same_method_mutation'] = rest_do_request( $request )->get_status();
		$other = new WP_REST_Request( 'POST', '/wp/v2/posts' );
		$other->set_param( 'title', 'Nested forbidden sentinel' );
		$statuses['different'] = rest_do_request( $other )->get_status();
		$statuses['plugin'] = rest_do_request( new WP_REST_Request( 'POST', '/probe/unregistered' ) )->get_status();
	} finally {
		$request->set_route( $route );
		$request->set_method( $method );
		$GLOBALS['newsroom_probe_running'] = false;
	}
	$GLOBALS['newsroom_probe_statuses'] = $statuses;
}, 20 );
add_filter( 'rest_request_after_callbacks', static function ( $response, $handler, $request ) {
	if ( isset( $GLOBALS['newsroom_probe_statuses'] ) && $response instanceof WP_REST_Response && $request === $GLOBALS['newsroom_probe_request'] ) {
		$response->header( 'X-Newsroom-Nested-Statuses', wp_json_encode( $GLOBALS['newsroom_probe_statuses'] ) );
	}
	return $response;
}, 20, 3 );
