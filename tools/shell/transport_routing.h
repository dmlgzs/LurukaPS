/* Intercept stable transport boundaries, including interpreted/inlined callers.
 * Only URI properties change; bodies, signed headers, options and returns remain intact.
 */
typedef void *(*TransportGetFn)(void *,const void *);
typedef void (*TransportSetFn)(void *,void *,const void *);
typedef BYTE (*UriAbsoluteFn)(void *,const void *);
typedef void *(*BestSendFn)(void *,const void *);
typedef void *(*HttpSendFn)(void *,void *,int32_t,uintptr_t,const void *);
static TransportSetFn transport_uri_ctor,transport_best_set,transport_http_set;
static TransportGetFn transport_uri_absolute,transport_best_get,transport_http_get;
static UriAbsoluteFn transport_uri_is_absolute;
static BestSendFn transport_best_original;
static HttpSendFn transport_http_original;
static TransportSetFn transport_unity_original;
static void *transport_uri_class;
static int setup_transport_routing(void) {
    typedef int32_t (*ValueSizeFn)(void *,uint32_t *);
    typedef BYTE (*ValueTypeFn)(void *);
    ValueSizeFn value_size=NULL; ValueTypeFn is_value=NULL;
    void *token; uint32_t alignment=0;
    if (!bind_export(runtime_module,"il2cpp_object_new",&rt.object_new,sizeof(rt.object_new)) ||
        !bind_export(runtime_module,"il2cpp_gchandle_new",&rt.gc_new,sizeof(rt.gc_new)) ||
        !bind_export(runtime_module,"il2cpp_gchandle_get_target",&rt.gc_target,sizeof(rt.gc_target)) ||
        !bind_export(runtime_module,"il2cpp_gchandle_free",&rt.gc_free,sizeof(rt.gc_free)) ||
        !bind_export(runtime_module,"il2cpp_class_value_size",&value_size,sizeof(value_size)) ||
        !bind_export(runtime_module,"il2cpp_class_is_valuetype",&is_value,sizeof(is_value))) return 0;
    transport_uri_class=find_runtime_class("System","Uri");
    token=find_runtime_class("System.Threading","CancellationToken");
    if (!transport_uri_class || !token || !is_value(token) || value_size(token,&alignment)!=(int32_t)sizeof(uintptr_t)) {
        log_line("Unsupported Uri/CancellationToken contract for Win64 transport interception"); return 0;
    }
    log_line("Transport routing: BestHTTP, HttpClient and UnityWebRequest boundaries enabled; CancellationToken ABI verified");
    return 1;
}
static void route_transport_uri(void *request,TransportGetFn get_uri,TransportSetFn set_uri,size_t getter,size_t setter,const char *source) {
    void *uri,*absolute,*rewritten,*replacement; int changed; uint32_t string_root,uri_root;
    if (!request) return;
    uri=get_uri(request,sites[getter].method);
    if (!uri || !transport_uri_is_absolute(uri,sites[SITE_UriIsAbsolute].method)) return;
    absolute=transport_uri_absolute(uri,sites[SITE_UriAbsolute].method);
    rewritten=route_managed_url(absolute,&changed);
    if (!changed) return;
    string_root=rt.gc_new(rewritten,0);
    if (!string_root) { local_sdk_fail("Transport URI string GC root failed"); return; }
    rt.class_init(transport_uri_class);
    replacement=rt.object_new(transport_uri_class);
    uri_root=replacement?rt.gc_new(replacement,0):0;
    if (!uri_root) {
        rt.gc_free(string_root); local_sdk_fail("Transport URI allocation/GC root failed"); return;
    }
    transport_uri_ctor(replacement,rt.gc_target(string_root),sites[SITE_UriCtor].method);
    set_uri(request,rt.gc_target(uri_root),sites[setter].method);
    rt.gc_free(uri_root); rt.gc_free(string_root);
    log_line("Transport redirect hit: %s (only the allowlisted URI changed)",source);
}
static void *transport_best_send(void *request,const void *method) {
    route_transport_uri(request,transport_best_get,transport_best_set,SITE_BestGetUri,SITE_BestSetUri,"BestHTTP.HTTPManager.SendRequest");
    return transport_best_original(request,method);
}
static void *transport_http_send(void *client,void *request,int32_t completion,uintptr_t token,const void *method) {
    route_transport_uri(request,transport_http_get,transport_http_set,SITE_HttpGetUri,SITE_HttpSetUri,"HttpClient.SendAsync");
    return transport_http_original(client,request,completion,token,method);
}

static void transport_unity_url(void *request,void *url,const void *method) {
    int changed; void *rewritten=route_managed_url(url,&changed);
    if (changed) log_line("Transport redirect hit: UnityWebRequest.InternalSetUrl (only the allowlisted URI changed)");
    transport_unity_original(request,rewritten,method);
}
