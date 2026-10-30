# VoiceExportToText

ถอดเสียงสนทนาภาษาไทย + แยกผู้พูดอัตโนมัติ ประมวลผลใน browser ทั้งหมด (ไฟล์เสียงไม่ถูกส่งออกจากเครื่อง)

## วิธีใช้
0. ครั้งแรก: ดับเบิลคลิก `download-models.command` เพื่อโหลดโมเดล/library ลง `models/` และ `vendor/` (~0.6 GB, Turbo เพิ่ม ~1.6 GB) — หลังจากนั้นใช้ offline ได้
   - clone จาก git: โมเดล Thonburian มากับ repo แล้ว ไม่ต้องโหลด (ไฟล์ fp16 ที่เกิน 100 MB เก็บเป็น `.part0`, `.part1` แล้ว `start.command` / `serve.py` / `start.bat` รวมให้เองตอนเปิดครั้งแรก) — โหลดเพิ่มเฉพาะ Turbo
1. ดับเบิลคลิก `start.command` (หรือรัน `python3 serve.py`) → เปิด http://localhost:8765
2. ลากไฟล์เสียงใส่ เลือกโมเดล / จำนวนผู้พูด แล้วกด **เริ่มถอดเสียง**
3. แก้ชื่อผู้พูด, รวมผู้พูด, เปลี่ยนผู้พูดรายบรรทัด (คลิกชื่อ), แก้ข้อความ (คลิกที่ข้อความ), คลิกเวลาเพื่อฟัง
4. Export: TXT / Word / SRT / JSON (JSON เปิดกลับมาแก้ต่อได้)

### เปิดผ่านเว็บ (GitHub Pages)
https://gob123th.github.io/Badminton-Generate-HUD/VoiceExportToText/ — ไม่ต้องติดตั้งอะไร ครั้งแรกโหลดโมเดล ~0.5 GB แล้วเก็บไว้ใน browser
(`sw.js`: รวมไฟล์ `.part*`, เก็บ cache, ใส่ header ให้ WASM ใช้หลาย thread — หน้า reload เองหนึ่งครั้งตอนเปิดครั้งแรก)

### Windows (ไม่ต้องมี Python)
- ครั้งแรก: ดับเบิลคลิก `download-models.bat` (ใช้ curl.exe ที่มีใน Windows 10+)
- ดับเบิลคลิก `start.bat` → server ด้วย PowerShell เปิด http://localhost:8765 ให้

ใช้ Chrome หรือ Edge (รองรับ WebGPU) · ห้ามเปิด `index.html` ตรงๆ ผ่าน file://

## Pipeline
| ขั้น | โมเดล | ทำงานบน |
|---|---|---|
| แยกช่วงพูด (10 วิ/หน้าต่าง) | `onnx-community/pyannote-segmentation-3.0` | WASM |
| ลักษณะเสียงผู้พูด | `onnx-community/wespeaker-voxceleb-resnet34-LM` | WASM |
| นับ/จัดกลุ่มผู้พูด | Agglomerative clustering (cosine, average linkage) + centroid refinement | JS |
| ถอดเสียง (ทีละช่วงของผู้พูด ≤28 วิ) | `supersuphot/distill-whisper-th-small-timestamped` (Thonburian) หรือ `striimit/whisper-large-v3-turbo-webgpu` | WebGPU หรือ WASM |

ไฟล์เสียงถูกถอดรหัสแบบ streaming (WebCodecs) เป็น 16 kHz mono จึงรองรับไฟล์ยาวหลายชั่วโมง

## ปรับความแม่นยำ
- รู้จำนวนคน → เลือก "ระบุช่วง" แล้วใส่ค่าเท่ากัน
- ระบบแยกคนเกิน → เลื่อน "ความไวในการแยกผู้พูด" ไปทางขวา หรือใช้ปุ่ม "รวมกับ…" หลังถอดเสร็จ
- ผลถอดเพี้ยนบน WebGPU → เปลี่ยนโหมดเป็น WASM
