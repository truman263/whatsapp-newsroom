<?php
/**
 * TEST-ONLY disposable media reconciliation storage.
 *
 * NOT PRODUCTION CODE. Dedicated media reconciliation table for the proof.
 * No secret storage. Schema version and column set are disposable and are NOT
 * a production migration.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // TEST-ONLY prototype.
}

final class Test_Only_Media_Store {

	const SCHEMA_VERSION = '1';

	/** Deterministic payload fingerprint: body digest, filename hash, mime. */
	public static function payload_fingerprint( $body_sha256, $filename_hash, $mime ) {
		return hash( 'sha256', 'media-payload-v1' . "\n" . $body_sha256 . "\n" . $filename_hash . "\n" . $mime );
	}

	private $wpdb;

	public function __construct() {
		global $wpdb;
		$this->wpdb = $wpdb;
	}

	public function install_schema() {
		$this->wpdb->query( 'CREATE TABLE IF NOT EXISTS ' . $this->wpdb->prefix . 'newsroom_media (' .
			'media_key CHAR(36) NOT NULL, ' .
			'attachment_id BIGINT(20) UNSIGNED NULL, ' .
			'payload_hash CHAR(64) NOT NULL, ' .
			'content_length BIGINT(20) UNSIGNED NOT NULL, ' .
			'actor_user_id BIGINT(20) UNSIGNED NOT NULL, ' .
			'reservation_token CHAR(64) NULL, ' .
			'created_at DATETIME NOT NULL, ' .
			'updated_at DATETIME NOT NULL, ' .
			'PRIMARY KEY  (media_key), ' .
			'UNIQUE KEY uniq_attachment_id (attachment_id), ' .
			'KEY idx_payload_hash (payload_hash)' .
			') ' . $this->wpdb->get_charset_collate() . ' ENGINE=InnoDB' );
	}

	public function row_by_key( $media_key ) {
		return $this->wpdb->get_row(
			$this->wpdb->prepare(
				'SELECT media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token, created_at, updated_at FROM ' . $this->wpdb->prefix . 'newsroom_media WHERE media_key = %s',
				$media_key
			),
			ARRAY_A
		);
	}

	/**
	 * Attempt to claim a fresh reservation for the key. Returns true when this
	 * call becomes the owner, false when another reservation already exists.
	 */
	public function try_insert_reservation( $media_key, $payload_hash, $content_length, $actor_user_id, $token ) {
		$now = gmdate( 'Y-m-d H:i:s' );
		$result = $this->wpdb->query(
			$this->wpdb->prepare(
				'INSERT INTO ' . $this->wpdb->prefix . 'newsroom_media ' .
				'(media_key, attachment_id, payload_hash, content_length, actor_user_id, reservation_token, created_at, updated_at) ' .
				'VALUES (%s, NULL, %s, %d, %d, %s, %s, %s)',
				$media_key,
				$payload_hash,
				$content_length,
				$actor_user_id,
				$token,
				$now,
				$now
			)
		);
		return false !== $result;
	}

	public function set_reservation_token( $media_key, $token ) {
		return 1 === (int) $this->wpdb->update(
			$this->wpdb->prefix . 'newsroom_media',
			array( 'reservation_token' => $token, 'updated_at' => gmdate( 'Y-m-d H:i:s' ) ),
			array( 'media_key' => $media_key )
		);
	}

	public function commit_attachment( $media_key, $attachment_id, $token ) {
		return 1 === (int) $this->wpdb->query(
			$this->wpdb->prepare(
				'UPDATE ' . $this->wpdb->prefix . 'newsroom_media SET attachment_id = %d, reservation_token = NULL, updated_at = %s WHERE media_key = %s AND reservation_token = %s',
				$attachment_id,
				gmdate( 'Y-m-d H:i:s' ),
				$media_key,
				$token
			)
		);
	}

	public function maybe_reclaim( $media_key, $expected_token, $new_token, $staleness_seconds ) {
		return 1 === (int) $this->wpdb->query(
			$this->wpdb->prepare(
				'UPDATE ' . $this->wpdb->prefix . 'newsroom_media SET reservation_token = %s, updated_at = %s WHERE media_key = %s AND reservation_token = %s AND updated_at < %s',
				$new_token,
				gmdate( 'Y-m-d H:i:s' ),
				$media_key,
				$expected_token,
				gmdate( 'Y-m-d H:i:s', (int) gmdate( 'U' ) - $staleness_seconds )
			)
		);
	}

	public function delete_row( $media_key ) {
		return 1 === (int) $this->wpdb->delete( $this->wpdb->prefix . 'newsroom_media', array( 'media_key' => $media_key ) );
	}

	public function table_exists() {
		$name = $this->wpdb->prefix . 'newsroom_media';
		return $name === $this->wpdb->get_var( $this->wpdb->prepare( 'SHOW TABLES LIKE %s', $name ) );
	}

	public function count_rows() {
		return (int) $this->wpdb->get_var( 'SELECT COUNT(*) FROM ' . $this->wpdb->prefix . 'newsroom_media' );
	}

}