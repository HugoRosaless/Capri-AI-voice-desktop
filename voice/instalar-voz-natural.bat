@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo  === Voz natural de Capri + oido en la tarjeta grafica ===
echo  Descarga unos 5 GB la primera vez. Tarda un rato: deja la ventana abierta.
echo.

rem La voz natural necesita Python 3.12 (se instala junto al que tengas, sin tocarlo)
py -3.12 -c "import sys" >nul 2>nul
if errorlevel 1 (
  echo  Instalando Python 3.12...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  py -3.12 -c "import sys" >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  Python 3.12 instalado. CIERRA esta ventana y vuelve a ejecutar instalar-voz-natural.bat
    pause
    exit /b
  )
)
set "PY=py -3.12"

echo  [1/6] Librerias del oido (Vosk, Whisper)...
%PY% -m pip install --user --upgrade pip >nul
%PY% -m pip install --user --upgrade vosk sounddevice faster-whisper numpy
if errorlevel 1 goto fallo

echo  [2/6] PyTorch para tu RTX (unos 3 GB)...
%PY% -m pip install --user torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
if errorlevel 1 goto fallo

echo  [3/6] Voz natural (XTTS v2)...
%PY% -m pip install --user coqui-tts
if errorlevel 1 goto fallo
rem por si la voz ha cambiado PyTorch por uno sin tarjeta grafica
%PY% -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>nul
if errorlevel 1 %PY% -m pip install --user --force-reinstall --no-deps torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128

echo  [4/6] Whisper en la tarjeta grafica (CUDA)...
%PY% -m pip install --user nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"

echo  [5/6] Configuracion...
%PY% -c "import json,io; p='config.json'; c=json.load(io.open(p,encoding='utf-8-sig')); c['python']='-3.12'; c.setdefault('tts','auto'); c.setdefault('tts_speaker','Ana Florence'); c.setdefault('tts_reference','voz_referencia.wav'); c.setdefault('tts_speed',1.0); c.setdefault('whisper_device','auto'); io.open(p,'w',encoding='utf-8').write(json.dumps(c,ensure_ascii=False,indent=2))"

echo  [6/6] Descargando la voz (unos 2 GB) y creando muestras para que elijas...
%PY% -c "import torch; print('  Tarjeta grafica:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NO (ira mas lenta)')"
%PY% capri_habla.py --muestras

echo.
echo  Listo. Escucha las muestras de la carpeta "muestras", elige tu voz favorita y ponla en
echo  config.json ^> tts_speaker. Despues reinicia Capri (clic derecho ^> Salir y npm start).
echo.
pause
exit /b

:fallo
echo.
echo  ERROR en la instalacion. Haz una captura de esta ventana y pasasela a Claude.
pause
exit /b 1
