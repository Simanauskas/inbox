# Reply suggestions, learned notes, agreed plans (`server/suggest/suggest.py`)

Compose services `suggest` (built from `server/suggest/Dockerfile`, python + numpy) and `ollama`
(`ollama/ollama:0.40.16`, models gemma3:4b + bge-m3 in `data/ollama`), profile `suggest` (`SUGGEST=1`).
Runs as @s through the double-puppet as_token, syncs DM rooms only. State in `data/suggest/suggest.db`.

## Suggestions

- Trigger: a fresh inbound message in a DM that wants a reply (`wants_reply`; automated messages
  skipped). Output: room account data `fit.simas.inbox.suggest` {event_id, replies, at}. App: chips
  above the composer, Mac ghost text "⇥ Tab" (`suggestionsFor`).
- **Claude first** (his decision 26 Nov — the chat's last ~12 messages go to Anthropic; covered by his
  subscription, no API key): runs the server's Claude Code binary (host
  `~/.local/share/claude/versions` mounted read-only at `/opt/claude`, newest version picked) as
  `claude -p --model sonnet --tools "" --no-session-persistence --system-prompt …`, env
  `CLAUDE_CODE_OAUTH_TOKEN` = `SUGGEST_CLAUDE_TOKEN` (from `claude setup-token`, ~1 year).
- Prompt: `data/suggest/style.md` (his style, server only, never in the repo) + "About <name>" (his own
  note `people[pid].about`, else the learned note) + up to 4 similar past exchanges + the last 12
  messages. Three replies with different purposes: direct response / follow-up question / offer or
  next step. **Always correct spelling: Lithuanian with diacritics (atvažiuoju, būsiu) or English**,
  even though he types without diacritics. Never invent facts.
- Fallback: local gemma3:4b with retrieval examples (weak Lithuanian; separate English prompt).
- Memory: pairs (their message → his reply) with bge-m3 embeddings (~5.2k from history via
  `--backfill`, grows as he replies). Never learns or suggests his self-chat (`SUGGEST_SELF_NAMES`),
  commands, keys, IBANs, passwords (`SENSITIVE`).

## Claude sign-in watch

- `claude_check` daily (tiny haiku request) + every suggestion → account data
  `fit.simas.inbox.status` {claude: {ok, error, checked, expires ≈ first seen + 365 d, configured}}.
- `alert()` → Sygnal `fit.simas.inbox.alert` to all his pushers, at most daily: when the token fails,
  and from 14 days before the year is up.
- App: Settings → Reply suggestions shows the status and, when needed, the two renew commands
  (copyable); a top bar appears when it fails. Setup-token tokens can't renew themselves.
- Renew (he runs on his Mac):
  `ssh -t inbox /root/.local/bin/claude setup-token`, then
  `ssh -t inbox 'read -rsp "Paste token: " T; …sed -i "/^SUGGEST_CLAUDE_TOKEN=/d"… >> /root/server/.env; docker compose up -d suggest'`.

## Learned notes about people

- `--profiles N` (initial run: 63 people) and 5 a day in the loop: Claude reads the last 80 messages
  of the people he talks with most (by learned exchanges, ≥5 each way) and writes
  `{category, note, at}` to account data `fit.simas.inbox.profiles` {rooms: {roomId: …}}, refreshed
  after 30 days. Categories: partner, family, close friend, friend, tennis, sport, work, client,
  service, other (meant for grouping later). No private details (addresses, numbers, health).
- Contact page shows the learned note; his "About" text replaces it.

## Agreed plans → calendar

- `detect_plan`: when a recent message mentions a time/day (`TIMEISH`) and someone confirmed
  (`AGREED`), **Claude** (since 27 Nov; gemma3:4b only if Claude isn't set up) extracts {agreed, title (chat's language), date, time, minutes, place}
  (relative days from today in Vilnius, start between now−1 h and +60 d) → room account data
  `fit.simas.inbox.plan`, offered once per room+start.
- App `PlanBanner`: "Add to calendar" → Apple Calendar new-event sheet with "Simanauskas | Personal"
  preselected (`@ebarooni/capacitor-calendar`; .ics on the web) / ✕.

## Memory on sky (27 Nov)
Local models unload quickly now (`keep_alive` 1 m for gemma, 5 m embeddings, `OLLAMA_KEEP_ALIVE=5m`),
so ~7 GB is free normally. That room is meant for Whisper (voice transcription).

## Voice transcription test (27 Nov)
faster-whisper on 6 real voice notes (Lithuanian): **large-v3-turbo int8** ≈ real-time on sky's CPU
(25 s note ≈ 25 s), language detected right, gist readable but many misheard words; **large-v3** a bit
better, ~2× slower. **Turbo + Claude clean-up** (text only, "fix clearly misheard words, don't add or
reorder") reads almost like the real message → the plan if he wants it built. Test image: python:3.12-slim +
faster-whisper 1.1.1 + requests + av 13.1.0 (av 16 breaks faster-whisper); models in data/whisper.
