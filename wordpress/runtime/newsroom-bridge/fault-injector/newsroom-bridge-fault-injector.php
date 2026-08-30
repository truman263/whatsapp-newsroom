<?php
/**
 * Plugin Name: Newsroom Bridge Fault Injector
 * Description: TEST ONLY — NEVER DEPLOY. Loopback runtime fault injection for Newsroom Bridge validation.
 * Version: 1.0.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function newsroom_bridge_test_fault_mode() {
	if ( '1' !== getenv( 'NEWSROOM_BRIDGE_TEST_FAULTS_ENABLED' ) || 'local' !== wp_get_environment_type() ) {
		return '';
	}

	$remote_address = isset( $_SERVER['REMOTE_ADDR'] ) ? (string) $_SERVER['REMOTE_ADDR'] : '';
	if ( ! in_array( $remote_address, array( '127.0.0.1', '::1', '172.18.0.1', '172.19.0.1', '172.20.0.1' ), true ) && 0 !== strpos( $remote_address, '172.' ) ) {
		return '';
	}

	return isset( $_SERVER['HTTP_X_NEWSROOM_TEST_FAULT'] )
		? sanitize_key( wp_unslash( $_SERVER['HTTP_X_NEWSROOM_TEST_FAULT'] ) )
		: '';
}

add_action(
	'rest_insert_post',
	static function ( $post, $request, $creating ) {
		if ( true === $creating && 'throw_after_insert' === newsroom_bridge_test_fault_mode() ) {
			throw new RuntimeException( 'TEST ONLY: failure after post insertion.' );
		}
	},
	20,
	3
);

add_action(
	'rest_after_insert_post',
	static function ( $post, $request, $creating ) {
		if ( true !== $creating ) {
			return;
		}

		$mode = newsroom_bridge_test_fault_mode();
		if ( 'category_corruption' === $mode ) {
			$category_id = isset( $_SERVER['HTTP_X_NEWSROOM_TEST_CATEGORY'] )
				? absint( $_SERVER['HTTP_X_NEWSROOM_TEST_CATEGORY'] )
				: 0;
			if ( $category_id > 0 ) {
				wp_set_post_categories( $post->ID, array( $category_id ), false );
			}
		}

		if ( 'transaction_tamper' === $mode ) {
			global $wpdb;
			$wpdb->query( 'COMMIT' );
			throw new RuntimeException( 'TEST ONLY: third-party transaction tampering.' );
		}
	},
	20,
	3
);

add_filter(
	'query',
	static function ( $query ) {
		$mode = newsroom_bridge_test_fault_mode();
		if (
			'attach_error' === $mode
			&& 1 === preg_match( '/^\s*UPDATE\s+\S*newsroom_reconciliation\s+SET\s+post_id\s*=/i', $query )
		) {
			return 'UPDATE newsroom_bridge_intentionally_missing SET invalid_column = 1';
		}

		if ( 'commit_error' === $mode && 'COMMIT' === strtoupper( trim( $query ) ) ) {
			return 'COMMIT INTENTIONALLY_INVALID';
		}

		if (
			'get_read_error' === $mode
			&& false !== stripos( $query, 'FROM' )
			&& false !== stripos( $query, 'newsroom_reconciliation' )
			&& false !== stripos( $query, 'SELECT draft_key, post_id, payload_hash, actor_user_id, reservation_token' )
			&& false === stripos( $query, 'FOR UPDATE' )
		) {
			return 'SELECT invalid_column FROM newsroom_bridge_intentionally_missing';
		}

		return $query;
	},
	PHP_INT_MAX
);
