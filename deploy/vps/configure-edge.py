#!/usr/bin/env python3
"""Route https://dsh.agencyarche.com/leo-status/* to the leo-status relay.

Idempotent edge configuration for the VPS (see leo-status/CONTRACT-V2.md §1/§8).

What it does
------------
1. Finds the live Caddyfile through `docker inspect co-align-v2-caddy-1` (the
   bind mount of /etc/caddy/Caddyfile), so it keeps working after a co-align
   release directory changes.
2. If the `dsh.agencyarche.com { ... }` site block already contains the
   /leo-status route, it changes nothing and exits 0 (idempotent).
3. Otherwise it backs the Caddyfile up to
   /opt/leo-status/Caddyfile.before-<timestamp>, inserts

       handle_path /leo-status/* {
           reverse_proxy 172.18.0.1:18888
       }

   at the top of the dsh.agencyarche.com block, and validates the whole config
   with `docker exec co-align-v2-caddy-1 caddy validate`.
4. Validation failure -> restore the backup and exit 1 (Caddy is never
   restarted with a broken config).
5. Validation success -> `docker restart co-align-v2-caddy-1`
   (`--no-restart` skips this, e.g. for a manual dry run).

The file is written in place (never via rename) on purpose: /etc/caddy/Caddyfile
inside the container is a *single-file bind mount*, so replacing the host inode
would leave the container looking at the stale file.

Exit codes: 0 = configured or already configured, 1 = error (rolled back),
2 = usage error.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys

CADDY_CONTAINER = "co-align-v2-caddy-1"
CADDYFILE_IN_CONTAINER = "/etc/caddy/Caddyfile"
SITE = "dsh.agencyarche.com"
BACKUP_DIR = pathlib.Path("/opt/leo-status")
ROUTE = (
    "    handle_path /leo-status/* {\n"
    "        reverse_proxy 172.18.0.1:18888\n"
    "    }\n"
)
# A site label line such as `dsh.agencyarche.com {` (optionally with scheme).
SITE_RE = re.compile(
    r"^[ \t]*(?:https?://)?" + re.escape(SITE) + r"[ \t]*\{[ \t]*$", re.MULTILINE
)


def log(msg: str) -> None:
    print(f"[configure-edge] {msg}", flush=True)


def fail(msg: str, code: int = 1) -> "NoReturn":  # noqa: F821 - docs only
    print(f"[configure-edge] ERROR: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(code)


def caddyfile_path() -> pathlib.Path:
    """Resolve the host path bind-mounted at /etc/caddy/Caddyfile."""
    try:
        proc = subprocess.run(
            ["docker", "inspect", CADDY_CONTAINER, "--format", "{{json .Mounts}}"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError:
        fail("docker not found on PATH")
    if proc.returncode != 0:
        fail(f"docker inspect {CADDY_CONTAINER} failed: {proc.stderr.strip()}")
    try:
        mounts = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        fail(f"cannot parse docker inspect output: {exc}")
    for mount in mounts:
        if mount.get("Destination") == CADDYFILE_IN_CONTAINER:
            return pathlib.Path(mount["Source"])
    fail(f"{CADDY_CONTAINER} has no bind mount at {CADDYFILE_IN_CONTAINER}")


def block_end(text: str, open_index: int) -> int:
    """Index of the `}` matching the `{` at open_index (-1 if unbalanced).

    Skips strings, `#` comments and `{$ENV}` placeholders while counting.
    """
    depth = 0
    i = open_index
    n = len(text)
    in_quote = False
    in_comment = False
    while i < n:
        ch = text[i]
        if in_comment:
            if ch == "\n":
                in_comment = False
            i += 1
            continue
        if in_quote:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_quote = False
            i += 1
            continue
        if ch == "#":
            in_comment = True
            i += 1
            continue
        if ch == '"':
            in_quote = True
            i += 1
            continue
        if ch == "{" and i + 1 < n and text[i + 1] == "$":
            end = text.find("}", i)
            if end == -1:
                return -1
            i = end + 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def caddy_validate() -> tuple[int, str]:
    proc = subprocess.run(
        [
            "docker",
            "exec",
            CADDY_CONTAINER,
            "caddy",
            "validate",
            "--config",
            CADDYFILE_IN_CONTAINER,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def write_in_place(path: pathlib.Path, content: str) -> None:
    """Truncate/rewrite the existing inode (single-file bind mount!).

    If the target does not exist yet (backup file), it is created normally.
    """
    if not path.exists():
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        return
    with open(path, "r+", encoding="utf-8", newline="\n") as fh:
        fh.write(content)
        fh.truncate()
        fh.flush()
        os.fsync(fh.fileno())


def backup_path() -> pathlib.Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = BACKUP_DIR / f"Caddyfile.before-{stamp}"
    suffix = 1
    while path.exists():
        path = BACKUP_DIR / f"Caddyfile.before-{stamp}-{suffix}"
        suffix += 1
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-restart",
        action="store_true",
        help="validate only; do not restart the Caddy container",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="show what would change and exit without touching any file",
    )
    args = parser.parse_args()

    path = caddyfile_path()
    if not path.is_file():
        fail(f"Caddyfile not found at {path}")
    text = path.read_text(encoding="utf-8")
    log(f"Caddyfile: {path}")

    match = SITE_RE.search(text)
    if not match:
        fail(
            f"site block '{SITE} {{' not found in {path}; the dsh-center edge site is "
            "missing - run /root/dsh-center/configure-center-edge.py first"
        )

    open_index = match.end() - 1
    # The regex may end with trailing spaces; walk back to the actual brace.
    while open_index > match.start() and text[open_index] != "{":
        open_index -= 1
    end_index = block_end(text, open_index)
    if end_index < 0:
        fail(f"unterminated '{SITE}' block in {path}")

    block = text[match.start() : end_index + 1]
    if "/leo-status" in block or "172.18.0.1:18888" in block:
        log("route /leo-status/* already present in the dsh.agencyarche.com block; nothing to do")
        return 0

    # Insert at the top of the block: right after the site opening line.
    newline = text.find("\n", open_index)
    insert_at = newline + 1 if newline != -1 else len(text)
    new_text = text[:insert_at] + ROUTE + text[insert_at:]

    if args.dry_run:
        log("would insert into the block:")
        print(ROUTE, end="")
        return 0

    backup = backup_path()
    write_in_place(backup, text)
    log(f"backup written: {backup}")

    write_in_place(path, new_text)
    log("Caddyfile updated, validating...")

    code, output = caddy_validate()
    if code != 0:
        write_in_place(path, text)
        fail(
            "caddy validate failed; Caddyfile rolled back to the original content.\n"
            f"{output}"
        )
    log("caddy validate OK")

    if args.no_restart:
        log("--no-restart given: Caddyfile is live on disk but Caddy still runs the old config")
        return 0

    log(f"restarting container {CADDY_CONTAINER} ...")
    proc = subprocess.run(
        ["docker", "restart", CADDY_CONTAINER],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if proc.returncode != 0:
        fail(
            "Caddyfile was validated and updated, but the container restart failed: "
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )
    log("done: /leo-status/* now routes to 172.18.0.1:18888")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - top-level guard, keep the edge safe
        print(f"[configure-edge] ERROR: unexpected failure: {exc}", file=sys.stderr)
        print(
            "[configure-edge] NOTE: if the Caddyfile was already modified, restore the "
            f"backup from {BACKUP_DIR}/Caddyfile.before-* before retrying.",
            file=sys.stderr,
        )
        sys.exit(1)
