/* Included after the patch engine; all operations run synchronously on init's thread. */
typedef uintptr_t (*InitFn)(const char *);
static InitFn init_original;
static InitFn init_utf16_original;
static LONG patches_ready;
static void (*launch_option)(void *,const void *);
static void start_replacement(void *this_object,const void *old_method) {
    (void)old_method; launch_option(this_object,sites[SITE_LaunchOptionStart].method);
}
static void refresh_runtime_patches(const char *stage,int require_complete);
typedef int32_t (*LoadOriginalFn)(void *,void *);
typedef int32_t (*LoadDhaoFn)(void *,void *,void *,void *);
typedef int32_t (*LoadMetaFn)(void *,void *,void *,void *,void *);
static LoadOriginalFn load_original;
static LoadDhaoFn load_dhao;
static LoadMetaFn load_meta;
static int32_t load_original_callback(void *name,void *method) {
    int32_t result=load_original(name,method);
    if (result==hybrid_load_ok) refresh_runtime_patches("original differential assembly loaded",0);
    return result;
}
static int32_t load_dhao_callback(void *bytes,void *symbols,void *dhao,void *method) {
    int32_t result=load_dhao(bytes,symbols,dhao,method);
    if (result==hybrid_load_ok) refresh_runtime_patches("DHAO differential assembly loaded",0);
    return result;
}
static int32_t load_meta_callback(void *bytes,void *symbols,void *original_meta,void *current_meta,void *method) {
    int32_t result=load_meta(bytes,symbols,original_meta,current_meta,method);
    if (result==hybrid_load_ok) refresh_runtime_patches("meta-version differential assembly loaded",0);
    return result;
}
static int bind_export(HMODULE module,const char *name,void *output,size_t size) {
    FARPROC proc=GetProcAddress(module,name);
    if (!proc || size!=sizeof(proc)) { log_line("Missing runtime API: %s",name); return 0; }
    memcpy(output,&proc,size); return 1;
}
#define BIND(member,export_name) if (!bind_export(module,export_name,&rt.member,sizeof(rt.member))) return 0
static int bind_runtime_api(HMODULE module) {
    BIND(domain_get,"il2cpp_domain_get"); BIND(assemblies,"il2cpp_domain_get_assemblies");
    BIND(assembly_open,"il2cpp_domain_assembly_open");
    BIND(assembly_image,"il2cpp_assembly_get_image"); BIND(image_name,"il2cpp_image_get_name");
    BIND(image_class_count,"il2cpp_image_get_class_count"); BIND(image_class,"il2cpp_image_get_class");
    BIND(find_class,"il2cpp_class_from_name"); BIND(methods,"il2cpp_class_get_methods");
    BIND(method_name,"il2cpp_method_get_name"); BIND(param_count,"il2cpp_method_get_param_count");
    BIND(param_type,"il2cpp_method_get_param"); BIND(return_type,"il2cpp_method_get_return_type");
    BIND(method_flags,"il2cpp_method_get_flags"); BIND(type_name,"il2cpp_type_get_name");
    BIND(free_memory,"il2cpp_free"); BIND(class_init,"il2cpp_runtime_class_init");
    BIND(static_value,"il2cpp_field_static_get_value"); BIND(field_value,"il2cpp_field_get_value");
    BIND(field_type,"il2cpp_field_get_type"); BIND(object_size,"il2cpp_object_get_size");
    BIND(string_length,"il2cpp_string_length"); BIND(string_chars,"il2cpp_string_chars");
    return 1;
}
#undef BIND
static void *find_loaded_class(const char *space,const char *name) {
    void *domain=rt.domain_get(),*found=NULL; const void **assemblies,**snapshot; size_t count=0,i;
    if (!domain) return NULL;
    assemblies=rt.assemblies(domain,&count);
    if (!assemblies || !count || count>4096) return NULL;
    snapshot=malloc(count*sizeof(*snapshot));
    if (!snapshot) return NULL;
    memcpy(snapshot,assemblies,count*sizeof(*snapshot));
    for (i=0;i<count;++i) {
        void *image=rt.assembly_image(snapshot[i]),*klass=rt.find_class(image,space,name);
        if (!klass) continue;
        if (found && found!=klass) { log_line("Ambiguous class: %s.%s",space,name); free(snapshot); return NULL; }
        found=klass;
    }
    free(snapshot);
    return found;
}
static void *find_enumerated_class(const char *space,const char *name) {
    void *domain=rt.domain_get(),*found=NULL;
    const void **assemblies,**snapshot; size_t count=0,i,total=0;
    if (!domain || !rt.image_class_count || !rt.image_class) return NULL;
    assemblies=rt.assemblies(domain,&count);
    if (!assemblies || !count || count>4096) return NULL;
    snapshot=malloc(count*sizeof(*snapshot)); if (!snapshot) return NULL;
    memcpy(snapshot,assemblies,count*sizeof(*snapshot));
    for (i=0;i<count;++i) {
        void *image=rt.assembly_image(snapshot[i]); size_t classes,j;
        if (!image) continue;
        classes=rt.image_class_count(image);
        if (classes>1000000 || total>1000000-classes) {
            log_line("Invalid/excessive runtime image class count"); free(snapshot); return NULL;
        }
        total+=classes;
        for (j=0;j<classes;++j) {
            void *klass=rt.image_class(image,j); const char *actual_name,*actual_space;
            if (!klass) continue;
            actual_name=class_name(klass); actual_space=class_namespace(klass);
            if (!actual_name || !actual_space || strcmp(actual_name,name)) continue;
            if (strcmp(actual_space,space)) {
                log_line("Same-name class in different namespace: %s.%s in %s",actual_space,actual_name,rt.image_name(image));
                continue;
            }
            if (found && found!=klass) {
                log_line("Ambiguous enumerated class: %s.%s",space,name); free(snapshot); return NULL;
            }
            found=klass;
            log_line("Enumerated exact class: %s.%s in %s",space,name,rt.image_name(image));
        }
    }
    free(snapshot);
    if (!found) log_line("No exact class after enumerating %llu types across %llu loaded images: %s.%s",
        (unsigned long long)total,(unsigned long long)count,space,name);
    return found;
}
static void *find_runtime_class(const char *space,const char *name) {
    void *found=find_loaded_class(space,name); size_t i;
    if (found) return found;
    if (!manifest_assemblies_opened && manifest_assembly_count && rt.assembly_open) {
        void *domain=rt.domain_get(); manifest_assemblies_opened=1;
        log_line("Class not yet loaded: %s.%s; opening client's registered scripting assemblies",space,name);
        for (i=0;i<manifest_assembly_count;++i) {
            void *assembly=rt.assembly_open(domain,manifest_assemblies[i]);
            if (assembly) log_line("Opened scripting image: %s",manifest_assemblies[i]);
        }
        /* Re-fetch the domain's array: assembly_open may reallocate it. */
        found=find_loaded_class(space,name);
    }
    if (!found) found=find_enumerated_class(space,name);
    if (!found) log_line("Class missing after assembly lookup: %s.%s",space,name);
    return found;
}
static void normalize_type(const char *input,char *output,size_t size) {
    size_t n=0;
    while (*input && n+1<size) {
        if (*input=='`') { ++input; while (*input>='0' && *input<='9') ++input; continue; }
        if (*input!=' ' && *input!='\t') output[n++]=*input;
        ++input;
    }
    output[n]=0;
}
static int type_matches(const void *type,const char *expected) {
    char *name=rt.type_name(type),actual[512],wanted[512]; int match;
    if (!name) return 0;
    if (strlen(name)>=sizeof(actual)-1 || strlen(expected)>=sizeof(wanted)-1) { rt.free_memory(name); return 0; }
    normalize_type(name,actual,sizeof(actual)); normalize_type(expected,wanted,sizeof(wanted));
    match=!strcmp(actual,wanted); rt.free_memory(name); return match;
}
static int method_matches(const void *method,const MethodSpec *spec) {
    uint32_t implementation,flags=rt.method_flags(method,&implementation); size_t i;
    if (strcmp(rt.method_name(method),spec->method) || rt.param_count(method)!=spec->count ||
        !!(flags&0x10)!=spec->is_static || (flags&0x400) || !type_matches(rt.return_type(method),spec->result)) return 0;
    for (i=0;i<spec->count;++i) if (!type_matches(rt.param_type(method,(uint32_t)i),spec->parameters[i])) return 0;
    return 1;
}
static int calibrate_method_pointer(void *method,void *code,size_t *offset) {
    size_t i;
    if (!executable_memory(code,1) || !readable_memory(method,64)) return 0;
    /* Compare a real delegate's method_ptr with its native MethodInfo.
     * First match selects methodPointer rather than the later virtual pointer. */
    for (i=0;i<64;i+=sizeof(void *)) {
        void *candidate; memcpy(&candidate,(BYTE *)method+i,sizeof(candidate));
        if (candidate==code) { *offset=i; return 1; }
    }
    return 0;
}
static int discover_method_layout(void) {
    void *klass=find_runtime_class("System.Reflection","Module"),*field,*delegate=NULL,*method=NULL,*code=NULL,*delegate_class;
    if (!klass) return 0;
    rt.class_init(klass);
    field=class_field(klass,"FilterTypeName"); if (!field) return 0;
    rt.static_value(field,&delegate); if (!delegate) return 0;
    delegate_class=object_class(delegate);
    field=class_field(delegate_class,"method_ptr"); if (!field) return 0;
    rt.field_value(delegate,field,&code);
    field=class_field(delegate_class,"method"); if (!field) return 0;
    rt.field_value(delegate,field,&method);
    if (!calibrate_method_pointer(method,code,&method_pointer_offset)) return 0;
    log_line("MethodInfo native pointer offset calibrated: %llu",(unsigned long long)method_pointer_offset);
    return 1;
}
static int binding_only_site(size_t i) {
    return i==SITE_LaunchOptionStart || i==SITE_LuaDoString || i==SITE_SdkRegister ||
        (i>=SITE_UriCtor && i<=SITE_HttpSetUri && i!=SITE_BestSend);
}
static int resolve_site(size_t index) {
    const MethodSpec *spec=method_specs+index;
    void *klass=find_runtime_class(spec->space,spec->klass),*iterator=NULL; const void *method,*found=NULL; BYTE *address; size_t i;
    if (!klass) return 0;
    while ((method=rt.methods(klass,&iterator))!=NULL) {
        if (!method_matches(method,spec)) continue;
        if (found) { log_line("Ambiguous method signature: %s",spec->name); return -1; }
        found=method;
    }
    if (!found || !readable_memory((const BYTE *)found+method_pointer_offset,sizeof(address))) {
        log_line("Method/signature missing: %s",spec->name); return -1;
    }
    memcpy(&address,(const BYTE *)found+method_pointer_offset,sizeof(address));
    if (!executable_memory(address,16) || *address==0xc3 || *address==0xc2) {
        log_line("Unsupported interpreter/shared/short method: %s",spec->name); return -1;
    }
    for (i=0;i<SITE_COUNT;++i) if (i!=index && sites[i].address==address && (!binding_only_site(i) || !binding_only_site(index))) { log_line("Shared patch entry rejected: %s",spec->name); return -1; }
    sites[index].name=spec->name; sites[index].address=address; sites[index].method=found;
    memcpy(sites[index].expected,address,16);
    log_line("Resolved %s -> %p",spec->name,(void *)address);
    return 1;
}
static int site_enabled(size_t i) {
    if (!redirect_api && (i==SITE_RequestUrl || i==SITE_RequestUrlTT2 || i==SITE_HttpGetJson ||
        (i>=SITE_UriCtor && i<=SITE_UnityUrl))) return 0;
    if (!local_account && (i==SITE_InfoEnableSdk || i==SITE_AppEnableSdk || i==SITE_SdkTrigger ||
        (i>=SITE_SdkFactory && i<=SITE_SdkRegion))) return 0;
    if (!redirect_appdata && i==SITE_PersistentPath) return 0;
    if ((i==SITE_PersistentPath || i==SITE_RestartFullPath) && !restart_routing_enabled) return 0;
    if (i>=SITE_SdkFactory && i<=SITE_SdkRegion && !local_sdk_enabled) return 0;
    if (!tcp_only && (i==SITE_InfoTLS || i==SITE_InfoKcp || i==SITE_NetKcp || i==SITE_NetSsl)) return 0;
    if (!camera_fade && (i==SITE_CameraFade || i==SITE_NpcFade)) return 0;
    return 1;
}
static int bootstrap_required(size_t i) {
    return i==SITE_Start || i==SITE_LaunchOptionStart || i==SITE_InfoEnableSdk ||
        i==SITE_AppEnableSdk || i==SITE_InfoLogUrl || i==SITE_AppLogUrl ||
        i==SITE_InfoTLS || i==SITE_InfoKcp || i==SITE_SdkTrigger || i>=SITE_LoadOriginal;
}
static size_t pending_site_count(void) {
    size_t i,count=0;
    for (i=0;i<SITE_COUNT;++i) if (site_enabled(i) && !site_installed[i]) ++count;
    return count;
}
static int resolve_available_sites(int bootstrap) {
    size_t i;
    for (i=0;i<SITE_COUNT;++i) {
        int result;
        if (!site_enabled(i) || sites[i].address) continue;
        result=resolve_site(i);
        if (result<0) return 0; /* A present class with an incompatible method is never deferred. */
        if (!result) {
            if (bootstrap && bootstrap_required(i)) return 0;
            log_line("Deferred until differential assembly load: %s",method_specs[i].name);
        }
    }
    if (sites[SITE_LaunchOptionStart].address)
        memcpy(&launch_option,&sites[SITE_LaunchOptionStart].address,sizeof(launch_option));
    return 1;
}
static int resolve_enum_literal(const char *space,const char *name,const char *literal,const char *type,int32_t *value) {
    void *klass=find_runtime_class(space,name),*field=klass?class_field(klass,literal):NULL;
    if (!field || !type_matches(rt.field_type(field),type)) return 0;
    rt.static_value(field,value); return 1;
}
#include "local_sdk.h"
#include "transport_routing.h"
static int resolve_runtime_contracts(void) {
    if (!discover_method_layout() ||
        !resolve_enum_literal("MJUnionSDK","EMJSDKType","Login","MJUnionSDK.EMJSDKType",&login_event) ||
        !resolve_enum_literal("HybridCLR","LoadImageErrorCode","OK","HybridCLR.LoadImageErrorCode",&hybrid_load_ok)) return 0;
    if (!setup_local_sdk() || !setup_transport_routing()) return 0;
    restart_routing_enabled=find_runtime_class("Azur.VersionCheck","WindowsGameRestart")!=NULL;
    log_line("Runtime enums resolved: Login=%d HybridCLR.OK=%d",login_event,hybrid_load_ok);
    return 1;
}
