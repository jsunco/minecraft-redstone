#!/usr/bin/env bash
set -euo pipefail
bridge_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${JAVA_HOME:-}" ]] || [[ ! -x "$JAVA_HOME/bin/javac" ]]; then
  printf '%s\n' 'Set JAVA_HOME to a JDK 25 installation (Minecraft bundled Java works when javac is present).' >&2
  exit 1
fi
bridge_cache="${MINECRAFT_BRIDGE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/minecraft-redstone}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$bridge_cache/gradle-user}"
cd "$bridge_dir/vendor"
./gradlew :26.3:test :26.3:jar --project-cache-dir "$bridge_cache/gradle-project" --no-daemon --console=plain "$@"
mkdir -p "$bridge_dir/artifacts"
jar_name='minecraft-fabric-mcp-1.1.0-redstone.1+26.3.jar'
cp "versions/26.3/build/libs/$jar_name" "$bridge_dir/artifacts/$jar_name"
cd "$bridge_dir/artifacts"
shasum -a 256 "$jar_name" > "$jar_name.sha256"
printf '\nArtifact: %s/artifacts/%s\n' "$bridge_dir" "$jar_name"
