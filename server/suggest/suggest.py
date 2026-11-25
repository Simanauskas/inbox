#!/usr/bin/env python3
"""Reply suggestions for Inbox, written in his own style by a small open-source model
running on the server (Ollama), so no chat text leaves the server.

How it learns: a memory of real exchanges — what someone wrote, then what he answered —
kept in SQLite with an embedding per message. For each new message the most similar
past exchanges are shown to the model as examples, together with a style profile
(style.md, written once and refreshed by hand). Every reply he sends is added to the
memory, so suggestions keep getting closer to how he writes. Edited suggestions count
as what he actually sent.

  python suggest.py --backfill   build the memory from his chat history (once, slow)
  python suggest.py --loop       the service: watch new messages, write suggestions

Suggestions go to room account data `fit.simas.inbox.suggest`
{event_id, replies: [..], source, at} which the app shows above the message box.

Env: USER_ID, AS_TOKEN_FILE (double-puppet registration), HS, OLLAMA (http://ollama:11434),
MODEL (gemma3:4b), EMBED_MODEL (bge-m3), STATE (/state).
"""
import json, os, re, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request
import numpy as np

HS = os.environ.get("HS", "http://synapse:8008")
USER = os.environ["USER_ID"]
OLLAMA = os.environ.get("OLLAMA", "http://ollama:11434")
MODEL = os.environ.get("MODEL", "gemma3:4b")
EMBED = os.environ.get("EMBED_MODEL", "bge-m3")
STATE = os.environ.get("STATE", "/state")
SUGGEST = "fit.simas.inbox.suggest"
PAIR_GAP = 6 * 3600 * 1000      # a reply counts if he answered within 6 h
FRESH = 15 * 60 * 1000          # only suggest for messages from the last 15 min
TOKEN = re.search(r'^as_token:\s*"?([^"\s]+)"?', open(os.environ.get("AS_TOKEN_FILE", "/app/doublepuppet.yaml")).read(), re.M).group(1)


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


# --- Matrix, as him (double-puppet appservice) ---------------------------------

def matrix(method, path, body=None, params=None, timeout=60):
    q = {"user_id": USER, **(params or {})}
    url = f"{HS}{path}{'&' if '?' in path else '?'}{urllib.parse.urlencode(q)}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def q(s):
    return urllib.parse.quote(s, safe="")


# --- Ollama --------------------------------------------------------------------

def ollama(path, body, timeout=300):
    req = urllib.request.Request(f"{OLLAMA}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def embed(texts):
    if not texts:
        return []
    out = ollama("/api/embed", {"model": EMBED, "input": texts, "keep_alive": "30m"})["embeddings"]
    v = np.asarray(out, dtype=np.float32)
    v /= np.linalg.norm(v, axis=1, keepdims=True) + 1e-9
    return list(v)


# --- memory --------------------------------------------------------------------

def db():
    os.makedirs(STATE, exist_ok=True)
    c = sqlite3.connect(os.path.join(STATE, "suggest.db"))
    c.execute("create table if not exists pairs (id integer primary key, room text, them text, me text, ts integer, emb blob, unique(room, ts))")
    c.execute("create table if not exists kv (k text primary key, v text)")
    c.execute("create table if not exists stats (event_id text primary key, room text, shown text, sent text, accepted integer, at integer)")
    return c


class Memory:
    def __init__(self, c):
        self.c = c
        self.load()

    def purge(self, rooms):
        bad = [rid for rid, t, m in self.c.execute("select id, them, me from pairs") if not ok_pair(t, m)]
        self.c.executemany("delete from pairs where id=?", [(i,) for i in bad])
        if rooms is not None:
            self.c.execute(f"delete from pairs where room not in ({','.join('?' * len(rooms))})", list(rooms))
        self.c.commit()
        self.load()

    def load(self):
        rows = self.c.execute("select room, them, me, emb from pairs where emb is not null").fetchall()
        self.rows = [(r, t, m) for r, t, m, _ in rows]
        self.mat = np.vstack([np.frombuffer(e, dtype=np.float32) for *_, e in rows]) if rows else np.zeros((0, 1024), np.float32)

    def add(self, room, them, me, ts):
        e = embed([them])[0]
        self.c.execute("insert or ignore into pairs (room, them, me, ts, emb) values (?,?,?,?,?)", (room, them, me, ts, e.tobytes()))
        self.c.commit()
        self.rows.append((room, them, me))
        self.mat = np.vstack([self.mat, e[None, :]]) if len(self.mat) else e[None, :]

    def similar(self, text, room, k=6):
        if not len(self.rows):
            return []
        e = embed([text])[0]
        s = self.mat @ e
        s = s + np.array([0.05 if r == room else 0 for r, _, _ in self.rows], dtype=np.float32)  # same person a bit first
        idx = np.argsort(-s)[: k * 3]
        out, seen = [], set()
        for i in idx:
            _, t, m = self.rows[i]
            if m.lower() in seen:
                continue
            seen.add(m.lower())
            out.append((float(s[i]), t, m))
            if len(out) == k:
                break
        return out


# --- which rooms / events ----------------------------------------------------------

def is_text(ev):
    c = ev.get("content") or {}
    return ev.get("type") == "m.room.message" and c.get("msgtype") in ("m.text", "m.emote") and isinstance(c.get("body"), str) \
        and not (c.get("m.relates_to") or {}).get("rel_type") == "m.replace"


# Never learn or suggest secrets or machine text: commands, keys, account numbers, passwords.
SENSITIVE = re.compile(
    r"(&&|\bsudo\b|\bdocker\b|\bcurl\b|\bssh-|\bgit\b|\bcreate-portal\b|matrix\.to/|```|\$ |"  # commands / bot talk
    r"\bLT\d{2}\s?\d{4}|\b[A-Z]{2}\d{2}[A-Z0-9]{12,30}\b|"                                  # IBANs
    r"\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]{4,}-[A-Za-z0-9]{4,}-[A-Za-z0-9]{4,}\b|"  # generated passwords
    r"\b\d{12,}\b|password|slaptaž|pin kod)", re.I)
SELF_NAMES = {n.strip().lower() for n in os.environ.get("SELF_NAMES", "").split(",") if n.strip()}


def ok_pair(them, me):
    if not them or not me or len(me) > 300 or SENSITIVE.search(me) or SENSITIVE.search(them):
        return False
    if re.fullmatch(r"\s*https?://\S+\s*", me):  # just a link
        return False
    return True


EN_WORDS = {"the", "you", "is", "are", "and", "to", "of", "it", "for", "with", "this", "that", "can", "will",
            "what", "how", "i", "we", "have", "do", "not", "be", "on", "at", "your", "my", "me", "great", "thanks", "ok"}


LT_WORDS = {"ir", "kad", "tai", "nu", "joa", "nea", "galim", "aciu", "ačiū", "taip", "ne", "as", "aš", "tu", "jau", "dar",
            "labas", "gerai", "davai", "aisku", "kur", "kada", "kaip", "busiu", "būsiu", "rytoj", "ryt", "siandien",
            "šiandien", "nzn", "seni", "brol", "puiku", "zupa", "valio", "darom", "parasysiu", "tuomet", "bet", "su",
            "man", "tau", "mes", "jus", "jūs", "cia", "čia", "ten", "kas", "ka", "ką", "gal", "reik", "reikia", "labai"}


def looks_english(text):
    """English unless it has Lithuanian letters or common Lithuanian words (incl. his diacritic-free spelling)."""
    words = re.findall(r"[a-ząčęėįšųūž']+", text.lower())
    if not words or re.search(r"[ąčęėįšųūž]", text.lower()):
        return False
    if any(w in LT_WORDS for w in words):
        return False
    return sum(w in EN_WORDS for w in words) >= 1 or len(words) <= 3


# 3: automated messages (businesses, notifications) don't get suggestions
AUTOMATED = re.compile(r"unsubscribe|notification preferences|do not reply|neatsakykite|atsisakyti|verification code|patvirtinimo kodas|your code is|\bOTP\b", re.I)


def wants_reply(text):
    return bool(text) and len(text) <= 600 and not AUTOMATED.search(text)


def clean(body):
    lines = body.split("\n")
    while lines and lines[0].startswith(">"):  # quoted reply fallback
        lines.pop(0)
    return "\n".join(lines).strip()[:400]


def dm_rooms():
    """Bridged one-to-one chats: rooms marked dm by the bridge, or iMessage chats that aren't groups."""
    out = []
    for rid in matrix("GET", "/_matrix/client/v3/joined_rooms")["joined_rooms"]:
        try:
            st = matrix("GET", f"/_matrix/client/v3/rooms/{q(rid)}/state")
        except Exception:
            continue
        br = next((e["content"] for e in st if e["type"] == "m.bridge"), None)
        if not br:
            continue
        kind = br.get("com.beeper.room_type") or br.get("com.beeper.room_type.v2")
        im_group = (br.get("channel") or {}).get("fi.mau.imessage.is_group")
        if kind == "dm" or im_group is False:
            name = next((e["content"].get("name", "") for e in st if e["type"] == "m.room.name"), "")
            others = [e["content"].get("displayname", "") for e in st if e["type"] == "m.room.member"
                      and e["state_key"] != USER and "bot:" not in e["state_key"] and e["content"].get("membership") == "join"]
            if SELF_NAMES and ({name.lower()} | {o.lower() for o in others}) & SELF_NAMES:
                continue  # his chat with himself: notes, commands, secrets
            out.append(rid)
    return out


def pairs_from(events):
    """(them, me, ts) from a time-ordered list of text events: their message(s), then his reply."""
    out, them, me, them_ts, me_ts = [], [], [], 0, 0
    def flush():
        if them and me and me_ts - them_ts < PAIR_GAP and ok_pair("\n".join(them[-3:]), "\n".join(me[:3])):
            out.append(("\n".join(them[-3:]), "\n".join(me[:3]), me_ts))
    for ev in events:
        if not is_text(ev):
            continue
        body = clean(ev["content"]["body"])
        if not body:
            continue
        if ev["sender"] == USER:
            if them:
                me.append(body); me_ts = me_ts or ev["origin_server_ts"]
        else:
            if me:
                flush(); them, me, me_ts = [], [], 0
            them.append(body); them_ts = ev["origin_server_ts"]
    flush()
    return out


# --- suggestions -----------------------------------------------------------------

def style():
    try:
        return open(os.path.join(STATE, "style.md")).read()
    except FileNotFoundError:
        return "Short, friendly, casual. Same language as the other person (Lithuanian or English)."


def recent(room, limit=12):
    r = matrix("GET", f"/_matrix/client/v3/rooms/{q(room)}/messages", params={"dir": "b", "limit": str(limit * 2)})
    evs = [e for e in reversed(r.get("chunk", [])) if is_text(e)][-limit:]
    return evs


def suggest(mem, room, ev):
    convo = recent(room)
    their = clean(ev["content"]["body"])
    # the conversation's language: its last few real sentences (one-word "Okaay" says nothing)
    texts = [clean(e["content"]["body"]) for e in convo[-6:]]
    longer = [x for x in texts if len(re.findall(r"\w+", x)) > 3] or texts
    english = sum(looks_english(x) for x in longer) * 2 > len(longer)
    examples = mem.similar(their, room, k=12)
    # examples in the same language as their message, so the model answers in that language
    same = [x for x in examples if looks_english(x[1]) == english]
    examples = (same or examples)[:6]
    lines = [f"{'Simas' if e['sender'] == USER else 'Them'}: {clean(e['content']['body'])[:200]}" for e in convo[-8:]]
    ex = "\n".join(f"Them: {t[:150]}\nSimas: {m[:120]}" for _, t, m in examples[:5])
    lang = "English" if english else "Lithuanian (usually without diacritics, as he writes)"
    system = (
        "You write reply suggestions for Simas to send in a chat. Match his style exactly: "
        "his language choice, length, spelling, punctuation and emoji habits.\n\n"
        f"How Simas writes:\n{style()}\n\n"
        f"How he actually replied to similar messages before:\n{ex}\n\n"
        f"Write the replies in {lang}, the language of their last message.\n"
        "Reply with JSON {\"replies\": [three short, different messages Simas could send next]}: "
        "usually one that agrees/confirms, one that declines or proposes an alternative, and one that asks "
        "a short follow-up — only when that fits the conversation. Write as Simas, never explain."
    )
    user = "Conversation (oldest first):\n" + "\n".join(lines) + f"\n\nSimas's next message options, in {'English' if english else 'Lithuanian'}:"
    t = time.time()

    def ask(sys_prompt):
        r = ollama("/api/chat", {"model": MODEL, "stream": False, "format": "json", "keep_alive": "30m",
                                 "options": {"temperature": 0.6, "num_predict": 120, "num_ctx": 2048},
                                 "messages": [{"role": "system", "content": sys_prompt}, {"role": "user", "content": user}]})
        try:
            return [x.strip() for x in json.loads(r["message"]["content"]).get("replies", []) if isinstance(x, str) and x.strip()]
        except Exception:
            return []

    if english:
        # the Lithuanian profile and examples pull a small model back to Lithuanian, so English
        # conversations get their own short prompt with only his English replies as examples
        en_ex = "\n".join(f"Them: {t[:150]}\nSimas: {m[:120]}" for _, t, m in examples if looks_english(m))
        system = ("You write reply suggestions for Simas in an English chat. He writes English short and casual, "
                  "no long explanations, sometimes one emoji (👍🙏😄). Examples: \"cool\", \"Great, your office then?\", "
                  "\"sounds good, let's do it\", \"thanks!\".\n"
                  + (f"How he replied in English before:\n{en_ex}\n" if en_ex else "")
                  + "Reply with JSON {\"replies\": [exactly three short, different messages Simas could send next]}: "
                  "one agreeing, one with a short follow-up or question, one alternative. Write as Simas, never explain.")
    replies = ask(system)
    if english and sum(looks_english(x) or len(x) < 4 for x in replies) < 2:
        # small models drift to his main language: ask once more, firmly, and keep only English
        replies = [x for x in ask("IMPORTANT: the conversation is in English. Answer ONLY in English, short and casual "
                                  "like Simas writes in English (e.g. \"sounds good\", \"great, thanks!\", \"cool, let's do it\").\n\n" + system)
                   if looks_english(x) or len(x) < 4]
    # his own earlier answer to almost the same message goes first
    if examples and examples[0][0] > 0.9 and len(their) >= 12 and len(examples[0][2]) <= 80 and examples[0][2] not in replies:
        replies.insert(0, examples[0][2])
    replies = [x for x in dict.fromkeys(replies) if not SENSITIVE.search(x)][:3]
    log(f"suggested in {time.time() - t:.0f}s for {room[:10]}: {len(replies)} replies, best match {examples[0][0]:.2f}" if examples else f"suggested for {room[:10]}")
    return replies


def put_suggestions(room, ev, replies):
    matrix("PUT", f"/_matrix/client/v3/user/{q(USER)}/rooms/{q(room)}/account_data/{SUGGEST}",
           {"event_id": ev["event_id"], "replies": replies, "at": int(time.time() * 1000), "model": MODEL})


# --- modes -----------------------------------------------------------------------

def backfill(per_room=1500):
    c = db()
    mem = Memory(c)
    rooms = dm_rooms()
    log(f"backfill: {len(rooms)} one-to-one chats")
    total = 0
    for n, rid in enumerate(rooms, 1):
        events, frm = [], None
        while len(events) < per_room:
            try:
                r = matrix("GET", f"/_matrix/client/v3/rooms/{q(rid)}/messages", params={"dir": "b", "limit": "500", **({"from": frm} if frm else {})})
            except Exception as e:
                log("skip", rid[:12], e); break
            events += r.get("chunk", [])
            frm = r.get("end")
            if not frm or not r.get("chunk"):
                break
        events.sort(key=lambda e: e.get("origin_server_ts", 0))
        ps = pairs_from(events)
        new = [p for p in ps if not c.execute("select 1 from pairs where room=? and ts=?", (rid, p[2])).fetchone()]
        for i in range(0, len(new), 32):
            batch = new[i:i + 32]
            for (them, me, ts), e in zip(batch, embed([b[0] for b in batch])):
                c.execute("insert or ignore into pairs (room, them, me, ts, emb) values (?,?,?,?,?)", (rid, them, me, ts, e.tobytes()))
            c.commit()
        total += len(new)
        if n % 25 == 0 or n == len(rooms):
            log(f"backfill: {n}/{len(rooms)} chats, {total} exchanges")
    log(f"backfill done: {c.execute('select count(*) from pairs').fetchone()[0]} exchanges in memory")


def loop():
    c = db()
    mem = Memory(c)
    log(f"memory: {len(mem.rows)} exchanges; model {MODEL}")
    dms = set(dm_rooms())
    dms_at = time.time()
    mem.purge(dms)
    log(f"memory after cleanup: {len(mem.rows)} exchanges")
    last_in = {}       # room -> (their text, ts) waiting for his reply
    shown = {}         # room -> (event_id, replies)
    flt = json.dumps({"room": {"timeline": {"limit": 30}, "state": {"types": []}, "ephemeral": {"types": []}, "account_data": {"types": []}},
                      "presence": {"types": []}, "account_data": {"types": []}})
    since = (c.execute("select v from kv where k='since'").fetchone() or [None])[0]
    if not since:
        since = matrix("GET", "/_matrix/client/v3/sync", params={"filter": flt, "timeout": "0"}, timeout=300)["next_batch"]
    while True:
        try:
            if time.time() - dms_at > 3600:
                dms, dms_at = set(dm_rooms()), time.time()
            r = matrix("GET", "/_matrix/client/v3/sync", params={"filter": flt, "since": since, "timeout": "30000"}, timeout=90)
            since = r["next_batch"]
            c.execute("insert or replace into kv values ('since', ?)", (since,)); c.commit()
            for rid, room in (r.get("rooms", {}).get("join") or {}).items():
                if rid not in dms:
                    continue
                evs = [e for e in room.get("timeline", {}).get("events", []) if is_text(e)]
                for ev in evs:
                    body = clean(ev["content"]["body"])
                    if ev["sender"] == USER:
                        # learning: what he actually sent after their message
                        if rid in last_in and body:
                            them, ts = last_in.pop(rid)
                            if ev["origin_server_ts"] - ts < PAIR_GAP and ok_pair(them, body):
                                mem.add(rid, them, body, ev["origin_server_ts"])
                                if rid in shown:
                                    eid, rep = shown.pop(rid)
                                    c.execute("insert or replace into stats values (?,?,?,?,?,?)", (eid, rid, json.dumps(rep), body, int(body in rep), int(time.time())))
                                    c.commit()
                    else:
                        prev = last_in.get(rid)
                        last_in[rid] = ((prev[0] + "\n" + body) if prev and ev["origin_server_ts"] - prev[1] < 600_000 else body, ev["origin_server_ts"])
                fresh = [e for e in evs if e["sender"] != USER and time.time() * 1000 - e["origin_server_ts"] < FRESH]
                if fresh and (not evs or evs[-1]["sender"] != USER) and wants_reply(clean(fresh[-1]["content"]["body"])):
                    ev = fresh[-1]
                    try:
                        replies = suggest(mem, rid, ev)
                        if replies:
                            put_suggestions(rid, ev, replies)
                            shown[rid] = (ev["event_id"], replies)
                    except Exception as e:
                        log("suggest failed:", e)
        except Exception as e:
            log("error:", e)
            time.sleep(10)


if __name__ == "__main__":
    if "--backfill" in sys.argv:
        backfill()
    if "--loop" in sys.argv:
        loop()
