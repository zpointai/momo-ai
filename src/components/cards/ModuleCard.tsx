import React from 'react';

interface ModuleCardProps {
  label: string;
  meta?: React.ReactNode;
  dotColorClass?: string;
  dotPulse?: boolean;
  className?: string; // Additional classes for the card
  children: React.ReactNode;
}

export function ModuleCard({ 
  label, 
  meta, 
  dotColorClass = 'bg-[var(--amber-500)]', 
  dotPulse = false, 
  className = '', 
  children 
}: ModuleCardProps) {
  return (
    <article 
      className={`bg-[var(--surface-1)] border border-[var(--border-hairline)] rounded-2xl p-6 flex flex-col gap-3.5 relative overflow-hidden transition-colors duration-[var(--dur-hover)] ease-[var(--ease)] hover:border-[var(--border-strong)] ${className}`}
      role="region"
      aria-label={label.replace(/^[0-9]+ \/ /, '')} // Strip leading numbers for a11y label
    >
      <div className="flex justify-between items-center shrink-0">
        <span className="font-mono text-[11px] tracking-[0.12em] uppercase text-[var(--text-tertiary)] inline-flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full inline-block ${dotColorClass} ${dotPulse ? 'animate-pulse shadow-[0_0_6px_currentColor]' : ''}`} aria-hidden="true" />
          {label}
        </span>
        {meta && (
          <span className="font-mono text-[11px] tracking-[0.12em] uppercase text-[var(--text-quaternary)]">
            {meta}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-3.5 flex-1 w-full relative">
        {children}
      </div>
    </article>
  );
}
