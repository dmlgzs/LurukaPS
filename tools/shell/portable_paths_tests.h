/* Temporary fixtures only. Never point the native-hook test at real AppData. */
static int portable_test_write(const wchar_t *path,const char *value) {
    HANDLE file=CreateFileW(path,GENERIC_WRITE,FILE_SHARE_READ,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
    DWORD written=0; int ok;
    if (file==INVALID_HANDLE_VALUE) return 0;
    ok=WriteFile(file,value,(DWORD)strlen(value),&written,NULL) && written==strlen(value);
    CloseHandle(file); return ok;
}
static int portable_test_read(const wchar_t *path,const char *value) {
    HANDLE file=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    char text[64]={0}; DWORD read=0; int ok;
    if (file==INVALID_HANDLE_VALUE) return 0;
    ok=ReadFile(file,text,sizeof(text)-1,&read,NULL) && !strcmp(text,value);
    CloseHandle(file); return ok;
}
static int portable_paths_test(void) {
    wchar_t temp[MAX_PATH],root[MAX_PATH],source[MAX_PATH]={0},target[MAX_PATH]={0},path[MAX_PATH],other[MAX_PATH];
    wchar_t *mapped=NULL;
    HANDLE original_root=INVALID_HANDLE_VALUE,file=INVALID_HANDLE_VALUE; WIN32_FIND_DATAW find;
    IO_STATUS_BLOCK io; UNICODE_STRING name; OBJECT_ATTRIBUTES attributes;
    int ok=0,installed=0; DWORD n; NTSTATUS status;
    n=GetTempPathW(MAX_PATH,temp);
    if (!n || n>=MAX_PATH || !GetTempFileNameW(temp,L"lps",0,root)) goto done;
    if (!DeleteFileW(root) || !CreateDirectoryW(root,NULL)) goto done;
    {
        wchar_t previous[PORTABLE_CAPACITY],host[PORTABLE_CAPACITY],after[PORTABLE_CAPACITY]; int stable;
        n=GetCurrentDirectoryW(PORTABLE_CAPACITY,previous);
        if (!n || n>=PORTABLE_CAPACITY || !executable_directory(host,PORTABLE_CAPACITY) || !SetCurrentDirectoryW(root)) goto cleanup;
        stable=executable_directory(after,PORTABLE_CAPACITY) && !wcscmp(host,after);
        if (!SetCurrentDirectoryW(previous) || !stable) goto cleanup;
    }
    if (!join_path(source,MAX_PATH,root,L"AppData") || !portable_directory(source) ||
        !join_path(target,MAX_PATH,root,L"LuruksPSData") || !portable_directory(target) ||
        !configure_portable_paths(source,target)) goto cleanup;
    join_path(path,MAX_PATH,source,L"Local"); if (!portable_directory(path)) goto cleanup;
    original_root=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,NULL);
    if (original_root==INVALID_HANDLE_VALUE) goto cleanup;
    join_path(path,MAX_PATH,target,L"Local"); if (!portable_directory(path)) goto cleanup;
    join_path(path,MAX_PATH,source,L"Local\\sentinel.dat"); if (!portable_test_write(path,"original")) goto cleanup;
    join_path(other,MAX_PATH,target,L"Local\\sentinel.dat"); if (!portable_test_write(other,"portable")) goto cleanup;
    /* Exact boundary, native prefix, dot normalization and relative roots. */
    swprintf(path,MAX_PATH,L"\\??\\%ls\\Local\\sentinel.dat",source);
    if (portable_name(path,wcslen(path),NULL,&mapped)!=1 || wcsncmp(mapped,L"\\??\\",4) || wcscmp(mapped+4,other)) goto cleanup;
    HeapFree(GetProcessHeap(),0,mapped); mapped=NULL;
    swprintf(path,MAX_PATH,L"%lsOther\\test",source);
    if (portable_name(path,wcslen(path),NULL,&mapped)!=0) goto cleanup;
    swprintf(path,MAX_PATH,L"%ls\\..\\outside.txt",source);
    if (portable_name(path,wcslen(path),NULL,&mapped)!=0) goto cleanup;
    if (!portable_bind_imports() || !portable_update_imports(1)) goto cleanup;
    installed=1; portable_active=1;
    join_path(path,MAX_PATH,source,L"Local\\sentinel.dat");
    if (!portable_test_read(path,"portable") || !portable_test_write(path,"changed") || !portable_test_read(other,"changed")) goto cleanup;
    if (GetFileAttributesW(path)==INVALID_FILE_ATTRIBUTES) goto cleanup;
    join_path(path,MAX_PATH,source,L"Local\\*");
    file=FindFirstFileW(path,&find); if (file==INVALID_HANDLE_VALUE) goto cleanup;
    FindClose(file); file=INVALID_HANDLE_VALUE;
    /* A pre-existing original directory handle must not bypass the mapping. */
    name.Buffer=L"sentinel.dat"; name.Length=24; name.MaximumLength=26;
    memset(&attributes,0,sizeof(attributes)); attributes.Length=sizeof(attributes);
    attributes.RootDirectory=original_root; attributes.ObjectName=&name; attributes.Attributes=OBJ_CASE_INSENSITIVE;
    {
        PortableOpenFn open_file=portable_open;
        char text[32]={0}; DWORD read;
        status=open_file(&file,GENERIC_READ|SYNCHRONIZE,&attributes,&io,FILE_SHARE_READ,0x20);
        if (status<0 || !ReadFile(file,text,31,&read,NULL) || strcmp(text,"changed")) goto cleanup;
        CloseHandle(file); file=INVALID_HANDLE_VALUE;
    }
    /* Rename from outside the source namespace into it; preserve contents. */
    join_path(path,MAX_PATH,root,L"outside.txt"); if (!portable_test_write(path,"renamed")) goto cleanup;
    join_path(other,MAX_PATH,source,L"Local\\moved.dat");
    if (!MoveFileExW(path,other,MOVEFILE_REPLACE_EXISTING) || !portable_test_read(other,"renamed")) goto cleanup;
    if (!DeleteFileW(other) || GetFileAttributesW(other)!=INVALID_FILE_ATTRIBUTES) goto cleanup;
    join_path(path,MAX_PATH,source,L"Local\\\x50cf\x7d20 \x6570\x636e.dat");
    if (!portable_test_write(path,"unicode") || !portable_test_read(path,"unicode") || !DeleteFileW(path)) goto cleanup;
    ok=1;
cleanup:
    if (file!=INVALID_HANDLE_VALUE) CloseHandle(file);
    if (original_root!=INVALID_HANDLE_VALUE) CloseHandle(original_root);
    portable_active=0;
    if (installed && !portable_update_imports(0)) ExitProcess(1);
    join_path(path,MAX_PATH,source,L"Local\\sentinel.dat");
    ok=ok && portable_test_read(path,"original");
    DeleteFileW(path);
    join_path(path,MAX_PATH,target,L"Local\\sentinel.dat"); DeleteFileW(path);
    join_path(path,MAX_PATH,target,L"Local\\moved.dat"); DeleteFileW(path);
    join_path(path,MAX_PATH,target,L"Local\\\x50cf\x7d20 \x6570\x636e.dat"); DeleteFileW(path);
    join_path(path,MAX_PATH,root,L"outside.txt"); DeleteFileW(path);
    join_path(path,MAX_PATH,source,L"Local"); RemoveDirectoryW(path);
    join_path(path,MAX_PATH,target,L"Local"); RemoveDirectoryW(path);
    RemoveDirectoryW(source); RemoveDirectoryW(target); RemoveDirectoryW(root);
done:
    if (mapped) HeapFree(GetProcessHeap(),0,mapped);
    log_line("Portable file I/O: KernelBase imports, read/write, attributes, enumeration, relative handle, rename/delete, Unicode and original-data isolation: %s",ok?"PASS":"FAIL");
    return ok;
}
