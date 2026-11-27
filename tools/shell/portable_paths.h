/* Process-local file namespace mapping. No environment, registry or disk patches.
 * Redirect KernelBase file imports, preserving any Sandboxie/AV interception.
 * Existing handles keep the filesystem's normal I/O semantics; no syscall code is changed.
 */
#define PORTABLE_CAPACITY 32768
#define PORTABLE_NO_MEMORY ((NTSTATUS)0xc0000017L)
typedef NTSTATUS (NTAPI *PortableCreateFn)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,
    PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
typedef NTSTATUS (NTAPI *PortableOpenFn)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,ULONG,ULONG);
typedef NTSTATUS (NTAPI *PortableQueryFn)(POBJECT_ATTRIBUTES,PVOID);
typedef NTSTATUS (NTAPI *PortableSetFn)(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,FILE_INFORMATION_CLASS);
static PortableCreateFn portable_create_original;
static PortableOpenFn portable_open_original;
static PortableQueryFn portable_query_original,portable_full_query_original;
static PortableSetFn portable_set_original;
static wchar_t portable_source[PORTABLE_CAPACITY],portable_target[PORTABLE_CAPACITY];
static wchar_t portable_device[MAX_PATH],portable_drive[3];
static int portable_active;
static _Thread_local unsigned portable_mapping;
typedef struct { OBJECT_ATTRIBUTES attributes; UNICODE_STRING name; wchar_t *text; } PortableObject;
typedef struct { ULONG flags; HANDLE root; ULONG bytes; wchar_t name[1]; } PortableRename;
_Static_assert(offsetof(PortableRename,name)==20,"Win64 rename/link information layout");

static int portable_prefix(const wchar_t *path,const wchar_t *root) {
    size_t n=wcslen(root),length=wcslen(path);
    return n && length>=n && !_wcsnicmp(path,root,n) && (!path[n] || path[n]==L'\\' || path[n]==L'/');
}
/* Most file operations are unrelated. Avoid allocations and path queries for them. */
static int portable_candidate(const wchar_t *name,size_t length,HANDLE root) {
    size_t i;
    if (!name || !length || length>=PORTABLE_CAPACITY) return 0;
    if (root) return 1;
    for (i=0;i+7<=length;++i)
        if ((name[i]==L'A' || name[i]==L'a') && !_wcsnicmp(name+i,L"AppData",7)) return 1;
    return 0;
}
/* Canonicalize before matching; allocate only the actual pathname length.
 * Return 1 for a new NT name, 0 for an unrelated name, -1 on size/allocation failure. */
static int portable_name(const wchar_t *name,size_t length,HANDLE root,wchar_t **out) {
    wchar_t *input=NULL,*full=NULL; const wchar_t *dos; DWORD n,root_length=0; size_t capacity,used; int result=0;
    *out=NULL;
    if (!portable_candidate(name,length,root) || wmemchr(name,0,length)) return 0;
    if (root && name[0]!=L'\\' && !(length>1 && name[1]==L':')) {
        root_length=GetFinalPathNameByHandleW(root,NULL,0,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
        if (!root_length) return 0;
    }
    capacity=root_length+length+4;
    if (capacity>=PORTABLE_CAPACITY) return -1;
    input=HeapAlloc(GetProcessHeap(),0,capacity*sizeof(wchar_t));
    if (!input) return -1;
    if (root_length) {
        n=GetFinalPathNameByHandleW(root,input,root_length,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
        if (!n || n>=root_length) goto done;
        input[n++]=L'\\'; memcpy(input+n,name,length*sizeof(wchar_t)); input[n+length]=0;
    } else { memcpy(input,name,length*sizeof(wchar_t)); input[length]=0; }
    dos=input;
    if (!_wcsnicmp(input,L"\\??\\",4) || !_wcsnicmp(input,L"\\\\?\\",4)) {
        dos=input+4;
        if (!_wcsnicmp(dos,L"UNC\\",4)) { input[6]=L'\\'; dos=input+6; }
    } else if (portable_device[0] && portable_prefix(input,portable_device)) {
        used=wcslen(portable_device);
        memmove(input+2,input+used,(wcslen(input+used)+1)*sizeof(wchar_t));
        input[0]=portable_drive[0]; input[1]=L':'; dos=input;
    }
    if (!((dos[0] && dos[1]==L':' && (dos[2]==L'\\' || dos[2]==L'/')) ||
        (dos[0]==L'\\' && dos[1]==L'\\' && dos[2]!=L'.' && dos[2]!=L'?'))) goto done;
    n=GetFullPathNameW(dos,0,NULL,NULL);
    if (!n || n>=PORTABLE_CAPACITY) { result=-1; goto done; }
    full=HeapAlloc(GetProcessHeap(),0,n*sizeof(wchar_t));
    if (!full) { result=-1; goto done; }
    if (!GetFullPathNameW(dos,n,full,NULL)) goto done;
    if (portable_prefix(full,portable_target) || !portable_prefix(full,portable_source)) goto done;
    used=wcslen(portable_target)+wcslen(full+wcslen(portable_source))+8;
    if (used>=PORTABLE_CAPACITY || used*sizeof(wchar_t)>USHRT_MAX) { result=-1; goto done; }
    *out=HeapAlloc(GetProcessHeap(),0,used*sizeof(wchar_t));
    if (!*out) { result=-1; goto done; }
    if (portable_target[0]==L'\\' && portable_target[1]==L'\\') {
        wcscpy(*out,L"\\??\\UNC\\"); wcscat(*out,portable_target+2);
    } else { wcscpy(*out,L"\\??\\"); wcscat(*out,portable_target); }
    wcscat(*out,full+wcslen(portable_source)); result=1;
done:
    if (full) HeapFree(GetProcessHeap(),0,full);
    HeapFree(GetProcessHeap(),0,input); return result;
}
static int portable_object(POBJECT_ATTRIBUTES original,PortableObject *copy) {
    int result;
    copy->text=NULL;
    if (!portable_active || portable_mapping || !original || !original->ObjectName ||
        original->ObjectName->Length%sizeof(wchar_t)) return 0;
    ++portable_mapping;
    result=portable_name(original->ObjectName->Buffer,original->ObjectName->Length/sizeof(wchar_t),
        original->RootDirectory,&copy->text);
    --portable_mapping;
    if (result==1) {
        copy->attributes=*original; copy->attributes.RootDirectory=NULL;
        copy->name.Buffer=copy->text; copy->name.Length=(USHORT)(wcslen(copy->text)*sizeof(wchar_t));
        copy->name.MaximumLength=copy->name.Length+sizeof(wchar_t); copy->attributes.ObjectName=&copy->name;
    }
    return result;
}
static NTSTATUS NTAPI portable_create(PHANDLE handle,ACCESS_MASK access,POBJECT_ATTRIBUTES attributes,
    PIO_STATUS_BLOCK io,PLARGE_INTEGER allocation,ULONG flags,ULONG share,ULONG disposition,ULONG options,PVOID ea,ULONG ea_size) {
    PortableObject mapped={0}; NTSTATUS result;
    /* FILE_OPEN_BY_FILE_ID uses a binary identifier, not a pathname. */
    if (!(options&0x2000) && portable_object(attributes,&mapped)<0) return PORTABLE_NO_MEMORY;
    result=portable_create_original(handle,access,mapped.text?&mapped.attributes:attributes,io,allocation,flags,share,disposition,options,ea,ea_size);
    if (mapped.text) HeapFree(GetProcessHeap(),0,mapped.text);
    return result;
}
static NTSTATUS NTAPI portable_open(PHANDLE handle,ACCESS_MASK access,POBJECT_ATTRIBUTES attributes,
    PIO_STATUS_BLOCK io,ULONG share,ULONG options) {
    PortableObject mapped={0}; NTSTATUS result;
    if (!(options&0x2000) && portable_object(attributes,&mapped)<0) return PORTABLE_NO_MEMORY;
    result=portable_open_original(handle,access,mapped.text?&mapped.attributes:attributes,io,share,options);
    if (mapped.text) HeapFree(GetProcessHeap(),0,mapped.text);
    return result;
}
static NTSTATUS portable_query(POBJECT_ATTRIBUTES attributes,PVOID information,PortableQueryFn original) {
    PortableObject mapped; NTSTATUS result;
    if (portable_object(attributes,&mapped)<0) return PORTABLE_NO_MEMORY;
    result=original(mapped.text?&mapped.attributes:attributes,information);
    if (mapped.text) HeapFree(GetProcessHeap(),0,mapped.text);
    return result;
}
static NTSTATUS NTAPI portable_query_attributes(POBJECT_ATTRIBUTES attributes,PVOID information) {
    return portable_query(attributes,information,portable_query_original);
}
static NTSTATUS NTAPI portable_query_full_attributes(POBJECT_ATTRIBUTES attributes,PVOID information) {
    return portable_query(attributes,information,portable_full_query_original);
}
static NTSTATUS NTAPI portable_set_information(HANDLE handle,PIO_STATUS_BLOCK io,PVOID information,ULONG bytes,FILE_INFORMATION_CLASS kind) {
    PortableRename *rename=information,*copy; wchar_t *target; int changed; NTSTATUS result;
    /* FileRenameInformation, FileLinkInformation and their Ex variants share this prefix. */
    if (!portable_active || portable_mapping || ((int)kind!=10 && (int)kind!=11 && (int)kind!=65 && (int)kind!=72) ||
        !rename || bytes<offsetof(PortableRename,name) || rename->bytes>bytes- offsetof(PortableRename,name) || rename->bytes%2)
        return portable_set_original(handle,io,information,bytes,kind);
    ++portable_mapping;
    changed=portable_name(rename->name,rename->bytes/sizeof(wchar_t),rename->root,&target);
    --portable_mapping;
    if (changed<=0) {
        return changed<0?PORTABLE_NO_MEMORY:portable_set_original(handle,io,information,bytes,kind);
    }
    bytes=(ULONG)(offsetof(PortableRename,name)+wcslen(target)*sizeof(wchar_t));
    copy=HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,bytes);
    if (!copy) { HeapFree(GetProcessHeap(),0,target); return PORTABLE_NO_MEMORY; }
    memcpy(copy,rename,offsetof(PortableRename,name)); copy->root=NULL;
    copy->bytes=bytes-(ULONG)offsetof(PortableRename,name); memcpy(copy->name,target,copy->bytes);
    result=portable_set_original(handle,io,copy,bytes,kind);
    HeapFree(GetProcessHeap(),0,copy); HeapFree(GetProcessHeap(),0,target); return result;
}

static ImportHook portable_imports[]={
    {"NtCreateFile",(void *)portable_create,&portable_create_original,NULL,NULL},
    {"NtOpenFile",(void *)portable_open,&portable_open_original,NULL,NULL},
    {"NtQueryAttributesFile",(void *)portable_query_attributes,&portable_query_original,NULL,NULL},
    {"NtQueryFullAttributesFile",(void *)portable_query_full_attributes,&portable_full_query_original,NULL,NULL},
    {"NtSetInformationFile",(void *)portable_set_information,&portable_set_original,NULL,NULL}
};
static int portable_bind_imports(void) {
    return bind_import_hooks(GetModuleHandleW(L"kernelbase.dll"),"ntdll.dll",portable_imports,sizeof(portable_imports)/sizeof(portable_imports[0]));
}
static int portable_update_imports(int install) {
    return update_import_hooks(portable_imports,sizeof(portable_imports)/sizeof(portable_imports[0]),install);
}
static int portable_directory(const wchar_t *path) {
    DWORD attributes;
    if (CreateDirectoryW(path,NULL)) return 1;
    if (GetLastError()!=ERROR_ALREADY_EXISTS) return 0;
    attributes=GetFileAttributesW(path);
    return attributes!=INVALID_FILE_ATTRIBUTES && (attributes&FILE_ATTRIBUTE_DIRECTORY);
}
static int configure_portable_paths(const wchar_t *source,const wchar_t *target) {
    DWORD n; size_t length;
    n=GetFullPathNameW(source,PORTABLE_CAPACITY,portable_source,NULL);
    if (!n || n>=PORTABLE_CAPACITY) return 0;
    length=wcslen(portable_source); while (length>3 && portable_source[length-1]==L'\\') portable_source[--length]=0;
    n=GetFullPathNameW(target,PORTABLE_CAPACITY,portable_target,NULL);
    if (!n || n>=PORTABLE_CAPACITY || !_wcsicmp(portable_source,portable_target)) return 0;
    portable_device[0]=0; portable_drive[0]=0;
    if (portable_source[1]==L':') {
        portable_drive[0]=portable_source[0]; portable_drive[1]=L':'; portable_drive[2]=0;
        if (!QueryDosDeviceW(portable_drive,portable_device,MAX_PATH)) return 0;
    }
    return 1;
}
static int install_portable_paths(void) {
    wchar_t *paths=HeapAlloc(GetProcessHeap(),0,3*PORTABLE_CAPACITY*sizeof(wchar_t));
    wchar_t *source,*target,*child; DWORD n; size_t i; int ok=0;
    static const wchar_t *children[]={L"Local",L"LocalLow",L"Roaming",L"Local\\Temp"};
    if (!paths) return 0;
    source=paths; target=paths+PORTABLE_CAPACITY; child=paths+2*PORTABLE_CAPACITY;
    n=GetEnvironmentVariableW(L"USERPROFILE",source,PORTABLE_CAPACITY);
    if (!n || n>=PORTABLE_CAPACITY-8) goto done;
    wcscat(source,L"\\AppData");
    /* Never derive storage from the caller's current working directory. */
    if (!executable_directory(child,PORTABLE_CAPACITY) ||
        !join_path(target,PORTABLE_CAPACITY,child,L"LuruksPSData") ||
        !configure_portable_paths(source,target) || !portable_directory(target)) goto done;
    for (i=0;i<sizeof(children)/sizeof(children[0]);++i)
        if (!join_path(child,PORTABLE_CAPACITY,target,children[i]) || !portable_directory(child)) goto done;
    if (!portable_bind_imports() || !portable_update_imports(1)) goto done;
    portable_active=1;
    log_line("Process-local AppData redirection installed through KernelBase imports (existing hooks preserved): EXE directory/LuruksPSData (Local/LocalLow/Roaming); original AppData unchanged");
    ok=1;
done:
    HeapFree(GetProcessHeap(),0,paths); return ok;
}
