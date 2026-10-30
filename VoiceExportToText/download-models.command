#!/bin/bash
# Download models (Hugging Face) + JS runtime (jsDelivr) into this folder for fully offline use.
# Usage: double-click, or ./download-models.command [all]
cd "$(dirname "$0")" || exit 1
HF="https://huggingface.co"
CDN="https://cdn.jsdelivr.net/npm"
FAIL=0

fetch() { # url out
  local url="$1" out="$2"
  if [ -s "$out" ]; then echo "  ✓ $out"; return; fi
  mkdir -p "$(dirname "$out")"
  echo "  ↓ $out"
  if curl -fL --retry 3 --progress-bar -C - -o "$out.part" "$url"; then mv "$out.part" "$out"; else echo "  ✗ ล้มเหลว: $url"; FAIL=1; fi
}
model() { # repo file...
  local repo="$1"; shift
  echo "■ $repo"
  for f in "$@"; do fetch "$HF/$repo/resolve/main/$f" "models/$repo/$f"; done
}
WHISPER_JSON="config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json"

echo "■ JS runtime → vendor/"
fetch "$CDN/@huggingface/transformers@3.8.1/dist/transformers.min.js" vendor/transformers.min.js
fetch "$CDN/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.mjs" vendor/ort-wasm-simd-threaded.jsep.mjs
fetch "$CDN/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.wasm" vendor/ort-wasm-simd-threaded.jsep.wasm
fetch "$CDN/mediabunny@1.64.0/dist/bundles/mediabunny.min.mjs" vendor/mediabunny.min.mjs

# Speaker diarization (~31 MB)
model onnx-community/pyannote-segmentation-3.0 config.json preprocessor_config.json onnx/model.onnx
model onnx-community/wespeaker-voxceleb-resnet34-LM config.json preprocessor_config.json onnx/model.onnx

# Thai ASR — Thonburian distil-whisper (~0.5 GB: fp16 for WebGPU + q8 for CPU)
model supersuphot/distill-whisper-th-small-timestamped $WHISPER_JSON \
  onnx/encoder_model_fp16.onnx onnx/decoder_model_merged_fp16.onnx \
  onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx

# Optional: Whisper Large-v3 Turbo (~1.6 GB)
ANS="$1"
if [ "$ANS" != "all" ]; then read -r -p "ดาวน์โหลด Whisper Large-v3 Turbo (~1.6 GB) ด้วยไหม? [y/N] " ANS; fi
if [[ "$ANS" =~ ^([yY]|all)$ ]]; then
  model striimit/whisper-large-v3-turbo-webgpu $WHISPER_JSON onnx/encoder_model_fp16.onnx onnx/decoder_model_merged_q4.onnx
fi

echo
if [ $FAIL -eq 0 ]; then echo "เสร็จแล้ว ✓  ต่อไปดับเบิลคลิก start.command"; else echo "มีบางไฟล์โหลดไม่สำเร็จ — รันสคริปต์นี้ซ้ำได้ (โหลดต่อจากเดิม)"; fi
[ -t 0 ] && read -r -p "กด Enter เพื่อปิด"
