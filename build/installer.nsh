!macro customInstall
  SetOutPath "$INSTDIR"
!macroend

!macro customUnInstall
  ; Preserve user data under C:\SpeakEasy AI by default.
  ; This keeps KBD, JD, Resume, and Sessions intact after uninstall.
!macroend
