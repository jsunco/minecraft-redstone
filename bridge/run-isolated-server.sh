#!/usr/bin/env bash
set -euo pipefail
bridge_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
run_dir="$bridge_dir/vendor/versions/26.3/run/server"
if [[ ! -f "$run_dir/eula.txt" ]] || ! grep -Eq '^eula=true[[:space:]]*$' "$run_dir/eula.txt"; then
  printf '%s\n' 'This script does not accept the Minecraft EULA.' \
    "If you have reviewed and accepted it yourself, provide eula=true in $run_dir/eula.txt." \
    'No server has been launched.' >&2
  exit 1
fi
if [[ -z "${JAVA_HOME:-}" ]] || [[ ! -x "$JAVA_HOME/bin/java" ]]; then
  printf '%s\n' 'Set JAVA_HOME to JDK 25.' >&2
  exit 1
fi
# This directory belongs exclusively to this bridge development checkout.
python3 - "$run_dir" <<'PY'
import json, pathlib, secrets, sys
run = pathlib.Path(sys.argv[1])
config_dir = run / 'config' / 'minecraft_fabric_mcp'
config_dir.mkdir(parents=True, exist_ok=True)
p = config_dir / 'config.json'
config = json.loads(p.read_text()) if p.exists() else {}
config.update(host='127.0.0.1', port=8775, auth_required=True, allow_remote=False,
              allowed_origins=[], included_categories=['blocks','world','entities','items','scripting','server','players','structures'],
              max_access='write')
if not isinstance(config.get('bearer_token'), str) or not config['bearer_token'].strip():
    config['bearer_token'] = secrets.token_hex(32)
p.write_text(json.dumps(config, indent=2) + '\n')
p.chmod(0o600)
props = run / 'server.properties'
if not props.exists():
    props.write_text('server-ip=127.0.0.1\nserver-port=25576\nonline-mode=true\nlevel-name=tinygpu-bridge-smoke\nlevel-type=minecraft:flat\ngamemode=creative\ndifficulty=peaceful\nspawn-protection=0\ngenerate-structures=false\n')
PY
export MCP_HOST=127.0.0.1 MCP_PORT=8775 MCP_AUTH_REQUIRED=true MCP_ALLOW_REMOTE=false
bridge_cache="${MINECRAFT_BRIDGE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/minecraft-redstone}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$bridge_cache/gradle-user}"
cd "$bridge_dir/vendor"
exec ./gradlew :26.3:runServer --project-cache-dir "$bridge_cache/gradle-project" --no-daemon --console=plain
