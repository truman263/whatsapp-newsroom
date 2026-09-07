<?php
if ( ! defined('WP_CLI') || ! WP_CLI ) { exit; }
// White-box lifecycle fixtures exercise actual production endpoint closures and frozen callbacks.
// Reflection seeds only the post-cryptographic proof; HTTP tests separately prove authentication.
$config=Newsroom_Bridge_Security_Config::from_constants();
$service=new Newsroom_Bridge_Service_User($config);
$auth=new Newsroom_Bridge_Auth($config,$service);
$bridge=new Newsroom_Bridge_REST(new Newsroom_Bridge_Reconciliation(new Newsroom_Bridge_DB()));
$property=new ReflectionProperty($auth,'proof'); $property->setAccessible(true);
$active=new ReflectionProperty($auth,'active'); $active->setAccessible(true);
$external=new ReflectionMethod($auth,'external_facts'); $external->setAccessible(true);
$check=static function($ok,$message){if(!$ok){throw new RuntimeException($message);}};
$route='/newsroom/v1/drafts/'.$args[0];
global $wp;
$wp->query_vars['rest_route']=$route;
$_SERVER['REQUEST_METHOD']='GET';
$_SERVER['REQUEST_URI']=rtrim(wp_parse_url(rest_url(),PHP_URL_PATH),'/').$route;
$_SERVER['HTTP_X_NEWSROOM_AUTH_VERSION']='1';
unset($_SERVER['HTTP_AUTHORIZATION'],$_SERVER['REDIRECT_HTTP_AUTHORIZATION']);
$_COOKIE=array(); $_GET=array(); $_POST=array();
$endpoints=$auth->wrap_endpoints(array('/newsroom/v1/drafts/(?P<draft_key>[a-f0-9-]{36})'=>array(array('callback'=>array($bridge,'get_draft'),'permission_callback'=>array($bridge,'permission_check')))));
$handler=$endpoints['/newsroom/v1/drafts/(?P<draft_key>[a-f0-9-]{36})'][0];
$results=array();
foreach(array('permission_normal','permission_error','permission_throw','permission_engine_throw','callback_normal','callback_error','callback_throw','callback_engine_throw') as $case){
	wp_set_current_user(0);
	$request=new WP_REST_Request('GET',$route); $request->set_body(''); $request->set_url_params(array('draft_key'=>$args[0]));
	$property->setValue($auth,array('method'=>'GET','route'=>$route,'body_hash'=>hash('sha256',''),'key_id'=>'fixture','timestamp'=>(string)time(),'verified'=>true,'external'=>$external->invoke($auth),'headers'=>$request->get_headers(),'request'=>$request,'phase'=>'verified'));
	$check(null===$auth->guard_dispatch(null,rest_get_server(),$request),'Initial dispatch rejected.');
	$fault=static function($caps)use($case){
		if(get_current_user_id()===(int)NEWSROOM_BRIDGE_USER_ID){
			if('permission_throw'===$case){throw new RuntimeException('Injected permission throwable.');}
			if('permission_engine_throw'===$case){throw new Error('Injected engine throwable.');}
			if('permission_error'===$case){$caps['edit_posts']=false;}
		}
		return $caps;
	};
	$storage_fault=static function($value)use($case){
		if(get_current_user_id()===(int)NEWSROOM_BRIDGE_USER_ID){
			if('callback_throw'===$case){throw new RuntimeException('Injected callback throwable.');}
			if('callback_engine_throw'===$case){throw new Error('Injected engine throwable.');}
			if('callback_error'===$case){return 'invalid-schema-fixture';}
		}
		return $value;
	};
	add_filter('user_has_cap',$fault,PHP_INT_MAX);
	add_filter('pre_option_newsroom_bridge_schema_version',$storage_fault,PHP_INT_MAX);
	$thrown=false;$result=null;
	try{
		$result=call_user_func($handler['permission_callback'],$request);
		$check(0===get_current_user_id() && false===$active->getValue($auth),'Permission failed immediate restoration.');
		if(0===strpos($case,'callback')){
			$check(true===$result,'Callback fixture permission failed.');
			$result=call_user_func($handler['callback'],$request);
		}
	}catch(Throwable $error){
		if(!in_array($error->getMessage(),array('Injected permission throwable.','Injected callback throwable.','Injected engine throwable.'),true)){throw $error;}
		$thrown=true;
	}
	finally{remove_filter('user_has_cap',$fault,PHP_INT_MAX);remove_filter('pre_option_newsroom_bridge_schema_version',$storage_fault,PHP_INT_MAX);}
	$check(0===get_current_user_id() && false===$active->getValue($auth),'Authority leaked after invocation.');
	$check($thrown===(false!==strpos($case,'throw')),'Unexpected exception result.');
	if(false!==strpos($case,'error')){$check(is_wp_error($result),'Expected WP_Error.');}
	if('permission_normal'===$case){$check(true===$result,'Expected permission success.');}
	if('callback_normal'===$case){$check($result instanceof WP_REST_Response && 200===$result->get_status(),'Expected callback success.');}
	$reuse=$auth->guard_dispatch(null,rest_get_server(),$request);
	$check(is_wp_error($reuse)&&401===$reuse->get_error_data()['status']&&null===$property->getValue($auth),'Proof was reusable by another dispatch.');
	$results[$case]=array('restored'=>true,'inactive'=>true,'redispatch'=>401,'thrown'=>$thrown);
}
// Hooks run inside wp_set_current_user: mutation must be caught before the frozen call,
// and a throwing restoration hook must consume permission proof immediately.
foreach(array('entry_mutation','entry_throw','restoration_throw') as $case){
	wp_set_current_user(0);
	$request=new WP_REST_Request('GET',$route);$request->set_body('');$request->set_url_params(array('draft_key'=>$args[0]));
	$property->setValue($auth,array('method'=>'GET','route'=>$route,'body_hash'=>hash('sha256',''),'key_id'=>'fixture','timestamp'=>(string)time(),'verified'=>true,'external'=>$external->invoke($auth),'headers'=>$request->get_headers(),'request'=>$request,'phase'=>'permission'));
	$hook=static function()use($case,$request){
		if('entry_mutation'===$case && get_current_user_id()===(int)NEWSROOM_BRIDGE_USER_ID){$request->set_method('DELETE');}
		if(('entry_throw'===$case && get_current_user_id()===(int)NEWSROOM_BRIDGE_USER_ID)||('restoration_throw'===$case && 0===get_current_user_id())){throw new Error('Injected user-context throwable.');}
	};
	add_action('set_current_user',$hook,PHP_INT_MAX);
	$thrown=false;$result=null;
	try{$result=call_user_func($handler['permission_callback'],$request);}
	catch(Throwable $error){if('Injected user-context throwable.'!==$error->getMessage()){throw $error;}$thrown=true;}
	finally{remove_action('set_current_user',$hook,PHP_INT_MAX);}
	$check(0===get_current_user_id()&&false===$active->getValue($auth)&&null===$property->getValue($auth),'Context hook left authority or proof.');
	$check($thrown===('entry_mutation'!==$case),'Context hook throwable result mismatch.');
	if('entry_mutation'===$case){$check(is_wp_error($result)&&401===$result->get_error_data()['status'],'Entry mutation reached frozen permission.');}
	$reuse=call_user_func($handler['callback'],$request);
	$check(is_wp_error($reuse)&&401===$reuse->get_error_data()['status'],'Context-hook proof reused.');
	$results[$case]=array('restored'=>true,'inactive'=>true,'redispatch'=>401,'thrown'=>$thrown);
}
// Mutations between successful permission and callback must invalidate the proof.
foreach(array('route','method','raw_body','query','parsed_body','header') as $mutation){
	wp_set_current_user(0);$request=new WP_REST_Request('GET',$route);$request->set_body('');$request->set_url_params(array('draft_key'=>$args[0]));
	$property->setValue($auth,array('method'=>'GET','route'=>$route,'body_hash'=>hash('sha256',''),'key_id'=>'fixture','timestamp'=>(string)time(),'verified'=>true,'external'=>$external->invoke($auth),'headers'=>$request->get_headers(),'request'=>$request,'phase'=>'permission'));
	$check(true===call_user_func($handler['permission_callback'],$request),'Mutation fixture permission failed.');
	if('route'===$mutation){$request->set_route('/wp/v2/posts');}
	if('method'===$mutation){$request->set_method('POST');}
	if('raw_body'===$mutation){$request->set_body('{}');}
	if('query'===$mutation){$request->set_query_params(array('x'=>'1'));}
	if('parsed_body'===$mutation){$request->set_param('title','tamper');}
	if('header'===$mutation){$request->set_header('X-Newsroom-Key-Id','tamper');}
	$result=call_user_func($handler['callback'],$request);
	$check(is_wp_error($result)&&401===$result->get_error_data()['status']&&0===get_current_user_id()&&false===$active->getValue($auth)&&null===$property->getValue($auth),'Mutation accepted or state leaked.');
	$results['mutation_'.$mutation]=401;
}
echo wp_json_encode($results);
