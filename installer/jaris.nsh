; Étape 153 — ajouts de Jaris à l'installeur d'electron-builder (nsis.include, electron-builder.yml).
;
; Léo : « Échec de désinstallation des anciens fichiers d'application… : 2 ». Pendant une mise à jour, l'ancien
; désinstalleur déplace chaque fichier du dossier du programme et abandonne (code 2) au premier fichier encore
; occupé. Deux choses lancées par Jaris pouvaient survivre à sa fermeture :
;   - le conteneur SearXNG (recherche web), créé par les anciennes versions DEPUIS le dossier du programme,
;     dont il montait un sous-dossier, et relancé par Docker en permanence ;
;   - les deux programmes Python de la voix, jamais arrêtés quand Jaris quittait par app.quit().
; Jaris les arrête lui-même désormais (searxngHome.ts, main.ts), mais c'est l'installeur de la NOUVELLE version
; qui doit débloquer la mise à jour depuis une ancienne : d'où ce nettoyage, AVANT que l'ancien désinstalleur
; ne tourne. Commandes en clair, sans droits administrateur, et rien qui ne soit à Jaris :
;   - seuls les conteneurs du service `searxng` de l'ancien projet Compose de Jaris (`resources`) sont
;     retirés — Jaris recrée le sien au prochain démarrage, dans son dossier de données ;
;   - seuls les Python qui exécutent voice_server.py ou tts_server.py sont arrêtés, et seulement si Jaris
;     lui-même ne tourne plus (ils seraient alors orphelins).
; Docker absent, arrêté ou PowerShell indisponible : les commandes échouent sans rien bloquer.

!macro customInit
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "docker ps -aq --filter label=com.docker.compose.project=resources --filter label=com.docker.compose.service=searxng | ForEach-Object { docker rm -f $$_ }"`
  Pop $0
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (-not (Get-Process -Name Jaris -ErrorAction SilentlyContinue)) { Get-CimInstance Win32_Process | Where-Object { $$_.Name -match '^pythonw?\.exe$$' -and $$_.CommandLine -match '(voice|tts)_server\.py' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"`
  Pop $0
!macroend

; Étape 154, Léo (capture de Paramètres → Applications, filtre « C: ») : Jaris y apparaissait sur C alors
; qu'il est installé sur D. electron-builder n'écrit le dossier d'installation (InstallLocation) que dans sa
; propre clé de registre, jamais dans la clé « Uninstall » que Windows lit pour ranger les applications par
; disque : sans elle, Windows les range d'office sur le disque système. Seul l'affichage était faux (les
; 355 Mo indiqués sont la taille du programme, qui est bien sur D). Écrite après registryAddInstallInfo ;
; la clé entière est supprimée à la désinstallation, rien à nettoyer.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
!macroend
