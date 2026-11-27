param([string]$Compiler = 'gcc', [switch]$Debug, [string]$ResourceCompiler = 'windres', [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$outputDirectory = Join-Path $PSScriptRoot 'build'
$outputName = if ($SelfTest) { 'LurukaPS-selftest.exe' } else { 'LurukaPS.exe' }
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$watermarkSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'watermark.lua'), [Text.Encoding]::UTF8)
$watermarkWords = foreach ($character in $watermarkSource.ToCharArray()) { '0x{0:x4}' -f [int]$character }
$watermarkHeader = 'static const uint16_t watermark_script[] = {' + ($watermarkWords -join ',') + ',0};'
[IO.File]::WriteAllText((Join-Path $outputDirectory 'watermark_script.h'), $watermarkHeader, [Text.Encoding]::ASCII)
# Embed the application icon and original Unity host's DPI policy.
$manifestObject = Join-Path $outputDirectory 'shell.res.o'
& $ResourceCompiler '--include-dir' $PSScriptRoot '--input' (Join-Path $PSScriptRoot 'shell.rc') `
    '--output' $manifestObject '--output-format=coff' '--target=pe-x86-64'
if ($LASTEXITCODE -ne 0) { throw "Resource compiler failed with exit code $LASTEXITCODE" }
$compilerArgs = @('-std=c11', '-Wall', '-Wextra', '-Werror', '-municode', '-mwindows', '-static-libgcc',
    (Join-Path $PSScriptRoot 'shell.c'), $manifestObject, '-o', (Join-Path $outputDirectory $outputName),
    '-lshell32', '-luser32', '-lgdi32', '-lmsimg32', '-lcomctl32', '-luxtheme', '-lole32', '-lwindowscodecs', '-luuid')
if ($SelfTest) { $compilerArgs += @('-DSHELL_SELF_TEST', '-ladvapi32') }
if ($Debug) { $compilerArgs += @('-O0', '-g') } else { $compilerArgs += @('-O2', '-s') }
try {
    & $Compiler @compilerArgs
    if ($LASTEXITCODE -ne 0) { throw "C compiler failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $manifestObject -Force -ErrorAction SilentlyContinue
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LurukaPS-client.ini') -Destination $outputDirectory
Write-Output (Join-Path $outputDirectory $outputName)
