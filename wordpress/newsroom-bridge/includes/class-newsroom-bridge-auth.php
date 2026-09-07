<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * REST-only newsroom HMAC authentication and temporary user context.
 */
final class Newsroom_Bridge_Auth {
	private const PROTOCOL_VERSION = '1';
	private const MAX_CLOCK_SKEW   = 300;

	private $config;
	private $service_user;
	private $proof;
	private $candidate;
	private $active = false;
	private $early_conflict = false;

	public function __construct( Newsroom_Bridge_Security_Config $config, Newsroom_Bridge_Service_User $service_user ) {
		$this->config       = $config;
		$this->service_user = $service_user;
		$this->proof        = null;
		$this->candidate    = null;
	}

	public function register() {
		add_filter( 'rest_allowed_cors_headers', array( $this, 'capture_request' ), PHP_INT_MIN, 2 );
		add_filter( 'rest_authentication_errors', array( $this, 'snapshot_conflict' ), PHP_INT_MIN );
		add_filter( 'rest_authentication_errors', array( $this, 'authenticate' ), 110 );
		add_filter( 'rest_endpoints', array( $this, 'wrap_endpoints' ), PHP_INT_MAX );
		add_filter( 'rest_pre_dispatch', array( $this, 'guard_dispatch' ), PHP_INT_MIN, 3 );
		add_filter( 'rest_request_after_callbacks', array( $this, 'clear_after_callbacks' ), PHP_INT_MAX, 3 );
		add_filter( 'rest_post_dispatch', array( $this, 'clear_after_callbacks' ), PHP_INT_MAX, 3 );
	}

	public function authenticate( $result ) {
		$route       = $this->current_external_rest_route();
		$uses_hmac   = $this->has_any_hmac_header();
		$is_newsroom = 0 === strpos( $route, '/newsroom/' );

		if ( ! $uses_hmac && ! $is_newsroom ) {
			return $result;
		}

		if ( ! $uses_hmac && $this->config->hmac_is_intentionally_disabled() ) {
			return $result;
		}

		$method   = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : '';
		$category = $this->route_category( $method, $route );
		if ( '' === $category ) {
			return $this->failure( 'route_scope', '', 'unsupported' );
		}

		if ( ! $this->config->hmac_prerequisites_are_valid() ) {
			return $this->failure( 'configuration', '', $category );
		}

		if ( $this->has_method_override() ) {
			return $this->failure( 'method_override', '', $category );
		}

		$request_uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		if ( null !== wp_parse_url( $request_uri, PHP_URL_QUERY ) ) {
			return $this->failure( 'query', '', $category );
		}

		if ( 'POST' === $method && ! $this->json_content_type_is_valid() ) {
			return $this->failure( 'content_type', '', $category );
		}
		if ( 'GET' === $method && $this->header_exists( 'CONTENT_TYPE' ) ) {
			return $this->failure( 'content_type', '', $category );
		}

		if ( $this->early_conflict || is_wp_error( $result ) || ( null !== $result && false !== $result && true !== $result ) ) {
			return $this->failure( 'prior_authentication', '', $category );
		}
		if ( get_current_user_id() > 0 ) {
			return $this->failure( 'prior_user', '', $category );
		}
		if ( $this->has_authorization_header() ) {
			return $this->failure( 'authorization_conflict', '', $category );
		}

		$version   = $this->header( 'HTTP_X_NEWSROOM_AUTH_VERSION' );
		$key_id    = $this->header( 'HTTP_X_NEWSROOM_KEY_ID' );
		$timestamp = $this->header( 'HTTP_X_NEWSROOM_TIMESTAMP' );
		$signature = $this->header( 'HTTP_X_NEWSROOM_SIGNATURE' );
		if (
			self::PROTOCOL_VERSION !== $version
			|| ! Newsroom_Bridge_Security_Config::key_id_is_valid( $key_id )
			|| ! is_string( $timestamp )
			|| 1 !== preg_match( '/\A[0-9]{10,12}\z/D', $timestamp )
			|| ! is_string( $signature )
			|| 1 !== preg_match( '/\A[0-9a-f]{64}\z/D', $signature )
		) {
			return $this->failure( 'malformed_headers', '', $category );
		}

		if ( PHP_INT_SIZE < 8 ) {
			return $this->failure( 'integer_width', $key_id, $category );
		}
		$timestamp_value = (int) $timestamp;
		$skew            = $timestamp_value - time();
		if ( ! self::timestamp_is_within_window( $timestamp, time() ) ) {
			return $this->failure( 'timestamp', $key_id, $category, $skew < 0 ? 'past' : 'future' );
		}

		$secret = $this->config->secret_for_key_id( $key_id );
		if ( false === $secret ) {
			return $this->failure( 'key', $key_id, $category );
		}

		$raw_body = file_get_contents( 'php://input' );
		if ( false === $raw_body || ( 'GET' === $method && '' !== $raw_body ) ) {
			return $this->failure( 'body', $key_id, $category );
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
			return $this->failure( 'signature', $key_id, $category );
		}

		$service_user_id = $this->config->service_user_id();
		$service_user    = get_user_by( 'id', $service_user_id );
		if (
			! defined( 'NEWSROOM_BRIDGE_USER_ID' )
			|| (int) NEWSROOM_BRIDGE_USER_ID !== $service_user_id
			|| ! $this->service_user->policy_is_valid( $service_user )
		) {
			return $this->failure( 'service_policy', $key_id, $category );
		}

		if ( ! $this->candidate instanceof WP_REST_Request || rest_get_server()->is_dispatching() || $this->active || null !== $this->proof ) {
			return $this->failure( 'top_level', $key_id, $category );
		}
		$this->proof = array(
			'method' => $method,
			'route' => $route,
			'body_hash' => hash( 'sha256', $raw_body ),
			'key_id' => $key_id,
			'timestamp' => $timestamp,
			'verified' => true,
			'external' => $this->external_facts(),
			'headers' => $this->candidate->get_headers(),
			'request' => $this->candidate,
			'phase' => 'verified',
		);
		if ( ! $this->matches_proof( $this->candidate, false ) ) {
			return $this->failure( 'request_binding', $key_id, $category );
		}
		$this->log( 'authentication_success', $key_id, $category, 'accepted', 'within_window' );
		return true;
	}

	/** Core supplies the actual serve_request object before authentication. No authority here. */
	public function capture_request( $headers, $request = null ) {
		if ( ! $this->active && null === $this->proof && $request instanceof WP_REST_Request ) {
			$this->candidate = $request;
		}
		return $headers;
	}

	public function snapshot_conflict( $result ) {
		if ( ! $this->has_any_hmac_header() ) {
			return $result;
		}
		$this->early_conflict = $this->early_conflict || get_current_user_id() > 0
			|| $this->has_authorization_header() || $this->has_auth_cookie()
			|| ( null !== $result && false !== $result );
		return $this->early_conflict ? $this->failure( 'prior_authentication' ) : $result;
	}

	private function has_auth_cookie() {
		foreach ( array( 'AUTH_COOKIE', 'SECURE_AUTH_COOKIE', 'LOGGED_IN_COOKIE' ) as $constant ) {
			if ( defined( $constant ) && array_key_exists( constant( $constant ), $_COOKIE ) ) {
				return true;
			}
		}
		return false;
	}

	private function external_facts() {
		$facts = array();
		foreach ( array( 'REQUEST_METHOD', 'REQUEST_URI', 'CONTENT_TYPE', 'HTTP_X_NEWSROOM_AUTH_VERSION', 'HTTP_X_NEWSROOM_KEY_ID', 'HTTP_X_NEWSROOM_TIMESTAMP', 'HTTP_X_NEWSROOM_SIGNATURE', 'HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION', 'HTTP_X_HTTP_METHOD_OVERRIDE' ) as $name ) {
			$facts[ $name ] = array_key_exists( $name, $_SERVER ) ? $_SERVER[ $name ] : null;
		}
		return $facts;
	}

	private function matches_proof( $request, $routed = true ) {
		if ( ! is_array( $this->proof ) || ! $request instanceof WP_REST_Request ) {
			return false;
		}
		$p = $this->proof;
		$expected_url = 'GET' === $p['method'] ? array( 'draft_key' => substr( $p['route'], strlen( '/newsroom/v1/drafts/' ) ) ) : array();
		return true === $p['verified'] && $request === $p['request']
			&& $request->get_method() === $p['method'] && $request->get_route() === $p['route']
			&& hash_equals( $p['body_hash'], hash( 'sha256', $request->get_body() ) )
			&& $request->get_headers() === $p['headers'] && $this->external_facts() === $p['external']
			&& $this->current_external_rest_route() === $p['route']
			&& array() === $request->get_query_params() && array() === $request->get_body_params()
			&& array() === $request->get_file_params() && array() === $request->get_default_params()
			&& ( ! $routed || $expected_url === $request->get_url_params() )
			&& $request->get_json_params() === json_decode( $request->get_body(), true );
	}

	public function guard_dispatch( $response, $server, $request ) {
		unset( $server );
		// Every nested dispatch is denied, even recursion of the exact owner object.
		if ( $this->active ) {
			return $this->failure( 'nested_dispatch', '', 'unsupported', '', false );
		}
		if ( null === $this->proof && ! $this->has_any_hmac_header() ) {
			return $response;
		}
		if ( ! is_array( $this->proof ) || 'verified' !== $this->proof['phase'] || ! $this->matches_proof( $request, false ) ) {
			return $this->failure( 'dispatch_binding' );
		}
		$this->proof['phase'] = 'permission';
		return $response;
	}

	/** Wrap only the unchanged bridge's two original handlers, never a namespace. */
	public function wrap_endpoints( $endpoints ) {
		$routes = array( '/newsroom/v1/drafts' => 'create_draft', '/newsroom/v1/drafts/(?P<draft_key>[a-f0-9-]{36})' => 'get_draft' );
		foreach ( $routes as $route => $method ) {
			if ( ! isset( $endpoints[ $route ] ) ) {
				continue;
			}
			foreach ( $endpoints[ $route ] as &$handler ) {
				if ( ! is_array( $handler ) || ! isset( $handler['callback'], $handler['permission_callback'] ) ) {
					continue;
				}
				$callback = $handler['callback'];
				$permission = $handler['permission_callback'];
				if ( ! is_array( $callback ) || ! $callback[0] instanceof Newsroom_Bridge_REST || $method !== $callback[1]
					|| ! is_array( $permission ) || $permission[0] !== $callback[0] || 'permission_check' !== $permission[1] ) {
					continue;
				}
				$handler['permission_callback'] = function ( $request ) use ( $permission ) {
					return $this->execute( $permission, $request, 'permission' );
				};
				$handler['callback'] = function ( $request ) use ( $callback ) {
					return $this->execute( $callback, $request, 'callback' );
				};
			}
			unset( $handler );
		}
		return $endpoints;
	}

	private function execute( $callback, $request, $phase ) {
		if ( $this->active ) {
			return $this->failure( 'nested_execution', '', 'unsupported', '', false );
		}
		// Preserve the explicitly disabled legacy stage; it grants no internal authority.
		if ( ! $this->has_any_hmac_header() && $this->config->hmac_is_intentionally_disabled() && null === $this->proof ) {
			return call_user_func( $callback, $request );
		}
		$previous = get_current_user_id();
		$keep_permission = false;
		$entered = false;
		try {
			if ( ! is_array( $this->proof ) || $phase !== $this->proof['phase'] || ! $this->matches_proof( $request )
				|| $this->early_conflict || 0 !== $previous || $this->has_authorization_header() || $this->has_auth_cookie()
				|| ! $this->config->hmac_prerequisites_are_valid()
				|| ! $this->service_user->policy_is_valid( get_user_by( 'id', $this->config->service_user_id() ) ) ) {
				return $this->failure( 'execution_binding' );
			}
			$this->proof['phase'] = 'executing';
			$this->active = true;
			$entered = true;
			wp_set_current_user( $this->config->service_user_id() );
			if ( get_current_user_id() !== $this->config->service_user_id() || ! $this->matches_proof( $request ) ) {
				return $this->failure( 'service_context' );
			}
			$result = call_user_func( $callback, $request );
			$keep_permission = 'permission' === $phase && true === $result && $this->matches_proof( $request );
			return $result;
		} finally {
			$restored = false;
			try {
				if ( $entered ) {
					wp_set_current_user( $previous );
				}
				$restored = get_current_user_id() === $previous;
			} finally {
				$this->active = false;
				if ( $restored && $keep_permission && is_array( $this->proof ) ) {
					$this->proof['phase'] = 'callback';
				} else {
					$this->proof = null;
					$this->candidate = null;
				}
			}
		}
	}

	/** Proof disposal only: user restoration never depends on a REST filter. */
	public function clear_after_callbacks( $response, $unused, $request ) {
		unset( $unused );
		if ( ! $this->active && is_array( $this->proof ) && $request === $this->proof['request'] ) {
			$this->proof = null;
			$this->candidate = null;
		}
		return $response;
	}

	private function current_external_rest_route() {
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

	private function route_category( $method, $route ) {
		if ( 'POST' === $method && '/newsroom/v1/drafts' === $route ) {
			return 'draft_create';
		}

		if (
			'GET' === $method
			&& 1 === preg_match( '#\A/newsroom/v1/drafts/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z#D', $route )
		) {
			return 'draft_lookup';
		}

		return '';
	}

	private static function timestamp_is_within_window( $timestamp, $now ) {
		if ( PHP_INT_SIZE < 8 || ! is_string( $timestamp ) || 1 !== preg_match( '/\A[0-9]{10,12}\z/D', $timestamp ) || ! is_int( $now ) ) {
			return false;
		}
		$skew = (int) $timestamp - $now;
		return $skew >= -self::MAX_CLOCK_SKEW && $skew <= self::MAX_CLOCK_SKEW;
	}

	private function has_any_hmac_header() {
		foreach ( array( 'HTTP_X_NEWSROOM_AUTH_VERSION', 'HTTP_X_NEWSROOM_KEY_ID', 'HTTP_X_NEWSROOM_TIMESTAMP', 'HTTP_X_NEWSROOM_SIGNATURE' ) as $name ) {
			if ( $this->header_exists( $name ) ) {
				return true;
			}
		}

		return false;
	}

	private function has_authorization_header() {
		foreach ( array( 'HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION' ) as $name ) {
			if ( ! $this->header_exists( $name ) ) {
				continue;
			}

			$value = $this->header( $name );
			if ( ! is_string( $value ) || '' !== $value ) {
				return true;
			}
		}

		return false;
	}

	private function has_method_override() {
		return $this->header_exists( 'HTTP_X_HTTP_METHOD_OVERRIDE' )
			|| array_key_exists( '_method', $_GET )
			|| array_key_exists( '_method', $_POST );
	}

	private function json_content_type_is_valid() {
		$content_type = $this->header( 'CONTENT_TYPE' );
		return is_string( $content_type )
			&& 1 === preg_match( '/\Aapplication\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?\z/iD', $content_type );
	}

	private function header_exists( $name ) {
		return array_key_exists( $name, $_SERVER );
	}

	private function header( $name ) {
		if ( ! $this->header_exists( $name ) || ! is_string( $_SERVER[ $name ] ) ) {
			return null;
		}

		return wp_unslash( $_SERVER[ $name ] );
	}

	private function failure( $result, $key_id = '', $route = 'unsupported', $skew = '', $restore = true ) {
		if ( $restore ) {
			$this->proof = null;
			$this->candidate = null;
		}
		$this->log( 'authentication_failure', $key_id, $route, $result, $skew );
		return new WP_Error(
			'newsroom_hmac_authentication_failed',
			'Newsroom authentication failed.',
			array( 'status' => 401 )
		);
	}

	private function log( $event, $key_id, $route, $result, $skew ) {
		if ( ! $this->config->security_logging_is_enabled() ) {
			return;
		}

		$record = array(
			'component' => 'newsroom_bridge_security',
			'event'     => sanitize_key( $event ),
			'version'   => self::PROTOCOL_VERSION,
			'key_id'    => Newsroom_Bridge_Security_Config::key_id_is_valid( $key_id ) ? $key_id : '',
			'route'     => sanitize_key( $route ),
			'result'    => sanitize_key( $result ),
			'skew'      => sanitize_key( $skew ),
		);
		$encoded = wp_json_encode( $record, JSON_UNESCAPED_SLASHES );
		if ( is_string( $encoded ) ) {
			error_log( $encoded );
		}
	}
}
