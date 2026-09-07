<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** A schema-specific JSON parser: array of objects with two unique string members. */
final class Newsroom_Bridge_Key_Ring_JSON {
	private $json;
	private $offset = 0;

	private function __construct( $json ) {
		$this->json = $json;
	}

	public static function parse( $json ) {
		if ( ! is_string( $json ) ) {
			return false;
		}
		$parser = new self( $json );
		return $parser->ring();
	}

	private function ring() {
		if ( ! $this->take( '[' ) ) {
			return false;
		}
		$entries = array();
		do {
			if ( ! $this->take( '{' ) ) {
				return false;
			}
			$entry = array();
			do {
				$name = $this->string_value();
				if ( ! in_array( $name, array( 'id', 'secret' ), true ) || array_key_exists( $name, $entry ) || ! $this->take( ':' ) ) {
					return false;
				}
				$value = $this->string_value();
				if ( false === $value ) {
					return false;
				}
				$entry[ $name ] = $value;
			} while ( $this->take( ',' ) );
			if ( 2 !== count( $entry ) || ! $this->take( '}' ) ) {
				return false;
			}
			$entries[] = $entry;
		} while ( $this->take( ',' ) );
		if ( ! $this->take( ']' ) ) {
			return false;
		}
		$this->whitespace();
		return $this->offset === strlen( $this->json ) ? $entries : false;
	}

	private function whitespace() {
		$this->offset += strspn( $this->json, " \t\r\n", $this->offset );
	}

	private function take( $token ) {
		$this->whitespace();
		if ( substr( $this->json, $this->offset, 1 ) !== $token ) {
			return false;
		}
		++$this->offset;
		return true;
	}

	private function string_value() {
		$this->whitespace();
		$start = $this->offset;
		if ( ! $this->take( '"' ) ) {
			return false;
		}
		$length = strlen( $this->json );
		while ( $this->offset < $length ) {
			$character = $this->json[ $this->offset++ ];
			if ( '\\' === $character ) {
				// Skip the escaped byte; json_decode validates the complete string token.
				++$this->offset;
			} elseif ( '"' === $character ) {
				$value = json_decode( substr( $this->json, $start, $this->offset - $start ) );
				return JSON_ERROR_NONE === json_last_error() && is_string( $value ) ? $value : false;
			}
		}
		return false;
	}
}
