#!/usr/bin/env python3
"""Set the production admin password from standard input without logging it."""

import os
from pathlib import Path
import sys
import tempfile


ENV_FILE = Path("/opt/mock-kabu2/deploy/production/.env.production")


def main() -> None:
    password = sys.stdin.buffer.read().rstrip(b"\r\n")
    if len(password) < 12 or any(char in password for char in (b"\r", b"\n", b"\x00")):
        raise SystemExit("Admin password must be at least 12 characters on one line")
    if any(char not in b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!._-" for char in password):
        raise SystemExit("Admin password contains characters unsupported by this env writer")

    metadata = ENV_FILE.stat()
    lines = ENV_FILE.read_bytes().splitlines(keepends=True)
    replacement = b"ADMIN_PASSWORD=" + password + b"\n"
    updated = []
    found = False
    for line in lines:
        if line.startswith(b"ADMIN_PASSWORD="):
            if not found:
                updated.append(replacement)
                found = True
        else:
            updated.append(line)
    if not found:
        if updated and not updated[-1].endswith(b"\n"):
            updated.append(b"\n")
        updated.append(replacement)

    descriptor, temporary = tempfile.mkstemp(prefix=".env.production.", dir=ENV_FILE.parent)
    try:
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
        with os.fdopen(descriptor, "wb") as output:
            output.write(b"".join(updated))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, ENV_FILE)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Admin password saved to the production environment file")


if __name__ == "__main__":
    main()
