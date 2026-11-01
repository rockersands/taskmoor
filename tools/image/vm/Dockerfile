# The "fresh VM" of tools/image/fresh-vm.sh (M1-113; NFR-013): a Docker host with nothing on it
# but what a person would install on a new server before running the backend kit: Docker with
# Compose, bash, curl and unzip. It runs privileged, with its own empty image store.
FROM docker:27-dind
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/build_ca > /tmp/build-ca.pem; \
      export SSL_CERT_FILE=/tmp/build-ca.pem; \
    fi; \
    apk add --no-cache bash curl unzip && rm -f /tmp/build-ca.pem
