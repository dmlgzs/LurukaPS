/* Local emulator SDK adapter for release builds that omit EditorStrategy.
 * Reuse typed managed objects and the client's handler; no official credentials.
 */
typedef void *(*SdkRegionFn)(void *,int32_t,BYTE,BYTE,void *);
typedef void *(*SdkFactoryFn)(int32_t,BYTE,BYTE,void *);
typedef void (*SdkInitializeFn)(void *,void *,void *,void *);
typedef void (*SdkInitFn)(void *,void *,void *);
typedef void (*SdkLoginFn)(void *,void *,void *,void *);
typedef void (*SdkRegisterFn)(void *,int32_t,void *,BYTE,const void *);
typedef void *(*SdkGetFn)(void *,int32_t,void *,void *);
typedef BYTE (*SdkSetFn)(void *,int32_t,void *,void *);
static SdkFactoryFn sdk_factory_original;
static SdkRegionFn sdk_region_original;
static SdkInitializeFn sdk_initialize_original;
static SdkInitFn sdk_init_original;
static SdkLoginFn sdk_login_original,sdk_logout_original;
static SdkRegisterFn sdk_register;
static SdkGetFn sdk_get_original;
static SdkSetFn sdk_set_original;
enum { LOCAL_STRATEGY,LOCAL_DATA,LOCAL_INIT_DATA,LOCAL_LOGIN_DATA,LOCAL_USER,LOCAL_TYPE_COUNT };
enum { LOCAL_SDK_SUCCESS=0 };
static const char *local_type_names[LOCAL_TYPE_COUNT]={
    "MJSDKStrategy","MJSDKData","MJSDKInitData","MJSDKLoginData","MJSDKUserInfo"
};
static void *local_classes[LOCAL_TYPE_COUNT],*local_handler_class;
static const void *local_constructors[LOCAL_TYPE_COUNT];
static int32_t local_init_event,local_begin_event,local_logout_event;
static LONG local_sdk_unknown_reads,local_sdk_unknown_writes;
static void local_sdk_fail(const char *reason) { error(reason); ExitProcess(1); }
static const void *local_default_constructor(void *klass) {
    MethodSpec spec={"local SDK constructor","","",".ctor","System.Void",0,0,{0}};
    const void *method,*found=NULL; void *iterator=NULL;
    while ((method=rt.methods(klass,&iterator))!=NULL) {
        if (!method_matches(method,&spec)) continue;
        if (found) return NULL;
        found=method;
    }
    return found; /* Metadata invocation also supports a shared/short ctor. */
}
static int local_field_type(void *klass,const char *name,const char *type) {
    void *field=class_field(klass,name);
    return field && type_matches(rt.field_type(field),type);
}
static int setup_local_sdk(void) {
    size_t i;
    local_sdk_enabled=0;
    if (find_runtime_class("MJUnionSDK","EditorStrategy")) {
        log_line("SDK policy: retained client EditorStrategy"); return 1;
    }
    if (!bind_export(runtime_module,"il2cpp_object_new",&rt.object_new,sizeof(rt.object_new)) ||
        !bind_export(runtime_module,"il2cpp_runtime_invoke",&rt.invoke,sizeof(rt.invoke)) ||
        !bind_export(runtime_module,"il2cpp_gchandle_new",&rt.gc_new,sizeof(rt.gc_new)) ||
        !bind_export(runtime_module,"il2cpp_gchandle_get_target",&rt.gc_target,sizeof(rt.gc_target)) ||
        !bind_export(runtime_module,"il2cpp_gchandle_free",&rt.gc_free,sizeof(rt.gc_free))) return 0;
    for (i=0;i<LOCAL_TYPE_COUNT;++i) {
        local_classes[i]=find_runtime_class("MJUnionSDK",local_type_names[i]);
        if (!local_classes[i] || !(local_constructors[i]=local_default_constructor(local_classes[i]))) {
            log_line("Missing/ambiguous local SDK type or ctor: %s",local_type_names[i]); return 0;
        }
    }
    local_handler_class=find_runtime_class("MJUnionSDK","MJSDKHandler");
    if (!local_handler_class ||
        !local_field_type(local_classes[LOCAL_STRATEGY],"m_Handler","MJUnionSDK.MJSDKHandler") ||
        !local_field_type(local_classes[LOCAL_DATA],"code","System.Int32") ||
        !local_field_type(local_classes[LOCAL_INIT_DATA],"code","System.Int32") ||
        !local_field_type(local_classes[LOCAL_LOGIN_DATA],"code","System.Int32") ||
        !local_field_type(local_classes[LOCAL_LOGIN_DATA],"userInfo","MJUnionSDK.MJSDKUserInfo") ||
        !local_field_type(local_classes[LOCAL_USER],"openId","System.String") ||
        !resolve_enum_literal("MJUnionSDK","EMJSDKType","Init","MJUnionSDK.EMJSDKType",&local_init_event) ||
        !resolve_enum_literal("MJUnionSDK","EMJSDKType","BeginLogin","MJUnionSDK.EMJSDKType",&local_begin_event) ||
        !resolve_enum_literal("MJUnionSDK","EMJSDKType","Logout","MJUnionSDK.EMJSDKType",&local_logout_event)) return 0;
    local_sdk_enabled=1;
    log_line("SDK policy: local emulator adapter; client EditorStrategy absent; no official token generated");
    return 1;
}
static int local_sdk_instance(void *object) {
    return local_sdk_enabled && object && object_class(object)==local_classes[LOCAL_STRATEGY];
}
static void *local_sdk_new(size_t type,uint32_t *root) {
    void *object,*exception=NULL;
    *root=0; rt.class_init(local_classes[type]); object=rt.object_new(local_classes[type]);
    if (!object || !(*root=rt.gc_new(object,0))) {
        local_sdk_fail("Local SDK allocation/GC root failed"); return NULL;
    }
    rt.invoke(local_constructors[type],object,NULL,&exception); object=rt.gc_target(*root);
    if (exception || !object || object_class(object)!=local_classes[type]) {
        rt.gc_free(*root); *root=0;
        local_sdk_fail("Local SDK constructor failed or returned an unexpected object"); return NULL;
    }
    return object;
}
static int local_sdk_reference(void *object,const char *owner,const char *name,const char *type,void *value) {
    void *field=checked_field(object,owner,name,type); size_t offset,size;
    if (!field) return 0;
    offset=field_offset(field); size=rt.object_size(object);
    if (offset<2*sizeof(void *) || offset>size || sizeof(void *)>size-offset) return 0;
    write_barrier(object,(void **)((BYTE *)object+offset),value); return 1;
}
static void *local_sdk_handler(void *self) {
    void *field=checked_field(self,"MJSDKStrategy","m_Handler","MJUnionSDK.MJSDKHandler"),*handler=NULL;
    if (field) rt.field_value(self,field,&handler);
    if (!handler || object_class(handler)!=local_handler_class) {
        local_sdk_fail("Local SDK strategy has no valid initialized handler"); return NULL;
    }
    return handler;
}
static void local_sdk_register(void *self,int32_t event,void *callback) {
    if (callback) sdk_register(self,event,callback,1,sites[SITE_SdkRegister].method);
}
static void local_sdk_dispatch(void *self,int32_t event,void *data,const char *type) {
    int32_t code; void *field=checked_field(data,type,"code","System.Int32");
    if (!field) { local_sdk_fail("Local SDK callback code field mismatch"); return; }
    rt.field_value(data,field,&code);
    if (code!=LOCAL_SDK_SUCCESS) { local_sdk_fail("Local SDK constructor did not produce the expected local success code"); return; }
    trigger_replacement(local_sdk_handler(self),event,data,(void *)sites[SITE_SdkTrigger].method);
}
static void local_sdk_emit(void *self,int32_t event,size_t type) {
    uint32_t root; void *data=local_sdk_new(type,&root);
    local_sdk_dispatch(self,event,data,local_type_names[type]); rt.gc_free(root);
}
static void *local_sdk_factory(int32_t platform,BYTE enable_sdk,BYTE enable_virtual,void *method) {
    uint32_t root; void *object;
    if (enable_sdk || !local_sdk_enabled) return sdk_factory_original(platform,enable_sdk,enable_virtual,method);
    object=local_sdk_new(LOCAL_STRATEGY,&root);
    log_line("Created local SDK strategy for disabled-SDK client path"); rt.gc_free(root); return object;
}
static void *local_sdk_region(void *factory,int32_t platform,BYTE enable_sdk,BYTE enable_virtual,void *method) {
    uint32_t root; void *object;
    if (enable_sdk || !local_sdk_enabled) return sdk_region_original(factory,platform,enable_sdk,enable_virtual,method);
    object=local_sdk_new(LOCAL_STRATEGY,&root);
    log_line("Created local SDK strategy through region factory (inlined outer factory supported)");
    rt.gc_free(root); return object;
}
static void local_sdk_initialize(void *self,void *go,void *handler,void *method) {
    if (!local_sdk_instance(self)) { sdk_initialize_original(self,go,handler,method); return; }
    if (!handler || object_class(handler)!=local_handler_class ||
        !local_sdk_reference(self,"MJSDKStrategy","m_Handler","MJUnionSDK.MJSDKHandler",handler)) {
        local_sdk_fail("Local SDK Initialize handler/type/layout mismatch"); return;
    }
    /* Base OnInitialize is empty. Do not install the native platform bridge. */
    log_line("Initialized local SDK handler (native SDK bridge not used)");
}
static void local_sdk_init(void *self,void *callback,void *method) {
    if (!local_sdk_instance(self)) { sdk_init_original(self,callback,method); return; }
    local_sdk_register(self,local_init_event,callback);
    log_line("Dispatching local SDK Init through client handler"); local_sdk_emit(self,local_init_event,LOCAL_INIT_DATA);
}
static void local_sdk_login(void *self,void *param,void *callback,void *method) {
    uint32_t data_root,user_root; void *data,*user;
    if (!local_sdk_instance(self)) { sdk_login_original(self,param,callback,method); return; }
    local_sdk_emit(self,local_begin_event,LOCAL_DATA); local_sdk_register(self,login_event,callback);
    local_sdk_new(LOCAL_LOGIN_DATA,&data_root); user=local_sdk_new(LOCAL_USER,&user_root); data=rt.gc_target(data_root);
    if (!local_sdk_reference(data,"MJSDKLoginData","userInfo","MJUnionSDK.MJSDKUserInfo",user)) {
        rt.gc_free(user_root); rt.gc_free(data_root); local_sdk_fail("Local SDK login userInfo field mismatch"); return;
    }
    rt.gc_free(user_root);
    log_line("Dispatching local SDK Login; existing identity hook supplies selected open_id");
    local_sdk_dispatch(self,login_event,rt.gc_target(data_root),"MJSDKLoginData"); rt.gc_free(data_root);
}
static void local_sdk_logout(void *self,void *param,void *callback,void *method) {
    if (!local_sdk_instance(self)) { sdk_logout_original(self,param,callback,method); return; }
    local_sdk_register(self,local_logout_event,callback);
    log_line("Dispatching local SDK Logout through client handler"); local_sdk_emit(self,local_logout_event,LOCAL_DATA);
}
static void *local_sdk_get_data(void *self,int32_t type,void *args,void *method) {
    void *empty;
    if (!local_sdk_instance(self)) return sdk_get_original(self,type,args,method);
    if (InterlockedIncrement(&local_sdk_unknown_reads)<=16) log_line("Local SDK data query %d: empty/unavailable (no official SDK values)",type);
    empty=string_new((const uint16_t *)L"",0);
    if (!empty) local_sdk_fail("Local SDK empty string allocation failed");
    return empty;
}
static BYTE local_sdk_set_data(void *self,int32_t type,void *args,void *method) {
    if (!local_sdk_instance(self)) return sdk_set_original(self,type,args,method);
    if (InterlockedIncrement(&local_sdk_unknown_writes)<=16) log_line("Local SDK data operation %d: unsupported",type);
    return 0;
}
