/* Shared import-table hooks. Preserve the current callee, including Sandboxie. */
typedef struct { const char *name; void *callback; void *original; PVOID *slot; PVOID previous; } ImportHook;
static int bind_import_hooks(HMODULE module,const char *library,ImportHook *entries,size_t count) {
    BYTE *base=(BYTE *)module; size_t i;
    IMAGE_NT_HEADERS64 *nt; IMAGE_IMPORT_DESCRIPTOR *imports;
    if (!base) { SetLastError(ERROR_MOD_NOT_FOUND); return 0; }
    nt=(IMAGE_NT_HEADERS64 *)(base+((IMAGE_DOS_HEADER *)base)->e_lfanew);
    if (!nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress) return 0;
    imports=(IMAGE_IMPORT_DESCRIPTOR *)(base+nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress);
    for (;imports->Name;++imports) {
        IMAGE_THUNK_DATA64 *names,*slots;
        if (_stricmp((const char *)(base+imports->Name),library) || !imports->OriginalFirstThunk) continue;
        names=(IMAGE_THUNK_DATA64 *)(base+imports->OriginalFirstThunk);
        slots=(IMAGE_THUNK_DATA64 *)(base+imports->FirstThunk);
        for (;names->u1.AddressOfData;++names,++slots) {
            IMAGE_IMPORT_BY_NAME *name;
            if (IMAGE_SNAP_BY_ORDINAL64(names->u1.Ordinal)) continue;
            name=(IMAGE_IMPORT_BY_NAME *)(base+names->u1.AddressOfData);
            for (i=0;i<count;++i) {
                ImportHook *entry=&entries[i];
                if (strcmp((const char *)name->Name,entry->name)) continue;
                entry->slot=(PVOID *)&slots->u1.Function; entry->previous=*entry->slot;
                memcpy(entry->original,&entry->previous,sizeof(entry->previous));
            }
        }
    }
    for (i=0;i<count;++i) if (!entries[i].slot) {
        log_line("Missing imported API: %s",entries[i].name);
        SetLastError(ERROR_PROC_NOT_FOUND); return 0;
    }
    return 1;
}
static int exchange_import_hook(ImportHook *entry,int install) {
    DWORD previous,ignored; PVOID expected=install?entry->previous:entry->callback;
    PVOID replacement=install?entry->callback:entry->previous,found;
    if (!VirtualProtect(entry->slot,sizeof(*entry->slot),PAGE_READWRITE,&previous)) return 0;
    found=InterlockedCompareExchangePointer(entry->slot,replacement,expected);
    if (!VirtualProtect(entry->slot,sizeof(*entry->slot),previous,&ignored)) return 0;
    if (found!=expected) { SetLastError(ERROR_INVALID_FUNCTION); return 0; }
    return 1;
}
/* Aligned pointer exchanges need neither instruction relocation nor thread suspension. */
static int update_import_hooks(ImportHook *entries,size_t count,int install) {
    size_t i,n; DWORD failure;
    for (i=0;i<count;++i)
        if (!exchange_import_hook(&entries[i],install)) break;
    if (i==count) return 1;
    failure=GetLastError(); n=i+1;
    while (n) {
        ImportHook *entry=&entries[--n];
        if (*entry->slot==(install?entry->callback:entry->previous) && !exchange_import_hook(entry,!install)) ExitProcess(1);
    }
    SetLastError(failure); return 0;
}
