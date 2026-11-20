import React, { useCallback, useEffect, useState } from "react";
import { BookOpen, Plus, Brain, Trash2, ExternalLink } from "lucide-react";
import { apiFetch } from "../../api/client";
import type { BrainItem } from "../../types";

interface SkillEntry {
  path: string;
  name: string;
  brainFolder: string;
  description: string;
  content: string;
}

interface MemoryEntry {
  id: string;
  brain_id: string;
  agent_id: string;
  category: string;
  content: string;
  importance: number;
  created_at: string;
}

export const SkillsPage: React.FC<{ onOpenFile: (path: string) => void }> = ({ onOpenFile }) => {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [brains, setBrains] = useState<BrainItem[]>([]);

  const [skillTitle, setSkillTitle] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [skillBrainFolder, setSkillBrainFolder] = useState("main-brain");

  const [memContent, setMemContent] = useState("");
  const [memBrainId, setMemBrainId] = useState("brain_main");
  const [memCategory, setMemCategory] = useState("lesson");

  const load = useCallback(async () => {
    const [sRes, mRes, bRes] = await Promise.all([
      apiFetch<{ skills: SkillEntry[] }>("/api/skills"),
      apiFetch<{ memories: MemoryEntry[] }>("/api/memories"),
      apiFetch<{ brains: BrainItem[] }>("/api/brains"),
    ]);
    setSkills(sRes.skills);
    setMemories(mRes.memories);
    setBrains(bRes.brains);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  async function addSkill(e: React.FormEvent) {
    e.preventDefault();
    if (!skillTitle.trim()) return;
    const slug = skillTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await apiFetch("/api/skills", {
      method: "POST",
      body: JSON.stringify({
        slug,
        title: skillTitle.trim(),
        description: skillDesc.trim(),
        instructions: skillBody.trim(),
        brainFolder: skillBrainFolder,
      }),
    });
    setSkillTitle("");
    setSkillDesc("");
    setSkillBody("");
    await load();
  }

  async function addMemory(e: React.FormEvent) {
    e.preventDefault();
    if (!memContent.trim()) return;
    await apiFetch("/api/memories", {
      method: "POST",
      body: JSON.stringify({
        brainId: memBrainId,
        category: memCategory,
        content: memContent.trim(),
        importance: 7,
      }),
    });
    setMemContent("");
    await load();
  }

  return (
    <div className="h-screen overflow-y-auto bg-[#080a0f] p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-amber-400" /> Self-Learning Skills & Episodic Memory
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Pandawa agents autonomously write reusable <code className="text-amber-300">SKILL.md</code> playbooks and save durable memories into Main Brain or Team Brains.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Skills Column */}
        <div className="space-y-4">
          <form onSubmit={addSkill} className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800 space-y-3 text-xs">
            <div className="font-bold text-amber-300 uppercase tracking-wider">Create Reusable Skill (SKILL.md)</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={skillTitle}
                onChange={(e) => setSkillTitle(e.target.value)}
                placeholder="Skill Title (e.g. Deploy Checklist)"
                className="bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
              />
              <select
                value={skillBrainFolder}
                onChange={(e) => setSkillBrainFolder(e.target.value)}
                className="bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
              >
                {brains.map((b) => (
                  <option key={b.id} value={b.folder_path}>
                    {b.name} ({b.folder_path})
                  </option>
                ))}
              </select>
            </div>
            <input
              value={skillDesc}
              onChange={(e) => setSkillDesc(e.target.value)}
              placeholder="Short description of when agents should apply this skill"
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
            />
            <textarea
              rows={3}
              value={skillBody}
              onChange={(e) => setSkillBody(e.target.value)}
              placeholder="Step-by-step markdown playbook..."
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Save Skill
            </button>
          </form>

          <div className="space-y-2.5">
            {skills.map((s) => (
              <div key={s.path} className="p-4 rounded-xl bg-[#0e1320] border border-slate-800 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-bold text-white">{s.name}</div>
                  <button
                    onClick={() => onOpenFile(s.path)}
                    className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 cursor-pointer"
                  >
                    <ExternalLink className="w-3 h-3" /> Edit
                  </button>
                </div>
                <div className="text-[11px] font-mono text-slate-500">{s.path}</div>
                <p className="text-xs text-slate-400">{s.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Memories Column */}
        <div className="space-y-4">
          <form onSubmit={addMemory} className="p-4 rounded-2xl bg-[#0e1320] border border-slate-800 space-y-3 text-xs">
            <div className="font-bold text-violet-300 uppercase tracking-wider flex items-center gap-1.5">
              <Brain className="w-4 h-4" /> Store Episodic Memory (FTS5 Indexed)
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={memBrainId}
                onChange={(e) => setMemBrainId(e.target.value)}
                className="bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
              >
                {brains.map((b) => (
                  <option key={b.id} value={b.id}>
                    [{b.layer.toUpperCase()}] {b.name}
                  </option>
                ))}
              </select>
              <select
                value={memCategory}
                onChange={(e) => setMemCategory(e.target.value)}
                className="bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
              >
                <option value="fact">Fact</option>
                <option value="decision">Decision</option>
                <option value="preference">Preference</option>
                <option value="lesson">Lesson Learned</option>
              </select>
            </div>
            <textarea
              rows={2}
              value={memContent}
              onChange={(e) => setMemContent(e.target.value)}
              placeholder="Write a persistent fact, decision, or preference for the team..."
              className="w-full bg-[#080a0f] border border-slate-700 rounded-lg px-3 py-2 text-white"
            />
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-violet-500 hover:bg-violet-400 text-white font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Add Memory
            </button>
          </form>

          <div className="space-y-2">
            {memories.map((m) => (
              <div key={m.id} className="p-3.5 rounded-xl bg-[#0e1320] border border-slate-800 flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className="px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 uppercase font-bold">
                      {m.category}
                    </span>
                    <span className="text-slate-500 font-mono">{m.brain_id}</span>
                  </div>
                  <div className="text-xs text-slate-200">{m.content}</div>
                </div>
                <button
                  onClick={async () => {
                    await apiFetch(`/api/memories/${m.id}`, { method: "DELETE" });
                    await load();
                  }}
                  className="text-slate-600 hover:text-rose-400 p-1 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {memories.length === 0 && (
              <div className="text-xs text-slate-500 p-3">
                No episodic memories stored yet. Agents can also store memories automatically during missions!
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
