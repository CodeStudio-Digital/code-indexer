; electron-builder preserves shortcuts on upgrades. Repair their destinations
; explicitly: a per-user Start Menu link can shadow the all-users link, and
; pinned links can still point at a previous unpacked build.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "Win\COM.nsh"
!define CODESTUDIO_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"

!ifndef BUILD_UNINSTALLER

!macro CodeStudioRepairShortcutLocations programs desktop pinned implicit
  Push "${programs}"
  Call CodeStudioRepairShortcutDirectory
  Push "${programs}\${SHORTCUT_NAME}"
  Call CodeStudioRepairShortcutDirectory
  Push "${desktop}"
  Call CodeStudioRepairShortcutDirectory
  !if "${pinned}" != ""
    Push "${pinned}"
    Call CodeStudioRepairShortcutDirectory
  !endif
  !if "${implicit}" != ""
    Push "${implicit}"
    Call CodeStudioRepairImplicitShortcuts
  !endif
!macroend

; electron-builder can register plugin paths AFTER reading this include.
; Emit functions only at customHeader, once WinShell and UAC are available.
!macro customHeader

; Update an existing Shell Link in place so arguments, hotkeys, descriptions
; and custom project working directories survive. Never resolve/launch it.
; Input: shortcut path on the stack. All registers are preserved.
Function CodeStudioRepairShortcut
  System::Store S
  Pop $9
  StrCpy $0 0
  StrCpy $1 0
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1).r2'
    ${If} $2 = 0
    ${AndIf} $1 P<> 0
      ${IPersistFile::Load} $1 '("$9",0).r2'
      ${If} $2 = 0
        ${IShellLink::GetPath} $0 '(.r3,${NSIS_MAX_STRLEN},0,4).r2'
        ${If} $2 = 0
          ${GetFileName} "$3" $4
          ; Checking the destination also protects unrelated .lnk files with
          ; a CodeStudio label. Broken links to old builds are repairable.
          ${If} $4 == "${CODESTUDIO_EXECUTABLE_FILENAME}"
          ${If} $3 != "$INSTDIR\${CODESTUDIO_EXECUTABLE_FILENAME}"
            ${GetParent} "$3" $4
            ${IShellLink::GetWorkingDirectory} $0 '(.r5,${NSIS_MAX_STRLEN}).r2'
            ${If} $2 = 0
              ${If} $5 == ""
              ${OrIf} $5 == $4
                ${IShellLink::SetWorkingDirectory} $0 '("$INSTDIR").r2'
              ${EndIf}
            ${EndIf}
            ${IShellLink::GetIconLocation} $0 '(.r5,${NSIS_MAX_STRLEN},.r6).r2'
            ${If} $2 = 0
              ${If} $5 == ""
              ${OrIf} $5 == $3
                ${IShellLink::SetIconLocation} $0 '("$INSTDIR\${CODESTUDIO_EXECUTABLE_FILENAME}",0).r2'
              ${EndIf}
            ${EndIf}
            ${IShellLink::SetPath} $0 '("$INSTDIR\${CODESTUDIO_EXECUTABLE_FILENAME}").r2'
            ${If} $2 = 0
              ${IPersistFile::Save} $1 '("$9",1).r2'
              ${If} $2 = 0
                WinShell::SetLnkAUMI "$9" "${APP_ID}"
                System::Call 'Shell32::SHChangeNotify(i 0x2000, i 5, w r9, p 0)'
                DetailPrint "Updated CodeStudio shortcut: $9"
              ${Else}
                DetailPrint "Could not update CodeStudio shortcut: $9 (HRESULT $2)"
              ${EndIf}
            ${EndIf}
          ${Else}
            ; Same-path upgrades can still carry the old runtime identity.
            WinShell::SetLnkAUMI "$9" "${APP_ID}"
          ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
  System::Store L
FunctionEnd

; Only inspect launch locations, without walking other user profiles or the
; filesystem. Non-CodeStudio destinations and intentionally deleted links stay
; untouched. This also handles renamed/pinned CodeStudio shortcuts.
Function CodeStudioRepairShortcutDirectory
  System::Store S
  Pop $7
  FindFirst $8 $9 "$7\*.lnk"
  ${DoWhile} $9 != ""
    Push "$7\$9"
    Call CodeStudioRepairShortcut
    FindNext $8 $9
  ${Loop}
  FindClose $8
  System::Store L
FunctionEnd

; Windows may store a pin made from a running app in a per-app child folder
; instead of User Pinned\TaskBar. Inspect just that one level, not other data.
Function CodeStudioRepairImplicitShortcuts
  System::Store S
  Pop $7
  FindFirst $8 $9 "$7\*"
  ${DoWhile} $9 != ""
    ${If} $9 != "."
    ${AndIf} $9 != ".."
      Push "$7\$9"
      Call CodeStudioRepairShortcutDirectory
    ${EndIf}
    FindNext $8 $9
  ${Loop}
  FindClose $8
  System::Store L
FunctionEnd

Function CodeStudioRepairUserShortcuts
  SetShellVarContext current
  !insertmacro CodeStudioRepairShortcutLocations "$SMPROGRAMS" "$DESKTOP" "$QUICKLAUNCH\User Pinned\TaskBar" "$QUICKLAUNCH\ImplicitAppShortcuts"
FunctionEnd

!macroend

!macro customInstall
  ; The app has been extracted before this hook. Avoid changing a link if
  ; packaging/installing the executable did not succeed.
  ${If} ${FileExists} "$INSTDIR\${CODESTUDIO_EXECUTABLE_FILENAME}"
    ${If} $installMode == "all"
      SetShellVarContext all
      !insertmacro CodeStudioRepairShortcutLocations "$SMPROGRAMS" "$DESKTOP" "" ""
    ${EndIf}

    ; With over-the-shoulder UAC credentials, "current" in the elevated
    ; process is the admin account. Repair the initiating user's links in
    ; electron-builder's existing outer process, using the chosen INSTDIR.
    ${If} ${UAC_IsInnerInstance}
      !insertmacro UAC_AsUser_Call Function CodeStudioRepairUserShortcuts ${UAC_SYNCINSTDIR}
    ${Else}
      Call CodeStudioRepairUserShortcuts
    ${EndIf}
    ${If} $installMode == "all"
      SetShellVarContext all
    ${Else}
      SetShellVarContext current
    ${EndIf}
  ${EndIf}
!macroend

!endif
