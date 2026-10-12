#!/usr/bin/env bash
# The Helm chart on kind (M1-099): install with two app replicas and an in-cluster PostgreSQL,
# run `helm test`, then roll the app to a new revision while clients keep calling it and require
# zero failed requests. Needs docker, kind, helm and kubectl, and the image built as $TAG.
#   TAG=taskmoor:dev bash tools/helm/kind-test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1

TAG=${TAG:-taskmoor:dev}
CLUSTER=${CLUSTER:-taskmoor-test}
RELEASE=taskmoor
KEEP=${KEEP_CLUSTER:-}
cleanup() { [ -n "$KEEP" ] || kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== cluster"
kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --wait 120s
kubectl config use-context "kind-$CLUSTER" >/dev/null
kind load docker-image "$TAG" --name "$CLUSTER"

echo "== postgres"
kubectl apply -f tools/helm/postgres.yaml >/dev/null
kubectl rollout status deploy/postgres --timeout=180s

repo=${TAG%:*}
tag=${TAG##*:}
values=(
  --set "image.repository=$repo" --set "image.tag=$tag" --set image.pullPolicy=Never
  --set database.existingSecret=taskmoor-db
  # Two app pods need shared files; the app reads the S3 settings from M1-016 on, so a
  # placeholder bucket is enough for this test.
  --set storage.type=s3 --set storage.s3.bucket=kind-test
  --set app.replicas=2 --set publicUrl=http://taskmoor.test
)

echo "== install"
helm upgrade --install "$RELEASE" deploy/helm/taskmoor "${values[@]}" --wait --timeout 5m
helm test "$RELEASE" --timeout 3m --logs | grep -E "^ok:|Phase:"

echo "== rolling upgrade under load"
kubectl delete pod load --ignore-not-found >/dev/null
kubectl create configmap load-script --from-file=load.mjs=tools/helm/load.mjs --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: { name: load }
spec:
  restartPolicy: Never
  containers:
    - name: load
      image: $TAG
      imagePullPolicy: Never
      command: ["node", "/load/load.mjs"]
      env:
        - { name: TARGET, value: "http://$RELEASE" }
        - { name: LOAD_SECONDS, value: "150" }
      volumeMounts: [{ name: load, mountPath: /load }]
  volumes: [{ name: load, configMap: { name: load-script } }]
YAML
kubectl wait pod/load --for=condition=Ready --timeout=60s >/dev/null
sleep 15
start=$(date +%s)
helm upgrade "$RELEASE" deploy/helm/taskmoor "${values[@]}" \
  --set-string "app.podAnnotations.rolled=$start" --wait --timeout 5m
echo "rollout finished in $(( $(date +%s) - start ))s"
kubectl wait pod/load --for=jsonpath='{.status.phase}'=Succeeded --timeout=240s >/dev/null
result=$(kubectl logs load | tail -1)
echo "$result"
failed=$(echo "$result" | sed -E 's/.*"failed":([0-9]+).*/\1/')
ok=$(echo "$result" | sed -E 's/.*"ok":([0-9]+).*/\1/')
if [ "$failed" != "0" ] || [ "$ok" -lt 100 ]; then
  echo "== rolling upgrade failed requests: $failed"
  exit 1
fi
echo "== kind test passed: $ok requests, none failed, during a rolling upgrade"
