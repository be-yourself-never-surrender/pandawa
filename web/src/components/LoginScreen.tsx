import React, { useState } from "react";
import { Lock, ArrowRight, Eye, EyeOff } from "lucide-react";
import { apiFetch, setStoredToken } from "../api/client";
import { PandawaMark } from "./PandawaMark";

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
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#09090b] bg-architect-grid flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-[380px]">
        {/* Brand Header */}
        <div className="flex items-center gap-2.5 mb-8">
          <div className="w-8 h-8 rounded-lg bg-[#111113] border border-white/[0.10] flex items-center justify-center text-amber-400">
            <PandawaMark className="w-4 h-4" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-[-0.02em] text-zinc-100">Pandawa</span>
            <span className="text-[11px] font-mono text-zinc-500">OS 7.0</span>
          </div>
        </div>

        {/* Auth Surface */}
        <div className="rounded-xl bg-[#111113] border border-white/[0.08] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
          <div className="mb-5">
            <h1 className="text-base font-semibold tracking-[-0.02em] text-zinc-100">
              Sign in to workspace
            </h1>
            <p className="text-xs text-zinc-500 mt-1">
              Enter your administrator password to access your local agent runtime.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  autoFocus
                  className="w-full h-10 bg-[#09090b] border border-white/[0.09] focus:border-amber-400/70 rounded-lg pl-9 pr-9 text-[13px] text-zinc-100 placeholder-zinc-600 outline-none transition"
                />
                <button
                  type="button"
                  aria-label={showPw ? "Hide password" : "Show password"}
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 cursor-pointer p-0.5"
                >
                  {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full h-10 rounded-lg bg-zinc-100 hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-medium text-[13px] flex items-center justify-center gap-2 transition cursor-pointer"
            >
              {loading ? "Verifying..." : "Continue"}
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>

        {/* Quiet Metadata Footer */}
        <div className="mt-5 flex items-center justify-between text-[11px] text-zinc-600 px-1">
          <span>scrypt · AES-256-GCM</span>
          <span className="font-mono">data/.initial_password</span>
        </div>
      </div>
    </div>
  );
};
