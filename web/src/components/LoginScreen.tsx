import React, { useState } from "react";
import { ShieldCheck, Lock, Sparkles, ArrowRight, Eye, EyeOff } from "lucide-react";
import { apiFetch, setStoredToken } from "../api/client";

interface LoginScreenProps {
  onSuccess: (usingDefaultPassword: boolean) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onSuccess }) => {
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; usingDefaultPassword: boolean }>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ password }),
        }
      );
      setStoredToken(res.token);
      onSuccess(res.usingDefaultPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#07090e] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Ambient glows */}
      <div className="pointer-events-none absolute -top-40 -left-40 w-[500px] h-[500px] rounded-full bg-amber-500/10 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 w-[500px] h-[500px] rounded-full bg-violet-600/15 blur-[130px]" />

      <div className="w-full max-w-md relative z-10">
        <div className="bg-[#10141f]/90 backdrop-blur-xl border border-slate-800/90 rounded-2xl shadow-2xl p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-400 via-amber-500 to-orange-600 flex items-center justify-center shadow-lg shadow-amber-500/25">
              <Sparkles className="w-6 h-6 text-slate-950" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">PANDAWA</h1>
              <p className="text-xs text-amber-400/90 font-medium tracking-wide uppercase">
                Agentic Team & Layered Brain Platform
              </p>
            </div>
          </div>

          <p className="text-sm text-slate-400 mb-6 leading-relaxed">
            Connect Main Brain, Team Brains, custom knowledge folders (<code className="text-amber-300">soul.md</code>),
            and multiple AI providers into one cohesive peer team.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5 uppercase tracking-wider">
                Access Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password (default: 11111111)"
                  autoFocus
                  className="w-full bg-[#090c14] border border-slate-700/80 focus:border-amber-500 rounded-xl pl-10 pr-10 py-3 text-sm text-white placeholder-slate-500 outline-none transition"
                />
                <button
                  type="button"
                  aria-label={showPw ? "Hide password" : "Show password"}
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-400 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm flex items-center justify-center gap-2 transition shadow-lg shadow-amber-500/20 disabled:shadow-none cursor-pointer"
            >
              {loading ? "Authenticating..." : "Enter Pandawa Studio"}
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              Encrypted scrypt auth
            </span>
            <span>Default password: <code className="text-slate-300">11111111</code></span>
          </div>
        </div>
      </div>
    </div>
  );
};
