<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Media reconciliation storage for the newsroom media bridge.
 *
 * Dedicated table (never mixed with the draft reconciliation table), with its
 * own schema version option. No secrets are ever written to storage.
 */
final class Newsroom_Bridge_Media_DB {
	private const SCHEMA_OPTION = 'newsroom_bridge_media_schema_version';

	public static function install() {
		global $wpdb;

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table_name      = self::table_name();
		$charset_collate = $wpdb->get_charset_collate();
		$sql             = "CREATE TABLE {$table_name} (
			media_key char(36) NOT NULL,
			attachment_id bigint(20) unsigned NULL,
			payload_hash char(64) NOT NULL,
			content_length bigint(20) unsigned NOT NULL,
			actor_user_id bigint(20) unsigned NOT NULL,
			reservation_token char(64) NULL,
			created_at datetime NOT NULL,
			updated_at datetime NOT NULL,
			PRIMARY KEY  (media_key),
			UNIQUE KEY attachment_id (attachment_id),
			KEY idx_payload_hash (payload_hash)
		) ENGINE=InnoDB {$charset_collate};";

		dbDelta( $sql );
		$verified = self::verify_media_table_contract();
		if ( is_wp_error( $verified ) ) {
			delete_option( self::SCHEMA_OPTION );
			wp_die( esc_html( 'Newsroom Bridge could not verify its media storage contract.' ) );
		}

		update_option( self::SCHEMA_OPTION, NEWSROOM_BRIDGE_MEDIA_SCHEMA_VERSION, false );
	}

	public static function table_name() {
		global $wpdb;
		return $wpdb->prefix . 'newsroom_media';
	}

	public function assert_ready_and_transactional() {
		global $wpdb;

		if ( get_option( self::SCHEMA_OPTION ) !== NEWSROOM_BRIDGE_MEDIA_SCHEMA_VERSION ) {
			return new WP_Error(
				'newsroom_bridge_media_not_configured',
				'Newsroom Bridge media storage is not installed at the required schema version.',
				array( 'status' => 503 )
			);
		}

		$verified = self::verify_media_table_contract();
		if ( is_wp_error( $verified ) ) {
			return $verified;
		}

		$required_tables = array(
			$wpdb->posts,
			$wpdb->postmeta,
			$wpdb->terms,
			$wpdb->term_taxonomy,
			$wpdb->term_relationships,
		);
		$placeholders = implode( ', ', array_fill( 0, count( $required_tables ), '%s' ) );
		$query        = $wpdb->prepare(
			"SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s AND TABLE_NAME IN ({$placeholders})",
			array_merge( array( DB_NAME ), $required_tables )
		);
		$rows         = $wpdb->get_results( $query, ARRAY_A );

		if ( ! is_array( $rows ) || count( $rows ) !== count( $required_tables ) ) {
			return new WP_Error(
				'newsroom_media_storage_not_transactional',
				'Required WordPress storage could not be verified as transactional.',
				array( 'status' => 503 )
			);
		}

		foreach ( $rows as $row ) {
			if ( 'INNODB' !== strtoupper( (string) $row['ENGINE'] ) ) {
				return new WP_Error(
					'newsroom_media_storage_not_transactional',
					'Required WordPress storage is not transactional.',
					array( 'status' => 503 )
				);
			}
		}

		return true;
	}

	public static function verify_media_table_contract() {
		global $wpdb;

		$table_name = self::table_name();
		$table      = $wpdb->get_row(
			$wpdb->prepare(
				'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s',
				DB_NAME,
				$table_name
			),
			ARRAY_A
		);

		if ( ! is_array( $table ) || 'INNODB' !== strtoupper( (string) $table['ENGINE'] ) ) {
			return self::invalid_contract();
		}

		$rows = $wpdb->get_results(
			$wpdb->prepare(
				'SELECT COLUMN_NAME, IS_NULLABLE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s',
				DB_NAME,
				$table_name
			),
			ARRAY_A
		);
		$columns = array();
		foreach ( is_array( $rows ) ? $rows : array() as $row ) {
			$columns[ $row['COLUMN_NAME'] ] = $row;
		}

		if (
			! self::column_matches( $columns, 'media_key', 'char', false, 36 )
			|| ! self::column_matches( $columns, 'attachment_id', 'bigint', true )
			|| false === stripos( (string) $columns['attachment_id']['COLUMN_TYPE'], 'unsigned' )
			|| ! self::column_matches( $columns, 'payload_hash', 'char', false, 64 )
			|| ! self::column_matches( $columns, 'content_length', 'bigint', false )
			|| false === stripos( (string) $columns['content_length']['COLUMN_TYPE'], 'unsigned' )
			|| ! self::column_matches( $columns, 'actor_user_id', 'bigint', false )
			|| false === stripos( (string) $columns['actor_user_id']['COLUMN_TYPE'], 'unsigned' )
			|| ! self::column_matches( $columns, 'reservation_token', 'char', true, 64 )
			|| ! self::column_matches( $columns, 'created_at', 'datetime', false )
			|| ! self::column_matches( $columns, 'updated_at', 'datetime', false )
		) {
			return self::invalid_contract();
		}

		$index_rows = $wpdb->get_results(
			$wpdb->prepare(
				'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s ORDER BY INDEX_NAME, SEQ_IN_INDEX',
				DB_NAME,
				$table_name
			),
			ARRAY_A
		);
		$indexes = array();
		foreach ( is_array( $index_rows ) ? $index_rows : array() as $row ) {
			$indexes[ $row['INDEX_NAME'] ]['non_unique'] = (int) $row['NON_UNIQUE'];
			$indexes[ $row['INDEX_NAME'] ]['columns'][]  = $row['COLUMN_NAME'];
		}

		$primary_valid = isset( $indexes['PRIMARY'] )
			&& 0 === $indexes['PRIMARY']['non_unique']
			&& array( 'media_key' ) === $indexes['PRIMARY']['columns'];
		$attachment_unique = false;
		foreach ( $indexes as $index ) {
			if ( 0 === $index['non_unique'] && array( 'attachment_id' ) === $index['columns'] ) {
				$attachment_unique = true;
				break;
			}
		}
		$payload_hash_index = false;
		foreach ( $indexes as $index ) {
			if ( array( 'payload_hash' ) === $index['columns'] ) {
				$payload_hash_index = true;
				break;
			}
		}

		return $primary_valid && $attachment_unique && $payload_hash_index ? true : self::invalid_contract();
	}

	private static function column_matches( array $columns, $name, $type, $nullable, $length = null ) {
		if ( ! isset( $columns[ $name ] ) ) {
			return false;
		}

		$column = $columns[ $name ];
		if ( $type !== strtolower( (string) $column['DATA_TYPE'] ) ) {
			return false;
		}

		if ( $nullable !== ( 'YES' === $column['IS_NULLABLE'] ) ) {
			return false;
		}

		return null === $length || (int) $column['CHARACTER_MAXIMUM_LENGTH'] === $length;
	}

	private static function invalid_contract() {
		return new WP_Error(
			'newsroom_media_storage_error',
			'Media storage does not satisfy the required contract.',
			array( 'status' => 503 )
		);
	}

	public function begin() {
		global $wpdb;
		return false !== $wpdb->query( 'START TRANSACTION' );
	}

	public function commit() {
		global $wpdb;
		return false !== $wpdb->query( 'COMMIT' );
	}

	public function rollback() {
		global $wpdb;
		$wpdb->query( 'ROLLBACK' );
	}

	/**
	 * Inserts a fresh reservation row, or a no-op when the key already exists.
	 * Ownership is decided by the caller comparing the row's token afterwards.
	 */
	public function reserve( $media_key, $payload_hash, $content_length, $actor_user_id, $reservation_token ) {
		global $wpdb;

		$now = current_time( 'mysql', true );
		$sql = $wpdb->prepare(
			'INSERT INTO ' . self::table_name() . ' (media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token, created_at, updated_at) VALUES (%s, NULL, %s, %d, %d, %s, %s, %s) ON DUPLICATE KEY UPDATE media_key = media_key',
			$media_key,
			$payload_hash,
			$content_length,
			$actor_user_id,
			$reservation_token,
			$now,
			$now
		);

		$result = $wpdb->query( $sql );
		if ( false === $result ) {
			return new WP_Error(
				'newsroom_media_storage_error',
				'Media storage could not reserve the media key.',
				array( 'status' => 503 )
			);
		}

		return true;
	}

	public function get_for_update( $media_key ) {
		return $this->read_mapping( $media_key, true );
	}

	public function get( $media_key ) {
		return $this->read_mapping( $media_key, false );
	}

	/**
	 * Commits a completed attachment to the matching reservation. Bounded by the
	 * ownership token: exactly one row must be affected.
	 */
	public function commit_attachment( $media_key, $reservation_token, $attachment_id ) {
		global $wpdb;
		$result = $wpdb->query(
			$wpdb->prepare(
				'UPDATE ' . self::table_name() . ' SET attachment_id = %d, reservation_token = NULL, updated_at = %s WHERE media_key = %s AND reservation_token = %s AND attachment_id IS NULL',
				$attachment_id,
				current_time( 'mysql', true ),
				$media_key,
				$reservation_token
			)
		);

		return 1 === $result;
	}

	/**
	 * Atomically reclaims a stale reservation owned by the expected token.
	 * Exactly one row must be affected for the caller to become owner.
	 */
	public function maybe_reclaim( $media_key, $expected_token, $new_token, $staleness_seconds ) {
		global $wpdb;
		$result = $wpdb->query(
			$wpdb->prepare(
				'UPDATE ' . self::table_name() . ' SET reservation_token = %s, updated_at = %s WHERE media_key = %s AND reservation_token = %s AND updated_at < %s',
				$new_token,
				current_time( 'mysql', true ),
				$media_key,
				$expected_token,
				gmdate( 'Y-m-d H:i:s', time() - $staleness_seconds )
			)
		);

		return 1 === $result;
	}

	public function set_reservation_token( $media_key, $reservation_token ) {
		global $wpdb;
		$result = $wpdb->update(
			self::table_name(),
			array(
				'reservation_token' => $reservation_token,
				'updated_at'        => current_time( 'mysql', true ),
			),
			array( 'media_key' => $media_key )
		);

		return 1 === $result;
	}

	public function delete_row( $media_key ) {
		global $wpdb;
		$result = $wpdb->delete( self::table_name(), array( 'media_key' => $media_key ) );

		return 1 === (int) $wpdb->rows_affected;
	}

	/**
	 * Deletes a reservation row only when it is still owned by the expected
	 * token. Guards against deleting a row that a concurrent reclaim now owns.
	 */
	public function delete_row_if_token( $media_key, $reservation_token ) {
		global $wpdb;
		$result = $wpdb->query(
			$wpdb->prepare(
				'DELETE FROM ' . self::table_name() . ' WHERE media_key = %s AND reservation_token = %s',
				$media_key,
				$reservation_token
			)
		);

		return 1 === $result;
	}

	private function read_mapping( $media_key, $for_update ) {
		global $wpdb;

		$locking_clause = $for_update ? ' FOR UPDATE' : '';
		$row            = $wpdb->get_row(
			$wpdb->prepare(
				'SELECT media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token FROM ' . self::table_name() . ' WHERE media_key = %s' . $locking_clause,
				$media_key
			),
			ARRAY_A
		);

		if ( ! empty( $wpdb->last_error ) ) {
			return new WP_Error(
				'newsroom_media_storage_error',
				'Media storage could not be read.',
				array( 'status' => 503 )
			);
		}

		return $row;
	}
}