/* Native contract test with moved fields/enums and a one-shot client handler model. */
typedef struct { size_t offset; const char *type; } SdkTestField;
static SdkTestField sdk_test_handler_field={48,"MJUnionSDK.MJSDKHandler"};
static SdkTestField sdk_test_code_field={32,"System.Int32"};
static SdkTestField sdk_test_user_field={64,"MJUnionSDK.MJSDKUserInfo"};
static SdkTestField sdk_test_open_field={40,"System.String"};
static void *sdk_test_objects[64],*sdk_test_roots[128],*sdk_test_callbacks[256];
static size_t sdk_test_object_count,sdk_test_root_count;
static int sdk_test_events[64],sdk_test_event_count,sdk_test_fail,sdk_test_forward,sdk_test_callback_count;
static wchar_t sdk_test_strings[16][129];
static int sdk_test_string_count,sdk_test_constructors;
static void *sdk_test_object_class(void *object) { void *klass; memcpy(&klass,object,sizeof(klass)); return klass; }
static const char *sdk_test_class_name(void *klass) {
    size_t i; for (i=0;i<LOCAL_TYPE_COUNT;++i) if (klass==local_classes[i]) return local_type_names[i];
    return klass==local_handler_class?"MJSDKHandler":"OtherStrategy";
}
static const char *sdk_test_namespace(void *klass) { (void)klass; return "MJUnionSDK"; }
static void *sdk_test_field(void *klass,const char *name) {
    if (klass==local_classes[LOCAL_STRATEGY] && !strcmp(name,"m_Handler")) return &sdk_test_handler_field;
    if ((klass==local_classes[LOCAL_DATA] || klass==local_classes[LOCAL_INIT_DATA] || klass==local_classes[LOCAL_LOGIN_DATA]) && !strcmp(name,"code")) return &sdk_test_code_field;
    if (klass==local_classes[LOCAL_LOGIN_DATA] && !strcmp(name,"userInfo")) return &sdk_test_user_field;
    if (klass==local_classes[LOCAL_USER] && !strcmp(name,"openId")) return &sdk_test_open_field;
    return NULL;
}
static size_t sdk_test_offset(void *field) { return ((SdkTestField *)field)->offset; }
static const void *sdk_test_field_type(void *field) { return ((SdkTestField *)field)->type; }
static void sdk_test_value(void *object,void *field,void *out) {
    SdkTestField *f=field; memcpy(out,(BYTE *)object+f->offset,!strcmp(f->type,"System.Int32")?4:sizeof(void *));
}
static size_t sdk_test_size(void *object) { (void)object; return 128; }
static void sdk_test_barrier(void *object,void **slot,void *value) {
    if ((BYTE *)slot<(BYTE *)object+16 || (BYTE *)slot+sizeof(void *)>(BYTE *)object+128) sdk_test_fail=1;
    memcpy(slot,&value,sizeof(value));
}
static void sdk_test_class_init(void *klass) { (void)klass; }
static void *sdk_test_new(void *klass) {
    void *object=calloc(1,128);
    if (!object || sdk_test_object_count>=64) { free(object); return NULL; }
    memcpy(object,&klass,sizeof(klass)); sdk_test_objects[sdk_test_object_count++]=object; return object;
}
static uint32_t sdk_test_gc_new(void *object,BYTE pinned) {
    uint32_t i; (void)pinned;
    for (i=1;i<128;++i) if (!sdk_test_roots[i]) { sdk_test_roots[i]=object; ++sdk_test_root_count; return i; }
    return 0;
}
static void *sdk_test_gc_target(uint32_t handle) { return handle<128?sdk_test_roots[handle]:NULL; }
static void sdk_test_gc_free(uint32_t handle) {
    if (!handle || handle>=128 || !sdk_test_roots[handle]) { sdk_test_fail=1; return; }
    sdk_test_roots[handle]=NULL; --sdk_test_root_count;
}
static void *sdk_test_invoke(const void *method,void *object,void **args,void **exception) {
    size_t i; *exception=NULL;
    for (i=0;i<LOCAL_TYPE_COUNT;++i) if (method==local_constructors[i] && object_class(object)==local_classes[i]) break;
    if (i==LOCAL_TYPE_COUNT || args || !sdk_test_root_count) sdk_test_fail=1;
    ++sdk_test_constructors; return NULL;
}
static void *sdk_test_string(const uint16_t *text,int32_t length) {
    wchar_t *out;
    if (sdk_test_string_count>=16 || length>128) return NULL;
    out=sdk_test_strings[sdk_test_string_count++]; memcpy(out,text,(size_t)length*2); out[length]=0; return out;
}
static void sdk_test_register(void *self,int32_t event,void *callback,BYTE once,const void *method) {
    if (!local_sdk_instance(self) || !once || method!=sites[SITE_SdkRegister].method) sdk_test_fail=1;
    sdk_test_events[sdk_test_event_count++]=1000+event; sdk_test_callbacks[event]=callback;
}
static void sdk_test_dispatch(void *handler,int32_t event,void *data,void *method) {
    if (object_class(handler)!=local_handler_class || method!=sites[SITE_SdkTrigger].method || !sdk_test_root_count) sdk_test_fail=1;
    sdk_test_events[sdk_test_event_count++]=2000+event;
    if (event==login_event) {
        void *user=NULL,*open=NULL,*token=(void *)1;
        sdk_test_value(data,&sdk_test_user_field,&user);
        if (!user) sdk_test_fail=1;
        else {
            sdk_test_value(user,&sdk_test_open_field,&open); memcpy(&token,(BYTE *)user+56,sizeof(token));
            if (!open || wcscmp(open,L"sdk-local-test") || token) sdk_test_fail=1;
        }
    }
    if (sdk_test_callbacks[event]) { ++sdk_test_callback_count; sdk_test_callbacks[event]=NULL; }
}
static void *sdk_test_factory_forward(int32_t platform,BYTE enabled,BYTE virt,void *method) {
    if (platform!=8 || !enabled || virt!=1 || method!=(void *)7) sdk_test_fail=1;
    ++sdk_test_forward; return (void *)99;
}
static void *sdk_test_region_forward(void *factory,int32_t platform,BYTE enabled,BYTE virt,void *method) {
    if (factory!=(void *)17) sdk_test_fail=1;
    return sdk_test_factory_forward(platform,enabled,virt,method);
}
static void sdk_test_initialize_forward(void *self,void *go,void *handler,void *method) {
    if (!self || go!=(void *)2 || handler!=(void *)3 || method!=(void *)4) sdk_test_fail=1;
    ++sdk_test_forward;
}
static void sdk_test_init_forward(void *self,void *callback,void *method) {
    if (!self || callback!=(void *)2 || method!=(void *)3) sdk_test_fail=1;
    ++sdk_test_forward;
}
static void sdk_test_login_forward(void *self,void *param,void *callback,void *method) {
    if (!self || param!=(void *)2 || callback!=(void *)3 || method!=(void *)4) sdk_test_fail=1;
    ++sdk_test_forward;
}
static void *sdk_test_get_forward(void *self,int32_t type,void *args,void *method) {
    if (!self || type!=9 || args!=(void *)2 || method!=(void *)3) sdk_test_fail=1;
    ++sdk_test_forward; return (void *)88;
}
static BYTE sdk_test_set_forward(void *self,int32_t type,void *args,void *method) {
    sdk_test_get_forward(self,type,args,method); return 1;
}
static void *sdk_test_legacy_class(void *image,const char *space,const char *name) {
    (void)image;
    return !strcmp(space,"MJUnionSDK") && !strcmp(name,"EditorStrategy")?(void *)888:NULL;
}
static int local_sdk_self_test(void) {
    static const int expected[]={1101,2101,2102,1103,2103,1104,2104,2102,1103,2103};
    void *self,*handler,*other,*klass=(void *)999; size_t i; int ok=1,writes;
    for (i=0;i<LOCAL_TYPE_COUNT;++i) { local_classes[i]=(void *)(uintptr_t)(100+i); local_constructors[i]=(const void *)(uintptr_t)(200+i); }
    local_handler_class=(void *)105; local_sdk_enabled=1;
    local_init_event=101; local_begin_event=102; login_event=103; local_logout_event=104;
    object_class=sdk_test_object_class; class_name=sdk_test_class_name; class_namespace=sdk_test_namespace;
    class_field=sdk_test_field; field_offset=sdk_test_offset; write_barrier=sdk_test_barrier; string_new=sdk_test_string;
    rt.field_type=sdk_test_field_type; rt.field_value=sdk_test_value; rt.object_size=sdk_test_size;
    rt.class_init=sdk_test_class_init; rt.object_new=sdk_test_new; rt.invoke=sdk_test_invoke;
    rt.gc_new=sdk_test_gc_new; rt.gc_target=sdk_test_gc_target; rt.gc_free=sdk_test_gc_free;
    rt.type_name=test_type_name; rt.free_memory=free;
    sdk_register=sdk_test_register; trigger_original=sdk_test_dispatch;
    sdk_factory_original=sdk_test_factory_forward; sdk_region_original=sdk_test_region_forward; sdk_initialize_original=sdk_test_initialize_forward;
    sdk_init_original=sdk_test_init_forward; sdk_login_original=sdk_test_login_forward; sdk_logout_original=sdk_test_login_forward;
    sdk_get_original=sdk_test_get_forward; sdk_set_original=sdk_test_set_forward;
    sites[SITE_SdkRegister].method=(void *)11; sites[SITE_SdkTrigger].method=(void *)12;
    wcscpy(selected_open_id,L"sdk-local-test");
    self=local_sdk_region((void *)17,8,0,0,NULL);
    ok=ok && local_sdk_instance(local_sdk_factory(8,0,0,NULL)); handler=sdk_test_new(local_handler_class);
    local_sdk_initialize(self,NULL,handler,NULL);
    ok=ok && local_sdk_handler(self)==handler && sdk_test_root_count==0;
    local_sdk_init(self,(void *)1,NULL);
    local_sdk_login(self,(void *)2,(void *)3,NULL);
    local_sdk_logout(self,(void *)4,(void *)5,NULL);
    local_sdk_login(self,NULL,(void *)6,NULL);
    ok=ok && sdk_test_event_count==(int)(sizeof(expected)/sizeof(expected[0])) && sdk_test_callback_count==4;
    for (i=0;i<sizeof(expected)/sizeof(expected[0]) && i<(size_t)sdk_test_event_count;++i) ok=ok && sdk_test_events[i]==expected[i];
    ok=ok && !wcscmp(local_sdk_get_data(self,9,NULL,NULL),L"") && !local_sdk_set_data(self,9,NULL,NULL);
    writes=sdk_test_event_count; sdk_test_handler_field.offset=124;
    ok=ok && !local_sdk_reference(self,"MJSDKStrategy","m_Handler","MJUnionSDK.MJSDKHandler",handler) && sdk_test_event_count==writes;
    sdk_test_handler_field.offset=48;
    other=sdk_test_new(klass);
    ok=ok && local_sdk_factory(8,1,1,(void *)7)==(void *)99;
    ok=ok && local_sdk_region((void *)17,8,1,1,(void *)7)==(void *)99;
    local_sdk_initialize(other,(void *)2,(void *)3,(void *)4); local_sdk_init(other,(void *)2,(void *)3);
    local_sdk_login(other,(void *)2,(void *)3,(void *)4); local_sdk_logout(other,(void *)2,(void *)3,(void *)4);
    ok=ok && local_sdk_get_data(other,9,(void *)2,(void *)3)==(void *)88 && local_sdk_set_data(other,9,(void *)2,(void *)3);
    ok=ok && sdk_test_forward==8 && !sdk_test_fail && sdk_test_root_count==0 && sdk_test_constructors==10;
    rt.domain_get=fake_domain; rt.assemblies=fake_assemblies; rt.assembly_image=fake_image;
    rt.find_class=sdk_test_legacy_class; fake_image_count=1;
    ok=ok && setup_local_sdk() && !local_sdk_enabled && !site_enabled(SITE_SdkFactory);
    for (i=0;i<sdk_test_object_count;++i) free(sdk_test_objects[i]);
    memset(sites,0,sizeof(sites));
    log_line("Local release SDK: moved fields/enums, callback order, selected identity, GC roots, repeated login/logout and native passthrough: %s",ok?"PASS":"FAIL");
    return ok;
}
