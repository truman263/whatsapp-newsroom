<?php
/** Disposable instrumentation through core hooks; never installed in production. */
if ( ! defined( 'ABSPATH' ) ) { exit; }
add_filter( 'wp_insert_post_data', static function ( $data, $postarr, $raw, $update ) {
    if ( $update && 'before_update' === get_option( 'test_draft_sync_fault_phase', '' ) ) { throw new RuntimeException( 'injected' ); }
    if ( $update && 'mismatched_store' === get_option( 'test_draft_sync_fault_phase', '' ) ) { $data['post_title'] .= ' [fault-injected]'; }
    return $data;
}, PHP_INT_MAX, 4 );
add_action( 'rest_after_insert_post', static function () {
    if ( 'during_update' === get_option( 'test_draft_sync_fault_phase', '' ) ) { throw new RuntimeException( 'injected' ); }
}, PHP_INT_MAX );
add_filter( 'query', static function ( $query ) {
    if ( 'COMMIT' === strtoupper( trim( $query ) ) && 'commit_uncertain' === get_option( 'test_draft_sync_fault_phase', '' ) ) {
        // Commit the transaction then make the caller observe a failed acknowledgement.
        global $wpdb;
        static $inside = false;
        if ( ! $inside ) {
            $inside = true;
            $wpdb->query( 'COMMIT' );
            $inside = false;
            return 'INVALID COMMIT ACKNOWLEDGEMENT';
        }
    }
    return $query;
} );
