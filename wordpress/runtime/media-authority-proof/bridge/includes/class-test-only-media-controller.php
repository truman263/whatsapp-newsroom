<?php
/**
 * TEST-ONLY disposable media controller.
 *
 * NOT PRODUCTION CODE. Media create + reconciliation GET over the approved
 * positive route allow-list, price-identity upload pipeline, deterministic
 * media-key idempotency, bounded orphan recovery, and injected phase faults
 * used by the disposable proof.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // TEST-ONLY prototype.
}

final class Test_Only_Media_Controller {

	const MEDIA_KEY_META = '_newsroom_media_key';
	const MEDIA_FILE_META = '_newsroom_media_file';
	const STALE_RESERVATION_SECONDS = 30;

	private $config;
	private $store;

	public function __construct( Test_Only_Media_Config $config ) {
		$this->config = $config;
		$this->store  = new Test_Only_Media_Store();
	}

	public function register() {
		add_filter( 'wp_is_application_passwords_available_for_user', array( $this, 'filter_application_password_availability' ), PHP_INT_MAX, 2 );
		add_filter( 'authenticate', array( $this, 'deny_generic_authentication' ), PHP_INT_MAX, 3 );
		add_filter( 'upload_dir', array( $this, 'filter_upload_dir' ) );
	}

	/**
	 * REST route registration must run on rest_api_init (never during
	 * plugins_loaded): calling register_rest_route() too early forces the REST
	 * server to build the default routes before $wp_rewrite is initialised.
	 * TEST-ONLY; the production bridge uses the same timing.
	 */
	public function register_routes() {
		register_rest_route(
			'newsroom-media/v1',
			'/media',
			array(
				'methods'             => 'POST',
				'callback'            => array( $this, 'create_media' ),
				'permission_callback' => array( $this, 'permission_check' ),
			)
		);
		register_rest_route(
			'newsroom-media/v1',
			'/media/(?P<media_key>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'get_media' ),
				'permission_callback' => array( $this, 'permission_check' ),
			)
		);
	}

	/**
	 * Isolate every upload in this disposable runtime into a media-managed
	 * sub-directory so the proof can reason about orphan files deterministically.
	 * TEST-ONLY; production media will scope uploads the same way.
	 */
	public function filter_upload_dir( $dirs ) {
		if ( ! is_array( $dirs ) || ! isset( $dirs['path'], $dirs['url'], $dirs['subdir'] ) ) {
			return $dirs;
		}
		$dirs['path']   = rtrim( $dirs['path'], '/' ) . '/newsroom-media';
		$dirs['url']    = rtrim( $dirs['url'], '/' ) . '/newsroom-media';
		$dirs['subdir'] = rtrim( $dirs['subdir'], '/' ) . '/newsroom-media';
		return $dirs;
	}

	public function register_activation() {
		$this->store->install_schema();
	}

	public function permission_check() {
		return true;
	}

	public function filter_application_password_availability( $available, $user ) {
		if ( $this->config->lockdown_is_enabled() && $this->is_service_identity( $user ) ) {
			return false;
		}
		return $available;
	}

	public function deny_generic_authentication( $user, $username, $password = null ) {
		unset( $password );
		if ( ! $this->config->lockdown_is_enabled() || ! $this->config->user_id_is_valid() ) {
			return $user;
		}
		$is_service = $this->is_service_identity( $user );
		$service    = get_user_by( 'id', $this->config->user_id() );
		if ( $service instanceof WP_User && is_string( $username ) ) {
			$is_service = $is_service || hash_equals( (string) $service->user_login, $username );
			$is_service = $is_service || hash_equals( (string) $service->user_email, $username );
		}
		if ( $is_service ) {
			return new WP_Error( 'newsroom_media_service_authentication_disabled', 'Authentication failed.' );
		}
		return $user;
	}

	public function create_media( $request ) {
		global $wpdb;

		// wp_generate_attachment_metadata() and friends live in wp-admin/admin
		// includes, which are not loaded for front-end REST requests. Core's own
		// wp/v2/media handler requires the same file before generating metadata.
		if ( ! function_exists( 'wp_generate_attachment_metadata' ) ) {
			require_once ABSPATH . 'wp-admin/includes/image.php';
		}

		$proof = $this->proof();
		$body  = $proof['body'];

		$length = strlen( $body );
		if ( 0 === $length ) {
			return new WP_Error( 'newsroom_media_empty', 'Empty media body rejected.', array( 'status' => 400 ) );
		}
		if ( $length > $this->config->max_bytes() ) {
			return new WP_Error( 'newsroom_media_too_large', 'Media body exceeds the byte limit.', array( 'status' => 413 ) );
		}

		$media_key    = $proof['media_key'];
		$filename     = $proof['filename'];
		$mime         = $proof['mime'];
		$body_sha256  = hash( 'sha256', $body );
		$filename_hash = hash( 'sha256', $filename );
		$fingerprint  = Test_Only_Media_Store::payload_fingerprint( $body_sha256, $filename_hash, $mime );

		$token = wp_generate_uuid4();
		$owner = false;
		$row   = null;

		for ( $attempt = 0; $attempt < 5; $attempt++ ) {
			$row = $this->store->row_by_key( $media_key );
			if ( null === $row ) {
				if ( $this->store->try_insert_reservation( $media_key, $fingerprint, $length, get_current_user_id(), $token ) ) {
					$owner = true;
					break;
				}
				continue;
			}
			if ( ! hash_equals( (string) $row['payload_hash'], $fingerprint ) ) {
				return new WP_Error(
					'newsroom_media_idempotency_conflict',
					'Media key is already bound to a different payload.',
					array( 'status' => 409 )
				);
			}
			if ( null !== $row['attachment_id'] ) {
				return $this->attachment_response( $media_key, (int) $row['attachment_id'], true );
			}
			if ( $this->try_stale_reclaim( $media_key, $row['reservation_token'], $token ) ) {
				$owner = true;
				break;
			}
			usleep( 150000 );
		}

		if ( ! $owner ) {
			return new WP_Error(
				'newsroom_media_reservation_in_progress',
				'Media creation is already in progress.',
				array( 'status' => 503 )
			);
		}

		$phase = $this->fault_phase();
		if ( 'after_reservation' === $phase ) {
			throw new RuntimeException( 'TEST-MEDIA-FAULT:after_reservation' );
		}

		$validation = $this->validate_upload( $filename, $mime, $body );
		if ( is_wp_error( $validation ) ) {
			$this->store->delete_row( $media_key );
			return $validation;
		}

		$uploaded = wp_upload_bits( $filename, null, $body );
		if ( is_string( $uploaded['error'] ) && '' !== $uploaded['error'] ) {
			throw new RuntimeException( 'TEST-MEDIA-FAULT:upload_error' );
		}

		if ( 'after_file' === $phase ) {
			throw new RuntimeException( 'TEST-MEDIA-FAULT:after_file' );
		}

		$filetype = wp_check_filetype_and_ext( $uploaded['file'], basename( $uploaded['file'] ) );
		$filetype_ok = is_array( $filetype ) && is_string( $filetype['type'] )
			&& ( 'image/jpeg' === $mime ? 'image/jpeg' === $filetype['type'] : $filetype['type'] === $mime );
		if ( ! $filetype_ok ) {
			wp_delete_file( $uploaded['file'] );
			$this->store->delete_row( $media_key );
			return new WP_Error( 'newsroom_media_invalid', 'WordPress file-type check rejected the upload.', array( 'status' => 400 ) );
		}

		$attachment_id = wp_insert_attachment(
			array(
				'post_title'     => $validation,
				'post_mime_type' => $mime,
				'post_status'    => 'inherit',
				'post_author'    => get_current_user_id(),
				'guid'           => $uploaded['url'],
			),
			$uploaded['file'],
			0,
			true
		);
		if ( is_wp_error( $attachment_id ) ) {
			wp_delete_file( $uploaded['file'] );
			throw new RuntimeException( 'TEST-MEDIA-FAULT:insert_error' );
		}

		update_post_meta( $attachment_id, self::MEDIA_KEY_META, $media_key );
		update_post_meta( $attachment_id, self::MEDIA_FILE_META, $uploaded['file'] );

		if ( 'after_insert' === $phase ) {
			throw new RuntimeException( 'TEST-MEDIA-FAULT:after_insert' );
		}

		if ( 'during_metadata' === $phase ) {
			wp_delete_attachment( $attachment_id, true );
			$this->store->delete_row( $media_key );
			throw new RuntimeException( 'TEST-MEDIA-FAULT:during_metadata' );
		}

		$metadata = wp_generate_attachment_metadata( $attachment_id, $uploaded['file'] );
		if ( ! is_array( $metadata ) ) {
			wp_delete_attachment( $attachment_id, true );
			$this->store->delete_row( $media_key );
			throw new RuntimeException( 'TEST-MEDIA-FAULT:metadata_error' );
		}
		wp_update_attachment_metadata( $attachment_id, $metadata );

		if ( ! $this->store->commit_attachment( $media_key, $attachment_id, $token ) ) {
			throw new RuntimeException( 'TEST-MEDIA-FAULT:commit_error' );
		}

		if ( 'after_mapping' === $phase ) {
			throw new RuntimeException( 'TEST-MEDIA-FAULT:after_mapping' );
		}

		return $this->attachment_response( $media_key, $attachment_id, false );
	}

	public function get_media( $request ) {
		$media_key = $request->get_param( 'media_key' );
		if ( ! is_string( $media_key ) ) {
			return new WP_Error( 'newsroom_media_not_found', 'Media not found.', array( 'status' => 404 ) );
		}
		$row = $this->store->row_by_key( $media_key );
		if ( null === $row ) {
			return new WP_Error( 'newsroom_media_not_found', 'Media not found.', array( 'status' => 404 ) );
		}
		if ( null === $row['attachment_id'] ) {
			return new WP_REST_Response(
				array(
					'media_key'     => $media_key,
					'attachment_id' => null,
					'status'        => 'reserved',
					'replayed'      => false,
				),
				200
			);
		}
		return $this->attachment_response( $media_key, (int) $row['attachment_id'], true );
	}

	/**
	 * Deterministic garbage-collection pass for bounded orphan recovery.
	 * Pass 1: adopt an attachment whose media-key meta references an existing
	 * reserved row (repairs the after-insert window). Pass 2: delete orphan
	 * attachments that carry a media-key meta but have no reconciliation row,
	 * together with their uploaded files. Pass 3: delete uploaded files not
	 * referenced by any attachment (repairs the after-file window).
	 *
	 * TEST-ONLY; exposed through the disposable CLI probe only.
	 */
	public function garbage_collect() {
		global $wpdb;

		$table = $wpdb->prefix . 'newsroom_media';
		$adopted = 0;
		$deleted_attachments = 0;
		$deleted_files = 0;

		$pending = $wpdb->get_results( "SELECT m.media_key FROM {$table} m WHERE m.attachment_id IS NULL", ARRAY_A );
		foreach ( $pending as $row ) {
			$attachments = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT post_id FROM {$wpdb->postmeta} pm WHERE pm.meta_key = %s AND pm.meta_value = %s LIMIT 1",
					self::MEDIA_KEY_META,
					$row['media_key']
				),
				ARRAY_A
			);
			if ( ! empty( $attachments ) ) {
				$attachment_id = (int) $attachments[0]['post_id'];
				$this->store->set_reservation_token( $row['media_key'], wp_generate_uuid4() );
				$token = $this->store->row_by_key( $row['media_key'] );
				$token_value = is_array( $token ) && is_string( $token['reservation_token'] ) ? $token['reservation_token'] : '';
				if ( '' !== $token_value ) {
					$this->store->commit_attachment( $row['media_key'], $attachment_id, $token_value );
					$adopted++;
				}
			}
		}

		$orphan_attachments = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT pm.post_id FROM {$wpdb->postmeta} pm WHERE pm.meta_key = %s AND NOT EXISTS ( SELECT 1 FROM {$table} m WHERE m.media_key = pm.meta_value )",
				self::MEDIA_KEY_META
			),
			ARRAY_A
		);
		foreach ( $orphan_attachments as $orphan ) {
			$file = (string) get_post_meta( (int) $orphan->post_id, self::MEDIA_FILE_META, true );
			if ( '' !== $file && file_exists( $file ) ) {
				wp_delete_file( $file );
				$deleted_files++;
			}
			wp_delete_attachment( (int) $orphan->post_id, true );
			$deleted_attachments++;
		}

		$upload_dir = wp_upload_dir();
		$base       = $upload_dir['path'];
		if ( is_dir( $base ) ) {
			$media_files   = array_map( 'strval', $wpdb->get_col( "SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = '" . self::MEDIA_FILE_META . "'" ) );
			$attached_file = $basedir = wp_upload_dir()['basedir'];
			$referenced    = array();
			foreach ( $media_files as $file ) {
				if ( '' !== $file ) {
					$referenced[ $file ] = true;
				}
			}
			foreach ( array_map( 'strval', $wpdb->get_col( "SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = '_wp_attached_file'" ) ) as $file ) {
				if ( '' !== $file ) {
					$referenced[ $attached_file . '/' . ltrim( str_replace( '\\', '/', $file ), '/' ) ] = true;
				}
			}
			$referenced_bases = array();
			foreach ( array_keys( $referenced ) as $path ) {
				if ( 0 !== strpos( $path, $base . '/' ) ) {
					continue;
				}
				$referenced_bases[ basename( $path ) ] = true;
			}
			foreach ( scandir( $base ) as $entry ) {
				if ( '.' === $entry || '..' === $entry ) {
					continue;
				}
				if ( is_dir( $base . '/' . $entry ) ) {
					continue;
				}
				$path = $base . '/' . $entry;
				if ( isset( $referenced[ $path ] ) ) {
					continue;
				}
				$parts = pathinfo( $entry );
				$base_name = isset( $parts['filename'] ) ? (string) $parts['filename'] : $entry;
				$extension = isset( $parts['extension'] ) ? (string) $parts['extension'] : '';
				if ( 1 === preg_match( '/\A(.+)-([0-9]+)x([0-9]+)\z/', $base_name, $m ) && isset( $referenced_bases[ $m[1] . '.' . $extension ] ) ) {
					continue;
				}
				wp_delete_file( $path );
				$deleted_files++;
			}
		}

		return array(
			'adopted'              => $adopted,
			'deleted_attachments'  => $deleted_attachments,
			'deleted_files'        => $deleted_files,
		);
	}

	private function proof() {
		static $auth = null;
		if ( null === $auth ) {
			$auth = Test_Only_Media_Plugin::auth_instance();
		}
		$proof = $auth->proof();
		if ( ! is_array( $proof ) || empty( $proof['body'] ) && ! array_key_exists( 'body', $proof ) ) {
			throw new RuntimeException( 'TEST-MEDIA-FAULT:missing_proof' );
		}
		return $proof;
	}

	private function try_stale_reclaim( $media_key, $expected_token, $token ) {
		if ( ! is_string( $expected_token ) || '' === $expected_token ) {
			return false;
		}
		return $this->store->maybe_reclaim( $media_key, $expected_token, $token, self::STALE_RESERVATION_SECONDS );
	}

	private function validate_upload( $filename, $mime, $body ) {
		$sanitized = sanitize_file_name( $filename );
		if ( '' === $sanitized || '.' === $sanitized || '..' === $sanitized || 0 === strpos( $sanitized, '.' ) ) {
			return new WP_Error( 'newsroom_media_invalid', 'Unsafe media filename rejected.', array( 'status' => 400 ) );
		}

		$extension    = strtolower( pathinfo( $sanitized, PATHINFO_EXTENSION ) );
		$allowed_exts = Test_Only_Media_Auth::MIME_EXTENSIONS[ $mime ];
		$extensions   = 'image/jpeg' === $mime ? array( 'jpg', 'jpeg' ) : array( $allowed_exts );
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

	private function fault_phase() {
		$phase = get_option( 'test_media_fault_phase', 'none' );
		return is_string( $phase ) && in_array( $phase, array( 'after_reservation', 'after_file', 'after_insert', 'during_metadata', 'after_mapping' ), true )
			? $phase
			: 'none';
	}

	private function attachment_response( $media_key, $attachment_id, $replayed ) {
		return new WP_REST_Response(
			array(
				'media_key'     => $media_key,
				'attachment_id' => $attachment_id,
				'status'        => 'attachment',
				'replayed'      => $replayed,
			),
			$replayed ? 200 : 201
		);
	}

	private function is_service_identity( $user ) {
		return $this->config->user_id_is_valid()
			&& $user instanceof WP_User
			&& (int) $user->ID === $this->config->user_id();
	}

}