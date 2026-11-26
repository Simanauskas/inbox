"""When you read a chat anywhere, its notifications disappear from the iPhone.

Watches your read receipts (from any device: Mac, web, the iPhone app itself). When a
chat that had notifications is read, it asks Sygnal to send the iPhone app a silent
push listing that chat; the app removes those notifications from the lock screen and
Notification Centre. Only chats that actually notified are sent, because iOS limits
how many silent pushes an app gets.

The Mac web app needs nothing from here: it's open, sees the receipt and closes them itself.
"""
import json
import os
import re
import time
import urllib.parse
import urllib.request

HS = os.environ.get("HS", "http://synapse:8008")
USER = os.environ["USER_ID"]
SYGNAL = os.environ.get("SYGNAL", "http://sygnal:5000/_matrix/push/v1/notify")
IOS_APP = os.environ.get("IOS_APP_ID", "fit.simas.inbox.ios")
TOKEN = re.search(r'^as_token:\s*"?([^"\s]+)"?', open(os.environ.get("AS_TOKEN_FILE", "/app/doublepuppet.yaml")).read(), re.M).group(1)

FILTER = {
    "presence": {"not_types": ["*"]},
    "account_data": {"not_types": ["*"]},
    "room": {
        "timeline": {"limit": 1, "types": ["m.room.message"]},
        "state": {"types": []},
        "ephemeral": {"types": ["m.receipt"]},
        "account_data": {"not_types": ["*"]},
    },
}


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def matrix(method, path, body=None, params=None, timeout=90):
    qs = urllib.parse.urlencode({"user_id": USER, **(params or {})})
    req = urllib.request.Request(f"{HS}{path}?{qs}", data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def ios_devices():
    return [{"app_id": p["app_id"], "pushkey": p["pushkey"], "data": {}}
            for p in matrix("GET", "/_matrix/client/v3/pushers").get("pushers", []) if p["app_id"] == IOS_APP]


def tell_iphone(rooms):
    devices = ios_devices()
    if not devices:
        return
    body = {"notification": {"type": "fit.simas.inbox.read", "prio": "low", "content": {"rooms": rooms[:50]}, "devices": devices}}
    req = urllib.request.Request(SYGNAL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()


def main():
    since = None
    notified = set()  # chats with notifications you haven't read yet
    while True:
        try:
            params = {"filter": json.dumps(FILTER), "timeout": "30000"}
            if since:
                params["since"] = since
            res = matrix("GET", "/_matrix/client/v3/sync", params=params)
            read = []
            for rid, r in (res.get("rooms", {}).get("join") or {}).items():
                count = (r.get("unread_notifications") or {}).get("notification_count")
                mine = any(USER in (types.get("m.read") or {}) or USER in (types.get("m.read.private") or {})
                           for ev in (r.get("ephemeral") or {}).get("events", []) if ev.get("type") == "m.receipt"
                           for types in ev.get("content", {}).values())
                if count:
                    notified.add(rid)
                if since and mine and rid in notified and not count:
                    read.append(rid)
                    notified.discard(rid)
                elif count == 0:
                    notified.discard(rid)
            if read:
                try:
                    tell_iphone(read)
                    log(f"read on some device: cleared {len(read)} chat(s) on the iPhone")
                except Exception as e:  # noqa: BLE001
                    log("couldn't reach Sygnal:", e)
            since = res.get("next_batch", since)
        except Exception as e:  # noqa: BLE001
            log("sync failed:", e)
            time.sleep(10)


if __name__ == "__main__":
    main()
