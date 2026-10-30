#!/bin/bash
# Double-click to start the app on http://localhost:8765
cd "$(dirname "$0")" || exit 1
PORT=8765
# models > 100 MB are stored in git as <file>.part0, .part1, … (GitHub's file limit): join them once
for p0 in $(find models -name '*.part0' 2>/dev/null); do
  out="${p0%.part0}"
  [ -s "$out" ] && continue
  echo "รวมไฟล์โมเดล $out"
  cat "$out".part[0-9]* > "$out.tmp" && mv "$out.tmp" "$out"
done
if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py "$PORT"
elif command -v npx >/dev/null 2>&1; then
  (sleep 2; open "http://localhost:$PORT/") &
  exec npx --yes http-server -a 127.0.0.1 -p "$PORT" -c-1
else
  echo "ไม่พบ python3 หรือ node — ติดตั้งอย่างใดอย่างหนึ่งก่อน"
  read -r -p "กด Enter เพื่อปิด"
fi
