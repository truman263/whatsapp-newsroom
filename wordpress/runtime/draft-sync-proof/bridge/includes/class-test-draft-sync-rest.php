<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! defined( 'NEWSROOM_DRAFT_SYNC_PROOF' ) || true !== NEWSROOM_DRAFT_SYNC_PROOF ) {
	exit;
}

/**
 * TEST-ONLY full-state draft sync surface (Round 2B.4A).
 *
 * PUT /newsroom/v1/drafts/{draft_key}  replaces the complete draft state
 *   {title, content, excerpt, categories, featured_media_key}. The author and
 *   status are never touched; featured_media_key identity-scoped validation
 *   resolves only media-key-managed attachments. null clears _thumbnail_id.
 *
 * GET /newsroom/v1/drafts/{draft_key}/state  returns the canonical applied
 *   state plus applied_version, used by the reconciliation client (the 2B.4B
 *   production surface will fold this read into the canonical state GET).
 *
 * The PUT contract additionally accepts an OPTIONAL expected_version — a
 * sha256 fingerprint of the canonical applied state the caller last observed.
 * When present and stale, the sync is rejected with 409
 * (newsroom_draft_sync_stale_version) instead of silently last-write-winning.
 * The comparison runs INSIDE the sync transaction under a writer lock on the
 * mapping row, so concurrent CAS writers produce exactly one winner per
 * version and never an accidental double write.
 * This is the WordPress-surface CAS guard; the 2B.4B backend pairs it with
 * the authoritative Story.version CAS before it ever calls WordPress.
 *
 * The frozen production Newsroom_Bridge_DB, Newsroom_Bridge_Reconciliation
 * and Newsroom_Bridge_Media_DB classes are reused verbatim. The only direct
 * SQL here refreshes the reconciliation payload_hash after a sync so the
 * frozen create/idempotency semantics track the synced state truthfully.
 */
final class Newsroom_Bridge_Draft_Sync_REST {
	private const NAMESPACE = 'newsroom/v1';
	private const SYNC_CONTRACT_VERSION = 1;
	private const ALLOWED_MIME = array( 'image/png', 'image/jpeg', 'image/webp', 'image/gif' );
	private const MEDIA_KEY_META = '_newsroom_media_key';
	private const MEDIA_FILE_META = '_newsroom_media_file';

	private $database;
	private $media_database;
	private $reconciliation;

	public function __construct(
		Newsroom_Bridge_DB $database,
		Newsroom_Bridge_Media_DB $media_database,
		Newsroom_Bridge_Reconciliation $reconciliation
	) {
		$this->database       = $database;
		$this->media_database = $media_database;
		$this->reconciliation = $reconciliation;
	}

	public function register_routes() {
		register_rest_route(
			self::NAMESPACE,
			'/drafts/(?P<draft_key>[a-f0-9-]{36})',
			array(
				'methods'             => 'PUT',
				'callback'            => array( $this, 'sync_draft' ),
				'permission_callback' => array( $this, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/drafts/(?P<draft_key>[a-f0-9-]{36})/state',
			array(
				'methods'             => 'GET',
				'callback'            => array( $this, 'get_state' ),
				'permission_callback' => array( $this, 'permission_check' ),
			)
		);
	}

	public function permission_check() {
		if ( ! defined( 'NEWSROOM_BRIDGE_USER_ID' ) || ! is_numeric( NEWSROOM_BRIDGE_USER_ID ) || (int) NEWSROOM_BRIDGE_USER_ID <= 0 ) {
			return new WP_Error(
				'newsroom_bridge_not_configured',
				'Newsroom Bridge integration identity is not configured.',
				array( 'status' => 503 )
			);
		}

		if ( get_current_user_id() !== (int) NEWSROOM_BRIDGE_USER_ID || ! current_user_can( 'edit_posts' ) ) {
			return new WP_Error(
				'newsroom_bridge_forbidden',
				'The current user cannot access Newsroom Bridge.',
				array( 'status' => 403 )
			);
		}

		return true;
	}

	public function get_state( WP_REST_Request $request ) {
		$draft_key = (string) $request->get_param( 'draft_key' );
		if ( ! $this->is_canonical_uuid_v4( $draft_key ) ) {
			return new WP_Error(
				'newsroom_invalid_draft_key',
				'The draft key must be a canonical lowercase UUID v4.',
				array( 'status' => 400 )
			);
		}

		$mapping = $this->ready_mapping( $draft_key );
		if ( is_wp_error( $mapping ) ) {
			return $mapping;
		}

		$state = $this->current_state( (int) $mapping['post_id'] );

		return new WP_REST_Response(
			array(
				'draft_key'         => $draft_key,
				'post_id'           => (int) $mapping['post_id'],
				'status'            => 'draft',
				'title'             => $state['title'],
				'content'           => $state['content'],
				'excerpt'           => $state['excerpt'],
				'categories'        => $state['categories'],
				'featured_media_key'=> $state['featured_media_key'],
				'applied_version'   => $this->state_fingerprint( $state ),
			),
			200
		);
	}

	public function sync_draft( WP_REST_Request $request ) {
		$payload = $this->validated_sync_payload( $request );
		if ( is_wp_error( $payload ) ) {
			return $payload;
		}

		$ready = $this->database->assert_ready_and_transactional();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}
		$media_ready = $this->media_database->assert_ready_and_transactional();
		if ( is_wp_error( $media_ready ) ) {
			return $media_ready;
		}

		$mapping = $this->ready_mapping( $payload['draft_key'] );
		if ( is_wp_error( $mapping ) ) {
			return $mapping;
		}
		$post_id = (int) $mapping['post_id'];

		$thumbnail_target = $this->resolve_featured_media_key( $payload['featured_media_key'] );
		if ( is_wp_error( $thumbnail_target ) ) {
			return $thumbnail_target;
		}

		$target_state = array(
			'title'             => $payload['title'],
			'content'           => $payload['content'],
			'excerpt'           => $payload['excerpt'],
			'categories'        => $payload['categories'],
			'thumbnail_id'      => $thumbnail_target,
			'featured_media_key'=> $payload['featured_media_key'],
			'status'            => 'draft',
			'author_id'         => (int) get_current_user_id(),
		);

		if ( ! $this->database->begin() ) {
			return $this->storage_error( 'The draft sync transaction could not start.' );
		}

		$caught = null;
		try {
			if ( ! $this->lock_draft( $payload['draft_key'] ) ) {
				throw new RuntimeException( 'draft_lock_failed' );
			}

			// Read the canonical state AFTER the writer lock so a stale cached
			// post never defeats the CAS check; the row lock serialises every
			// concurrent synchroniser of this draft key.
			clean_post_cache( $post_id );
			$current = $this->current_state( $post_id );

			if ( null !== $payload['expected_version'] && ! hash_equals( $payload['expected_version'], $this->state_fingerprint( $current ) ) ) {
				throw new Newsroom_Draft_Sync_Carrier(
					new WP_Error(
						'newsroom_draft_sync_stale_version',
						'The draft changed since the expected version; reconcile this draft key before retrying.',
						array( 'status' => 409 )
					)
				);
			}

			if ( $this->states_equal( $current, $target_state ) ) {
				$this->database->rollback();
				return $this->sync_response( $payload['draft_key'], $post_id, true, $target_state );
			}

			$updated = $this->apply_state( $post_id, $target_state );
			if ( is_wp_error( $updated ) ) {
				throw new Newsroom_Draft_Sync_Carrier( $updated );
			}

			$after = $this->current_state( $post_id );
			if ( ! $this->states_equal( $after, $target_state ) ) {
				throw new RuntimeException( 'postcondition_mismatch' );
			}

			// TEST-ONLY fault injection point; production never fires this action.
			do_action( 'newsroom_draft_sync_proof_before_commit', $post_id, $target_state );

			$this->refresh_payload_hash( $payload['draft_key'], $target_state );
			if ( ! $this->database->commit() ) {
				throw new RuntimeException( 'commit_uncertain' );
			}
		} catch ( Throwable $throwable ) {
			$this->database->rollback();
			clean_post_cache( $post_id );
			$caught = $throwable;
		}

		if ( $caught instanceof Newsroom_Draft_Sync_Carrier ) {
			return $caught->wp_error();
		}

		if ( null !== $caught ) {
			$message = $caught->getMessage();
			if ( 'postcondition_mismatch' === $message ) {
				return new WP_Error(
					'newsroom_draft_sync_postcondition_failed',
					'WordPress state postconditions failed after the draft sync.',
					array( 'status' => 503 )
				);
			}
			if ( 'commit_uncertain' === $message ) {
				return new WP_Error(
					'newsroom_reconciliation_outcome_uncertain',
					'The draft sync outcome is uncertain; reconcile this draft key before any retry.',
					array( 'status' => 503 )
				);
			}
			return new WP_Error(
				'newsroom_draft_sync_failed',
				'WordPress could not complete the draft sync.',
				array( 'status' => 503 )
			);
		}

		return $this->sync_response( $payload['draft_key'], $post_id, false, $target_state );
	}

	public function validated_sync_payload( WP_REST_Request $request ) {
		$input   = $request->get_json_params();
		$allowed = array( 'draft_key', 'title', 'content', 'excerpt', 'categories', 'featured_media_key', 'expected_version' );

		if ( ! is_array( $input ) ) {
			return $this->invalid_payload( 'The request body must be a JSON object.' );
		}

		$unsupported = array_diff( array_keys( $input ), $allowed );
		if ( ! empty( $unsupported ) ) {
			return $this->invalid_payload( 'The request contains unsupported fields.' );
		}

		if ( ! isset( $input['draft_key'] ) || ! is_string( $input['draft_key'] ) || ! $this->is_canonical_uuid_v4( $input['draft_key'] ) ) {
			return new WP_Error(
				'newsroom_invalid_draft_key',
				'The draft key must be a canonical lowercase UUID v4.',
				array( 'status' => 400 )
			);
		}

		if ( ! isset( $input['title'] ) || ! is_string( $input['title'] ) || '' === trim( $input['title'] ) ) {
			return $this->invalid_payload( 'Title must be a non-empty string.' );
		}

		if ( ! isset( $input['content'] ) || ! is_string( $input['content'] ) || '' === trim( $input['content'] ) ) {
			return $this->invalid_payload( 'Content must be a non-empty string.' );
		}

		if ( isset( $input['excerpt'] ) && ! is_string( $input['excerpt'] ) ) {
			return $this->invalid_payload( 'Excerpt must be a string.' );
		}

		if ( ! array_key_exists( 'featured_media_key', $input ) ) {
			return $this->invalid_payload( 'The featured_media_key field is required; pass null to clear the featured media.' );
		}

		if ( null !== $input['featured_media_key'] ) {
			if ( ! is_string( $input['featured_media_key'] ) || ! $this->is_canonical_uuid_v4( $input['featured_media_key'] ) ) {
				return $this->invalid_payload( 'The featured media key must be a canonical lowercase UUID v4 or null.' );
			}
		}

		$expected_version = null;
		if ( array_key_exists( 'expected_version', $input ) ) {
			if ( ! is_string( $input['expected_version'] ) || 1 !== preg_match( '/\A[0-9a-f]{64}\z/D', $input['expected_version'] ) ) {
				return $this->invalid_payload( 'The expected_version must be a canonical sha256 fingerprint.' );
			}
			$expected_version = $input['expected_version'];
		}

		$categories = $this->validated_categories( isset( $input['categories'] ) ? $input['categories'] : null );
		if ( is_wp_error( $categories ) ) {
			return $categories;
		}

		return array(
			'draft_key'          => $input['draft_key'],
			'title'              => $input['title'],
			'content'            => $input['content'],
			'excerpt'            => isset( $input['excerpt'] ) ? $input['excerpt'] : '',
			'categories'         => $categories,
			'featured_media_key' => null === $input['featured_media_key'] ? null : (string) $input['featured_media_key'],
			'expected_version'   => $expected_version,
		);
	}

	private function ready_mapping( $draft_key ) {
		$ready = $this->database->assert_ready_and_transactional();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}

		$mapping = $this->database->get( $draft_key );
		if ( is_wp_error( $mapping ) ) {
			return $mapping;
		}

		if ( null === $mapping ) {
			return new WP_Error(
				'newsroom_draft_sync_not_found',
				'No reconciliation mapping exists for this draft key.',
				array( 'status' => 404 )
			);
		}

		if ( empty( $mapping['post_id'] ) || null !== $mapping['reservation_token'] ) {
			return new WP_Error(
				'newsroom_reconciliation_corrupt',
				'The reconciliation mapping is incomplete and requires operator review.',
				array( 'status' => 409 )
			);
		}

		if ( (int) $mapping['actor_user_id'] !== (int) get_current_user_id() ) {
			return new WP_Error(
				'newsroom_bridge_forbidden',
				'This reconciliation mapping is not accessible to the current user.',
				array( 'status' => 403 )
			);
		}

		$post = get_post( (int) $mapping['post_id'] );
		if ( ! $post ) {
			return new WP_Error(
				'newsroom_reconciliation_target_missing',
				'The mapped WordPress post is missing and the key cannot be reused.',
				array( 'status' => 409 )
			);
		}

		if ( 'post' !== $post->post_type ) {
			return new WP_Error(
				'newsroom_reconciliation_corrupt',
				'The reconciliation mapping points to an unexpected object type.',
				array( 'status' => 409 )
			);
		}

		if ( ! current_user_can( 'edit_post', $post->ID ) ) {
			return new WP_Error(
				'newsroom_bridge_forbidden',
				'The mapped post is not accessible to the current user.',
				array( 'status' => 403 )
			);
		}

		return $mapping;
	}

	private function resolve_featured_media_key( $featured_media_key ) {
		if ( null === $featured_media_key ) {
			return null;
		}

		$row = $this->media_database->get( $featured_media_key );
		if ( is_wp_error( $row ) ) {
			return $row;
		}

		if ( ! is_array( $row ) ) {
			return new WP_Error(
				'newsroom_draft_sync_media_key_not_found',
				'The featured media key is not managed by the newsroom media boundary.',
				array( 'status' => 400 )
			);
		}

		if ( null !== $row['reservation_token'] ) {
			return new WP_Error(
				'newsroom_draft_sync_media_key_in_progress',
				'The featured media key is still reserved and cannot be assigned.',
				array( 'status' => 409 )
			);
		}

		if ( ! defined( 'NEWSROOM_BRIDGE_MEDIA_USER_ID' ) || (int) $row['actor_user_id'] !== (int) NEWSROOM_BRIDGE_MEDIA_USER_ID ) {
			return new WP_Error(
				'newsroom_draft_sync_media_not_owned',
				'The featured media mapping is not owned by the newsroom media authority.',
				array( 'status' => 400 )
			);
		}

		$attachment_id = empty( $row['attachment_id'] ) ? 0 : (int) $row['attachment_id'];
		if ( $attachment_id <= 0 ) {
			return new WP_Error(
				'newsroom_draft_sync_media_attachment_missing',
				'The featured media mapping has no committed attachment.',
				array( 'status' => 409 )
			);
		}

		$attachment = get_post( $attachment_id );
		if ( ! $attachment || 'attachment' !== $attachment->post_type ) {
			return new WP_Error(
				'newsroom_draft_sync_media_attachment_missing',
				'The featured media attachment is missing.',
				array( 'status' => 409 )
			);
		}

		if ( (int) $attachment->post_author !== (int) NEWSROOM_BRIDGE_MEDIA_USER_ID ) {
			return new WP_Error(
				'newsroom_draft_sync_media_not_owned',
				'The featured media attachment is not owned by the newsroom media authority.',
				array( 'status' => 400 )
			);
		}

		if ( ! in_array( (string) $attachment->post_mime_type, self::ALLOWED_MIME, true ) ) {
			return new WP_Error(
				'newsroom_draft_sync_media_not_image',
				'The featured media attachment is not an accepted image.',
				array( 'status' => 400 )
			);
		}

		$key_meta  = get_post_meta( $attachment_id, self::MEDIA_KEY_META, true );
		$file_meta = get_post_meta( $attachment_id, self::MEDIA_FILE_META, true );
		if ( (string) $key_meta !== $featured_media_key || ! is_string( $file_meta ) || '' === $file_meta || ! file_exists( $file_meta ) ) {
			return new WP_Error(
				'newsroom_draft_sync_media_corrupt',
				'The featured media mapping is corrupted.',
				array( 'status' => 409 )
			);
		}

		return $attachment_id;
	}

	private function lock_draft( $draft_key ) {
		global $wpdb;

		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT post_id FROM {$this->database->table_name()} WHERE draft_key = %s FOR UPDATE",
				$draft_key
			),
			ARRAY_A
		);

		return is_array( $row ) && ! empty( $row['post_id'] );
	}

	private function current_state( $post_id ) {
		$post = get_post( $post_id );

		$categories = wp_get_post_categories( $post_id, array( 'fields' => 'ids' ) );
		if ( is_wp_error( $categories ) ) {
			$categories = array();
		}
		$categories = array_values( array_unique( array_filter( array_map( 'intval', $categories ) ) ) );
		sort( $categories, SORT_NUMERIC );

		$thumbnail     = get_post_meta( $post_id, '_thumbnail_id', true );
		$thumbnail_id  = null;
		$featured_key  = null;
		if ( is_numeric( $thumbnail ) && (int) $thumbnail > 0 ) {
			$thumbnail_id = (int) $thumbnail;
			$featured_key = $this->media_key_for_attachment( $thumbnail_id );
		}

		return array(
			'title'              => (string) $post->post_title,
			'content'            => (string) $post->post_content,
			'excerpt'            => (string) $post->post_excerpt,
			'categories'         => $categories,
			'thumbnail_id'       => $thumbnail_id,
			'featured_media_key' => $featured_key,
			'status'             => (string) $post->post_status,
			'author_id'          => (int) $post->post_author,
		);
	}

	private function media_key_for_attachment( $attachment_id ) {
		global $wpdb;
		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT pm.meta_value FROM {$wpdb->postmeta} pm WHERE pm.post_id = %d AND pm.meta_key = %s LIMIT 1",
				$attachment_id,
				self::MEDIA_KEY_META
			),
			ARRAY_A
		);
		if ( ! is_array( $row ) || ! is_string( $row['meta_value'] ) || '' === $row['meta_value'] ) {
			return null;
		}
		return $row['meta_value'];
	}

	private function apply_state( $post_id, array $target ) {
		$request = new WP_REST_Request( 'PUT', '/wp/v2/posts/' . $post_id );
		$request->set_param( 'id', $post_id );
		$request->set_param( 'title', $target['title'] );
		$request->set_param( 'content', $target['content'] );
		$request->set_param( 'excerpt', $target['excerpt'] );
		$request->set_param( 'categories', $target['categories'] );

		$controller = new WP_REST_Posts_Controller( 'post' );
		$permission = $controller->update_item_permissions_check( $request );
		if ( is_wp_error( $permission ) ) {
			return new WP_Error(
				'newsroom_draft_sync_forbidden',
				'WordPress rejected permission to update the draft.',
				array( 'status' => 403 )
			);
		}

		$response = $controller->update_item( $request );
		if ( is_wp_error( $response ) ) {
			return new WP_Error(
				'newsroom_draft_sync_failed',
				'WordPress could not update the draft.',
				array( 'status' => 422 )
			);
		}

		$post = get_post( $post_id );
		if ( ! $post || 'draft' !== $post->post_status ) {
			return new WP_Error(
				'newsroom_draft_sync_failed',
				'WordPress did not preserve the draft status.',
				array( 'status' => 503 )
			);
		}

		if ( null === $target['thumbnail_id'] ) {
			delete_post_meta( $post_id, '_thumbnail_id' );
		} else {
			update_post_meta( $post_id, '_thumbnail_id', (string) $target['thumbnail_id'] );
		}

		return true;
	}

	private function states_equal( array $a, array $b ) {
		return $a['title'] === $b['title']
			&& $a['content'] === $b['content']
			&& $a['excerpt'] === $b['excerpt']
			&& $a['categories'] === $b['categories']
			&& $a['status'] === $b['status']
			&& (int) $a['author_id'] === (int) $b['author_id']
			&& ( null === $a['thumbnail_id'] ? 0 : (int) $a['thumbnail_id'] ) === ( null === $b['thumbnail_id'] ? 0 : (int) $b['thumbnail_id'] );
	}

	private function refresh_payload_hash( $draft_key, array $target ) {
		global $wpdb;

		$fingerprint = $this->reconciliation_fingerprint(
			array(
				'title'      => $target['title'],
				'content'    => $target['content'],
				'excerpt'    => $target['excerpt'],
				'categories' => $target['categories'],
			)
		);

		$result = $wpdb->update(
			$this->database->table_name(),
			array(
				'payload_hash' => $fingerprint,
				'updated_at'   => current_time( 'mysql', true ),
			),
			array( 'draft_key' => $draft_key )
		);

		if ( 1 !== $result ) {
			throw new RuntimeException( 'payload_hash_refresh_failed' );
		}
	}

	private function reconciliation_fingerprint( array $payload ) {
		$canonical = array(
			'contract_version' => 1,
			'title'            => $payload['title'],
			'content'          => $payload['content'],
			'excerpt'          => $payload['excerpt'],
			'categories'       => $payload['categories'],
		);

		$serialized = wp_json_encode( $canonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( false === $serialized ) {
			throw new RuntimeException( 'reconciliation_fingerprint_failed' );
		}

		return hash( 'sha256', $serialized );
	}

	private function state_fingerprint( array $state ) {
		$canonical = array(
			'contract_version'   => self::SYNC_CONTRACT_VERSION,
			'title'              => $state['title'],
			'content'            => $state['content'],
			'excerpt'            => $state['excerpt'],
			'categories'         => $state['categories'],
			'featured_media_key' => $state['featured_media_key'],
		);

		$serialized = wp_json_encode( $canonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( false === $serialized ) {
			throw new RuntimeException( 'state_fingerprint_failed' );
		}

		return hash( 'sha256', $serialized );
	}

	private function sync_response( $draft_key, $post_id, $replayed, array $target_state ) {
		return new WP_REST_Response(
			array(
				'draft_key'          => $draft_key,
				'post_id'            => (int) $post_id,
				'status'             => 'draft',
				'replayed'           => (bool) $replayed,
				'featured_media_key' => $target_state['featured_media_key'],
				'applied_version'    => $this->state_fingerprint( $target_state ),
			),
			200
		);
	}

	private function validated_categories( $input ) {
		if ( ! is_array( $input ) || empty( $input ) || array_values( $input ) !== $input ) {
			return $this->invalid_payload( 'Categories must be a non-empty array of positive integer IDs.' );
		}

		$categories = array();
		foreach ( $input as $category_id ) {
			if ( ! is_int( $category_id ) && ! ( is_string( $category_id ) && ctype_digit( $category_id ) ) ) {
				return $this->invalid_payload( 'Each category ID must be a positive integer.' );
			}

			$category_id = (int) $category_id;
			if ( $category_id <= 0 ) {
				return $this->invalid_payload( 'Each category ID must be a positive integer.' );
			}

			$term = get_term( $category_id, 'category' );
			if ( is_wp_error( $term ) || ! $term ) {
				return new WP_Error(
					'newsroom_category_not_found',
					'Every category ID must identify an existing WordPress category.',
					array( 'status' => 400 )
				);
			}

			$categories[] = $category_id;
		}

		$taxonomy = get_taxonomy( 'category' );
		if ( ! $taxonomy || ! current_user_can( $taxonomy->cap->assign_terms ) ) {
			return new WP_Error(
				'newsroom_bridge_forbidden',
				'The current user cannot assign existing categories.',
				array( 'status' => 403 )
			);
		}

		$categories = array_values( array_unique( $categories ) );
		sort( $categories, SORT_NUMERIC );

		return $categories;
	}

	private function is_canonical_uuid_v4( $draft_key ) {
		return is_string( $draft_key )
			&& 1 === preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $draft_key )
			&& wp_is_uuid( $draft_key, 4 );
	}

	private function storage_error( $message ) {
		return new WP_Error(
			'newsroom_reconciliation_storage_error',
			$message,
			array( 'status' => 503 )
		);
	}

	private function invalid_payload( $message ) {
		return new WP_Error(
			'newsroom_invalid_payload',
			$message,
			array( 'status' => 400 )
		);
	}
}

if ( ! class_exists( 'Newsroom_Draft_Sync_Carrier', false ) ) {
	final class Newsroom_Draft_Sync_Carrier extends RuntimeException {
		private $carried;

		public function __construct( WP_Error $error ) {
			parent::__construct( $error->get_error_code(), 0, null );
			$this->carried = $error;
		}

		public function wp_error() {
			return $this->carried;
		}
	}
}