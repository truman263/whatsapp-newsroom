<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Newsroom_Bridge_REST {
	private const NAMESPACE = 'newsroom/v1';

	private $reconciliation;

	public function __construct( Newsroom_Bridge_Reconciliation $reconciliation ) {
		$this->reconciliation = $reconciliation;
	}

	public function register_routes() {
		register_rest_route(
			self::NAMESPACE,
			'/drafts',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'create_draft' ),
				'permission_callback' => array( $this, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/drafts/(?P<draft_key>[a-f0-9-]{36})',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'get_draft' ),
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

	public function create_draft( WP_REST_Request $request ) {
		$payload = $this->validated_payload( $request );
		if ( is_wp_error( $payload ) ) {
			return $payload;
		}

		$result = $this->reconciliation->create( $payload );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return new WP_REST_Response( $result, $result['replayed'] ? 200 : 201 );
	}

	public function get_draft( WP_REST_Request $request ) {
		$draft_key = (string) $request->get_param( 'draft_key' );
		if ( ! $this->is_canonical_uuid_v4( $draft_key ) ) {
			return new WP_Error(
				'newsroom_invalid_draft_key',
				'The draft key must be a canonical lowercase UUID v4.',
				array( 'status' => 400 )
			);
		}

		$result = $this->reconciliation->lookup( $draft_key );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		return new WP_REST_Response( $result, 200 );
	}

	private function validated_payload( WP_REST_Request $request ) {
		$input   = $request->get_json_params();
		$allowed = array( 'draft_key', 'title', 'content', 'excerpt', 'categories' );

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

		$categories = $this->validated_categories( isset( $input['categories'] ) ? $input['categories'] : null );
		if ( is_wp_error( $categories ) ) {
			return $categories;
		}

		return array(
			'draft_key' => $input['draft_key'],
			'title'      => $input['title'],
			'content'    => $input['content'],
			'excerpt'    => isset( $input['excerpt'] ) ? $input['excerpt'] : '',
			'categories' => $categories,
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

	private function invalid_payload( $message ) {
		return new WP_Error(
			'newsroom_invalid_payload',
			$message,
			array( 'status' => 400 )
		);
	}
}
