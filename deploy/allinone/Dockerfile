# syntax=docker/dockerfile:1.7
# The all-in-one image (ADR-021, M0-026): the one Tracksmith image plus PostgreSQL 16 in the
# same container, for trials and single-box installs. One volume (/data) holds the database
# and the files. Build it on top of the main image:
#   docker build -f deploy/allinone/Dockerfile --build-arg BASE=tracksmith:dev -t tracksmith-allinone:dev .
ARG BASE=tracksmith:dev
FROM ${BASE}
USER root
RUN apk add --no-cache postgresql16 postgresql16-client postgresql16-contrib su-exec \
    && mkdir -p /data /run/postgresql \
    && chown node:node /data \
    && chown postgres:postgres /run/postgresql
COPY deploy/allinone/entrypoint.sh /usr/local/bin/tracksmith-allinone
RUN chmod 755 /usr/local/bin/tracksmith-allinone
ENV TRACKSMITH_DATA=/data
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["tracksmith-allinone"]
