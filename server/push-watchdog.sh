#!/usr/bin/env bash
# Keeps push notifications flowing to every device.
#
# Synapse sends a device the next notifications after its last pointer, but it only
# looks at the oldest 20. If those 20 were already read (e.g. you read them on the Mac
# while the phone's push service was briefly down), it skips them and never moves on:
# that device gets no notifications again until its app re-registers. This finds such
# a device, moves its pointer past what's already read, and restarts Synapse (which
# holds the pointers in memory). Does nothing when all is well.
#
# Usage (in /root/server): bash push-watchdog.sh            check once
#                          bash push-watchdog.sh --install  run every 5 minutes (cron)
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--install" ]]; then
  line="*/5 * * * * cd $PWD && bash push-watchdog.sh >> data/push-watchdog.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'push-watchdog.sh' ; echo "$line" ) | crontab -
  echo "Installed: $line"
  exit 0
fi

sql() { docker compose exec -T postgres psql -U synapse -d synapse -tA -c "$1"; }

# For each pusher: is its window of 20 oldest notifications all read? Then the new
# pointer is the newest of those 20 (repeat until it reaches something unread).
STUCK_SQL="
with p as (select id, user_name, last_stream_ordering pos from pushers where enabled),
w as (
  select p.id, ep.stream_ordering,
         ep.stream_ordering <= coalesce((select max(r.event_stream_ordering) from receipts_linearized r
            where r.room_id = ep.room_id and r.user_id = ep.user_id and r.receipt_type in ('m.read','m.read.private')), 0) as is_read,
         row_number() over (partition by p.id order by ep.stream_ordering) n
  from p join lateral (select * from event_push_actions e where e.user_id = p.user_name and e.notif = 1
                       and e.stream_ordering > p.pos order by e.stream_ordering limit 20) ep on true
)
select id, max(stream_ordering) from w group by id having count(*) = 20 and bool_and(is_read);"

moved=0
for _ in $(seq 1 50); do
  rows=$(sql "$STUCK_SQL")
  [[ -z "$rows" ]] && break
  while IFS='|' read -r id pos; do
    sql "update pushers set last_stream_ordering = $pos where id = $id" >/dev/null
    moved=1
  done <<< "$rows"
done

if [[ $moved == 1 ]]; then
  echo "$(date -Is) a device's notifications were stuck; moved it on and restarting Synapse"
  docker compose restart synapse >/dev/null
fi
