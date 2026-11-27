/* Native launch settings: embedded JPEG, GDI paint, standard keyboard-accessible
 * controls. No web runtime, worker thread or animation loop. */
enum { UI_API=110,UI_URL,UI_LOCAL,UI_ACCOUNT,UI_DATA,UI_REGISTRY,UI_FADE,UI_TCP,UI_ADVANCED };
typedef struct {
    const wchar_t *config;
    double scale;
    HFONT fonts[4];
    HBRUSH white,disabled,footer;
    HBITMAP banner;
    UINT banner_width,banner_height;
    int expanded;
} LauncherDialog;
#ifdef SHELL_SELF_TEST
static int account_dialog_smoke;
#endif
static int ui_px(LauncherDialog *ui,int value) { return (int)(value*ui->scale+0.5); }
static HBITMAP ui_load_banner(UINT *width,UINT *height) {
    IWICImagingFactory *factory=NULL; IWICStream *stream=NULL;
    IWICBitmapDecoder *decoder=NULL; IWICBitmapFrameDecode *frame=NULL; IWICFormatConverter *converter=NULL;
    HRSRC resource=FindResourceW(NULL,MAKEINTRESOURCEW(2),RT_RCDATA);
    HBITMAP bitmap=NULL; BITMAPINFO info={0}; void *pixels=NULL;
    HRESULT initialized=CoInitializeEx(NULL,COINIT_APARTMENTTHREADED);
    if (!resource || FAILED(CoCreateInstance(&CLSID_WICImagingFactory,NULL,CLSCTX_INPROC_SERVER,&IID_IWICImagingFactory,(void **)&factory))) goto done;
    if (FAILED(IWICImagingFactory_CreateStream(factory,&stream)) ||
        FAILED(IWICStream_InitializeFromMemory(stream,LockResource(LoadResource(NULL,resource)),SizeofResource(NULL,resource))) ||
        FAILED(IWICImagingFactory_CreateDecoderFromStream(factory,(IStream *)stream,NULL,WICDecodeMetadataCacheOnLoad,&decoder)) ||
        FAILED(IWICBitmapDecoder_GetFrame(decoder,0,&frame)) ||
        FAILED(IWICBitmapFrameDecode_GetSize(frame,width,height)) || !*width || !*height || *width>4096 || *height>4096 ||
        FAILED(IWICImagingFactory_CreateFormatConverter(factory,&converter)) ||
        FAILED(IWICFormatConverter_Initialize(converter,(IWICBitmapSource *)frame,&GUID_WICPixelFormat32bppBGRA,WICBitmapDitherTypeNone,NULL,0,WICBitmapPaletteTypeCustom))) goto done;
    info.bmiHeader.biSize=sizeof(info.bmiHeader); info.bmiHeader.biWidth=(LONG)*width; info.bmiHeader.biHeight=-(LONG)*height;
    info.bmiHeader.biPlanes=1; info.bmiHeader.biBitCount=32; info.bmiHeader.biCompression=BI_RGB;
    bitmap=CreateDIBSection(NULL,&info,DIB_RGB_COLORS,&pixels,NULL,0);
    if (bitmap && FAILED(IWICFormatConverter_CopyPixels(converter,NULL,*width*4,*width**height*4,pixels))) {
        DeleteObject(bitmap); bitmap=NULL;
    }
done:
    if (converter) IWICFormatConverter_Release(converter);
    if (frame) IWICBitmapFrameDecode_Release(frame);
    if (decoder) IWICBitmapDecoder_Release(decoder);
    if (stream) IWICStream_Release(stream);
    if (factory) IWICImagingFactory_Release(factory);
    if (SUCCEEDED(initialized)) CoUninitialize();
    return bitmap;
}
static void ui_round(HDC dc,LauncherDialog *ui,int x,int y,int width,int height,COLORREF fill,COLORREF border,int radius) {
    HBRUSH brush=CreateSolidBrush(fill); HPEN pen=CreatePen(PS_SOLID,1,border);
    HGDIOBJ old_brush=SelectObject(dc,brush),old_pen=SelectObject(dc,pen);
    RoundRect(dc,ui_px(ui,x),ui_px(ui,y),ui_px(ui,x+width),ui_px(ui,y+height),ui_px(ui,radius),ui_px(ui,radius));
    SelectObject(dc,old_pen); SelectObject(dc,old_brush); DeleteObject(pen); DeleteObject(brush);
}
static void ui_text(HDC dc,LauncherDialog *ui,const wchar_t *text,int x,int y,int width,int height,int font,COLORREF color,UINT flags) {
    RECT rect={ui_px(ui,x),ui_px(ui,y),ui_px(ui,x+width),ui_px(ui,y+height)};
    HGDIOBJ previous=SelectObject(dc,ui->fonts[font]);
    SetBkMode(dc,TRANSPARENT); SetTextColor(dc,color); DrawTextW(dc,text,-1,&rect,flags|DT_SINGLELINE|DT_VCENTER);
    SelectObject(dc,previous);
}
static void ui_paint(HWND dialog,LauncherDialog *ui) {
    PAINTSTRUCT paint; RECT client; HDC screen=BeginPaint(dialog,&paint),dc=CreateCompatibleDC(screen);
    HBITMAP back; HGDIOBJ previous; TRIVERTEX colors[2]; GRADIENT_RECT gradient={0,1};
    GetClientRect(dialog,&client); back=CreateCompatibleBitmap(screen,client.right,client.bottom); previous=SelectObject(dc,back);
    colors[0]=(TRIVERTEX){0,ui_px(ui,230),233<<8,242<<8,248<<8,0};
    colors[1]=(TRIVERTEX){client.right,client.bottom,224<<8,232<<8,245<<8,0};
    GradientFill(dc,colors,2,&gradient,1,GRADIENT_FILL_RECT_V);
    if (ui->banner) {
        HDC image=CreateCompatibleDC(dc); HGDIOBJ old=SelectObject(image,ui->banner);
        SetStretchBltMode(dc,HALFTONE); SetBrushOrgEx(dc,0,0,NULL);
        StretchBlt(dc,0,0,client.right,ui_px(ui,230),image,0,0,(int)ui->banner_width,(int)ui->banner_height,SRCCOPY);
        SelectObject(image,old); DeleteDC(image);
    }
    ui_round(dc,ui,24,236,712,84,RGB(255,255,255),RGB(221,231,238),16);
    ui_round(dc,ui,24,330,712,104,RGB(255,255,255),RGB(221,231,238),16);
    ui_round(dc,ui,24,444,712,84,RGB(255,255,255),RGB(221,231,238),16);
    ui_round(dc,ui,24,538,712,ui->expanded?76:48,RGB(255,255,255),RGB(221,231,238),16);
    ui_round(dc,ui,36,252,3,17,RGB(83,155,180),RGB(83,155,180),3);
    ui_round(dc,ui,36,346,3,17,RGB(83,155,180),RGB(83,155,180),3);
    ui_round(dc,ui,36,460,3,17,RGB(83,155,180),RGB(83,155,180),3);
    ui_round(dc,ui,36,554,3,17,RGB(83,155,180),RGB(83,155,180),3);
    ui_text(dc,ui,L"服务器重定向",48,246,270,28,2,RGB(38,62,82),DT_LEFT);
    ui_text(dc,ui,L"本地账号",48,340,240,28,2,RGB(38,62,82),DT_LEFT);
    ui_text(dc,ui,L"其他设置",48,454,240,28,2,RGB(38,62,82),DT_LEFT);
    ui_text(dc,ui,L"同一账号对应同一份存档；关闭后使用游戏 SDK 登录",144,407,562,18,3,RGB(117,132,149),DT_LEFT);
    {
        int enabled=IsWindowEnabled(GetDlgItem(dialog,UI_URL)); COLORREF fill=enabled?RGB(255,255,255):RGB(242,245,248);
        ui_round(dc,ui,144,278,568,30,fill,RGB(207,221,231),10);
        enabled=IsWindowEnabled(GetDlgItem(dialog,UI_ACCOUNT)); fill=enabled?RGB(255,255,255):RGB(242,245,248);
        ui_round(dc,ui,144,375,568,30,fill,RGB(207,221,231),10);
    }
    {
        RECT footer={0,ui_px(ui,620),client.right,client.bottom};
        FillRect(dc,&footer,ui->footer);
    }
    BitBlt(screen,0,0,client.right,client.bottom,dc,0,0,SRCCOPY);
    SelectObject(dc,previous); DeleteObject(back); DeleteDC(dc); EndPaint(dialog,&paint);
}
typedef struct { int id; const wchar_t *klass,*text; DWORD style; int x,y,w,h,font; } LauncherControl;
static const LauncherControl launcher_controls[]={
    {UI_API,L"BUTTON",L"启用替换",BS_AUTOCHECKBOX,510,248,212,24,1},
    {120,L"STATIC",L"API URL",0,42,282,90,24,0},
    {UI_URL,L"EDIT",L"",ES_AUTOHSCROLL,154,283,548,22,0},
    {UI_LOCAL,L"BUTTON",L"使用本地账号（关闭 SDK）",BS_AUTOCHECKBOX,510,342,212,24,1},
    {121,L"STATIC",L"账号",0,42,379,90,24,0},
    {UI_ACCOUNT,L"EDIT",L"",ES_AUTOHSCROLL,154,380,548,22,0},
    {UI_DATA,L"BUTTON",L"游戏数据重定向",BS_AUTOCHECKBOX,42,487,214,24,1},
    {UI_REGISTRY,L"BUTTON",L"注册表重定向",BS_AUTOCHECKBOX,276,487,214,24,1},
    {UI_FADE,L"BUTTON",L"反虚化",BS_AUTOCHECKBOX,510,487,212,24,1},
    {UI_ADVANCED,L"BUTTON",L"高级设置",BS_OWNERDRAW,48,548,668,28,2},
    {UI_TCP,L"BUTTON",L"仅使用 TCP",BS_AUTOCHECKBOX,42,582,480,24,1},
    {IDCANCEL,L"BUTTON",L"取消",BS_OWNERDRAW,490,633,100,34,0},
    {IDOK,L"BUTTON",L"启动游戏",BS_OWNERDRAW,604,633,132,34,0}
};
static void ui_layout(HWND dialog,LauncherDialog *ui) {
    typedef UINT (WINAPI *GetDpiFn)(HWND);
    GetDpiFn get_dpi; FARPROC proc=GetProcAddress(GetModuleHandleW(L"user32.dll"),"GetDpiForWindow");
    MONITORINFO monitor={0}; RECT rect; UINT dpi; size_t i; static const int sizes[]={14,12,16,11};
    memcpy(&get_dpi,&proc,sizeof(get_dpi)); dpi=get_dpi?get_dpi(dialog):96;
    if (!dpi) dpi=96;
    monitor.cbSize=sizeof(monitor);
    if (!GetMonitorInfoW(MonitorFromWindow(dialog,MONITOR_DEFAULTTONEAREST),&monitor) ||
        monitor.rcWork.right<=monitor.rcWork.left || monitor.rcWork.bottom<=monitor.rcWork.top) {
        if (!SystemParametersInfoW(SPI_GETWORKAREA,0,&monitor.rcWork,0) ||
            monitor.rcWork.right<=monitor.rcWork.left || monitor.rcWork.bottom<=monitor.rcWork.top)
            monitor.rcWork=(RECT){0,0,1024,768};
    }
    ui->scale=dpi/96.0;
    if (800*ui->scale>monitor.rcWork.right-monitor.rcWork.left) ui->scale=(monitor.rcWork.right-monitor.rcWork.left)/800.0;
    if (740*ui->scale>monitor.rcWork.bottom-monitor.rcWork.top) ui->scale=(monitor.rcWork.bottom-monitor.rcWork.top)/740.0;
    for (i=0;i<4;++i) {
        if (ui->fonts[i]) DeleteObject(ui->fonts[i]);
        ui->fonts[i]=CreateFontW(-ui_px(ui,sizes[i]),0,0,0,i==2?FW_SEMIBOLD:FW_NORMAL,FALSE,FALSE,FALSE,
            DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Microsoft YaHei UI");
    }
    rect=(RECT){0,0,ui_px(ui,760),ui_px(ui,680)};
    AdjustWindowRectEx(&rect,(DWORD)GetWindowLongPtrW(dialog,GWL_STYLE),FALSE,(DWORD)GetWindowLongPtrW(dialog,GWL_EXSTYLE));
    SetWindowPos(dialog,NULL,monitor.rcWork.left+(monitor.rcWork.right-monitor.rcWork.left-(rect.right-rect.left))/2,
        monitor.rcWork.top+(monitor.rcWork.bottom-monitor.rcWork.top-(rect.bottom-rect.top))/2,
        rect.right-rect.left,rect.bottom-rect.top,SWP_NOZORDER|SWP_NOACTIVATE|SWP_SHOWWINDOW);
    for (i=0;i<sizeof(launcher_controls)/sizeof(launcher_controls[0]);++i) {
        const LauncherControl *c=&launcher_controls[i]; HWND control=GetDlgItem(dialog,c->id);
        MoveWindow(control,ui_px(ui,c->x),ui_px(ui,c->y),ui_px(ui,c->w),ui_px(ui,c->h),TRUE);
        SendMessageW(control,WM_SETFONT,(WPARAM)ui->fonts[c->font],TRUE);
    }
    InvalidateRect(dialog,NULL,FALSE);
}
static int ui_checked(HWND dialog,int id) { return IsDlgButtonChecked(dialog,id)==BST_CHECKED; }
static void ui_enable_fields(HWND dialog) {
    EnableWindow(GetDlgItem(dialog,UI_URL),ui_checked(dialog,UI_API));
    EnableWindow(GetDlgItem(dialog,UI_ACCOUNT),ui_checked(dialog,UI_LOCAL));
    InvalidateRect(dialog,NULL,FALSE);
}
static INT_PTR CALLBACK launcher_dialog_proc(HWND dialog,UINT message,WPARAM wparam,LPARAM lparam) {
    LauncherDialog *ui=(LauncherDialog *)GetWindowLongPtrW(dialog,DWLP_USER);
    if (message==WM_INITDIALOG) {
        size_t i; ui=(LauncherDialog *)lparam; SetWindowLongPtrW(dialog,DWLP_USER,(LONG_PTR)ui);
        ui->white=CreateSolidBrush(RGB(255,255,255)); ui->disabled=CreateSolidBrush(RGB(242,245,248));
        ui->footer=CreateSolidBrush(RGB(241,246,250));
        ui->banner=ui_load_banner(&ui->banner_width,&ui->banner_height);
        if (!ui->banner) { EndDialog(dialog,-1); return TRUE; }
        for (i=0;i<sizeof(launcher_controls)/sizeof(launcher_controls[0]);++i) {
            const LauncherControl *c=&launcher_controls[i]; HWND control=CreateWindowExW(0,c->klass,c->text,
                WS_CHILD|WS_VISIBLE|(wcscmp(c->klass,L"STATIC")?WS_TABSTOP:0)|c->style,
                0,0,1,1,dialog,(HMENU)(INT_PTR)c->id,GetModuleHandleW(NULL),NULL);
            if (!control) { EndDialog(dialog,-1); return TRUE; }
            if (!wcscmp(c->klass,L"BUTTON")) SetWindowTheme(control,L"Explorer",NULL);
        }
        CheckDlgButton(dialog,UI_API,redirect_api?BST_CHECKED:BST_UNCHECKED);
        CheckDlgButton(dialog,UI_LOCAL,local_account?BST_CHECKED:BST_UNCHECKED);
        CheckDlgButton(dialog,UI_DATA,redirect_appdata?BST_CHECKED:BST_UNCHECKED);
        CheckDlgButton(dialog,UI_REGISTRY,redirect_registry?BST_CHECKED:BST_UNCHECKED);
        CheckDlgButton(dialog,UI_FADE,camera_fade?BST_CHECKED:BST_UNCHECKED);
        CheckDlgButton(dialog,UI_TCP,tcp_only?BST_CHECKED:BST_UNCHECKED);
        SetDlgItemTextW(dialog,UI_URL,api_url); SetDlgItemTextW(dialog,UI_ACCOUNT,selected_open_id);
        SendDlgItemMessageW(dialog,UI_URL,EM_SETLIMITTEXT,1023,0);
        SendDlgItemMessageW(dialog,UI_ACCOUNT,EM_SETLIMITTEXT,128,0);
        SendDlgItemMessageW(dialog,UI_URL,EM_SETCUEBANNER,0,(LPARAM)L"http://127.0.0.1:20001");
        SendDlgItemMessageW(dialog,UI_ACCOUNT,EM_SETCUEBANNER,0,(LPARAM)L"输入本地账号 open_id");
        SendMessageW(dialog,WM_SETICON,ICON_BIG,(LPARAM)LoadImageW(GetModuleHandleW(NULL),MAKEINTRESOURCEW(1),IMAGE_ICON,0,0,LR_DEFAULTSIZE|LR_SHARED));
        SendMessageW(dialog,WM_SETICON,ICON_SMALL,(LPARAM)LoadImageW(GetModuleHandleW(NULL),MAKEINTRESOURCEW(1),IMAGE_ICON,GetSystemMetrics(SM_CXSMICON),GetSystemMetrics(SM_CYSMICON),LR_SHARED));
        ui_layout(dialog,ui); ui_enable_fields(dialog); ShowWindow(GetDlgItem(dialog,UI_TCP),SW_HIDE);
        SendMessageW(dialog,DM_SETDEFID,IDOK,0); SetFocus(GetDlgItem(dialog,UI_URL));
#ifdef SHELL_SELF_TEST
        if (account_dialog_smoke) { SetDlgItemTextW(dialog,UI_ACCOUNT,L"ui-smoke-account"); SetTimer(dialog,1,250,NULL); }
#endif
        return FALSE;
    }
    if (!ui) return FALSE;
    if (message==WM_ERASEBKGND) return TRUE;
    if (message==WM_PAINT) { ui_paint(dialog,ui); return TRUE; }
    if (message==WM_DPICHANGED) { ui_layout(dialog,ui); return TRUE; }
    if (message==WM_CTLCOLORSTATIC || message==WM_CTLCOLORBTN || message==WM_CTLCOLOREDIT) {
        HDC dc=(HDC)wparam; int enabled=IsWindowEnabled((HWND)lparam);
        SetTextColor(dc,enabled?RGB(54,75,94):RGB(140,151,164)); SetBkColor(dc,enabled?RGB(255,255,255):RGB(242,245,248));
        return (INT_PTR)(enabled?ui->white:ui->disabled);
    }
    if (message==WM_DRAWITEM) {
        DRAWITEMSTRUCT *item=(DRAWITEMSTRUCT *)lparam; RECT r=item->rcItem; HDC dc=item->hDC;
        HBRUSH brush; HPEN pen; HGDIOBJ old_brush,old_pen,old_font; int primary=item->CtlID==IDOK;
        COLORREF fill=primary?RGB(52,126,155):RGB(249,252,254),border=primary?RGB(52,126,155):RGB(187,207,221);
        if (item->CtlID==UI_ADVANCED) {
            FillRect(dc,&r,ui->white); old_font=SelectObject(dc,ui->fonts[2]); SetBkMode(dc,TRANSPARENT); SetTextColor(dc,RGB(38,62,82));
            DrawTextW(dc,L"高级设置",-1,&r,DT_LEFT|DT_VCENTER|DT_SINGLELINE);
            SelectObject(dc,ui->fonts[1]); SetTextColor(dc,RGB(112,131,148));
            DrawTextW(dc,ui->expanded?L"▾":L"▸",-1,&r,DT_RIGHT|DT_VCENTER|DT_SINGLELINE);
            SelectObject(dc,old_font); return TRUE;
        }
        FillRect(dc,&r,ui->footer);
        if (item->itemState&ODS_SELECTED) fill=primary?RGB(40,106,133):RGB(231,240,246);
        brush=CreateSolidBrush(fill); pen=CreatePen(PS_SOLID,1,border);
        old_brush=SelectObject(dc,brush); old_pen=SelectObject(dc,pen);
        RoundRect(dc,r.left,r.top,r.right,r.bottom,ui_px(ui,10),ui_px(ui,10));
        old_font=SelectObject(dc,ui->fonts[0]); SetBkMode(dc,TRANSPARENT); SetTextColor(dc,primary?RGB(255,255,255):RGB(65,91,112));
        DrawTextW(dc,primary?L"启动游戏":L"取消",-1,&r,DT_CENTER|DT_VCENTER|DT_SINGLELINE);
        if (item->itemState&ODS_FOCUS) { InflateRect(&r,-4,-4); DrawFocusRect(dc,&r); }
        SelectObject(dc,old_font); SelectObject(dc,old_pen); SelectObject(dc,old_brush); DeleteObject(pen); DeleteObject(brush); return TRUE;
    }
#ifdef SHELL_SELF_TEST
    if (message==WM_TIMER && account_dialog_smoke) {
        static const int switches[]={UI_API,UI_LOCAL,UI_DATA,UI_REGISTRY,UI_FADE,UI_TCP}; size_t i; RECT a,b,c;
        KillTimer(dialog,1); SetActiveWindow(dialog);
        GetWindowRect(GetDlgItem(dialog,UI_API),&a); GetWindowRect(GetDlgItem(dialog,UI_LOCAL),&b); GetWindowRect(GetDlgItem(dialog,UI_FADE),&c);
        if (a.left!=b.left || b.left!=c.left) { EndDialog(dialog,-1); return TRUE; }
        SendDlgItemMessageW(dialog,UI_ADVANCED,BM_CLICK,0,0);
        if (!IsWindowVisible(GetDlgItem(dialog,UI_TCP))) { EndDialog(dialog,-1); return TRUE; }
        for (i=0;i<sizeof(switches)/sizeof(switches[0]);++i) SendDlgItemMessageW(dialog,switches[i],BM_CLICK,0,0);
        if (IsWindowEnabled(GetDlgItem(dialog,UI_URL)) || IsWindowEnabled(GetDlgItem(dialog,UI_ACCOUNT))) { EndDialog(dialog,-1); return TRUE; }
        SendMessageW(dialog,WM_COMMAND,IDOK,0); return TRUE;
    }
#endif
    if (message==WM_COMMAND) {
        int id=LOWORD(wparam);
        if (id==UI_API || id==UI_LOCAL) { ui_enable_fields(dialog); return TRUE; }
        if (id==UI_ADVANCED) {
            ui->expanded=!ui->expanded; ShowWindow(GetDlgItem(dialog,UI_TCP),ui->expanded?SW_SHOW:SW_HIDE);
            InvalidateRect(dialog,NULL,FALSE); return TRUE;
        }
        if (id==IDOK) {
            redirect_api=ui_checked(dialog,UI_API); local_account=ui_checked(dialog,UI_LOCAL);
            redirect_appdata=ui_checked(dialog,UI_DATA); redirect_registry=ui_checked(dialog,UI_REGISTRY);
            camera_fade=ui_checked(dialog,UI_FADE); tcp_only=ui_checked(dialog,UI_TCP);
            GetDlgItemTextW(dialog,UI_URL,api_url,1024); GetDlgItemTextW(dialog,UI_ACCOUNT,selected_open_id,129);
            if (redirect_api && !normalize_api_url()) {
                MessageBoxW(dialog,L"请输入有效的 HTTP 或 HTTPS 地址，地址中不能包含空白。",L"服务器地址",MB_OK|MB_ICONINFORMATION);
                SetFocus(GetDlgItem(dialog,UI_URL)); return TRUE;
            }
            if (local_account && !valid_open_id(selected_open_id)) {
                MessageBoxW(dialog,L"请输入本地账号：1～128 个 UTF-8 字节，首尾不要空白。",L"本地账号",MB_OK|MB_ICONINFORMATION);
                SetFocus(GetDlgItem(dialog,UI_ACCOUNT)); return TRUE;
            }
            if (!save_config(ui->config)) { MessageBoxW(dialog,L"无法保存设置，请检查 INI 所在目录的写入权限。",L"保存失败",MB_OK|MB_ICONERROR); return TRUE; }
            EndDialog(dialog,IDOK); return TRUE;
        }
        if (id==IDCANCEL) { EndDialog(dialog,IDCANCEL); return TRUE; }
    }
    if (message==WM_CLOSE) { EndDialog(dialog,IDCANCEL); return TRUE; }
    return FALSE;
}
static int show_settings_dialog(HINSTANCE instance,const wchar_t *config) {
    union { DWORD align; BYTE bytes[256]; } buffer; DLGTEMPLATE *layout=(DLGTEMPLATE *)buffer.bytes; WORD *tail;
    const wchar_t title[]=L"LurukaPS"; LauncherDialog ui={0}; INT_PTR result; size_t i;
    INITCOMMONCONTROLSEX controls={sizeof(controls),ICC_STANDARD_CLASSES}; InitCommonControlsEx(&controls);
    memset(&buffer,0,sizeof(buffer)); ui.config=config;
    layout->style=WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_CLIPCHILDREN|DS_MODALFRAME|DS_CENTER;
    layout->cx=480; layout->cy=420; tail=(WORD *)(buffer.bytes+sizeof(DLGTEMPLATE));
    *tail++=0; *tail++=0; memcpy(tail,title,sizeof(title));
    result=DialogBoxIndirectParamW(instance,layout,NULL,launcher_dialog_proc,(LPARAM)&ui);
    for (i=0;i<4;++i) if (ui.fonts[i]) DeleteObject(ui.fonts[i]);
    if (ui.banner) DeleteObject(ui.banner);
    if (ui.white) DeleteObject(ui.white);
    if (ui.disabled) DeleteObject(ui.disabled);
    if (ui.footer) DeleteObject(ui.footer);
    return result==IDOK?1:result==IDCANCEL?0:-1;
}
