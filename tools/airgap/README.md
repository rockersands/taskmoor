# Taskmoor air-gap bundle

Everything needed to install Taskmoor on a host with no internet access (OPS-005):

| Path | Contents |
|---|---|
| `images/` | Image archives: Taskmoor and PostgreSQL (`images.txt` lists the references and image ids) |
| `compose/` | The Compose kit and its installer |
| `helm/` | The Helm chart, for Kubernetes clusters with a private registry |
| `web/` | The frontend build, for serving from any static host |
| `sbom.cdx.json` | Software bill of materials of the Taskmoor image (CycloneDX) |
| `SHA256SUMS`, `SHA256SUMS.sig` | Checksums of every file, and their signature |
| `cosign.pub` | The public key the signature verifies against |

Compare `cosign.pub` with the key published on the project's release page before trusting it:
a bundle can carry any key, so the check only means something against the published one.

## Install with Docker Compose

```
bash verify.sh                 # signature and checksums; stops on any mismatch
bash install-offline.sh        # verify, load the images, install without contacting a registry
```

The installer prints the one-time setup link. The instance makes no outbound connections by
default: no telemetry, no update check (the installer writes `TASKMOOR_UPDATE_CHECK=off` into
`compose/.env`), and AI features stay off until a local model is configured.

## Upgrade with Docker Compose

Verify the new bundle and load its images, then run its `upgrade.sh` from the kit directory you
installed from (where `.env` is): it backs up, migrates and rolls back on failure (OPS-006,
`INSTALL.md`, Upgrades), without contacting a registry.

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
