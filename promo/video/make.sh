#!/usr/bin/env bash
# Builds both promo videos with sound, plus cover images, into promo/video/output/.
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
    -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$HERE/output/checklist-bridge-promo-$f.mp4"
  ffmpeg -y -loglevel error -ss 43 -i "$HERE/output/checklist-bridge-promo-$f.mp4" -frames:v 1 -q:v 2 "$HERE/output/cover-$f.jpg"
done
echo "Done: $HERE/output"
