#!/usr/bin/env python3
"""
Pandawa v6 — Hybrid Python Living Worker (Documents + Real Playwright Browser)
Runs on-demand so idle VPS memory stays minimal while giving Pandawa agents
full Python ecosystem power (PDF/DOCX/XLSX parsing + interactive Playwright browser).
"""
import ipaddress
import json
import os
import socket
import sys
import tempfile
import traceback
import urllib.parse
import zipfile

TEXT_EXTS = {
    "", ".md", ".mdx", ".rst", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".csv", ".tsv",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".ps1", ".bat", ".cmd", ".sql",
    ".xml", ".html", ".css", ".less", ".sass", ".svg", ".env", ".example", ".ini", ".cfg", ".conf",
    ".properties", ".lock", ".sandbox", ".log", ".gitignore", ".dockerignore", ".editorconfig", ".npmrc",
    ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".graphql", ".prisma", ".tf",
    ".hcl", ".nix", ".lua", ".r", ".scala", ".kt", ".swift", ".dart", ".vue", ".svelte", ".astro",
}
RICH_DOC_EXTS = {".pdf", ".docx", ".xlsx", ".xlsm"}
SKIP_SEGMENTS = {".git", "node_modules", "__macosx", ".obsidian", ".venv", "__pycache__", ".ds_store"}


def action_status() -> dict:
    caps = {}
    for mod in ("pypdf", "docx", "openpyxl", "playwright"):
        try:
            __import__(mod)
            caps[mod] = True
        except Exception:
            caps[mod] = False
    return {
        "ok": True,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "capabilities": caps,
    }


def action_doc_read(payload: dict) -> dict:
    file_path = str(payload.get("path", "")).strip()
    max_chars = int(payload.get("maxChars", 24000))
    if not file_path or not os.path.exists(file_path):
        return {"ok": False, "error": f"File not found: {file_path}"}

    ext = os.path.splitext(file_path)[1].lower()
    try:
        if ext == ".pdf":
            from pypdf import PdfReader
            reader = PdfReader(file_path)
            pages = []
            for idx, page in enumerate(reader.pages):
                txt = (page.extract_text() or "").strip()
                pages.append(f"--- Page {idx + 1}/{len(reader.pages)} ---\n{txt}")
                if sum(len(p) for p in pages) > max_chars:
                    break
            return {
                "ok": True,
                "format": "pdf",
                "pageCount": len(reader.pages),
                "text": "\n\n".join(pages)[:max_chars],
            }

        if ext in (".docx",):
            import docx
            doc = docx.Document(file_path)
            parts = [p.text for p in doc.paragraphs if p.text.strip()]
            for t in doc.tables:
                for row in t.rows:
                    parts.append(" | ".join(c.text.strip() for c in row.cells))
            return {
                "ok": True,
                "format": "docx",
                "text": "\n".join(parts)[:max_chars],
            }

        if ext in (".xlsx", ".xlsm"):
            import openpyxl
            wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
            sheet_names = list(wb.sheetnames)
            sheets = []
            for name in sheet_names[:6]:
                ws = wb[name]
                rows = []
                for r_idx, row in enumerate(ws.iter_rows(values_only=True)):
                    if r_idx >= 120:
                        rows.append("...[truncated rows]")
                        break
                    vals = ["" if v is None else str(v) for v in row]
                    if any(vals):
                        rows.append(" | ".join(vals))
                sheets.append(f"### Sheet: {name}\n" + "\n".join(rows))
            wb.close()
            return {
                "ok": True,
                "format": "xlsx",
                "sheets": sheet_names,
                "text": "\n\n".join(sheets)[:max_chars],
            }

        # Fallback: UTF-8 text / CSV / JSON / MD
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(max_chars)
        return {"ok": True, "format": ext.lstrip(".") or "text", "text": text}
    except ImportError as ie:
        return {"ok": False, "error": f"Missing Python package for {ext}: {ie}"}
    except Exception as ex:
        return {"ok": False, "error": f"Failed reading {ext}: {ex}"}


BLOCKED_META_HOSTS = {"metadata.google.internal", "metadata.goog", "metadata.azure.com", "instance-data"}
BLOCKED_META_IPS = {"169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"}


def is_metadata_url(url: str, block_private: bool = False) -> str | None:
    try:
        parsed = urllib.parse.urlparse(url)
        scheme = (parsed.scheme or "").lower()
        if scheme and scheme not in ("http", "https", "data", "blob", "about"):
            return f"Blocked scheme: {scheme}"
        if scheme in ("data", "blob", "about"):
            return None
        host = (parsed.hostname or "").lower()
        if not host:
            return "Empty hostname"
        if host in BLOCKED_META_HOSTS or host in BLOCKED_META_IPS:
            return f"Blocked cloud metadata host: {host}"
        if block_private and host == "localhost":
            return "Blocked private/loopback host: localhost"
        try:
            for info in socket.getaddrinfo(host, None):
                ip = info[4][0].lower().replace("::ffff:", "")
                if ip in BLOCKED_META_IPS:
                    return f"Blocked cloud metadata IP: {ip}"
                if block_private:
                    try:
                        addr = ipaddress.ip_address(ip)
                        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
                            return f"Blocked private/loopback IP: {ip}"
                    except ValueError:
                        pass
        except Exception:
            pass
    except Exception:
        return "Invalid URL"
    return None


def action_browser_run(payload: dict) -> dict:
    url = str(payload.get("url", "")).strip()
    block_private = bool(payload.get("blockPrivate", False))
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "error": "URL must start with http:// or https://"}
    meta_err = is_metadata_url(url, block_private=block_private)
    if meta_err:
        return {"ok": False, "error": meta_err}

    actions = payload.get("actions") or []
    wait_ms = max(200, min(15000, int(payload.get("waitMs", 1200))))
    screenshot_path = str(payload.get("screenshotPath", "")).strip()
    viewport_w = int(payload.get("width", 1280))
    viewport_h = int(payload.get("height", 800))

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {
            "ok": False,
            "error": "Playwright is not installed in Pandawa Python worker yet.",
        }

    console_errors = []
    action_log = []
    eval_outputs = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            )
            context = browser.new_context(viewport={"width": viewport_w, "height": viewport_h})
            page = context.new_page()
            page.set_default_timeout(20000)

            def ssrf_route_handler(route):
                req_url = route.request.url
                err = is_metadata_url(req_url, block_private=block_private)
                if err:
                    console_errors.append(f"Blocked SSRF navigation/request: {err}")
                    route.abort("blockedbyclient")
                    return
                route.continue_()

            page.route("**/*", ssrf_route_handler)

            page.on(
                "console",
                lambda msg: console_errors.append(msg.text[:300]) if msg.type == "error" else None,
            )
            page.on("pageerror", lambda err: console_errors.append(str(err)[:300]))

            resp = page.goto(url, wait_until="domcontentloaded", timeout=25000)
            page.wait_for_timeout(wait_ms)

            for act in actions:
                if not isinstance(act, dict):
                    continue
                kind = str(act.get("type", "")).lower()
                sel = str(act.get("selector", "")).strip()
                val = str(act.get("value", ""))
                try:
                    if kind == "click" and sel:
                        page.locator(sel).first.click(timeout=10000)
                        action_log.append(f"clicked {sel}")
                    elif kind == "fill" and sel:
                        page.locator(sel).first.fill(val, timeout=10000)
                        action_log.append(f"filled {sel}")
                    elif kind == "press":
                        if sel:
                            page.locator(sel).first.press(val or "Enter", timeout=10000)
                        else:
                            page.keyboard.press(val or "Enter")
                        action_log.append(f"pressed {val or 'Enter'}")
                    elif kind == "wait":
                        ms = max(100, min(10000, int(act.get("ms") or val or 1000)))
                        page.wait_for_timeout(ms)
                        action_log.append(f"waited {ms}ms")
                    elif kind == "eval" and val:
                        res = page.evaluate(val)
                        eval_outputs.append(res)
                        action_log.append("evaluated js")
                    page.wait_for_timeout(350)
                except Exception as aerr:
                    action_log.append(f"action {kind}({sel}) error: {str(aerr)[:180]}")

            title = page.title()
            final_url = page.url
            text = page.evaluate(
                "() => (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 12000)"
            )
            interactives = page.evaluate(
                """() => {
                    const els = Array.from(document.querySelectorAll('a,button,input,textarea,select'));
                    return els.slice(0, 45).map((el) => {
                        const tag = el.tagName.toLowerCase();
                        const id = el.id ? '#' + el.id : '';
                        const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
                        const aria = el.getAttribute('aria-label') || '';
                        const txt = (el.innerText || el.value || el.placeholder || aria || '').trim().slice(0, 60);
                        return {
                            tag,
                            selector: id || name || (aria ? `[aria-label="${aria}"]` : tag),
                            text: txt,
                            href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 120) : undefined
                        };
                    }).filter(x => x.text || x.href || x.tag === 'input');
                }"""
            )

            saved_shot = ""
            if screenshot_path:
                os.makedirs(os.path.dirname(os.path.abspath(screenshot_path)), exist_ok=True)
                page.screenshot(path=screenshot_path, full_page=bool(payload.get("fullPage", False)))
                saved_shot = screenshot_path

            browser.close()

        return {
            "ok": True,
            "status": resp.status if resp else 0,
            "url": final_url,
            "title": title,
            "actionsExecuted": action_log,
            "evalOutputs": eval_outputs,
            "consoleErrors": console_errors[:15],
            "interactiveElements": interactives,
            "text": text,
            "screenshotPath": saved_shot,
        }
    except Exception as ex:
        return {"ok": False, "error": f"{ex}\n{traceback.format_exc()[-400:]}"}


def action_import_zip(payload: dict) -> dict:
    zip_path = str(payload.get("zipPath", "")).strip()
    target_dir = str(payload.get("targetDir", "")).strip()
    rel_prefix = str(payload.get("relPrefix", "")).strip().strip("/")
    max_files = int(payload.get("maxFiles", 5000))
    max_total_bytes = int(payload.get("maxTotalBytes", 150 * 1024 * 1024))

    if not zip_path or not os.path.exists(zip_path):
        return {"ok": False, "error": f"ZIP file not found: {zip_path}"}
    if not target_dir:
        return {"ok": False, "error": "targetDir is required"}

    os.makedirs(target_dir, exist_ok=True)
    target_real = os.path.realpath(target_dir)
    saved_paths = []
    converted_docs = 0
    skipped = 0
    skipped_details = []
    total_bytes = 0

    def record_skip(item_path: str, reason: str) -> None:
        nonlocal skipped
        skipped += 1
        if len(skipped_details) < 100:
            skipped_details.append({"path": item_path, "reason": reason})

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            infos = zf.infolist()
            for info in infos:
                if info.is_dir():
                    continue
                raw_name = info.filename.replace("\\", "/").lstrip("/")
                if len(saved_paths) >= max_files:
                    record_skip(raw_name, f"Exceeded max_files limit ({max_files})")
                    continue

                parts = [p for p in raw_name.split("/") if p and p != "."]
                if not parts or any(p == ".." or ":" in p for p in parts):
                    record_skip(raw_name, "Invalid or unsafe path segments")
                    continue
                if any(p.lower() in SKIP_SEGMENTS or p.startswith("._") for p in parts):
                    record_skip(raw_name, "Ignored system/cache path")
                    continue

                clean_rel = "/".join(parts)
                ext = os.path.splitext(clean_rel)[1].lower()

                if info.file_size > 15 * 1024 * 1024 or total_bytes + info.file_size > max_total_bytes:
                    record_skip(clean_rel, "Exceeds file size or total archive byte budget")
                    continue

                data = zf.read(info)

                if ext in RICH_DOC_EXTS:
                    total_bytes += len(data)
                    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tf:
                        tf.write(data)
                        tmp_doc = tf.name
                    try:
                        parsed = action_doc_read({"path": tmp_doc, "maxChars": 80000})
                    finally:
                        try:
                            os.unlink(tmp_doc)
                        except OSError:
                            pass
                    if not parsed.get("ok"):
                        record_skip(clean_rel, parsed.get("error") or f"Failed parsing {ext}")
                        continue
                    stem_rel = os.path.splitext(clean_rel)[0] + ".md"
                    out_full = os.path.realpath(os.path.join(target_real, stem_rel))
                    if not (out_full == target_real or out_full.startswith(target_real + os.sep)):
                        record_skip(clean_rel, "Resolved path escapes target directory")
                        continue
                    os.makedirs(os.path.dirname(out_full), exist_ok=True)
                    md_body = f"# {os.path.basename(clean_rel)}\n\n> Converted automatically from `{clean_rel}` ({parsed.get('format', ext)})\n\n{parsed.get('text', '')}\n"
                    with open(out_full, "w", encoding="utf-8") as outf:
                        outf.write(md_body)
                    saved_paths.append(f"{rel_prefix}/{stem_rel}" if rel_prefix else stem_rel)
                    converted_docs += 1
                    continue

                # Determine text content: allowlisted TEXT_EXTS OR clean UTF-8 non-binary files
                is_known_text = ext in TEXT_EXTS
                if not is_known_text:
                    if len(data) > 2 * 1024 * 1024 or b"\x00" in data:
                        record_skip(clean_rel, f"Binary or unsupported extension ({ext or 'none'})")
                        continue
                    try:
                        text = data.decode("utf-8")
                    except UnicodeDecodeError:
                        record_skip(clean_rel, f"Non-UTF-8 file ({ext or 'none'})")
                        continue
                else:
                    text = data.decode("utf-8", errors="replace")

                total_bytes += len(data)
                out_full = os.path.realpath(os.path.join(target_real, clean_rel))
                if not (out_full == target_real or out_full.startswith(target_real + os.sep)):
                    record_skip(clean_rel, "Resolved path escapes target directory")
                    continue
                os.makedirs(os.path.dirname(out_full), exist_ok=True)
                with open(out_full, "w", encoding="utf-8") as outf:
                    outf.write(text)
                saved_paths.append(f"{rel_prefix}/{clean_rel}" if rel_prefix else clean_rel)

        return {
            "ok": True,
            "count": len(saved_paths),
            "convertedDocs": converted_docs,
            "skipped": skipped,
            "skippedDetails": skipped_details,
            "paths": saved_paths,
        }
    except zipfile.BadZipFile:
        return {"ok": False, "error": "Invalid or corrupted ZIP archive."}
    except Exception as ex:
        return {"ok": False, "error": f"ZIP extraction failed: {ex}"}


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    raw = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
    try:
        payload = json.loads(raw) if raw else {}
        if not isinstance(payload, dict):
            print(json.dumps({"ok": False, "error": "JSON payload must be an object"}))
            return
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"Invalid JSON input: {exc}"}))
        return

    if action == "status":
        out = action_status()
    elif action == "doc_read":
        out = action_doc_read(payload)
    elif action == "browser_run":
        out = action_browser_run(payload)
    elif action == "import_zip":
        out = action_import_zip(payload)
    else:
        out = {"ok": False, "error": f"Unknown worker action: {action}"}

    print(json.dumps(out))


if __name__ == "__main__":
    main()
