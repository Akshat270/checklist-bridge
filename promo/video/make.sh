#!/usr/bin/env bash
# Builds both promo videos (H.264 Main profile, so phones and every browser can play them) with sound, plus cover images, into promo/video/output/.
# Run from anywhere: bash promo/video/make.sh   (takes about 6 minutes)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"
[ -d node_modules/playwright ] || npm ci
npm run build
mkdir -p "$HERE/output"
for f in vertical square; do node "$HERE/render.js" "$f"; done
python3 "$HERE/audio.py"
for f in vertical square; do
  ffmpeg -y -loglevel error -i "$HERE/build/video-$f.mp4" -i "$HERE/build/audio.wav" \
    -c:v libx264 -profile:v main -level:v 4.0 -preset slow -crf 18 -pix_fmt yuv420p -r 30 \
    -c:a aac -b:a 160k -ar 48000 -shortest -movflags +faststart "$HERE/output/checklist-bridge-promo-$f.mp4"
  ffmpeg -y -loglevel error -ss 43 -i "$HERE/output/checklist-bridge-promo-$f.mp4" -frames:v 1 -q:v 2 "$HERE/output/cover-$f.jpg"
done
echo "Done: $HERE/output"
