/* Runtime metadata API and semantic method specifications; no build RVAs. */
typedef struct { const char *name; BYTE *address; BYTE expected[16]; const void *method; } Site;
enum { SITE_Start,SITE_LaunchOptionStart,SITE_InfoEnableSdk,SITE_AppEnableSdk,
    SITE_InfoLogUrl,SITE_AppLogUrl,SITE_InfoTLS,SITE_InfoKcp,SITE_NetKcp,SITE_NetSsl,
    SITE_CameraFade,SITE_NpcFade,SITE_RequestUrl,SITE_RequestUrlTT2,SITE_HttpGetJson,
    SITE_SdkTrigger,SITE_LuaStart,SITE_LuaDoString,SITE_LoadOriginal,SITE_LoadDhao,SITE_LoadMeta,SITE_SdkFactory,SITE_SdkInitialize,SITE_SdkInit,SITE_SdkLogin,SITE_SdkLogout,
    SITE_SdkRegister,SITE_SdkGetData,SITE_SdkSetData,SITE_SdkRegion,SITE_COUNT };
static Site sites[SITE_COUNT];
static BYTE site_installed[SITE_COUNT];
static int32_t hybrid_load_ok;
static int local_sdk_enabled;
typedef struct {
    void *(*domain_get)(void);
    const void **(*assemblies)(void *,size_t *);
    void *(*assembly_open)(void *,const char *);
    void *(*assembly_image)(const void *);
    const char *(*image_name)(void *);
    size_t (*image_class_count)(void *);
    void *(*image_class)(void *,size_t);
    void *(*find_class)(void *,const char *,const char *);
    const void *(*methods)(void *,void **);
    const char *(*method_name)(const void *);
    uint32_t (*param_count)(const void *);
    const void *(*param_type)(const void *,uint32_t);
    const void *(*return_type)(const void *);
    uint32_t (*method_flags)(const void *,uint32_t *);
    char *(*type_name)(const void *);
    void (*free_memory)(void *);
    void (*class_init)(void *);
    void (*static_value)(void *,void *);
    void (*field_value)(void *,void *,void *);
    const void *(*field_type)(void *);
    size_t (*object_size)(void *);
    void *(*object_new)(void *);
    void *(*invoke)(const void *,void *,void **,void **);
    uint32_t (*gc_new)(void *,BYTE);
    void *(*gc_target)(uint32_t);
    void (*gc_free)(uint32_t);
    int32_t (*string_length)(void *);
    const uint16_t *(*string_chars)(void *);
} RuntimeApi;
static RuntimeApi rt;
static size_t method_pointer_offset;
static int32_t login_event;
static HMODULE runtime_module;
static int readable_memory(const void *pointer,size_t size) {
    MEMORY_BASIC_INFORMATION info; uintptr_t start=(uintptr_t)pointer,end;
    if (!pointer || !VirtualQuery(pointer,&info,sizeof(info)) || info.State!=MEM_COMMIT ||
        (info.Protect&(PAGE_NOACCESS|PAGE_GUARD))) return 0;
    end=(uintptr_t)info.BaseAddress+info.RegionSize;
    return start<=end && size<=end-start;
}
static int executable_memory(const void *pointer,size_t size) {
    MEMORY_BASIC_INFORMATION info;
    if (!readable_memory(pointer,size) || !VirtualQuery(pointer,&info,sizeof(info))) return 0;
    return (!runtime_module || info.AllocationBase==runtime_module) &&
        ((info.Protect&0xff)==PAGE_EXECUTE || (info.Protect&0xff)==PAGE_EXECUTE_READ ||
        (info.Protect&0xff)==PAGE_EXECUTE_READWRITE || (info.Protect&0xff)==PAGE_EXECUTE_WRITECOPY);
}
static const char *required_exports[]={
    "il2cpp_init","il2cpp_get_corlib","il2cpp_domain_get","il2cpp_domain_get_assemblies","il2cpp_domain_assembly_open",
    "il2cpp_assembly_get_image","il2cpp_image_get_name","il2cpp_image_get_class_count","il2cpp_image_get_class","il2cpp_class_from_name",
    "il2cpp_class_get_methods","il2cpp_method_get_name","il2cpp_method_get_param_count",
    "il2cpp_method_get_param","il2cpp_method_get_return_type","il2cpp_method_get_flags",
    "il2cpp_type_get_name","il2cpp_free","il2cpp_runtime_class_init","il2cpp_field_static_get_value",
    "il2cpp_field_get_value","il2cpp_field_get_type","il2cpp_object_get_size",
    "il2cpp_string_length","il2cpp_string_chars","il2cpp_string_new_utf16",
    "il2cpp_gc_wbarrier_set_field","il2cpp_object_get_class","il2cpp_class_get_field_from_name",
    "il2cpp_field_get_offset","il2cpp_class_get_name","il2cpp_class_get_namespace"
};
static char manifest_assemblies[1024][260];
static size_t manifest_assembly_count;
static int manifest_assemblies_opened;
typedef struct {
    const char *name,*space,*klass,*method,*result;
    int is_static; size_t count; const char *parameters[8];
} MethodSpec;
static const MethodSpec method_specs[SITE_COUNT]={
    {"AzurShell.Start","Azur","AzurShell","Start","System.Void",0,0,{0}},
    {"AzurShell.LaunchOptionStart","Azur","AzurShell","LaunchOptionStart","System.Void",0,0,{0}},
    {"InfoManager.EnableSdk","Lens.Framework.Managers","InfoManager","get_EnableSdk","System.Boolean",1,0,{0}},
    {"AppConfigManager.IsEnableSDK","Lens.Framework.Managers","AppConfigManager","get_IsEnableSDK","System.Boolean",1,0,{0}},
    {"InfoManager.LogUrl","Lens.Framework.Managers","InfoManager","get_LogUrl","System.String",1,0,{0}},
    {"AppConfigManager.LogUrl","Lens.Framework.Managers","AppConfigManager","get_LogUrl","System.String",1,0,{0}},
    {"InfoManager.EnableTLS","Lens.Framework.Managers","InfoManager","get_EnableTLS","System.Boolean",1,0,{0}},
    {"InfoManager.EnableKcp","Lens.Framework.Managers","InfoManager","get_EnableKcp","System.Boolean",1,0,{0}},
    {"NetManager.EnableKcp","Azur.Gameplay.Core.Net","NetManager","get_EnableKcp","System.Boolean",1,0,{0}},
    {"NetManager.EnableSsl","Azur.Gameplay.Core.Net","NetManager","get_EnableSsl","System.Boolean",1,0,{0}},
    {"CameraColliderMain.FadeByDistanceToCamera","Gameplay.Utility.CinemachineExtensions","CameraColliderMain","FadeByDistanceToCamera","System.Void",0,4,
        {"Cinemachine.CinemachineVirtualCameraBase","Cinemachine.CinemachinePOV","UnityEngine.Vector3","UnityEngine.Vector3"}},
    {"CameraColliderMain.FadeNpcByDistanceToCamera","Gameplay.Utility.CinemachineExtensions","CameraColliderMain","FadeNpcByDistanceToCamera","System.Void",0,3,
        {"UnityEngine.Vector3","UnityEngine.Vector3","Cinemachine.CinemachinePOV"}},
    {"NetSupport.RequestUrlByTask","Azur.Gameplay.Core.Net","NetSupport","RequestUrlByTask","System.Void",1,8,
        {"System.String","System.String","System.Collections.Generic.KeyValuePair<System.String,System.String>[]","System.String",
         "System.Action<System.Boolean,System.String,System.String>","System.Int32","System.Int32","System.Collections.Generic.List<System.String>"}},
    {"NetSupport.RequestUrlByTaskTT2","Azur.Gameplay.Core.Net","NetSupport","RequestUrlByTaskTT2","System.Void",1,8,
        {"System.String","System.String","System.Collections.Generic.KeyValuePair<System.String,System.String>[]","System.String",
         "System.Action<System.Boolean,System.String,System.String>","System.Int32","System.Int32","System.Collections.Generic.List<System.String>"}},
    {"HttpManager.GetJson","Lens.Framework.Managers","HttpManager","GetJson","BestHTTP.HTTPRequest",1,3,
        {"System.String","System.Action<LitJson.JsonData>","System.Action<System.String>"}},
    {"MJSDKHandler.Trigger","MJUnionSDK","MJSDKHandler","Trigger","System.Void",0,2,{"MJUnionSDK.EMJSDKType","MJUnionSDK.MJSDKData"}},
    {"LuaManager.Start","Lens.Framework.Managers","LuaManager","Start","System.Void",0,2,{"System.String","System.Boolean"}},
    {"LuaManager.DoString","Lens.Framework.Managers","LuaManager","DoString","System.Object[]",1,1,{"System.String"}},
    {"HybridCLR.LoadOriginal","HybridCLR","RuntimeApi","LoadOriginalDifferentialHybridAssembly","HybridCLR.LoadImageErrorCode",1,1,{"System.String"}},
    {"HybridCLR.LoadDHAO","HybridCLR","RuntimeApi","LoadDifferentialHybridAssemblyWithDHAO","HybridCLR.LoadImageErrorCode",1,3,{"System.Byte[]","System.Byte[]","System.Byte[]"}},
    {"HybridCLR.LoadMetaVersion","HybridCLR","RuntimeApi","LoadDifferentialHybridAssemblyWithMetaVersion","HybridCLR.LoadImageErrorCode",1,4,{"System.Byte[]","System.Byte[]","System.Byte[]","System.Byte[]"}},
    {"SDKStrategyFactory.Create","MJUnionSDK","SDKStrategyFactory","Create","MJUnionSDK.ISDKStrategy",1,3,{"UnityEngine.RuntimePlatform","System.Boolean","System.Boolean"}},
    {"MJSDKStrategy.Initialize","MJUnionSDK","MJSDKStrategy","Initialize","System.Void",0,2,{"UnityEngine.GameObject","MJUnionSDK.MJSDKHandler"}},
    {"MJSDKStrategy.SDKInit","MJUnionSDK","MJSDKStrategy","SDKInit","System.Void",0,1,{"System.Action<MJUnionSDK.MJSDKData>"}},
    {"MJSDKStrategy.Login","MJUnionSDK","MJSDKStrategy","Login","System.Void",0,2,{"System.String","System.Action<MJUnionSDK.MJSDKData>"}},
    {"MJSDKStrategy.Logout","MJUnionSDK","MJSDKStrategy","Logout","System.Void",0,2,{"System.String","System.Action<MJUnionSDK.MJSDKData>"}},
    {"MJSDKStrategy.RegisterEvent","MJUnionSDK","MJSDKStrategy","RegisterEvent","System.Void",0,3,{"MJUnionSDK.EMJSDKType","System.Action<MJUnionSDK.MJSDKData>","System.Boolean"}},
    {"MJSDKStrategy.GetSDKData","MJUnionSDK","MJSDKStrategy","GetSDKData","System.String",0,2,{"MJUnionSDK.EMJSDKParamType","System.String"}},
    {"MJSDKStrategy.SetSDKData","MJUnionSDK","MJSDKStrategy","SetSDKData","System.Boolean",0,2,{"MJUnionSDK.EMJSDKParamType","System.String"}},
    {"ChinaSDKFactory.CreateStrategy","MJUnionSDK","ChinaSDKFactory","CreateStrategy","MJUnionSDK.ISDKStrategy",0,3,{"UnityEngine.RuntimePlatform","System.Boolean","System.Boolean"}}
};
