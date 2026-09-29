@echo off
REM ============================================================
REM  DeepChat 依赖安装脚本（VS 2026 / MSVC 14.44 x64 工具集）
REM
REM  背景：
REM   1) node-gyp 的 PowerShell 查找路径失效（VSSetup 模块未安装），
REM      所以改用 VCINSTALLDIR/VSCMD_VER/WindowsSDKVersion 环境变量，
REM      走 findVSFromSpecifiedLocation 分支，绕过 PowerShell 查询。
REM   2) 本机默认的 MSVC 14.51.36231 安装不完整（缺 bin/include，
REM      没有 cl.exe），完整的是 14.44.35207。因此强制指定 14.44。
REM   3) node-gyp 依据 VSCMD_VER 的 major 决定 PlatformToolset：
REM      18 -> v145(不完整) / 17 -> v143(对应 14.44，完整)。
REM      故将 VSCMD_VER 覆盖为 17.0.0.0 以匹配 14.44 编译器。
REM ============================================================

echo [1/5] 初始化 VS 2026 x64 编译环境（锁定 MSVC 14.44.35207）...
call "D:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64 -vcvars_ver=14.44.35207
if errorlevel 1 (
    echo [WARN] 带 -vcvars_ver 调用失败，回退为默认工具集...
    call "D:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
    if errorlevel 1 (
        echo [ERROR] vcvarsall.bat 执行失败，请检查 VS 2026 安装路径
        pause
        exit /b 1
    )
)

REM 让 node-gyp 识别为 VS2022 -> PlatformToolset v143，与 14.44 编译器匹配
set "VSCMD_VER=17.0.0.0"

REM 兜底变量（正常情况下 vcvarsall 已设置好）
if not defined VCINSTALLDIR set "VCINSTALLDIR=D:\Program Files\Microsoft Visual Studio\18\Community\VC"
if not defined WindowsSDKVersion set "WindowsSDKVersion=10.0.26100.0"

echo.
echo [2/5] 编译环境变量：
echo   VCINSTALLDIR      = %VCINSTALLDIR%
echo   VSCMD_VER         = %VSCMD_VER%   故意设为 17.x，对应 toolset v143
echo   VCToolsVersion    = %VCToolsVersion%
echo   WindowsSDKVersion = %WindowsSDKVersion%
echo.

echo [3/5] 校验编译器可用性...
where cl.exe
if errorlevel 1 (
    echo [ERROR] 找不到 cl.exe，MSVC 工具集不完整。
    echo         请用 Visual Studio Installer 修复"C++ 桌面开发"工作负载。
    pause
    exit /b 1
)
cl.exe 2>&1 | findstr /C:"Version" 
echo.

echo [4/5] 切换到项目目录...
cd /d "D:\sync-workspace\traework\tools-market-project\deepchat-project"

echo [5/5] 开始 pnpm install ...
echo.
call pnpm install

echo.
echo ============================================================
if errorlevel 1 (
    echo 安装失败。请把上面完整的报错内容发出来。
) else (
    echo 安装成功。
)
echo ============================================================
pause
