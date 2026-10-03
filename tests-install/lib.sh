# Shared by run.sh and upgrade.sh (docs/install-test.md). Expects $machine set; sourced.
# shellcheck shell=bash
C=(docker compose -f compose.yml)
keep="${keep:-}"

fail() { echo "FAIL [$machine] $*"; exit 1; }
ok() { echo "ok   [$machine] $*"; }
on() { "${C[@]}" exec -T "$machine" bash -c "$1"; }
# The service user's shell, with its systemd manager reachable.
as_claw() { "${C[@]}" exec -T -u claw -e XDG_RUNTIME_DIR=/run/user/1000 "$machine" bash -lc "$1"; }

cleanup() { [ "$keep" = "--keep" ] || "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }

boot_machine() {
  "${C[@]}" up -d --build "$machine" >/dev/null
  local state=""
  for _ in $(seq 1 60); do
    state="$(on 'systemctl is-system-running 2>/dev/null' || true)"
    case "$state" in running|degraded) break ;; esac
    sleep 1
  done
  ok "systemd is up ($state)"
}

# install_tarball <path under /dist> <log>
install_tarball() {
  local name; name="$(basename "$1" .tar.gz)"
  on "rm -rf /root/x && mkdir /root/x && tar -xzf $1 -C /root/x" || fail "extract $1"
  on "cd /root/x/${name} && ./packaging/install.sh --user claw" > "$2" 2>&1 || { tail -40 "$2"; fail "install.sh"; }
}

unit_state() { as_claw "systemctl --user is-$1 $2.service" || true; }

# wait_unit <enabled|disabled> <unit> [seconds]
wait_unit() {
  for _ in $(seq 1 "${3:-300}"); do
    [ "$(unit_state enabled "$2")" = "$1" ] && return 0
    sleep 1
  done
  return 1
}

# The first paired device, as the app would present itself.
creds() {
  as_claw 'jq -r ".channels[\"my-claw-app\"].devices | to_entries[0] | \"\(.key) \(.value.token)\"" ~/.my-claw/config.json'
}

# probe '<frame json>' <answer type>: one frame through the app's socket (ws-probe.ts).
probe() {
  local c; c="$(creds)"
  as_claw "~/.bun/bin/bun /t/ws-probe.ts ${c% *} ${c#* } '$1' $2"
}

# The field of one service in a services.result.
service() { echo "$1" | jq -r --arg id "$2" ".services[] | select(.id == \$id) | $3"; }

whisper_answers() {
  for _ in $(seq 1 "${1:-60}"); do
    as_claw 'curl -fsS http://127.0.0.1:8000/health' 2>/dev/null && return 0
    sleep 1
  done
  return 1
}
