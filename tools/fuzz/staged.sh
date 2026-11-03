#!/usr/bin/env bash
# Staged fuzzing for M1 (the user's decision of 2026-11-02; ADR-104 Changes): 1 h, then 2 h, 4 h
# and 8 h, all fuzz targets in parallel at the lowest priority. A stage starts only when the one
# before was clean for every target. A finished stage leaves .cache/fuzz-stages/stage-<h>h/done
# (or failed, with the failing inputs copied there), so running this again after an interruption
# resumes at the stage it stopped in; that stage starts over, because a run counts only whole.
# When stage 8h is done, copy each target's report (stage-8h/<target>.json) into
# docs/security/fuzz-results.json: `pnpm gate M1` reads it (FUZZ_GATE_SECONDS is 8 hours).
#
#   bash tools/fuzz/staged.sh            # all stages
#   STAGES="1" bash tools/fuzz/staged.sh # one stage only
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=.cache/fuzz-stages
TARGETS=${TARGETS:-"query formula text href wiki markdown adf csv dc-xml dc-stage scim addresses rich-text"}
STAGES=${STAGES:-"1 2 4 8"}
mkdir -p "$OUT"
for hours in $STAGES; do
  dir=$OUT/stage-${hours}h
  [ -f "$dir/done" ] && continue
  [ -f "$dir/failed" ] && { echo "stage ${hours}h failed earlier; see $dir"; exit 1; }
  mkdir -p "$dir"
  echo "$(date -u +%FT%TZ) stage ${hours}h starts" | tee -a "$OUT/staged.log"
  pids=()
  for t in $TARGETS; do
    nice -n 19 corepack pnpm -s fuzz "$t" --minutes $((hours * 60)) --seed $((1180300 + hours)) \
      --hang-seconds 120 > "$dir/$t.log" 2>&1 < /dev/null &
    pids+=($!)
  done
  ok=1
  for p in "${pids[@]}"; do wait "$p" || ok=0; done
  for t in $TARGETS; do cp -f ".verify/fuzz-$t.json" "$dir/$t.json" 2>/dev/null || ok=0; done
  if [ $ok = 1 ]; then
    touch "$dir/done"
    echo "$(date -u +%FT%TZ) stage ${hours}h clean" | tee -a "$OUT/staged.log"
  else
    touch "$dir/failed"
    cp -f .cache/fuzz/*.txt "$dir/" 2>/dev/null
    echo "$(date -u +%FT%TZ) stage ${hours}h FAILED: reproduce each failure alone with its seed, fix it with a regression test, delete $dir and run again" | tee -a "$OUT/staged.log"
    exit 1
  fi
done
echo "$(date -u +%FT%TZ) all stages clean" | tee -a "$OUT/staged.log"
