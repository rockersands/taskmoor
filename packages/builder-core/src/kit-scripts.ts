// Written by tools/compose/kit-scripts.mjs from deploy/compose and tools/airgap; do not edit.
// The backend kit's update scripts are these same files (OPS-025, ADR-117).

export const UPGRADE_SH = `#!/usr/bin/env bash
# One-command upgrade of the Compose kit (OPS-006, ADR-022):
#
#   bash upgrade.sh <image>             for example: bash upgrade.sh ghcr.io/rockersands/taskmoor:1.4.0
#   bash upgrade.sh <image> --dry-run   the checks and the plan only; nothing changes or stops
#
# It pulls the image when it is missing, makes the database's TLS certificate when the kit has
# none yet (ADR-111), stops the backend (PostgreSQL keeps running), runs
# \`node cli.mjs upgrade\` from the new image (pre-flight checks, a backup under
# /data/backups/pre-upgrade-<time>, the migrations, a check of the result, and a rollback when
# anything fails), then starts the new image and records it in .env. When the upgrade fails,
# the database is as it was and the previous image starts again. Exit codes: 0 upgraded (or
# nothing to do), 1 not upgraded and running the previous image, 3 the rollback failed too:
# the backend stays stopped and the output says which backup to restore, 4 a backend or
# PostgreSQL did not come back: the output says which, and nothing vouches for what is running.
#
# Like install.sh it uses docker-compose.external.yml when DATABASE_URL is set (in the
# environment or .env), honours TASKMOOR_COMPOSE_OVERRIDE, and TASKMOOR_PULL=never never
# contacts a registry.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\\n' "$*"; }
die() { say "upgrade: $1" >&2; exit "\${2:-1}"; } # message, exit code (1)

new=\${1:-}
[ -n "$new" ] && [ "\${new#-}" = "$new" ] || die "usage: bash upgrade.sh <image> [--dry-run]" 2
dry=
if [ "\${2:-}" = "--dry-run" ]; then dry=--dry-run; elif [ -n "\${2:-}" ]; then die "unknown option \${2}" 2; fi

command -v docker >/dev/null 2>&1 || die "Docker is not installed"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command)"

# The Builder's backend kit has one Compose file, with its database in it.
if [ -f docker-compose.external.yml ] && { [ -n "\${DATABASE_URL:-}" ] || grep -qE '^DATABASE_URL=' .env 2>/dev/null; }; then
  file=docker-compose.external.yml
else
  file=docker-compose.yml
fi
files=(-f "$file")
for extra in \${TASKMOOR_COMPOSE_OVERRIDE:-}; do files+=(-f "$extra"); done
compose() { docker compose "\${files[@]}" "$@"; }

# The image running now is the one to go back to; without a container, the configured one.
running=$(compose ps -q taskmoor 2>/dev/null || true)
old=
if [ -n "$running" ]; then old=$(docker inspect --format '{{.Config.Image}}' "$running" 2>/dev/null || true); fi
if [ -z "$old" ]; then
  old=\${TASKMOOR_IMAGE:-$(grep -E '^TASKMOOR_IMAGE=' .env 2>/dev/null | cut -d= -f2- || true)}
fi
old=\${old:-taskmoor:dev}

if ! docker image inspect "$new" >/dev/null 2>&1; then
  [ "\${TASKMOOR_PULL:-missing}" != never ] || die "$new is not loaded and TASKMOOR_PULL=never"
  say "pulling $new"
  docker pull "$new" >/dev/null
fi

# The new image's command line against this kit's database and data volume. Its password
# stays in the container's environment, never on a command line.
upgrade() { TASKMOOR_IMAGE=$new compose run --rm -T taskmoor node cli.mjs upgrade "$@"; }

ready() {
  compose exec -T taskmoor node -e \\
    "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \\
    >/dev/null 2>&1
}
start() { # image
  TASKMOOR_IMAGE=$1 compose up -d taskmoor >/dev/null
  for _ in $(seq 1 120); do
    if ready; then return 0; fi
    sleep 1
  done
  compose logs --tail 40 taskmoor
  die "the backend ($1) did not become ready in 2 minutes; the log above says why" 4
}

# TLS to the bundled PostgreSQL (ASVS 1.9.1, ADR-111). A kit file with the postgres-tls service
# makes the certificate when it is missing, and PostgreSQL restarts with TLS once when it ran
# without it (an install from before, given the new kit file). Compose does both on \`up\`.
tls=
if [ "$file" = docker-compose.yml ] && compose config --services 2>/dev/null | grep -qx postgres-tls; then
  tls=yes
fi
db_ssl() { compose exec -T postgres psql -U taskmoor -d taskmoor -tAc 'SHOW ssl' 2>/dev/null | tr -d '[:space:]' || true; }
db_ready() { compose exec -T postgres pg_isready -U taskmoor -d taskmoor >/dev/null 2>&1; }

if [ -n "$dry" ]; then
  say "dry run of the upgrade from $old to $new (the backend keeps running)"
  if [ -n "$tls" ] && [ "$(db_ssl)" != on ]; then
    say "PostgreSQL runs without TLS: the upgrade first makes its certificate and restarts it once with TLS (ADR-111); the database checks run then"
    exit 0
  fi
  upgrade --dry-run
  exit $?
fi

if [ -n "$tls" ]; then
  say "checking the database certificate (TLS to PostgreSQL)"
  compose up -d postgres >/dev/null
  for _ in $(seq 1 60); do
    if db_ready; then break; fi
    sleep 1
  done
  db_ready || die "PostgreSQL did not come back with TLS; see: docker compose logs postgres-tls postgres" 4
fi

say "upgrading from $old to $new; the backend stops for the backup and the migrations"
compose stop taskmoor >/dev/null || die "could not stop the backend; see: docker compose ps" 4
set +e
upgrade
code=$?
set -e

if [ "$code" -eq 0 ]; then
  if [ -f .env ]; then
    if grep -qE '^TASKMOOR_IMAGE=' .env; then
      sed -i.bak "s|^TASKMOOR_IMAGE=.*|TASKMOOR_IMAGE=$new|" .env && rm -f .env.bak
    else
      printf 'TASKMOOR_IMAGE=%s\\n' "$new" >> .env
    fi
    say "recorded TASKMOOR_IMAGE=$new in .env"
  else
    say "no .env here: set TASKMOOR_IMAGE=$new wherever you keep this kit's settings"
  fi
  start "$new"
  say "Taskmoor $new is running."
  exit 0
fi
if [ "$code" -eq 3 ]; then
  die "the upgrade and its rollback failed; the backend stays stopped. Restore the pre-upgrade backup named above with: TASKMOOR_IMAGE=$new docker compose \${files[*]} run --rm taskmoor node cli.mjs restore <dir> --yes" 3
fi
say "the upgrade did not complete; the database is as it was. Starting $old again."
start "$old"
die "not upgraded: see the report above; $old is running"
`;

export const UPDATE_SH = `#!/usr/bin/env bash
# One update command for a kit that runs on Docker Compose (OPS-025, ADR-117):
#
#   bash update.sh                     the newest release
#   bash update.sh 1.4.0               that release
#   bash update.sh [1.4.0] --dry-run   says what it would do and runs the upgrade's checks;
#                                      nothing changes or stops
#
# It finds the newest release from the project's public GitHub releases, checks that the release
# is signed with the project's release key (taskmoor-release.pub, beside this script), and then
# runs upgrade.sh with the image the signature names, by digest, which backs up, migrates and
# rolls back. A release it cannot verify is never installed, whichever version was asked for.
#
# Exit codes: 0 updated, or nothing to do; 1 not updated, and the previous version is running on
# the unchanged database; 2 wrong arguments; 3 the update and its rollback failed, and the backend
# stays stopped; 4 the backend or its database did not come back, and the message says what to do.
#
# It sends the release source nothing but ordinary requests for public files. TASKMOOR_RELEASES_URL
# and TASKMOOR_RELEASE_DOWNLOADS point it at another copy of the releases (a fork, a mirror).
set -euo pipefail
cd "$(dirname "$0")"

RELEASES=\${TASKMOOR_RELEASES_URL:-https://api.github.com/repos/Rockersands/taskmoor/releases/latest}
DOWNLOADS=\${TASKMOOR_RELEASE_DOWNLOADS:-https://github.com/Rockersands/taskmoor/releases/download}
RELEASE_PAGES=https://github.com/Rockersands/taskmoor/releases/tag
KEY=taskmoor-release.pub
MANIFEST=taskmoor-release.txt

say() { printf '%s\\n' "$*"; }
usage() { say "usage: bash update.sh [version] [--dry-run]"; }

wanted=
dry=
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=yes ;;
    -h | --help) usage; exit 0 ;;
    -*) say "update: unknown option $arg" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$wanted" ]; then say "update: more than one version given" >&2; usage >&2; exit 2; fi
      wanted=\${arg#v}
      if ! [[ "$wanted" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then
        say "update: $arg is not a version like 1.4.0" >&2
        exit 2
      fi
      ;;
  esac
done

setting() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

# The image this kit runs now, and its parts: registry and name, and the version in its tag.
current_image=\${TASKMOOR_IMAGE:-$(setting TASKMOOR_IMAGE)}
ref=\${current_image%%@*}
case "\${ref##*/}" in
  *:*) current_repo=\${ref%:*}; current=\${ref##*:} ;;
  *) current_repo=$ref; current= ;;
esac
[[ "$current" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || current=
running_now=\${current:-the version you run now}

# Nothing has started changing while this one is in use.
refuse() {
  say "update: $1" >&2
  say "update: nothing was changed; $running_now stays as it is." >&2
  exit 1
}

# Whether version $1 is older than version $2.
older() {
  local a b i
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    if ((10#\${a[i]} < 10#\${b[i]})); then return 0; fi
    if ((10#\${a[i]} > 10#\${b[i]})); then return 1; fi
  done
  return 1
}

# Downloads a public file, with either tool; the signature, not the connection, is the proof.
get() { # url, file, extra header
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time 120 --max-filesize 4194304 --proto-redir =https \\
      \${3:+-H "$3"} -o "$2" -- "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=30 --tries=1 \${3:+--header="$3"} -O "$2" -- "$1" 2>/dev/null
  else
    refuse "this needs curl or wget to read the releases; install one, or run upgrade.sh yourself"
  fi
}

[ -f upgrade.sh ] || refuse "upgrade.sh is missing from this folder; run this from the kit folder"
[ -f "$KEY" ] || refuse "$KEY is missing from this folder, so no release can be verified"
command -v openssl >/dev/null 2>&1 || refuse "openssl is needed to check the release's signature; install it and run this again"
command -v base64 >/dev/null 2>&1 || refuse "base64 is needed to check the release's signature"
if [ "\${TASKMOOR_PULL:-missing}" = never ]; then
  refuse "TASKMOOR_PULL=never: this install contacts no registry; update it from the air-gap bundle instead (tools/airgap/README.md)"
fi
command -v docker >/dev/null 2>&1 || refuse "Docker is not installed"
docker compose version >/dev/null 2>&1 || refuse "Docker Compose v2 is missing (the 'docker compose' command)"
docker info >/dev/null 2>&1 || refuse "Docker is not running, or this user may not use it"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The version: the one asked for, or the newest stable release. Only the shape of the answer is
# believed; the signature below says whether that release is real.
if [ -n "$wanted" ]; then
  target=$wanted
else
  say "looking up the newest release"
  if ! get "$RELEASES" "$work/latest.json" "Accept: application/vnd.github+json"; then
    refuse "could not read the newest release from $RELEASES. If this server has no internet, or none has been published, name a version: bash update.sh 1.4.0"
  fi
  tag=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$work/latest.json" | head -1)
  target=\${tag#v}
  if ! [[ "$target" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then
    refuse "the newest release is tagged '\${tag:-nothing}', which is not a version like 1.4.0"
  fi
fi

if [ -n "$current" ]; then
  if [ "$target" = "$current" ]; then
    say "Taskmoor $current is the version this kit runs: nothing to do."
    exit 0
  fi
  if older "$target" "$current"; then
    if [ -z "$wanted" ]; then
      say "Taskmoor $current is newer than the newest release ($target): nothing to do."
      exit 0
    fi
    refuse "$target is older than $current. Going back takes a backup from before the upgrade (see the manual: Upgrades)"
  fi
fi

# The release's signed statement: which image is this version. No statement, or one that does
# not verify, and this stops here: the release cannot be told from a forgery.
say "checking the signature of release $target"
for name in "v$target" "$target"; do
  if get "$DOWNLOADS/$name/$MANIFEST" "$work/$MANIFEST" &&
    get "$DOWNLOADS/$name/$MANIFEST.sig" "$work/$MANIFEST.sig"; then
    break
  fi
  rm -f "$work/$MANIFEST" "$work/$MANIFEST.sig"
done
[ -s "$work/$MANIFEST" ] && [ -s "$work/$MANIFEST.sig" ] ||
  refuse "release $target cannot be verified: it has no signed $MANIFEST, or it could not be downloaded from $DOWNLOADS"
base64 -d <"$work/$MANIFEST.sig" >"$work/signature" 2>/dev/null ||
  refuse "release $target cannot be verified: its signature is damaged"
openssl dgst -sha256 -verify "$KEY" -signature "$work/signature" "$work/$MANIFEST" >/dev/null 2>&1 ||
  refuse "release $target cannot be verified: its signature does not match $KEY. Do not use it, and tell the project"

signed_version=$(sed -n 's/^version=//p' "$work/$MANIFEST")
signed_image=$(sed -n 's/^image=//p' "$work/$MANIFEST")
[ "$signed_version" = "$target" ] ||
  refuse "release $target cannot be verified: its signature is for version '$signed_version'"
if ! [[ "$signed_image" =~ ^([a-z0-9][a-z0-9._:/-]*)@(sha256:[0-9a-f]{64})$ ]]; then
  refuse "release $target cannot be verified: its signed statement names no image digest"
fi
repo=\${BASH_REMATCH[1]}
digest=\${BASH_REMATCH[2]}
case "\${repo##*/}" in *:*) repo=\${repo%:*} ;; esac
# A kit on a registry of its own keeps it: the digest is the same image on any registry.
case "$current_repo" in */*) repo=$current_repo ;; esac
new="$repo:$target@$digest"
say "verified: release $target is signed with $KEY; the image is $new"

# Frontends on other hosts stay behind whatever happens here. A frontend the backend serves
# itself updates with it and needs no word. The running backend knows them all; failing that,
# .env lists the kit's own.
compose_files=(-f docker-compose.yml)
if [ -f docker-compose.external.yml ] && { [ -n "\${DATABASE_URL:-}" ] || grep -qE '^DATABASE_URL=' .env 2>/dev/null; }; then
  compose_files=(-f docker-compose.external.yml)
fi
for extra in \${TASKMOOR_COMPOSE_OVERRIDE:-}; do compose_files+=(-f "$extra"); done
other_frontends() {
  if docker compose "\${compose_files[@]}" exec -T taskmoor node cli.mjs frontends 2>/dev/null | tr -d '\\r' >"$work/frontends"; then
    tr '\\n' ' ' <"$work/frontends"
    return 0
  fi
  local own origin
  own=\${PUBLIC_URL:-$(setting PUBLIC_URL)}
  own=\${own%/}
  for origin in $(printf '%s' "\${TASKMOOR_ALLOWED_ORIGINS:-$(setting TASKMOOR_ALLOWED_ORIGINS)}" | tr ',' ' '); do
    origin=\${origin%/}
    if [ "$origin" != "$own" ]; then printf '%s ' "$origin"; fi
  done
}
frontend_steps() { # what the update does not reach
  local origins
  origins=$(other_frontends || true)
  if [ -n "$origins" ]; then
    say ""
    say "One more step: the frontend on another host ($(printf '%s' "$origins" | sed 's/ *$//; s/  */, /g')) keeps its version until you replace it:"
    say "  1. Open the new Builder: download it from $RELEASE_PAGES/v$target"
    say "  2. Load your saved project file in it."
    say "  3. Upload the new frontend it makes to that host."
  fi
}

if [ -n "$dry" ]; then
  say ""
  say "This is a dry run: nothing changes and the backend keeps running."
  say "The update would go from \${current:-the version you run now} to $target:"
  say "  1. pull the image, if it is not here yet;"
  say "  2. stop the backend and back up the database, the files and the password keyring;"
  say "  3. apply the migrations and check the result;"
  say "  4. record the image in .env and start it;"
  say "  5. if anything fails, put the database back and start the previous version again."
  say ""
  set +e
  bash upgrade.sh "$new" --dry-run
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    say "update: the upgrade's checks stopped here (exit code $code); the report above says why. Nothing was changed." >&2
    exit "$code"
  fi
  frontend_steps
  exit 0
fi

set +e
bash upgrade.sh "$new"
code=$?
set -e
case "$code" in
  0)
    say "Updated: Taskmoor $target is running."
    frontend_steps
    exit 0
    ;;
  1)
    say "update: the update to $target did not complete, and $running_now is running again on the database as it was. The report above says why; fix that and run this again." >&2
    exit 1
    ;;
  3)
    say "update: the update to $target failed and so did putting the database back. The previous version is NOT back: the backend stays stopped. Restore the pre-upgrade backup with the command above (manual: Upgrades, If an upgrade fails)." >&2
    exit 3
    ;;
  4)
    say "update: Taskmoor did not come back. The previous version is NOT confirmed running: the message above says which part did not start. Read its log with 'docker compose logs taskmoor' (manual: Upgrades, If an upgrade fails)." >&2
    exit 4
    ;;
  *)
    say "update: upgrade.sh stopped unexpectedly (exit code $code). The update to $target may not have finished: check 'docker compose ps' and the output above." >&2
    exit "$code"
    ;;
esac
`;

/** The public half of the release key: what update.sh checks a release against. */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/eSlm9CBGea5VW2/n3xQJfLLBekg
lRwlV+PMMnA/PpaG5bWqMKcvXGEHeYVRP+YTP9s5bXoRegBVQdagb4aBCw==
-----END PUBLIC KEY-----
`;
