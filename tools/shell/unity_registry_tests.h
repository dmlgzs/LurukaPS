/* Isolated temporary registry subtree; never modify the real game keys. */
static __attribute__((noinline)) LSTATUS registry_test_create_ex(LPCWSTR path,PHKEY key) {
    /* Enter after installation, as Unity does, so the import is loaded anew. */
    return RegCreateKeyExW(HKEY_CURRENT_USER,path,0,NULL,0,KEY_ALL_ACCESS,NULL,key,NULL);
}
static int registry_test_value(HKEY key,DWORD expected) {
    DWORD value=0,type=0,bytes=sizeof(value);
    return RegQueryValueExW(key,L"fixture",NULL,&type,(BYTE *)&value,&bytes)==ERROR_SUCCESS &&
        type==REG_DWORD && bytes==sizeof(value) && value==expected;
}
static int unity_registry_test(void) {
    wchar_t root[160],source[220],target[220],child[240]; wchar_t *allocated;
    const wchar_t *original_source=unity_registry_source,*original_target=unity_registry_target,*mapped;
    const char *stage="fixture setup";
    HKEY base=NULL,key=NULL; DWORD disposition,value; LSTATUS status; int ok=0,created=0,installed=0;
    swprintf(root,160,L"Software\\LurukaPS.ShellTest_%lu_%llu",(unsigned long)GetCurrentProcessId(),(unsigned long long)GetTickCount64());
    status=RegCreateKeyExW(HKEY_CURRENT_USER,root,0,NULL,0,KEY_ALL_ACCESS,NULL,&base,&disposition);
    if (status!=ERROR_SUCCESS || disposition!=REG_CREATED_NEW_KEY) {
        log_line("Registry test fixture creation failed: status=%ld",(long)status); goto done;
    }
    created=1;
    swprintf(source,220,L"%ls\\manjuu\\AzurPromilia",root);
    swprintf(target,220,L"%ls\\LurukaPS\\AzurPromilia",root);
    if (RegCreateKeyExW(HKEY_CURRENT_USER,source,0,NULL,0,KEY_ALL_ACCESS,NULL,&key,NULL)!=ERROR_SUCCESS) goto done;
    value=101;
    if (RegSetValueExW(key,L"fixture",0,REG_DWORD,(BYTE *)&value,sizeof(value))!=ERROR_SUCCESS) goto done;
    RegCloseKey(key); key=NULL;
    if (RegCreateKeyExW(HKEY_CURRENT_USER,target,0,NULL,0,KEY_ALL_ACCESS,NULL,&key,NULL)!=ERROR_SUCCESS) goto done;
    value=202;
    if (RegSetValueExW(key,L"fixture",0,REG_DWORD,(BYTE *)&value,sizeof(value))!=ERROR_SUCCESS) goto done;
    RegCloseKey(key); key=NULL;
    unity_registry_source=source; unity_registry_target=target;
    stage="path exclusions";
    mapped=unity_registry_path(HKEY_LOCAL_MACHINE,source,&allocated);
    if (mapped!=source || allocated) goto done;
    swprintf(child,240,L"%lsOther",source);
    if (unity_registry_path(HKEY_CURRENT_USER,child,&allocated)!=child || allocated) goto done;
    stage="import installation";
    if (!install_unity_registry(GetModuleHandleW(NULL))) goto done;
    installed=1;
    stage="RegCreateKeyW mapped read";
    if (RegCreateKeyW(HKEY_CURRENT_USER,source,&key)!=ERROR_SUCCESS || !registry_test_value(key,202)) goto done;
    value=303;
    if (RegSetValueExW(key,L"fixture",0,REG_DWORD,(BYTE *)&value,sizeof(value))!=ERROR_SUCCESS) goto done;
    RegCloseKey(key); key=NULL;
    stage="RegOpenKeyExW mapped read";
    if (RegOpenKeyExW(HKEY_CURRENT_USER,source,0,KEY_ALL_ACCESS,&key)!=ERROR_SUCCESS || !registry_test_value(key,303)) goto done;
    stage="delete and enumerate";
    if (RegDeleteValueW(key,L"fixture")!=ERROR_SUCCESS) goto done;
    {
        wchar_t name[32]; DWORD count=32;
        if (RegEnumValueW(key,0,name,&count,NULL,NULL,NULL,NULL)!=ERROR_NO_MORE_ITEMS) goto done;
    }
    RegCloseKey(key); key=NULL;
    stage="RegCreateKeyExW subkey";
    swprintf(child,240,L"%ls\\Child",source);
    if (registry_test_create_ex(child,&key)!=ERROR_SUCCESS) goto done;
    value=404;
    if (RegSetValueExW(key,L"fixture",0,REG_DWORD,(BYTE *)&value,sizeof(value))!=ERROR_SUCCESS) goto done;
    RegCloseKey(key); key=NULL;
    if (!update_import_hooks(unity_registry_imports,sizeof(unity_registry_imports)/sizeof(unity_registry_imports[0]),0)) ExitProcess(1);
    installed=0;
    stage="original key unchanged";
    /* Use the saved callee: the compiler may cache a dllimport function pointer
     * across the test's live install/uninstall within this same function. */
    if (unity_registry_open_original(HKEY_CURRENT_USER,source,0,KEY_READ,&key)!=ERROR_SUCCESS || !registry_test_value(key,101)) goto done;
    RegCloseKey(key); key=NULL;
    stage="redirected subkey exists";
    swprintf(child,240,L"%ls\\Child",target);
    if (unity_registry_open_original(HKEY_CURRENT_USER,child,0,KEY_READ,&key)!=ERROR_SUCCESS || !registry_test_value(key,404)) goto done;
    ok=1;
done:
    if (!ok) log_line("Registry test failed at: %s",stage);
    if (key) RegCloseKey(key);
    if (installed && !update_import_hooks(unity_registry_imports,sizeof(unity_registry_imports)/sizeof(unity_registry_imports[0]),0)) ExitProcess(1);
    unity_registry_source=original_source; unity_registry_target=original_target;
    if (base) RegCloseKey(base);
    if (created && RegDeleteTreeW(HKEY_CURRENT_USER,root)!=ERROR_SUCCESS) ok=0;
    log_line("Unity registry: three IAT hooks, read/write/delete/enumeration, subkeys and original-key isolation: %s",ok?"PASS":"FAIL");
    return ok;
}
