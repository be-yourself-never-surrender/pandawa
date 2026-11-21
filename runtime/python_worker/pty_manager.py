#!/usr/bin/env python3
"""
Pandawa v6 — Persistent Shared Terminal Manager (Python + tmux)
Provides stateful, interactive, multi-agent shared terminal sessions
that humans can also inspect in Web Studio or attach via `tmux attach`.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid

PREFIX = "pdw_"
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07")


def sanitize_name(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", (name or "main").strip().lower()).strip("_")
    return (slug or "main")[:36]


def tmux_name(name: str) -> str:
    s = sanitize_name(name)
    return s if s.startswith(PREFIX) else f"{PREFIX}{s}"


def run_tmux(args: list[str], input_text: str | None = None, timeout: float = 10.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["tmux", *args],
        input=input_text,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def has_tmux() -> bool:
    return shutil.which("tmux") is not None


def session_exists(tname: str) -> bool:
    res = run_tmux(["has-session", "-t", tname])
    return res.returncode == 0


def cmd_list() -> dict:
    if not has_tmux():
        return {"ok": False, "tmux": False, "sessions": [], "error": "tmux is not installed"}
    fmt = "#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}"
    res = run_tmux(["list-sessions", "-F", fmt])
    sessions = []
    if res.returncode == 0:
        for line in res.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) < 6:
                continue
            sname = parts[0]
            if not sname.startswith(PREFIX):
                continue
            short = sname[len(PREFIX):]
            sessions.append({
                "name": short,
                "tmuxName": sname,
                "createdAt": int(parts[1]) if parts[1].isdigit() else 0,
                "attached": parts[2] != "0",
                "cwd": parts[3],
                "currentCommand": parts[4],
                "pid": int(parts[5]) if parts[5].isdigit() else None,
                "attachCommand": f"tmux attach -t {sname}",
            })
    return {"ok": True, "tmux": True, "sessions": sessions}


def cmd_open(payload: dict) -> dict:
    if not has_tmux():
        return {"ok": False, "error": "tmux is not installed on host"}
    name = sanitize_name(payload.get("name", "main"))
    tname = tmux_name(name)
    cwd = payload.get("cwd") or os.getcwd()
    os.makedirs(cwd, exist_ok=True)
    existed = session_exists(tname)

    if not existed:
        shell = os.environ.get("SHELL") or "/bin/bash"
        if not os.path.exists(shell):
            shell = "/bin/sh"
        res = run_tmux([
            "new-session", "-d", "-s", tname,
            "-x", "200", "-y", "50",
            "-c", cwd,
            shell,
        ])
        if res.returncode != 0:
            return {"ok": False, "error": res.stderr.strip() or "Failed to create tmux session"}
        run_tmux(["set-option", "-t", tname, "history-limit", "10000"])
        run_tmux(["set-option", "-t", tname, "remain-on-exit", "off"])
        # Give shell prompt a moment to initialize
        time.sleep(0.25)

    # Apply any initial environment variables requested
    env_vars = payload.get("env") or {}
    if isinstance(env_vars, dict) and env_vars:
        exports = []
        for k, v in env_vars.items():
            if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", str(k)):
                escaped = str(v).replace("'", "'\"'\"'")
                exports.append(f"export {k}='{escaped}'")
        if exports:
            cmd_send({"name": name, "text": " && ".join(exports), "enter": True})
            time.sleep(0.15)

    return {
        "ok": True,
        "name": name,
        "tmuxName": tname,
        "existed": existed,
        "cwd": cwd,
        "attachCommand": f"tmux attach -t {tname}",
    }


def capture_pane(tname: str, lines: int = 300) -> str:
    lines = max(20, min(5000, int(lines)))
    res = run_tmux(["capture-pane", "-p", "-J", "-t", tname, "-S", f"-{lines}"])
    if res.returncode != 0:
        return ""
    return ANSI_RE.sub("", res.stdout)


def cmd_read(payload: dict) -> dict:
    if not has_tmux():
        return {"ok": False, "error": "tmux is not installed"}
    name = sanitize_name(payload.get("name", "main"))
    tname = tmux_name(name)
    if not session_exists(tname):
        return {"ok": False, "error": f"Terminal session '{name}' does not exist."}
    lines = int(payload.get("lines", 200))
    raw_output = capture_pane(tname, lines)
    clean_lines = [
        ln for ln in raw_output.splitlines()
        if "__PDW_START_" not in ln and "__PDW_DONE_" not in ln and "__pdw_ec=" not in ln
    ]
    output = "\n".join(clean_lines).rstrip()
    # Also fetch current cwd and running command
    meta = run_tmux(["display-message", "-p", "-t", tname, "#{pane_current_path}\t#{pane_current_command}"])
    cwd, cur_cmd = "", ""
    if meta.returncode == 0 and "\t" in meta.stdout:
        cwd, cur_cmd = meta.stdout.strip().split("\t", 1)
    return {
        "ok": True,
        "name": name,
        "tmuxName": tname,
        "cwd": cwd,
        "currentCommand": cur_cmd,
        "output": output,
    }


def cmd_send(payload: dict) -> dict:
    if not has_tmux():
        return {"ok": False, "error": "tmux is not installed"}
    name = sanitize_name(payload.get("name", "main"))
    tname = tmux_name(name)
    if not session_exists(tname):
        return {"ok": False, "error": f"Terminal session '{name}' does not exist."}

    special_keys = {"C-c", "C-d", "C-z", "C-l", "Enter", "Escape", "Tab", "Up", "Down", "Left", "Right", "BSpace"}
    key = payload.get("key")
    text = payload.get("text")
    enter = payload.get("enter", True)

    if key and str(key) in special_keys:
        res = run_tmux(["send-keys", "-t", tname, str(key)])
        if res.returncode != 0:
            return {"ok": False, "error": res.stderr.strip()}
    elif text is not None:
        raw = str(text)
        if raw in special_keys and not payload.get("literal"):
            res = run_tmux(["send-keys", "-t", tname, raw])
            if res.returncode != 0:
                return {"ok": False, "error": res.stderr.strip()}
        else:
            # Use tmux buffer paste for exact quoting & multiline fidelity
            buf_name = f"pdwbuf_{uuid.uuid4().hex[:8]}"
            load = run_tmux(["load-buffer", "-b", buf_name, "-"], input_text=raw)
            if load.returncode != 0:
                return {"ok": False, "error": load.stderr.strip()}
            paste = run_tmux(["paste-buffer", "-d", "-b", buf_name, "-t", tname])
            if paste.returncode != 0:
                return {"ok": False, "error": paste.stderr.strip()}
            if enter:
                run_tmux(["send-keys", "-t", tname, "Enter"])

    time.sleep(0.2)
    snapshot = capture_pane(tname, 80).rstrip()
    return {"ok": True, "name": name, "output": snapshot[-4000:]}


def cmd_exec(payload: dict) -> dict:
    if not has_tmux():
        return {"ok": False, "error": "tmux is not installed"}
    name = sanitize_name(payload.get("name", "main"))
    tname = tmux_name(name)
    cwd = payload.get("cwd") or os.getcwd()
    if not session_exists(tname):
        opened = cmd_open({"name": name, "cwd": cwd})
        if not opened.get("ok"):
            return opened

    command = str(payload.get("command", "")).strip()
    if not command:
        return {"ok": False, "error": "Command cannot be empty"}

    timeout_sec = max(1.0, min(300.0, float(payload.get("timeoutSec", 45.0))))
    marker_id = uuid.uuid4().hex[:10]
    start_token = f"__PDW_START_{marker_id}__"
    done_prefix = f"__PDW_DONE_{marker_id}__:"

    # %s and %d keep the echoed command text distinct from the actual printed markers!
    script = (
        f"printf '__PDW_START_%s__\\n' '{marker_id}'\n"
        f"{command}\n"
        f"__pdw_ec=$?; printf '\\n__PDW_DONE_%s__:%d\\n' '{marker_id}' \"$__pdw_ec\"\n"
    )

    buf_name = f"pdwexec_{marker_id}"
    load = run_tmux(["load-buffer", "-b", buf_name, "-"], input_text=script)
    if load.returncode != 0:
        return {"ok": False, "error": load.stderr.strip()}
    paste = run_tmux(["paste-buffer", "-d", "-b", buf_name, "-t", tname])
    if paste.returncode != 0:
        return {"ok": False, "error": paste.stderr.strip()}

    done_re = re.compile(rf"^{re.escape(done_prefix)}(\d+)\s*$")
    deadline = time.monotonic() + timeout_sec
    exit_code = None
    captured_out = ""
    timed_out = False

    while True:
        pane = capture_pane(tname, 2500)
        lines = pane.splitlines()

        # Find LAST exact start_token line
        start_idx = -1
        for i, ln in enumerate(lines):
            if ln.strip() == start_token:
                start_idx = i

        if start_idx != -1:
            after = lines[start_idx + 1:]
            done_idx = -1
            for j, ln in enumerate(after):
                m = done_re.match(ln.strip())
                if m:
                    done_idx = j
                    exit_code = int(m.group(1))
                    break

            if done_idx != -1:
                body = after[:done_idx]
                # Remove echoed trailing sentinel command line if shell echoed it
                cleaned = [
                    ln for ln in body
                    if f"__PDW_DONE_%s__" not in ln and f"__PDW_START_%s__" not in ln
                ]
                captured_out = "\n".join(cleaned).strip()
                break

            if time.monotonic() >= deadline:
                timed_out = True
                cleaned = [
                    ln for ln in after
                    if f"__PDW_DONE_%s__" not in ln and f"__PDW_START_%s__" not in ln
                ]
                captured_out = "\n".join(cleaned).strip()
                break
        elif time.monotonic() >= deadline:
            timed_out = True
            captured_out = "\n".join(lines[-80:]).strip()
            break

        time.sleep(0.15)

    meta = run_tmux(["display-message", "-p", "-t", tname, "#{pane_current_path}\t#{pane_current_command}"])
    cur_cwd, cur_cmd = cwd, ""
    if meta.returncode == 0 and "\t" in meta.stdout:
        cur_cwd, cur_cmd = meta.stdout.strip().split("\t", 1)

    return {
        "ok": True,
        "name": name,
        "tmuxName": tname,
        "exitCode": exit_code,
        "timedOut": timed_out,
        "cwd": cur_cwd,
        "currentCommand": cur_cmd,
        "output": captured_out[-18000:],
    }


def cmd_close(payload: dict) -> dict:
    if not has_tmux():
        return {"ok": False, "error": "tmux is not installed"}
    name = sanitize_name(payload.get("name", "main"))
    tname = tmux_name(name)
    if not session_exists(tname):
        return {"ok": False, "error": f"Terminal session '{name}' not found."}
    res = run_tmux(["kill-session", "-t", tname])
    return {"ok": res.returncode == 0, "name": name, "error": res.stderr.strip() if res.returncode != 0 else ""}


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "list"
    raw_in = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
    payload = json.loads(raw_in) if raw_in else {}

    if action == "list":
        out = cmd_list()
    elif action == "open":
        out = cmd_open(payload)
    elif action == "read":
        out = cmd_read(payload)
    elif action == "send":
        out = cmd_send(payload)
    elif action == "exec":
        out = cmd_exec(payload)
    elif action == "close":
        out = cmd_close(payload)
    else:
        out = {"ok": False, "error": f"Unknown action: {action}"}

    print(json.dumps(out))


if __name__ == "__main__":
    main()
