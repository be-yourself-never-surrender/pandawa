const activeControllers = new Map<string, AbortController>();

export function registerMissionController(sessionId: string): AbortController {
  // Abort any prior stale run on the same session
  const prev = activeControllers.get(sessionId);
  if (prev) prev.abort(new Error("Superseded by a new mission on this session."));
  const ac = new AbortController();
  activeControllers.set(sessionId, ac);
  return ac;
}

export function clearMissionController(sessionId: string, ac?: AbortController): void {
  if (!ac || activeControllers.get(sessionId) === ac) {
    activeControllers.delete(sessionId);
  }
}

export function abortMission(sessionId: string): boolean {
  if (sessionId === "*") {
    let count = 0;
    for (const [sid, ac] of activeControllers.entries()) {
      ac.abort(new Error("Mission stopped by user."));
      activeControllers.delete(sid);
      count++;
    }
    return count > 0;
  }
  const ac = activeControllers.get(sessionId);
  if (!ac) return false;
  ac.abort(new Error("Mission stopped by user."));
  activeControllers.delete(sessionId);
  return true;
}

export function listActiveMissionSessions(): string[] {
  return Array.from(activeControllers.keys());
}
