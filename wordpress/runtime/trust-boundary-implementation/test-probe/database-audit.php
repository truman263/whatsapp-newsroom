<?php
// CLI-only disposable evidence. Never installed as a production endpoint.
if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) { exit; }
global $wpdb;
$checked = static function ( $sql ) use ( $wpdb ) {
	$result = $wpdb->get_results( $sql, ARRAY_A );
	if ( '' !== $wpdb->last_error || ! is_array( $result ) ) {
		throw new RuntimeException( 'Database audit query failed.' );
	}
	return $result;
};
$columns = $checked( $wpdb->prepare( "SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=%s ORDER BY TABLE_NAME,ORDINAL_POSITION", DB_NAME ) );
if ( empty( $columns ) ) { throw new RuntimeException( 'No database columns inspected.' ); }
$tables = array(); $inspected = 0; $encoded_matches = 0; $raw_matches = 0;
$ring = Newsroom_Bridge_Key_Ring_JSON::parse( NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON );
if ( false === $ring ) { throw new RuntimeException( 'Invalid audit key configuration.' ); }
$encoded_hex = bin2hex( $ring[0]['secret'] );
$raw_hex = bin2hex( base64_decode( strtr( $ring[0]['secret'], '-_', '+/' ) . '=', true ) );
$quote = static function ( $name ) { return '`' . str_replace( '`', '``', $name ) . '`'; };
foreach ( $columns as $column ) {
	$tables[ $column['TABLE_NAME'] ] = true;
	if ( ! in_array( strtolower( $column['DATA_TYPE'] ), array( 'char','varchar','tinytext','text','mediumtext','longtext','binary','varbinary','tinyblob','blob','mediumblob','longblob','enum','set','json' ), true ) ) { continue; }
	++$inspected;
	$field = $quote( $column['COLUMN_NAME'] );
	$rows = $checked( 'SELECT COUNT(*) AS encoded_count FROM ' . $quote( $column['TABLE_NAME'] ) . " WHERE LOCATE(UNHEX('" . $encoded_hex . "'),CAST(" . $field . ' AS BINARY))>0' );
	if ( ! isset( $rows[0]['encoded_count'] ) || ! ctype_digit( (string) $rows[0]['encoded_count'] ) ) { throw new RuntimeException( 'Missing encoded count.' ); }
	$encoded_matches += (int) $rows[0]['encoded_count'];
	$rows = $checked( 'SELECT COUNT(*) AS raw_count FROM ' . $quote( $column['TABLE_NAME'] ) . " WHERE LOCATE(UNHEX('" . $raw_hex . "'),CAST(" . $field . ' AS BINARY))>0' );
	if ( ! isset( $rows[0]['raw_count'] ) || ! ctype_digit( (string) $rows[0]['raw_count'] ) ) { throw new RuntimeException( 'Missing raw count.' ); }
	$raw_matches += (int) $rows[0]['raw_count'];
}
// Prove SQL failure cannot be counted as zero. Suppress SQL text, never the failure.
$old = $wpdb->suppress_errors( true ); $rejected = false;
try { $checked( 'SELECT nonexistent_audit_column FROM ' . $quote( $wpdb->posts ) ); }
catch ( RuntimeException $error ) { $rejected = true; }
finally { $wpdb->suppress_errors( $old ); }
if ( ! $rejected ) { throw new RuntimeException( 'Database error guard failed.' ); }
echo wp_json_encode( array( 'tables'=>count($tables), 'columns'=>$inspected, 'encoded_matches'=>$encoded_matches, 'raw_matches'=>$raw_matches, 'query_errors'=>0, 'injected_query_error_rejected'=>$rejected ) );
