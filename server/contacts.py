#!/usr/bin/env python3
"""Hand your phone book (iCloud contacts, via BlueBubbles on the Mac) to the app.

Fetches the contacts from BlueBubbles, stores them as a private file in your
Matrix media and points account data `fit.simas.inbox.contacts` at it. The
app uses it to show people by the names in your contacts. Runs every 15
minutes from cron (contacts.sh); only uploads when something changed.
Standard library only.
"""
import hashlib, json, os, sys, urllib.parse, urllib.request

BB_URL = os.environ["BLUEBUBBLES_URL"].rstrip("/")
BB_PASSWORD = os.environ["BLUEBUBBLES_PASSWORD"]
HS = os.environ.get("HS", "http://synapse:8008")
USER = os.environ["USER_ID"]
TOKEN = os.environ["AS_TOKEN"]  # the double-puppet appservice may act as you
STATE = os.environ.get("STATE", "/work/data/contacts.state")


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url), timeout=120) as r:
        return json.loads(r.read())


def matrix(method, path, body=None, raw=None, ctype="application/json"):
    sep = "&" if "?" in path else "?"
    url = f"{HS}{path}{sep}user_id={urllib.parse.quote(USER)}"
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def main():
    data = get(f"{BB_URL}/api/v1/contact?{urllib.parse.urlencode({'password': BB_PASSWORD})}").get("data") or []
    contacts = []
    for c in data:
        name = (c.get("displayName") or " ".join(x for x in [c.get("firstName"), c.get("lastName")] if x) or c.get("nickname") or "").strip()
        phones = [p["address"] for p in c.get("phoneNumbers") or [] if p.get("address")]
        emails = [e["address"].lower() for e in c.get("emails") or [] if e.get("address")]
        if name and (phones or emails):
            contacts.append({"id": c.get("id"), "n": name, "p": phones, "e": emails})
    if not contacts:
        sys.exit("BlueBubbles returned no contacts; leaving the app's copy as it is.")
    contacts.sort(key=lambda c: (c["n"], c.get("id") or ""))
    payload = json.dumps({"v": 1, "contacts": contacts}, ensure_ascii=False, separators=(",", ":")).encode()
    digest = hashlib.sha256(payload).hexdigest()
    try:
        if open(STATE).read().strip() == digest:
            print(f"contacts unchanged ({len(contacts)})")
            return
    except FileNotFoundError:
        pass
    mxc = matrix("POST", "/_matrix/media/v3/upload?filename=contacts.json", raw=payload)["content_uri"]
    matrix("PUT", f"/_matrix/client/v3/user/{urllib.parse.quote(USER)}/account_data/fit.simas.inbox.contacts",
           {"url": mxc, "count": len(contacts), "sha256": digest})
    with open(STATE, "w") as f:
        f.write(digest)
    print(f"contacts updated: {len(contacts)}")


if __name__ == "__main__":
    main()
