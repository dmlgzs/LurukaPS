/* Change only Unity's game preferences key; native handles retain all normal
 * query/set/delete/enumeration behavior and existing Sandboxie interception. */
typedef LSTATUS (WINAPI *RegistryCreateFn)(HKEY,LPCWSTR,PHKEY);
typedef LSTATUS (WINAPI *RegistryOpenFn)(HKEY,LPCWSTR,DWORD,REGSAM,PHKEY);
typedef LSTATUS (WINAPI *RegistryCreateExFn)(HKEY,LPCWSTR,DWORD,LPWSTR,DWORD,REGSAM,LPSECURITY_ATTRIBUTES,PHKEY,LPDWORD);
static RegistryCreateFn unity_registry_create_original;
static RegistryOpenFn unity_registry_open_original;
static RegistryCreateExFn unity_registry_create_ex_original;
static const wchar_t *unity_registry_source=L"Software\\manjuu\\AzurPromilia";
static const wchar_t *unity_registry_target=L"Software\\LurukaPS\\AzurPromilia";
static LPCWSTR unity_registry_path(HKEY root,LPCWSTR path,wchar_t **allocated) {
    size_t prefix,length,bytes;
    *allocated=NULL;
    if (root!=HKEY_CURRENT_USER || !path) return path;
    prefix=wcslen(unity_registry_source); length=wcslen(path);
    if (length<prefix || _wcsnicmp(path,unity_registry_source,prefix) || (path[prefix] && path[prefix]!=L'\\')) return path;
    if (length==prefix) return unity_registry_target; /* Common path: no allocation. */
    bytes=(wcslen(unity_registry_target)+length-prefix+1)*sizeof(wchar_t);
    *allocated=HeapAlloc(GetProcessHeap(),0,bytes);
    if (*allocated) { wcscpy(*allocated,unity_registry_target); wcscat(*allocated,path+prefix); }
    return *allocated;
}
static LSTATUS WINAPI unity_registry_create(HKEY root,LPCWSTR path,PHKEY key) {
    wchar_t *allocated; LPCWSTR mapped=unity_registry_path(root,path,&allocated); LSTATUS result;
    if (path && !mapped) return ERROR_NOT_ENOUGH_MEMORY;
    result=unity_registry_create_original(root,mapped,key);
    if (allocated) HeapFree(GetProcessHeap(),0,allocated);
    return result;
}
static LSTATUS WINAPI unity_registry_open(HKEY root,LPCWSTR path,DWORD options,REGSAM access,PHKEY key) {
    wchar_t *allocated; LPCWSTR mapped=unity_registry_path(root,path,&allocated); LSTATUS result;
    if (path && !mapped) return ERROR_NOT_ENOUGH_MEMORY;
    result=unity_registry_open_original(root,mapped,options,access,key);
    if (allocated) HeapFree(GetProcessHeap(),0,allocated);
    return result;
}
static LSTATUS WINAPI unity_registry_create_ex(HKEY root,LPCWSTR path,DWORD reserved,LPWSTR klass,DWORD options,
    REGSAM access,LPSECURITY_ATTRIBUTES security,PHKEY key,LPDWORD disposition) {
    wchar_t *allocated; LPCWSTR mapped=unity_registry_path(root,path,&allocated); LSTATUS result;
    if (path && !mapped) return ERROR_NOT_ENOUGH_MEMORY;
    result=unity_registry_create_ex_original(root,mapped,reserved,klass,options,access,security,key,disposition);
    if (allocated) HeapFree(GetProcessHeap(),0,allocated);
    return result;
}
static ImportHook unity_registry_imports[]={
    {"RegCreateKeyW",(void *)unity_registry_create,&unity_registry_create_original,NULL,NULL},
    {"RegOpenKeyExW",(void *)unity_registry_open,&unity_registry_open_original,NULL,NULL},
    {"RegCreateKeyExW",(void *)unity_registry_create_ex,&unity_registry_create_ex_original,NULL,NULL}
};
static int install_unity_registry(HMODULE unity) {
    size_t count=sizeof(unity_registry_imports)/sizeof(unity_registry_imports[0]);
    if (!bind_import_hooks(unity,"advapi32.dll",unity_registry_imports,count) || !update_import_hooks(unity_registry_imports,count,1)) return 0;
    log_line("Unity registry redirected: HKCU/Software/LurukaPS/AzurPromilia (existing hooks preserved)");
    return 1;
}
