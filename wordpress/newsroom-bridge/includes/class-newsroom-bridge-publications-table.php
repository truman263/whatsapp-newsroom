<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

final class Newsroom_Bridge_Publications_Table {
	private const OPTION = 'newsroom_bridge_publications_schema_version';
	public static function name() { global $wpdb; return $wpdb->prefix . 'newsroom_publications'; }
	public static function install() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$table = self::name(); $collate = $wpdb->get_charset_collate();
		$exists = (string) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s', DB_NAME, $table ) ) === '1';
		if ( $exists ) {
			if ( get_option( self::OPTION ) !== NEWSROOM_BRIDGE_PUBLICATIONS_SCHEMA_VERSION || is_wp_error( self::verify() ) ) {
				wp_die( esc_html( 'Newsroom publication storage has unexpected schema drift and requires operator intervention.' ) );
			}
			return;
		}
		dbDelta( "CREATE TABLE {$table} (
			publish_key char(36) NOT NULL,
			draft_key char(36) NOT NULL,
			post_id bigint(20) unsigned NOT NULL,
			expected_applied_version char(64) NOT NULL,
			status enum('RESERVED','PUBLISHED') NOT NULL DEFAULT 'RESERVED',
			published_at datetime NULL,
			created_at datetime NOT NULL,
			updated_at datetime NOT NULL,
			PRIMARY KEY  (publish_key),
			UNIQUE KEY draft_version (draft_key,expected_applied_version),
			KEY post_id (post_id)
		) ENGINE=InnoDB {$collate};" );
		update_option( self::OPTION, NEWSROOM_BRIDGE_PUBLICATIONS_SCHEMA_VERSION, false );
		$verified = self::verify();
		if ( is_wp_error( $verified ) ) { delete_option( self::OPTION ); wp_die( esc_html( 'Newsroom publication storage contract verification failed.' ) ); }
	}
	public static function verify() {
		global $wpdb; $table = self::name();
		if ( get_option( self::OPTION ) !== NEWSROOM_BRIDGE_PUBLICATIONS_SCHEMA_VERSION ) return self::error();
		$t = $wpdb->get_row( $wpdb->prepare( 'SELECT ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s', DB_NAME, $table ), ARRAY_A );
		if ( ! is_array( $t ) || 'INNODB' !== strtoupper( (string) $t['ENGINE'] ) || '' === (string) $t['TABLE_COLLATION'] || ( '' !== (string) $wpdb->collate && (string) $t['TABLE_COLLATION'] !== (string) $wpdb->collate ) ) return self::error();
		$rows=$wpdb->get_results($wpdb->prepare('SELECT COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s ORDER BY ORDINAL_POSITION',DB_NAME,$table),ARRAY_A);
		$expected=array('publish_key'=>array('char',36,'NO'),'draft_key'=>array('char',36,'NO'),'post_id'=>array('bigint',null,'NO'),'expected_applied_version'=>array('char',64,'NO'),'status'=>array('enum',null,'NO'),'published_at'=>array('datetime',null,'YES'),'created_at'=>array('datetime',null,'NO'),'updated_at'=>array('datetime',null,'NO')); $cols=array(); foreach((array)$rows as $r)$cols[$r['COLUMN_NAME']]=$r;
		if(count($cols)!==count($expected))return self::error(); foreach($expected as $n=>$e){$default=isset($cols[$n])?$cols[$n]['COLUMN_DEFAULT']:null;if(!isset($cols[$n])||strtolower($cols[$n]['DATA_TYPE'])!==$e[0]||$cols[$n]['IS_NULLABLE']!==$e[2]||(null!==$e[1]&&(int)$cols[$n]['CHARACTER_MAXIMUM_LENGTH']!==$e[1])||('status'!==$n&&null!==$default&&'NULL'!==strtoupper(trim((string)$default,"'\""))))return self::error();}
		if(strtolower($cols['status']['COLUMN_TYPE'])!=="enum('reserved','published')"||false===stripos($cols['post_id']['COLUMN_TYPE'],'unsigned'))return self::error();
		if('RESERVED'!==trim((string)$cols['status']['COLUMN_DEFAULT'],"'\""))return self::error();
		foreach(array('publish_key','draft_key','expected_applied_version','status') as $name){if(strtolower((string)$cols[$name]['CHARACTER_SET_NAME'])!==strtolower((string)$wpdb->charset)||(string)$cols[$name]['COLLATION_NAME']!==(string)$t['TABLE_COLLATION'])return self::error();}
		$idx=$wpdb->get_results($wpdb->prepare('SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s ORDER BY INDEX_NAME,SEQ_IN_INDEX',DB_NAME,$table),ARRAY_A); $ix=array();foreach((array)$idx as $r){$ix[$r['INDEX_NAME']]['u']=(int)$r['NON_UNIQUE'];$ix[$r['INDEX_NAME']]['c'][]=$r['COLUMN_NAME'];}
		$primary=isset($ix['PRIMARY'])&&0===$ix['PRIMARY']['u']&&array('publish_key')===$ix['PRIMARY']['c'];$unique=false;$post=false;foreach($ix as $i){$unique=$unique||(0===$i['u']&&array('draft_key','expected_applied_version')===$i['c']);$post=$post||(array('post_id')===$i['c']);} if(!$primary||!$unique||!$post)return self::error();
		$bad=$wpdb->get_var("SELECT COUNT(*) FROM {$table} WHERE status IS NULL OR status NOT IN ('RESERVED','PUBLISHED')"); return '0'===(string)$bad?true:self::error();
	}
	private static function error(){return new WP_Error('newsroom_publication_storage_error','Publication storage does not satisfy the required contract.',array('status'=>503));}
}
