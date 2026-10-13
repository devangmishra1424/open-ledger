"""Reads every test-set document with the real reader (no HTTP) into eval/documents/readings/<sha256>.json, the same
cache eval/documents/run.ts uses, and prints how long each took. For development: the scorer can then re-score
field extraction without re-running OCR.   docreader/.venv/Scripts/python eval/documents/read_all.py"""
import hashlib, json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "docreader"))
import reader  # noqa: E402

root = Path(__file__).resolve().parent
cache = root / "readings"
cache.mkdir(exist_ok=True)
reader.warm_up()
for path in sorted((root / "invoices").glob("*/*")) + sorted((root / "purchase_orders").glob("*/*")):
    if path.name == "truth.json":
        continue
    data = path.read_bytes()
    out = cache / f"{hashlib.sha256(data).hexdigest()}.json"
    if out.exists() and "--fresh" not in sys.argv:
        continue
    t0 = time.time()
    try:
        r = reader.read_document(data, path.name)
        out.write_text(json.dumps(r.to_dict(), ensure_ascii=False), encoding="utf-8")
        print(f"{path.parent.name}/{path.name}: {time.time() - t0:.1f}s kind={r.source_kind} ocr={r.ocr_confidence} tables={len(r.tables)} rows={sum(len(p['rows']) for p in r.layout)}", flush=True)
    except reader.ReaderError as e:
        print(f"{path.parent.name}/{path.name}: REFUSED {e.status} {e.message}", flush=True)
