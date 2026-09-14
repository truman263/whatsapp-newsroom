<?php
/** Disposable current-user transition observer; never installed in production. */
if ( ! defined( 'ABSPATH' ) ) { exit; }
if ( ! function_exists( 'newsroom_draft_auth_observer_is_draft_route' ) ) {
	function newsroom_draft_auth_observer_is_draft_route() {
		$uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		$host = isset( $_SERVER['HTTP_HOST'] ) ? (string) $_SERVER['HTTP_HOST'] : '';
		$full = ( '' === $host ) ? $uri : 'http://' . $host . $uri;
		$path = parse_url( $full, PHP_URL_PATH );
		return is_string( $path ) && false !== strpos( $path, '/newsroom/v1/drafts' );
	}
}
add_action( 'save_post', static function () {
	if ( newsroom_draft_auth_observer_is_draft_route() ) {
		update_option( 'newsroom_auth_observer_during_user', (string) get_current_user_id(), false );
	}
}, PHP_INT_MAX );
add_action( 'shutdown', static function () {
	if ( newsroom_draft_auth_observer_is_draft_route() ) {
		update_option( 'newsroom_auth_observer_shutdown_user', (string) get_current_user_id(), false );
	}
}, PHP_INT_MAX );

if ( ! function_exists( 'newsroom_publication_observer_is_route' ) ) {
	function newsroom_publication_observer_is_route() {
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		return false !== strpos( $uri, '/newsroom/v1/publications' );
	}
}
foreach ( array( 'transition_post_status', 'publish_post', 'save_post', 'wp_after_insert_post', 'clean_post_cache' ) as $newsroom_publication_hook ) {
	add_action( $newsroom_publication_hook, static function () use ( $newsroom_publication_hook ) {
		if ( newsroom_publication_observer_is_route() ) {
			update_option( 'newsroom_publication_hook_' . $newsroom_publication_hook, 'fired', false );
		}
	}, PHP_INT_MAX );
}
unset( $newsroom_publication_hook );

add_filter( 'rest_authentication_errors', static function ( $result ) {
	if ( isset( $_SERVER['HTTP_X_NEWSROOM_TEST_PRIOR_AUTH'] ) ) {
		return true;
	}
	if ( isset( $_SERVER['HTTP_X_NEWSROOM_TEST_CURRENT_USER'] ) ) {
		wp_set_current_user( 1 );
	}
	return $result;
}, PHP_INT_MIN );
