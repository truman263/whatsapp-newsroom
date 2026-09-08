<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * REST surface of the newsroom media bridge: media-managed uploads, bounded
 * orphan recovery, and scoped media responses.
 */
final class Newsroom_Bridge_Media_REST {
	private const MEDIA_KEY_PATTERN = '/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/D';
	private const MEDIA_KEY_META = '_newsroom_media_key';
	private const MEDIA_FILE_META = '_newsroom_media_file';
	private const GC_GATE = 'newsroom_bridge_media_gc_gate';
	private const GC_INTERVAL = HOUR_IN_SECONDS;

	private $auth;
	private $reconciliation;
	private $database;
	private $config;
	private $media_uploads_active = false;

	public function __construct(
		Newsroom_Bridge_Media_Auth $auth,
		Newsroom_Bridge_Media_Reconciliation $reconciliation,
		Newsroom_Bridge_Media_DB $database,
		Newsroom_Bridge_Media_Config $config
	) {
		$this->auth           = $auth;
		$this->reconciliation = $reconciliation;
		$this->database       = $database;
		$this->config         = $config;
	}

	public function register() {
		add_filter( 'upload_dir', array( $this, 'filter_upload_dir' ) );
	}

	/**
	 * REST route registration must run on rest_api_init (never during
	 * plugins_loaded): calling register_rest_route() too early forces the REST
	 * server to build the default routes before $wp_rewrite is initialised.
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

	public function permission_check() {
		if ( ! $this->config->prerequisites_are_valid() ) {
			return new WP_Error(
				'newsroom_bridge_media_not_configured',
				'Newsroom Bridge media configuration requires a service user and an HMAC key.',
				array( 'status' => 503 )
			);
		}

		if ( get_current_user_id() !== $this->config->user_id() || ! current_user_can( 'upload_files' ) ) {
			return new WP_Error(
				'newsroom_bridge_forbidden',
				'The current user may not access newsroom media.',
				array( 'status' => 403 )
			);
		}

		$this->maybe_garbage_collect();

		return true;
	}

	/**
	 * Idempotent, rate-limited orphan recovery: at most one GC pass per
	 * interval, only while a verified media request is being served.
	 */
	private function maybe_garbage_collect() {
		if ( false !== get_transient( self::GC_GATE ) ) {
			return;
		}

		set_transient( self::GC_GATE, 1, self::GC_INTERVAL );
		$this->garbage_collect();
	}

	/**
	 * Isolate media uploads into a media-managed sub-directory, only while the
	 * verified media pipeline (or its recovery pass) is executing.
	 */
	public function filter_upload_dir( $dirs ) {
		if ( ! $this->media_uploads_active || ! is_array( $dirs ) || ! isset( $dirs['path'], $dirs['url'], $dirs['subdir'] ) ) {
			return $dirs;
		}

		$dirs['path']   = rtrim( (string) $dirs['path'], '/' ) . '/newsroom-media';
		$dirs['url']    = rtrim( (string) $dirs['url'], '/' ) . '/newsroom-media';
		$dirs['subdir'] = rtrim( (string) $dirs['subdir'], '/' ) . '/newsroom-media';
		return $dirs;
	}

	public function create_media( $request ) {
		unset( $request );
		$proof = $this->auth->proof();
		if ( ! is_array( $proof ) || empty( $proof['body'] ) && ! array_key_exists( 'body', $proof ) ) {
			return new WP_Error(
				'newsroom_media_storage_error',
				'The verified media payload is unavailable.',
				array( 'status' => 503 )
			);
		}

		$this->scope_media_uploads( true );
		try {
			$result = $this->reconciliation->create_media(
				array(
					'media_key' => (string) $proof['media_key'],
					'body'      => (string) $proof['body'],
					'filename'  => (string) $proof['filename'],
					'mime'      => (string) $proof['mime'],
				)
			);
		} finally {
			$this->scope_media_uploads( false );
		}

		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return $this->media_response( $result );
	}

	public function get_media( $request ) {
		$media_key = $request->get_param( 'media_key' );
		if ( ! is_string( $media_key ) || 1 !== preg_match( self::MEDIA_KEY_PATTERN, $media_key ) ) {
			return new WP_Error( 'newsroom_media_not_found', 'Media not found.', array( 'status' => 404 ) );
		}

		$result = $this->reconciliation->lookup( $media_key );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		$result['replayed'] = 'attachment' === $result['status'];
		return $this->media_response( $result );
	}

	/**
	 * Bounded recovery pass for crashed-media orphans. Pass 1 adopts an
	 * attachment whose media-key meta references an existing reserved row.
	 * Pass 2 deletes orphan attachments carrying a media-key meta without a
	 * reconciliation row, together with their uploaded files. Pass 3 deletes
	 * files inside the media-managed directory not referenced by any attachment.
	 */
	public function garbage_collect() {
		global $wpdb;

		$this->scope_media_uploads( true );
		try {
			$table = $this->database->table_name();
			$adopted = 0;
			$deleted_attachments = 0;
			$deleted_files = 0;

			$pending = $wpdb->get_results( "SELECT media_key FROM {$table} WHERE attachment_id IS NULL", ARRAY_A );
			foreach ( is_array( $pending ) ? $pending : array() as $row ) {
				$attachment_id = $this->attachment_with_key( (string) $row['media_key'] );
				if ( $attachment_id <= 0 ) {
					continue;
				}
				$token = strtolower( (string) wp_generate_uuid4() );
				if ( ! $this->database->set_reservation_token( (string) $row['media_key'], $token )
					|| ! $this->database->commit_attachment( (string) $row['media_key'], $token, $attachment_id ) ) {
					continue;
				}
				$adopted++;
			}

			$orphan_attachments = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT pm.post_id FROM {$wpdb->postmeta} pm WHERE pm.meta_key = %s AND NOT EXISTS ( SELECT 1 FROM {$table} m WHERE m.media_key = pm.meta_value )",
					self::MEDIA_KEY_META
				),
				ARRAY_A
			);
			foreach ( is_array( $orphan_attachments ) ? $orphan_attachments : array() as $orphan ) {
				$file = (string) get_post_meta( (int) $orphan['post_id'], self::MEDIA_FILE_META, true );
				if ( '' !== $file && file_exists( $file ) ) {
					wp_delete_file( $file );
					$deleted_files++;
				}
				wp_delete_attachment( (int) $orphan['post_id'], true );
				$deleted_attachments++;
			}

			$base      = $this->managed_media_directory();
			$reference = $this->referenced_media_files( $base );
			if ( is_dir( $base ) ) {
				foreach ( scandir( $base ) as $entry ) {
					if ( '.' === $entry || '..' === $entry ) {
						continue;
					}
					$path = $base . '/' . $entry;
					if ( is_dir( $path ) || isset( $reference['files'][ $path ] ) ) {
						continue;
					}
					if ( $this->is_sized_variant( $entry, $reference ) ) {
						continue;
					}
					wp_delete_file( $path );
					$deleted_files++;
				}
			}

			return array(
				'adopted'             => $adopted,
				'deleted_attachments' => $deleted_attachments,
				'deleted_files'       => $deleted_files,
			);
		} finally {
			$this->scope_media_uploads( false );
		}
	}

	private function scope_media_uploads( $active ) {
		$this->media_uploads_active = (bool) $active;
	}

	private function media_response( array $result ) {
		$status_code = 'reserved' === $result['status'] || ! empty( $result['replayed'] ) ? 200 : 201;
		return new WP_REST_Response( $result, $status_code );
	}

	private function attachment_with_key( $media_key ) {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = %s AND meta_value = %s LIMIT 1",
				self::MEDIA_KEY_META,
				$media_key
			),
			ARRAY_A
		);
		return is_array( $row ) ? (int) $row['post_id'] : 0;
	}

	private function managed_media_directory() {
		$upload_dir = wp_upload_dir();
		return is_string( $upload_dir['path'] ) ? rtrim( $upload_dir['path'], '/' ) : '';
	}

	private function referenced_media_files( $base ) {
		global $wpdb;

		$referenced = array();
		foreach ( (array) $wpdb->get_col( "SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = '" . self::MEDIA_FILE_META . "'" ) as $file ) {
			if ( is_string( $file ) && '' !== $file ) {
				$referenced[ $file ] = true;
			}
		}

		$basedir = wp_upload_dir()['basedir'];
		foreach ( (array) $wpdb->get_col( "SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = '_wp_attached_file'" ) as $file ) {
			if ( is_string( $file ) && '' !== $file ) {
				$referenced[ $basedir . '/' . ltrim( str_replace( '\\', '/', $file ), '/' ) ] = true;
			}
		}

		$bases = array();
		foreach ( array_keys( $referenced ) as $path ) {
			if ( is_string( $path ) && 0 === strpos( $path, $base . '/' ) ) {
				$bases[ basename( $path ) ] = true;
			}
		}

		return array( 'files' => $referenced, 'bases_in_scope' => $bases );
	}

	private function is_sized_variant( $entry, array $reference ) {
		if ( 1 !== preg_match( '/\A(.+)-([0-9]+)x([0-9]+)\.([A-Za-z0-9]+)\z/', $entry, $matches ) ) {
			return false;
		}

		$base_name = $matches[1] . '.' . strtolower( $matches[4] );
		return isset( $reference['bases_in_scope'][ $base_name ] );
	}
}