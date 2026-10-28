# A throwaway OpenLDAP server for the directory sync end-to-end test (M1-082). Debian's slapd,
# configured at start by entrypoint.sh from what tools/ldap/openldap-test.sh copies in: the
# generated directory (LDIF), the passwords and a self-signed certificate, all made per run.
FROM debian:bookworm-slim
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends slapd ldap-utils \
  && rm -rf /var/lib/apt/lists/* /etc/ldap/slapd.d /var/lib/ldap/*
COPY slapd.conf entrypoint.sh /etc/ldap/taskmoor/
RUN chmod +x /etc/ldap/taskmoor/entrypoint.sh
EXPOSE 389
ENTRYPOINT ["/etc/ldap/taskmoor/entrypoint.sh"]
