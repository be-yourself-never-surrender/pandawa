#!/usr/bin/env python3
"""
Pandawa v6 — Hybrid Python Living Worker (Documents + Real Playwright Browser)
Runs on-demand so idle VPS memory stays minimal while giving Pandawa agents
full Python ecosystem power (PDF/DOCX/XLSX parsing + interactive Playwright browser).
"""
import hashlib
import io
import ipaddress
import json
import os
import socket
import struct
import sys
import tempfile
import traceback
import urllib.parse
import xml.etree.ElementTree as ET
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
ANDROID_PKG_EXTS = {".apk", ".apks", ".xapk", ".aab"}
SKIP_SEGMENTS = {".git", "node_modules", "__macosx", ".obsidian", ".venv", "__pycache__", ".ds_store"}

MAX_ZIP_ENTRIES_INSPECT = 50000
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_NESTED_APK_BYTES = 250 * 1024 * 1024


def _sha256_file(file_path: str) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _format_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.2f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


def _decode_axml_string_pool(data: bytes, offset: int, chunk_size: int) -> list[str]:
    if offset + 28 > len(data):
        return []
    string_count, _style_count, flags, strings_start, _styles_start = struct.unpack_from(
        "<IIIII", data, offset + 8
    )
    is_utf8 = bool(flags & (1 << 8))
    offsets_base = offset + 28
    pool_base = offset + strings_start
    end_limit = min(len(data), offset + chunk_size)
    strings: list[str] = []
    for i in range(min(string_count, 200000)):
        off_pos = offsets_base + i * 4
        if off_pos + 4 > end_limit:
            break
        str_off = struct.unpack_from("<I", data, off_pos)[0]
        p = pool_base + str_off
        if p >= end_limit:
            strings.append("")
            continue
        try:
            if is_utf8:
                # UTF-16 char length (1 or 2 bytes)
                b0 = data[p]
                p += 2 if (b0 & 0x80) else 1
                if p >= end_limit:
                    strings.append("")
                    continue
                # UTF-8 byte length (1 or 2 bytes)
                b1 = data[p]
                if b1 & 0x80:
                    if p + 1 >= end_limit:
                        strings.append("")
                        continue
                    byte_len = ((b1 & 0x7F) << 8) | data[p + 1]
                    p += 2
                else:
                    byte_len = b1
                    p += 1
                raw = data[p : min(end_limit, p + byte_len)]
                strings.append(raw.decode("utf-8", errors="replace"))
            else:
                if p + 2 > end_limit:
                    strings.append("")
                    continue
                char_len = struct.unpack_from("<H", data, p)[0]
                p += 2
                if char_len & 0x8000:
                    if p + 2 > end_limit:
                        strings.append("")
                        continue
                    char_len = ((char_len & 0x7FFF) << 16) | struct.unpack_from("<H", data, p)[0]
                    p += 2
                raw = data[p : min(end_limit, p + char_len * 2)]
                strings.append(raw.decode("utf-16le", errors="replace"))
        except Exception:
            strings.append("")
    return strings


def _axml_attr_value(val_type: int, val_data: int, raw_str_idx: int, strings: list[str]) -> str:
    if raw_str_idx != 0xFFFFFFFF and 0 <= raw_str_idx < len(strings):
        return strings[raw_str_idx]
    if val_type == 0x03 and 0 <= val_data < len(strings):  # TYPE_STRING
        return strings[val_data]
    if val_type == 0x12:  # TYPE_INT_BOOLEAN
        return "true" if val_data != 0 else "false"
    if val_type == 0x10:  # TYPE_INT_DEC
        return str(struct.unpack("<i", struct.pack("<I", val_data & 0xFFFFFFFF))[0])
    if val_type == 0x11:  # TYPE_INT_HEX
        return f"0x{val_data:x}"
    if val_type == 0x01:  # TYPE_REFERENCE
        return f"@0x{val_data:08x}"
    return str(val_data)


def _extract_manifest_from_events(events: list[tuple[str, str, dict[str, str]]]) -> dict:
    info: dict = {
        "package": "",
        "versionName": "",
        "versionCode": "",
        "minSdkVersion": "",
        "targetSdkVersion": "",
        "compileSdkVersion": "",
        "applicationClass": "",
        "debuggable": None,
        "allowBackup": None,
        "usesCleartextTraffic": None,
        "networkSecurityConfig": "",
        "permissions": [],
        "customPermissions": [],
        "exportedComponents": [],
        "deepLinks": [],
        "componentCounts": {"activity": 0, "service": 0, "receiver": 0, "provider": 0},
    }
    stack: list[dict] = []
    seen_perms: set[str] = set()
    seen_custom_perms: set[str] = set()
    seen_links: set[str] = set()

    def current_comp() -> dict | None:
        for item in reversed(stack):
            if item.get("ctype"):
                return item
        return None

    for ev_type, tag, attrs in events:
        short_tag = tag.rsplit("}", 1)[-1]
        if ev_type == "start":
            if short_tag == "manifest":
                info["package"] = attrs.get("package", info["package"])
                info["versionName"] = attrs.get("versionName", info["versionName"])
                info["versionCode"] = attrs.get("versionCode", info["versionCode"])
                info["compileSdkVersion"] = attrs.get("compileSdkVersion", info["compileSdkVersion"])
            elif short_tag == "uses-sdk":
                info["minSdkVersion"] = attrs.get("minSdkVersion", info["minSdkVersion"])
                info["targetSdkVersion"] = attrs.get("targetSdkVersion", info["targetSdkVersion"])
            elif short_tag == "application":
                info["applicationClass"] = attrs.get("name", info["applicationClass"])
                if "debuggable" in attrs:
                    info["debuggable"] = attrs["debuggable"].lower() == "true"
                if "allowBackup" in attrs:
                    info["allowBackup"] = attrs["allowBackup"].lower() == "true"
                if "usesCleartextTraffic" in attrs:
                    info["usesCleartextTraffic"] = attrs["usesCleartextTraffic"].lower() == "true"
                if "networkSecurityConfig" in attrs:
                    info["networkSecurityConfig"] = attrs["networkSecurityConfig"]
            elif short_tag == "uses-permission" or short_tag == "uses-permission-sdk-23":
                pname = attrs.get("name", "")
                if pname and pname not in seen_perms:
                    seen_perms.add(pname)
                    info["permissions"].append(pname)
            elif short_tag == "permission":
                pname = attrs.get("name", "")
                if pname and pname not in seen_custom_perms:
                    seen_custom_perms.add(pname)
                    info["customPermissions"].append(pname)
            elif short_tag in ("activity", "activity-alias", "service", "receiver", "provider"):
                ctype = "activity" if short_tag == "activity-alias" else short_tag
                info["componentCounts"][ctype] = info["componentCounts"].get(ctype, 0) + 1
                stack.append({
                    "tag": short_tag,
                    "ctype": ctype,
                    "name": attrs.get("name", ""),
                    "exported": attrs.get("exported"),
                    "permission": attrs.get("permission", ""),
                    "authorities": attrs.get("authorities", ""),
                    "hasIntentFilter": False,
                    "actions": [],
                })
                continue
            elif short_tag == "intent-filter":
                comp = current_comp()
                if comp is not None:
                    comp["hasIntentFilter"] = True
            elif short_tag == "action":
                comp = current_comp()
                act = attrs.get("name", "")
                if comp is not None and act:
                    comp["actions"].append(act)
            elif short_tag == "data":
                scheme = attrs.get("scheme", "")
                host = attrs.get("host", "")
                port = attrs.get("port", "")
                path_val = attrs.get("pathPrefix") or attrs.get("path") or attrs.get("pathPattern") or ""
                if scheme or host:
                    comp = current_comp()
                    comp_name = comp["name"] if comp is not None else ""
                    uri = f"{scheme}://{host}{(':' + port) if port else ''}{path_val}" if scheme else f"{host}{path_val}"
                    entry = f"{uri} ({comp_name})" if comp_name else uri
                    if entry not in seen_links:
                        seen_links.add(entry)
                        info["deepLinks"].append(entry)
            stack.append({"tag": short_tag})
        elif ev_type == "end":
            if stack:
                node = stack.pop()
                if node.get("ctype"):
                    exp_raw = node.get("exported")
                    is_exported = (
                        (exp_raw.lower() == "true")
                        if isinstance(exp_raw, str)
                        else bool(node.get("hasIntentFilter"))
                    )
                    if is_exported:
                        entry = {
                            "type": node["ctype"],
                            "name": node.get("name", "(unnamed)"),
                            "explicitExported": exp_raw,
                        }
                        if node.get("permission"):
                            entry["permission"] = node["permission"]
                        if node.get("authorities"):
                            entry["authorities"] = node["authorities"]
                        if node.get("actions"):
                            entry["actions"] = node["actions"][:5]
                        info["exportedComponents"].append(entry)
    return info


def parse_android_manifest(data: bytes) -> dict | None:
    if not data:
        return None
    # Case 1: Plain-text XML manifest
    stripped = data.lstrip()
    if stripped.startswith(b"<"):
        try:
            root = ET.fromstring(data.decode("utf-8", errors="replace"))
            events: list[tuple[str, str, dict[str, str]]] = []

            def walk(elem: ET.Element) -> None:
                clean_attrs = {k.rsplit("}", 1)[-1]: v for k, v in elem.attrib.items()}
                events.append(("start", elem.tag, clean_attrs))
                for child in elem:
                    walk(child)
                events.append(("end", elem.tag, {}))

            walk(root)
            return _extract_manifest_from_events(events)
        except Exception:
            return None

    # Case 2: Binary Android XML (AXML, chunk type 0x0003)
    if len(data) < 8:
        return None
    res_type, _hdr_size, total_size = struct.unpack_from("<HHI", data, 0)
    if res_type != 0x0003:
        return None

    limit = min(len(data), total_size if total_size >= 8 else len(data))
    pos = 8
    strings: list[str] = []
    events = []

    while pos + 8 <= limit:
        ctype, chdr, csize = struct.unpack_from("<HHI", data, pos)
        if csize < 8 or pos + csize > limit:
            break
        if ctype == 0x0001:  # RES_STRING_POOL_TYPE
            strings = _decode_axml_string_pool(data, pos, csize)
        elif ctype == 0x0102:  # RES_XML_START_ELEMENT_TYPE
            if pos + 36 <= pos + csize:
                _line, _comment, _ns_idx, name_idx, attr_start, attr_size, attr_count = struct.unpack_from(
                    "<IIIIHHH", data, pos + 8
                )
                tag_name = strings[name_idx] if 0 <= name_idx < len(strings) else ""
                attrs: dict[str, str] = {}
                attr_base = pos + chdr + attr_start
                step = attr_size if attr_size >= 20 else 20
                for i in range(min(attr_count, 128)):
                    ap = attr_base + i * step
                    if ap + 20 > pos + csize:
                        break
                    _a_ns, a_name_idx, a_raw_str, _v_size, _v_res0, v_type, v_data = struct.unpack_from(
                        "<IIIHBBI", data, ap
                    )
                    aname = strings[a_name_idx] if 0 <= a_name_idx < len(strings) else ""
                    if aname:
                        attrs[aname] = _axml_attr_value(v_type, v_data, a_raw_str, strings)
                if tag_name:
                    events.append(("start", tag_name, attrs))
        elif ctype == 0x0103:  # RES_XML_END_ELEMENT_TYPE
            if pos + 24 <= pos + csize:
                _line, _comment, _ns_idx, name_idx = struct.unpack_from("<IIII", data, pos + 8)
                tag_name = strings[name_idx] if 0 <= name_idx < len(strings) else ""
                if tag_name:
                    events.append(("end", tag_name, {}))
        pos += csize

    return _extract_manifest_from_events(events) if events else None


def _inspect_apk_zip(zf: zipfile.ZipFile) -> dict:
    infos = zf.infolist()
    if len(infos) > MAX_ZIP_ENTRIES_INSPECT:
        return {"error": f"Archive has too many entries ({len(infos)}) for safe inspection."}

    names = [i.filename for i in infos]
    dex_files = sorted(n for n in names if n.startswith("classes") and n.endswith(".dex"))
    native_libs: dict[str, list[str]] = {}
    certs: list[str] = []
    xml_configs: list[str] = []
    frameworks: list[str] = []

    for n in names:
        low = n.lower()
        if n.startswith("lib/") and low.endswith(".so"):
            parts = n.split("/")
            abi = parts[1] if len(parts) >= 3 else "unknown"
            native_libs.setdefault(abi, []).append(parts[-1])
        elif n.startswith("META-INF/") and (
            low.endswith(".rsa") or low.endswith(".dsa") or low.endswith(".ec") or low.endswith(".sf")
        ):
            certs.append(n)
        elif "network_security_config" in low or low.endswith("file_paths.xml") or low.endswith("provider_paths.xml"):
            xml_configs.append(n)

    joined_lower = "\n".join(n.lower() for n in names)
    if "libflutter.so" in joined_lower or "libapp.so" in joined_lower:
        frameworks.append("Flutter")
    if "index.android.bundle" in joined_lower or "libreactnativejni.so" in joined_lower or "libhermes.so" in joined_lower:
        frameworks.append("React Native")
    if "assets/www/" in joined_lower or "capacitor.config" in joined_lower:
        frameworks.append("Cordova/Capacitor")
    if "libunity.so" in joined_lower or "libil2cpp.so" in joined_lower:
        frameworks.append("Unity")
    if "libmonodroid.so" in joined_lower or "assemblies/" in joined_lower:
        frameworks.append("Xamarin/.NET MAUI")
    if any(n.startswith("kotlin/") for n in names):
        frameworks.append("Kotlin")

    manifest = None
    manifest_entry = next((i for i in infos if i.filename == "AndroidManifest.xml"), None)
    if manifest_entry and manifest_entry.file_size <= MAX_MANIFEST_BYTES:
        try:
            manifest = parse_android_manifest(zf.read(manifest_entry))
        except Exception:
            manifest = None

    return {
        "entryCount": len(infos),
        "dexFiles": dex_files,
        "nativeLibs": {k: sorted(v)[:40] for k, v in sorted(native_libs.items())},
        "signingFiles": sorted(certs)[:12],
        "securityXmlConfigs": sorted(xml_configs)[:12],
        "frameworks": frameworks,
        "manifest": manifest,
    }


def _format_apk_details(details: dict, header_lines: list[str]) -> str:
    lines = list(header_lines)
    m = details.get("manifest")
    if isinstance(m, dict):
        lines.append("\n### AndroidManifest.xml")
        if m.get("package"):
            lines.append(f"- Package: {m['package']}")
        if m.get("versionName") or m.get("versionCode"):
            lines.append(f"- Version: {m.get('versionName') or '?'} (code: {m.get('versionCode') or '?'})")
        if m.get("minSdkVersion") or m.get("targetSdkVersion") or m.get("compileSdkVersion"):
            lines.append(
                f"- SDK: min={m.get('minSdkVersion') or '?'}, target={m.get('targetSdkVersion') or '?'}, compile={m.get('compileSdkVersion') or '?'}"
            )
        if m.get("applicationClass"):
            lines.append(f"- Application class: {m['applicationClass']}")
        flags = []
        if m.get("debuggable") is not None:
            flags.append(f"debuggable={m['debuggable']}")
        if m.get("allowBackup") is not None:
            flags.append(f"allowBackup={m['allowBackup']}")
        if m.get("usesCleartextTraffic") is not None:
            flags.append(f"usesCleartextTraffic={m['usesCleartextTraffic']}")
        if m.get("networkSecurityConfig"):
            flags.append(f"networkSecurityConfig={m['networkSecurityConfig']}")
        if flags:
            lines.append(f"- Security flags: {', '.join(flags)}")

        counts = m.get("componentCounts") or {}
        lines.append(
            f"- Components: activities={counts.get('activity', 0)}, services={counts.get('service', 0)}, receivers={counts.get('receiver', 0)}, providers={counts.get('provider', 0)}"
        )

        perms = m.get("permissions") or []
        if perms:
            lines.append(f"- Permissions ({len(perms)}): {', '.join(perms[:35])}" + (" ..." if len(perms) > 35 else ""))

        exported = m.get("exportedComponents") or []
        if exported:
            lines.append(f"- Exported components ({len(exported)}):")
            for comp in exported[:25]:
                extra = []
                if comp.get("permission"):
                    extra.append(f"perm={comp['permission']}")
                if comp.get("authorities"):
                    extra.append(f"authorities={comp['authorities']}")
                if comp.get("actions"):
                    extra.append(f"actions={','.join(comp['actions'][:3])}")
                suffix = f" [{' | '.join(extra)}]" if extra else ""
                lines.append(f"  * [{comp['type']}] {comp['name']}{suffix}")

        links = m.get("deepLinks") or []
        if links:
            lines.append(f"- Deep links / Intent data ({len(links)}):")
            for dl in links[:20]:
                lines.append(f"  * {dl}")
    else:
        lines.append("\n- AndroidManifest.xml: not decoded (encrypted/protobuf or absent in archive)")

    lines.append("\n### Binary & Package Structure")
    lines.append(f"- Entries: {details.get('entryCount', 0)}")
    dex = details.get("dexFiles") or []
    lines.append(f"- DEX files ({len(dex)}): {', '.join(dex[:12]) if dex else '(none)'}")
    if details.get("frameworks"):
        lines.append(f"- Detected frameworks: {', '.join(details['frameworks'])}")
    nlibs = details.get("nativeLibs") or {}
    if nlibs:
        lines.append("- Native libraries (.so):")
        for abi, libs in nlibs.items():
            lines.append(f"  * {abi} ({len(libs)}): {', '.join(libs[:15])}" + (" ..." if len(libs) > 15 else ""))
    if details.get("signingFiles"):
        lines.append(f"- Signing artifacts: {', '.join(details['signingFiles'])}")
    if details.get("securityXmlConfigs"):
        lines.append(f"- Security XML configs: {', '.join(details['securityXmlConfigs'])}")
    return "\n".join(lines)


def inspect_android_package(file_path: str, max_chars: int = 24000) -> dict:
    ext = os.path.splitext(file_path)[1].lower()
    size_bytes = os.path.getsize(file_path)
    sha256 = _sha256_file(file_path)

    if not zipfile.is_zipfile(file_path):
        return {
            "ok": False,
            "error": f"File '{os.path.basename(file_path)}' is not a valid ZIP-based {ext.upper()} archive.",
        }

    with zipfile.ZipFile(file_path, "r") as zf:
        infos = zf.infolist()
        if len(infos) > MAX_ZIP_ENTRIES_INSPECT:
            return {"ok": False, "error": f"Archive has too many entries ({len(infos)})."}

        # Single APK
        if ext == ".apk":
            details = _inspect_apk_zip(zf)
            if "error" in details:
                return {"ok": False, "error": details["error"]}
            header = [
                f"## Android APK Inspection: {os.path.basename(file_path)}",
                f"- Format: APK ({_format_size(size_bytes)}, {size_bytes} bytes)",
                f"- SHA-256: {sha256}",
            ]
            text = _format_apk_details(details, header)
            text += (
                "\n\n### Suggested Next Steps\n"
                "- Decompile Java/Kotlin: `jadx -d decompiled/ <apk_path>`\n"
                "- Unpack resources/smali: `apktool d <apk_path> -o unpacked/`\n"
                "- Inspect raw files: `unzip -l <apk_path>`"
            )
            return {
                "ok": True,
                "format": "apk",
                "sha256": sha256,
                "sizeBytes": size_bytes,
                "metadata": details,
                "text": text[:max_chars],
            }

        # Split APK Archive (.apks / .xapk)
        if ext in (".apks", ".xapk"):
            split_entries = [i for i in infos if i.filename.lower().endswith(".apk")]
            other_entries = [i.filename for i in infos if not i.filename.lower().endswith(".apk")]
            split_summary = [
                {"name": i.filename, "sizeBytes": i.file_size}
                for i in sorted(split_entries, key=lambda x: x.filename)
            ]

            xapk_meta = None
            for cand in ("manifest.json", "meta.json", "info.json"):
                if cand in other_entries:
                    try:
                        raw = zf.read(cand)
                        if len(raw) <= 512 * 1024:
                            xapk_meta = json.loads(raw.decode("utf-8", errors="replace"))
                            break
                    except Exception:
                        pass

            # Select primary base APK inside .apks/.xapk
            def base_rank(zi: zipfile.ZipInfo) -> tuple[int, int]:
                low = os.path.basename(zi.filename).lower()
                if low in ("base.apk", "base-master.apk", "base-master_2.apk"):
                    return (0, -zi.file_size)
                if "base" in low and "config" not in low and "arm" not in low and "dpi" not in low:
                    return (1, -zi.file_size)
                if "config." not in low and "split_" not in low:
                    return (2, -zi.file_size)
                return (3, -zi.file_size)

            base_entry = min(split_entries, key=base_rank) if split_entries else None
            base_details = None
            abi_split_libs: dict[str, list[str]] = {}

            for si in split_entries:
                if si.file_size > MAX_NESTED_APK_BYTES:
                    continue
                is_base = base_entry is not None and si.filename == base_entry.filename
                low_name = si.filename.lower()
                looks_abi_split = any(
                    tok in low_name for tok in ("arm64", "armeabi", "x86", "lib", "abi")
                )
                if not is_base and not looks_abi_split:
                    continue
                try:
                    raw_apk = zf.read(si)
                    with zipfile.ZipFile(io.BytesIO(raw_apk), "r") as inner_zf:
                        if is_base:
                            base_details = _inspect_apk_zip(inner_zf)
                        else:
                            for inner_name in inner_zf.namelist():
                                if inner_name.startswith("lib/") and inner_name.lower().endswith(".so"):
                                    parts = inner_name.split("/")
                                    abi = parts[1] if len(parts) >= 3 else "unknown"
                                    abi_split_libs.setdefault(abi, []).append(parts[-1])
                except Exception:
                    continue

            if isinstance(base_details, dict) and abi_split_libs:
                merged_libs = dict(base_details.get("nativeLibs") or {})
                for abi, libs in abi_split_libs.items():
                    merged_libs[abi] = sorted(set(merged_libs.get(abi, []) + libs))[:40]
                base_details["nativeLibs"] = merged_libs
                if any("libflutter.so" in l.lower() or "libapp.so" in l.lower() for ls in merged_libs.values() for l in ls):
                    if "Flutter" not in base_details.get("frameworks", []):
                        base_details.setdefault("frameworks", []).append("Flutter")

            header = [
                f"## Android Split APK Bundle ({ext.lstrip('.').upper()}): {os.path.basename(file_path)}",
                f"- Format: {ext.lstrip('.').upper()} ({_format_size(size_bytes)}, {size_bytes} bytes)",
                f"- SHA-256: {sha256}",
                f"- Contained Split APKs ({len(split_summary)}):",
            ]
            for s in split_summary[:30]:
                marker = " [PRIMARY BASE]" if base_entry and s["name"] == base_entry.filename else ""
                header.append(f"  * {s['name']} ({_format_size(s['sizeBytes'])}){marker}")
            if other_entries:
                header.append(f"- Bundle metadata/other files ({len(other_entries)}): {', '.join(other_entries[:15])}")
            if isinstance(xapk_meta, dict):
                summary_kv = {
                    k: xapk_meta[k]
                    for k in ("package_name", "name", "version_name", "version_code", "min_sdk_version", "target_sdk_version")
                    if k in xapk_meta
                }
                if summary_kv:
                    header.append(f"- Bundle manifest.json: {json.dumps(summary_kv)}")

            if isinstance(base_details, dict) and "error" not in base_details:
                text = _format_apk_details(base_details, header)
            else:
                text = "\n".join(header)

            text += (
                "\n\n### Suggested Next Steps for Split APKs (.apks/.xapk)\n"
                "- Unpack splits: `unzip -o <apks_path> -d unpacked_splits/`\n"
                "- Decompile base APK: `jadx -d decompiled/ unpacked_splits/<base_apk>`\n"
                "- Decode base resources/smali: `apktool d unpacked_splits/<base_apk> -o apktool_out/`"
            )
            return {
                "ok": True,
                "format": ext.lstrip("."),
                "sha256": sha256,
                "sizeBytes": size_bytes,
                "splits": split_summary,
                "baseApk": base_entry.filename if base_entry else None,
                "metadata": base_details,
                "text": text[:max_chars],
            }

        # Android App Bundle (.aab)
        names = [i.filename for i in infos]
        modules = sorted({n.split("/", 1)[0] for n in names if "/" in n and not n.startswith("META-INF") and not n.startswith("BUNDLE-METADATA")})
        dex_files = sorted(n for n in names if n.endswith(".dex"))
        so_files = sorted(n for n in names if n.endswith(".so"))
        lines = [
            f"## Android App Bundle (AAB): {os.path.basename(file_path)}",
            f"- Format: AAB ({_format_size(size_bytes)}, {size_bytes} bytes)",
            f"- SHA-256: {sha256}",
            f"- Entries: {len(infos)}",
            f"- Modules ({len(modules)}): {', '.join(modules[:20])}",
            f"- DEX files ({len(dex_files)}): {', '.join(dex_files[:15])}",
            f"- Native libs ({len(so_files)}): {', '.join(so_files[:20])}",
            "\n### Suggested Next Steps\n- Inspect contents: `unzip -l <aab_path>` or unpack with `unzip -o <aab_path> -d unpacked_aab/`",
        ]
        return {
            "ok": True,
            "format": "aab",
            "sha256": sha256,
            "sizeBytes": size_bytes,
            "modules": modules,
            "text": "\n".join(lines)[:max_chars],
        }


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
        if ext in ANDROID_PKG_EXTS:
            return inspect_android_package(file_path, max_chars=max_chars)

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
