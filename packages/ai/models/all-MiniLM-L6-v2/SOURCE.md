# all-MiniLM-L6-v2 (bundled embedding model, M1-078)

The local embedding model Taskmoor ships so that duplicate detection and similar-ticket search
work with no cloud key and no internet (AI-012). It is a sentence-embedding model: 384
dimensions, mean pooling, trained by the sentence-transformers project.

- **Source:** <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2>, commit
  `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`, downloaded on 2026-10-31 (the user allowed the
  host for this one download).
- **Licence:** Apache License 2.0 (`LICENSE`, the text from apache.org; the model card states
  the licence). Bundling and redistribution are allowed with the licence and notices kept.
- **Weights:** `model_qint8.onnx` is the repository's `onnx/model_qint8_arm64.onnx`, the int8
  quantisation the repository publishes; its `_avx512` and `_avx512_vnni` files are the same
  bytes, so one file serves amd64 and arm64.
- **Verified:** every file matched the hash the source publishes for that commit (SHA-256 for
  the weights, the git object id for the small files) before it was committed. The full
  precision `onnx/model.onnx` (90,405,214 bytes, SHA-256
  `6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452`) was checked too but is
  not committed; the int8 model is what ships.
- **Renamed:** `README.md` of the source is `MODEL_CARD.md` here; `model_qint8_arm64.onnx` is
  `model_qint8.onnx`. Nothing else was changed.
- **Integrity:** `SHA256SUMS` lists every file here; `models.test.ts` fails if any file changes.

Nothing at build or run time downloads a model. To move to another model or version, download
it the same way, verify it against the source's hashes, and replace this folder in one change.
