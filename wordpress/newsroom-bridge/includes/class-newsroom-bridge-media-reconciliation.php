<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Transactional media reconciliation: reservation-first idempotency and the
 * media-managed upload pipeline for the newsroom bridge.
 */
final class Newsroom_Bridge_Media_Reconciliation {
	private const CONTRACT_VERSION = 1;
	private const STALE_RESERVATION_SECONDS = 30;
	private const MEDIA_KEY_META = '_newsroom_media_key';
	private const MEDIA_FILE_META = '_newsroom_media_file';

	private $database;
	private $config;

	public function __construct( Newsroom_Bridge_Media_DB $database, Newsroom_Bridge_Media_Config $config ) {
		$this->database = $database;
		$this->config   = $config;
	}

	public static function payload_fingerprint( $body_sha256, $filename_hash, $mime ) {
		return hash( 'sha256', 'media-payload-v1' . "\n" . $body_sha256 . "\n" . $filename_hash . "\n" . $mime );
	}

	public function create_media( array $payload ) {
		$ready = $this->database->assert_ready_and_transactional();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}

		$media_key = isset( $payload['media_key'] ) ? (string) $payload['media_key'] : '';
		$body      = isset( $payload['body'] ) && is_string( $payload['body'] ) ? $payload['body'] : '';
		$filename  = isset( $payload['filename'] ) ? (string) $payload['filename'] : '';
		$mime      = isset( $payload['mime'] ) && is_string( $payload['mime'] ) ? $payload['mime'] : '';

		$length = strlen( $body );
		if ( 0 === $length ) {
			return new WP_Error( 'newsroom_media_empty', 'Empty media body rejected.', array( 'status' => 400 ) );
		}
		if ( $length > $this->config->max_bytes() ) {
			return new WP_Error( 'newsroom_media_too_large', 'Media body exceeds the byte limit.', array( 'status' => 413 ) );
		}

		$body_sha256   = hash( 'sha256', $body );
		$filename_hash = hash( 'sha256', $filename );
		$fingerprint   = self::payload_fingerprint( $body_sha256, $filename_hash, $mime );

		$reservation_token = strtolower( (string) wp_generate_uuid4() );
		if ( ! $this->is_canonical_uuid_v4( $reservation_token ) ) {
			return $this->storage_error( 'A media reservation token could not be generated.' );
		}

		if ( ! $this->database->begin() ) {
			return $this->storage_error( 'The media transaction could not start.' );
		}

		$reservation_result = $this->database->reserve( $media_key, $fingerprint, $length, get_current_user_id(), $reservation_token );
		if ( is_wp_error( $reservation_result ) ) {
			$this->database->rollback();
			return $reservation_result;
		}

		$mapping = $this->database->get_for_update( $media_key );
		if ( is_wp_error( $mapping ) ) {
			$this->database->rollback();
			return $mapping;
		}

		if ( ! is_array( $mapping ) ) {
			$this->database->rollback();
			return $this->storage_error( 'The reserved media mapping could not be locked.' );
		}

		$owns_reservation = isset( $mapping['reservation_token'] ) && $mapping['reservation_token'] === $reservation_token;
		if ( ! $owns_reservation ) {
			$decision = $this->decide_rival( $mapping, $fingerprint, $reservation_token );
			if ( is_wp_error( $decision ) ) {
				$this->database->rollback();
				return $decision;
			}

			if ( true === $decision ) {
				$owns_reservation = true;
			} else {
				if ( ! $this->database->commit() ) {
					return $this->uncertain_outcome( 0 );
				}

				$decision['replayed'] = true;
				return $decision;
			}
		}

		if ( ! $owns_reservation ) {
			$this->database->rollback();
			return $this->storage_error( 'Media reservation ownership could not be established.' );
		}

		$attachment_id = $this->create_attachment( $body, $filename, $mime, $media_key, $reservation_token );
		if ( is_wp_error( $attachment_id ) ) {
			$this->database->rollback();
			$this->database->delete_row_if_token( $media_key, $reservation_token );
			return $attachment_id;
		}

		if ( ! $this->database->commit_attachment( $media_key, $reservation_token, $attachment_id ) ) {
			return $this->uncertain_outcome( $attachment_id );
		}

		if ( ! $this->database->commit() ) {
			return $this->uncertain_outcome( $attachment_id );
		}

		return array(
			'media_key'     => $media_key,
			'attachment_id' => $attachment_id,
			'status'        => 'attachment',
			'replayed'      => false,
		);
	}

	public function lookup( $media_key ) {
		$ready = $this->database->assert_ready_and_transactional();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}

		$mapping = $this->database->get( $media_key );
		if ( is_wp_error( $mapping ) ) {
			return $mapping;
		}

		if ( null === $mapping ) {
			return new WP_Error(
				'newsroom_media_not_found',
				'No media mapping exists for this media key.',
				array( 'status' => 404 )
			);
		}

		if ( null === $mapping['attachment_id'] ) {
			return array(
				'media_key'     => (string) $mapping['media_key'],
				'attachment_id' => null,
				'status'        => 'reserved',
				'replayed'      => false,
			);
		}

		return $this->healthy_mapping( $mapping, get_current_user_id() );
	}

	/**
	 * Decides a rival (already-reserved) media key. Returns:
	 *   - array   replay mapping (healthy, same payload, attachment committed)
	 *   - true    stale reservation reclaimed; caller continues as owner
	 *   - WP_Error conflict / in-progress
	 */
	private function decide_rival( array $mapping, $fingerprint, $reservation_token ) {
		if ( ! hash_equals( (string) $mapping['payload_hash'], $fingerprint ) ) {
			return new WP_Error(
				'newsroom_media_idempotency_conflict',
				'This media key is already bound to a different creation payload.',
				array( 'status' => 409 )
			);
		}

		if ( ! empty( $mapping['attachment_id'] ) ) {
			return $this->healthy_mapping( $mapping, get_current_user_id() );
		}

		$rival_token = isset( $mapping['reservation_token'] ) ? (string) $mapping['reservation_token'] : '';
		if (
			'' === $rival_token
			|| ! $this->database->maybe_reclaim( (string) $mapping['media_key'], $rival_token, $reservation_token, self::STALE_RESERVATION_SECONDS )
		) {
			return new WP_Error(
				'newsroom_media_reservation_in_progress',
				'Media creation is already in progress.',
				array( 'status' => 503 )
			);
		}

		return true;
	}

	private function create_attachment( $body, $filename, $mime, $media_key, $reservation_token ) {
		if ( ! function_exists( 'wp_generate_attachment_metadata' ) ) {
			require_once ABSPATH . 'wp-admin/includes/image.php';
		}

		$validation = $this->validate_upload( $filename, $mime, $body );
		if ( is_wp_error( $validation ) ) {
			return $validation;
		}

		$title    = $validation;
		$uploaded = wp_upload_bits( $title, null, $body );
		if ( is_string( $uploaded['error'] ) && '' !== $uploaded['error'] ) {
			return $this->storage_error( 'Media could not be written to the upload directory.' );
		}

		$filepath    = is_string( $uploaded['file'] ) ? $uploaded['file'] : '';
		$filetype    = wp_check_filetype_and_ext( $filepath, basename( $filepath ) );
		$filetype_ok = is_array( $filetype ) && is_string( $filetype['type'] )
			&& ( 'image/jpeg' === $mime ? 'image/jpeg' === $filetype['type'] : $filetype['type'] === $mime );
		if ( ! $filetype_ok ) {
			wp_delete_file( $filepath );
			return new WP_Error(
				'newsroom_media_invalid',
				'WordPress file-type check rejected the upload.',
				array( 'status' => 400 )
			);
		}

		$attachment_id = wp_insert_attachment(
			array(
				'post_title'     => $title,
				'post_mime_type' => $mime,
				'post_status'    => 'inherit',
				'post_author'    => get_current_user_id(),
				'guid'           => is_string( $uploaded['url'] ) ? $uploaded['url'] : '',
			),
			$filepath,
			0,
			true
		);
		if ( is_wp_error( $attachment_id ) ) {
			wp_delete_file( $filepath );
			return $this->storage_error( 'Media could not be registered as an attachment.' );
		}

		update_post_meta( $attachment_id, self::MEDIA_KEY_META, $media_key );
		update_post_meta( $attachment_id, self::MEDIA_FILE_META, $filepath );

		$metadata = wp_generate_attachment_metadata( $attachment_id, $filepath );
		if ( ! is_array( $metadata ) ) {
			wp_delete_attachment( $attachment_id, true );
			return $this->storage_error( 'Media metadata could not be generated.' );
		}
		wp_update_attachment_metadata( $attachment_id, $metadata );

		return $attachment_id;
	}

	private function healthy_mapping( array $mapping, $actor_user_id ) {
		$attachment_id = (int) $mapping['attachment_id'];
		if ( empty( $attachment_id ) || null !== $mapping['reservation_token'] ) {
			return new WP_Error(
				'newsroom_media_corrupt',
				'The media mapping is incomplete and requires operator review.',
				array( 'status' => 409 )
			);
		}

		if ( (int) $mapping['actor_user_id'] !== (int) $actor_user_id ) {
			return new WP_Error(
				'newsroom_bridge_forbidden',
				'This media mapping is not accessible to the current user.',
				array( 'status' => 403 )
			);
		}

		$attachment = get_post( $attachment_id );
		if ( ! $attachment ) {
			return new WP_Error(
				'newsroom_media_target_missing',
				'The mapped WordPress attachment is missing and the key is already committed.',
				array( 'status' => 409 )
			);
		}

		if ( 'attachment' !== $attachment->post_type ) {
			return new WP_Error(
				'newsroom_media_corrupt',
				'The media mapping points to an unexpected object type.',
				array( 'status' => 409 )
			);
		}

		if ( ! hash_equals( (string) get_post_meta( $attachment_id, self::MEDIA_KEY_META, true ), (string) $mapping['media_key'] ) ) {
			return new WP_Error(
				'newsroom_media_corrupt',
				'The media mapping does not match its attachment binding.',
				array( 'status' => 409 )
			);
		}

		return array(
			'media_key'     => (string) $mapping['media_key'],
			'attachment_id' => $attachment_id,
			'status'        => 'attachment',
			'replayed'      => false,
		);
	}

	private function validate_upload( $filename, $mime, $body ) {
		$sanitized = sanitize_file_name( $filename );
		if ( '' === $sanitized || '.' === $sanitized || '..' === $sanitized || 0 === strpos( $sanitized, '.' ) ) {
			return new WP_Error( 'newsroom_media_invalid', 'Unsafe media filename rejected.', array( 'status' => 400 ) );
		}

		if ( ! array_key_exists( $mime, Newsroom_Bridge_Media_Auth::MIME_EXTENSIONS ) ) {
			return new WP_Error( 'newsroom_media_invalid', 'Unsupported media MIME type rejected.', array( 'status' => 400 ) );
		}

		$extension  = strtolower( pathinfo( $sanitized, PATHINFO_EXTENSION ) );
		$allowed    = Newsroom_Bridge_Media_Auth::MIME_EXTENSIONS[ $mime ];
		$extensions = 'image/jpeg' === $mime ? array( 'jpg', 'jpeg' ) : array( $allowed );
		if ( ! in_array( $extension, $extensions, true ) ) {
			return new WP_Error( 'newsroom_media_invalid', 'Media filename extension does not match the claimed MIME.', array( 'status' => 400 ) );
		}

		$detected = $this->detected_mime( $body );
		if ( ! is_string( $detected ) || $detected !== $mime ) {
			return new WP_Error( 'newsroom_media_invalid', 'Claimed MIME does not match the detected image content.', array( 'status' => 400 ) );
		}

		return pathinfo( $sanitized, PATHINFO_BASENAME );
	}

	private function detected_mime( $body ) {
		$size = getimagesizefromstring( $body );
		if ( ! is_array( $size ) || empty( $size['mime'] ) ) {
			return null;
		}

		return $size['mime'];
	}

	private function is_canonical_uuid_v4( $value ) {
		return is_string( $value )
			&& 1 === preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $value )
			&& wp_is_uuid( $value, 4 );
	}

	private function storage_error( $message ) {
		return new WP_Error(
			'newsroom_media_storage_error',
			$message,
			array( 'status' => 503 )
		);
	}

	private function uncertain_outcome( $attachment_id ) {
		$this->database->rollback();
		if ( $attachment_id > 0 ) {
			wp_delete_attachment( $attachment_id, true );
			clean_post_cache( $attachment_id );
		}

		return new WP_Error(
			'newsroom_media_outcome_uncertain',
			'The media transaction outcome is uncertain; reconcile this media key before any create retry.',
			array( 'status' => 503 )
		);
	}
}