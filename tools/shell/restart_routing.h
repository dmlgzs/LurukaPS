/* The target client's persistent directory is known. Build it from the existing
 * portable root; never query Unity engine state during hook installation. */
typedef void *(*RestartFullPathFn)(void *,const void *);
static RestartFullPathFn restart_full_path_original;
static uint32_t restart_path_root,restart_exe_root;
static wchar_t restart_current_exe[32768],restart_persistent_directory[32768];
static size_t restart_directory_length;
static SRWLOCK restart_cache_lock=SRWLOCK_INIT;
static int prepare_restart_paths(void) {
    DWORD n=GetModuleFileNameW(NULL,restart_current_exe,32768); wchar_t *slash;
    if (!n || n>=32768 || !(slash=wcsrchr(restart_current_exe,L'\\'))) return 0;
    restart_directory_length=(size_t)(slash-restart_current_exe);
    if (redirect_appdata && !join_path(restart_persistent_directory,32768,portable_target,L"LocalLow\\manjuu\\AzurPromilia")) return 0;
    log_line("Restart handoff paths prepared from EXE directory; no Unity getter called");
    return 1;
}
static void *restart_cached_path(uint32_t *root,const wchar_t *text) {
    void *value;
    AcquireSRWLockExclusive(&restart_cache_lock);
    if (!*root) {
        value=string_new((const uint16_t *)text,(int32_t)wcslen(text));
        *root=value?rt.gc_new(value,0):0;
        if (!*root) local_sdk_fail("Cannot retain restart path");
    }
    value=rt.gc_target(*root);
    ReleaseSRWLockExclusive(&restart_cache_lock);
    return value;
}
static void *restart_persistent_path(const void *method) {
    (void)method; return restart_cached_path(&restart_path_root,restart_persistent_directory);
}
static void *restart_full_path(void *value,const void *method) {
    static const wchar_t suffix[]=L"\\AzurPromilia.exe";
    size_t i,length=restart_directory_length+sizeof(suffix)/sizeof(suffix[0])-1;
    int match=value && rt.string_length(value)==(int32_t)length;
    const wchar_t *text=match?(const wchar_t *)rt.string_chars(value):NULL;
    /* Rewrite before the client's File.Exists check, preserving all other paths. */
    for (i=0;match && i<length;++i) {
        wchar_t actual=text[i]==L'/'?L'\\':text[i];
        wchar_t expected=i<restart_directory_length?restart_current_exe[i]:suffix[i-restart_directory_length];
        if (towlower(actual)!=towlower(expected)) match=0;
    }
    if (match) value=restart_cached_path(&restart_exe_root,restart_current_exe);
    return restart_full_path_original(value,method);
}
