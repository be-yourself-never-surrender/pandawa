#!/usr/bin/env python3
"""
Pandawa v6 — Hybrid Python Living Worker (Documents + Real Playwright Browser)
Runs on-demand so idle VPS memory stays minimal while giving Pandawa agents
full Python ecosystem power (PDF/DOCX/XLSX parsing + interactive Playwright browser).
"""
import json
import os
import sys
import traceback


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
            sheets = []
            for name in wb.sheetnames[:6]:
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
                "sheets": wb.sheetnames,
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


def action_browser_run(payload: dict) -> dict:
    url = str(payload.get("url", "")).strip()
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "error": "URL must start with http:// or https://"}

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


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    raw = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
    payload = json.loads(raw) if raw else {}

    if action == "status":
        out = action_status()
    elif action == "doc_read":
        out = action_doc_read(payload)
    elif action == "browser_run":
        out = action_browser_run(payload)
    else:
        out = {"ok": False, "error": f"Unknown worker action: {action}"}

    print(json.dumps(out))


if __name__ == "__main__":
    main()
