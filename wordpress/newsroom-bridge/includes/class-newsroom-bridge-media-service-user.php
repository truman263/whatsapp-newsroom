<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Enforces generic-credential lockdown for the media identity and validates
 * the reduced read/upload-only capability set.
 */
final class Newsroom_Bridge_Media_Service_User {
	private const REQUIRED_CAPABILITIES = array(
		'read',
		'upload_files',
	);

	private const FORBIDDEN_CAPABILITIES = array(
		'edit_posts',
		'publish_posts',
		'edit_others_posts',
		'edit_published_posts',
		'edit_private_posts',
		'delete_posts',
		'delete_published_posts',
		'delete_others_posts',
		'delete_private_posts',
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

	private $config;

	public function __construct( Newsroom_Bridge_Media_Config $config ) {
		$this->config = $config;
	}

	public function register() {
		add_filter( 'wp_is_application_passwords_available_for_user', array( $this, 'filter_application_password_availability' ), PHP_INT_MAX, 2 );
		add_filter( 'authenticate', array( $this, 'deny_generic_authentication' ), PHP_INT_MAX, 3 );
	}

	public function filter_application_password_availability( $available, $user ) {
		if ( $this->config->effective_lockdown_is_enabled() && $this->is_service_identity( $user ) ) {
			return false;
		}

		return $available;
	}

	public function deny_generic_authentication( $user, $username, $password = null ) {
		unset( $password );
		if ( ! $this->config->effective_lockdown_is_enabled() || ! $this->config->prerequisites_are_valid() ) {
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

	public function policy_is_valid( $user ) {
		if ( ! $user instanceof WP_User || (int) $user->ID !== $this->config->user_id() ) {
			return false;
		}

		foreach ( self::REQUIRED_CAPABILITIES as $capability ) {
			if ( ! user_can( $user, $capability ) ) {
				return false;
			}
		}

		foreach ( self::FORBIDDEN_CAPABILITIES as $capability ) {
			if ( user_can( $user, $capability ) ) {
				return false;
			}
		}

		if ( is_multisite() && is_super_admin( $user->ID ) ) {
			return false;
		}

		return ! wp_is_application_passwords_available_for_user( $user );
	}

	private function is_service_identity( $user ) {
		return $this->config->prerequisites_are_valid()
			&& $user instanceof WP_User
			&& (int) $user->ID === $this->config->user_id();
	}
}