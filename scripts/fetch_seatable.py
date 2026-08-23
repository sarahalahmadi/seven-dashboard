#!/usr/bin/env python3
"""
Export a SeaTable table to data/live.json for the Live dashboard.

Reads its settings from environment variables so the token is never
written into a file or committed to the repository:

    SEATABLE_SERVER   e.g. https://cloud.seatable.io
    SEATABLE_TOKEN    a READ-ONLY API token for the base
    SEATABLE_TABLE    the table name, e.g. "Critical Path"
    OUTPUT_PATH       optional, defaults to data/live.json

In GitHub Actions these come from repository Secrets.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def get_json(url, token):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    server = os.environ.get("SEATABLE_SERVER", "").rstrip("/")
    token = os.environ.get("SEATABLE_TOKEN", "")
    table = os.environ.get("SEATABLE_TABLE", "")
    out_path = os.environ.get("OUTPUT_PATH", "data/live.json")

    missing = [n for n, v in [
        ("SEATABLE_SERVER", server), ("SEATABLE_TOKEN", token), ("SEATABLE_TABLE", table)
    ] if not v]
    if missing:
        sys.exit(f"Missing required setting(s): {', '.join(missing)}")

    # Step 1 — swap the API token for a short-lived base token.
    try:
        auth = get_json(f"{server}/api/v2.1/dtable/app-access-token/", token)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            sys.exit("SeaTable rejected the API token. Check SEATABLE_TOKEN is current and belongs to this base.")
        sys.exit(f"Authentication failed (HTTP {e.code}).")

    base_url = (auth.get("dtable_server") or server).rstrip("/")
    base_token = auth["access_token"]
    uuid = auth["dtable_uuid"]

    # Step 2 — page through the rows.
    rows, start, page = [], 0, 1000
    while True:
        qs = urllib.parse.urlencode({"table_name": table, "start": start, "limit": page})
        url = f"{base_url}/api/v1/dtables/{uuid}/rows/?{qs}"
        try:
            batch = get_json(url, base_token).get("rows", [])
        except urllib.error.HTTPError as e:
            if e.code == 404:
                sys.exit(f'No table named "{table}" in that base.')
            sys.exit(f"Couldn't read rows (HTTP {e.code}).")
        rows.extend(batch)
        if len(batch) < page:
            break
        start += page

    if not rows:
        sys.exit(f'Table "{table}" came back empty — refusing to overwrite the snapshot with nothing.')

    # Drop SeaTable's internal bookkeeping columns (_id, _ctime, ...).
    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]

    payload = {
        "source": f"{table} · SeaTable",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "row_count": len(clean),
        "rows": clean,
    }

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Wrote {len(clean)} rows to {out_path}")


if __name__ == "__main__":
    main()
