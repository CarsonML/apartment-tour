#!/bin/bash
# Stop the render at a wall-clock deadline whatever state it is in.
#
# auto_finish.sh waits for the render process to exit. If the render ever
# wedges, that wait never ends and the night produces nothing. This
# guarantees an ending: pruning already drops whatever is unfinished, so a
# stopped render still yields a valid, better site.
set -u
cd "$(dirname "$0")/.."
PID="${1:?render runner pid}"
HOURS="${2:-7.5}"
SECS=$(python3 -c "print(int(float('$HOURS')*3600))")
say() { echo "$(date '+%H:%M:%S') [deadline] $*" >> logs/auto_finish.log; }

say "render will be stopped after ${HOURS} h if not done by then"
END=$(( $(date +%s) + SECS ))
while kill -0 "$PID" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$END" ]; then
    say "deadline reached - stopping the render, keeping what finished"
    pkill -f "render_faces.py" 2>/dev/null
    sleep 5
    kill "$PID" 2>/dev/null
    sleep 2
    kill -9 "$PID" 2>/dev/null
    break
  fi
  sleep 60
done
say "render runner has exited"
