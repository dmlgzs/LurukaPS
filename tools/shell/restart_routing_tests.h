/* A child process has no file hooks: it must receive the redirected path itself. */
static void *restart_test_full_path(void *value,const void *method) { return method==(void *)456?value:NULL; }
static int restart_routing_test(void) {
    wchar_t temp[MAX_PATH],root[MAX_PATH],source[MAX_PATH],target[MAX_PATH],path[MAX_PATH],marker[MAX_PATH],exe[32768],command[32768],legacy[32768];
    PROCESS_INFORMATION process; STARTUPINFOW startup={0}; DWORD n,exit_code=1; int installed=0,ok=0;
    void *arguments=(void *)L"-start=azurpromilia_launcher";
    n=GetTempPathW(MAX_PATH,temp);
    if (!n || n>=MAX_PATH || !GetTempFileNameW(temp,L"lps",0,root) || !DeleteFileW(root) || !CreateDirectoryW(root,NULL)) return 0;
    join_path(source,MAX_PATH,root,L"AppData"); join_path(target,MAX_PATH,root,L"LuruksPSData");
    join_path(path,MAX_PATH,target,L"LocalLow\\manjuu\\AzurPromilia\\RestartRequests");
    if (SHCreateDirectoryExW(NULL,path,NULL)!=ERROR_SUCCESS || !configure_portable_paths(source,target) ||
        !portable_bind_imports() || !portable_update_imports(1)) goto done;
    installed=1; portable_active=1;
    join_path(temp,MAX_PATH,source,L"LocalLow\\manjuu\\AzurPromilia");
    string_new=transport_test_string_new; rt.string_length=transport_test_length; rt.string_chars=transport_test_chars;
    rt.gc_new=sdk_test_gc_new; rt.gc_target=sdk_test_gc_target; rt.gc_free=sdk_test_gc_free;
    restart_full_path_original=restart_test_full_path;
    if (!prepare_restart_paths() || restart_path_root || restart_exe_root || transport_test_string_count) goto done;
    join_path(path,MAX_PATH,target,L"LocalLow\\manjuu\\AzurPromilia");
    if (wcscmp(restart_persistent_path(NULL),path) || wcscmp(restart_persistent_path(NULL),path) || transport_test_string_count!=1) goto done;
    if (!executable_directory(command,32768) || !join_path(legacy,32768,command,L"AzurPromilia.exe")) goto done;
    n=GetModuleFileNameW(NULL,exe,32768);
    if (!n || n>=32768 || wcscmp(restart_full_path(legacy,(void *)456),exe) ||
        GetFileAttributesW(restart_full_path(legacy,(void *)456))==INVALID_FILE_ATTRIBUTES) goto done;
    if (restart_full_path(arguments,(void *)456)!=arguments) goto done;
    join_path(marker,MAX_PATH,temp,L"RestartRequests\\commit");
    if (!portable_test_write(marker,"handoff")) goto done;
    join_path(marker,MAX_PATH,path,L"RestartRequests\\commit");
    if (swprintf(command,32768,L"\"%ls\" --restart-marker-check \"%ls\"",exe,marker)<0) goto done;
    startup.cb=sizeof(startup);
    if (!CreateProcessW(exe,command,NULL,NULL,FALSE,CREATE_NO_WINDOW,NULL,NULL,&startup,&process)) goto done;
    if (WaitForSingleObject(process.hProcess,5000)!=WAIT_OBJECT_0) TerminateProcess(process.hProcess,1);
    else GetExitCodeProcess(process.hProcess,&exit_code);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    ok=exit_code==0;
done:
    portable_active=0;
    if (installed && !portable_update_imports(0)) ExitProcess(1);
    if (restart_path_root) rt.gc_free(restart_path_root);
    if (restart_exe_root) rt.gc_free(restart_exe_root);
    restart_path_root=restart_exe_root=0;
    log_line("Restart installation: fixed portable path, no engine getter or install-time managed allocation: %s",ok?"PASS":"FAIL");
    join_path(path,MAX_PATH,target,L"LocalLow\\manjuu\\AzurPromilia\\RestartRequests\\commit"); DeleteFileW(path);
    join_path(path,MAX_PATH,target,L"LocalLow\\manjuu\\AzurPromilia\\RestartRequests"); RemoveDirectoryW(path);
    join_path(path,MAX_PATH,target,L"LocalLow\\manjuu\\AzurPromilia"); RemoveDirectoryW(path);
    join_path(path,MAX_PATH,target,L"LocalLow\\manjuu"); RemoveDirectoryW(path);
    join_path(path,MAX_PATH,target,L"LocalLow"); RemoveDirectoryW(path);
    RemoveDirectoryW(target); RemoveDirectoryW(root);
    log_line("Restart handoff: redirected persistent path, current EXE, original arguments and unhooked child marker visibility: %s",ok?"PASS":"FAIL");
    return ok;
}
