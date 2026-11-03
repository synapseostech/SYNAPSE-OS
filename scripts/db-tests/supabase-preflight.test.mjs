import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * supabase-preflight.test.mjs — pins the Docker failure classifier the
 * disposable harness relies on.
 *
 * Each case supplies a stand-in `docker` binary and, where the case is about
 * the socket, a stand-in socket file under a temporary directory. Nothing here
 * contacts a real daemon, starts a container or changes permissions; the point
 * is exactly that the classifier can tell those situations apart *before* the
 * harness attempts anything.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const lib = join(root, "scripts", "db-tests", "lib", "supabase-preflight.sh")

// Absolute, because one case below deliberately runs with a PATH that cannot
// resolve anything — including the shell itself.
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash"

/** Run a snippet of the library in bash with the given PATH and env. */
function inLib(expression, { path, env = {} } = {}) {
  const r = spawnSync(BASH, ["-c", `source "$LIB" && ${expression}`, "bash"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      LIB: lib,
      PATH: path ?? process.env.PATH,
    },
  })
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr }
}

/** A PATH whose only docker is the stand-in below, plus the core utilities. */
function pathWithFakeDocker(stderrText) {
  const dir = mkdtempSync(join(tmpdir(), "synapse-preflight-"))
  const docker = join(dir, "docker")
  writeFileSync(
    docker,
    `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(stderrText)} >&2\nexit 1\n`,
  )
  chmodSync(docker, 0o755)
  return { dir, path: `${dir}:/usr/bin:/bin` }
}

/** A PATH with no docker at all: an empty directory, so no system client leaks in. */
function pathWithoutDocker() {
  const dir = mkdtempSync(join(tmpdir(), "synapse-preflight-nodocker-"))
  return dir
}

function classify(stderrText, extra = {}) {
  const { dir, path } = pathWithFakeDocker(stderrText)
  const errFile = join(dir, "docker-info.err")
  writeFileSync(errFile, stderrText + "\n")
  try {
    return inLib(`supabase_preflight_classify "$ERR"`, {
      path,
      env: { ERR: errFile, ...extra },
    }).stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function withSockets(fn) {
  const dir = mkdtempSync(join(tmpdir(), "synapse-preflight-sock-"))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("a missing docker client is named rather than reported as a dead daemon", () => {
  assert.equal(
    inLib("supabase_preflight_classify ''", { path: pathWithoutDocker() }).stdout,
    "DOCKER_CLIENT_MISSING",
  )
})

test("permission denied with a socket the user cannot write is a group problem", () => {
  withSockets((dir) => {
    const sock = join(dir, "docker.sock")
    writeFileSync(sock, "")
    chmodSync(sock, 0o000)
    assert.equal(
      classify("permission denied while trying to connect to the docker API", {
        DOCKER_HOST: `unix://${sock}`,
      }),
      "DOCKER_SOCKET_PERMISSION",
    )
  })
})

test("permission denied where the socket mode already grants access is not a permissions problem", () => {
  withSockets((dir) => {
    const sock = join(dir, "docker.sock")
    writeFileSync(sock, "")
    chmodSync(sock, 0o600) // owned by this user, writable by this user
    assert.equal(
      classify("permission denied while trying to connect to the docker API", {
        DOCKER_HOST: `unix://${sock}`,
      }),
      "DOCKER_HOST_INTERMEDIATED",
    )
  })
})

test("permission denied with no socket present is reported as a missing socket", () => {
  withSockets((dir) => {
    assert.equal(
      classify("permission denied while trying to connect to the docker API", {
        DOCKER_HOST: `unix://${join(dir, "absent.sock")}`,
      }),
      "DOCKER_SOCKET_MISSING",
    )
  })
})

test("a stopped daemon is distinguished from a permission refusal", () => {
  assert.equal(
    classify(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    ),
    "DOCKER_DAEMON_DOWN",
  )
})

test("connection refused is a stopped daemon, not a missing one", () => {
  assert.equal(classify("dial unix /var/run/docker.sock: connect: connection refused"), "DOCKER_DAEMON_DOWN")
})

test("an unrecognised failure stays unknown instead of being promoted to a nearby case", () => {
  assert.equal(classify("context deadline exceeded while contacting some proxy"), "DOCKER_UNKNOWN")
})

test("every classification has operator text, and none of it claims to have changed anything", () => {
  const codes = [
    "DOCKER_CLIENT_MISSING",
    "DOCKER_SOCKET_MISSING",
    "DOCKER_SOCKET_PERMISSION",
    "DOCKER_HOST_INTERMEDIATED",
    "DOCKER_DAEMON_DOWN",
    "DOCKER_UNKNOWN",
  ]
  for (const code of codes) {
    const r = inLib(`supabase_preflight_explain ${code}`)
    assert.equal(r.status, 0, `${code} produced no explanation`)
    assert.ok(r.stdout.length > 40, `${code} explanation is too thin to act on`)
    assert.doesNotMatch(r.stdout, /password|secret|token=/i)
  }
  // The one case that is *not* a permissions problem must not send the
  // operator to chmod or usermod.
  const mediated = inLib("supabase_preflight_explain DOCKER_HOST_INTERMEDIATED").stdout
  assert.doesNotMatch(mediated, /usermod|chmod/)
})

test("the remote-environment guard names every variable that could retarget a client", () => {
  const r = inLib("supabase_preflight_remote_env_vars", {
    env: {
      DATABASE_URL: "postgresql://u@host/db",
      SUPABASE_ACCESS_TOKEN: "x",
      PGURI: "postgresql://u@host/db",
      UNRELATED_VAR: "kept",
    },
  })
  const names = r.stdout.split("\n").filter(Boolean)
  assert.deepEqual(names.sort(), ["DATABASE_URL", "PGURI", "SUPABASE_ACCESS_TOKEN"])
})

test("the loopback check accepts only loopback, and refuses a project URL", () => {
  const ok = ["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"]
  const bad = [
    "https://abcdefghijklmnopqrst.supabase.co",
    "http://192.168.1.20:54321",
    "http://127.0.0.1.evil.example:54321",
    "",
  ]
  for (const url of ok) {
    assert.equal(inLib(`supabase_preflight_is_loopback "${url}"`).status, 0, url)
  }
  for (const url of bad) {
    assert.notEqual(inLib(`supabase_preflight_is_loopback "${url}"`).status, 0, url)
  }
})
