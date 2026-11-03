#!/usr/bin/env bash
# Why a disposable Supabase stack cannot start, named precisely.
#
# The harness used to answer every Docker failure with "the daemon is not
# reachable", which is true and useless: a missing binary, a stopped daemon, a
# user outside the docker group and a shell whose socket access is intercepted
# by a sandbox all need different things done, and one of them must not be
# "fixed" by changing permissions at all.
#
# This library only observes. It never starts the daemon, never edits group
# membership, never touches the socket and never runs sudo. Its job is to say
# which of the cases below happened, so an operator can act on the right one.
#
# Classification is deliberately conservative: an unrecognised stderr is
# UNKNOWN, never a guess at a nearby case.
#
# Sourced by run-pharmacy-db-harness.sh; exercised directly by
# supabase-preflight.test.mjs with stand-in `docker` binaries.
# shellcheck shell=bash

# Where the client looks for the daemon. Honours DOCKER_HOST only for the
# unix:// form, because a tcp:// host is not something this repository is
# allowed to reason about.
supabase_preflight_socket_path() {
  local host="${DOCKER_HOST:-unix:///var/run/docker.sock}"
  case "$host" in
    unix://*) printf '%s' "${host#unix://}" ;;
    *) printf '' ;;
  esac
}

# Prints exactly one classification token:
#   OK  DOCKER_CLIENT_MISSING  DOCKER_SOCKET_MISSING  DOCKER_SOCKET_PERMISSION
#   DOCKER_HOST_INTERMEDIATED  DOCKER_DAEMON_DOWN  DOCKER_UNKNOWN
#
# $1 is a file holding the stderr of a failed `docker info`. Ignored when the
# failure happened before the client could run.
supabase_preflight_classify() {
  local stderr_file="${1:-}"
  local sock msg

  if ! command -v docker >/dev/null 2>&1; then
    printf 'DOCKER_CLIENT_MISSING'
    return 0
  fi

  sock="$(supabase_preflight_socket_path)"
  msg=""
  if [ -n "$stderr_file" ] && [ -r "$stderr_file" ]; then
    msg="$(tr '[:upper:]' '[:lower:]' <"$stderr_file")"
  fi

  case "$msg" in
    *"permission denied"*)
      # A Unix socket is reachable only by a process that may write to it. If
      # the mode bits already grant that, the refusal came from something above
      # the filesystem — a sandbox, an LSM policy or an interposed proxy — and
      # no chmod or usermod will change it. Those two cases need opposite
      # advice, so they must never share a branch.
      if [ -n "$sock" ] && [ -w "$sock" ]; then
        printf 'DOCKER_HOST_INTERMEDIATED'
      elif [ -n "$sock" ] && [ -e "$sock" ]; then
        printf 'DOCKER_SOCKET_PERMISSION'
      else
        printf 'DOCKER_SOCKET_MISSING'
      fi
      return 0
      ;;
    *"cannot connect to the docker daemon"*|*"connection refused"*|*"is the docker daemon running"*)
      printf 'DOCKER_DAEMON_DOWN'
      return 0
      ;;
    *"no such file or directory"*)
      printf 'DOCKER_SOCKET_MISSING'
      return 0
      ;;
  esac

  printf 'DOCKER_UNKNOWN'
}

# Human text for a classification token. Written to stdout so the caller can
# route it wherever it likes; the caller adds its own exit.
supabase_preflight_explain() {
  local code="${1:-DOCKER_UNKNOWN}"
  local sock
  sock="$(supabase_preflight_socket_path)"

  case "$code" in
    DOCKER_CLIENT_MISSING)
      cat <<'MSG'
The docker command is not installed, so no stack can be provisioned.

  Install Docker Engine (or Docker Desktop) and confirm `docker info` answers.
  Nothing in this repository installs it, and the harness will not try.
MSG
      ;;
    DOCKER_SOCKET_MISSING)
      cat <<MSG
No Docker socket is present at ${sock:-<no unix socket configured>}, so there
is no daemon to talk to.

  Start Docker, then re-run. On a systemd host: sudo systemctl start docker
MSG
      ;;
    DOCKER_SOCKET_PERMISSION)
      cat <<MSG
The Docker socket at ${sock} refuses this user. The socket's mode grants its
group access, and this account is not in that group.

  Current groups: $(id -nG 2>/dev/null || echo unknown)
  Socket:         $(ls -l "$sock" 2>/dev/null || echo 'unreadable')

  To grant access (an administrative change, taken deliberately, not by this
  script):
      sudo usermod -aG docker "$USER"
  then sign out and back in so the new group is picked up. Confirm with
  `docker info` before re-running the harness.
MSG
      ;;
    DOCKER_HOST_INTERMEDIATED)
      cat <<MSG
File permissions already allow this user to write to ${sock}, yet the connect
is still refused. The refusal therefore comes from something above the
filesystem: a sandbox, a mandatory-access-control policy, or a proxy that
intercepts Unix sockets.

  Re-running the harness with different permissions will not help, and the
  harness will not change any permissions to try. Run it from an ordinary
  login shell outside that isolation (the operator's own desktop session, or
  CI where the socket is provided deliberately).
MSG
      ;;
    DOCKER_DAEMON_DOWN)
      cat <<'MSG'
The Docker client can reach the socket but the daemon behind it is not
answering.

  Start it, then re-run. On a systemd host: sudo systemctl start docker
MSG
      ;;
    *)
      cat <<'MSG'
Docker failed for a reason this harness does not recognise. The client's own
output is above; run `docker info` by hand and act on it.

  No permissions were changed, no container was started and no database was
  touched.
MSG
      ;;
  esac
}

# Returns the environment variable (if any) that would point a client at a
# remote or shared project, one per line. The harness clears these before it
# starts anything; this function exists so the guard itself can be tested.
supabase_preflight_remote_env_vars() {
  local name
  for name in DATABASE_URL DIRECT_DATABASE_URL SUPABASE_DB_URL PGURI \
              PGSERVICE PGSERVICEFILE PGHOST PGHOSTADDR \
              SUPABASE_ACCESS_TOKEN SUPABASE_URL NEXT_PUBLIC_SUPABASE_URL \
              SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY; do
    if [ -n "${!name:-}" ]; then
      printf '%s\n' "$name"
    fi
  done
}

# True when an API URL is loopback. Anything else — a project ref, a LAN
# address, a tunnel — is refused, because the suites would otherwise write to
# a real project.
supabase_preflight_is_loopback() {
  case "${1:-}" in
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) return 0 ;;
    *) return 1 ;;
  esac
}
