"""Voice messages → text, so he can read them instead of listening.

Watches all his chats (as @s, through the double-puppet appservice). For every new voice
message (and any older one the app asks for), it downloads the audio, transcribes it here
on sky with Whisper (faster-whisper, large-v3-turbo, int8 on the CPU; the audio never leaves
sky), then asks Claude to fix clearly misheard words (text only; his subscription, same token as
the reply suggestions). The result goes into room account data

    fit.simas.inbox.transcripts = {"t": {event_id: {"text", "lang", "raw"?, "at"}}, "requests": [...]}

which the app shows under the voice message and in the chat list. The app asks for older voice
messages by adding their event ids to "requests" (the "Transcribe" button).
"""
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HS = os.environ.get("HS", "http://synapse:8008")
USER = os.environ["USER_ID"]
MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
THREADS = int(os.environ.get("WHISPER_THREADS", "4"))  # leave CPU for Synapse and the bridges
MAX_SECONDS = 600
TOKEN = re.search(r'^as_token:\s*"?([^"\s]+)"?', open(os.environ.get("AS_TOKEN_FILE", "/app/doublepuppet.yaml")).read(), re.M).group(1)
TYPE = "fit.simas.inbox.transcripts"
KEEP = 300  # transcripts kept per chat
CLAUDE_DIR = os.environ.get("CLAUDE_DIR", "/opt/claude")

FILTER = {
    "presence": {"not_types": ["*"]},
    "account_data": {"not_types": ["*"]},
    "room": {
        "timeline": {"limit": 20, "types": ["m.room.message"]},
        "state": {"types": []},
        "ephemeral": {"not_types": ["*"]},
        "account_data": {"types": [TYPE]},
    },
}

CLEANUP = (
    "You clean up automatic transcripts of voice messages, mostly Lithuanian, sometimes English. The "
    "speech recognizer mishears some words. Fix only words that are clearly misheard, using context and "
    "normal spoken Lithuanian (keep slang, casual tone, swear words and English words as said); fix "
    "obviously wrong word endings; add punctuation where it helps. Use correct Lithuanian spelling with "
    "diacritics. Do NOT add, remove or reorder content, do not summarize, do not translate. If unsure, keep "
    "the original word. Output only the corrected text."
)


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def matrix(method, path, body=None, params=None, timeout=90):
    qs = urllib.parse.urlencode({"user_id": USER, **(params or {})})
    req = urllib.request.Request(f"{HS}{path}?{qs}", data=json.dumps(body).encode() if body is not None else None,
                                 method=method, headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def q(s):
    return urllib.parse.quote(s, safe="")


def download(mxc, dest):
    server, mid = mxc[6:].split("/", 1)
    req = urllib.request.Request(f"{HS}/_matrix/client/v1/media/download/{q(server)}/{q(mid)}?user_id={q(USER)}",
                                 headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())


def is_voice(ev):
    c = ev.get("content") or {}
    if ev.get("type") != "m.room.message" or c.get("msgtype") != "m.audio" or not str(c.get("url", "")).startswith("mxc://"):
        return False
    dur = (c.get("info") or {}).get("duration") or 0
    return dur <= MAX_SECONDS * 1000  # voice notes and short audio; skip long recordings


# --- Claude clean-up (text only) ------------------------------------------------------

def claude_bin():
    try:
        v = sorted(os.listdir(CLAUDE_DIR), key=lambda x: [int(p) if p.isdigit() else 0 for p in re.split(r"[.-]", x)])
        return os.path.join(CLAUDE_DIR, v[-1]) if v else None
    except OSError:
        return None


def cleanup(text):
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    exe = claude_bin()
    if not token or not exe or len(text) < 3:
        return text
    env = {"PATH": "/usr/bin:/bin", "HOME": "/tmp/claude-home", "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_OAUTH_TOKEN": token}
    try:
        r = subprocess.run([exe, "-p", "--model", os.environ.get("CLAUDE_MODEL", "sonnet"), "--tools", "", "--no-session-persistence",
                            "--system-prompt", CLEANUP], input=text, capture_output=True, text=True, timeout=90, env=env)
        out = r.stdout.strip()
        # a clean-up never changes the length much; anything else is a refusal or a ramble
        if r.returncode == 0 and out and 0.5 < len(out) / max(1, len(text)) < 1.6:
            return out
    except Exception as e:  # noqa: BLE001
        log("clean-up failed:", str(e)[:100])
    return text


# --- Whisper ---------------------------------------------------------------------------

_model = None


def whisper():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        t = time.time()
        _model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS, download_root="/models")
        log(f"Whisper {MODEL} loaded in {time.time() - t:.0f}s")
    return _model


def transcribe(ev):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "voice")
        download(ev["content"]["url"], path)
        t = time.time()
        segs, info = whisper().transcribe(path, beam_size=5, vad_filter=True)
        raw = " ".join(s.text.strip() for s in segs).strip()
        heard = time.time() - t
    if not raw:
        return {"text": "", "lang": info.language, "at": int(time.time() * 1000)}
    text = cleanup(raw)
    log(f"voice message ({info.language}, {heard:.0f}s + clean-up) transcribed")
    out = {"text": text, "lang": info.language, "at": int(time.time() * 1000)}
    if text != raw:
        out["raw"] = raw
    return out


# --- storage in room account data --------------------------------------------------------

def load(room):
    try:
        return matrix("GET", f"/_matrix/client/v3/user/{q(USER)}/rooms/{q(room)}/account_data/{TYPE}")
    except urllib.error.HTTPError:
        return {}


def save(room, doc):
    t = doc.get("t") or {}
    if len(t) > KEEP:
        doc["t"] = dict(sorted(t.items(), key=lambda kv: kv[1].get("at", 0))[-KEEP:])
    matrix("PUT", f"/_matrix/client/v3/user/{q(USER)}/rooms/{q(room)}/account_data/{TYPE}", doc)


def handle(room, ev, doc=None):
    doc = doc if doc is not None else load(room)
    doc.setdefault("t", {})
    if ev["event_id"] in doc["t"]:
        return doc
    doc["t"][ev["event_id"]] = {"pending": True, "at": int(time.time() * 1000)}  # the app shows "Transcribing…"
    save(room, doc)
    try:
        doc["t"][ev["event_id"]] = transcribe(ev)
    except Exception as e:  # noqa: BLE001
        log("transcription failed:", str(e)[:150])
        doc["t"][ev["event_id"]] = {"error": "Couldn't transcribe this one", "at": int(time.time() * 1000)}
    doc["requests"] = [r for r in doc.get("requests", []) if r != ev["event_id"]]
    save(room, doc)
    return doc


def requested(room, doc):
    """Older voice messages the app asked for (the Transcribe / Transcribe again button)."""
    for eid in list(doc.get("requests", [])):
        cur = (doc.get("t") or {}).get(eid)
        if cur and not cur.get("redo") and (cur.get("text") is not None or cur.get("pending")):
            continue
        try:
            ev = matrix("GET", f"/_matrix/client/v3/rooms/{q(room)}/event/{q(eid)}")
        except Exception:  # noqa: BLE001
            doc["requests"] = [r for r in doc["requests"] if r != eid]
            continue
        if is_voice(ev):
            (doc.setdefault("t", {})).pop(eid, None)
            doc = handle(room, ev, doc)


def main():
    since = None
    while True:
        try:
            params = {"filter": json.dumps(FILTER), "timeout": "30000"}
            if since:
                params["since"] = since
            res = matrix("GET", "/_matrix/client/v3/sync", params=params)
            for room, r in (res.get("rooms", {}).get("join") or {}).items():
                for ad in (r.get("account_data") or {}).get("events", []):
                    if ad.get("type") == TYPE and (ad.get("content") or {}).get("requests"):
                        requested(room, ad["content"])
                if since is None:
                    continue  # first sync: don't redo the whole history, only new ones from now
                for ev in (r.get("timeline") or {}).get("events", []):
                    if is_voice(ev):
                        handle(room, ev)
            since = res.get("next_batch", since)
        except Exception as e:  # noqa: BLE001
            log("sync failed:", str(e)[:150])
            time.sleep(10)


if __name__ == "__main__":
    whisper()  # load once at start
    main()
