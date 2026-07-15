#!/usr/bin/env bash
# Вимикає та видаляє десклет "Claude Usage Limits".
set -euo pipefail

UUID="claude-usage@maracasabat"

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
kept = [e for e in enabled if e.split(":")[0] != UUID]
if kept != enabled:
    subprocess.run(["gsettings", "set", "org.cinnamon", "enabled-desklets", str(kept)])
    print("Десклет вимкнено.")
EOF

rm -rf "$HOME/.local/share/cinnamon/desklets/$UUID"
echo "Файли десклета видалено."
