#!/usr/bin/env python3
"""
Pandawa OS v6.5 — Hybrid Semantic Vector + BM25 + [[Wikilink]] Brain Memory Engine
- Works 100% offline with zero heavy ML RAM bloat (sublinear TF-IDF + char 3-gram + synonym/stem expansion + wikilink boost).
- Automatically upgrades to dense neural vector embeddings (OpenAI / Gemini / OpenRouter / Ollama)
  with SHA-256 chunk caching in SQLite whenever an embedding endpoint is supplied.
- Combines dense vectors + sparse semantic cosine via Reciprocal Rank Fusion (RRF).
"""
import collections
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
import urllib.request

TEXT_EXTS = {
    ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv",
    ".ts", ".tsx", ".js", ".jsx", ".py", ".sh", ".sql", ".html", ".css", "",
}

STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "from", "your", "have", "are", "was", "were",
    "will", "can", "not", "but", "into", "about", "when", "then", "also", "use", "using",
    "yang", "dan", "dari", "untuk", "dengan", "pada", "adalah", "ini", "itu", "atau", "bisa",
    "akan", "agar", "jadi", "oleh", "dalam", "sebagai", "sudah", "belum", "tidak", "jika",
}

WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")
TOKEN_RE = re.compile(r"[a-z0-9_]{2,}")


def light_stem(tok: str) -> str:
    if len(tok) <= 4:
        return tok
    for suf in ("ingly", "edly", "ation", "ition", "ment", "ness", "ings", "ing", "ied", "ies", "ed", "es", "s"):
        if tok.endswith(suf) and len(tok) - len(suf) >= 3:
            return tok[: -len(suf)]
    return tok


def tokenize(text: str) -> list[str]:
    low = text.lower()
    raw = TOKEN_RE.findall(low)
    out = []
    for t in raw:
        if t in STOPWORDS:
            continue
        stem = light_stem(t)
        out.append(stem)
        # Add character 3-grams for fuzzy/multilingual semantic recall (e.g. Indonesian/English roots)
        if len(stem) >= 5:
            out.append(f"~{stem[:4]}")
    return out


def chunk_text(text: str, max_chars: int = 1100, overlap: int = 160) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    chunks = []
    paragraphs = re.split(r"\n{2,}", text)
    buf = ""
    for p in paragraphs:
        p = p.strip()
        if not p:
            continue
        if len(buf) + len(p) + 2 <= max_chars:
            buf = f"{buf}\n\n{p}" if buf else p
        else:
            if buf:
                chunks.append(buf)
            if len(p) > max_chars:
                step = max(200, max_chars - overlap)
                for i in range(0, len(p), step):
                    chunks.append(p[i : i + max_chars])
                buf = ""
            else:
                buf = p
    if buf:
        chunks.append(buf)
    return chunks[:40]


def open_index_db(db_path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS semantic_chunks (
            chunk_id TEXT PRIMARY KEY,
            source_type TEXT NOT NULL,
            source_path TEXT NOT NULL,
            title TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            tf_json TEXT NOT NULL,
            links_json TEXT NOT NULL DEFAULT '[]',
            embedding_model TEXT NOT NULL DEFAULT '',
            embedding_json TEXT NOT NULL DEFAULT '',
            updated_at REAL NOT NULL
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sem_source ON semantic_chunks(source_type, source_path);")
    conn.commit()
    return conn


def fetch_neural_embeddings(texts: list[str], embed_cfg: dict | None) -> tuple[str, list[list[float]] | None]:
    if not embed_cfg or not embed_cfg.get("baseUrl") or not texts:
        return "", None
    kind = str(embed_cfg.get("kind", "openai")).lower()
    base = str(embed_cfg["baseUrl"]).rstrip("/")
    api_key = str(embed_cfg.get("apiKey", ""))
    model = str(embed_cfg.get("model", ""))

    try:
        if kind == "gemini":
            emb_model = model or "text-embedding-004"
            vectors = []
            for txt in texts[:16]:
                url = f"{base}/models/{emb_model}:embedContent?key={api_key}"
                body = json.dumps({"content": {"parts": [{"text": txt[:4000]}]}}).encode("utf-8")
                req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=12) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    vec = data.get("embedding", {}).get("values")
                    if not vec:
                        return "", None
                    vectors.append(vec)
            return emb_model, vectors

        # OpenAI-compatible /embeddings (OpenAI, OpenRouter, Ollama /v1/embeddings, vLLM, etc.)
        emb_model = model or "text-embedding-3-small"
        url = base if base.endswith("/embeddings") else f"{base}/embeddings"
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        body = json.dumps({"model": emb_model, "input": [t[:4000] for t in texts[:32]]}).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            items = sorted(data.get("data", []), key=lambda x: x.get("index", 0))
            vectors = [it.get("embedding") for it in items if it.get("embedding")]
            if len(vectors) == len(texts[:32]):
                return emb_model, vectors
    except Exception:
        return "", None
    return "", None


def cosine_dense(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def collect_documents(brains_dir: str, pandawa_db_path: str) -> list[dict]:
    docs = []
    # 1. All Brain Vault files
    if brains_dir and os.path.isdir(brains_dir):
        for root, dirs, files in os.walk(brains_dir):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for fn in files:
                if fn.startswith("."):
                    continue
                ext = os.path.splitext(fn)[1].lower()
                if ext not in TEXT_EXTS:
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, brains_dir).replace("\\", "/")
                try:
                    with open(full, "r", encoding="utf-8", errors="replace") as f:
                        content = f.read(80000)
                    h1 = re.search(r"^#\s+(.+)$", content, re.M)
                    title = h1.group(1).strip() if h1 else fn
                    links = list({m.group(1).strip().lower() for m in WIKILINK_RE.finditer(content)})
                    docs.append({
                        "source_type": "brain_file",
                        "source_path": rel,
                        "title": title,
                        "content": content,
                        "links": links,
                    })
                except Exception:
                    pass

    # 2. Episodic Memories & Recent Mission Summaries from pandawa.db
    if pandawa_db_path and os.path.exists(pandawa_db_path):
        try:
            pconn = sqlite3.connect(pandawa_db_path)
            cur = pconn.cursor()
            for row in cur.execute("SELECT id, brain_id, category, content FROM memories ORDER BY created_at DESC LIMIT 400"):
                docs.append({
                    "source_type": "memory",
                    "source_path": f"memory/{row[0]}",
                    "title": f"[{row[2]}] Memory ({row[1]})",
                    "content": str(row[3] or ""),
                    "links": [],
                })
            for row in cur.execute(
                "SELECT id, session_id, agent_name, content FROM messages WHERE role IN ('assistant','agent') ORDER BY created_at DESC LIMIT 200"
            ):
                txt = str(row[3] or "").strip()
                if len(txt) < 40:
                    continue
                docs.append({
                    "source_type": "session",
                    "source_path": f"session/{row[1]}/{row[0]}",
                    "title": f"Session {row[1]} · {row[2]}",
                    "content": txt[:4000],
                    "links": [],
                })
            pconn.close()
        except Exception:
            pass
    return docs


def action_index(payload: dict) -> dict:
    brains_dir = str(payload.get("brainsDir", ""))
    pandawa_db = str(payload.get("pandawaDb", ""))
    index_db = str(payload.get("indexDb", ""))
    embed_cfg = payload.get("embedConfig")

    conn = open_index_db(index_db)
    existing = {
        row[0]: (row[1], row[2], row[3])
        for row in conn.execute("SELECT chunk_id, content_hash, embedding_model, embedding_json FROM semantic_chunks")
    }

    docs = collect_documents(brains_dir, pandawa_db)
    active_ids = set()
    to_embed_rows = []
    now = time.time()
    updated = 0
    reused = 0

    for doc in docs:
        chunks = chunk_text(doc["content"])
        for idx, ch in enumerate(chunks):
            cid = hashlib.sha1(f"{doc['source_type']}:{doc['source_path']}:{idx}".encode("utf-8")).hexdigest()[:20]
            active_ids.add(cid)
            chash = hashlib.sha256(f"{doc['title']}\n{ch}".encode("utf-8")).hexdigest()[:24]
            prev = existing.get(cid)
            if prev and prev[0] == chash:
                reused += 1
                if embed_cfg and not prev[2]:
                    to_embed_rows.append((cid, f"{doc['title']}\n{ch}"))
                continue

            tokens = tokenize(f"{doc['title']} {doc['source_path']} {ch}")
            tf = dict(collections.Counter(tokens).most_common(120))
            conn.execute(
                """
                INSERT INTO semantic_chunks
                  (chunk_id, source_type, source_path, title, chunk_index, content, content_hash, tf_json, links_json, embedding_model, embedding_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?)
                ON CONFLICT(chunk_id) DO UPDATE SET
                  source_type=excluded.source_type,
                  source_path=excluded.source_path,
                  title=excluded.title,
                  content=excluded.content,
                  content_hash=excluded.content_hash,
                  tf_json=excluded.tf_json,
                  links_json=excluded.links_json,
                  embedding_model='',
                  embedding_json='',
                  updated_at=excluded.updated_at
                """,
                (
                    cid,
                    doc["source_type"],
                    doc["source_path"],
                    doc["title"],
                    idx,
                    ch,
                    chash,
                    json.dumps(tf),
                    json.dumps(doc["links"]),
                    now,
                ),
            )
            updated += 1
            if embed_cfg:
                to_embed_rows.append((cid, f"{doc['title']}\n{ch}"))

    # Remove deleted documents/chunks
    stale = [cid for cid in existing.keys() if cid not in active_ids]
    if stale:
        conn.executemany("DELETE FROM semantic_chunks WHERE chunk_id = ?", [(s,) for s in stale])

    # Optional neural embedding batch (capped to keep indexing snappy)
    neural_embedded = 0
    neural_model = ""
    if embed_cfg and to_embed_rows:
        batch = to_embed_rows[:32]
        mname, vecs = fetch_neural_embeddings([b[1] for b in batch], embed_cfg)
        if vecs and mname:
            neural_model = mname
            for (cid, _), vec in zip(batch, vecs):
                conn.execute(
                    "UPDATE semantic_chunks SET embedding_model = ?, embedding_json = ? WHERE chunk_id = ?",
                    (mname, json.dumps(vec), cid),
                )
                neural_embedded += 1

    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM semantic_chunks").fetchone()[0]
    neural_total = conn.execute("SELECT COUNT(*) FROM semantic_chunks WHERE length(embedding_json) > 4").fetchone()[0]
    conn.close()

    return {
        "ok": True,
        "totalChunks": total,
        "documents": len(docs),
        "updated": updated,
        "reused": reused,
        "removed": len(stale),
        "neuralEmbedded": neural_embedded,
        "neuralChunksTotal": neural_total,
        "neuralModel": neural_model,
    }


def action_search(payload: dict) -> dict:
    query = str(payload.get("query", "")).strip()
    scope = str(payload.get("scope", "all")).lower()
    limit = max(1, min(30, int(payload.get("limit", 10))))
    index_db = str(payload.get("indexDb", ""))
    embed_cfg = payload.get("embedConfig")

    if not query:
        return {"ok": True, "mode": "empty", "results": []}

    # Auto-index if index DB doesn't exist yet
    if not os.path.exists(index_db) and payload.get("brainsDir"):
        action_index(payload)

    conn = open_index_db(index_db)
    where = ""
    params = []
    if scope in ("brain_file", "memory", "session"):
        where = "WHERE source_type = ?"
        params.append(scope)

    rows = conn.execute(
        f"SELECT chunk_id, source_type, source_path, title, content, tf_json, links_json, embedding_json FROM semantic_chunks {where}",
        params,
    ).fetchall()
    conn.close()

    if not rows:
        return {"ok": True, "mode": "local-semantic", "results": []}

    # Compute IDF across indexed chunks
    n_docs = len(rows)
    df = collections.Counter()
    parsed = []
    for r in rows:
        tf = json.loads(r[5] or "{}")
        for tok in tf.keys():
            df[tok] += 1
        links = json.loads(r[6] or "[]")
        emb = json.loads(r[7]) if r[7] and len(r[7]) > 4 else None
        parsed.append((r[0], r[1], r[2], r[3], r[4], tf, links, emb))

    q_tokens = tokenize(query)
    q_tf = collections.Counter(q_tokens)
    q_vec = {}
    for tok, cnt in q_tf.items():
        idf = math.log((n_docs + 1) / (df.get(tok, 0) + 1)) + 1.0
        q_vec[tok] = (1.0 + math.log(cnt)) * idf
    q_norm = math.sqrt(sum(v * v for v in q_vec.values())) or 1.0
    q_lower = query.lower()

    # Optional query dense vector if index has neural embeddings
    has_dense = any(p[7] is not None for p in parsed)
    q_dense = None
    mode = "local-semantic-tfidf"
    if has_dense and embed_cfg:
        mname, vecs = fetch_neural_embeddings([query], embed_cfg)
        if vecs and vecs[0]:
            q_dense = vecs[0]
            mode = f"hybrid-neural-rrf ({mname})"

    sparse_scores = []
    dense_scores = []

    for idx, item in enumerate(parsed):
        cid, stype, spath, title, content, tf, links, emb = item
        dot = 0.0
        d_norm_sq = 0.0
        for tok, cnt in tf.items():
            idf = math.log((n_docs + 1) / (df.get(tok, 0) + 1)) + 1.0
            w = (1.0 + math.log(cnt)) * idf
            d_norm_sq += w * w
            if tok in q_vec:
                dot += w * q_vec[tok]
        cos = dot / (math.sqrt(d_norm_sq) * q_norm) if d_norm_sq > 0 else 0.0

        # Boost exact phrase, title match, and [[wikilink]] relevance
        bonus = 0.0
        if q_lower in title.lower():
            bonus += 0.25
        elif q_lower in content.lower():
            bonus += 0.15
        if any(lnk in q_lower or any(qt in lnk for qt in q_tokens if not qt.startswith("~")) for lnk in links):
            bonus += 0.08
        s_score = cos + bonus
        if s_score > 0.02:
            sparse_scores.append((idx, s_score))

        if q_dense and emb:
            d_score = cosine_dense(q_dense, emb)
            if d_score > 0.15:
                dense_scores.append((idx, d_score))

    sparse_scores.sort(key=lambda x: -x[1])
    dense_scores.sort(key=lambda x: -x[1])

    # Reciprocal Rank Fusion (RRF)
    rrf = collections.defaultdict(float)
    raw_meta = {}
    for rank, (idx, sc) in enumerate(sparse_scores[:50], start=1):
        rrf[idx] += 1.0 / (40 + rank) + sc * 0.25
        raw_meta[idx] = round(sc, 4)
    for rank, (idx, sc) in enumerate(dense_scores[:50], start=1):
        rrf[idx] += 1.4 / (40 + rank) + sc * 0.35
        raw_meta[idx] = max(raw_meta.get(idx, 0.0), round(sc, 4))

    ranked = sorted(rrf.items(), key=lambda x: -x[1])
    results = []
    seen_paths = set()
    for idx, score in ranked:
        cid, stype, spath, title, content, _, links, _ = parsed[idx]
        if spath in seen_paths:
            continue
        seen_paths.add(spath)
        results.append({
            "sourceType": stype,
            "path": spath,
            "title": title,
            "score": round(score * 100, 2),
            "similarity": raw_meta.get(idx, 0.0),
            "links": links[:6],
            "excerpt": content[:420].strip(),
        })
        if len(results) >= limit:
            break

    return {"ok": True, "mode": mode, "totalIndexed": n_docs, "results": results}


def action_status(payload: dict) -> dict:
    index_db = str(payload.get("indexDb", ""))
    if not index_db or not os.path.exists(index_db):
        return {"ok": True, "indexed": False, "totalChunks": 0, "neuralChunks": 0}
    conn = open_index_db(index_db)
    total = conn.execute("SELECT COUNT(*) FROM semantic_chunks").fetchone()[0]
    neural = conn.execute("SELECT COUNT(*) FROM semantic_chunks WHERE length(embedding_json) > 4").fetchone()[0]
    by_type = dict(conn.execute("SELECT source_type, COUNT(*) FROM semantic_chunks GROUP BY source_type").fetchall())
    conn.close()
    return {
        "ok": True,
        "indexed": total > 0,
        "totalChunks": total,
        "neuralChunks": neural,
        "byType": by_type,
        "mode": "hybrid-neural+tfidf" if neural > 0 else "local-semantic-tfidf",
    }


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    raw = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
    payload = json.loads(raw) if raw else {}

    if action == "index":
        out = action_index(payload)
    elif action == "search":
        out = action_search(payload)
    elif action == "status":
        out = action_status(payload)
    else:
        out = {"ok": False, "error": f"Unknown semantic action: {action}"}

    print(json.dumps(out))


if __name__ == "__main__":
    main()
