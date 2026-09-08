<?php
/**
 * Test-only fault injection for the disposable media-implementation runtime.
 *
 * Mounted ONLY inside the disposable WordPress container as an mu-plugin. The
 * production newsroom-bridge plugin never references these hooks or the
 * option that gates them. Faults are armed/cleared by the runner through
 * wp-cli on the disposable instance, so they can never be triggered by a
 * production request.
 *
 * Available phases:
 *   after_reservation - throw at the very start of the upload pipeline
 *   after_file        - throw after the media file has been written to disk
 *   after_insert      - throw after the attachment row has been inserted
 *   during_metadata   - throw while attachment metadata is being generated
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_filter(
	'upload_dir',
	static function ( $dirs ) {
		$phase = get_option( 'test_media_fault_phase', '' );
		if ( 'after_reservation' !== $phase ) {
			return $dirs;
		}
		throw new Exception( 'test fault: after_reservation' );
	},
	PHP_INT_MAX
);

add_filter(
	'wp_check_filetype_and_ext',
	static function ( $filetype ) {
		$phase = get_option( 'test_media_fault_phase', '' );
		if ( 'after_file' !== $phase ) {
			return $filetype;
		}
		throw new Exception( 'test fault: after_file' );
	},
	PHP_INT_MAX,
	3
);

add_action(
	'add_attachment',
	static function () {
		$phase = get_option( 'test_media_fault_phase', '' );
		if ( 'after_insert' !== $phase ) {
			return;
		}
		throw new Exception( 'test fault: after_insert' );
	},
	PHP_INT_MAX
);

add_filter(
	'wp_generate_attachment_metadata',
	static function ( $metadata, $attachment_id, $context ) {
		unset( $context );
		$phase = get_option( 'test_media_fault_phase', '' );
		if ( 'during_metadata' !== $phase ) {
			return $metadata;
		}
		throw new Exception( 'test fault: during_metadata' );
	},
	PHP_INT_MAX,
	3
);