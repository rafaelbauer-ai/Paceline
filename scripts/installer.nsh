# Hooks for the standard electron-builder assisted installer.
# Keep this file declarative: no credentials, remote scripts or machine-wide writes.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    SetRegView 64
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $0 == ""
      IfFileExists "D:\projetos\*.*" 0 pacelineDefaultDone
        WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "D:\projetos\Paceline-Desktop"
      pacelineDefaultDone:
    ${EndIf}
  !endif
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" pacelineRestoreStart 0
      Abort "The application executable is missing. Restore the Claude integration manually before removing this installation."
    pacelineRestoreStart:
      DetailPrint "Restoring the previous Claude Code status line..."
      ClearErrors
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-integration --data-dir "$INSTDIR\paceline-data"' $0
      ${If} ${Errors}
        Abort "The integration cleanup process could not start. Your application and data were preserved."
      ${EndIf}
      ${If} $0 != 0
        MessageBox MB_ICONSTOP|MB_OK "The Claude integration could not be restored. Your data and application were preserved. Close Paceline and resolve its integration settings before uninstalling."
        Abort "Claude integration cleanup failed."
      ${EndIf}
  ${EndIf}
!macroend

!macro customRemoveFiles
  # The stock NSIS uninstaller removes the entire install directory. App data is
  # intentionally adjacent to the EXE, so remove only known distribution files.
  # The NSIS framework has already resolved INSTDIR from this app's registration.
  ${If} $INSTDIR == ""
    Abort "Missing application installation directory."
  ${EndIf}
  IfFileExists "$INSTDIR\resources\app.asar" pacelineOwnedFiles 0
    Abort "The expected application package is missing. No directories were removed."
  pacelineOwnedFiles:
  SetOutPath $TEMP
  ClearErrors
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${If} ${Errors}
    Abort "The application is still running or its executable cannot be removed. Close it and retry."
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"
  Delete "$INSTDIR\electron_wer.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vulkan-1.dll"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  # No /r here: user data and the storage-location marker must survive.
  RMDir "$INSTDIR"
!macroend
