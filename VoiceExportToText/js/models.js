// Local model manifest. Files live under ./models/<repo>/ (download with download-models.command).
const WHISPER_JSON = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];

export const DIAR_MODELS = {
  seg: { id: 'onnx-community/pyannote-segmentation-3.0', files: ['config.json', 'preprocessor_config.json', 'onnx/model.onnx'] },
  emb: { id: 'onnx-community/wespeaker-voxceleb-resnet34-LM', files: ['config.json', 'preprocessor_config.json', 'onnx/model.onnx'] },
};

export const ASR_MODELS = [
  {
    key: 'th-small', label: 'Thonburian Whisper (distil) · ไทย (แนะนำ)',
    id: 'supersuphot/distill-whisper-th-small-timestamped',
    webgpu: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
    wasm: 'q8',
    files: {
      common: WHISPER_JSON,
      webgpu: ['onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_fp16.onnx'],
      wasm: ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'],
    },
    hint: 'fine-tune ภาษาไทย (Mahidol/biodatlab) · ~0.5 GB',
  },
  {
    key: 'turbo', label: 'Whisper Large-v3 Turbo · หลายภาษา',
    id: 'striimit/whisper-large-v3-turbo-webgpu',
    webgpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
    wasm: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
    files: {
      common: WHISPER_JSON,
      webgpu: ['onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_q4.onnx'],
      wasm: ['onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_q4.onnx'],
    },
    hint: 'โมเดลใหญ่ เหมาะกับไทยปนอังกฤษ · ควรใช้ WebGPU · ~1.6 GB',
  },
];

export const MODELS_DIR = new URL('../models/', import.meta.url).href;
export const VENDOR_DIR = new URL('../vendor/', import.meta.url).href;

/** Returns the list of missing files for a repo (HEAD requests against the local server). */
export async function missingFiles(id, files) {
  const res = await Promise.all(files.map(async (f) => {
    try {
      const r = await fetch(`${MODELS_DIR}${id}/${f}`, { method: 'HEAD', cache: 'no-store' });
      return r.ok ? null : f;
    } catch { return f; }
  }));
  return res.filter(Boolean);
}
