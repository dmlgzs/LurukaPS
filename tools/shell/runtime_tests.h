/* Synthetic metadata changes addresses/layouts without using CBT3 RVAs. */
typedef struct { void *native_slots[4]; const char *name,*result; uint32_t count,flags; const char *parameters[8]; } FakeMethod;
static FakeMethod fake_methods[2];
static int fake_method_count,fake_image_count;
static int fake_class_hidden,fake_open_calls;
static void *fake_domain(void) { return (void *)1; }
static const void **fake_assemblies(void *domain,size_t *count) {
    static const void *images[]={(void *)1,(void *)2}; (void)domain; *count=(size_t)fake_image_count; return images;
}
static void *fake_image(const void *assembly) { return (void *)assembly; }
static void *fake_find_class(void *image,const char *space,const char *name) {
    return !fake_class_hidden && !strcmp(space,"Azur") && !strcmp(name,"AzurShell")?image:NULL;
}
static void *fake_open_assembly(void *domain,const char *name) {
    (void)domain; ++fake_open_calls;
    if (strcmp(name,"Deferred.dll")) return NULL;
    fake_class_hidden=0; fake_image_count=1; return (void *)1;
}
static const void *fake_get_methods(void *klass,void **iterator) {
    size_t index=(size_t)*iterator; (void)klass;
    if (index>=(size_t)fake_method_count) return NULL;
    *iterator=(void *)(index+1); return fake_methods+index;
}
static const char *fake_method_name(const void *method) { return ((const FakeMethod *)method)->name; }
static const void *fake_param(const void *method,uint32_t index) { return ((const FakeMethod *)method)->parameters[index]; }
static uint32_t fake_count(const void *method) { return ((const FakeMethod *)method)->count; }
static const void *fake_return(const void *method) { return ((const FakeMethod *)method)->result; }
static uint32_t fake_flags(const void *method,uint32_t *implementation) { *implementation=0; return ((const FakeMethod *)method)->flags; }
static size_t fake_class_count(void *image) { (void)image; return 1; }
static void *fake_image_class(void *image,size_t index) { return index?NULL:image; }
static const char *fake_class_name(void *klass) { (void)klass; return "AzurShell"; }
static int fake_wrong_namespace;
static const char *fake_class_namespace(void *klass) { (void)klass; return fake_wrong_namespace?"Wrong.Space":"Azur"; }
static const char *fake_image_name(void *image) { return image==(void *)1?"One.dll":"Two.dll"; }
static int runtime_resolution_test(BYTE *code) {
    size_t offset; BYTE changed[64]={0}; void *target=code; int ok;
    rt.domain_get=fake_domain; rt.assemblies=fake_assemblies; rt.assembly_image=fake_image;
    rt.find_class=fake_find_class; rt.methods=fake_get_methods; rt.method_name=fake_method_name;
    rt.param_count=fake_count; rt.param_type=fake_param; rt.return_type=fake_return; rt.method_flags=fake_flags;
    rt.type_name=test_type_name; rt.free_memory=free;
    memset(fake_methods,0,sizeof(fake_methods)); fake_image_count=1; fake_method_count=1;
    fake_methods[0].name="Start"; fake_methods[0].result="System.Void";
    fake_methods[0].native_slots[0]=code;
    ok=calibrate_method_pointer(fake_methods,code,&offset) && offset==0;
    method_pointer_offset=offset;
    ok=ok && resolve_site(SITE_Start) && sites[SITE_Start].address==code;
    /* Version B: pointer slot moves by 16, code address also moves. */
    fake_methods[0].native_slots[0]=NULL; fake_methods[0].native_slots[2]=code+32;
    ok=ok && calibrate_method_pointer(fake_methods,code+32,&offset) && offset==16;
    method_pointer_offset=offset;
    ok=ok && resolve_site(SITE_Start) && sites[SITE_Start].address==code+32;
    fake_methods[0].result="System.Boolean";
    ok=ok && resolve_site(SITE_Start)==-1;
    fake_methods[0].result="System.Void"; fake_methods[1]=fake_methods[0]; fake_method_count=2;
    ok=ok && resolve_site(SITE_Start)==-1;
    fake_method_count=1; fake_image_count=2;
    ok=ok && !find_runtime_class("Azur","AzurShell");
    /* Initial domain lacks a game class; manifest-driven opening exposes it. */
    fake_class_hidden=1; fake_image_count=1; fake_open_calls=0;
    strcpy(manifest_assemblies[0],"Deferred.dll"); manifest_assembly_count=1; manifest_assemblies_opened=0;
    rt.assembly_open=fake_open_assembly;
    ok=ok && find_runtime_class("Azur","AzurShell")== (void *)1 && fake_open_calls==1;
    manifest_assembly_count=0; manifest_assemblies_opened=0;
    memcpy(changed+24,&target,sizeof(target));
    ok=ok && calibrate_method_pointer(changed,code,&offset) && offset==24;
    /* Generic arity/spacing normalization does not weaken by-ref/type checks. */
    ok=ok && type_matches("System.Action`2<System.Boolean, System.String>","System.Action<System.Boolean,System.String>") &&
        !type_matches("System.String&","System.String");
    {
        const MethodSpec *spec=method_specs+SITE_HttpGetJson;
        FakeMethod candidate={0}; size_t i;
        candidate.name=spec->method; candidate.result=spec->result;
        candidate.count=(uint32_t)spec->count; candidate.flags=0x10;
        for (i=0;i<spec->count;++i) candidate.parameters[i]=spec->parameters[i];
        ok=ok && method_matches(&candidate,spec);
        candidate.parameters[0]="System.String&";
        ok=ok && !method_matches(&candidate,spec);
        candidate.parameters[0]="System.String"; candidate.flags=0;
        ok=ok && !method_matches(&candidate,spec);
        candidate.flags=0x410;
        ok=ok && !method_matches(&candidate,spec);
    }
    /* A metadata type may exist even when the image's name index misses it. */
    rt.image_class_count=fake_class_count; rt.image_class=fake_image_class;
    rt.image_name=fake_image_name; class_name=fake_class_name; class_namespace=fake_class_namespace;
    fake_class_hidden=1; fake_image_count=1; fake_wrong_namespace=0;
    ok=ok && find_runtime_class("Azur","AzurShell")== (void *)1;
    fake_wrong_namespace=1;
    ok=ok && !find_runtime_class("Azur","AzurShell");
    fake_wrong_namespace=0; fake_image_count=2;
    ok=ok && !find_runtime_class("Azur","AzurShell");
    return ok;
}
static int staged_types_visible,staged_queries;
static int32_t staged_load_result;
static void *staged_load_arguments[5];
static void *staged_find_class(void *image,const char *space,const char *name) {
    (void)image; ++staged_queries;
    return staged_types_visible && !strcmp(space,"Azur.Gameplay.Core.Net") && !strcmp(name,"NetManager")?(void *)1:NULL;
}
static int32_t staged_load_meta(void *a,void *b,void *c,void *d,void *method) {
    staged_load_arguments[0]=a; staged_load_arguments[1]=b; staged_load_arguments[2]=c;
    staged_load_arguments[3]=d; staged_load_arguments[4]=method;
    if (staged_load_result==hybrid_load_ok) staged_types_visible=1;
    return staged_load_result;
}
static int staged_loading_test(BYTE *code) {
    const BYTE body[16]={0xb8,1,0,0,0,0xc3}; size_t i; int ok,queries;
    typedef int (*Getter)(void);
    Getter getter; void *saved_start;
    for (i=0;i<SITE_COUNT;++i) {
        sites[i].address=code+512+i*16; sites[i].name=method_specs[i].name; site_installed[i]=1;
    }
    sites[SITE_NetKcp].address=NULL; site_installed[SITE_NetKcp]=0;
    rt.find_class=staged_find_class; rt.image_class_count=NULL; rt.image_class=NULL;
    fake_image_count=1; staged_types_visible=0; staged_queries=0; manifest_assembly_count=0;
    ok=resolve_available_sites(0) && pending_site_count()==1;
    tcp_only=0; ok=ok && pending_site_count()==0; tcp_only=1;
    saved_start=sites[SITE_Start].address; sites[SITE_Start].address=NULL;
    ok=ok && !resolve_available_sites(1); sites[SITE_Start].address=saved_start;
    if (!write_code(code,body,sizeof(body))) return 0;
    memset(fake_methods,0,sizeof(fake_methods)); fake_method_count=1; method_pointer_offset=0;
    fake_methods[0].name="get_EnableKcp"; fake_methods[0].result="System.String"; fake_methods[0].flags=0x10;
    fake_methods[0].native_slots[0]=code; staged_types_visible=1;
    ok=ok && !resolve_available_sites(0); /* Present but wrong signature must fail, not defer. */
    staged_types_visible=0; fake_methods[0].result="System.Boolean";
    hybrid_load_ok=7; load_meta=staged_load_meta; staged_load_result=99; queries=staged_queries;
    ok=ok && load_meta_callback((void *)1,(void *)2,(void *)3,(void *)4,(void *)5)==99 && staged_queries==queries;
    staged_load_result=hybrid_load_ok;
    ok=ok && load_meta_callback((void *)1,(void *)2,(void *)3,(void *)4,(void *)5)==7 &&
        pending_site_count()==0 && site_installed[SITE_NetKcp];
    memcpy(&getter,&code,sizeof(getter)); ok=ok && getter()==0;
    for (i=0;i<5;++i) ok=ok && staged_load_arguments[i]==(void *)(i+1);
    queries=staged_queries;
    ok=ok && load_meta_callback((void *)1,(void *)2,(void *)3,(void *)4,(void *)5)==7 && staged_queries==queries && getter()==0;
    memset(sites,0,sizeof(sites)); memset(site_installed,0,sizeof(site_installed));
    log_line("Deferred HybridCLR types, incompatible signatures, synchronous installation and loader ABI/results: %s",ok?"PASS":"FAIL");
    return ok;
}
static int assembly_manifest_test(void) {
    int ok=parse_assembly_manifest("{\"names\":[\"AzurLoader.dll\",\"Assembly-CSharp.dll\"],\"types\":[16,16]}") &&
        manifest_assembly_count==2 && !strcmp(manifest_assemblies[1],"Assembly-CSharp.dll");
    ok=ok && !parse_assembly_manifest("{\"names\":[\"../other.dll\"]}") &&
        !parse_assembly_manifest("{\"names\":[\"trailing.dll\",]}") &&
        !parse_assembly_manifest("{\"names\":[\"unterminated") &&
        !parse_assembly_manifest("{\"names\":[\"wrong.exe\"]}");
    manifest_assembly_count=0; return ok;
}
static InitFn test_init_original;
static int test_init_calls;
static uintptr_t test_init_hook(const char *name) { ++test_init_calls; return test_init_original(name); }
static int bootstrap_trampoline_test(BYTE *code) {
    const BYTE body[]={0x40,0x53,0x48,0x83,0xec,0x20,0xb8,7,0,0,0,0x48,0x83,0xc4,0x20,0x5b,0xc3};
    Site site={"init prologue bootstrap",NULL,{0},NULL}; Patch patch; InitFn entry; int ok;
    if (!write_code(code,body,sizeof(body))) return 0;
    memcpy(site.expected,code,16);
    if (!prepare_hook_at(code,&site,(const void *)test_init_hook,5,&patch) || patch.length!=6) return 0;
    memcpy(&test_init_original,&hook_pages[5],sizeof(test_init_original));
    memcpy(&entry,&code,sizeof(entry));
    ok=apply_patches(&patch,1) && entry("test")==7 && test_init_calls==1;
    ok=ok && write_code(code,patch.before,patch.length) && entry("test")==7;
    VirtualFree(hook_pages[5],0,MEM_RELEASE); hook_pages[5]=NULL;
    return ok && !prologue_instruction((const BYTE *)"\x48\x8b\x05\x00\x00\x00\x00") &&
        !prologue_instruction((const BYTE *)"\xe8\x00\x00\x00\x00") &&
        !prologue_instruction((const BYTE *)"\xe9\x00\x00\x00\x00");
}
