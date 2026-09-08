<?php
/**
 * Test-only fault injection for the disposable draft-sync proof runtime.
 *
 * Mounted ONLY inside the disposable WordPress container as an mu-plugin. The
 * production newsroom-bridge plugin and the draft-sync prototype never trigger
 * these hooks or the option that gates them except on the exact action/filter
 * the prototype exposes for proof purposes. Faults are armed/cleared by the
 * runner through wp-cli on the disposable instance, so they can never fire on
 * a production request.
 *
 * Available phases:
 *   during_update  - throw right before the sync transaction commits; the
 *                    prototype rolls back and must leave zero state behind.
 *   mismatched_store - corrupt the title that WordPress stores for an update;
 *                    the prototype must detect the postcondition mismatch,
 *                    roll back, and return 503 without persisting anything.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'newsroom_draft_sync_proof_before_commit',
	static function () {
		if ( 'during_update' === get_option( 'test_draft_sync_fault_phase', '' ) ) {
			throw new Exception( 'test fault: during_update' );
		}
	},
	PHP_INT_MAX,
	2
);

add_filter(
	'wp_insert_post_data',
	static function ( $data, $postarr, $unsanitized_postarr, $update ) {
		unset( $postarr, $unsanitized_postarr );
		$phase = get_option( 'test_draft_sync_fault_phase', '' );
		if ( 'mismatched_store' !== $phase ) {
			return $data;
		}
		if ( true !== $update || ! is_array( $data ) || ! isset( $data['post_title'] ) ) {
			return $data;
		}
		$data['post_title'] = (string) $data['post_title'] . ' [fault-injected]';
		return $data;
	},
	PHP_INT_MAX,
	4
);