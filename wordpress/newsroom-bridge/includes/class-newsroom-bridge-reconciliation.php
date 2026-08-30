<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Newsroom_Bridge_Reconciliation {
	private const CONTRACT_VERSION = 1;

	private $database;

	public function __construct( Newsroom_Bridge_DB $database ) {
		$this->database = $database;
	}

	public function create( array $payload ) {
		$ready = $this->database->assert_ready_and_transactional();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}

		$actor_user_id = get_current_user_id();
		$payload_hash  = $this->fingerprint( $payload );
		if ( is_wp_error( $payload_hash ) ) {
			return $payload_hash;
		}

		$reservation_token = strtolower( (string) wp_generate_uuid4() );
		if ( ! $this->is_canonical_uuid_v4( $reservation_token ) ) {
			return $this->storage_error( 'A reconciliation reservation token could not be generated.' );
		}

		if ( ! $this->database->begin() ) {
			return $this->storage_error( 'The reconciliation transaction could not start.' );
		}

		$reservation_result = $this->database->reserve( $payload['draft_key'], $payload_hash, $actor_user_id, $reservation_token );
		if ( is_wp_error( $reservation_result ) ) {
			$this->database->rollback();
			return $reservation_result;
		}

		$mapping = $this->database->get_for_update( $payload['draft_key'] );
		if ( is_wp_error( $mapping ) ) {
			$this->database->rollback();
			return $mapping;
		}

		if ( ! is_array( $mapping ) ) {
			$this->database->rollback();
			return $this->storage_error( 'The reserved reconciliation mapping could not be locked.' );
		}

		$owns_reservation = isset( $mapping['reservation_token'] ) && $mapping['reservation_token'] === $reservation_token;
		if ( ! $owns_reservation ) {
			$result = $this->replay_existing( $mapping, $payload_hash, $actor_user_id );
			if ( is_wp_error( $result ) ) {
				$this->database->rollback();
				return $result;
			}

			if ( ! $this->database->commit() ) {
				return $this->uncertain_outcome( (int) $mapping['post_id'] );
			}

			$result['replayed'] = true;
			return $result;
		}

		$previous_cache_addition_state = wp_suspend_cache_addition();
		$candidate_post_id             = 0;
		wp_suspend_cache_addition( true );

		try {
			$core_result       = $this->create_core_draft( $payload, $candidate_post_id );
			$candidate_post_id = (int) $core_result['post_id'];
			if ( is_wp_error( $core_result['error'] ) ) {
				$this->rollback_and_clean( $candidate_post_id );
				return $core_result['error'];
			}

			if ( ! $this->database->attach_post( $payload['draft_key'], $reservation_token, $candidate_post_id ) ) {
				$this->rollback_and_clean( $candidate_post_id );
				return $this->storage_error( 'The created draft could not be attached to its reconciliation mapping.' );
			}

			if ( ! $this->database->commit() ) {
				return $this->uncertain_outcome( $candidate_post_id );
			}

			return array(
				'draft_key' => $payload['draft_key'],
				'post_id'   => $candidate_post_id,
				'status'    => 'draft',
				'replayed'  => false,
			);
		} catch ( Throwable $throwable ) {
			$this->rollback_and_clean( $candidate_post_id );
			return $this->storage_error( 'WordPress draft creation failed unexpectedly.' );
		} finally {
			wp_suspend_cache_addition( $previous_cache_addition_state );
		}
	}

	public function lookup( $draft_key ) {
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
				'newsroom_reconciliation_not_found',
				'No reconciliation mapping exists for this draft key.',
				array( 'status' => 404 )
			);
		}

		return $this->healthy_mapping( $mapping, get_current_user_id() );
	}

	private function replay_existing( array $mapping, $payload_hash, $actor_user_id ) {
		$healthy = $this->healthy_mapping( $mapping, $actor_user_id );
		if ( is_wp_error( $healthy ) ) {
			return $healthy;
		}

		if ( ! hash_equals( (string) $mapping['payload_hash'], $payload_hash ) ) {
			return new WP_Error(
				'newsroom_idempotency_conflict',
				'This draft key is already bound to a different creation payload.',
				array( 'status' => 409 )
			);
		}

		return $healthy;
	}

	private function healthy_mapping( array $mapping, $actor_user_id ) {
		if ( empty( $mapping['post_id'] ) || null !== $mapping['reservation_token'] ) {
			return new WP_Error(
				'newsroom_reconciliation_corrupt',
				'The reconciliation mapping is incomplete and requires operator review.',
				array( 'status' => 409 )
			);
		}

		if ( (int) $mapping['actor_user_id'] !== (int) $actor_user_id ) {
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

		return array(
			'draft_key' => (string) $mapping['draft_key'],
			'post_id'   => (int) $post->ID,
			'status'    => (string) $post->post_status,
		);
	}

	private function create_core_draft( array $payload, &$candidate_post_id ) {
		$request = new WP_REST_Request( 'POST', '/wp/v2/posts' );
		$request->set_param( 'title', $payload['title'] );
		$request->set_param( 'content', $payload['content'] );
		$request->set_param( 'excerpt', $payload['excerpt'] );
		$request->set_param( 'categories', $payload['categories'] );
		$request->set_param( 'status', 'draft' );
		$request->set_param( 'author', get_current_user_id() );

		$controller = new WP_REST_Posts_Controller( 'post' );
		$permission = $controller->create_item_permissions_check( $request );
		if ( is_wp_error( $permission ) ) {
			return array(
				'post_id' => 0,
				'error'   => new WP_Error(
					'newsroom_draft_creation_failed',
					'WordPress rejected permission to create the draft.',
					array( 'status' => 403 )
				),
			);
		}

		$candidate_post_id = 0;
		$capture_post_id    = static function ( $post, $hook_request, $creating ) use ( $request, &$candidate_post_id ) {
			if ( true === $creating && $hook_request === $request && $post instanceof WP_Post && 'post' === $post->post_type ) {
				$candidate_post_id = (int) $post->ID;
			}
		};

		add_action( 'rest_insert_post', $capture_post_id, 10, 3 );
		try {
			$response = $controller->create_item( $request );
		} catch ( Throwable $throwable ) {
			$response = new WP_Error(
				'newsroom_draft_creation_failed',
				'WordPress could not complete draft creation.',
				array( 'status' => 503 )
			);
		} finally {
			remove_action( 'rest_insert_post', $capture_post_id, 10 );
		}

		if ( is_wp_error( $response ) ) {
			return array(
				'post_id' => $candidate_post_id,
				'error'   => new WP_Error(
					'newsroom_draft_creation_failed',
					'WordPress could not create the draft.',
					array( 'status' => 422 )
				),
			);
		}

		$post = $candidate_post_id > 0 ? get_post( $candidate_post_id ) : null;

		if ( ! $post || 'post' !== $post->post_type || 'draft' !== $post->post_status || (int) $post->post_author !== get_current_user_id() ) {
			return array(
				'post_id' => $candidate_post_id,
				'error'   => new WP_Error(
					'newsroom_draft_creation_failed',
					'WordPress returned an invalid draft creation result.',
					array( 'status' => 503 )
				),
			);
		}

		$actual_categories = wp_get_post_categories( $candidate_post_id, array( 'fields' => 'ids' ) );
		if ( is_wp_error( $actual_categories ) ) {
			return array(
				'post_id' => $candidate_post_id,
				'error'   => new WP_Error(
					'newsroom_draft_creation_failed',
					'WordPress could not verify assigned draft categories.',
					array( 'status' => 503 )
				),
			);
		}

		$actual_categories = array_values( array_unique( array_filter( array_map( 'intval', $actual_categories ) ) ) );
		sort( $actual_categories, SORT_NUMERIC );
		if ( $actual_categories !== $payload['categories'] ) {
			return array(
				'post_id' => $candidate_post_id,
				'error'   => new WP_Error(
					'newsroom_draft_creation_failed',
					'WordPress assigned categories that differ from the immutable creation payload.',
					array( 'status' => 409 )
				),
			);
		}

		return array(
			'post_id' => $candidate_post_id,
			'error'   => null,
		);
	}

	private function fingerprint( array $payload ) {
		$canonical = array(
			'contract_version' => self::CONTRACT_VERSION,
			'title'            => $payload['title'],
			'content'          => $payload['content'],
			'excerpt'          => $payload['excerpt'],
			'categories'       => $payload['categories'],
		);

		$serialized = wp_json_encode( $canonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( false === $serialized ) {
			return $this->storage_error( 'The reconciliation payload could not be serialized.' );
		}

		return hash( 'sha256', $serialized );
	}

	private function is_canonical_uuid_v4( $value ) {
		return is_string( $value )
			&& 1 === preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $value )
			&& wp_is_uuid( $value, 4 );
	}

	private function storage_error( $message ) {
		return new WP_Error(
			'newsroom_reconciliation_storage_error',
			$message,
			array( 'status' => 503 )
		);
	}

	private function rollback_and_clean( $post_id ) {
		$this->database->rollback();
		if ( $post_id > 0 ) {
			clean_post_cache( $post_id );
		}
	}

	private function uncertain_outcome( $post_id ) {
		$this->database->rollback();
		if ( $post_id > 0 ) {
			clean_post_cache( $post_id );
		}

		return new WP_Error(
			'newsroom_reconciliation_outcome_uncertain',
			'The transaction outcome is uncertain; reconcile this draft key before any create retry.',
			array( 'status' => 503 )
		);
	}
}
