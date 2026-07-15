#!/usr/bin/env bash
# Встановлює десклет "Claude Usage Limits" і вмикає його на робочому столі.
set -euo pipefail

UUID="claude-usage@maracasabat"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST_DIR="$HOME/.local/share/cinnamon/desklets"
DEST="$DEST_DIR/$UUID"

mkdir -p "$DEST_DIR"
rm -rf "$DEST"
ln -s "$SRC" "$DEST"
echo "Встановлено (symlink): $DEST -> $SRC"

python3 - <<'EOF'
import ast
import subprocess

UUID = "claude-usage@maracasabat"
out = subprocess.run(
    ["gsettings", "get", "org.cinnamon", "enabled-desklets"],
    capture_output=True, text=True,
).stdout.strip()
if out.startswith("@as"):
    out = out[len("@as"):].strip()
enabled = ast.literal_eval(out) if out else []

if any(e.split(":")[0] == UUID for e in enabled):
    # Уже ввімкнено — перезавантажуємо код десклета
    subprocess.run([
        "dbus-send", "--session", "--dest=org.Cinnamon", "--print-reply",
        "/org/Cinnamon", "org.Cinnamon.ReloadXlet",
        f"string:{UUID}", "string:DESKLET",
    ], capture_output=True)
    print("Десклет уже ввімкнений — код перезавантажено.")
else:
    ids = [int(e.split(":")[1]) for e in enabled if len(e.split(":")) > 1]
    new_id = (max(ids) + 1) if ids else 1
    enabled.append(f"{UUID}:{new_id}:100:100")
    subprocess.run(["gsettings", "set", "org.cinnamon", "enabled-desklets", str(enabled)])
    print("Десклет увімкнено — має з'явитися на робочому столі (лівий верхній кут).")
EOF
