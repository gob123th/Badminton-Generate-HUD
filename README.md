# Badminton HUD — Web App (static)

อัปโหลดวิดีโอแบดมินตัน (กล้องตั้งนิ่ง) → ได้วิดีโอใหม่พร้อม HUD สไตล์ถ่ายทอดสด / เกม
ประมวลผล **ในเบราว์เซอร์ทั้งหมด** (ไม่มี server, วิดีโอไม่ถูกอัปโหลดไปไหน)

**ฟีเจอร์ (Phase 1–3)**
- ตรวจจับ/ติดตามผู้เล่น (YOLO11-pose + ByteTrack + re-ID ตามฝั่งสนาม), ป้ายชื่อภาษาไทย + stamina, วงแหวนเรืองแสงใต้เท้า, Court map
- **การ์ดผู้เล่น:** หลังอัปโหลด ระบบตัดรูปผู้เล่นในสนามมาให้ใส่ชื่อ/สี/ทีม (รูปหน้าไปโชว์ในแผงผู้เล่นด้วย)
- **ลูกขนไก่ (TrackNetV3):** LOCK ON + หางลูก, ตรวจจับจังหวะตี, นับ RALLY COUNT, RALLY TIME, **SHOT SPEED (km/h, ค่าประมาณ)**
- แผงผู้เล่นซ้ายล่าง (รูป, ชื่อ, ระยะวิ่ง MOVE, STA, แถบ stamina), ส่งออก MP4 พร้อมเสียงเดิม + stats.json (rally/ช็อต/ความเร็ว)

**การประมวลผล 2 รอบ:** รอบแรกวิเคราะห์ผู้เล่น + ลูก (มีพรีวิวสด) → วิเคราะห์วิถีลูกทั้งช่วง (หาจังหวะตี/rally/ความเร็ว) → รอบสองวาด HUD + encode

**ความเร็วลูกคำนวณยังไง:** ระยะจากผู้ตี → ผู้รับบนพื้นสนาม (จาก homography) ÷ เวลาบิน แล้วชดเชยแรงต้านอากาศของลูกขนไก่
(terminal velocity ≈ 6.8 m/s) ให้เป็นความเร็วตอนออกจากไม้ — กล้องตัวเดียวจึงเป็น **ค่าประมาณ** (EST)

## ความต้องการ
- **Chrome หรือ Edge รุ่นล่าสุด** (ต้องมี WebGPU + WebCodecs) — Safari ยังไม่แนะนำ
- เปิดผ่าน `http://localhost` หรือ `https://` (เปิดไฟล์ตรง ๆ แบบ `file://` ไม่ได้)
- อินเทอร์เน็ตตอนเปิดหน้าเว็บครั้งแรก (โหลด onnxruntime-web และ mediabunny จาก CDN jsDelivr)

## วิธีรันบนเครื่อง (Mac / Windows)
```bash
cd webapp
python3 -m http.server 8080          # Windows: py -m http.server 8080
```
แล้วเปิด Chrome ไปที่ http://localhost:8080

## วิธีใช้
1. **วิดีโอ** — ลากไฟล์มาวาง เลือกช่วงเวลา (ปุ่ม "ทดสอบ 15 วินาที" ไว้ลองก่อน)
2. **สนาม** — คลิก 4 มุมนอกของสนามคู่ ซ้ายบน → ขวาบน → ขวาล่าง → ซ้ายล่าง (คลิกในขอบดำได้ถ้ามุมอยู่นอกภาพ) ลากจุดปรับจนเส้นเขียวทับเส้นจริง
   คลิป `กอล์ฟ หมู vs วา มาร์ค.mp4` มีค่ามุมสนามตั้งไว้ให้แล้ว
3. **ผู้เล่น** — ระบบตรวจจับและตัดรูปให้อัตโนมัติ ใส่ชื่อ/สี/ทีม ลบคนที่ไม่ใช่ผู้เล่น หรือคลิกกรอบในภาพเพื่อเพิ่ม
4. **สร้างวิดีโอ** — ติ๊ก "บันทึกลงไฟล์โดยตรง" (แนะนำ, คลิปยาวไม่กิน RAM) → เลือกที่เซฟ → รอ (มีพรีวิวสด) → ได้ MP4 + ปุ่มดาวน์โหลด stats.json
   ระหว่างประมวลผลให้เปิดแท็บค้างไว้

การตั้งค่าทั้งหมดถูกจำไว้ในเบราว์เซอร์ และ Export/Import เป็น JSON ได้

## ความเร็ว
- `YOLO11s-pose` แม่นกว่า (ค่าเริ่มต้น), `YOLO11n-pose` เร็วกว่า
- "ตรวจจับทุก 2 เฟรม" เร็วขึ้นเกือบเท่าตัว (ตำแหน่งยังลื่นเพราะมี smoothing)
- ปิด "ติดตามลูกขนไก่" ถ้าต้องการแค่ผู้เล่น (เร็วขึ้น, ไม่ต้องโหลดโมเดล 45MB)
- ถ้าแถบบนขวาขึ้น `WebGPU ✗` จะใช้ CPU (ช้ากว่ามาก)

## Deploy เป็นเว็บ (ฟรี)
อัปโหลดทั้งโฟลเดอร์ `webapp/` ขึ้น GitHub Pages / Netlify / Cloudflare Pages ได้เลย (ไม่มี build step)

## โครงสร้าง
```
index.html          UI
css/style.css
js/app.js           ควบคุมขั้นตอน UI
js/pipeline.js      2-pass: analyze (players + shuttle) → rally analysis → render + encode, copy เสียงเดิม
js/shuttle.js       TrackNetV3 (ONNX) — background median + 8 เฟรม → heatmap → ตำแหน่งลูก
js/rally.js         วิเคราะห์วิถีลูก: เติมช่วงหาย, จังหวะตี, ความเร็ว, rally
js/detector.js      YOLO11-pose ONNX (onnxruntime-web, WebGPU → WASM)
js/bytetrack.js     ByteTrack (Kalman + 2-stage association)
js/players.js       จับคู่ track → ผู้เล่น (ID เดิม + ระยะในสนาม + กันข้ามเน็ต), EMA smoothing
js/court.js         homography 4 จุด, เส้นสนาม
js/stats.js         ระยะวิ่ง (กรอง jitter) + stamina
js/hud.js           วาด HUD ทั้งหมดบน canvas
js/stage.js         หน้าจอ calibrate / ระบุตัวผู้เล่น
js/config.js        ค่าเริ่มต้น + บันทึกใน localStorage
models/             yolo11n/s-pose.onnx (AGPL-3.0, Ultralytics), tracknetv3.onnx (MIT, qaz812345/TrackNetV3)
fonts/              Kanit, Bebas Neue (OFL)
```
