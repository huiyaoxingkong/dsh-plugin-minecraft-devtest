<#
.SYNOPSIS
    Builds the DSH Test Bridge Forge 1.20.1 mod jar without Gradle/MDK.

.DESCRIPTION
    Compiles the tiny Mixin-only mod against the jars of an existing, fully
    installed Forge 1.20.1 server (its "libraries" directory is used as the
    compile classpath) and packages:

        META-INF/MANIFEST.MF          (MixinConfigs: dsh-test-bridge.mixins.json)
        META-INF/mods.toml            (modLoader=javafml, modId=dsh_test_bridge)
        dsh-test-bridge.mixins.json
        dev/dsh/bridge/DshTestBridgeMod.class
        dev/dsh/bridge/mixin/NetworkRegistryMixin.class

    Output: <this script's folder>\dsh-test-bridge-0.1.0.jar

    Requirements: JDK 17 (javac + jar) and a Forge 1.20.1 server installation
    (only its libraries/ folder with the forge universal jar, mixin 0.8.5 and
    the Minecraft server jars are needed).

.PARAMETER ForgeServerDir
    A Forge 1.20.1 server directory containing "libraries" and "run.bat".
    Defaults to $env:DSH_FORGE_SERVER_DIR, then to the local installation
    D:\Minecraft\数据包\_mw_server\forge-1.20.1.

.PARAMETER JavaHome
    JDK 17 home. Defaults to $env:JAVA_HOME, then D:\Program Files\Java\jdk-17.

.PARAMETER ModVersion
    Mod/jar version string. Defaults to 0.1.0.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\build.ps1 `
        -ForgeServerDir 'D:\Minecraft\数据包\_mw_server\forge-1.20.1' `
        -JavaHome 'D:\Program Files\Java\jdk-17'
#>
[CmdletBinding()]
param(
    [string]$ForgeServerDir = $(if ($env:DSH_FORGE_SERVER_DIR) { $env:DSH_FORGE_SERVER_DIR } else { 'D:\Minecraft\数据包\_mw_server\forge-1.20.1' }),
    [string]$JavaHome       = $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'D:\Program Files\Java\jdk-17' }),
    [string]$ModVersion     = '0.1.0'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ModId   = 'dsh_test_bridge'
$VersionDir = $PSScriptRoot
$SrcDir  = Join-Path $VersionDir 'src\main'
$JarName = "dsh-test-bridge-$ModVersion.jar"
$OutJar  = Join-Path $VersionDir $JarName
$BuildDir = Join-Path $VersionDir 'build'
$ClassesDir = Join-Path $BuildDir 'classes'
$ManifestPath = Join-Path $BuildDir 'MANIFEST.MF'

function Write-Step([string]$Message) {
    Write-Host "[build] $Message" -ForegroundColor Cyan
}

# ---------------------------------------------------------------- preflight ---
Write-Step "Forge server dir : $ForgeServerDir"
if (-not (Test-Path -LiteralPath (Join-Path $ForgeServerDir 'libraries'))) {
    throw "Forge server 'libraries' directory not found under '$ForgeServerDir'. Pass -ForgeServerDir <forge-1.20.1 server dir> or set DSH_FORGE_SERVER_DIR."
}
$Javac = Join-Path $JavaHome 'bin\javac.exe'
$JarTool = Join-Path $JavaHome 'bin\jar.exe'
if (-not (Test-Path -LiteralPath $Javac)) {
    throw "javac not found at '$Javac'. Pass -JavaHome <JDK 17 home> or set JAVA_HOME."
}
if (-not (Test-Path -LiteralPath $JarTool)) {
    throw "jar tool not found at '$JarTool'."
}
$javacVersion = (& $Javac -version 2>&1 | Out-String).Trim()
Write-Step "javac           : $javacVersion"

# Forge 1.20.1 requires Java 17. Newer JDKs may not build/launch this shape.
if ($javacVersion -notmatch '^javac 17') {
    Write-Warning "Expected JDK 17 (Forge 1.20.1), got: $javacVersion"
}

# --------------------------------------------------------- compile classpath --
# The Forge installer's libraries tree contains everything needed to compile:
#   forge-1.20.1-47.4.28-universal.jar          -> net.minecraftforge.network.NetworkRegistry
#   javafmllanguage-1.20.1-47.4.28.jar          -> net.minecraftforge.fml.common.Mod
#   mixin-0.8.5.jar                             -> org.spongepowered.asm.mixin.*
#   server-1.20.1-20230612.114412-*.jar         -> Minecraft classes
#   + all other libraries. Joining every jar is the simplest reliable classpath.
$libJars = @(Get-ChildItem -LiteralPath (Join-Path $ForgeServerDir 'libraries') -Recurse -Filter '*.jar' -File |
        Sort-Object FullName)
if ($libJars.Count -eq 0) {
    throw "No jars found under '$ForgeServerDir\libraries'."
}
$classPath = ($libJars | ForEach-Object { $_.FullName }) -join ';'
Write-Step "classpath jars  : $($libJars.Count)"

# ------------------------------------------------------------------- compile --
if (Test-Path -LiteralPath $BuildDir) { Remove-Item -LiteralPath $BuildDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ClassesDir | Out-Null

$sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $SrcDir 'java') -Recurse -Filter '*.java' -File | Sort-Object FullName)
if ($sourceFiles.Count -eq 0) { throw "No .java sources found under '$SrcDir\java'." }
Write-Step "sources         : $($sourceFiles.Count)"

$javacArgs = @('--release', '17', '-encoding', 'UTF-8', '-cp', $classPath, '-d', $ClassesDir) + ($sourceFiles | ForEach-Object { $_.FullName })
Write-Step "javac: $(($sourceFiles | ForEach-Object { $_.Name }) -join ', ')"
& $Javac @javacArgs
if ($LASTEXITCODE -ne 0) { throw "javac failed with exit code $LASTEXITCODE" }

# Copy resources (mods.toml, mixin config, ...) next to the compiled classes.
$resourcesDir = Join-Path $SrcDir 'resources'
if (Test-Path -LiteralPath $resourcesDir) {
    Copy-Item -Path (Join-Path $resourcesDir '*') -Destination $ClassesDir -Recurse -Force
    Write-Step "resources       : copied from $resourcesDir"
}

# ------------------------------------------------------------------ manifest --
# Mixin config discovery in Forge/ModLauncher is done through this manifest
# attribute, so it must be present and correctly spelled.
# Manifest lines are CRLF-terminated and the file ends with a blank line.
$manifestText = @(
    'Manifest-Version: 1.0'
    'Implementation-Title: DSH Test Bridge'
    "Implementation-Version: $ModVersion"
    'Specification-Title: DSH Test Bridge'
    'Specification-Version: 1.0'
    'MixinConfigs: dsh-test-bridge.mixins.json'
) -join "`r`n"
$manifestText += "`r`n`r`n"
[System.IO.File]::WriteAllText($ManifestPath, $manifestText, [System.Text.Encoding]::ASCII)
Write-Step "manifest        : MixinConfigs=dsh-test-bridge.mixins.json"

# -------------------------------------------------------------------- package --
if (Test-Path -LiteralPath $OutJar) { Remove-Item -LiteralPath $OutJar -Force }
& $JarTool cfm $OutJar $ManifestPath -C $ClassesDir .
if ($LASTEXITCODE -ne 0) { throw "jar packaging failed with exit code $LASTEXITCODE" }

# --------------------------------------------------------------- verification --
$expectedEntries = @(
    'META-INF/MANIFEST.MF'
    'META-INF/mods.toml'
    'dsh-test-bridge.mixins.json'
    'dev/dsh/bridge/DshTestBridgeMod.class'
    'dev/dsh/bridge/mixin/NetworkRegistryMixin.class'
)
$entries = @(& $JarTool tf $OutJar)
$missing = @($expectedEntries | Where-Object { $entries -notcontains $_ })
if ($missing.Count -gt 0) {
    throw "Jar is missing expected entries: $($missing -join ', ')"
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($OutJar)
try {
    $manifestEntry = $zip.GetEntry('META-INF/MANIFEST.MF')
    if ($null -eq $manifestEntry) { throw "Packaged jar has no META-INF/MANIFEST.MF." }
    $reader = New-Object System.IO.StreamReader($manifestEntry.Open())
    try { $packedManifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if ($packedManifest -notmatch 'MixinConfigs:\s*dsh-test-bridge\.mixins\.json') {
        throw "Packaged MANIFEST.MF does not contain the MixinConfigs attribute."
    }
} finally {
    $zip.Dispose()
}

$sizeKb = [math]::Round((Get-Item -LiteralPath $OutJar).Length / 1KB, 1)
Write-Step "OK              : $OutJar ($sizeKb KB)"
Write-Host ''
Write-Host "Jar built successfully." -ForegroundColor Green
Write-Host "  jar      : $OutJar"
Write-Host "  modId    : $ModId  version: $ModVersion"
Write-Host "  install  : copy the jar into <forge-server>/mods/ and restart the server."
Write-Host "  test     : see README.md (vanilla Mineflayer bot can join once this mod is loaded)."

# Leave the tree clean (only the jar plus sources); keep make clean reproducible.
Remove-Item -LiteralPath $BuildDir -Recurse -Force -ErrorAction SilentlyContinue
