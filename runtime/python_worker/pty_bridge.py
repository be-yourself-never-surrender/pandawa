#!/usr/bin/env python3
"""
Pandawa OS v6.5 — Real-Time Interactive PTY Bridge (Python stdlib + tmux)
Bridges an attached tmux session over stdin/stdout JSON frames (base64 payload)
so Node.js WebSocket + xterm.js get true 60fps ANSI interactive terminal I/O
without any C++ native addon compilation.
"""
import base64
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios

PREFIX = "pdw_"


def sanitize_name(name: str, max_len: int = 64) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", (name or "main").strip().lower()).strip("_")
    return (slug or "main")[:max_len]


def resolve_scoped_name(name: str, scope: str = "") -> str:
    clean = sanitize_name(name)
    if clean.startswith(PREFIX):
        clean = clean[len(PREFIX):] or "main"
    sc = str(scope or "").strip()
    if not sc:
        return clean
    tag = "s" + hashlib.sha256(sc.encode("utf-8")).hexdigest()[:8]
    if clean.startswith(f"{tag}__"):
        return clean
    return f"{tag}__{clean}"[:64]


def tmux_name(name: str, scope: str = "") -> str:
    s = resolve_scoped_name(name, scope)
    return s if s.startswith(PREFIX) else f"{PREFIX}{s}"


def set_winsize(fd: int, rows: int, cols: int) -> None:
    rows = max(8, min(200, int(rows)))
    cols = max(20, min(400, int(cols)))
    try:
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except Exception:
        pass


def emit(obj: dict) -> None:
    try:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        os._exit(0)


def ensure_session(tname: str, cwd: str, cols: int, rows: int) -> bool:
    if not shutil.which("tmux"):
        emit({"type": "error", "message": "tmux is not installed on host."})
        return False
    check = subprocess.run(["tmux", "has-session", "-t", f"={tname}"], capture_output=True)
    if check.returncode != 0:
        os.makedirs(cwd, exist_ok=True)
        shell = os.environ.get("SHELL") or "/bin/bash"
        if not os.path.exists(shell):
            shell = "/bin/sh"
        res = subprocess.run(
            ["tmux", "new-session", "-d", "-s", tname, "-x", str(cols), "-y", str(rows), "-c", cwd, shell],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            emit({"type": "error", "message": res.stderr.strip() or "Failed to create tmux session"})
            return False
        subprocess.run(["tmux", "set-option", "-t", f"={tname}", "history-limit", "10000"], capture_output=True)
        subprocess.run(["tmux", "set-option", "-t", f"={tname}", "mouse", "on"], capture_output=True)
        # Keep status line clean inside web xterm
        subprocess.run(["tmux", "set-option", "-t", f"={tname}", "status", "off"], capture_output=True)
    else:
        subprocess.run(["tmux", "set-option", "-t", f"={tname}", "status", "off"], capture_output=True)
    return True


def _parse_int(raw: str, default: int) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else "main"
    cwd = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    cols = _parse_int(sys.argv[3], 120) if len(sys.argv) > 3 else 120
    rows = _parse_int(sys.argv[4], 32) if len(sys.argv) > 4 else 32
    scope = sys.argv[5] if len(sys.argv) > 5 else os.environ.get("PANDAWA_TERM_SCOPE", "")
    resolved_name = resolve_scoped_name(name, scope)
    tname = tmux_name(resolved_name)

    if not ensure_session(tname, cwd, cols, rows):
        sys.exit(1)

    pid, master_fd = pty.fork()
    if pid == 0:
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        os.execvpe("tmux", ["tmux", "attach-session", "-t", f"={tname}"], env)
        os._exit(1)

    set_winsize(master_fd, rows, cols)
    emit({"type": "ready", "name": resolved_name, "tmuxName": tname, "cols": cols, "rows": rows})

    stdin_fd = sys.stdin.fileno()
    os.set_blocking(stdin_fd, False)
    stdin_buf = b""
    running = True

    def handle_sig(_sig, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, handle_sig)
    signal.signal(signal.SIGINT, handle_sig)

    try:
        while running:
            rlist, _, _ = select.select([master_fd, stdin_fd], [], [], 0.25)

            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 16384)
                    if not data:
                        break
                    emit({"type": "data", "b64": base64.b64encode(data).decode("ascii")})
                except OSError:
                    break

            if stdin_fd in rlist:
                try:
                    chunk = os.read(stdin_fd, 16384)
                    if not chunk:
                        break
                    stdin_buf += chunk
                    while b"\n" in stdin_buf:
                        line, stdin_buf = stdin_buf.split(b"\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            msg = json.loads(line.decode("utf-8", errors="replace"))
                            if not isinstance(msg, dict):
                                emit({"type": "error", "message": "Invalid frame: expected JSON object"})
                                continue
                            mtype = msg.get("type")
                            if mtype == "input" and msg.get("b64"):
                                raw = base64.b64decode(msg["b64"])
                                os.write(master_fd, raw)
                            elif mtype == "resize":
                                set_winsize(master_fd, msg.get("rows", rows), msg.get("cols", cols))
                                try:
                                    os.kill(pid, signal.SIGWINCH)
                                except OSError:
                                    pass
                        except Exception as exc:
                            emit({"type": "error", "message": f"Malformed control frame: {exc}"})
                except BlockingIOError:
                    pass
                except OSError:
                    break

            # Check if child tmux attach exited
            try:
                wpid, _ = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    break
            except ChildProcessError:
                break
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass
        emit({"type": "exit"})


if __name__ == "__main__":
    main()
