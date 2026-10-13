"""VeriBook's document reader as a small HTTP service (VeriBook's Next.js API calls it; it is not public).

    GET  /health   {"status": "ok", "models_loaded": true, ...}
    POST /read     multipart form, field "file" -> a Reading (see reader.py), or {"error": "..."} with
                   400 damaged/empty, 413 too big, 415 unsupported type, 422 no readable text, 503 busy

Run:  docreader/.venv/Scripts/python -m uvicorn app:app --app-dir docreader --host 127.0.0.1 --port 8090

Concurrency: documents are read one at a time (reader._convert_lock), because the layout/OCR models use most
of a small machine's memory. Up to MAX_WAITING more requests wait their turn; beyond that the service answers 503
at once instead of building an unbounded queue, and the caller says so to the person.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

import reader

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("docreader")

MAX_WAITING = 3
_slots = threading.BoundedSemaphore(MAX_WAITING + 1)
_state = {"models_loaded": False, "started_at": time.time()}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.environ.get("DOCREADER_SKIP_WARMUP") != "1":
        t0 = time.perf_counter()
        await run_in_threadpool(reader.warm_up)
        logger.info("models loaded in %.1f s", time.perf_counter() - t0)
    _state["models_loaded"] = True
    yield


app = FastAPI(title="VeriBook document reader", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "models_loaded": _state["models_loaded"],
        "supported": reader.SUPPORTED_EXTENSIONS,
        "max_file_mb": reader.MAX_FILE_BYTES // 1024 // 1024,
        "max_pages": reader.MAX_PAGES,
    }


def _read_with_slot(data: bytes, filename: str):
    if not _slots.acquire(blocking=False):
        raise reader.ReaderBusy("the document reader is busy with other documents; try again in a minute")
    try:
        return reader.read_document(data, filename)
    finally:
        _slots.release()


@app.post("/read")
async def read(file: UploadFile = File(...)):
    filename = (file.filename or "document").replace("\\", "/").rsplit("/", 1)[-1][:200]
    data = await file.read(reader.MAX_FILE_BYTES + 1)
    try:
        reading = await run_in_threadpool(_read_with_slot, data, filename)
    except reader.ReaderError as e:
        logger.info("refused (%d): %s", e.status, e.message)
        return JSONResponse({"error": e.message}, status_code=e.status)
    return reading.to_dict()
