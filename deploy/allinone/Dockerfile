# syntax=docker/dockerfile:1.7
# The all-in-one image (ADR-021, M0-026): the one Taskmoor image plus PostgreSQL 16 in the
# same container, for trials and single-box installs. One volume (/data) holds the database
# and the files. Build it on top of the main image:
#   docker build -f deploy/allinone/Dockerfile --build-arg BASE=taskmoor:dev -t taskmoor-allinone:dev .
# Behind a proxy that re-signs TLS, pass its CA as the build secret `build_ca` and the proxy as
# the HTTPS_PROXY build argument, as for the main image (the secret is never written to a layer).
ARG BASE=taskmoor:dev
FROM ${BASE}
USER root
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/build_ca > /tmp/build-ca.pem; \
      export SSL_CERT_FILE=/tmp/build-ca.pem; \
    fi; \
    apk add --no-cache postgresql16 postgresql16-client postgresql16-contrib su-exec \
    && rm -f /tmp/build-ca.pem \
    && mkdir -p /data /run/postgresql \
    && chown node:node /data \
    && chown postgres:postgres /run/postgresql
COPY deploy/allinone/entrypoint.sh /usr/local/bin/taskmoor-allinone
RUN chmod 755 /usr/local/bin/taskmoor-allinone
ENV TASKMOOR_DATA=/data
# Clean URLs (M1-134, ADR-066); `-e TASKMOOR_WEB_ROUTING=hash` brings hash routing back.
ENV TASKMOOR_WEB_ROUTING=path
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["taskmoor-allinone"]
