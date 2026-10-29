@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo  === Instalando el oido de Capri ===
echo.

rem 1. Python
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && python -c "import sys" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo  No tienes Python. Lo instalo con winget...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  echo.
  echo  Python instalado. CIERRA esta ventana y vuelve a ejecutar instalar-voz.bat
  pause
  exit /b
)
echo  [1/4] Python encontrado: %PY%

rem 2. Librerias
echo  [2/4] Instalando vosk y sounddevice...
%PY% -m pip install --user --upgrade vosk sounddevice
if errorlevel 1 (
  echo  ERROR instalando las librerias.
  pause
  exit /b 1
)

rem 3. Modelo de voz en espanol (~40 MB)
if exist "model\am" (
  echo  [3/4] El modelo de voz ya esta descargado.
) else (
  echo  [3/4] Descargando el modelo de voz en espanol...
  powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest 'https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip' -OutFile 'model.zip'; Expand-Archive 'model.zip' -DestinationPath '.' -Force; Remove-Item 'model.zip'; if (Test-Path 'model') { Remove-Item 'model' -Recurse -Force }; Rename-Item 'vosk-model-small-es-0.42' 'model'"
  if not exist "model\am" (
    echo  ERROR descargando el modelo.
    pause
    exit /b 1
  )
)

rem 4. Whisper: entiende mucho mejor las ordenes (~480 MB la primera vez)
echo  [4/4] Instalando Whisper (puede tardar unos minutos)...
%PY% -m pip install --user --upgrade faster-whisper numpy
if errorlevel 1 (
  echo  AVISO: Whisper no se pudo instalar. Capri te escuchara solo con Vosk.
) else (
  %PY% -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8', download_root='whisper'); print('  Whisper listo')"
  if errorlevel 1 echo  AVISO: no se pudo descargar el modelo de Whisper. Capri usara solo Vosk.
)

echo.
echo  Listo. Ahora vamos a probarlo: di "Capri, abre el bloc de notas".
echo  Veras lo que entiende. Pulsa Ctrl+C para terminar la prueba.
echo.
%PY% capri_oido.py --debug
pause
