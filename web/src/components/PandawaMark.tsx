import React from "react";

interface PandawaMarkProps {
  className?: string;
}

/**
 * Bespoke minimalist geometric emblem for Pandawa OS:
 * Five faceted strokes converging into a sharp spearhead/crest.
 */
export const PandawaMark: React.FC<PandawaMarkProps> = ({ className = "w-5 h-5" }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path
      d="M12 2.5L20 12L12 21.5L4 12L12 2.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="miter"
    />
    <path
      d="M12 6.5L16.2 12L12 17.5L7.8 12L12 6.5Z"
      fill="currentColor"
      fillOpacity="0.92"
    />
    <path d="M12 2.5V6.5M12 17.5V21.5" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
