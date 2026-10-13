"""Reading one business document (an invoice, a purchase order, a delivery note) into text and tables.

    bytes ──► what is it? (by its content, not its name)
               ├─ PDF with a text layer ......... Docling: layout + table structure (no OCR needed)
               ├─ PDF that is a scan ............ each page rendered, straightened and cleaned (scan.py),
               │                                  then Docling with full-page OCR (RapidOCR)
               ├─ photo / image (JPG, PNG, ...) . page found in the photo, perspective flattened, straightened,
               │                                  light evened (scan.py), then Docling with full-page OCR
               └─ Word / Excel / PowerPoint / HTML / Markdown / CSV ... Docling's own parsers (no OCR)
           ──► Reading: markdown (tables kept as tables), each table as columns + rows, the page rebuilt as
               rows of positioned text cells (`layout`, see below), OCR confidence, what was done to each page,
               warnings

Why `layout` as well as tables: Docling's table model reads clean grids well, but on dense boxed layouts (a
Tally-style GST invoice, the most common format in India) it can merge a whole page into one table and several
rows into one cell. The text itself is still read correctly; only the structure is lost. `layout` keeps every
line of text with its position, grouped into the visual rows of the page, so a caller can read an item row or
a "label above value" pair from where things actually are, whatever the table model made of them.

This module only READS. Turning the text into invoice fields, and deciding how far to trust them, is the
caller's job (VeriBook's lib/documents/). A document with no readable text at all is refused here
(UnreadableDocument), because passing an empty reading on would look like an empty invoice.
"""

from __future__ import annotations

import hashlib
import io
import logging
import math
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from importlib.metadata import version

import pypdfium2 as pdfium
from PIL import Image, ImageOps, UnidentifiedImageError

from scan import prepare_page

logger = logging.getLogger("docreader")

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_PAGES = 20
SCAN_RENDER_DPI = 250
# A page with fewer text characters than this in its PDF text layer is treated as a scan.
SCANNED_PAGE_MAX_CHARS = 20
CONVERT_TIMEOUT_S = 150.0
MIN_READABLE_CHARS = 8
LOW_OCR_CONFIDENCE = 0.6

_IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tif": "image/tiff", ".tiff": "image/tiff",
                ".bmp": "image/bmp", ".webp": "image/webp"}
_OFFICE_TYPES = {".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                 ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}
_TEXTUAL_TYPES = {".html": "text/html", ".htm": "text/html", ".md": "text/markdown", ".csv": "text/csv"}
SUPPORTED_EXTENSIONS = sorted({".pdf", *_IMAGE_TYPES, *_OFFICE_TYPES, *_TEXTUAL_TYPES})


class ReaderError(Exception):
    """A document this reader refuses, with the HTTP status that says why."""

    status = 400

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class UnsupportedDocument(ReaderError):
    status = 415


class DocumentTooLarge(ReaderError):
    status = 413


class UnreadableDocument(ReaderError):
    status = 422


class ReaderBusy(ReaderError):
    status = 503


class ReaderOverloaded(ReaderError):
    """This machine failed (out of memory), not the document: worth a retry, and the operator should know."""

    status = 503


@dataclass
class TableOut:
    page: int | None
    columns: list[str]
    rows: list[list[str]]


@dataclass
class Cell:
    """One run of text on the page: its text, its box (0-1000 across and down the page, top-left origin) and,
    for OCR'd text, how sure the OCR was of it."""

    text: str
    x0: int
    y0: int
    x1: int
    y1: int
    conf: float | None


@dataclass
class Reading:
    filename: str
    media_type: str
    sha256: str
    byte_size: int
    source_kind: str  # digital_pdf | scanned_pdf | image | office | web
    page_count: int
    ocr_used: bool
    ocr_confidence: float | None
    layout_confidence: float | None
    table_confidence: float | None
    markdown: str
    tables: list[TableOut]
    # per page: {"page": n, "rows": [[Cell, ...], ...]}, rows top to bottom, cells left to right
    layout: list[dict] = field(default_factory=list)
    # the same rows as text, one row per line, cells joined by " | ", pages separated by a "--- page n ---" line
    layout_text: str = ""
    preparation: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    timing_ms: dict = field(default_factory=dict)
    reader: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------------------------------------------
# What is this file?
# ---------------------------------------------------------------------------------------------------------------
def sniff(data: bytes, filename: str) -> tuple[str, str]:
    """(kind, media_type) from the bytes themselves. The filename's extension only decides between formats that
    share a container (a .docx and a .xlsx are both ZIP files) or are plain text. A file whose content does not
    match any supported format is refused rather than handed to a parser that would guess."""
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    head = data[:16]
    if head.startswith(b"%PDF-"):
        return "pdf", "application/pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image", "image/jpeg"
    if head.startswith((b"II*\x00", b"MM\x00*")):
        return "image", "image/tiff"
    if head.startswith(b"BM"):
        return "image", "image/bmp"
    if head.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image", "image/webp"
    if head.startswith(b"PK\x03\x04") and ext in _OFFICE_TYPES:
        return "office", _OFFICE_TYPES[ext]
    if ext in _TEXTUAL_TYPES:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise UnsupportedDocument(f"{filename} is not valid UTF-8 text") from None
        return "web", _TEXTUAL_TYPES[ext]
    if ext in (".pdf", *_IMAGE_TYPES, *_OFFICE_TYPES):
        raise ReaderError(f"{filename} says it is a {ext} file, but its content is not (the file may be damaged or renamed)")
    raise UnsupportedDocument(f"{filename}: this file type is not supported. Supported: {', '.join(SUPPORTED_EXTENSIONS)}")


def pdf_text_chars_per_page(data: bytes) -> list[int]:
    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as e:
        raise ReaderError(f"this PDF could not be opened ({e}); it may be damaged or password-protected") from None
    try:
        if len(pdf) == 0:
            raise UnreadableDocument("this PDF has no pages")
        if len(pdf) > MAX_PAGES:
            raise DocumentTooLarge(f"this PDF has {len(pdf)} pages; the reader takes at most {MAX_PAGES}")
        counts = []
        for i in range(len(pdf)):
            textpage = pdf[i].get_textpage()
            try:
                counts.append(len(textpage.get_text_range().strip()))
            finally:
                textpage.close()
        return counts
    finally:
        pdf.close()


# ---------------------------------------------------------------------------------------------------------------
# Docling
# ---------------------------------------------------------------------------------------------------------------
@lru_cache(maxsize=2)
def _converter(full_page_ocr: bool):
    """One converter per mode for the whole process: building one loads the layout, table and OCR models
    (seconds, and hundreds of MB), so it is done once, not per document."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions, TableFormerMode
    from docling.document_converter import DocumentConverter, PdfFormatOption

    options = PdfPipelineOptions()
    options.do_ocr = True
    options.ocr_options = RapidOcrOptions(force_full_page_ocr=full_page_ocr)
    options.do_table_structure = True
    # FAST, not ACCURATE: on a dense boxed layout (Tally) ACCURATE took 66-70 s a page against 6-8 s, and VeriBook reads
    # item rows from `layout`, not from these tables (they feed the markdown for the AI reader and the preview).
    options.table_structure_options.mode = TableFormerMode.FAST
    options.document_timeout = CONVERT_TIMEOUT_S
    options.generate_parsed_pages = True  # keeps each page's positioned text lines (from the PDF, or from OCR) for `layout`
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF, InputFormat.DOCX, InputFormat.XLSX, InputFormat.PPTX, InputFormat.HTML, InputFormat.MD, InputFormat.CSV],
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
    )


def warm_up() -> None:
    """Loads every model ahead of the first real document: builds both converters and runs one small rendered
    page through each (Docling loads the layout and table models lazily, on the first page it sees; without this
    the first upload after a restart takes over a minute)."""
    from PIL import ImageDraw

    page = Image.new("L", (1240, 600), 255)
    draw = ImageDraw.Draw(page)
    for i, line in enumerate(["Invoice No: WARM-UP-1", "Item  Qty  Rate  Amount", "Bolt  2  5.00  10.00", "Total 10.00"]):
        draw.text((80, 80 + i * 60), line, fill=0)
    sample = _images_to_pdf([page])
    for full_page_ocr in (False, True):
        _convert(sample, "warm-up.pdf", full_page_ocr=full_page_ocr)


_convert_lock = threading.Lock()


def _convert(data: bytes, name: str, *, full_page_ocr: bool):
    from docling.datamodel.base_models import ConversionStatus
    from docling_core.types.io import DocumentStream

    with _convert_lock:  # the models are not documented as thread-safe; one document at a time also bounds memory
        result = _converter(full_page_ocr).convert(DocumentStream(name=name, stream=io.BytesIO(data)), raises_on_error=False)
    if result.status not in (ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS):
        detail = "; ".join(str(getattr(err, "error_message", err)) for err in (result.errors or [])) or str(result.status)
        # A failure of this machine (out of memory) is not a fault of the document: it must not come back as "this
        # document could not be read" (400), which tells the person their good invoice is bad. Found when two readers
        # ran side by side on one machine and the second ran out of memory mid-page.
        if re.search(r"MemoryError|out of memory|std::bad_alloc", detail, re.IGNORECASE):
            logger.error("conversion failed for lack of memory: %s", detail)
            raise ReaderOverloaded("the document reader ran out of memory on this document; try again in a minute (if it keeps happening, the server needs more memory)")
        raise ReaderError(f"the document could not be read: {detail}")
    return result


_PLACEHOLDER = re.compile(r"<!--.*?-->")


def _score(value) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else round(f, 3)


def _layout(result) -> tuple[list[dict], str]:
    """Each page's text lines (PDF text or OCR) grouped into the page's visual rows."""
    pages_out, text_parts = [], []
    for page in result.pages:
        parsed = getattr(page, "parsed_page", None)
        if parsed is None or not parsed.textline_cells:
            continue
        width, height = float(parsed.dimension.width), float(parsed.dimension.height)
        cells = []
        for c in parsed.textline_cells:
            text = " ".join(c.text.split())
            if not text:
                continue
            l, t, r, b = c.rect.to_bounding_box().as_tuple()
            top, bottom = (t, b) if t <= b else (b, t)  # either origin convention: keep top < bottom
            conf = round(float(c.confidence), 3) if getattr(c, "from_ocr", False) and c.confidence is not None else None
            cells.append(Cell(text, round(l / width * 1000), round(top / height * 1000), round(r / width * 1000), round(bottom / height * 1000), conf))
        # Printed lines (the same rule as VeriBook's lib/documents/layout.ts groupIntoLines): a cell joins a line when
        # its middle falls inside the line's FIRST cell's band, and never joins a line holding a cell it overlaps
        # horizontally by more than half the narrower one (that cell is printed above or below it, not beside it).
        def stacked(a: Cell, b: Cell) -> bool:
            return min(a.x1, b.x1) - max(a.x0, b.x0) > 0.5 * max(1, min(a.x1 - a.x0, b.x1 - b.x0))

        lines: list[tuple[int, int, list[Cell]]] = []
        for cell in sorted(cells, key=lambda c: c.y0 + c.y1):
            mid = (cell.y0 + cell.y1) / 2
            for top, bottom, members in lines:
                if top <= mid <= bottom and not any(stacked(m, cell) for m in members):
                    members.append(cell)
                    break
            else:
                lines.append((cell.y0, cell.y1, [cell]))
        rows = [sorted(members, key=lambda c: c.x0) for _, _, members in sorted(lines, key=lambda l: l[0] + l[1])]
        pages_out.append({"page": len(pages_out) + 1, "rows": [[asdict(c) for c in r] for r in rows]})
        if text_parts:
            text_parts.append(f"--- page {len(pages_out)} ---")
        text_parts.extend(" | ".join(c.text for c in r) for r in rows)
    return pages_out, "\n".join(text_parts)


def _tables(doc) -> list[TableOut]:
    out = []
    for table in doc.tables:
        frame = table.export_to_dataframe(doc=doc)
        page = table.prov[0].page_no if table.prov else None
        columns = [str(c) for c in frame.columns]
        rows = [["" if v is None else str(v) for v in row] for row in frame.astype(object).where(frame.notna(), None).values.tolist()]
        out.append(TableOut(page=page, columns=columns, rows=rows))
    return out


# ---------------------------------------------------------------------------------------------------------------
# The whole read
# ---------------------------------------------------------------------------------------------------------------
def _images_to_pdf(pages: list[Image.Image]) -> bytes:
    buf = io.BytesIO()
    pages[0].save(buf, "PDF", resolution=200, save_all=True, append_images=pages[1:])
    return buf.getvalue()


def _open_images(data: bytes) -> list[Image.Image]:
    try:
        img = Image.open(io.BytesIO(data))
        frames = []
        for i in range(getattr(img, "n_frames", 1)):
            img.seek(i)
            frames.append(ImageOps.exif_transpose(img.copy()).convert("RGB"))  # a phone's "rotate on display" tag, applied
            if len(frames) > MAX_PAGES:
                raise DocumentTooLarge(f"this image file has more than {MAX_PAGES} pages")
        return frames
    except (UnidentifiedImageError, OSError) as e:
        raise ReaderError(f"this image could not be opened ({e})") from None


def _render_pdf_pages(data: bytes) -> list[Image.Image]:
    pdf = pdfium.PdfDocument(data)
    try:
        return [pdf[i].render(scale=SCAN_RENDER_DPI / 72).to_pil() for i in range(len(pdf))]
    finally:
        pdf.close()


def read_document(data: bytes, filename: str) -> Reading:
    started = time.perf_counter()
    if not data:
        raise ReaderError("the file is empty")
    if len(data) > MAX_FILE_BYTES:
        raise DocumentTooLarge(f"the file is {len(data) / 1024 / 1024:.1f} MB; the reader takes at most {MAX_FILE_BYTES // 1024 // 1024} MB")

    kind, media_type = sniff(data, filename)
    warnings: list[str] = []
    preparation: list[dict] = []
    t_prepare = 0.0

    if kind == "pdf":
        chars = pdf_text_chars_per_page(data)
        scanned_pages = [i + 1 for i, n in enumerate(chars) if n < SCANNED_PAGE_MAX_CHARS]
        if len(scanned_pages) * 2 > len(chars):
            source_kind = "scanned_pdf"
            t0 = time.perf_counter()
            prepared = []
            for i, page in enumerate(_render_pdf_pages(data), 1):
                img, steps = prepare_page(page, photo=False)
                prepared.append(img)
                preparation.append({"page": i, "steps": steps})
            t_prepare = time.perf_counter() - t0
            to_convert, full_ocr = _images_to_pdf(prepared), True
        else:
            source_kind = "digital_pdf"
            to_convert, full_ocr = data, False
            if scanned_pages:
                warnings.append(f"page(s) {', '.join(map(str, scanned_pages))} have no text layer; any pictures of text there were read by OCR")
        name = "document.pdf"
    elif kind == "image":
        source_kind = "image"
        t0 = time.perf_counter()
        prepared = []
        for i, frame in enumerate(_open_images(data), 1):
            img, steps = prepare_page(frame, photo=True)
            prepared.append(img)
            preparation.append({"page": i, "steps": steps})
        t_prepare = time.perf_counter() - t0
        to_convert, full_ocr, name = _images_to_pdf(prepared), True, "document.pdf"
    else:
        source_kind = kind  # office | web
        ext = "." + filename.rsplit(".", 1)[-1].lower()
        to_convert, full_ocr, name = data, False, f"document{ext}"

    t0 = time.perf_counter()
    result = _convert(to_convert, name, full_page_ocr=full_ocr)
    t_convert = time.perf_counter() - t0
    doc = result.document

    markdown = _PLACEHOLDER.sub("", doc.export_to_markdown()).strip()
    layout, layout_text = _layout(result)
    readable = max(sum(ch.isalnum() for ch in markdown), sum(ch.isalnum() for ch in layout_text))
    if readable < MIN_READABLE_CHARS:
        raise UnreadableDocument(
            f"no readable text was found in {filename} (found {readable} letters and digits): it may be blank, "
            f"a photo too blurred or dark to read, or a page held sideways"
        )

    from docling.datamodel.base_models import ConversionStatus

    if result.status == ConversionStatus.PARTIAL_SUCCESS:
        warnings.append("the reader stopped before the end of the document (a page failed or it took too long); check every page was read")

    confidence = getattr(result, "confidence", None)
    ocr_conf = _score(getattr(confidence, "ocr_score", None)) if full_ocr or source_kind == "digital_pdf" else None
    if full_ocr and ocr_conf is not None and ocr_conf < LOW_OCR_CONFIDENCE:
        warnings.append(f"the OCR was unsure of this page's text (confidence {ocr_conf:.2f}); every field needs checking against the document")

    page_count = len(preparation) if preparation else (doc.num_pages() if callable(getattr(doc, "num_pages", None)) else 1)
    reading = Reading(
        filename=filename,
        media_type=media_type,
        sha256=hashlib.sha256(data).hexdigest(),
        byte_size=len(data),
        source_kind=source_kind,
        page_count=page_count or 1,
        ocr_used=full_ocr,
        ocr_confidence=ocr_conf if full_ocr else None,
        layout_confidence=_score(getattr(confidence, "layout_score", None)),
        table_confidence=_score(getattr(confidence, "table_score", None)),
        markdown=markdown,
        tables=_tables(doc),
        layout=layout,
        layout_text=layout_text,
        preparation=preparation,
        warnings=warnings,
        timing_ms={"prepare": round(t_prepare * 1000), "convert": round(t_convert * 1000), "total": round((time.perf_counter() - started) * 1000)},
        reader={"docling": version("docling"), "ocr": f"rapidocr {version('rapidocr')}"},
    )
    logger.info("read %s.. kind=%s pages=%d ocr=%s conf=%s tables=%d ms=%d", reading.sha256[:12], source_kind, reading.page_count,
                full_ocr, reading.ocr_confidence, len(reading.tables), reading.timing_ms["total"])
    return reading
