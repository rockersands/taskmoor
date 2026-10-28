#!/bin/sh
# Starts slapd for the end-to-end test: fills in the root password hash, loads the generated
# directory once, and runs in the foreground on ldap:// with StartTLS available.
set -eu
: "${LDAP_ROOT_PASSWORD:?LDAP_ROOT_PASSWORD is required}"
conf=/etc/ldap/slapd.conf
hash="$(slappasswd -s "$LDAP_ROOT_PASSWORD")"
sed "s|@ROOT_PASSWORD_HASH@|$hash|" /etc/ldap/taskmoor/slapd.conf > "$conf"
mkdir -p /run/slapd /var/lib/ldap
if [ -f /etc/ldap/taskmoor/seed/directory.ldif ] && [ ! -f /var/lib/ldap/data.mdb ]; then
  slapadd -q -f "$conf" -l /etc/ldap/taskmoor/seed/directory.ldif
fi
exec slapd -d 256 -f "$conf" -h "ldap:///"
