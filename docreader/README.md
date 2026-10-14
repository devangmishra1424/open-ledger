# VeriBook document reader

A small Python service that turns a business document into text, tables and positioned rows of text, for VeriBook's
field rules (`lib/documents/`). Built on [Docling](https://github.com/docling-project/docling) (layout and table
models) with RapidOCR, plus scanner-style page cleanup (`scan.py`). How it works and why: `docs/HOW_IT_WORKS.md`
section 1; how well: `docs/EVAL.md` section 5.

```bash
python -m venv docreader/.venv                                   # Python 3.12
docreader/.venv/Scripts/pip install -r docreader/requirements.txt   # bin/pip on Linux/macOS; ~2 GB
npm run reader                                                   # 127.0.0.1:8090 (DOCREADER_PORT to change)
```

- `GET /health`: `{"status": "ok", "models_loaded": true, ...}` once the models are loaded (10-30 s after start).
- `POST /read` (multipart, field `file`): a Reading (`reader.py`), or `{"error": ...}` with 400 damaged/renamed, 413 too
  large (20 MB / 20 pages), 415 unsupported type, 422 no readable text, 503 busy or out of memory.

It only reads; it never decides what a field means or how far to trust it. VeriBook's API calls it at `DOCREADER_URL`
(default `http://127.0.0.1:8090`) and refuses documents with a 503 when it is not running.

**Versions are pinned** (`requirements.txt`) to the set BusinessFlow verified on real scans: an unpinned
`docling-ibm-models` or `rapidocr` has silently broken OCR before. `onnxruntime` is listed explicitly because RapidOCR
needs it but does not declare it.

**Memory:** about 1.1 GB with the models loaded. Documents are read one at a time; up to 3 wait, beyond that 503.

**Tests:** `docreader/.venv/Scripts/python -m pytest docreader/tests` (about a minute: the read tests run the real models
on the generated test set). CI runs only the tests that need no models (file-type detection, page straightening,
finding the page in a photo).
