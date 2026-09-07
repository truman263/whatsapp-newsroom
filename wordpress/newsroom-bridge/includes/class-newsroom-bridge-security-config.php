<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Validated, read-only view of deployment-provided security configuration.
 */
final class Newsroom_Bridge_Security_Config {
	private const KEY_ID_PATTERN = '/\A[a-z0-9][a-z0-9._-]{0,63}\z/D';

	private $service_user_id;
	private $service_user_id_valid;
	private $lockdown_state;
	private $hmac_state;
	private $logging_enabled;
	private $key_ring;
	private $key_ring_valid;

	private function __construct() {
		$this->service_user_id       = self::read_service_user_id();
		$this->service_user_id_valid = $this->service_user_id > 0;
		$this->lockdown_state        = self::read_boolean_constant( 'NEWSROOM_BRIDGE_SERVICE_LOCKDOWN_ENABLED' );
		$this->hmac_state            = self::read_boolean_constant( 'NEWSROOM_BRIDGE_HMAC_ENABLED' );
		$this->logging_enabled       = true === self::read_boolean_constant( 'NEWSROOM_BRIDGE_SECURITY_LOGGING_ENABLED' );
		$this->key_ring              = array();
		$this->key_ring_valid        = false;

		if ( defined( 'NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON' ) && is_string( NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON ) ) {
			$parsed = self::parse_key_ring_json( NEWSROOM_BRIDGE_DRAFT_HMAC_KEYS_JSON );
			if ( is_array( $parsed ) ) {
				$this->key_ring       = $parsed;
				$this->key_ring_valid = true;
			}
		}
	}

	public static function from_constants() {
		return new self();
	}

	public function service_user_id() {
		return $this->service_user_id;
	}

	public function service_user_id_is_valid() {
		return $this->service_user_id_valid;
	}

	public function hmac_is_enabled() {
		return true === $this->hmac_state;
	}

	public function hmac_is_intentionally_disabled() {
		return null === $this->hmac_state || false === $this->hmac_state;
	}

	public function lockdown_is_explicitly_enabled() {
		return true === $this->lockdown_state;
	}

	/**
	 * HMAC enablement also activates lockdown. This prevents configuration drift
	 * from creating simultaneous generic and route-scoped service authority.
	 */
	public function effective_lockdown_is_enabled() {
		return true === $this->lockdown_state || 'invalid' === $this->lockdown_state || ! $this->hmac_is_intentionally_disabled();
	}

	public function hmac_prerequisites_are_valid() {
		return $this->hmac_is_enabled()
			&& $this->lockdown_is_explicitly_enabled()
			&& $this->service_user_id_valid
			&& $this->key_ring_valid;
	}

	public function security_logging_is_enabled() {
		return $this->logging_enabled;
	}

	public function secret_for_key_id( $key_id ) {
		if ( ! $this->key_ring_valid || ! is_string( $key_id ) || ! array_key_exists( $key_id, $this->key_ring ) ) {
			return false;
		}

		return $this->key_ring[ $key_id ];
	}

	public static function key_id_is_valid( $key_id ) {
		return is_string( $key_id ) && 1 === preg_match( self::KEY_ID_PATTERN, $key_id );
	}

	/**
	 * Parses the complete ring atomically. A single malformed entry rejects all.
	 * Returns decoded 32-byte secrets indexed by exact key ID, or false.
	 */
	public static function parse_key_ring_json( $json ) {
		if ( ! is_string( $json ) || '' === $json ) {
			return false;
		}

		$configured = Newsroom_Bridge_Key_Ring_JSON::parse( $json );
		if ( ! is_array( $configured ) || empty( $configured ) ) {
			return false;
		}

		$validated = array();
		foreach ( $configured as $entry ) {
			if (
				! is_array( $entry )
				|| 2 !== count( $entry )
				|| ! array_key_exists( 'id', $entry )
				|| ! array_key_exists( 'secret', $entry )
				|| ! self::key_id_is_valid( $entry['id'] )
				|| array_key_exists( $entry['id'], $validated )
			) {
				return false;
			}

			$secret = self::decode_secret( $entry['secret'] );
			if ( false === $secret ) {
				return false;
			}

			$validated[ $entry['id'] ] = $secret;
		}

		return $validated;
	}

	private static function read_service_user_id() {
		if ( ! defined( 'NEWSROOM_BRIDGE_USER_ID' ) ) {
			return 0;
		}

		$value = NEWSROOM_BRIDGE_USER_ID;
		if ( is_int( $value ) ) {
			return $value > 0 ? $value : 0;
		}

		if ( is_string( $value ) && 1 === preg_match( '/\A[1-9][0-9]*\z/D', $value ) ) {
			$integer = (int) $value;
			return (string) $integer === $value ? $integer : 0;
		}

		return 0;
	}

	private static function read_boolean_constant( $name ) {
		if ( ! defined( $name ) ) {
			return null;
		}

		$value = constant( $name );
		return is_bool( $value ) ? $value : 'invalid';
	}

	private static function decode_secret( $encoded ) {
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

}
