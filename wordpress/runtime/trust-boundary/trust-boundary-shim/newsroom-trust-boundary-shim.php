<?php
/**
 * Plugin Name: Newsroom Trust Boundary Shim
 * Description: TEST ONLY — NEVER DEPLOY. Disposable route-scoped HMAC and service-user lockdown proof.
 * Version: 0.1.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const NEWSROOM_HMAC_PROTOCOL_VERSION = '1';
const NEWSROOM_HMAC_MAX_CLOCK_SKEW   = 300;

function newsroom_tb_service_user_id() {
	if (
		! defined( 'NEWSROOM_TRUST_BOUNDARY_SERVICE_USER_ID' )
		|| ! is_numeric( NEWSROOM_TRUST_BOUNDARY_SERVICE_USER_ID )
		|| (int) NEWSROOM_TRUST_BOUNDARY_SERVICE_USER_ID <= 0
	) {
		return 0;
	}

	return (int) NEWSROOM_TRUST_BOUNDARY_SERVICE_USER_ID;
}

function newsroom_tb_is_service_identity( $user ) {
	$service_user_id = newsroom_tb_service_user_id();
	return $service_user_id > 0 && $user instanceof WP_User && (int) $user->ID === $service_user_id;
}

add_filter(
	'wp_is_application_passwords_available_for_user',
	static function ( $available, $user ) {
		return newsroom_tb_is_service_identity( $user ) ? false : $available;
	},
	PHP_INT_MAX,
	2
);

add_filter(
	'authenticate',
	static function ( $user, $username ) {
		$service_user_id = newsroom_tb_service_user_id();
		if ( $service_user_id <= 0 ) {
			return $user;
		}

		$service_user = get_user_by( 'id', $service_user_id );
		$is_service    = $user instanceof WP_User && (int) $user->ID === $service_user_id;
		if ( $service_user instanceof WP_User && is_string( $username ) ) {
			$is_service = $is_service || hash_equals( (string) $service_user->user_login, $username );
			$is_service = $is_service || hash_equals( (string) $service_user->user_email, $username );
		}

		if ( $is_service ) {
			return new WP_Error( 'newsroom_service_login_disabled', 'Authentication failed.' );
		}

		return $user;
	},
	PHP_INT_MAX,
	3
);

function newsroom_tb_auth_error( $category = 'generic' ) {
	if ( 'local' === wp_get_environment_type() ) {
		error_log( 'NEWSROOM_TB_AUTH_FAILURE=' . sanitize_key( $category ) );
	}
	unset( $GLOBALS['newsroom_tb_context_restore'] );
	wp_set_current_user( 0 );
	return new WP_Error(
		'newsroom_hmac_authentication_failed',
		'Newsroom authentication failed.',
		array( 'status' => 401 )
	);
}

function newsroom_tb_header_exists( $name ) {
	return array_key_exists( $name, $_SERVER );
}

function newsroom_tb_header( $name ) {
	return newsroom_tb_header_exists( $name ) && is_string( $_SERVER[ $name ] ) ? wp_unslash( $_SERVER[ $name ] ) : null;
}

function newsroom_tb_route_policy( $method, $route ) {
	if ( 'POST' === $method && '/newsroom/v1/drafts' === $route ) {
		return 'draft';
	}

	if (
		'GET' === $method
		&& 1 === preg_match( '#^/newsroom/v1/drafts/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$#', $route )
	) {
		return 'draft';
	}

	return '';
}

function newsroom_tb_current_rest_route() {
	global $wp;

	if ( ! isset( $wp->query_vars['rest_route'] ) || ! is_string( $wp->query_vars['rest_route'] ) ) {
		return '';
	}

	$route = $wp->query_vars['rest_route'];
	if ( '' === $route || '/' !== $route[0] || 0 === strpos( $route, '//' ) ) {
		return '';
	}

	$request_uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
	$request_path = wp_parse_url( $request_uri, PHP_URL_PATH );
	$rest_path    = wp_parse_url( rest_url(), PHP_URL_PATH );
	if ( ! is_string( $request_path ) || ! is_string( $rest_path ) ) {
		return '';
	}

	$expected_path = rtrim( $rest_path, '/' ) . $route;
	return $request_path === $expected_path ? $route : '';
}

function newsroom_tb_json_content_type_is_valid() {
	$content_type = newsroom_tb_header( 'CONTENT_TYPE' );
	return is_string( $content_type )
		&& 1 === preg_match( '/\Aapplication\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?\z/iD', $content_type );
}

function newsroom_tb_has_method_override() {
	return newsroom_tb_header_exists( 'HTTP_X_HTTP_METHOD_OVERRIDE' )
		|| array_key_exists( '_method', $_GET )
		|| array_key_exists( '_method', $_POST );
}

function newsroom_tb_has_authorization_credential() {
	foreach ( array( 'HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION' ) as $name ) {
		if ( ! newsroom_tb_header_exists( $name ) ) {
			continue;
		}

		$value = newsroom_tb_header( $name );
		if ( ! is_string( $value ) || '' !== $value ) {
			return true;
		}
	}

	return false;
}

function newsroom_tb_key_id_is_valid( $key_id ) {
	return is_string( $key_id ) && 1 === preg_match( '/\A[a-z0-9][a-z0-9._-]{0,63}\z/D', $key_id );
}

function newsroom_tb_decode_secret( $encoded ) {
	if ( ! is_string( $encoded ) || 1 !== preg_match( '/\A[A-Za-z0-9_-]{43}\z/D', $encoded ) ) {
		return false;
	}

	$decoded = base64_decode( strtr( $encoded, '-_', '+/' ) . '=', true );
	if ( ! is_string( $decoded ) || 32 !== strlen( $decoded ) ) {
		return false;
	}

	$canonical = rtrim( strtr( base64_encode( $decoded ), '+/', '-_' ), '=' );
	return hash_equals( $canonical, $encoded ) ? $decoded : false;
}

function newsroom_tb_validate_key_ring( $configured ) {
	if ( ! is_array( $configured ) || empty( $configured ) || array_keys( $configured ) !== range( 0, count( $configured ) - 1 ) ) {
		return false;
	}

	$validated = array();
	foreach ( $configured as $entry ) {
		if (
			! is_array( $entry )
			|| array( 'id', 'secret' ) !== array_keys( $entry )
			|| ! newsroom_tb_key_id_is_valid( $entry['id'] )
			|| array_key_exists( $entry['id'], $validated )
		) {
			return false;
		}

		$secret = newsroom_tb_decode_secret( $entry['secret'] );
		if ( false === $secret ) {
			return false;
		}

		$validated[ $entry['id'] ] = $secret;
	}

	return $validated;
}

function newsroom_tb_service_user_policy_is_valid( $service_user ) {
	if ( ! $service_user instanceof WP_User || ! user_can( $service_user, 'read' ) || ! user_can( $service_user, 'edit_posts' ) ) {
		return false;
	}

	$forbidden = array(
		'publish_posts',
		'edit_others_posts',
		'edit_published_posts',
		'delete_posts',
		'delete_published_posts',
		'delete_others_posts',
		'delete_private_posts',
		'edit_private_posts',
		'upload_files',
		'manage_categories',
		'manage_options',
		'edit_users',
		'create_users',
		'delete_users',
		'promote_users',
		'list_users',
		'activate_plugins',
		'install_plugins',
		'update_plugins',
		'delete_plugins',
		'edit_plugins',
		'switch_themes',
		'edit_themes',
		'install_themes',
		'update_themes',
		'delete_themes',
		'edit_files',
		'unfiltered_html',
		'manage_network',
		'manage_network_users',
		'manage_network_plugins',
		'manage_network_themes',
		'manage_network_options',
		'setup_network',
	);

	foreach ( $forbidden as $capability ) {
		if ( user_can( $service_user, $capability ) ) {
			return false;
		}
	}

	return ! is_multisite() || ! is_super_admin( $service_user->ID );
}

add_filter(
	'rest_post_dispatch',
	static function ( $response, $server, $request ) {
		$restore = isset( $GLOBALS['newsroom_tb_context_restore'] ) ? $GLOBALS['newsroom_tb_context_restore'] : null;
		if (
			is_array( $restore )
			&& $request instanceof WP_REST_Request
			&& $request->get_method() === $restore['method']
			&& $request->get_route() === $restore['route']
		) {
			unset( $GLOBALS['newsroom_tb_context_restore'] );
			wp_set_current_user( (int) $restore['user_id'] );
		}

		return $response;
	},
	PHP_INT_MAX,
	3
);

add_filter(
	'rest_authentication_errors',
	static function ( $result ) {
		$route = newsroom_tb_current_rest_route();

		$version   = newsroom_tb_header( 'HTTP_X_NEWSROOM_AUTH_VERSION' );
		$key_id    = newsroom_tb_header( 'HTTP_X_NEWSROOM_KEY_ID' );
		$timestamp = newsroom_tb_header( 'HTTP_X_NEWSROOM_TIMESTAMP' );
		$signature = newsroom_tb_header( 'HTTP_X_NEWSROOM_SIGNATURE' );
		$uses_hmac = null !== $version || null !== $key_id || null !== $timestamp || null !== $signature;
		$is_newsroom_route = 0 === strpos( $route, '/newsroom/' );

		if ( ! $uses_hmac && ! $is_newsroom_route ) {
			return $result;
		}

		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : '';
		$policy = newsroom_tb_route_policy( $method, $route );
		if ( 'draft' !== $policy ) {
			return newsroom_tb_auth_error( 'route_scope' );
		}
		if ( newsroom_tb_has_method_override() ) {
			return newsroom_tb_auth_error( 'method_override' );
		}
		if ( 'POST' === $method && ! newsroom_tb_json_content_type_is_valid() ) {
			return newsroom_tb_auth_error( 'content_type' );
		}
		if ( 'GET' === $method && newsroom_tb_header_exists( 'CONTENT_TYPE' ) ) {
			return newsroom_tb_auth_error( 'get_content_type' );
		}

		if ( is_wp_error( $result ) ) {
			return newsroom_tb_auth_error( 'prior_authentication_error' );
		}
		if ( get_current_user_id() > 0 ) {
			return newsroom_tb_auth_error( 'prior_user_context' );
		}
		if ( newsroom_tb_has_authorization_credential() ) {
			return newsroom_tb_auth_error( 'authorization_header' );
		}

		$request_uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		if ( null !== wp_parse_url( $request_uri, PHP_URL_QUERY ) ) {
			return newsroom_tb_auth_error( 'query_not_allowed' );
		}

		if (
			NEWSROOM_HMAC_PROTOCOL_VERSION !== $version
			|| ! newsroom_tb_key_id_is_valid( $key_id )
			|| 1 !== preg_match( '/\A[0-9]{10,12}\z/D', $timestamp )
			|| 1 !== preg_match( '/\A[0-9a-f]{64}\z/D', $signature )
		) {
			return newsroom_tb_auth_error( 'malformed_header' );
		}

		if ( PHP_INT_SIZE < 8 ) {
			return newsroom_tb_auth_error( 'unsupported_integer_width' );
		}
		$timestamp_value = (int) $timestamp;
		$skew            = $timestamp_value - time();
		if ( $skew < -NEWSROOM_HMAC_MAX_CLOCK_SKEW || $skew > NEWSROOM_HMAC_MAX_CLOCK_SKEW ) {
			return newsroom_tb_auth_error( 'expired_timestamp' );
		}

		if ( ! defined( 'NEWSROOM_HMAC_DRAFT_KEYS' ) ) {
			return newsroom_tb_auth_error( 'missing_key_configuration' );
		}

		$key_ring = newsroom_tb_validate_key_ring( NEWSROOM_HMAC_DRAFT_KEYS );
		if ( false === $key_ring ) {
			return newsroom_tb_auth_error( 'malformed_key_configuration' );
		}
		if ( ! array_key_exists( $key_id, $key_ring ) ) {
			return newsroom_tb_auth_error( 'unknown_key' );
		}
		$secret = $key_ring[ $key_id ];

		$raw_body = file_get_contents( 'php://input' );
		if ( false === $raw_body ) {
			return newsroom_tb_auth_error( 'body_unavailable' );
		}
		if ( 'GET' === $method && '' !== $raw_body ) {
			return newsroom_tb_auth_error( 'get_body' );
		}

		$canonical = implode(
			"\n",
			array(
				'newsroom-hmac-v1',
				$key_id,
				$method,
				$route,
				$timestamp,
				hash( 'sha256', $raw_body ),
			)
		);
		$expected = hash_hmac( 'sha256', $canonical, $secret );
		if ( ! hash_equals( $expected, $signature ) ) {
			return newsroom_tb_auth_error( 'invalid_signature' );
		}

		$service_user_id = newsroom_tb_service_user_id();
		$service_user    = $service_user_id > 0 ? get_user_by( 'id', $service_user_id ) : false;
		if (
			! $service_user instanceof WP_User
			|| ! defined( 'NEWSROOM_BRIDGE_USER_ID' )
			|| (int) NEWSROOM_BRIDGE_USER_ID !== $service_user_id
			|| wp_is_application_passwords_available_for_user( $service_user )
			|| ! newsroom_tb_service_user_policy_is_valid( $service_user )
		) {
			return newsroom_tb_auth_error( 'service_configuration' );
		}

		$GLOBALS['newsroom_tb_context_restore'] = array(
			'user_id' => get_current_user_id(),
			'method'  => $method,
			'route'   => $route,
		);
		wp_set_current_user( $service_user_id );
		if ( get_current_user_id() !== $service_user_id || ! current_user_can( 'edit_posts' ) ) {
			return newsroom_tb_auth_error( 'service_context' );
		}

		return true;
	},
	110
);
