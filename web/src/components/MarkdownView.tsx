import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";

const CodeBlock: React.FC<{ className?: string; children?: React.ReactNode }> = ({ className, children }) => {
  const [copied, setCopied] = useState(false);
  const raw = String(children ?? "").replace(/\n$/, "");
  const match = /language-(\w+)/.exec(className || "");
  const lang = match?.[1] || "";

  if (!className && !raw.includes("\n")) {
    return (
      <code className="px-1.5 py-0.5 rounded bg-[#18181b] text-amber-300 font-mono text-[12px]">
        {raw}
      </code>
    );
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-white/[0.11] bg-[#09090b]">
      <div className="px-3 py-1.5 bg-[#0c0c0e] border-b border-white/[0.08] flex items-center justify-between text-[11px]">
        <span className="font-mono text-zinc-400 uppercase">{lang || "code"}</span>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(raw).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          className="flex items-center gap-1 text-zinc-400 hover:text-amber-300 transition cursor-pointer"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-xs font-mono text-zinc-200 leading-relaxed">
        <code>{raw}</code>
      </pre>
    </div>
  );
};

export const MarkdownView: React.FC<{ content: string; className?: string }> = ({ content, className = "" }) => {
  return (
    <div className={`text-sm text-zinc-200 leading-relaxed space-y-2.5 break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-lg font-bold text-white mt-3 mb-1.5">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-bold text-amber-300 mt-3 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-bold text-cyan-300 mt-2.5 mb-1">{children}</h3>,
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="text-zinc-200">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-amber-500/70 pl-3 py-0.5 text-zinc-300 italic bg-amber-500/5 rounded-r-lg">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 rounded-xl border border-white/[0.08]">
              <table className="w-full text-xs text-left">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-[#0c0c0e] text-zinc-300 uppercase text-[10px]">{children}</thead>,
          th: ({ children }) => <th className="px-3 py-2 border-b border-white/[0.08] font-semibold">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 border-b border-white/[0.08]/60 text-zinc-300">{children}</td>,
          hr: () => <hr className="border-white/[0.08] my-3" />,
          code: ({ className: c, children }) => <CodeBlock className={c}>{children}</CodeBlock>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
