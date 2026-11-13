; installer.nsh — 自定义 NSIS 行为
;
; 背景：electron-builder 默认的卸载逻辑是「把 $INSTDIR 整个搬到 $PLUGINSDIR\old-install 再删掉」。
; 覆盖安装（update）时同样会走这段，于是装在安装目录里的 DeskDockData 会被一起删除。
; 这里接管"删除文件"这一步，保证用户数据永远不会在升级/卸载时被抹掉。

; ---------------------------------------------------------------------------
; 接管"安装前检查进程" —— 同时干掉覆盖安装的真正卡点
; ---------------------------------------------------------------------------
; 卡点不在进程，而在 electron-builder 的 uninstallOldVersion()（include/installUtil.nsh）：
; 它会去跑**旧版本的卸载器**，并以退出码判断成败：
;
;   UninstallLoop:
;     IntOp $R5 $R5 + 1
;     ${if} $R5 > 5
;       MessageBox ... "$(appCannotBeClosed)"   ; 就是那句"无法关闭"
;       Return
;     ${endIf}
;     ExecWait '"$uninstallerFileNameTemp" /S ...' $R0
;     ${if} $R0 == 0
;       Return
;     ${endIf}
;     Goto UninstallLoop
;
; 旧卸载器（几个月前编译的二进制）只要返回非 0，安装器就重试 5 次然后弹「DeskDock 无法关闭」。
; 注意它和"进程没关掉"用的是同一条文案，极具误导性 —— 用户去任务管理器里当然找不到任何进程。
;
; 绕过办法：uninstallOldVersion 一进来就 readReg UninstallString，读不到直接 return。
; 所以这里把旧版写的那条卸载注册项抹掉，"先卸载旧版本"整段就被跳过了，
; 安装行为退化成用户想要的"文件已存在就直接覆盖"。
;
; 三个 key 都删：HKLM / HKCU、外加 WOW6432Node；GUID 写死是因为
; UNINSTALL_REGISTRY_KEY 只在 multiUser.nsh 里定义，perMachine=false 时可能不存在。
; ---------------------------------------------------------------------------
; customInit —— 真正能删 HKLM 的位置
; ---------------------------------------------------------------------------
; 把 DeleteRegKey 只放在 customCheckAppRunning 里是错的：
; installer.nsi 的 Section "install" 中，CHECK_APP_RUNNING 被包在
;   ${ifNot} ${UAC_IsInnerInstance}
; 里面，只有**外层**实例才执行它。而"为所有人安装"的真正安装动作发生在
; UAC 提权后的**内层**实例里，内层会跳过 CHECK_APP_RUNNING；
; 外层又因为不是管理员，DeleteRegKey HKLM 静默失败。
;
; .onInit 的执行顺序是：
;   check64BitAndSetRegView → initMultiUser → customInit → (页面) → Section install
; 内层实例会从 .onInit 重新跑一遍，所以 customInit 在提权实例里一定执行，
; 且早于 installSection.nsh 里的 uninstallOldVersion。
!macro customInit
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" >nul 2>&1`
  Pop $0
  Sleep 300

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\3fca447a-cf0c-59c5-83c4-c43b80c986ed"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\3fca447a-cf0c-59c5-83c4-c43b80c986ed"
  !ifdef UNINSTALL_REGISTRY_KEY
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  !endif
!macroend

!macro customCheckAppRunning
  ; 1) 先强杀还在跑的实例（Electron 是多进程：主进程 / gpu / renderer / utility）
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" >nul 2>&1`
  Pop $0
  Sleep 500

  ; 2) 抹掉旧版本的卸载入口 → uninstallOldVersion 读不到 UninstallString 会直接 return
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\3fca447a-cf0c-59c5-83c4-c43b80c986ed"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\3fca447a-cf0c-59c5-83c4-c43b80c986ed"
  DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\3fca447a-cf0c-59c5-83c4-c43b80c986ed"
  DeleteRegKey HKCU "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\3fca447a-cf0c-59c5-83c4-c43b80c986ed"

  ; 3) 如果宏存在再用宏补一刀（等价路径，重复删除无害）
  !ifdef UNINSTALL_REGISTRY_KEY
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  !endif
!macroend

!macro customRemoveFiles
  StrCpy $R8 0

  ; 1) 先把安装目录里的数据临时搬到 $PLUGINSDIR（如果存在）
  ${If} ${FileExists} "$INSTDIR\DeskDockData\*.*"
    StrCpy $R8 1
    CreateDirectory "$PLUGINSDIR\dd-keep"
    nsExec::ExecToLog '"$SYSDIR\cmd.exe" /C xcopy /E /I /Q /H /Y "$INSTDIR\DeskDockData" "$PLUGINSDIR\dd-keep\DeskDockData" >nul'
    Pop $0
  ${EndIf}

  ; 2) 按原来的方式删除程序文件
  ${if} ${isUpdated}
    Push ""
    Call un.atomicRMDir
    Pop $R0
    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"
      Push ""
      Call un.restoreFiles
      Pop $R0
      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}
  ${else}
    RMDir /r $INSTDIR
  ${EndIf}

  ; 3) 数据放回去
  ${If} $R8 == 1
    ${if} ${isUpdated}
      ; 覆盖安装：放回安装目录，新的程序启动后会自己迁移到用户目录
      CreateDirectory "$INSTDIR\DeskDockData"
      nsExec::ExecToLog '"$SYSDIR\cmd.exe" /C xcopy /E /I /Q /H /Y "$PLUGINSDIR\dd-keep\DeskDockData" "$INSTDIR\DeskDockData" >nul'
      Pop $0
    ${else}
      ; 彻底卸载：只在用户目录还没有数据时才搬过去，绝不覆盖更新的数据
      ${IfNot} ${FileExists} "$APPDATA\DeskDock\DeskDockData\config.json"
        CreateDirectory "$APPDATA\DeskDock\DeskDockData"
        nsExec::ExecToLog '"$SYSDIR\cmd.exe" /C xcopy /E /I /Q /H /Y "$PLUGINSDIR\dd-keep\DeskDockData" "$APPDATA\DeskDock\DeskDockData" >nul'
        Pop $0
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
