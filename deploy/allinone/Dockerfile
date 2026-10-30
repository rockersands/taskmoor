# syntax=docker/dockerfile:1.7
# The all-in-one image (ADR-021, M0-026): the one Taskmoor image plus PostgreSQL 16 in the
# same container, for trials and single-box installs. One volume (/data) holds the database
# and the files. Build it on top of the main image:
#   docker build -f deploy/allinone/Dockerfile --build-arg BASE=taskmoor:dev -t taskmoor-allinone:dev .
ARG BASE=taskmoor:dev
FROM ${BASE}
USER root
RUN apk add --no-cache postgresql16 postgresql16-client postgresql16-contrib su-exec \
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
