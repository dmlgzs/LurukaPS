/* SPDX-License-Identifier: AGPL-3.0-or-later
 * CBT3 native host, inspired by Evergreen's pre-Unity patch architecture.
 * No C++, injected DLL, Frida, or disk patches. Windows x64 only.
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>
#include <shellapi.h>
#include <bcrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <wchar.h>

_Static_assert(sizeof(void *) == 8, "Build for Windows x64");
_Static_assert(sizeof(wchar_t) == 2, "Windows UTF-16 required");

/* Restore the original CBT3 EXE's hybrid-GPU selection exports. These must
 * reside in the process EXE, not merely in a loaded Unity/plugin DLL. */
__declspec(dllexport) DWORD NvOptimusEnablement = 1;
__declspec(dllexport) DWORD AmdPowerXpressRequestHighPerformance = 1;

typedef struct {
    const char *name;
    DWORD rva;
    BYTE expected[16];
} Site;
#include "profile.h"
#include "build/watermark_script.h"

typedef struct { HANDLE file, mapping; const BYTE *bytes; size_t size; } Image;
typedef struct { BYTE *address, before[16], after[16]; size_t length; const char *name; } Patch;
typedef void *(*StringNew)(const uint16_t *, int32_t);
typedef int (WINAPI *UnityMainFn)(HINSTANCE, HINSTANCE, LPWSTR, int);
typedef void (*RequestFn)(void *,void *,void *,void *,void *,int32_t,int32_t,void *,void *);
typedef void *(*GetJsonFn)(void *,void *,void *,void *);
typedef void (*TriggerFn)(void *,int32_t,void *,void *);
typedef void (*WriteBarrierFn)(void *,void **,void *);
typedef void *(*ObjectClassFn)(void *);
typedef void *(*ClassFieldFn)(void *,const char *);
typedef size_t (*FieldOffsetFn)(void *);
typedef const char *(*ClassNameFn)(void *);
typedef void (*LuaStartFn)(void *,void *,BYTE,void *);
typedef void *(*LuaDoStringFn)(void *,void *);
static LuaStartFn lua_start_original;
static LuaDoStringFn lua_do_string;
static StringNew string_new;
static TriggerFn trigger_original;
static WriteBarrierFn write_barrier;
static ObjectClassFn object_class;
static ClassFieldFn class_field;
static FieldOffsetFn field_offset;
static ClassNameFn class_name,class_namespace;
static RequestFn request_original,request_tt2_original;
static GetJsonFn get_json_original;
static BYTE *hook_pages[5];
static wchar_t selected_open_id[129];
static FILE *log_file;
static wchar_t api_url[1024] = L"http://127.0.0.1:20001";
static wchar_t log_url[1024] = L"";
static int tcp_only = 1, camera_fade = 1, check_mode = 0;
/* On-disk client metadata differs from the decrypted analysis export. */
static const char metadata_sha256[] = "041d0270c23f13423b81ed37709d3ea50d29ab53a780113db82cc650b8c23d7e";

static void log_line(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    if (log_file) { vfprintf(log_file, fmt, args); fputc('\n', log_file); fflush(log_file); }
    va_end(args);
    va_start(args, fmt);
    vfprintf(stderr, fmt, args); fputc('\n', stderr);
    va_end(args);
}
static int error(const char *message) {
    DWORD code = GetLastError();
    log_line("ERROR: %s (Win32=%lu)", message, (unsigned long)code);
    if (!check_mode) {
        char text[1024];
        snprintf(text, sizeof(text), "%s\nWin32 error: %lu\nSee cbt3-shell.log.", message, (unsigned long)code);
        MessageBoxA(NULL, text, "CBT3 shell", MB_OK | MB_ICONERROR);
    }
    return 1;
}
static int blank_character(wchar_t ch) {
    return (ch>=9 && ch<=13) || ch==32 || ch==0xa0 || ch==0x1680 ||
        (ch>=0x2000 && ch<=0x200a) || ch==0x2028 || ch==0x2029 ||
        ch==0x202f || ch==0x205f || ch==0x3000 || ch==0xfeff;
}
static int valid_open_id(const wchar_t *text) {
    size_t length=wcslen(text); int bytes;
    if (!length || length>128 || blank_character(text[0]) || blank_character(text[length-1])) return 0;
    bytes=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text,(int)length,NULL,0,NULL,NULL);
    return bytes>0 && bytes<=128;
}
typedef struct { const wchar_t *config; int smoke; HFONT font; } AccountDialog;
static HWND dialog_control(HWND dialog,const wchar_t *klass,const wchar_t *text,DWORD style,
    int id,int x,int y,int width,int height,HFONT font) {
    RECT rect={x,y,x+width,y+height}; HWND control;
    MapDialogRect(dialog,&rect);
    control=CreateWindowExW(!wcscmp(klass,L"EDIT")?WS_EX_CLIENTEDGE:0,klass,text,
        WS_CHILD|WS_VISIBLE|style,rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top,
        dialog,(HMENU)(INT_PTR)id,GetModuleHandleW(NULL),NULL);
    if (control) SendMessageW(control,WM_SETFONT,(WPARAM)font,TRUE);
    return control;
}
static INT_PTR CALLBACK account_dialog_proc(HWND dialog,UINT message,WPARAM wparam,LPARAM lparam) {
    AccountDialog *context=(AccountDialog *)GetWindowLongPtrW(dialog,DWLP_USER);
    if (message==WM_INITDIALOG) {
        HWND edit; context=(AccountDialog *)lparam;
        SetWindowLongPtrW(dialog,DWLP_USER,(LONG_PTR)context);
        context->font=(HFONT)GetStockObject(DEFAULT_GUI_FONT);
        dialog_control(dialog,L"STATIC",L"请输入本地账号 open_id",0,100,12,12,276,14,context->font);
        edit=dialog_control(dialog,L"EDIT",selected_open_id,WS_TABSTOP|ES_AUTOHSCROLL,101,12,31,276,22,context->font);
        dialog_control(dialog,L"STATIC",L"同一账号对应同一份服务器存档。\n1～128 个 UTF-8 字节，首尾不要空白。",0,102,12,60,276,28,context->font);
        dialog_control(dialog,L"BUTTON",L"记住账号，下次预填",WS_TABSTOP|BS_AUTOCHECKBOX,103,12,94,180,16,context->font);
        dialog_control(dialog,L"BUTTON",L"启动游戏",WS_TABSTOP|BS_DEFPUSHBUTTON,IDOK,144,119,69,24,context->font);
        dialog_control(dialog,L"BUTTON",L"取消",WS_TABSTOP|BS_PUSHBUTTON,IDCANCEL,220,119,68,24,context->font);
        if (!edit) { EndDialog(dialog,-1); return TRUE; }
        SendMessageW(edit,EM_SETLIMITTEXT,128,0);
        SetFocus(edit); SendMessageW(edit,EM_SETSEL,0,-1);
        if (context->smoke) { SetWindowTextW(edit,L"ui-smoke-account"); SetTimer(dialog,1,250,NULL); }
        return FALSE;
    }
    if (message==WM_TIMER && context && context->smoke) { KillTimer(dialog,1); SendMessageW(dialog,WM_COMMAND,IDOK,0); return TRUE; }
    if (message==WM_COMMAND && LOWORD(wparam)==IDOK) {
        wchar_t value[129]; GetDlgItemTextW(dialog,101,value,129);
        if (!valid_open_id(value)) {
            MessageBoxW(dialog,L"账号不能为空，UTF-8 长度不能超过 128 字节，首尾不要空白。",L"账号格式不正确",MB_OK|MB_ICONINFORMATION);
            SetFocus(GetDlgItem(dialog,101)); return TRUE;
        }
        if (IsDlgButtonChecked(dialog,103)==BST_CHECKED &&
            !WritePrivateProfileStringW(L"shell",L"open_id",value,context->config)) {
            MessageBoxW(dialog,L"无法保存账号。请检查 INI 所在目录的写入权限。",L"保存失败",MB_OK|MB_ICONERROR); return TRUE;
        }
        wcscpy(selected_open_id,value); EndDialog(dialog,IDOK); return TRUE;
    }
    if ((message==WM_COMMAND && LOWORD(wparam)==IDCANCEL) || message==WM_CLOSE) { EndDialog(dialog,IDCANCEL); return TRUE; }
    return FALSE;
}
static int show_account_dialog(HINSTANCE instance,const wchar_t *config,int smoke) {
    /* DLGTEMPLATE variable fields are UTF-16 and word aligned. */
    union { DWORD align; BYTE bytes[256]; } buffer;
    DLGTEMPLATE *template=(DLGTEMPLATE *)buffer.bytes; WORD *tail;
    const wchar_t title[]=L"CBT3 本地账号"; INT_PTR result; AccountDialog context={config,smoke,NULL};
    memset(&buffer,0,sizeof(buffer));
    template->style=WS_POPUP|WS_CAPTION|WS_SYSMENU|DS_MODALFRAME|DS_CENTER;
    template->cx=300; template->cy=155;
    tail=(WORD *)(buffer.bytes+sizeof(DLGTEMPLATE));
    *tail++=0; *tail++=0; memcpy(tail,title,sizeof(title));
    result=DialogBoxIndirectParamW(instance,template,NULL,account_dialog_proc,(LPARAM)&context);
    return result==IDOK ? 1 : result==IDCANCEL ? 0 : -1;
}
static int join_path(wchar_t *out, size_t count, const wchar_t *dir, const wchar_t *name) {
    int n = _snwprintf(out, count, L"%ls\\%ls", dir, name);
    return n >= 0 && (size_t)n < count;
}
static void close_image(Image *image) {
    if (image->bytes) UnmapViewOfFile(image->bytes);
    if (image->mapping) CloseHandle(image->mapping);
    if (image->file != INVALID_HANDLE_VALUE) CloseHandle(image->file);
    memset(image, 0, sizeof(*image)); image->file = INVALID_HANDLE_VALUE;
}
static int open_image(Image *image, const wchar_t *path) {
    LARGE_INTEGER size;
    memset(image, 0, sizeof(*image)); image->file = INVALID_HANDLE_VALUE;
    /* Deny concurrent writes/deletes until the verified image is loaded. */
    image->file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (image->file == INVALID_HANDLE_VALUE || !GetFileSizeEx(image->file, &size) || size.QuadPart < 4096) return 0;
    image->size = (size_t)size.QuadPart;
    image->mapping = CreateFileMappingW(image->file, NULL, PAGE_READONLY, 0, 0, NULL);
    if (!image->mapping) return 0;
    image->bytes = MapViewOfFile(image->mapping, FILE_MAP_READ, 0, 0, 0);
    return image->bytes != NULL;
}
static int verify_hash(const Image *image, const char *expected) {
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    BYTE result[32]; char hex[65]; size_t pos; int ok = 0;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0) goto done;
    if (BCryptCreateHash(alg, &hash, NULL, 0, NULL, 0, 0) < 0) goto done;
    for (pos = 0; pos < image->size;) {
        ULONG chunk = (ULONG)((image->size-pos > 1048576) ? 1048576 : image->size-pos);
        if (BCryptHashData(hash, (PUCHAR)(image->bytes+pos), chunk, 0) < 0) goto done;
        pos += chunk;
    }
    if (BCryptFinishHash(hash, result, sizeof(result), 0) < 0) goto done;
    for (pos = 0; pos < 32; ++pos) snprintf(hex+pos*2, 3, "%02x", result[pos]);
    ok = strcmp(hex, expected) == 0;
    log_line("SHA256 %s: %s", ok ? "OK" : "MISMATCH", hex);
done:
    if (hash) BCryptDestroyHash(hash);
    if (alg) BCryptCloseAlgorithmProvider(alg, 0);
    return ok;
}
static const IMAGE_NT_HEADERS64 *pe_header(const Image *image) {
    const IMAGE_DOS_HEADER *dos;
    const IMAGE_NT_HEADERS64 *nt;
    if (image->size < sizeof(*dos)) return NULL;
    dos = (const IMAGE_DOS_HEADER *)image->bytes;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew < 0 ||
        (size_t)dos->e_lfanew > image->size-sizeof(*nt)) return NULL;
    nt = (const IMAGE_NT_HEADERS64 *)(image->bytes+dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
        nt->FileHeader.SizeOfOptionalHeader != sizeof(IMAGE_OPTIONAL_HEADER64)) return NULL;
    return nt;
}
static const BYTE *rva_bytes(const Image *image, DWORD rva, size_t count) {
    const IMAGE_NT_HEADERS64 *nt = pe_header(image);
    const IMAGE_SECTION_HEADER *sections; size_t i, off;
    if (!nt) return NULL;
    sections = IMAGE_FIRST_SECTION(nt);
    off = (size_t)((const BYTE *)sections-image->bytes);
    if (off > image->size || nt->FileHeader.NumberOfSections > (image->size-off)/sizeof(*sections)) return NULL;
    for (i = 0; i < nt->FileHeader.NumberOfSections; ++i) {
        const IMAGE_SECTION_HEADER *s = sections+i;
        if (rva < s->VirtualAddress || rva-s->VirtualAddress > s->SizeOfRawData) continue;
        off = rva-s->VirtualAddress;
        if (count > s->SizeOfRawData-off) return NULL;
        off += s->PointerToRawData;
        if (off > image->size || count > image->size-off) return NULL;
        return image->bytes+off;
    }
    return NULL;
}
static int verify_profile(const Image *image) {
    const IMAGE_NT_HEADERS64 *nt; size_t i;
    if (image->size != PROFILE_FILE_SIZE || !verify_hash(image, PROFILE_SHA256)) return 0;
    nt = pe_header(image);
    if (!nt || nt->FileHeader.TimeDateStamp != PROFILE_TIMESTAMP ||
        nt->OptionalHeader.SizeOfImage != PROFILE_IMAGE_SIZE) return 0;
    for (i = 0; i < sizeof(sites)/sizeof(sites[0]); ++i) {
        const BYTE *bytes = rva_bytes(image, sites[i].rva, sizeof(sites[i].expected));
        if (!bytes || memcmp(bytes, sites[i].expected, sizeof(sites[i].expected))) {
            log_line("Profile mismatch: %s RVA=%08lx", sites[i].name, (unsigned long)sites[i].rva); return 0;
        }
    }
    log_line("CBT3 PE and all native sites verified");
    return 1;
}
/* Pure bounded URL routing; never treat a URL inside a query as its path. */
static int rewrite_discovery(const wchar_t *url,size_t length,wchar_t *out,size_t capacity) {
    static const wchar_t *endpoints[]={L"/version/client/patchV1",L"/version/client/getCdnV1",
        L"/version/client/preDownloadConfV1",L"/version/client/getAccountV1",L"/version/client/cdntoken"};
    size_t start,i,path,path_end,endpoint,base_length=wcslen(api_url);
    if (length>=7 && !wmemcmp(url,L"http://",7)) start=7;
    else if (length>=8 && !wmemcmp(url,L"https://",8)) start=8;
    else return 0;
    for (i=start;i<length && url[i]!=L'/' && url[i]!=L'?' && url[i]!=L'#';++i) {}
    if (i==start || i==length || url[i]!=L'/') return 0;
    path=i;
    for (path_end=path;path_end<length && url[path_end]!=L'?' && url[path_end]!=L'#';++path_end) {}
    for (endpoint=0;endpoint<sizeof(endpoints)/sizeof(endpoints[0]);++endpoint)
        if (path_end-path==wcslen(endpoints[endpoint]) &&
            !wmemcmp(url+path,endpoints[endpoint],path_end-path)) break;
    if (endpoint==sizeof(endpoints)/sizeof(endpoints[0])) return 0;
    if (path==base_length && !wmemcmp(url,api_url,base_length)) return 0;
    if (base_length+length-path>=capacity) return -1;
    memcpy(out,api_url,base_length*sizeof(wchar_t));
    memcpy(out+base_length,url+path,(length-path)*sizeof(wchar_t));
    out[base_length+length-path]=0;
    return 1;
}
static void *route_managed_url(void *url,int *changed) {
    wchar_t replacement[4096]; int32_t length; int result;
    *changed=0;
    if (!url) return url;
    memcpy(&length,(BYTE *)url+16,sizeof(length));
    if (length<0 || length>32767) return url;
    result=rewrite_discovery((const wchar_t *)((const BYTE *)url+20),(size_t)length,replacement,4096);
    if (result<0) {
        log_line("Discovery URL exceeds routing capacity; refusing official fallback");
        ExitProcess(1);
    }
    if (!result) return url;
    url=string_new((const uint16_t *)replacement,(int32_t)wcslen(replacement));
    if (!url) { log_line("IL2CPP URL allocation failed"); ExitProcess(1); }
    *changed=1;
    log_line("Redirected allowlisted /version/client/ endpoint to configured local API (query redacted)");
    return url;
}
static void request_replacement(void *url,void *method,void *headers,void *body,
    void *complete,int32_t timeout,int32_t retry,void *backups,void *method_info) {
    int changed; url=route_managed_url(url,&changed);
    request_original(url,method,headers,body,complete,timeout,retry,changed?NULL:backups,method_info);
}
static void request_tt2_replacement(void *url,void *method,void *headers,void *body,
    void *complete,int32_t timeout,int32_t retry,void *backups,void *method_info) {
    int changed; url=route_managed_url(url,&changed);
    request_tt2_original(url,method,headers,body,complete,timeout,retry,changed?NULL:backups,method_info);
}
static void *get_json_replacement(void *url,void *success,void *failure,void *method_info) {
    int changed; url=route_managed_url(url,&changed);
    return get_json_original(url,success,failure,method_info);
}
static int checked_field(void *object,const char *type,const char *field,size_t expected) {
    void *klass,*info;
    if (!object) return 0;
    klass=object_class(object);
    if (!klass || strcmp(class_name(klass),type) || strcmp(class_namespace(klass),"MJUnionSDK")) return 0;
    info=class_field(klass,field);
    return info && field_offset(info)==expected;
}
static int fill_login_identity(void *data) {
    void *user,*identity;
    if (!checked_field(data,"MJSDKLoginData","userInfo",0x28)) return 0;
    memcpy(&user,(BYTE *)data+0x28,sizeof(user));
    if (!checked_field(user,"MJSDKUserInfo","openId",0x10)) return 0;
    identity=string_new((const uint16_t *)selected_open_id,(int32_t)wcslen(selected_open_id));
    if (!identity) return 0;
    write_barrier(user,(void **)((BYTE *)user+0x10),identity);
    return 1;
}
static void trigger_replacement(void *handler,int32_t type,void *data,void *method_info) {
    if (type==2) { /* EMJSDKType.Login, not Init/BeginLogin. */
        int32_t code;
        if (!checked_field(data,"MJSDKLoginData","code",0x10)) {
            log_line("Unexpected local login callback layout; refusing to send empty identity"); ExitProcess(1);
        }
        memcpy(&code,(BYTE *)data+0x10,sizeof(code));
        if (!code) {
            if (!valid_open_id(selected_open_id) || !fill_login_identity(data)) {
                log_line("Failed to populate local login identity; Unity login stopped"); ExitProcess(1);
            }
            log_line("Local login identity assigned before callback dispatch (value not logged)");
        }
    }
    trigger_original(handler,type,data,method_info);
}
static void *log_replacement(void *method_info) {
    (void)method_info;
    return string_new((const uint16_t *)log_url, (int32_t)wcslen(log_url));
}
static void lua_start_replacement(void *self,void *main,BYTE debug,void *method_info) {
    void *script;
    lua_start_original(self,main,debug,method_info);
    script=string_new(watermark_script,(int32_t)(sizeof(watermark_script)/sizeof(watermark_script[0])-1));
    if (!script) { log_line("Watermark script allocation failed"); return; }
    lua_do_string(script,NULL);
    log_line("Watermark policy submitted after Lua startup; check Player.log for installation/readback");
}
static int write_code(BYTE *address, const BYTE *bytes, size_t count) {
    DWORD previous, ignored;
    if (!VirtualProtect(address, count, PAGE_EXECUTE_READWRITE, &previous)) return 0;
    memcpy(address, bytes, count);
    if (!FlushInstructionCache(GetCurrentProcess(), address, count)) {
        VirtualProtect(address, count, previous, &ignored); return 0;
    }
    return VirtualProtect(address, count, previous, &ignored) != 0;
}
static int apply_patches(Patch *patches, size_t count) {
    size_t i;
    /* Validate the whole transaction before changing any site. */
    for (i = 0; i < count; ++i) {
        if (memcmp(patches[i].address, patches[i].before, patches[i].length)) {
            log_line("Memory mismatch: %s", patches[i].name); return 0;
        }
    }
    for (i = 0; i < count; ++i) {
        if (!write_code(patches[i].address, patches[i].after, patches[i].length)) {
            /* Include the failing site: protection/flush can fail after memcpy. */
            size_t n = i+1;
            while (n) { --n; if (!write_code(patches[n].address, patches[n].before, patches[n].length))
                log_line("Rollback failed: %s; Unity will not start", patches[n].name); }
            return 0;
        }
        log_line("Installed: %s", patches[i].name);
    }
    return 1;
}
static Patch make_patch(BYTE *base, size_t index, int kind, const void *target) {
    Patch p; memset(&p, 0, sizeof(p));
    p.address = base+sites[index].rva; p.name = sites[index].name;
    memcpy(p.before, sites[index].expected, sizeof(p.before));
    if (kind == 0) { p.after[0]=0x31; p.after[1]=0xc0; p.after[2]=0xc3; p.length=3; }
    else if (kind == 1) { p.after[0]=0xc3; p.length=1; }
    else if (kind == 2) {
        int32_t rel = (int32_t)((const BYTE *)target-(p.address+5));
        p.after[0]=0xe9; memcpy(p.after+1, &rel, sizeof(rel)); p.length=5;
    } else {
        /* RIP-indirect jump: no clobbered arguments/registers or push/ret. */
        p.after[0]=0xff; p.after[1]=0x25;
        memcpy(p.after+6, &target, sizeof(target)); p.length=14;
    }
    return p;
}
static void absolute_jump(BYTE *out,const void *target) {
    memset(out,0,14); out[0]=0xff; out[1]=0x25; memcpy(out+6,&target,sizeof(target));
}
static BYTE *allocate_near(BYTE *address) {
    SYSTEM_INFO system; uintptr_t origin,delta,step;
    GetSystemInfo(&system); step=system.dwAllocationGranularity;
    origin=(uintptr_t)address & ~(step-1);
    for (delta=step;delta<0x7fff0000u;delta+=step) {
        uintptr_t candidates[2]={origin+delta,origin>=delta?origin-delta:0}; size_t i;
        for (i=0;i<2;++i) {
            MEMORY_BASIC_INFORMATION info; BYTE *page;
            if (!candidates[i] || !VirtualQuery((void *)candidates[i],&info,sizeof(info)) || info.State!=MEM_FREE) continue;
            page=VirtualAlloc((void *)candidates[i],4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
            if (page) return page;
        }
    }
    return NULL;
}
static int prepare_hook_at(BYTE *entry,const Site *site,const void *callback,size_t index,Patch *patch) {
    BYTE *page; DWORD previous; int64_t relative;
    /* All three verified prologues begin with one complete 5-byte
     * mov [rsp+disp8],rbx, with no relative address to relocate. */
    if (site->expected[0]!=0x48 || site->expected[1]!=0x89 ||
        site->expected[2]!=0x5c || site->expected[3]!=0x24 || memcmp(entry,site->expected,16)) return 0;
    page=allocate_near(entry);
    if (!page) return 0;
    memcpy(page,entry,5); absolute_jump(page+5,entry+5);
    absolute_jump(page+64,callback);
    if (!VirtualProtect(page,4096,PAGE_EXECUTE_READ,&previous) ||
        !FlushInstructionCache(GetCurrentProcess(),page,4096)) { VirtualFree(page,0,MEM_RELEASE); return 0; }
    hook_pages[index]=page;
    memset(patch,0,sizeof(*patch)); patch->address=entry; patch->name=site->name; patch->length=5;
    memcpy(patch->before,entry,5); patch->after[0]=0xe9;
    relative=(int64_t)(uintptr_t)(page+64)-(int64_t)(uintptr_t)(entry+5);
    if (relative<INT32_MIN || relative>INT32_MAX) return 0;
    { int32_t rel=(int32_t)relative; memcpy(patch->after+1,&rel,4); }
    return 1;
}
static int prepare_hook(BYTE *base,size_t site,const void *callback,size_t index,Patch *patch) {
    return prepare_hook_at(base+sites[site].rva,&sites[site],callback,index,patch);
}
static int install_patches(HMODULE game) {
    BYTE *base = (BYTE *)game; Patch patches[20]; size_t n=0, i;
    /* Also guard unmodified callback targets and all overwritten prologues. */
    for (i=0; i<sizeof(sites)/sizeof(sites[0]); ++i)
        if (memcmp(base+sites[i].rva, sites[i].expected, sizeof(sites[i].expected))) return 0;
    patches[n++] = make_patch(base, SITE_Start, 2, base+sites[SITE_LaunchOptionStart].rva);
    patches[n++] = make_patch(base, SITE_InfoEnableSdk, 0, NULL);
    patches[n++] = make_patch(base, SITE_AppEnableSdk, 0, NULL);
    if (!prepare_hook(base,SITE_RequestUrl,(const void *)request_replacement,0,&patches[n++]) ||
        !prepare_hook(base,SITE_RequestUrlTT2,(const void *)request_tt2_replacement,1,&patches[n++]) ||
        !prepare_hook(base,SITE_HttpGetJson,(const void *)get_json_replacement,2,&patches[n++])) return 0;
    memcpy(&request_original,&hook_pages[0],sizeof(request_original));
    memcpy(&request_tt2_original,&hook_pages[1],sizeof(request_tt2_original));
    memcpy(&get_json_original,&hook_pages[2],sizeof(get_json_original));
    if (!prepare_hook(base,SITE_SdkTrigger,(const void *)trigger_replacement,3,&patches[n++])) return 0;
    memcpy(&trigger_original,&hook_pages[3],sizeof(trigger_original));
    if (!prepare_hook(base,SITE_LuaStart,(const void *)lua_start_replacement,4,&patches[n++])) return 0;
    memcpy(&lua_start_original,&hook_pages[4],sizeof(lua_start_original));
    { void *address=base+sites[SITE_LuaDoString].rva; memcpy(&lua_do_string,&address,sizeof(lua_do_string)); }
    patches[n++] = make_patch(base, SITE_InfoLogUrl, 3, (const void *)log_replacement);
    patches[n++] = make_patch(base, SITE_AppLogUrl, 3, (const void *)log_replacement);
    if (tcp_only) {
        patches[n++] = make_patch(base, SITE_InfoTLS, 0, NULL);
        patches[n++] = make_patch(base, SITE_InfoKcp, 0, NULL);
        patches[n++] = make_patch(base, SITE_NetKcp, 0, NULL);
        patches[n++] = make_patch(base, SITE_NetSsl, 0, NULL);
    }
    if (camera_fade) {
        patches[n++] = make_patch(base, SITE_CameraFade, 1, NULL);
        patches[n++] = make_patch(base, SITE_NpcFade, 1, NULL);
    }
    return apply_patches(patches, n);
}
static int read_boolean(const wchar_t *path, const wchar_t *key, int fallback) {
    wchar_t value[16], def[2]={(wchar_t)(L'0'+fallback),0};
    GetPrivateProfileStringW(L"shell", key, def, value, 16, path);
    if (!wcscmp(value,L"0")) return 0;
    if (!wcscmp(value,L"1")) return 1;
    return -1;
}
static int read_config(const wchar_t *path) {
    DWORD n; size_t i;
    n=GetPrivateProfileStringW(L"shell",L"api_url",L"http://127.0.0.1:20001",api_url,1024,path);
    if (n==1023 || !n || (wcsncmp(api_url,L"http://",7) && wcsncmp(api_url,L"https://",8))) return 0;
    for (i=0; api_url[i]; ++i) if (api_url[i]<=32) return 0;
    while (i && api_url[i-1]==L'/') api_url[--i]=0;
    if (i <= (!wcsncmp(api_url,L"https://",8) ? 8u : 7u)) return 0;
    n=GetPrivateProfileStringW(L"shell",L"log_url",L"",log_url,1024,path);
    if (n==1023 || (n && wcsncmp(log_url,L"http://",7) && wcsncmp(log_url,L"https://",8))) return 0;
    for (i=0; log_url[i]; ++i) if (log_url[i]<=32) return 0;
    tcp_only=read_boolean(path,L"tcp_only",1);
    camera_fade=read_boolean(path,L"disable_camera_fade",1);
    n=GetPrivateProfileStringW(L"shell",L"open_id",L"",selected_open_id,129,path);
    if (n==128 && selected_open_id[127]) {
        wchar_t full[512]; DWORD full_length=GetPrivateProfileStringW(L"shell",L"open_id",L"",full,512,path);
        if (full_length>128) return 0;
    }
    if (n && !valid_open_id(selected_open_id)) return 0;
    return tcp_only>=0 && camera_fade>=0;
}
typedef uintptr_t (*TestNineFn)(void *,void *,void *,void *,void *,int32_t,int32_t,void *,void *);
static TestNineFn test_nine_original;
static uintptr_t test_nine_logic(void *a,void *b,void *c,void *d,void *e,int32_t f,int32_t g,void *h,void *i) {
    return (uintptr_t)a+(uintptr_t)b+(uintptr_t)c+(uintptr_t)d+(uintptr_t)e+f+g+(uintptr_t)h+(uintptr_t)i;
}
static uintptr_t test_nine_hook(void *a,void *b,void *c,void *d,void *e,int32_t f,int32_t g,void *h,void *i) {
    return test_nine_original(a,b,c,d,e,f,g,h,i)+1;
}
static int routing_self_test(void) {
    wchar_t out[4096],input[512],expected[512]; size_t i,j,length;
    const wchar_t *endpoints[]={L"patchV1",L"getCdnV1",L"preDownloadConfV1",L"getAccountV1",L"cdntoken"};
    const wchar_t *suffixes[]={L"",L"?zoneId=22&url=/version/client/patchV1#fragment",
        L"#fragment?zoneId=22",L"?"};
    const wchar_t *unchanged[]={L"https://cdn.example/chs/windows/30_package_1938420.hash",
        L"https://api.example/sdk/login",L"https://api.example/version/client/patchV10",
        L"https://api.example/version/client/getCdnV1/asset",L"https://api.example/version/client/preDownloadConfV1/",
        L"https://api.example/version/client/getAccountV1.json",L"https://api.example/version/client/cdntokenX",
        L"https://api.example/version/client/PatchV1",L"https://api.example/path?url=/version/client/patchV1",
        L"https://api.example#url=/version/client/getCdnV1",L"https:///version/client/patchV1",
        L"http:///version/client/getCdnV1",L"/version/client/patchV1",L"//api.example/version/client/getCdnV1"};
    for (i=0;i<sizeof(endpoints)/sizeof(endpoints[0]);++i) {
        for (j=0;j<sizeof(suffixes)/sizeof(suffixes[0]);++j) {
            swprintf(input,512,L"https://api.example/version/client/%ls%ls",endpoints[i],suffixes[j]);
            swprintf(expected,512,L"http://127.0.0.1:20001/version/client/%ls%ls",endpoints[i],suffixes[j]);
            length=wcslen(expected);
            if (rewrite_discovery(input,wcslen(input),out,4096)!=1 || wcscmp(out,expected)) return 0;
            if (rewrite_discovery(input,wcslen(input),out,length+1)!=1 || wcscmp(out,expected)) return 0;
            if (rewrite_discovery(input,wcslen(input),out,length)!=-1 ||
                rewrite_discovery(input,wcslen(input),out,0)!=-1) return 0;
            if (rewrite_discovery(expected,length,out,4096)!=0 ||
                rewrite_discovery(expected,length,out,0)!=0) return 0;
        }
        swprintf(input,512,L"http://api.example/version/client/%ls",endpoints[i]);
        swprintf(expected,512,L"http://127.0.0.1:20001/version/client/%ls",endpoints[i]);
        if (rewrite_discovery(input,wcslen(input),out,4096)!=1 || wcscmp(out,expected)) return 0;
    }
    for (i=0;i<sizeof(unchanged)/sizeof(unchanged[0]);++i)
        if (rewrite_discovery(unchanged[i],wcslen(unchanged[i]),out,4096)!=0) return 0;
    log_line("Startup routing: 5 exact endpoints, query/fragment, resource/SDK exclusions, idempotence and capacity: PASS");
    return 1;
}
static int identity_test_writes,identity_test_calls,identity_test_seen;
static wchar_t identity_test_string[129];
static void *identity_test_class(void *object) { void *klass; memcpy(&klass,object,sizeof(klass)); return klass; }
static const char *identity_test_name(void *klass) { return klass==(void *)1?"MJSDKLoginData":"MJSDKUserInfo"; }
static const char *identity_test_namespace(void *klass) { (void)klass; return "MJUnionSDK"; }
static void *identity_test_field(void *klass,const char *name) {
    if (klass==(void *)1 && !strcmp(name,"userInfo")) return (void *)0x28;
    if ((klass==(void *)1 && !strcmp(name,"code")) || (klass==(void *)2 && !strcmp(name,"openId"))) return (void *)0x10;
    return NULL;
}
static size_t identity_test_offset(void *field) { return (size_t)field; }
static void *identity_test_new(const uint16_t *text,int32_t length) {
    memcpy(identity_test_string,text,(size_t)length*2); identity_test_string[length]=0; return identity_test_string;
}
static void identity_test_barrier(void *object,void **slot,void *value) {
    if (slot==(void **)((BYTE *)object+0x10)) { memcpy(slot,&value,sizeof(value)); ++identity_test_writes; }
}
static void identity_test_original(void *handler,int32_t type,void *data,void *method) {
    void *user,*value; (void)handler; (void)method; ++identity_test_calls;
    memcpy(&user,(BYTE *)data+0x28,sizeof(user)); memcpy(&value,(BYTE *)user+0x10,sizeof(value));
    if (type==2 && value==identity_test_string && !wcscmp(value,L"offline-test")) identity_test_seen=1;
}
static int identity_self_test(void) {
    BYTE data[64]={0},user[32]={0}; void *klass=(void *)1,*user_pointer=user; int32_t failure=7;
    wchar_t long_text[130],chinese[44]; size_t i;
    for (i=0;i<129;++i) long_text[i]=L'a';
    long_text[129]=0;
    for (i=0;i<43;++i) chinese[i]=L'中';
    chinese[43]=0;
    if (valid_open_id(L"") || valid_open_id(L"   ") || valid_open_id(L" leading") || valid_open_id(long_text) || valid_open_id(chinese)) return 0;
    long_text[128]=0; chinese[42]=0;
    if (!valid_open_id(long_text) || !valid_open_id(chinese)) return 0;
    memcpy(data,&klass,8); klass=(void *)2; memcpy(user,&klass,8); memcpy(data+0x28,&user_pointer,8);
    object_class=identity_test_class; class_name=identity_test_name; class_namespace=identity_test_namespace;
    class_field=identity_test_field; field_offset=identity_test_offset; write_barrier=identity_test_barrier;
    string_new=identity_test_new; trigger_original=identity_test_original;
    wcscpy(selected_open_id,L"offline-test");
    trigger_replacement(NULL,0,data,NULL);
    if (identity_test_calls!=1 || identity_test_writes) return 0;
    trigger_replacement(NULL,2,data,NULL);
    if (identity_test_calls!=2 || identity_test_writes!=1 || !identity_test_seen) return 0;
    memcpy(data+0x10,&failure,4); trigger_replacement(NULL,2,data,NULL);
    if (identity_test_calls!=3 || identity_test_writes!=1) return 0;
    memset(data+0x28,0,8);
    return !fill_login_identity(data);
}
static int self_test(void) {
    BYTE *page=VirtualAlloc(NULL,4096,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
    Patch patches[2]; DWORD previous; MEMORY_BASIC_INFORMATION info; int ok;
    typedef int (*TestFn)(void);
    if (!page) return 1;
    {
        HMODULE host=GetModuleHandleW(NULL);
        FARPROC nv=GetProcAddress(host,"NvOptimusEnablement");
        FARPROC amd=GetProcAddress(host,"AmdPowerXpressRequestHighPerformance");
        DWORD nv_value=0,amd_value=0;
        if (nv) memcpy(&nv_value,(const void *)nv,sizeof(nv_value));
        if (amd) memcpy(&amd_value,(const void *)amd,sizeof(amd_value));
        if (nv_value!=1 || amd_value!=1) { VirtualFree(page,0,MEM_RELEASE); return 1; }
        log_line("Hybrid-GPU EXE exports: PASS");
    }
    memset(patches,0,sizeof(patches));
    page[0]=0xb8; page[1]=7; page[5]=0xc3;
    page[32]=0xb8; page[33]=9; page[37]=0xc3;
    patches[0].address=page; patches[0].length=6; patches[0].name="test A";
    memcpy(patches[0].before,page,6); memcpy(patches[0].after,page+32,6);
    patches[1].address=page+64; patches[1].length=1; patches[1].name="test B";
    patches[1].before[0]=0xff; patches[1].after[0]=0xc3;
    VirtualProtect(page,4096,PAGE_EXECUTE_READ,&previous);
    ok=!apply_patches(patches,2) && ((TestFn)page)()==7;
    ok=ok && apply_patches(patches,1) && ((TestFn)page)()==9;
    VirtualQuery(page,&info,sizeof(info)); ok=ok && info.Protect==PAGE_EXECUTE_READ;
    ok=ok && write_code(page,patches[0].before,6) && ((TestFn)page)()==7;
    if (!write_code(page,(const BYTE *)"\x48\x89\x5c\x24\x08",5)) ok=0;
    {
        BYTE jump[14]; Site test_site={"nine-argument trampoline",0,{0}}; Patch hook;
        absolute_jump(jump,(const void *)test_nine_logic);
        if (!write_code(page+5,jump,14)) ok=0;
        memcpy(test_site.expected,page,16);
        if (!prepare_hook_at(page,&test_site,(const void *)test_nine_hook,0,&hook)) ok=0;
        else {
            memcpy(&test_nine_original,&hook_pages[0],sizeof(test_nine_original));
            ok=ok && apply_patches(&hook,1) && ((TestNineFn)page)((void *)1,(void *)2,(void *)3,(void *)4,(void *)5,6,7,(void *)8,(void *)9)==46;
            if (!write_code(page,hook.before,hook.length)) ok=0;
            ok=ok && ((TestNineFn)page)((void *)1,(void *)2,(void *)3,(void *)4,(void *)5,6,7,(void *)8,(void *)9)==45;
            VirtualFree(hook_pages[0],0,MEM_RELEASE); hook_pages[0]=NULL;
        }
    }
    ok=ok && routing_self_test() && identity_self_test();
    VirtualFree(page,0,MEM_RELEASE);
    log_line("Patch transaction, executable code and page protection: %s",ok?"PASS":"FAIL");
    log_line("Selective discovery routing and 9-argument Win64 trampoline: %s",ok?"PASS":"FAIL");
    log_line("Local identity validation, GC field assignment and callback ordering: %s",ok?"PASS":"FAIL");
    return ok?0:1;
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE previous,LPWSTR command,int show) {
    wchar_t exe[32768], dir[32768], path[32768]; wchar_t **argv; int argc,i,rc=1;
    Image image={INVALID_HANDLE_VALUE,NULL,NULL,0}, metadata={INVALID_HANDLE_VALUE,NULL,NULL,0};
    HMODULE unity=NULL,game=NULL; FARPROC procedure;
    UnityMainFn unity_main=NULL; (void)previous;
    argv=CommandLineToArgvW(GetCommandLineW(),&argc);
    if (!argv) return error("Cannot parse arguments");
    for (i=1;i<argc;++i) if (!wcscmp(argv[i],L"--check") || !wcscmp(argv[i],L"--self-test") || !wcscmp(argv[i],L"--help") || !wcscmp(argv[i],L"--ui-smoke-test")) check_mode=1;
    for (i=1;i<argc;++i) if (!wcscmp(argv[i],L"--console")) {
        if (AllocConsole() || AttachConsole(ATTACH_PARENT_PROCESS)) {
            FILE *stream; stream=_wfreopen(L"CONOUT$",L"w",stderr); (void)stream;
        }
    }
    if (!GetModuleFileNameW(NULL,exe,32768) || wcslen(exe)>=32767) goto done;
    wcscpy(dir,exe);
    { wchar_t *slash=wcsrchr(dir,L'\\'); if (!slash) goto done; *slash=0; }
    for (i=1;i<argc;++i) {
        if (!wcscmp(argv[i],L"--ui-smoke-test")) {
            int shown=show_account_dialog(instance,L"",1);
            rc=shown==1 && !wcscmp(selected_open_id,L"ui-smoke-account")?0:1;
            log_line("Native account dialog smoke test: %s",rc?"FAIL":"PASS"); goto done;
        }
        if (!wcscmp(argv[i],L"--self-test")) { rc=self_test(); goto done; }
        if (!wcscmp(argv[i],L"--help")) {
            log_line("Place AzurPromilia.exe and cbt3-shell.ini in the game directory.\n--check <game-directory>: validate without loading/executing DLLs\n--self-test: patch engine test\n--ui-smoke-test: native account dialog test, no Unity\n--console: show log console");
            rc=0; goto done;
        }
        if (!wcscmp(argv[i],L"--check")) {
            DWORD length;
            if (i+1>=argc) { error("--check requires game directory"); goto done; }
            length=GetFullPathNameW(argv[++i],32768,dir,NULL);
            if (!length || length>=32768) { error("Invalid/overlong game directory"); goto done; }
        }
    }
    if (!join_path(path,32768,dir,L"cbt3-shell.log")) goto done;
    /* --check is read-only, including the supplied client directory. */
    if (!check_mode) log_file=_wfopen(path,L"ab");
    log_line("CBT3 C shell; mode=%s",check_mode?"check":"Unity host");
    log_line("Hybrid-GPU high-performance hints: NVIDIA=1 AMD=1; actual adapter is reported in Player.log");
    if (!join_path(path,32768,dir,L"cbt3-shell.ini") || !read_config(path)) { error("Invalid cbt3-shell.ini"); goto done; }
    if (!join_path(path,32768,dir,L"GameAssembly.dll") || !open_image(&image,path)) { error("Cannot open GameAssembly.dll"); goto done; }
    if (!verify_profile(&image)) { error("Unsupported GameAssembly.dll; no patches applied"); goto done; }
    {
        int valid=join_path(path,32768,dir,L"AzurPromilia_Data\\il2cpp_data\\Metadata\\global-metadata.dat") &&
            open_image(&metadata,path) && verify_hash(&metadata,metadata_sha256);
        if (!valid) { error("Missing/mismatched CBT3 global-metadata.dat"); goto done; }
    }
    {
        Image player={INVALID_HANDLE_VALUE,NULL,NULL,0};
        int valid=join_path(path,32768,dir,L"UnityPlayer.dll") && open_image(&player,path) && pe_header(&player);
        close_image(&player);
        if (!valid) { error("Missing/invalid Windows x64 UnityPlayer.dll"); goto done; }
    }
    if (check_mode) { log_line("CHECK PASS; no DLL loaded, no game started"); rc=0; goto done; }
    if (!join_path(path,32768,dir,L"cbt3-shell.ini")) goto done;
    {
        int shown=show_account_dialog(instance,path,0);
        if (shown<=0) { if (shown<0) error("Cannot open account input dialog"); else rc=0; goto done; }
    }
    if (!SetCurrentDirectoryW(dir) || !SetDllDirectoryW(dir)) { error("Cannot set game directory"); goto done; }
    if (!join_path(path,32768,dir,L"UnityPlayer.dll")) goto done;
    unity=LoadLibraryExW(path,NULL,LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!unity) { error("Cannot load UnityPlayer.dll"); goto done; }
    procedure=GetProcAddress(unity,"UnityMain");
    memcpy(&unity_main,&procedure,sizeof(unity_main));
    if (!unity_main) { error("UnityPlayer.dll has no UnityMain export"); goto done; }
    if (!join_path(path,32768,dir,L"GameAssembly.dll")) goto done;
    game=LoadLibraryExW(path,NULL,LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!game) { error("Cannot load GameAssembly.dll"); goto done; }
    procedure=GetProcAddress(game,"il2cpp_string_new_utf16");
    memcpy(&string_new,&procedure,sizeof(string_new));
    procedure=GetProcAddress(game,"il2cpp_gc_wbarrier_set_field"); memcpy(&write_barrier,&procedure,sizeof(write_barrier));
    procedure=GetProcAddress(game,"il2cpp_object_get_class"); memcpy(&object_class,&procedure,sizeof(object_class));
    procedure=GetProcAddress(game,"il2cpp_class_get_field_from_name"); memcpy(&class_field,&procedure,sizeof(class_field));
    procedure=GetProcAddress(game,"il2cpp_field_get_offset"); memcpy(&field_offset,&procedure,sizeof(field_offset));
    procedure=GetProcAddress(game,"il2cpp_class_get_name"); memcpy(&class_name,&procedure,sizeof(class_name));
    procedure=GetProcAddress(game,"il2cpp_class_get_namespace"); memcpy(&class_namespace,&procedure,sizeof(class_namespace));
    if (!write_barrier || !object_class || !class_field || !field_offset || !class_name || !class_namespace) {
        error("Missing IL2CPP identity/GC exports; Unity will not start"); goto done;
    }
    if (!string_new || !install_patches(game)) { error("Native patch validation/installation failed; Unity will not start"); goto done; }
    log_line("Patches installed; calling UnityMain. In-game behavior requires verification.");
    rc=unity_main(instance,NULL,command,show);
    log_line("UnityMain returned %d",rc);
done:
    close_image(&image);
    close_image(&metadata);
    /* Let process termination unload Unity; plugins/threads may still own DLLs. */
    if (log_file) fclose(log_file);
    LocalFree(argv);
    return rc;
}
