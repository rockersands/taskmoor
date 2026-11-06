# Taskmoor air-gap bundle

Everything needed to install Taskmoor on a host with no internet access (OPS-005):

| Path | Contents |
|---|---|
| `images/` | Image archives: Taskmoor and PostgreSQL (`images.txt` lists the references, the image ids and the platform) |
| `compose/` | The Compose kit and its installer |
| `helm/` | The Helm chart, for Kubernetes clusters with a private registry |
| `web/` | The frontend build, for serving from any static host |
| `sbom.cdx.json` | Software bill of materials of the Taskmoor image (CycloneDX) |
| `SHA256SUMS`, `SHA256SUMS.sig` | Checksums of every file, and their signature |
| `cosign.pub` | The public key the signature verifies against |

Compare `cosign.pub` with the key published on the project's release page before trusting it:
a bundle can carry any key, so the check only means something against the published one.

## One platform per bundle

A bundle's images are for one kind of server: `linux/amd64` (most servers) or `linux/arm64`.
The last line of `images.txt` names it, and `install-offline.sh` stops before changing anything
when this server is the other kind, since there is no registry here to fetch the right images
from. To see which one a server is: `docker version --format '{{.Server.Os}}/{{.Server.Arch}}'`.

Making a bundle (`tools/airgap/bundle.sh` in the repository) takes the platform as `PLATFORM`,
`linux/amd64` unless set, and refuses an image the local Docker does not hold for it. A machine
of the other kind, such as an Apple silicon Mac for an amd64 bundle, needs the images for that
platform: `docker pull --platform linux/amd64 <image>`, or `docker buildx build --platform
linux/amd64 --load` for an image built there. A missing database image is pulled for
`PLATFORM`.

A tag can hold more than one platform: with the containerd image store, Docker 29's default,
pulling for another platform adds it beside the one the tag held. Docker 28.1 and later
(`docker image inspect` and `docker save` take `--platform`) let the bundle check and save
`PLATFORM`'s image by name, so nothing else is needed. An older Docker cannot pick one, so there
the tag must hold that platform's image alone: remove it first (`docker image rm <image>`), then
pull it for the platform.

## Install with Docker Compose

```
bash verify.sh                 # signature and checksums; stops on any mismatch
bash install-offline.sh        # verify, load the images, install without contacting a registry
```

The installer prints the one-time setup link. The instance makes no outbound connections by
default: no telemetry, no update check (the installer writes `TASKMOOR_UPDATE_CHECK=off` into
`compose/.env`), and AI features stay off until a local model is configured.

## Upgrade with Docker Compose

Verify the new bundle, check that `images.txt` names this server's platform (above), and load
its images, then run its `upgrade.sh` from the kit directory you installed from (where `.env`
is): it backs up, migrates and rolls back on failure (OPS-006, `INSTALL.md`, Upgrades), without
contacting a registry.

```
bash verify.sh
for archive in images/*.tar.gz; do gzip -dc "$archive" | docker load; done
cp compose/upgrade.sh <installed kit>/
TASKMOOR_PULL=never bash <installed kit>/upgrade.sh "$(awk '$1 == "taskmoor" { print $2 }' images.txt)"
```

## Kubernetes

Push the two images to your private registry (`docker load` the archives, then `docker tag` and
`docker push`), then install the chart from `helm/` with `--set image.repository=<registry>/taskmoor`.

## Verifying with cosign

The signature is in the format `cosign sign-blob --key` writes, so with cosign available:

```
cosign verify-blob --key cosign.pub --signature SHA256SUMS.sig SHA256SUMS
```
