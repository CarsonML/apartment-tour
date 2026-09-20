#!/bin/bash
# Drive the cube-face render to completion, surviving GPU hangs.
#
# Blender's Metal backend can wedge mid-frame: the process stays alive, the GPU
# reads as busy, and nothing is ever written again.  render_faces.py skips
# faces that already exist, so the cure is to kill it and start over -- no work
# is lost.  This polls the finished-face count and does that whenever progress
# stops for STALL_SECS.  A heartbeat line goes to the log so the watchdog can
# itself be seen to be alive.
set -u
cd "$(dirname "$0")/.."

BLEND="${BLEND:?set BLEND to the .blend path}"
OUT="${OUT:-raw/full}"
SIZE="${SIZE:-2048}"
SAMPLES="${SAMPLES:-128}"
THRESHOLD="${THRESHOLD:-0.01}"
STALL_SECS="${STALL_SECS:-540}"
KIND="${KIND:-all}"
POLL="${POLL:-30}"
LOG="${LOG:-logs/render_full.log}"
HEARTBEAT="${HEARTBEAT:-logs/heartbeat.log}"

want=$(KIND="$KIND" python3 -c "
import json, os
k=os.environ['KIND']
ns=json.load(open('pipeline/nodes.json'))['nodes']
if k=='walk':  ns=[n for n in ns if n.get('walkOnly')]
if k=='named': ns=[n for n in ns if not n.get('walkOnly')]
print(len(ns)*6)")
count() { ls "$OUT"/*/*.png 2>/dev/null | wc -l | tr -d ' '; }
say() { echo "$(date '+%H:%M:%S') $*" >> "$HEARTBEAT"; }

say "runner start, target ${want} faces, have $(count)"
attempt=0
while [ "$(count)" -lt "$want" ]; do
  attempt=$((attempt + 1))
  say "attempt ${attempt}: $(count)/${want}"
  echo "=== attempt ${attempt} $(date '+%H:%M:%S') ===" >> "$LOG"

  "/Applications/Blender.app/Contents/MacOS/Blender" -b "$BLEND" \
    --python pipeline/render_faces.py -- \
    --nodes pipeline/nodes.json --out "$OUT" --size "$SIZE" \
    --samples "$SAMPLES" --threshold "$THRESHOLD" --kind "$KIND" >> "$LOG" 2>&1 &
  pid=$!
  say "  blender pid ${pid}"

  last=$(count)
  idle=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$POLL"
    now=$(count)
    if [ "$now" -gt "$last" ]; then
      last=$now
      idle=0
    else
      idle=$((idle + POLL))
    fi
    say "  ${now}/${want} idle=${idle}s"
    if [ "$idle" -ge "$STALL_SECS" ]; then
      say "  STALLED ${idle}s -> killing ${pid}"
      echo "!!! stalled ${idle}s at ${now}/${want}, restarting" >> "$LOG"
      kill "$pid" 2>/dev/null
      sleep 5
      kill -9 "$pid" 2>/dev/null
      break
    fi
  done
  wait "$pid" 2>/dev/null

  OUT="$OUT" python3 - >> "$LOG" 2>&1 <<'PY'
import glob, os
from PIL import Image
for f in glob.glob(os.environ["OUT"] + "/*/*.png"):
    try:
        Image.open(f).verify()
    except Exception:
        os.remove(f)
        print("removed truncated", f)
PY
  sleep 3
done
say "ALL ${want} FACES DONE"
echo "=== all ${want} faces present $(date '+%H:%M:%S') ===" >> "$LOG"
