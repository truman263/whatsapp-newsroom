<?php
if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) { exit; }
global $wpdb;
$state = array();
// Complete content/mapping rows catch updates as well as additions/deletions.
foreach ( array( $wpdb->posts, $wpdb->postmeta, $wpdb->terms, $wpdb->term_taxonomy, $wpdb->termmeta, $wpdb->term_relationships, $wpdb->prefix.'newsroom_reconciliation' ) as $table ) {
	$rows = $wpdb->get_results( 'SELECT * FROM `' . str_replace('`','``',$table) . '`', ARRAY_A );
	if ( '' !== $wpdb->last_error || ! is_array($rows) ) { throw new RuntimeException('State query failed.'); }
	$serialized = array_map( 'wp_json_encode', $rows ); sort( $serialized, SORT_STRING );
	$state[$table] = array( 'count'=>count($rows), 'hash'=>hash('sha256',implode("\n",$serialized)) );
}
$rows = $wpdb->get_results( "SELECT user_id,meta_value FROM {$wpdb->usermeta} WHERE meta_key='_application_passwords' ORDER BY user_id", ARRAY_A );
if ( '' !== $wpdb->last_error || ! is_array($rows) ) { throw new RuntimeException('Credential state query failed.'); }
// Authentication may update last_used metadata; credential identity/hash/count must not change.
$credentials=array();
foreach($rows as $row){foreach((array)maybe_unserialize($row['meta_value']) as $item){$credentials[]=array($row['user_id'],$item['uuid'],$item['password'],$item['name']);}}
sort($credentials);
$state['credentials']=array('count'=>count($credentials),'hash'=>hash('sha256',wp_json_encode($credentials)));
echo wp_json_encode($state);
