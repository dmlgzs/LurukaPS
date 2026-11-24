/* Read Unity's local names array; no inferred or hardcoded assembly filenames. */
static const char *json_space(const char *text) {
    while (*text==' ' || *text=='\t' || *text=='\r' || *text=='\n') ++text;
    return text;
}
static int json_string(const char **cursor,char *output,size_t capacity) {
    const char *text=json_space(*cursor); size_t length=0;
    if (*text++!='"') return 0;
    while (*text && *text!='"') {
        unsigned char value=(unsigned char)*text++;
        if (value=='\\') {
            value=(unsigned char)*text++;
            if (value=='u') {
                unsigned decoded=0; int i;
                for (i=0;i<4;++i) {
                    unsigned char digit=(unsigned char)*text++; unsigned number;
                    if (digit>='0' && digit<='9') number=digit-'0';
                    else if (digit>='a' && digit<='f') number=digit-'a'+10;
                    else if (digit>='A' && digit<='F') number=digit-'A'+10;
                    else return 0;
                    decoded=decoded*16+number;
                }
                if (!decoded || decoded>127) return 0;
                value=(unsigned char)decoded;
            } else if (value!='"' && value!='\\' && value!='/') return 0;
        }
        if (value<32 || !value || length+1>=capacity) return 0;
        output[length++]=(char)value;
    }
    if (*text!='"') return 0;
    output[length]=0; *cursor=text+1; return 1;
}
static int parse_assembly_manifest(const char *text) {
    char key[64]; size_t count=0;
    manifest_assembly_count=0;
    text=json_space(text);
    if (*text++!='{') return 0;
    /* Unity writes names first. Reject unsupported format instead of matching
     * a quoted substring inside another JSON value. */
    if (!json_string(&text,key,sizeof(key)) || strcmp(key,"names")) return 0;
    text=json_space(text); if (*text++!=':') return 0;
    text=json_space(text); if (*text++!='[') return 0;
    text=json_space(text);
    while (*text!=']') {
        size_t i,length;
        if (count>=1024 || !json_string(&text,manifest_assemblies[count],260)) return 0;
        length=strlen(manifest_assemblies[count]);
        if (length<5 || strcmp(manifest_assemblies[count]+length-4,".dll")) return 0;
        for (i=0;i<length;++i) if (manifest_assemblies[count][i]=='/' || manifest_assemblies[count][i]=='\\' ||
            manifest_assemblies[count][i]==':' || manifest_assemblies[count][i]=='"') return 0;
        ++count; text=json_space(text);
        if (*text==']') break;
        if (*text++!=',') return 0;
        text=json_space(text); if (*text==']') return 0;
    }
    if (!count) return 0;
    manifest_assembly_count=count; return 1;
}
static int read_assembly_manifest(const wchar_t *path) {
    HANDLE file=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    LARGE_INTEGER size; char *text=NULL; DWORD read; int ok=0;
    if (file==INVALID_HANDLE_VALUE) return 0;
    if (!GetFileSizeEx(file,&size) || size.QuadPart<2 || size.QuadPart>1048576) goto done;
    text=calloc((size_t)size.QuadPart+8,1);
    if (!text || !ReadFile(file,text,(DWORD)size.QuadPart,&read,NULL) || read!=(DWORD)size.QuadPart) goto done;
    ok=parse_assembly_manifest(text);
done:
    free(text); CloseHandle(file);
    if (ok) log_line("Client scripting assembly names loaded: %llu",(unsigned long long)manifest_assembly_count);
    return ok;
}
