# Benchmark baselines

`pnpm bench:check` compares the latest results in `docs/spikes/data` with the files here and
fails on a regression over 20% (beyond a small noise floor) or a missed budget. The top level
holds the development machine's accepted results; `ci/` holds the nightly runner's, written
after its first green run. Update a baseline on purpose, in the same commit as the change that
moved the numbers, and say why in the commit message.
