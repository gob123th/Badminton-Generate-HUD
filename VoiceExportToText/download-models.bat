@echo off
rem Download models (Hugging Face) + JS runtime (jsDelivr) into this folder (Windows 10+, uses curl.exe)
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "HF=https://huggingface.co"
set "CDN=https://cdn.jsdelivr.net/npm"
set FAIL=0
where curl.exe >nul 2>nul || (echo curl.exe not found - requires Windows 10 or newer & pause & exit /b 1)

echo == JS runtime -^> vendor\
call :fetch "%CDN%/@huggingface/transformers@3.8.1/dist/transformers.min.js" "vendor\transformers.min.js"
call :fetch "%CDN%/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.mjs" "vendor\ort-wasm-simd-threaded.jsep.mjs"
call :fetch "%CDN%/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.wasm" "vendor\ort-wasm-simd-threaded.jsep.wasm"
call :fetch "%CDN%/mediabunny@1.64.0/dist/bundles/mediabunny.min.mjs" "vendor\mediabunny.min.mjs"

rem Speaker diarization (~31 MB)
call :model onnx-community/pyannote-segmentation-3.0 config.json preprocessor_config.json onnx/model.onnx
call :model onnx-community/wespeaker-voxceleb-resnet34-LM config.json preprocessor_config.json onnx/model.onnx

rem Thai ASR - Thonburian distil-whisper (~0.5 GB)
set "WJ=config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json"
call :model supersuphot/distill-whisper-th-small-timestamped %WJ% onnx/encoder_model_fp16.onnx onnx/decoder_model_merged_fp16.onnx onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx

rem Optional: Whisper Large-v3 Turbo (~1.6 GB)
set "ANS=%~1"
if /i not "%ANS%"=="all" set /p "ANS=Download Whisper Large-v3 Turbo (~1.6 GB) too? [y/N] "
if /i "%ANS%"=="y" set "ANS=all"
if /i "%ANS%"=="all" call :model striimit/whisper-large-v3-turbo-webgpu %WJ% onnx/encoder_model_fp16.onnx onnx/decoder_model_merged_q4.onnx

echo.
if "%FAIL%"=="0" (echo Done. Next: double-click start.bat) else (echo Some files failed - run this script again to resume)
pause
exit /b 0

:model
set "REPO=%~1"
echo == %REPO%
shift
:model_loop
if "%~1"=="" exit /b 0
call :fetch "%HF%/%REPO%/resolve/main/%~1" "models/%REPO%/%~1"
shift
goto model_loop

:fetch
set "URL=%~1"
set "OUT=%~2"
set "OUT=!OUT:/=\!"
if exist "!OUT!" for %%A in ("!OUT!") do if %%~zA GTR 0 (echo   ok !OUT! & exit /b 0)
for %%D in ("!OUT!") do if not exist "%%~dpD" mkdir "%%~dpD"
echo   get !OUT!
curl.exe -fL --retry 3 -C - -o "!OUT!.part" "!URL!"
if errorlevel 1 (echo   FAILED !URL! & set FAIL=1 & exit /b 0)
move /y "!OUT!.part" "!OUT!" >nul
exit /b 0
