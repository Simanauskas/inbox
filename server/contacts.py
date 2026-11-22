#!/usr/bin/env python3
"""Your phone book for the Inbox app — read from iCloud (CardDAV), with
BlueBubbles on the Mac as a fallback — and contact-card changes you confirm in
the app, written back to iCloud.

Runs as the `contacts` service (docker compose), standard library only:
  - every 10 minutes: fetch contacts, store them as a private JSON file in your
    Matrix media and point account data `fit.simas.inbox.contacts` at it
    (only when something changed);
  - every 20 seconds: look at `fit.simas.inbox.contact_requests` (written by the
    app when you tap "Save to iCloud") and carry them out; outcomes go to
    `fit.simas.inbox.contact_results`.

  python contacts.py --loop     the service
  python contacts.py --once     one refresh (+ pending requests), then exit

Env: ICLOUD_USER + ICLOUD_APP_PASSWORD (app-specific password) for iCloud;
ICLOUD_CARDDAV_URL (default https://contacts.icloud.com/); BLUEBUBBLES_URL +
BLUEBUBBLES_PASSWORD as fallback; USER_ID; AS_TOKEN or AS_TOKEN_FILE (the
double-puppet appservice registration, which may act as you); HS; STATE.
"""
import base64, hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request, uuid
import xml.etree.ElementTree as ET

HS = os.environ.get("HS", "http://synapse:8008")
USER = os.environ["USER_ID"]
STATE = os.environ.get("STATE", "/state/contacts.state")
ICLOUD_USER = os.environ.get("ICLOUD_USER", "")
ICLOUD_PASS = os.environ.get("ICLOUD_APP_PASSWORD", "").replace(" ", "")
CARDDAV_URL = os.environ.get("ICLOUD_CARDDAV_URL") or "https://contacts.icloud.com/"
BB_URL = (os.environ.get("BLUEBUBBLES_URL") or "").rstrip("/")
BB_PASSWORD = os.environ.get("BLUEBUBBLES_PASSWORD", "")
REFRESH_SECONDS = int(os.environ.get("REFRESH_SECONDS", "600"))
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "20"))

POINTER = "fit.simas.inbox.contacts"
REQUESTS = "fit.simas.inbox.contact_requests"
RESULTS = "fit.simas.inbox.contact_results"


def as_token():
    if os.environ.get("AS_TOKEN"):
        return os.environ["AS_TOKEN"]
    text = open(os.environ.get("AS_TOKEN_FILE", "/app/doublepuppet.yaml")).read()
    return re.search(r'^as_token:\s*"?([^"\s]+)"?', text, re.M).group(1)


TOKEN = as_token()


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


# --- Matrix (acting as you through the double-puppet appservice) ------------

def matrix(method, path, body=None, raw=None, ctype="application/json"):
    sep = "&" if "?" in path else "?"
    url = f"{HS}{path}{sep}user_id={urllib.parse.quote(USER)}"
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def account_data(kind):
    try:
        return matrix("GET", f"/_matrix/client/v3/user/{urllib.parse.quote(USER)}/account_data/{kind}")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        raise


def set_account_data(kind, content):
    matrix("PUT", f"/_matrix/client/v3/user/{urllib.parse.quote(USER)}/account_data/{kind}", content)


# --- CardDAV (iCloud) -------------------------------------------------------

NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:carddav"}


def dav(method, url, body=None, depth=None, headers=None, redirects=5):
    h = {"Authorization": "Basic " + base64.b64encode(f"{ICLOUD_USER}:{ICLOUD_PASS}".encode()).decode()}
    if body is not None:
        h["Content-Type"] = "application/xml; charset=utf-8" if body.lstrip().startswith(b"<") else "text/vcard; charset=utf-8"
    if depth is not None:
        h["Depth"] = str(depth)
    h.update(headers or {})
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 307, 308) and redirects and e.headers.get("Location"):
            return dav(method, urllib.parse.urljoin(url, e.headers["Location"]), body, depth, headers, redirects - 1)
        return e.code, dict(e.headers), e.read()


def propfind(url, props, depth=0):
    body = ('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">'
            f"<d:prop>{props}</d:prop></d:propfind>").encode()
    status, _, data = dav("PROPFIND", url, body, depth)
    if status == 401:
        raise SystemExit("iCloud refused the login: check ICLOUD_USER and the app-specific password.")
    if status != 207:
        raise RuntimeError(f"PROPFIND {url}: HTTP {status}")
    return ET.fromstring(data)


def addressbooks():
    """Discover the address books: principal → address book home → books."""
    root = propfind(CARDDAV_URL, "<d:current-user-principal/>")
    principal = urllib.parse.urljoin(CARDDAV_URL, root.find(".//d:current-user-principal/d:href", NS).text.strip())
    root = propfind(principal, "<c:addressbook-home-set/>")
    home = urllib.parse.urljoin(principal, root.find(".//c:addressbook-home-set/d:href", NS).text.strip())
    root = propfind(home, "<d:resourcetype/><d:displayname/>", depth=1)
    books = []
    for resp in root.findall("d:response", NS):
        if resp.find(".//d:resourcetype/c:addressbook", NS) is not None:
            books.append(urllib.parse.urljoin(home, resp.find("d:href", NS).text.strip()))
    if not books:
        raise RuntimeError("no address book found in iCloud")
    return books


def unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text).replace("\r\n", "\n").split("\n")


def unescape(v):
    return re.sub(r"\\([,;\\nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), v)


def parse_vcard(text):
    """FN / N / ORG, phones and emails of one vCard (None for contact groups)."""
    fields = {}
    phones, emails = [], []
    for line in unfold(text):
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        name = key.split(";")[0].split(".")[-1].upper()
        if name == "X-ADDRESSBOOKSERVER-KIND" and value.strip().lower() == "group":
            return None
        if name == "TEL":
            phones.append(value.strip())
        elif name == "EMAIL":
            emails.append(value.strip().lower())
        elif name in ("FN", "N", "ORG", "NICKNAME") and name not in fields:
            fields[name] = unescape(value).strip()
    n = fields.get("FN") or " ".join(p for p in reversed((fields.get("N") or "").split(";")[:2]) if p) or fields.get("ORG", "").split(";")[0] or fields.get("NICKNAME", "")
    return {"n": n.strip(), "p": phones, "e": emails}


def icloud_contacts():
    out = []
    books = addressbooks()
    query = ('<?xml version="1.0" encoding="utf-8"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">'
             "<d:prop><d:getetag/><c:address-data/></d:prop></c:addressbook-query>").encode()
    for book in books:
        status, _, data = dav("REPORT", book, query, depth=1)
        if status != 207:
            raise RuntimeError(f"REPORT {book}: HTTP {status}")
        for resp in ET.fromstring(data).findall("d:response", NS):
            card = resp.find(".//c:address-data", NS)
            if card is None or not card.text:
                continue
            c = parse_vcard(card.text)
            if c and c["n"] and (c["p"] or c["e"]):
                c["id"] = urllib.parse.urljoin(book, resp.find("d:href", NS).text.strip())
                out.append(c)
    return out, books[0]


def bluebubbles_contacts():
    url = f"{BB_URL}/api/v1/contact?{urllib.parse.urlencode({'password': BB_PASSWORD})}"
    with urllib.request.urlopen(urllib.request.Request(url), timeout=120) as r:
        data = json.loads(r.read()).get("data") or []
    out = []
    for c in data:
        name = (c.get("displayName") or " ".join(x for x in [c.get("firstName"), c.get("lastName")] if x) or c.get("nickname") or "").strip()
        phones = [p["address"] for p in c.get("phoneNumbers") or [] if p.get("address")]
        emails = [e["address"].lower() for e in c.get("emails") or [] if e.get("address")]
        if name and (phones or emails):
            out.append({"id": c.get("id"), "n": name, "p": phones, "e": emails})
    return out


# --- refresh: contacts → app -----------------------------------------------

BOOK = None  # where new contacts go (iCloud)


def refresh(force=False):
    global BOOK
    if ICLOUD_USER and ICLOUD_PASS:
        contacts, BOOK = icloud_contacts()
        source = "icloud"
    elif BB_URL and BB_PASSWORD:
        contacts, source = bluebubbles_contacts(), "bluebubbles"
    else:
        log("no contacts source configured (ICLOUD_USER/ICLOUD_APP_PASSWORD or BLUEBUBBLES_*)")
        return
    if not contacts:
        log(f"{source} returned no contacts; leaving the app's copy as it is")
        return
    contacts.sort(key=lambda c: (c["n"], c.get("id") or ""))
    payload = json.dumps({"v": 1, "source": source, "contacts": contacts}, ensure_ascii=False, separators=(",", ":")).encode()
    digest = hashlib.sha256(payload).hexdigest()
    try:
        if not force and open(STATE).read().strip() == digest:
            return
    except FileNotFoundError:
        pass
    mxc = matrix("POST", "/_matrix/media/v3/upload?filename=contacts.json", raw=payload)["content_uri"]
    set_account_data(POINTER, {"url": mxc, "count": len(contacts), "sha256": digest, "source": source, "writable": source == "icloud"})
    os.makedirs(os.path.dirname(STATE) or ".", exist_ok=True)
    with open(STATE, "w") as f:
        f.write(digest)
    log(f"contacts updated: {len(contacts)} from {source}")


# --- requests: confirmed changes → iCloud ----------------------------------

def normalize_phone(raw):
    """Digits in international form, like the app: old Lithuanian '8 6…' and '6…' numbers become 370…."""
    d = re.sub(r"[^\d+]", "", raw or "")
    if d.startswith("+"):
        return d[1:]
    if d.startswith("00"):
        return d[2:]
    if re.fullmatch(r"8[3-9]\d{7}", d):
        return "370" + d[1:]
    if re.fullmatch(r"6\d{7}", d):
        return "370" + d
    return d


def vcard_lines(phones, emails):
    return [f"TEL;type=CELL;type=VOICE:+{p}" for p in phones] + [f"EMAIL;type=INTERNET:{e}" for e in emails]


def esc(v):
    return re.sub(r"([,;\\])", r"\\\1", v)


def update_card(href, phones, emails):
    for _ in range(2):
        status, headers, data = dav("GET", href)
        if status != 200:
            raise RuntimeError(f"couldn't read the contact (HTTP {status})")
        etag = headers.get("ETag") or headers.get("Etag") or headers.get("etag")
        text = data.decode()
        nl = "\r\n" if "\r\n" in text else "\n"
        existing = parse_vcard(text) or {"p": [], "e": []}
        have = {normalize_phone(p)[-9:] for p in existing["p"]}
        add = vcard_lines([p for p in phones if normalize_phone(p)[-9:] not in have], [e for e in emails if e.lower() not in existing["e"]])
        if not add:
            return "already on the card"
        idx = text.rstrip().rfind("END:VCARD")
        new = text[:idx] + nl.join(add) + nl + "END:VCARD" + nl
        status, _, _ = dav("PUT", href, new.encode(), headers={"If-Match": etag} if etag else {})
        if status in (200, 201, 204):
            return "updated"
        if status != 412:  # 412: changed meanwhile → read again and retry once
            raise RuntimeError(f"iCloud refused the change (HTTP {status})")
    raise RuntimeError("the contact kept changing; try again")


def create_card(name, phones, emails):
    if not BOOK:
        raise RuntimeError("no iCloud address book")
    parts = name.split()
    last = parts.pop() if len(parts) > 1 else ""
    uid = str(uuid.uuid4()).upper()
    card = "\r\n".join(["BEGIN:VCARD", "VERSION:3.0", f"UID:{uid}", f"FN:{esc(name)}", f"N:{esc(last)};{esc(' '.join(parts))};;;",
                        *vcard_lines(phones, emails), "END:VCARD"]) + "\r\n"
    href = BOOK.rstrip("/") + f"/{uid}.vcf"
    status, _, _ = dav("PUT", href, card.encode(), headers={"If-None-Match": "*"})
    if status not in (200, 201, 204):
        raise RuntimeError(f"iCloud refused the new contact (HTTP {status})")
    return "created"


def process_requests():
    if not (ICLOUD_USER and ICLOUD_PASS):
        return False
    requests = account_data(REQUESTS).get("requests") or []
    results = account_data(RESULTS).get("results") or {}
    todo = [r for r in requests if r.get("rid") and r["rid"] not in results]
    if not todo:
        return False
    if BOOK is None:
        refresh()
    for r in todo:
        phones = [re.sub(r"\D", "", p) for p in r.get("phones") or [] if re.sub(r"\D", "", p)]
        emails = [e for e in r.get("emails") or [] if "@" in e]
        try:
            if r.get("kind") == "update" and r.get("href"):
                msg = update_card(r["href"], phones, emails)
            elif r.get("kind") == "create" and r.get("name"):
                msg = create_card(r["name"].strip(), phones, emails)
            else:
                raise RuntimeError("incomplete request")
            results[r["rid"]] = {"ok": True, "message": msg, "at": int(time.time() * 1000)}
            log(f"contact {r.get('kind')}: {msg}")
        except Exception as e:  # report back to the app instead of failing the service
            results[r["rid"]] = {"ok": False, "message": str(e), "at": int(time.time() * 1000)}
            log(f"contact {r.get('kind')} failed: {e}")
    # keep the newest 100 outcomes
    results = dict(sorted(results.items(), key=lambda kv: kv[1].get("at", 0))[-100:])
    set_account_data(RESULTS, {"results": results})
    return True


def main():
    if "--once" in sys.argv:
        refresh()
        if process_requests():
            refresh()
        return
    last = 0
    while True:
        try:
            changed = process_requests()
            if changed or time.time() - last > REFRESH_SECONDS:
                refresh()
                last = time.time()
        except SystemExit as e:
            log(e)
            time.sleep(600)
        except Exception as e:
            log("error:", e)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
