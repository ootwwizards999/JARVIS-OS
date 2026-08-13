#!/bin/bash
# Reap orphaned Claude Code processes (SG-817).
#
# The leak: Claude Desktop routine fires spawn `claude` process trees that are
# never reaped. When the spawner dies, the tree reparents to launchd (ppid 1)
# and sits there holding 100-200MB each, forever. Observed: 11 procs / 0.71GB
# still alive after 15 days.
#
# Kill criteria — ALL must hold, so this can never touch live work:
#   ppid == 1     orphaned; its spawner is already dead
#   tty == ??     no controlling terminal, so it is not an interactive session
#   age  > 2h     well past any real routine fire (they run hourly)
#
# Interactive sessions in a terminal tab always have a TTY and are never
# candidates, no matter how old. Closing those is a human decision.

set -uo pipefail

MIN_AGE_SECONDS=${MIN_AGE_SECONDS:-7200}
LOG="${HOME}/Library/Logs/claude-reaper.log"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

# macOS ps has no `etimes`, only `etime` as [[DD-]HH:]MM:SS — convert to seconds.
candidates=$(ps -Ao pid=,ppid=,tty=,etime=,rss=,comm= \
  | awk -v min="$MIN_AGE_SECONDS" '
      function secs(e,   d, t, p, n) {
        d = 0
        if (e ~ /-/) { split(e, p, "-"); d = p[1]; t = p[2] } else { t = e }
        n = split(t, p, ":")
        if (n == 3) return d * 86400 + p[1] * 3600 + p[2] * 60 + p[3]
        if (n == 2) return d * 86400 + p[1] * 60 + p[2]
        return d * 86400 + p[1]
      }
      $2 == 1 && $3 == "??" && $6 ~ /claude/ && secs($4) > min { print $1, secs($4), $5 }')

[ -z "$candidates" ] && exit 0

freed_kb=0
count=0
while read -r pid age rss; do
  [ -z "$pid" ] && continue
  kids=$(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ')
  kill "$pid" $kids 2>/dev/null
  freed_kb=$((freed_kb + rss))
  count=$((count + 1))
  log "reaped pid=$pid age=${age}s rss=$((rss / 1024))MB kids=[${kids:-none}]"
done <<< "$candidates"

# Anything that ignored SIGTERM gets SIGKILL.
sleep 5
while read -r pid age rss; do
  [ -z "$pid" ] && continue
  if ps -p "$pid" > /dev/null 2>&1; then
    kill -9 "$pid" 2>/dev/null
    log "SIGKILL pid=$pid (ignored SIGTERM)"
  fi
done <<< "$candidates"

log "run complete: reaped $count proc(s), ~$((freed_kb / 1024))MB"
