#!/usr/bin/env python3
"""The people he knows: who they are to him, how close, where they work, what we've learned.

Runs as the `people` service (docker compose). Every night (NIGHT_UTC, default 01:30 UTC =
03:30 in Vilnius in winter) it reads the day's private chats and, for each person he talked
with, asks Claude (his subscription, like the reply suggestions) to update what we know:

  - circle (family, close friend, colleague, …) and connection strength 0–100 — only as
    SUGGESTIONS; what he sets in the app always wins, and his corrections (with his "why")
    are given back to Claude every night so the suggestions learn;
  - how they know each other, company / role / industry (and past jobs), tags (tennis, …);
  - facts, each with the date and the message it came from; facts that stop being true are
    kept, marked old.

Where things are:
  - learned data: `/state/people.db` (SQLite), published to the app as a private JSON file in
    his Matrix media, pointed at by account data `fit.simas.inbox.crm`;
  - his own edits: account data `fit.simas.inbox.crm_edits` (the app writes it);
  - who is who (rooms → person → iCloud card): account data `fit.simas.inbox.directory`, which
    the app publishes from its own people model, so both agree on who is one person;
  - iCloud: work details are written to the card only where the card is empty; when the card
    says something else the app asks him (card.conflicts). The card note gets an "Inbox" block
    (his own note text is kept), and the card is put in an iCloud group per circle and tag.
    Requests go through the `contacts` service (`fit.simas.inbox.contact_requests_auto`).

Messages are read straight from Synapse's database with a read-only user (PG_* env).

  python people.py --loop          the service
  python people.py --once          tonight's run now (only messages since the last run)
  python people.py --backfill [N]  read whole histories (up to N people) — after imports
  python people.py --publish       just merge, publish and sync iCloud
"""
import hashlib, json, math, os, re, sqlite3, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

import psycopg

HS = os.environ.get("HS", "http://synapse:8008")
USER = os.environ["USER_ID"]
STATE = os.environ.get("STATE", "/state")
CLAUDE_DIR = os.environ.get("CLAUDE_DIR", "/opt/claude")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "sonnet")
NIGHT_UTC = os.environ.get("NIGHT_UTC", "01:30")
MAX_PER_NIGHT = int(os.environ.get("MAX_PER_NIGHT", "60"))
CHUNK_LINES = 400

DIRECTORY = "fit.simas.inbox.directory"
EDITS = "fit.simas.inbox.crm_edits"
POINTER = "fit.simas.inbox.crm"
PROFILES = "fit.simas.inbox.profiles"   # the older one-line learned notes (seeds)
CONTACTS = "fit.simas.inbox.contacts"
AUTOREQ = "fit.simas.inbox.contact_requests_auto"
RESULTS = "fit.simas.inbox.contact_results"

CIRCLES = ["partner", "family", "close friend", "friend", "colleague", "former colleague", "client", "acquaintance", "service"]
# iCloud groups (partner and service get none)
GROUP_OF = {"family": "Family", "close friend": "Close friends", "friend": "Friends", "colleague": "Colleagues",
            "former colleague": "Former colleagues", "client": "Clients", "acquaintance": "Acquaintances"}
SEED_CIRCLE = {"partner": "partner", "family": "family", "close friend": "close friend", "friend": "friend",
               "tennis": "friend", "sport": "friend", "work": "colleague", "client": "client", "service": "service",
               "other": "acquaintance"}
NOTE_MARK = "— Inbox —"


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def as_token():
    text = open(os.environ.get("AS_TOKEN_FILE", "/app/doublepuppet.yaml")).read()
    return re.search(r'^as_token:\s*"?([^"\s]+)"?', text, re.M).group(1)


TOKEN = as_token()
q = lambda s: urllib.parse.quote(s, safe="")


def matrix(method, path, body=None, raw=None, ctype="application/json", timeout=60):
    sep = "&" if "?" in path else "?"
    url = f"{HS}{path}{sep}user_id={q(USER)}"
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = r.read()
        return json.loads(out) if out and r.headers.get_content_type() == "application/json" else out


def account_data(kind):
    try:
        return matrix("GET", f"/_matrix/client/v3/user/{q(USER)}/account_data/{kind}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        raise


def set_account_data(kind, content):
    matrix("PUT", f"/_matrix/client/v3/user/{q(USER)}/account_data/{kind}", content)


def media_json(mxc):
    server, mid = mxc[6:].split("/", 1)
    out = matrix("GET", f"/_matrix/client/v1/media/download/{q(server)}/{q(mid)}", timeout=120)
    return out if isinstance(out, dict) else json.loads(out)


# --- local state -------------------------------------------------------------

def db():
    os.makedirs(STATE, exist_ok=True)
    c = sqlite3.connect(os.path.join(STATE, "people.db"))
    c.executescript("""
      create table if not exists persons (cid text primary key, rooms text, name text, learned text, last_ts integer default 0, at integer);
      create table if not exists facts (id integer primary key, cid text, text text, kind text, ts integer, room text, event text,
                                        status text default 'current', added integer);
      create table if not exists kv (k text primary key, v text);
      create index if not exists facts_cid on facts(cid);
    """)
    return c


def kv(c, k, v=None):
    if v is None:
        r = c.execute("select v from kv where k=?", (k,)).fetchone()
        return json.loads(r[0]) if r else None
    c.execute("insert or replace into kv values (?,?)", (k, json.dumps(v)))
    c.commit()


def sync_persons(c, directory):
    """Give every person in the app's directory a stable id. A person keeps their id when chats
    are added to or split from them (matched by shared chats)."""
    rows = {cid: set(json.loads(rooms)) for cid, rooms in c.execute("select cid, rooms from persons")}
    by_room = {r: cid for cid, rs in rows.items() for r in rs}
    out = {}
    for p in directory:
        rooms = [r for r in p.get("rooms") or [] if r]
        if not rooms:
            continue
        cands = [by_room[r] for r in rooms if r in by_room]
        cid = max(set(cands), key=cands.count) if cands else rooms[0]
        if cid in out:  # two app people share a chat id somehow: keep the first
            continue
        out[cid] = {"name": p.get("name") or "", "rooms": rooms, "href": p.get("href"), "key": p.get("key")}
        c.execute("insert into persons (cid, rooms, name) values (?,?,?) on conflict(cid) do update set rooms=excluded.rooms, name=excluded.name",
                  (cid, json.dumps(rooms), out[cid]["name"]))
    c.commit()
    return out


# --- messages (Synapse's database, read-only) -------------------------------

def pg():
    return psycopg.connect(host=os.environ.get("PG_HOST", "postgres"), dbname=os.environ.get("PG_DB", "synapse"),
                           user=os.environ["PG_USER"], password=os.environ["PG_PASSWORD"], autocommit=True)


def stats(conn, rooms):
    now = int(time.time() * 1000)
    out = {}
    with conn.cursor() as cur:
        cur.execute("""select room_id, count(*), count(*) filter (where sender = %s), min(origin_server_ts), max(origin_server_ts),
                              count(*) filter (where origin_server_ts > %s), count(*) filter (where origin_server_ts > %s)
                       from events where type = 'm.room.message' and room_id = any(%s) group by room_id""",
                    (USER, now - 30 * 86400_000, now - 365 * 86400_000, list(rooms)))
        for room, n, mine, first, last, m30, m365 in cur.fetchall():
            out[room] = {"total": n, "mine": mine, "first": first, "last": last, "m30": m30, "m365": m365}
    return out


def combine(stats_by_room, rooms):
    s = {"total": 0, "mine": 0, "first": None, "last": None, "m30": 0, "m365": 0}
    for r in rooms:
        x = stats_by_room.get(r)
        if not x:
            continue
        for k in ("total", "mine", "m30", "m365"):
            s[k] += x[k]
        s["first"] = min(filter(None, [s["first"], x["first"]]), default=None)
        s["last"] = max(filter(None, [s["last"], x["last"]]), default=None)
    return s


KIND_TEXT = {"m.image": "[photo]", "m.video": "[video]", "m.audio": "[voice message]", "m.file": "[file]", "m.location": "[location]"}


def messages(conn, rooms, since, limit=None, newest=False):
    """Messages in these chats after `since` (ms), oldest first; edits and deleted ones left out."""
    with conn.cursor() as cur:
        cur.execute(f"""select e.event_id, e.room_id, e.sender, e.origin_server_ts, j.json from events e join event_json j using (event_id)
                        where e.type = 'm.room.message' and e.room_id = any(%s) and e.origin_server_ts > %s
                          and not exists (select 1 from redactions r where r.redacts = e.event_id)
                        order by e.origin_server_ts {'desc' if newest else 'asc'} {'limit %s' if limit else ''}""",
                    (list(rooms), since, limit) if limit else (list(rooms), since))
        rows = cur.fetchall()
    if newest:
        rows.reverse()
    out = []
    for eid, room, sender, ts, js in rows:
        try:
            content = json.loads(js).get("content") or {}
        except ValueError:
            continue
        if (content.get("m.relates_to") or {}).get("rel_type") == "m.replace":
            continue
        mt = content.get("msgtype")
        body = (content.get("body") or "").strip()
        if mt in KIND_TEXT:
            cap = body if content.get("filename") and body != content.get("filename") else ""
            text = KIND_TEXT[mt] + (" " + cap if cap else "")
            tr = content.get("fit.simas.transcript")
            if mt == "m.audio" and isinstance(tr, str):
                text += " " + tr
        else:
            body = "\n".join(l for l in body.split("\n") if not l.startswith("> "))  # drop quoted replies
            text = body
        if text:
            out.append({"id": eid, "room": room, "me": sender == USER, "ts": ts, "text": re.sub(r"\s+", " ", text)[:400]})
    return out


# --- Claude ------------------------------------------------------------------

def claude_bin():
    try:
        versions = sorted(os.listdir(CLAUDE_DIR), key=lambda v: [int(x) if x.isdigit() else 0 for x in re.split(r"[.-]", v)])
        return os.path.join(CLAUDE_DIR, versions[-1]) if versions else None
    except OSError:
        return None


def claude(system, user, timeout=240):
    env = {"PATH": "/usr/bin:/bin", "HOME": "/tmp/claude-home", "DISABLE_AUTOUPDATER": "1",
           "CLAUDE_CODE_OAUTH_TOKEN": os.environ["CLAUDE_CODE_OAUTH_TOKEN"]}
    r = subprocess.run([claude_bin(), "-p", "--model", CLAUDE_MODEL, "--tools", "", "--no-session-persistence",
                        "--system-prompt", system], input=user, capture_output=True, text=True, timeout=timeout, env=env)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "claude failed").strip()[:200])
    m = re.search(r"\{.*\}", r.stdout, re.S)
    return json.loads(m.group(0)) if m else {}


SYSTEM = """You keep Simas's private notes about the people he knows, learned from his chats with them.
You get what is known so far about one person, Simas's own settings and corrections (they are the
truth — never contradict them), and new messages between Simas and that person.
Update the notes and output ONLY JSON:
{
 "summary": "who this person is to Simas, 1-2 sentences, max 300 characters",
 "circle": one of %(circles)s,
 "strength": 0-100 (how close they are: 100 = partner/mother; ~90 = best friends of 20 years;
             ~75 = new but strong friends; ~50 = friends seen now and then; ~25 = acquaintance;
             ~5 = service/one-off),
 "reason": "why that circle and strength, max 160 characters",
 "tags": ["short lowercase interests or contexts they share with Simas, e.g. tennis, neighbours, school"],
 "met": {"how": "how they know each other, short", "since": year or null, "via": "person or place, or empty"},
 "work": {"company": "", "role": "", "industry": ""},
 "past_work": [{"company": "", "role": "", "until": year or null}],
 "new_facts": [{"text": "a lasting fact about the person, short, in English", "kind": "work|family|life|interest|plan|other", "msg": line number}],
 "outdated_facts": [ids of known facts these messages show are no longer true]
}
Rules: facts only from the messages, never guessed. Lasting things worth remembering (job, kids,
partner, where they live (city only), birthday, interests, big life events, preferences) — not
small talk or one-off logistics. Never record health, money/bank details, codes, passwords, exact
addresses or other people's phone numbers. Don't repeat known facts. Keep fields you have no new
information for as they were. Leave circle/strength consistent with Simas's corrections and his
general guidance."""


def ask_claude(name, known, edits, guidance, lines):
    payload = (f"PERSON: {name}\n\nKNOWN SO FAR:\n{json.dumps(known, ensure_ascii=False)}\n\n"
               f"SIMAS'S OWN SETTINGS FOR THIS PERSON (truth):\n{json.dumps(edits or {}, ensure_ascii=False)}\n\n"
               f"SIMAS'S CORRECTIONS ELSEWHERE (learn from them):\n{json.dumps(guidance, ensure_ascii=False)}\n\n"
               "MESSAGES (line number, date, who):\n" + "\n".join(lines))
    return claude(SYSTEM % {"circles": CIRCLES}, payload)


# --- learning ----------------------------------------------------------------

def guidance_from(edits):
    """His corrections with reasons, newest first: the suggestions learn from these."""
    out = []
    for cid, e in (edits.get("people") or {}).items():
        for field, why in (e.get("why") or {}).items():
            if why and field in e:
                out.append({"person": e.get("name") or cid, "field": field, "set_to": e[field], "why": why, "at": (e.get("at") or {}).get(field, 0)})
        for fid, f in (e.get("facts") or {}).items():
            if f.get("why"):
                out.append({"fact": f.get("text") or fid, "marked": f.get("status"), "why": f["why"], "at": f.get("at", 0)})
    out.sort(key=lambda x: -x.get("at", 0))
    rules = [r for r in edits.get("rules") or [] if isinstance(r, str)]
    return {"rules": rules, "corrections": [{k: v for k, v in x.items() if k != "at"} for x in out[:40]]}


def apply_marks(c, edits):
    """Facts he marked wrong or no longer true (in the app) — Claude doesn't see wrong ones again."""
    for cid, e in (edits.get("people") or {}).items():
        for fid, f in (e.get("facts") or {}).items():
            if f.get("status") in ("wrong", "old", "current") and str(fid).isdigit():
                c.execute("update facts set status=? where id=? and cid=?", (f["status"], int(fid), cid))
    c.commit()


def known_of(c, cid):
    row = c.execute("select learned from persons where cid=?", (cid,)).fetchone()
    learned = json.loads(row[0]) if row and row[0] else {}
    facts = [{"id": i, "text": t, "kind": k, "date": time.strftime("%Y-%m-%d", time.gmtime(ts / 1000)) if ts else None, "status": s}
             for i, t, k, ts, s in c.execute("select id, text, kind, ts, status from facts where cid=? and status != 'wrong' order by ts", (cid,))]
    return learned, facts


def learn(c, conn, cid, person, edits, guidance, since, max_chunks=1):
    """Read the messages after `since` (in chunks) and update this person's notes. Returns the
    number of messages read."""
    rooms = person["rooms"]
    msgs = messages(conn, rooms, since, limit=CHUNK_LINES if max_chunks == 1 else None, newest=max_chunks == 1)
    if not msgs:
        return 0
    first = person["name"].split(" ")[0] or "Them"
    done = 0
    for start in range(0, len(msgs), CHUNK_LINES):
        if start // CHUNK_LINES >= max_chunks:
            break
        chunk = msgs[start:start + CHUNK_LINES]
        if sum(not m["me"] for m in chunk) == 0:
            continue
        lines = [f"[{i}] {time.strftime('%Y-%m-%d', time.gmtime(m['ts'] / 1000))} {'Simas' if m['me'] else first}: {m['text']}"
                 for i, m in enumerate(chunk)]
        learned, facts = known_of(c, cid)
        out = ask_claude(person["name"], {**learned, "facts": facts}, edits, guidance, lines)
        if not out:
            continue
        now = int(time.time() * 1000)
        new = {k: out[k] for k in ("summary", "reason", "tags", "met", "work", "past_work") if k in out}
        if out.get("circle") in CIRCLES:
            new["circle"] = out["circle"]
        try:
            new["strength"] = max(0, min(100, int(out.get("strength"))))
        except (TypeError, ValueError):
            pass
        new["tags"] = sorted({str(t).strip().lower()[:24] for t in new.get("tags") or [] if str(t).strip()})[:8]
        learned = {**learned, **new, "at": now, "source": "claude"}
        for f in out.get("new_facts") or []:
            text = str(f.get("text") or "").strip()[:240]
            if not text:
                continue
            i = f.get("msg")
            src = chunk[i] if isinstance(i, int) and 0 <= i < len(chunk) else chunk[-1]
            c.execute("insert into facts (cid, text, kind, ts, room, event, added) values (?,?,?,?,?,?,?)",
                      (cid, text, str(f.get("kind") or "other")[:12], src["ts"], src["room"], src["id"], now))
        for fid in out.get("outdated_facts") or []:
            c.execute("update facts set status='old' where id=? and cid=? and status='current'", (fid, cid))
        c.execute("update persons set learned=?, last_ts=?, at=? where cid=?", (json.dumps(learned, ensure_ascii=False), chunk[-1]["ts"], now, cid))
        c.commit()
        done += len(chunk)
    return done


def seed(c, people, edits_people):
    """People without notes yet get a starting suggestion from the older learned notes (no Claude)."""
    old = account_data(PROFILES).get("rooms") or {}
    n = 0
    for cid, p in people.items():
        row = c.execute("select learned from persons where cid=?", (cid,)).fetchone()
        if row and row[0]:
            continue
        note = next((old[r] for r in p["rooms"] if r in old and old[r].get("note")), None)
        if not note:
            continue
        cat = note.get("category") or "other"
        learned = {"summary": note["note"], "circle": SEED_CIRCLE.get(cat, "acquaintance"),
                   "tags": [cat] if cat in ("tennis", "sport") else [], "source": "seed", "at": note.get("at")}
        c.execute("update persons set learned=? where cid=?", (json.dumps(learned, ensure_ascii=False), cid))
        n += 1
    c.commit()
    return n


BASE = {"partner": 95, "family": 75, "close friend": 80, "friend": 50, "colleague": 35, "former colleague": 25,
        "client": 25, "acquaintance": 15, "service": 3}


def guess_strength(circle, st):
    """When Claude hasn't suggested one: the circle's usual level, nudged by how much you write."""
    base = BASE.get(circle, 15)
    act = math.log2((st.get("m365") or 0) + 1) * 2.2 - 6
    return int(max(0, min(100, base + act)))


# --- publish -----------------------------------------------------------------

def build(c, people, st_by_room, edits):
    out = {}
    for cid, p in people.items():
        learned, _ = known_of(c, cid)
        st = combine(st_by_room, p["rooms"])
        if not learned and st["total"] < 6:
            continue  # couriers, one-off codes: not worth a profile
        if learned and "strength" not in learned and learned.get("circle"):
            learned["strength"] = guess_strength(learned["circle"], st)
            learned.setdefault("reason", "From the circle and how often you write")
        facts = [{"id": i, "text": t, "kind": k, "ts": ts, "room": r, "event": e, "status": s}
                 for i, t, k, ts, r, e, s in c.execute("select id, text, kind, ts, room, event, status from facts where cid=? order by ts desc", (cid,))]
        out[cid] = {"name": p["name"], "rooms": p["rooms"], "href": p.get("href"), "learned": learned, "facts": facts, "stats": st}
    return out


def final(person, e):
    """His value if he set one, else the learned one."""
    l = person.get("learned") or {}
    f = {k: e.get(k) if e.get(k) not in (None, "") else l.get(k) for k in ("circle", "strength", "summary")}
    work = l.get("work") or {}
    f["company"] = e.get("company") if e.get("company") is not None else work.get("company")
    f["role"] = e.get("role") if e.get("role") is not None else work.get("role")
    f["industry"] = e.get("industry") if e.get("industry") is not None else work.get("industry")
    met = l.get("met") or {}
    f["met"] = e.get("met") if e.get("met") is not None else met.get("how")
    f["since"] = e.get("since") if e.get("since") is not None else met.get("since")
    removed = set(e.get("tagsRemoved") or [])
    f["tags"] = sorted((set(l.get("tags") or []) - removed) | set(e.get("tags") or []))
    return f


def note_block(f):
    lines = []
    how = " · ".join(str(x) for x in [f.get("met"), f"since {f['since']}" if f.get("since") else None] if x)
    if how:
        lines.append(f"How we know each other: {how}")
    work = ", ".join(x for x in [f.get("role"), f.get("company")] if x)
    if work:
        lines.append(f"Works: {work}" + (f" ({f['industry']})" if f.get("industry") else ""))
    return (NOTE_MARK + "\n" + "\n".join(lines)) if lines else ""


def with_block(note, block):
    own = (note or "").split(NOTE_MARK)[0].rstrip()
    return (own + ("\n\n" if own and block else "") + block).strip()


def icloud(c, people_out, edits, contacts_by_href):
    """Card changes for the contacts service; conflicts go into the published data for the app."""
    if not contacts_by_href:
        return 0
    sent = kv(c, "icloud_sent") or {}
    reqs = account_data(AUTOREQ).get("requests") or []  # contacts takes done ones off
    n = 0
    for cid, p in people_out.items():
        href = p.get("href")
        card = contacts_by_href.get(href)
        if not card:
            continue
        e = (edits.get("people") or {}).get(cid) or {}
        f = final(p, e)
        d = card.get("d") or {}
        keep = e.get("keepCard") or {}
        changes, conflicts = {}, []
        for field, want in (("org", f.get("company")), ("title", f.get("role"))):
            have = (d.get(field) or "").strip()
            if not want:
                continue
            if not have:
                changes[field] = want
            elif have.lower() != want.strip().lower() and keep.get(field) != have:
                conflicts.append({"field": field, "card": have, "learned": want})
        block = note_block(f)
        note = with_block(d.get("note"), block)
        if block and note != (d.get("note") or "").strip():
            changes["note"] = note
        p["card"] = {"conflicts": conflicts}
        # groups only once he has set or confirmed the circle (suggestions stay in Inbox)
        groups = (sorted({GROUP_OF[e["circle"]]} if e.get("circle") in GROUP_OF else set())
                  + sorted({t.capitalize() for t in f.get("tags") or []})) if e.get("circle") else []
        managed = sorted(set(GROUP_OF.values()) | set((sent.get(href) or {}).get("groups") or []) | set(groups))
        last = sent.get(href) or {}
        stamp = int(time.time() * 1000)
        if changes and last.get("changes") != changes:
            reqs.append({"rid": f"people-{cid[:12]}-{stamp}-c", "kind": "edit", "href": href, "changes": changes, "at": stamp})
            last["changes"] = changes
            n += 1
        if last.get("groups", []) != groups:
            reqs.append({"rid": f"people-{cid[:12]}-{stamp}-g", "kind": "groups", "href": href, "groups": groups, "managed": managed, "at": stamp})
            last["groups"] = groups
            n += 1
        sent[href] = last
    if n:
        set_account_data(AUTOREQ, {"requests": reqs})
        kv(c, "icloud_sent", sent)
    return n


def publish(c, conn=None):
    directory = (account_data(DIRECTORY).get("people") or [])
    if not directory:
        log("no directory from the app yet (open Inbox once)")
        return
    people = sync_persons(c, directory)
    edits = account_data(EDITS)
    apply_marks(c, edits)
    seed(c, people, edits.get("people") or {})
    own = conn is None
    conn = conn or pg()
    try:
        st = stats(conn, {r for p in people.values() for r in p["rooms"]})
    finally:
        if own:
            conn.close()
    out = build(c, people, st, edits)
    contacts_by_href = {}
    ptr = account_data(CONTACTS)
    if ptr.get("url") and ptr.get("source") == "icloud":
        try:
            contacts_by_href = {x["id"]: x for x in media_json(ptr["url"]).get("contacts") or []}
        except Exception as e:
            log("contacts not readable:", e)
    sent = icloud(c, out, edits, contacts_by_href)
    payload = json.dumps({"v": 1, "at": int(time.time() * 1000), "circles": CIRCLES, "people": out}, ensure_ascii=False, separators=(",", ":")).encode()
    digest = hashlib.sha256(json.dumps(out, sort_keys=True).encode()).hexdigest()
    if kv(c, "published") != digest:
        mxc = matrix("POST", "/_matrix/media/v3/upload?filename=people.json", raw=payload)["content_uri"]
        set_account_data(POINTER, {"url": mxc, "count": len(out), "at": int(time.time() * 1000)})
        kv(c, "published", digest)
        log(f"published {len(out)} people ({sent} iCloud changes queued)")


def run(c, backfill=None):
    directory = account_data(DIRECTORY).get("people") or []
    people = sync_persons(c, directory)
    edits = account_data(EDITS)
    guidance = guidance_from(edits)
    apply_marks(c, edits)
    start = kv(c, "start")
    if start is None:  # first run: learn from now on; whole histories wait for --backfill
        start = int(time.time() * 1000) - 86400_000
        kv(c, "start", start)
    conn = pg()
    try:
        st = stats(conn, {r for p in people.values() for r in p["rooms"]})
        todo = []
        for cid, p in people.items():
            last = c.execute("select last_ts from persons where cid=?", (cid,)).fetchone()[0] or 0
            s = combine(st, p["rooms"])
            if backfill is not None:
                if s["total"] >= 20 and s["total"] - s["mine"] >= 5 and not kv(c, f"backfilled:{cid}"):
                    todo.append((s["total"], cid, 0))
            elif (s["last"] or 0) > max(last, start):
                todo.append((s["m30"], cid, max(last, start)))
        todo.sort(reverse=True)
        todo = todo[: (backfill or 10**6) if backfill is not None else MAX_PER_NIGHT]
        log(f"{'backfill' if backfill is not None else 'nightly'}: {len(todo)} people")
        for _, cid, since in todo:
            e = (edits.get("people") or {}).get(cid) or {}
            try:
                n = learn(c, conn, cid, people[cid], e, guidance, since, max_chunks=50 if backfill is not None else 1)
                if backfill is not None:
                    kv(c, f"backfilled:{cid}", int(time.time()))
                log(f"  {cid[:10]}…: {n} messages")
            except Exception as ex:
                log("  failed:", str(ex)[:160])
                if "401" in str(ex) or "auth" in str(ex).lower():
                    break
        publish(c, conn)
    finally:
        conn.close()


def loop():
    c = db()
    last_edits = None
    while True:
        try:
            hm = time.strftime("%H:%M", time.gmtime())
            today = time.strftime("%Y-%m-%d", time.gmtime())
            if hm >= NIGHT_UTC and kv(c, "night") != today:
                kv(c, "night", today)
                run(c)
            else:
                # his edits change the iCloud side (groups, note): carry them over within minutes
                e = json.dumps(account_data(EDITS), sort_keys=True) + json.dumps(account_data(DIRECTORY).get("people") or [], sort_keys=True)
                h = hashlib.sha256(e.encode()).hexdigest()
                if h != last_edits:
                    last_edits = h
                    publish(c)
        except Exception as ex:
            log("error:", str(ex)[:200])
        time.sleep(300)


if __name__ == "__main__":
    if "--loop" in sys.argv:
        loop()
    elif "--once" in sys.argv:
        run(db())
    elif "--backfill" in sys.argv:
        i = sys.argv.index("--backfill")
        run(db(), backfill=int(sys.argv[i + 1]) if len(sys.argv) > i + 1 else 10**6)
    elif "--publish" in sys.argv:
        publish(db())
    else:
        print(__doc__)
