<?php
/**
 * TEST-ONLY disposable media-authority prototype configuration.
 *
 * NOT PRODUCTION CODE. Never load this plugin into a production WordPress
 * installation. It exists only to prove the Round 2B.3B media-authority and
 * idempotency semantics inside the disposable media-authority-proof runtime.
 *
 * Media authority is separated from draft authority: distinct headers, key
 * ring, service identity, and canonical protocol. No secret is ever written
 * to WordPress storage.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // TEST-ONLY prototype; same guard as production bridge.
}

/**
 * Validated view of the disposable media-prototype configuration.
 */
final class Test_Only_Media_Config {

	private const KEY_ID_PATTERN = '/\A[a-z0-9][a-z0-9._-]{0,63}\z/D';

	private $user_id;
	private $hmac_enabled;
	private $lockdown_enabled;
	private $logging_enabled;
	private $key_ring;
	private $key_ring_valid;
	private $max_bytes;

	private function __construct() {
		$this->user_id          = defined( 'TEST_MEDIA_USER_ID' ) && (int) TEST_MEDIA_USER_ID > 0 ? (int) TEST_MEDIA_USER_ID : 0;
		$this->hmac_enabled     = defined( 'TEST_MEDIA_HMAC_ENABLED' ) && true === TEST_MEDIA_HMAC_ENABLED;
		$this->lockdown_enabled = defined( 'TEST_MEDIA_SERVICE_LOCKDOWN_ENABLED' ) && true === TEST_MEDIA_SERVICE_LOCKDOWN_ENABLED;
		$this->logging_enabled  = defined( 'TEST_MEDIA_SECURITY_LOGGING_ENABLED' ) && true === TEST_MEDIA_SECURITY_LOGGING_ENABLED;
		$this->max_bytes        = defined( 'TEST_MEDIA_MAX_BYTES' ) && (int) TEST_MEDIA_MAX_BYTES >= 1 ? (int) TEST_MEDIA_MAX_BYTES : 1048576;
		$this->key_ring         = array();
		$this->key_ring_valid   = false;

		if ( defined( 'TEST_MEDIA_HMAC_KEYS_JSON' ) && is_string( TEST_MEDIA_HMAC_KEYS_JSON ) ) {
			$parsed = self::parse_key_ring_json( TEST_MEDIA_HMAC_KEYS_JSON );
			if ( is_array( $parsed ) ) {
				$this->key_ring       = $parsed;
				$this->key_ring_valid = true;
			}
		}
	}

	public static function from_constants() {
		return new self();
	}

	public function user_id() {
		return $this->user_id;
	}

	public function user_id_is_valid() {
		return $this->user_id > 0;
	}

	public function hmac_is_enabled() {
		return $this->hmac_enabled;
	}

	public function lockdown_is_enabled() {
		return $this->lockdown_enabled;
	}

	public function logging_is_enabled() {
		return $this->logging_enabled;
	}

	public function max_bytes() {
		return $this->max_bytes;
	}

	public function prerequisites_are_valid() {
		return $this->hmac_enabled && $this->lockdown_enabled && $this->user_id_is_valid() && $this->key_ring_valid;
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
	 * Atomic ring parse. Exact same shape contract as the production key ring:
	 * nonempty array of exactly {id, secret}; strict canonical base64url secret.
	 */
	public static function parse_key_ring_json( $json ) {
		if ( ! is_string( $json ) || '' === $json ) {
			return false;
		}

		$decoded = json_decode( $json, true );
		if ( ! is_array( $decoded ) || empty( $decoded ) ) {
			return false;
		}

		$validated = array();
		foreach ( $decoded as $entry ) {
			if (
				! is_array( $entry )
				|| 2 !== count( $entry )
				|| ! array_key_exists( 'id', $entry )
				|| ! array_key_exists( 'secret', $entry )
				|| ! is_string( $entry['id'] )
				|| ! self::key_id_is_valid( $entry['id'] )
				|| array_key_exists( $entry['id'], $validated )
				|| ! is_string( $entry['secret'] )
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