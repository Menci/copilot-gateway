// Base HTML layout — dark luxury aesthetic
// Uses Tailwind CDN + Alpine.js + JetBrains Mono + DM Sans fonts

import type { Child } from "hono/jsx";
import { html } from "hono/html";

export function Layout({
  title,
  children,
}: {
  title: string;
  children: Child;
}) {
  return html`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — Copilot Gateway</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%2306080a'/><path d='M55 15L30 55h18L40 85l35-45H55L65 15z' fill='%2300e5ff'/></svg>" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <link href="https://cdn.jsdelivr.net/npm/prismjs@1/themes/prism-okaidia.min.css" rel="stylesheet" />
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/prism.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-bash.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1/components/prism-toml.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@300;400;500;600&display=swap" rel="stylesheet" />
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['DM Sans', 'system-ui', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          },
          colors: {
            surface: {
              '900': '#06080a',
              '800': '#0c1015',
              '700': '#13181f',
              '600': '#1a2029',
              '500': '#242c38',
            },
            accent: {
              cyan: '#00e5ff',
              cyanDim: '#00b8d4',
              cyanGlow: 'rgba(0, 229, 255, 0.15)',
              emerald: '#00e676',
              amber: '#ffd740',
              rose: '#ff5252',
            }
          }
        }
      }
    }
  </script>
  <style>
    [x-cloak] { display: none !important; }

    body {
      background: #06080a;
      color: #e0e0e0;
      font-family: 'DM Sans', system-ui, sans-serif;
    }

    /* Subtle noise texture */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
      pointer-events: none;
      z-index: -1;
    }

    /* Glow effect */
    .glow-cyan {
      box-shadow: 0 0 20px rgba(0, 229, 255, 0.1),
                  0 0 60px rgba(0, 229, 255, 0.05);
    }

    .glow-border {
      border: 1px solid rgba(0, 229, 255, 0.15);
    }

    /* Card glass effect */
    .glass-card {
      background: linear-gradient(135deg, rgba(19, 24, 31, 0.8), rgba(12, 16, 21, 0.95));
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
    }

    /* Staggered fade-in */
    @keyframes fadeSlideUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .animate-in {
      animation: fadeSlideUp 0.5s ease-out forwards;
      opacity: 0;
    }

    .delay-1 { animation-delay: 0.1s; }
    .delay-2 { animation-delay: 0.2s; }
    .delay-3 { animation-delay: 0.3s; }
    .delay-4 { animation-delay: 0.4s; }
    .delay-5 { animation-delay: 0.5s; }

    /* Progress bar */
    .progress-track {
      height: 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.8s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* Status dot pulse */
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .status-pulse {
      animation: pulse-dot 2s ease-in-out infinite;
    }

    /* Hover lift */
    .hover-lift {
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .hover-lift:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    /* Input styling */
    input[type="text"], input[type="password"] {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      padding: 12px 16px;
      color: #e0e0e0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      outline: none;
      width: 100%;
    }
    input:focus {
      border-color: rgba(0, 229, 255, 0.5);
      box-shadow: 0 0 0 3px rgba(0, 229, 255, 0.1);
    }

    /* Button */
    .btn-primary {
      background: linear-gradient(135deg, #00b8d4, #00e5ff);
      color: #06080a;
      font-weight: 600;
      padding: 12px 24px;
      border-radius: 10px;
      border: none;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: 'DM Sans', system-ui, sans-serif;
      font-size: 14px;
      letter-spacing: 0.02em;
    }
    .btn-primary:hover {
      filter: brightness(1.1);
      box-shadow: 0 4px 16px rgba(0, 229, 255, 0.25);
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-ghost {
      background: rgba(255, 255, 255, 0.04);
      color: #b0bec5;
      font-weight: 500;
      padding: 10px 20px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: 'DM Sans', system-ui, sans-serif;
      font-size: 13px;
    }
    .btn-ghost:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
    }

    /* Prism github-dark overrides */
    code[class*="language-"],
    pre[class*="language-"] {
      background: transparent !important;
      text-shadow: none !important;
      font-family: 'JetBrains Mono', monospace !important;
      font-size: 11px !important;
      line-height: 1.6 !important;
    }
    /* TOML table headers — Tailwind's .table sets display:table, override it */
    .token.table { display: inline !important; }
    .token.table .punctuation { display: inline !important; }
    .token.comment, .token.prolog, .token.doctype, .token.cdata { color: #8b949e; }
    .token.punctuation { color: #c9d1d9; }
    .token.property, .token.tag, .token.boolean, .token.number, .token.constant, .token.symbol { color: #79c0ff; }
    .token.selector, .token.attr-name, .token.string, .token.char, .token.builtin { color: #a5d6ff; }
    .token.operator, .token.entity, .token.url { color: #c9d1d9; }
    .token.atrule, .token.attr-value, .token.keyword { color: #ff7b72; }
    .token.function, .token.class-name { color: #d2a8ff; }
    .token.regex, .token.important, .token.variable { color: #ffa657; }
    .token.assign-left { color: #c9d1d9; }
  </style>
</head>
<body class="min-h-screen">
  ${children}
</body>
</html>`;
}
