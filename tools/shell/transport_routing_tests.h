/* Exercise actual transport wrappers without calling the legacy request entry. */
typedef struct { const wchar_t *text; BYTE absolute; } TransportTestUri;
typedef struct { TransportTestUri *uri; void *body,*headers,*callback; } TransportTestRequest;
static TransportTestUri *transport_test_allocations[16];
static size_t transport_test_allocation_count;
static wchar_t transport_test_strings[32][1024];
static size_t transport_test_string_count;
static int transport_test_fail,transport_test_setters,transport_test_sends;
static const wchar_t *transport_test_expected;
static void *transport_test_string_new(const uint16_t *text,int32_t length) {
    wchar_t *out;
    if (length<0 || length>=1024 || transport_test_string_count>=32) return NULL;
    out=transport_test_strings[transport_test_string_count++]; memcpy(out,text,(size_t)length*2); out[length]=0; return out;
}
static int32_t transport_test_length(void *text) { return (int32_t)wcslen(text); }
static const uint16_t *transport_test_chars(void *text) { return text; }
static void *transport_test_new(void *klass) {
    TransportTestUri *uri;
    if (klass!=transport_uri_class || transport_test_allocation_count>=16) { transport_test_fail=1; return NULL; }
    uri=calloc(1,sizeof(*uri)); transport_test_allocations[transport_test_allocation_count++]=uri; return uri;
}
static void transport_test_ctor(void *object,void *text,const void *method) {
    TransportTestUri *uri=object;
    if (method!=sites[SITE_UriCtor].method || sdk_test_root_count<2) transport_test_fail=1;
    uri->text=text; uri->absolute=1;
}
static BYTE transport_test_absolute(void *object,const void *method) {
    if (method!=sites[SITE_UriIsAbsolute].method) transport_test_fail=1;
    return ((TransportTestUri *)object)->absolute;
}
static void *transport_test_absolute_uri(void *object,const void *method) {
    TransportTestUri *uri=object;
    if (method!=sites[SITE_UriAbsolute].method || !uri->absolute) transport_test_fail=1;
    return (void *)uri->text;
}
static void *transport_test_get(void *object,const void *method) {
    if (method!=sites[SITE_BestGetUri].method && method!=sites[SITE_HttpGetUri].method) transport_test_fail=1;
    return ((TransportTestRequest *)object)->uri;
}
static void transport_test_set(void *object,void *uri,const void *method) {
    if ((method!=sites[SITE_BestSetUri].method && method!=sites[SITE_HttpSetUri].method) || sdk_test_root_count<2) transport_test_fail=1;
    ((TransportTestRequest *)object)->uri=uri; ++transport_test_setters;
}
static void transport_test_validate(TransportTestRequest *request) {
    if (request) {
        if (request->body!=(void *)1 || request->headers!=(void *)2 || request->callback!=(void *)3 ||
            (transport_test_expected && wcscmp(request->uri->text,transport_test_expected))) transport_test_fail=1;
    }
    ++transport_test_sends;
}
static void *transport_test_best(void *request,const void *method) {
    if (method!=(void *)7) transport_test_fail=1;
    transport_test_validate(request); return (void *)0x501;
}
static void *transport_test_http(void *client,void *request,int32_t completion,uintptr_t token,const void *method) {
    if (client!=(void *)6 || completion!=1 || token!=UINT64_C(0xfedcba9876543210) || method!=(void *)8) transport_test_fail=1;
    transport_test_validate(request); return (void *)0x502;
}
static void transport_test_unity(void *request,void *url,const void *method) {
    if (request!=(void *)4 || method!=(void *)5 || wcscmp(url,transport_test_expected)) transport_test_fail=1;
    ++transport_test_sends;
}
static void *transport_test_binding_class(void *image,const char *space,const char *name) {
    (void)image; return !strcmp(space,"BestHTTP") && !strcmp(name,"HTTPRequest")?(void *)1:NULL;
}
static int transport_routing_test(BYTE *code) {
    TransportTestUri uri={L"https://official.example/version/client/v1_0/patch?zoneId=22#fragment",1};
    TransportTestRequest request={&uri,(void *)1,(void *)2,(void *)3}; int ok=1; size_t i;
    for (i=0;i<SITE_COUNT;++i) sites[i].method=(void *)(uintptr_t)(i+100);
    transport_uri_class=(void *)123; transport_uri_ctor=transport_test_ctor; transport_uri_is_absolute=transport_test_absolute;
    transport_uri_absolute=transport_test_absolute_uri; transport_best_get=transport_test_get; transport_http_get=transport_test_get;
    transport_best_set=transport_test_set; transport_http_set=transport_test_set;
    transport_best_original=transport_test_best; transport_http_original=transport_test_http; transport_unity_original=transport_test_unity;
    string_new=transport_test_string_new; rt.string_length=transport_test_length; rt.string_chars=transport_test_chars;
    rt.object_new=transport_test_new;
    transport_test_expected=L"http://127.0.0.1:20001/version/client/v1_0/patch?zoneId=22#fragment";
    ok=ok && transport_best_send(&request,(void *)7)==(void *)0x501 && request.uri!=&uri;
    transport_unity_url((void *)4,(void *)uri.text,(void *)5);
    request.uri=&uri;
    ok=ok && transport_http_send((void *)6,&request,1,UINT64_C(0xfedcba9876543210),(void *)8)==(void *)0x502 && request.uri!=&uri;
    /* An original-host fallback attempt must hit the local API as well. */
    uri.text=L"https://backup.example/version/client/v1_0/patch?zoneId=22#fragment"; request.uri=&uri;
    ok=ok && transport_best_send(&request,(void *)7)==(void *)0x501;
    uri.text=L"https://cdn.example/chs/windows/30_package_3217420.hash"; request.uri=&uri; transport_test_expected=uri.text;
    ok=ok && transport_best_send(&request,(void *)7)==(void *)0x501 && request.uri==&uri;
    uri.text=L"/relative/path"; uri.absolute=0; transport_test_expected=uri.text;
    ok=ok && transport_http_send((void *)6,&request,1,UINT64_C(0xfedcba9876543210),(void *)8)==(void *)0x502 && request.uri==&uri;
    ok=ok && transport_best_send(NULL,(void *)7)==(void *)0x501;
    ok=ok && transport_test_setters==3 && transport_test_sends==7 && !transport_test_fail && sdk_test_root_count==0;
    /* Leaf property getters may share code, but a shared patched entry is refused. */
    rt.find_class=transport_test_binding_class; fake_image_count=1; fake_method_count=1;
    memset(fake_methods,0,sizeof(fake_methods)); fake_methods[0].name="get_Uri"; fake_methods[0].result="System.Uri";
    fake_methods[0].native_slots[0]=code; method_pointer_offset=0;
    sites[SITE_HttpGetUri].address=code;
    ok=ok && resolve_site(SITE_BestGetUri)==1;
    sites[SITE_Start].address=code;
    ok=ok && resolve_site(SITE_BestGetUri)==-1;
    for (i=0;i<transport_test_allocation_count;++i) free(transport_test_allocations[i]);
    memset(sites,0,sizeof(sites));
    log_line("Transport routing: bypassed wrapper entries, all three transport boundaries, signed payload preservation, fallback, relative/resource exclusion and shared getters: %s",ok?"PASS":"FAIL");
    return ok;
}
