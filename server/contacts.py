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


LABELS = {"CELL": "mobile", "IPHONE": "iPhone", "HOME": "home", "WORK": "work", "MAIN": "main", "OTHER": "other",
          "PAGER": "pager", "FAX": "fax", "INTERNET": "", "VOICE": "", "PREF": "", "X-INTERNET": ""}


def apple_label(v):
    """'_$!<Mobile>!$_' → 'mobile'; custom labels stay as typed."""
    m = re.fullmatch(r"_\$!<(.+)>!\$_", v.strip())
    return (m.group(1).lower() if m else v.strip())


def entry_name(key):
    """('item1', 'TEL', ['type=CELL', ...]) from 'item1.TEL;type=CELL'."""
    head, *params = key.split(";")
    group, _, name = head.rpartition(".")
    return group, name.upper(), params


def type_label(params):
    types = []
    for p in params:
        k, _, v = p.partition("=")
        for t in (v if k.lower() == "type" else k).split(","):
            t = t.strip().upper()
            if t and LABELS.get(t, t.lower()):
                types.append(LABELS.get(t, t.lower()))
    for pref in ("iPhone", "mobile", "home", "work", "main"):
        if pref in types:
            return pref
    return types[0] if types else ""


def parse_vcard(text):
    """Name, phones and emails (for matching) plus the card's details (for the contact page).
    None for contact groups."""
    fields = {}
    phones, emails = [], []
    labels = {}  # item group → X-ABLabel
    raw = []
    for line in unfold(text):
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        group, name, params = entry_name(key)
        if name == "X-ADDRESSBOOKSERVER-KIND" and value.strip().lower() == "group":
            return None
        if name == "X-ABLABEL" and group:
            labels[group] = apple_label(unescape(value))
        raw.append((group, name, params, value))
        if name == "TEL":
            phones.append(value.strip())
        elif name == "EMAIL":
            emails.append(value.strip().lower())
        elif name in ("FN", "N", "ORG", "NICKNAME", "BDAY", "NOTE", "TITLE") and name not in fields:
            fields[name] = value.strip()
    n = unescape(fields.get("FN", "")) or " ".join(unescape(p) for p in reversed((fields.get("N") or "").split(";")[:2]) if p) \
        or unescape(fields.get("ORG", "").split(";")[0]) or unescape(fields.get("NICKNAME", ""))
    nparts = (fields.get("N") or "").split(";") + ["", ""]
    d = {"first": unescape(nparts[1]), "last": unescape(nparts[0]),
         "org": unescape(fields.get("ORG", "").split(";")[0]), "title": unescape(fields.get("TITLE", "")),
         "bday": fields.get("BDAY", ""), "note": unescape(fields.get("NOTE", "")), "ph": [], "em": [], "adr": [], "url": []}
    for group, name, params, value in raw:
        label = labels.get(group) or type_label(params)
        if name == "TEL":
            d["ph"].append([label, value.strip()])
        elif name == "EMAIL":
            d["em"].append([label, value.strip()])
        elif name == "ADR":
            parts = [unescape(x).strip() for x in value.split(";")]
            d["adr"].append([label, ", ".join(x for x in parts[2:] if x)])
        elif name == "URL":
            d["url"].append([label, unescape(value).strip()])
    d = {k: v for k, v in d.items() if v}
    return {"n": n.strip(), "p": phones, "e": emails, "d": d}


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


# What a label becomes on the card: Apple's own TYPEs, or a custom X-ABLabel.
TEL_TYPES = {"mobile": "type=CELL;type=VOICE", "iphone": "type=IPHONE;type=CELL;type=VOICE", "home": "type=HOME;type=VOICE",
             "work": "type=WORK;type=VOICE", "main": "type=MAIN", "other": "type=OTHER;type=VOICE", "": "type=VOICE"}
EMAIL_TYPES = {"home": "type=HOME", "work": "type=WORK", "other": "type=OTHER", "": ""}


def card_entries(text):
    """The card as a list of logical lines, each kept exactly as written (folding included)."""
    entries = []
    for physical in re.split(r"\r?\n", text):
        if physical[:1] in (" ", "\t") and entries:
            entries[-1] += "\r\n" + physical
        elif physical:
            entries.append(physical)
    return entries


def bday_value(v):
    v = (v or "").strip()
    if not v:
        return ""
    if not re.fullmatch(r"(\d{4}|--)-?\d{2}-?\d{2}", v):
        raise RuntimeError(f"birthday should look like 1990-05-31, not {v!r}")
    return v


def edit_card(href, ch):
    """Change only the fields in `ch` (first/last, org, title, bday, note, ph, em); the rest
    of the card (photo, addresses, anything Inbox doesn't show) stays exactly as it was."""
    for _ in range(2):
        status, headers, data = dav("GET", href)
        if status != 200:
            raise RuntimeError(f"couldn't read the contact (HTTP {status})")
        etag = headers.get("ETag") or headers.get("Etag") or headers.get("etag")
        entries = card_entries(data.decode())
        parsed = [(e, *entry_name(re.sub(r"\r\n[ \t]", "", e).split(":", 1)[0])) for e in entries]
        drop = set()
        if "ph" in ch:
            drop |= {"TEL"}
        if "em" in ch:
            drop |= {"EMAIL"}
        dropped_groups = {g for _, g, n, _ in parsed if n in drop and g}
        kept, used = [], set()
        for e, g, n, _ in parsed:
            if n in drop or (n == "X-ABLABEL" and g in dropped_groups):
                continue
            if ("first" in ch or "last" in ch) and n in ("N", "FN"):
                continue
            if ("org" in ch and n == "ORG") or ("title" in ch and n == "TITLE") or ("bday" in ch and n == "BDAY") or ("note" in ch and n == "NOTE"):
                continue
            if g:
                used.add(g)
            kept.append(e)
        old = parse_vcard(data.decode()) or {"d": {}}
        od = old.get("d", {})
        add = []
        if "first" in ch or "last" in ch:
            first = ch.get("first", od.get("first", "")).strip()
            last = ch.get("last", od.get("last", "")).strip()
            if not (first or last):
                raise RuntimeError("the contact needs a name")
            # keep the card's own order: "Surname Name" if that's how it was written
            surname_first = bool(od.get("last")) and (old.get("n", "").startswith(od.get("last", "")))
            fn = " ".join(x for x in ([last, first] if surname_first else [first, last]) if x)
            add += [f"N:{esc(last)};{esc(first)};;;", f"FN:{esc(fn)}"]
        if ch.get("org", "").strip():
            add.append(f"ORG:{esc(ch['org'].strip())};")
        if ch.get("title", "").strip():
            add.append(f"TITLE:{esc(ch['title'].strip())}")
        if bday_value(ch.get("bday")):
            add.append(f"BDAY;value=date:{bday_value(ch['bday'])}")
        if ch.get("note", "").strip():
            add.append("NOTE:" + esc(ch["note"].strip()).replace("\n", "\\n"))
        n = 0

        def group():
            nonlocal n
            while True:
                n += 1
                if f"item{n}" not in used:
                    used.add(f"item{n}")
                    return f"item{n}"
        for i, (label, value) in enumerate(ch.get("ph", [])):
            digits = normalize_phone(value)
            if not digits:
                continue
            types = TEL_TYPES.get(label.lower())
            pref = ";type=pref" if i == 0 else ""
            if types is not None:
                add.append(f"TEL;{types}{pref}:+{digits}")
            else:
                g = group()
                add += [f"{g}.TEL;type=VOICE{pref}:+{digits}", f"{g}.X-ABLabel:{esc(label)}"]
        for i, (label, value) in enumerate(ch.get("em", [])):
            value = value.strip()
            if "@" not in value:
                continue
            types = EMAIL_TYPES.get(label.lower())
            pref = ";type=pref" if i == 0 else ""
            if types is not None:
                add.append(f"EMAIL;type=INTERNET{';' + types if types else ''}{pref}:{value}")
            else:
                g = group()
                add += [f"{g}.EMAIL;type=INTERNET{pref}:{value}", f"{g}.X-ABLabel:{esc(label)}"]
        end = max(i for i, e in enumerate(kept) if e.upper().startswith("END:VCARD"))
        new = "\r\n".join(kept[:end] + add + kept[end:]) + "\r\n"
        status, _, _ = dav("PUT", href, new.encode(), headers={"If-Match": etag} if etag else {})
        if status in (200, 201, 204):
            return "saved"
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
            if r.get("kind") == "edit" and r.get("href") and isinstance(r.get("changes"), dict):
                msg = edit_card(r["href"], r["changes"])
            elif r.get("kind") == "update" and r.get("href"):
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
