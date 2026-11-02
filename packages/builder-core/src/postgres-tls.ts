/**
 * TLS between the backend and the bundled PostgreSQL of the Compose kits (ASVS 1.9.1;
 * IAM-017; ADR-111). One definition for `deploy/compose/docker-compose.yml` and the Builder's
 * backend kit, so both behave alike; a test holds the Compose file to these texts.
 *
 * - A one-shot `postgres-tls` service, in the PostgreSQL image (which has `openssl`), runs at
 *   every `docker compose up` before PostgreSQL starts. The first time it makes a private
 *   certificate authority (P-256, 20 years; its key stays in the `postgres-ca` volume, which
 *   nothing else mounts) and a server certificate for the host name `postgres` (10 years). Later
 *   runs keep both and reissue only a server certificate that is missing, expires within 90
 *   days or no longer verifies, so an upgrade of an existing install gets one at its next start.
 *   It also writes the `pg_hba.conf` PostgreSQL then uses: TLS with a password for every
 *   network connection, plain connections refused, the container's own socket trusted (the
 *   image's health check and setup scripts).
 * - PostgreSQL runs with `ssl=on`, TLS 1.2 at least, that certificate and that `pg_hba.conf`.
 * - The backend connects with `sslmode=verify-full` against the authority's certificate, so it
 *   checks the certificate and the host name; the `postgres-tls` volume is mounted read-only.
 *
 * Nothing secret is generated outside the install, nor kept in the kit: the keys are made on
 * the machine the kit runs on, at its first start.
 */

/** Where the backend container finds the authority's certificate. */
export const DB_TLS_MOUNT = '/db-tls';

/** The connection URL's TLS parameters, after the database name. */
export const DB_TLS_PARAMS = `sslmode=verify-full&sslrootcert=${DB_TLS_MOUNT}/ca.crt`;

/**
 * The shell script the `postgres-tls` service runs (as root, POSIX sh). Its directories, the
 * key's owner and the host name can be changed through the environment for tests.
 */
export const POSTGRES_TLS_SCRIPT = `set -eu
umask 077
ca=\${TLS_CA_DIR:-/ca}
out=\${TLS_DIR:-/tls}
owner=\${TLS_KEY_OWNER:-postgres:postgres}
host=\${TLS_HOST:-postgres}
mkdir -p "$ca" "$out"
if [ ! -s "$ca/ca.key" ] || [ ! -s "$ca/ca.crt" ]; then
  openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -days 7300 \\
    -subj "/CN=Taskmoor database CA" -addext "basicConstraints=critical,CA:TRUE" \\
    -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout "$ca/ca.key" -out "$ca/ca.crt" 2>/dev/null
  rm -f "$out/server.crt"
  echo "postgres-tls: made the private certificate authority"
fi
if [ ! -s "$out/server.crt" ] || [ ! -s "$out/server.key" ] \\
  || ! openssl x509 -checkend 7776000 -noout -in "$out/server.crt" >/dev/null 2>&1 \\
  || ! openssl verify -CAfile "$ca/ca.crt" "$out/server.crt" >/dev/null 2>&1; then
  printf 'subjectAltName=DNS:%s,DNS:localhost\\nbasicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\nextendedKeyUsage=serverAuth\\n' "$host" > "$out/server.ext"
  openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 -subj "/CN=$host" \\
    -keyout "$out/server.key.new" -out "$out/server.csr" 2>/dev/null
  openssl x509 -req -sha256 -days 3650 -in "$out/server.csr" -CA "$ca/ca.crt" -CAkey "$ca/ca.key" \\
    -set_serial "0x$(openssl rand -hex 16)" -extfile "$out/server.ext" -out "$out/server.crt.new" 2>/dev/null
  mv "$out/server.key.new" "$out/server.key"
  mv "$out/server.crt.new" "$out/server.crt"
  rm -f "$out/server.csr" "$out/server.ext"
  echo "postgres-tls: issued the database certificate for $host"
fi
cp "$ca/ca.crt" "$out/ca.crt"
printf '%s\\n' '# Written by the postgres-tls service (ADR-111): TLS for every network connection.' \\
  'local   all all     trust' \\
  'hostssl all all all scram-sha-256' \\
  'host    all all all reject' > "$out/pg_hba.conf"
chown "$owner" "$out/server.key"
chmod 600 "$out/server.key" "$ca/ca.key"
chmod 644 "$out/server.crt" "$out/ca.crt" "$out/pg_hba.conf"
chmod 755 "$out"
`;

/** Text as Compose reads it: `$` doubled, so Compose leaves the shell's variables alone. */
const forCompose = (text: string) => text.replaceAll('$', () => '$$');

/** Lines indented by `spaces`, empty lines left empty. */
const indent = (text: string, spaces: number) =>
  text
    .split('\n')
    .map((line) => (line === '' ? '' : `${' '.repeat(spaces)}${line}`))
    .join('\n');

/** The `postgres-tls` service, as Compose YAML under `services:` (two-space indent). */
export function postgresTlsService(image: string): string {
  return `  postgres-tls:
    # The database's TLS certificate (ASVS 1.9.1, ADR-111): made at the first start, renewed
    # before it expires. A private authority whose key stays in the postgres-ca volume.
    image: ${image}
    user: "0:0"
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
${indent(forCompose(POSTGRES_TLS_SCRIPT).trimEnd(), 8)}
    volumes:
      - postgres-ca:/ca
      - postgres-tls:/tls
    restart: "no"
`;
}

/** PostgreSQL's command line: TLS on, with the certificate and `pg_hba.conf` made above. */
export const POSTGRES_TLS_COMMAND = `    command:
      - postgres
      - -c
      - ssl=on
      - -c
      - ssl_min_protocol_version=TLSv1.2
      - -c
      - ssl_cert_file=/tls/server.crt
      - -c
      - ssl_key_file=/tls/server.key
      - -c
      - hba_file=/tls/pg_hba.conf
`;

/** PostgreSQL waits for the certificate. */
export const POSTGRES_TLS_DEPENDS = `    depends_on:
      postgres-tls:
        condition: service_completed_successfully
`;
