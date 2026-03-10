// Dashboard page — four-tab layout: Upstream / API Keys / Usage / Settings
// All API calls authenticated via x-api-key header from localStorage

import { html } from "hono/html";
import { Layout } from "./layout.tsx";

/** Reusable code block with Prism.js syntax highlighting and copy button */
function codeBlock(lang: string, ref: string, snippetFn: string, copyId: string) {
  return html`
    <div class="relative group">
      <pre class="bg-surface-900 rounded-xl p-4 pr-10 overflow-x-auto border border-white/[0.04]"><code class="language-${lang}" x-ref="${ref}" x-effect="$el.textContent = ${snippetFn}(); Prism.highlightElement($el)"></code></pre>
      <button @click="copySnippet(${snippetFn}(), '${copyId}')"
        class="absolute top-2.5 right-2.5 p-1.5 rounded-md bg-surface-700/80 text-gray-500 hover:text-accent-cyan hover:bg-surface-600 transition-all opacity-0 group-hover:opacity-100"
        :title="copied === '${copyId}' ? 'Copied!' : 'Copy'">
        <svg x-show="copied !== '${copyId}'" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <svg x-show="copied === '${copyId}'" class="w-3.5 h-3.5 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      </button>
    </div>`;
}

export function DashboardPage() {
  return Layout({
    title: "Dashboard",
    children: html`
      <div class="min-h-screen" x-data="dashboardApp()" x-init="init()">
        <!-- Top ambient glow -->
        <div class="fixed top-0 left-1/4 w-[500px] h-[300px] bg-accent-cyan/3 rounded-full blur-[100px] pointer-events-none"></div>
        <div class="fixed top-0 right-1/4 w-[400px] h-[250px] bg-accent-emerald/3 rounded-full blur-[100px] pointer-events-none"></div>

        <!-- Header -->
        <header class="border-b border-white/5 bg-surface-900/80 backdrop-blur-md sticky top-0 z-50">
          <div class="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-surface-700 glow-border flex items-center justify-center">
                <svg class="w-4 h-4 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
              </div>
              <span class="font-semibold text-white text-sm tracking-tight">Copilot Gateway</span>
            </div>
            <button @click="logout()" class="btn-ghost text-xs">Logout</button>
          </div>

          <!-- Tab bar -->
          <div class="max-w-6xl mx-auto px-6 pb-3">
            <nav class="flex gap-1 bg-surface-800 rounded-lg p-0.5 w-fit">
              <template x-if="isAdmin">
                <button @click="switchTab('upstream')"
                  class="px-4 py-2 rounded-md text-sm font-medium transition-all"
                  :class="tab === 'upstream' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
                  Upstream
                </button>
              </template>
              <template x-if="isAdmin">
              <button @click="switchTab('keys')"
                class="px-4 py-2 rounded-md text-sm font-medium transition-all"
                :class="tab === 'keys' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
                API Keys
              </button>
              </template>
              <button @click="switchTab('usage')"
                class="px-4 py-2 rounded-md text-sm font-medium transition-all"
                :class="tab === 'usage' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
                Usage
              </button>
              <template x-if="isAdmin">
              <button @click="switchTab('settings')"
                class="px-4 py-2 rounded-md text-sm font-medium transition-all"
                :class="tab === 'settings' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
                Settings
              </button>
              </template>
            </nav>
          </div>
        </header>

        <main class="max-w-6xl mx-auto px-6 py-8">

          <!-- ===================== TAB: UPSTREAM (ADMIN_KEY only) ===================== -->
          <template x-if="isAdmin">
          <div x-show="tab === 'upstream'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">

            <!-- GitHub Connection Banner (only when no accounts at all) -->
            <template x-if="meLoaded && githubAccounts.length === 0">
              <div class="glass-card p-6 mb-8 glow-border animate-in flex items-center justify-between">
                <div>
                  <h3 class="text-white font-medium mb-1">Connect GitHub Account</h3>
                  <p class="text-sm text-gray-400">Link your GitHub account to use Copilot API with your own token.</p>
                </div>
                <button @click="startGithubAuth()" class="btn-primary" :disabled="deviceFlow.loading">
                  <span x-show="!deviceFlow.loading">Connect GitHub</span>
                  <span x-show="deviceFlow.loading" class="flex items-center gap-2">
                    <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                    </svg>
                    Connecting…
                  </span>
                </button>
              </div>
            </template>

            <!-- Device Flow Modal -->
            <template x-if="deviceFlow.userCode">
              <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in">
                <div class="glass-card p-8 max-w-md w-full mx-4 glow-cyan">
                  <h3 class="text-white text-lg font-semibold mb-2">GitHub Authorization</h3>
                  <p class="text-gray-400 text-sm mb-6">Enter this code on GitHub to authorize:</p>

                  <div class="bg-surface-900 rounded-xl p-6 text-center mb-6 glow-border">
                    <code class="text-3xl font-mono font-bold text-accent-cyan tracking-[0.3em]" x-text="deviceFlow.userCode"></code>
                  </div>

                  <p class="text-gray-500 text-xs text-center mb-2">Visit <a :href="deviceFlow.verificationUri" class="text-accent-cyan hover:underline" x-text="deviceFlow.verificationUri" target="_blank"></a></p>
                  <a :href="deviceFlow.verificationUri" target="_blank"
                     class="btn-primary w-full block text-center mb-4">
                    Open GitHub
                  </a>

                  <div class="flex items-center justify-center gap-2 text-sm text-gray-500">
                    <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                    </svg>
                    Waiting for authorization...
                  </div>

                  <button @click="cancelDeviceFlow()" class="btn-ghost w-full mt-4">Cancel</button>
                </div>
              </div>
            </template>

            <!-- Stats Grid -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
              <!-- Premium Requests -->
              <div class="glass-card p-6 hover-lift animate-in delay-1">
                <div class="flex items-center justify-between mb-4">
                  <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Premium Requests</span>
                  <div class="w-2 h-2 rounded-full status-pulse"
                       :class="usageData ? (usagePercent > 90 ? 'bg-accent-rose' : usagePercent > 70 ? 'bg-accent-amber' : 'bg-accent-emerald') : 'bg-gray-600'"></div>
                </div>
                <template x-if="usageData">
                  <div>
                    <div class="flex items-baseline gap-2 mb-3">
                      <span class="text-3xl font-bold text-white font-mono" x-text="usageData.quota_snapshots.premium_interactions.entitlement - usageData.quota_snapshots.premium_interactions.remaining"></span>
                      <span class="text-sm text-gray-500">/ <span x-text="usageData.quota_snapshots.premium_interactions.entitlement"></span></span>
                    </div>
                    <div class="progress-track">
                      <div class="progress-fill"
                           :class="usagePercent > 90 ? 'bg-accent-rose' : usagePercent > 70 ? 'bg-gradient-to-r from-accent-amber to-accent-rose' : 'bg-gradient-to-r from-accent-cyan to-accent-emerald'"
                           :style="'width:' + usagePercent + '%'"></div>
                    </div>
                    <p class="text-xs text-gray-500 mt-2">
                      <span x-text="usageData.quota_snapshots.premium_interactions.remaining"></span> remaining
                      · Resets <span x-text="formatDate(usageData.quota_reset_date)"></span>
                    </p>
                  </div>
                </template>
                <template x-if="!usageData && !usageError">
                  <div class="space-y-2">
                    <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
                    <div class="h-2 bg-surface-600 rounded animate-pulse"></div>
                  </div>
                </template>
                <template x-if="usageError">
                  <p class="text-sm text-gray-500">Unable to load</p>
                </template>
              </div>

              <!-- Chat Completions -->
              <div class="glass-card p-6 hover-lift animate-in delay-2">
                <div class="flex items-center justify-between mb-4">
                  <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Chat Quota</span>
                  <svg class="w-4 h-4 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                </div>
                <template x-if="usageData">
                  <div>
                    <div class="flex items-baseline gap-2 mb-1">
                      <span class="text-2xl font-bold text-white font-mono"
                            x-text="usageData.quota_snapshots.chat.unlimited ? '\u221e' : usageData.quota_snapshots.chat.remaining"></span>
                      <span class="text-xs text-gray-500" x-show="!usageData.quota_snapshots.chat.unlimited">remaining</span>
                      <span class="text-xs text-accent-emerald" x-show="usageData.quota_snapshots.chat.unlimited">unlimited</span>
                    </div>
                    <p class="text-xs text-gray-500">
                      Plan: <span class="text-gray-300" x-text="usageData.copilot_plan"></span>
                    </p>
                  </div>
                </template>
                <template x-if="!usageData">
                  <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
                </template>
              </div>

              <!-- Completions -->
              <div class="glass-card p-6 hover-lift animate-in delay-3">
                <div class="flex items-center justify-between mb-4">
                  <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Completions</span>
                  <svg class="w-4 h-4 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="16 18 22 12 16 6"/>
                    <polyline points="8 6 2 12 8 18"/>
                  </svg>
                </div>
                <template x-if="usageData">
                  <div>
                    <div class="flex items-baseline gap-2 mb-1">
                      <span class="text-2xl font-bold text-white font-mono"
                            x-text="usageData.quota_snapshots.completions.unlimited ? '\u221e' : usageData.quota_snapshots.completions.remaining"></span>
                      <span class="text-xs text-gray-500" x-show="!usageData.quota_snapshots.completions.unlimited">remaining</span>
                      <span class="text-xs text-accent-emerald" x-show="usageData.quota_snapshots.completions.unlimited">unlimited</span>
                    </div>
                    <p class="text-xs text-gray-500">Code completions</p>
                  </div>
                </template>
                <template x-if="!usageData">
                  <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
                </template>
              </div>
            </div>

            <!-- Info Cards -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
              <!-- GitHub Accounts -->
              <div class="glass-card p-6 animate-in delay-4">
                <div class="flex items-center justify-between mb-4">
                  <h3 class="text-xs font-medium text-gray-500 uppercase tracking-widest">GitHub Accounts</h3>
                  <template x-if="meLoaded && githubAccounts.length > 0">
                    <button @click="startGithubAuth()" class="btn-ghost text-xs" :disabled="deviceFlow.loading">
                      <span x-show="!deviceFlow.loading">+ Add</span>
                      <span x-show="deviceFlow.loading" class="flex items-center gap-1.5">
                        <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                          <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                        </svg>
                        Adding…
                      </span>
                    </button>
                  </template>
                </div>
                <template x-if="!meLoaded">
                  <div class="space-y-3">
                    <div class="flex items-center gap-3">
                      <div class="w-9 h-9 rounded-lg bg-surface-600 animate-pulse shrink-0"></div>
                      <div class="space-y-1.5 flex-1">
                        <div class="h-4 w-28 bg-surface-600 rounded animate-pulse"></div>
                        <div class="h-3 w-20 bg-surface-600 rounded animate-pulse"></div>
                      </div>
                    </div>
                  </div>
                </template>
                <template x-if="meLoaded && githubAccounts.length === 0">
                  <p class="text-sm text-gray-500">No GitHub accounts connected</p>
                </template>
                <template x-if="meLoaded && githubAccounts.length > 0">
                  <div class="space-y-1">
                    <template x-for="acct in githubAccounts" :key="acct.id">
                      <div @click="!acct.active && switchGithubAccount(acct.id)"
                           class="flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors"
                           :class="acct.active ? 'bg-accent-cyan/5 border border-accent-cyan/15' : 'hover:bg-white/[0.03] cursor-pointer border border-transparent'">
                        <div class="flex items-center gap-3">
                          <div class="relative">
                            <img :src="acct.avatar_url" class="w-9 h-9 rounded-lg ring-1 ring-white/5" />
                            <div x-show="acct.active" class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-accent-emerald ring-2 ring-surface-800"></div>
                          </div>
                          <div>
                            <p class="text-sm text-white font-medium" x-text="acct.name || acct.login"></p>
                            <p class="text-xs text-gray-500" x-text="'@' + acct.login"></p>
                          </div>
                        </div>
                        <div class="flex items-center gap-2">
                          <span x-show="acct.active" class="text-[10px] font-medium text-accent-emerald uppercase tracking-widest">Active</span>
                          <button @click.stop="disconnectGithub(acct.id, acct.login)" class="text-gray-600 hover:text-accent-rose transition-colors p-1" title="Disconnect">
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <line x1="18" y1="6" x2="6" y2="18"/>
                              <line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                          </button>
                        </div>
                      </div>
                    </template>
                  </div>
                </template>
              </div>

              <!-- API Info -->
              <div class="glass-card p-6 animate-in delay-5">
                <h3 class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4">API Endpoints</h3>
                <div class="space-y-3 font-mono text-xs">
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold">POST</span>
                    <span class="text-gray-300">/v1/chat/completions</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold">POST</span>
                    <span class="text-gray-300">/v1/messages</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold">POST</span>
                    <span class="text-gray-300">/v1/responses</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold">POST</span>
                    <span class="text-gray-300">/v1/embeddings</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan text-[10px] font-bold">GET</span>
                    <span class="text-gray-300">/v1/models</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </template>

          <!-- ===================== TAB: API KEYS (ADMIN_KEY only) ===================== -->
          <template x-if="isAdmin">
          <div x-show="tab === 'keys'">

            <!-- Key Management -->
            <div class="glass-card p-6 mb-6 animate-in">
              <div class="flex items-center justify-between mb-6">
                <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">API Keys</span>
                <div class="flex items-center gap-2">
                  <input type="text" x-model="newKeyName" placeholder="Name" class="!text-xs !py-1.5 !px-3 !w-32 !rounded-lg" @keydown.enter="createNewKey()" />
                  <button @click="createNewKey()" class="btn-primary !text-xs !py-1.5 !px-3 !rounded-lg whitespace-nowrap" :disabled="!newKeyName.trim() || keyCreating">
                    <span x-show="!keyCreating">+ Create</span>
                    <span x-show="keyCreating" class="flex items-center gap-1.5">
                      <svg class="animate-spin h-3 w-3" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                      </svg>
                      Creating…
                    </span>
                  </button>
                </div>
              </div>

              <!-- Key List -->
              <div class="overflow-x-auto">
                <template x-if="keys.length === 0 && !keysLoading">
                  <p class="text-sm text-gray-500 py-4 text-center">No API keys yet. Create one above.</p>
                </template>
                <template x-if="keysLoading && keys.length === 0">
                  <div class="space-y-3 py-2">
                    <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
                    <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
                  </div>
                </template>
                <template x-if="keys.length > 0">
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="border-b border-white/5">
                        <th class="text-left py-2 pr-4 pl-7 text-xs font-medium text-gray-500 uppercase tracking-widest">Name</th>
                        <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Key</th>
                        <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Created</th>
                        <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Last Used</th>
                        <th class="text-right py-2 pr-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <template x-for="k in keys" :key="k.id">
                        <tr @click="selectedKeyId = k.id"
                            class="border-b border-white/[0.03] transition-colors cursor-pointer"
                            :class="selectedKeyId === k.id ? 'bg-accent-cyan/5 hover:bg-accent-cyan/8' : 'hover:bg-white/[0.02]'">
                          <td class="py-3 pr-4 pl-2">
                            <div class="flex items-center gap-2">
                              <div class="w-1.5 h-1.5 rounded-full shrink-0 transition-colors"
                                   :class="selectedKeyId === k.id ? 'bg-accent-cyan' : 'bg-transparent'"></div>
                              <span class="text-white font-medium" x-text="k.name"></span>
                            </div>
                          </td>
                          <td class="py-3 pr-4">
                            <code class="text-xs font-mono text-gray-500 bg-surface-800 rounded px-2 py-1" x-text="truncateKey(k.key)"></code>
                          </td>
                          <td class="py-3 pr-4">
                            <span class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.created_at)" x-text="timeAgo(k.created_at)"></span>
                          </td>
                          <td class="py-3 pr-4">
                            <span x-show="k.last_used_at" class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.last_used_at)" x-text="timeAgo(k.last_used_at)"></span>
                            <span x-show="!k.last_used_at" class="text-gray-600 text-xs">Never</span>
                          </td>
                          <td class="py-3 pr-2 text-right">
                            <div class="flex items-center justify-end gap-1">
                              <button @click.stop="copySnippet(k.key, 'key-' + k.id)" class="text-gray-600 hover:text-accent-cyan transition-colors p-1" title="Copy key">
                                <svg x-show="copied !== 'key-' + k.id" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                <svg x-show="copied === 'key-' + k.id" class="w-4 h-4 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                              </button>
                              <button @click.stop="renameKeyById(k.id, k.name)" class="text-gray-600 hover:text-accent-violet transition-colors p-1" title="Rename key">
                                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                                    <path d="m15 5 4 4"/>
                                  </svg>
                                </button>
                              <button @click.stop="rotateKeyById(k.id, k.name)" class="text-gray-600 hover:text-accent-amber transition-colors p-1" :disabled="keyRotating === k.id" title="Rotate key">
                                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M21.5 2v6h-6"/>
                                    <path d="M2.5 22v-6h6"/>
                                    <path d="M2.5 12a10 10 0 0 1 16.5-5.7L21.5 8"/>
                                    <path d="M21.5 12a10 10 0 0 1-16.5 5.7L2.5 16"/>
                                  </svg>
                                </button>
                              <button @click.stop="deleteKeyById(k.id, k.name)" class="text-gray-600 hover:text-accent-rose transition-colors p-1" :disabled="keyDeleting === k.id" title="Delete key">
                                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                  </svg>
                                </button>
                            </div>
                          </td>
                        </tr>
                      </template>
                    </tbody>
                  </table>
                </template>
              </div>
            </div>

            <!-- Configuration Guide -->
            <div class="glass-card p-6 animate-in delay-1">
              <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Configuration</span>
              <template x-if="selectedKeyId">
                <p class="text-xs text-accent-cyan mt-2 flex items-center gap-1.5">
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                  Configs below use the selected key.
                </p>
              </template>

              <!-- Loading skeleton -->
              <template x-if="!modelsLoaded">
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
                  <div class="space-y-3">
                    <div class="h-5 w-28 bg-surface-600 rounded animate-pulse"></div>
                    <div class="h-7 w-40 bg-surface-600 rounded animate-pulse"></div>
                    <div class="h-32 bg-surface-600 rounded-xl animate-pulse"></div>
                  </div>
                  <div class="space-y-3">
                    <div class="h-5 w-20 bg-surface-600 rounded animate-pulse"></div>
                    <div class="h-7 w-40 bg-surface-600 rounded animate-pulse"></div>
                    <div class="h-32 bg-surface-600 rounded-xl animate-pulse"></div>
                  </div>
                </div>
              </template>

              <template x-if="modelsLoaded">
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
                  <!-- Claude Code -->
                  <div>
                    <div class="mb-3">
                      <span class="text-sm font-semibold text-white">Claude Code</span>
                    </div>

                    <!-- Model selectors -->
                    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                      <div class="flex items-center gap-2">
                        <label class="text-xs text-gray-500">Model:</label>
                        <select x-model="claudeModel"
                          class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer">
                          <template x-for="m in claudeModelsBig" :key="m">
                            <option :value="m" x-text="m"></option>
                          </template>
                        </select>
                      </div>
                      <div class="flex items-center gap-2">
                        <label class="text-xs text-gray-500">Small/fast:</label>
                        <select x-model="claudeSmallModel"
                          class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer">
                          <template x-for="m in claudeModelsSmall" :key="m">
                            <option :value="m" x-text="m"></option>
                          </template>
                        </select>
                      </div>
                    </div>

                    <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.bashrc</code>, <code class="text-gray-500">~/.zshrc</code>, or equivalent</p>
                    ${codeBlock("bash", "claudeCode", "claudeCodeSnippet", "claude")}
                  </div>

                  <!-- Codex -->
                  <div>
                    <div class="mb-3">
                      <span class="text-sm font-semibold text-white">Codex</span>
                    </div>

                    <!-- Model selector -->
                    <div class="flex items-center gap-2 mb-3">
                      <label class="text-xs text-gray-500">Model:</label>
                      <select x-model="codexModel"
                        class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer">
                        <template x-for="m in codexModels" :key="m">
                          <option :value="m" x-text="m"></option>
                        </template>
                      </select>
                    </div>

                    <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.codex/config.toml</code></p>
                    ${codeBlock("toml", "codexCode", "codexSnippet", "codex")}

                    <p class="text-[11px] text-gray-600 mt-4 mb-2">Add to <code class="text-gray-500">~/.bashrc</code>, <code class="text-gray-500">~/.zshrc</code>, or equivalent</p>
                    ${codeBlock("bash", "codexEnv", "codexEnvSnippet", "codexEnv")}
                  </div>
                </div>
              </template>
            </div>
          </div>
          </template>

          <!-- ===================== TAB: USAGE ===================== -->
          <div x-show="tab === 'usage'">
            <div class="glass-card p-6 animate-in">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <div class="flex items-center gap-3">
                  <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Token Usage</span>
                  <template x-if="tokenLoading">
                    <svg class="animate-spin h-3.5 w-3.5 text-gray-500" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                    </svg>
                  </template>
                </div>
                <div class="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
                  <button @click="switchTokenRange('today')"
                    class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                    :class="tokenRange === 'today' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
                    Today
                  </button>
                  <button @click="switchTokenRange('7d')"
                    class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                    :class="tokenRange === '7d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
                    7 Days
                  </button>
                  <button @click="switchTokenRange('30d')"
                    class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                    :class="tokenRange === '30d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'">
                    30 Days
                  </button>
                </div>
              </div>

              <div style="height: 320px; position: relative;">
                <template x-if="tokenLoading && !tokenChart">
                  <div class="absolute inset-0 flex items-center justify-center">
                    <div class="flex flex-col items-center gap-3">
                      <svg class="animate-spin h-6 w-6 text-accent-cyan/60" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/>
                        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/>
                      </svg>
                      <span class="text-xs text-gray-500">Loading usage data…</span>
                    </div>
                  </div>
                </template>
                <canvas id="tokenChart"></canvas>
              </div>

              <!-- Summary stats -->
              <div class="grid grid-cols-3 gap-4 mt-6 pt-5 border-t border-white/5">
                <div class="text-center">
                  <p class="text-xs text-gray-500 mb-1">Requests</p>
                  <template x-if="tokenLoading && !tokenChart">
                    <div class="h-7 w-16 mx-auto bg-surface-600 rounded animate-pulse"></div>
                  </template>
                  <template x-if="!tokenLoading || tokenChart">
                    <p class="text-lg font-bold font-mono text-white" x-text="tokenSummary.requests.toLocaleString()"></p>
                  </template>
                </div>
                <div class="text-center">
                  <p class="text-xs text-gray-500 mb-1">Input Tokens</p>
                  <template x-if="tokenLoading && !tokenChart">
                    <div class="h-7 w-20 mx-auto bg-surface-600 rounded animate-pulse"></div>
                  </template>
                  <template x-if="!tokenLoading || tokenChart">
                    <p class="text-lg font-bold font-mono text-white" x-text="tokenSummary.input.toLocaleString()"></p>
                  </template>
                </div>
                <div class="text-center">
                  <p class="text-xs text-gray-500 mb-1">Output Tokens</p>
                  <template x-if="tokenLoading && !tokenChart">
                    <div class="h-7 w-20 mx-auto bg-surface-600 rounded animate-pulse"></div>
                  </template>
                  <template x-if="!tokenLoading || tokenChart">
                    <p class="text-lg font-bold font-mono text-white" x-text="tokenSummary.output.toLocaleString()"></p>
                  </template>
                </div>
              </div>
            </div>
          </div>

          <!-- ===================== TAB: SETTINGS (ADMIN_KEY only) ===================== -->
          <template x-if="isAdmin">
          <div x-show="tab === 'settings'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">

            <!-- Export -->
            <div class="glass-card p-6 mb-6 animate-in">
              <h3 class="text-white font-semibold mb-1">Export Data</h3>
              <p class="text-sm text-gray-400 mb-4">Download all API keys, GitHub accounts, and usage data as a JSON file.</p>
              <button @click="exportData()" class="btn-primary" :disabled="exportLoading">
                <span x-show="!exportLoading" class="flex items-center gap-2">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Export JSON
                </span>
                <span x-show="exportLoading" class="flex items-center gap-2">
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/></svg>
                  Exporting...
                </span>
              </button>
            </div>

            <!-- Import -->
            <div class="glass-card p-6 animate-in">
              <h3 class="text-white font-semibold mb-1">Import Data</h3>
              <p class="text-sm text-gray-400 mb-4">Restore data from a previously exported JSON file.</p>

              <!-- File picker -->
              <div class="mb-4">
                <label class="block w-full cursor-pointer border-2 border-dashed border-white/10 hover:border-accent-cyan/30 rounded-xl p-8 text-center transition-colors"
                  :class="importFile ? 'border-accent-cyan/40 bg-accent-cyan/5' : ''">
                  <input type="file" accept=".json" class="hidden" @change="handleImportFile($event)">
                  <template x-if="!importFile">
                    <div>
                      <svg class="w-8 h-8 mx-auto mb-2 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      <p class="text-sm text-gray-400">Click to select a JSON export file</p>
                    </div>
                  </template>
                  <template x-if="importFile">
                    <div>
                      <svg class="w-8 h-8 mx-auto mb-2 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      <p class="text-sm text-white" x-text="importFile.name"></p>
                      <p class="text-xs text-gray-500 mt-1" x-text="'Exported: ' + (importPreview.exportedAt ? new Date(importPreview.exportedAt).toLocaleString() : 'unknown')"></p>
                    </div>
                  </template>
                </label>
              </div>

              <!-- Preview & mode -->
              <template x-if="importPreview.ready">
                <div>
                  <div class="grid grid-cols-3 gap-3 mb-4">
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">API Keys</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.apiKeys"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">GitHub Accounts</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.githubAccounts"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">Usage Records</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.usage"></p>
                    </div>
                  </div>

                  <!-- Mode selector -->
                  <div class="flex gap-3 mb-4">
                    <button @click="importMode = 'merge'"
                      class="flex-1 p-3 rounded-lg border text-left transition-all"
                      :class="importMode === 'merge' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'">
                      <p class="text-sm font-medium" :class="importMode === 'merge' ? 'text-accent-cyan' : 'text-white'">Merge</p>
                      <p class="text-xs text-gray-500 mt-0.5">Keep existing data, add/update imported records</p>
                    </button>
                    <button @click="importMode = 'replace'"
                      class="flex-1 p-3 rounded-lg border text-left transition-all"
                      :class="importMode === 'replace' ? 'border-red-400/50 bg-red-400/5' : 'border-white/10 hover:border-white/20'">
                      <p class="text-sm font-medium" :class="importMode === 'replace' ? 'text-red-400' : 'text-white'">Replace</p>
                      <p class="text-xs text-gray-500 mt-0.5">Wipe all existing data and restore from file</p>
                    </button>
                  </div>

                  <!-- Warning for replace mode -->
                  <template x-if="importMode === 'replace'">
                    <div class="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4">
                      <p class="text-sm text-red-400">This will permanently delete all existing data before importing. This cannot be undone.</p>
                    </div>
                  </template>

                  <!-- Import button -->
                  <button @click="doImport()" class="btn-primary" :disabled="importLoading"
                    :class="importMode === 'replace' ? 'bg-red-500/80 hover:bg-red-500' : ''">
                    <span x-show="!importLoading" class="flex items-center gap-2">
                      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      <span x-text="importMode === 'replace' ? 'Replace All Data' : 'Merge Data'"></span>
                    </span>
                    <span x-show="importLoading" class="flex items-center gap-2">
                      <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/></svg>
                      Importing...
                    </span>
                  </button>
                </div>
              </template>
            </div>

          </div>
          </template>

        </main>
      </div>

      <style>
        select option { background: #13181f; color: #e0e0e0; }
      </style>

      <script>
        function dashboardApp() {
          const isAdmin = localStorage.getItem('isAdmin') === '1';
          const TABS = isAdmin ? ['upstream', 'keys', 'usage', 'settings'] : ['usage'];
          const defaultTab = isAdmin ? 'upstream' : 'usage';
          const initTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;

          // Claude tier order: opus=0, sonnet=1, haiku=2
          const CLAUDE_TIER = { opus: 0, sonnet: 1, haiku: 2 };
          function claudeTier(id) {
            for (const t in CLAUDE_TIER) { if (id.includes(t)) return CLAUDE_TIER[t]; }
            return 99;
          }
          // Big model sort: opus first, within tier reverse alpha (larger version first)
          function sortClaudeBig(a, b) {
            const ta = claudeTier(a), tb = claudeTier(b);
            return ta !== tb ? ta - tb : b.localeCompare(a);
          }
          // Small model sort: haiku first, within tier reverse alpha
          function sortClaudeSmall(a, b) {
            const ta = claudeTier(a), tb = claudeTier(b);
            return ta !== tb ? tb - ta : b.localeCompare(a);
          }
          // Codex sort: non-mini first, within group reverse alpha
          function sortCodex(a, b) {
            const am = a.includes('mini') ? 1 : 0;
            const bm = b.includes('mini') ? 1 : 0;
            return am !== bm ? am - bm : b.localeCompare(a);
          }

          return {
            authKey: '',
            isAdmin,
            tab: initTab,

            // Upstream
            meLoaded: false,
            githubAccounts: [],
            githubConnected: false,
            usageData: null,
            usageError: false,
            usagePercent: 0,
            deviceFlow: { loading: false, userCode: null, verificationUri: null, deviceCode: null, pollTimer: null },

            // Keys
            keys: [],
            keysLoading: false,
            now: Date.now(),
            newKeyName: '',
            selectedKeyId: null,
            keyCreating: false,
            keyDeleting: null,
            keyRotating: null,
            copied: false,

            // Config — no defaults, populated by loadModels
            modelsLoaded: false,
            claudeModelsBig: [],
            claudeModelsSmall: [],
            claudeModel: '',
            claudeSmallModel: '',
            codexModels: [],
            codexModel: '',

            // Token usage
            tokenRange: 'today',
            tokenData: [],
            tokenChart: null,
            tokenLoading: false,
            tokenSummary: { requests: 0, input: 0, output: 0 },

            // Settings — import/export
            exportLoading: false,
            importFile: null,
            importData: null,
            importMode: 'merge',
            importLoading: false,
            importPreview: { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 },

            get baseUrl() { return location.origin; },

            get activeKey() {
              const sel = this.selectedKeyId && this.keys.find(k => k.id === this.selectedKeyId);
              if (sel) return sel.key;
              return this.isAdmin ? '<your-api-key>' : this.authKey;
            },

            truncateKey(key) {
              if (!key || key.length <= 12) return key;
              return key.slice(0, 4) + '\u2026' + key.slice(-4);
            },

            timeAgo(dateStr) {
              if (!dateStr) return null;
              const date = new Date(dateStr);
              const diff = this.now - date;
              const seconds = Math.floor(diff / 1000);
              if (seconds < 60) return 'just now';
              const minutes = Math.floor(seconds / 60);
              if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
              const hours = Math.floor(minutes / 60);
              if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
              const days = Math.floor(hours / 24);
              if (days <= 30) return days + (days === 1 ? ' day ago' : ' days ago');
              return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            },

            fullDateTime(dateStr) {
              if (!dateStr) return '';
              const d = new Date(dateStr);
              const p = n => String(n).padStart(2, '0');
              return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
                + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
            },

            claudeCodeSnippet() {
              const lines = [
                'export ANTHROPIC_BASE_URL=' + this.baseUrl,
                'export ANTHROPIC_AUTH_TOKEN=' + this.activeKey,
                'export ANTHROPIC_MODEL=' + this.claudeModel,
                'export ANTHROPIC_SMALL_FAST_MODEL=' + this.claudeSmallModel,
              ];
              return lines.join('\\n');
            },

            codexSnippet() {
              const lines = [
                'model = "' + this.codexModel + '"',
                'model_provider = "copilot_gateway"',
                '',
                '[model_providers.copilot_gateway]',
                'name = "Copilot Gateway"',
                'base_url = "' + this.baseUrl + '/"',
                'env_key = "COPILOT_GATEWAY_API_KEY"',
                'wire_api = "responses"',
              ];
              return lines.join('\\n');
            },

            codexEnvSnippet() {
              return 'export COPILOT_GATEWAY_API_KEY=' + this.activeKey;
            },

            init() {
              this.authKey = localStorage.getItem('authKey') || '';
              if (!this.authKey) { window.location.href = '/'; return; }

              this.loadModels();

              // Load data for initial tab
              if (this.tab === 'upstream' && this.isAdmin) {
                this.loadMe();
                this.loadUsage();
              } else if (this.tab === 'keys' && this.isAdmin) {
                this.loadKeys();
              } else if (this.tab === 'usage') {
                this.tokenLoading = true;
                this.fetchTokenData().then(() => {
                  if (this.tab === 'usage') {
                    this.$nextTick().then(() => this.renderTokenChart());
                  }
                });
              }

              setInterval(() => {
                if (this.tab === 'upstream' && this.isAdmin) this.loadUsage();
                if (this.tab === 'usage') this.loadTokenUsage();
              }, 60000);

              // Update "time ago" every 30s
              setInterval(() => { this.now = Date.now(); }, 30000);

              window.addEventListener('hashchange', () => {
                const h = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;
                if (this.tab !== h) this.switchTab(h);
              });
            },

            authHeaders() { return { 'x-api-key': this.authKey }; },

            async switchTab(t) {
              if (t !== 'usage' && this.tokenChart) {
                this.tokenChart.stop();
                this.tokenChart.destroy();
                this.tokenChart = null;
              }
              this.tab = t;
              location.hash = '#' + t;
              if (t === 'upstream' && this.isAdmin) {
                if (!this.meLoaded) this.loadMe();
                this.loadUsage();
              } else if (t === 'usage') {
                this.tokenLoading = true;
                await this.fetchTokenData();
                if (this.tab === 'usage') {
                  await this.$nextTick();
                  this.renderTokenChart();
                }
              } else if (t === 'keys') {
                await this.loadKeys();
              }
            },

            // ---- Models ----

            async loadModels() {
              try {
                const resp = await fetch('/api/models', { headers: this.authHeaders() });
                if (!resp.ok) return;
                const { data } = await resp.json();

                const claudeAll = data
                  .filter(m => m.id.startsWith('claude-') && m.supported_endpoints?.includes('/v1/messages'))
                  .map(m => m.id);

                this.claudeModelsBig = [...claudeAll].sort(sortClaudeBig);
                this.claudeModelsSmall = [...claudeAll].sort(sortClaudeSmall);
                this.claudeModel = this.claudeModelsBig[0] || '';
                this.claudeSmallModel = this.claudeModelsSmall[0] || '';

                this.codexModels = data
                  .filter(m => m.supported_endpoints?.includes('/responses'))
                  .map(m => m.id)
                  .sort(sortCodex);
                this.codexModel = this.codexModels[0] || '';

                this.modelsLoaded = true;
              } catch {}
            },

            // ---- Upstream ----

            async loadMe() {
              try {
                const resp = await fetch('/auth/me', { headers: this.authHeaders() });
                if (resp.status === 401) { this.kickToLogin(); return; }
                const data = await resp.json();
                this.githubConnected = data.github_connected;
                this.githubAccounts = data.accounts || [];
              } catch (e) { console.error('loadMe:', e); }
              finally { this.meLoaded = true; }
            },

            async loadUsage() {
              try {
                const resp = await fetch('/api/copilot-quota', { headers: this.authHeaders() });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (resp.ok) {
                  this.usageData = await resp.json();
                  const pi = this.usageData.quota_snapshots.premium_interactions;
                  this.usagePercent = pi.entitlement > 0
                    ? Math.round(((pi.entitlement - pi.remaining) / pi.entitlement) * 100) : 0;
                  this.usageError = false;
                } else { this.usageError = true; }
              } catch { this.usageError = true; }
            },

            formatDate(s) {
              return s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
            },

            async startGithubAuth() {
              this.deviceFlow.loading = true;
              try {
                const resp = await fetch('/auth/github', { headers: this.authHeaders() });
                if (resp.status === 401) { this.kickToLogin(); return; }
                const d = await resp.json();
                if (d.user_code) {
                  Object.assign(this.deviceFlow, { userCode: d.user_code, verificationUri: d.verification_uri, deviceCode: d.device_code });
                  this.pollDeviceFlow(d.interval || 5);
                }
              } catch (e) { console.error('startGithubAuth:', e); }
              finally { this.deviceFlow.loading = false; }
            },

            pollDeviceFlow(interval) {
              this.deviceFlow.pollTimer = setInterval(async () => {
                try {
                  const resp = await fetch('/auth/github/poll', {
                    method: 'POST',
                    headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ device_code: this.deviceFlow.deviceCode }),
                  });
                  if (resp.status === 401) { this.kickToLogin(); return; }
                  const d = await resp.json();
                  if (d.status === 'complete') {
                    this.cancelDeviceFlow();
                    await this.loadMe();
                    this.githubConnected = this.githubAccounts.length > 0;
                    await this.loadUsage();
                  } else if (d.status === 'slow_down') {
                    clearInterval(this.deviceFlow.pollTimer);
                    this.pollDeviceFlow((d.interval || interval) + 1);
                  } else if (d.status === 'error') {
                    this.cancelDeviceFlow();
                    alert('Authorization failed: ' + d.error);
                  }
                } catch (e) { console.error('poll:', e); }
              }, interval * 1000);
            },

            cancelDeviceFlow() {
              clearInterval(this.deviceFlow.pollTimer);
              Object.assign(this.deviceFlow, { pollTimer: null, userCode: null, verificationUri: null, deviceCode: null });
            },

            async disconnectGithub(userId, login) {
              if (!confirm('Disconnect @' + login + '? The stored token will be deleted.')) return;
              try {
                const resp = await fetch('/auth/github/' + userId, { method: 'DELETE', headers: this.authHeaders() });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (resp.ok) {
                  await this.loadMe();
                  this.githubConnected = this.githubAccounts.length > 0;
                  if (!this.githubConnected) {
                    this.usageData = null;
                    this.usageError = false;
                    this.usagePercent = 0;
                  } else {
                    await this.loadUsage();
                  }
                } else {
                  alert('Failed to disconnect GitHub account');
                }
              } catch (e) { console.error('disconnectGithub:', e); }
            },

            async switchGithubAccount(userId) {
              try {
                const resp = await fetch('/auth/github/switch', {
                  method: 'POST',
                  headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                  body: JSON.stringify({ user_id: userId }),
                });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (resp.ok) {
                  await this.loadMe();
                  await this.loadUsage();
                } else {
                  alert('Failed to switch account');
                }
              } catch (e) { console.error('switchGithubAccount:', e); }
            },

            // ---- Key management ----

            async loadKeys() {
              this.keysLoading = true;
              try {
                const resp = await fetch('/api/keys', { headers: this.authHeaders() });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (resp.ok) {
                  this.keys = await resp.json();
                  // Clear stale selection if key no longer exists
                  if (this.selectedKeyId && !this.keys.some(k => k.id === this.selectedKeyId)) {
                    this.selectedKeyId = null;
                  }
                }
              } catch (e) { console.error('loadKeys:', e); }
              finally { this.keysLoading = false; }
            },

            async createNewKey() {
              const name = this.newKeyName.trim();
              if (!name) return;
              this.keyCreating = true;
              try {
                const resp = await fetch('/api/keys', {
                  method: 'POST',
                  headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name }),
                });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (resp.ok) {
                  const created = await resp.json();
                  this.selectedKeyId = created.id;
                  this.newKeyName = '';
                  await this.loadKeys();
                } else {
                  alert((await resp.json()).error || 'Failed to create key');
                }
              } catch (e) { console.error('createKey:', e); }
              finally { this.keyCreating = false; }
            },

            async deleteKeyById(id, name) {
              if (!confirm('Delete key "' + name + '"? This cannot be undone.')) return;
              this.keyDeleting = id;
              try {
                const resp = await fetch('/api/keys/' + id, { method: 'DELETE', headers: this.authHeaders() });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (resp.ok) {
                  await this.loadKeys();
                } else {
                  alert((await resp.json()).error || 'Failed to delete key');
                }
              } catch (e) { console.error('deleteKey:', e); }
              finally { this.keyDeleting = null; }
            },

            async rotateKeyById(id, name) {
              if (!confirm('Rotate key "' + name + '"? The old key will stop working immediately.')) return;
              this.keyRotating = id;
              try {
                const resp = await fetch('/api/keys/' + id + '/rotate', { method: 'POST', headers: this.authHeaders() });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (resp.ok) {
                  this.selectedKeyId = id;
                  await this.loadKeys();
                } else {
                  alert((await resp.json()).error || 'Failed to rotate key');
                }
              } catch (e) { console.error('rotateKey:', e); }
              finally { this.keyRotating = null; }
            },

            async renameKeyById(id, currentName) {
              const newName = prompt('Rename key:', currentName);
              if (!newName || newName === currentName) return;
              try {
                const resp = await fetch('/api/keys/' + id, {
                  method: 'PATCH',
                  headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: newName }),
                });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (resp.ok) {
                  await this.loadKeys();
                } else {
                  alert((await resp.json()).error || 'Failed to rename key');
                }
              } catch (e) { console.error('renameKey:', e); }
            },

            async copySnippet(text, tag) {
              try { await navigator.clipboard.writeText(text); }
              catch {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
              }
              this.copied = tag;
              setTimeout(() => { this.copied = false; }, 2000);
            },

            // ---- Token usage ----

            localHourKey(d) {
              const p = n => String(n).padStart(2, '0');
              return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + 'T' + p(d.getHours());
            },
            localDateKey(d) {
              const p = n => String(n).padStart(2, '0');
              return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
            },

            async fetchTokenData() {
              this.tokenLoading = true;
              try {
                const now = new Date();
                const rangeStart = new Date(now);
                if (this.tokenRange === 'today') rangeStart.setHours(0,0,0,0);
                else if (this.tokenRange === '7d') { rangeStart.setDate(rangeStart.getDate()-6); rangeStart.setHours(0,0,0,0); }
                else { rangeStart.setDate(rangeStart.getDate()-29); rangeStart.setHours(0,0,0,0); }
                const start = rangeStart.toISOString().slice(0,13);
                const end = new Date(now.getTime()+3600000).toISOString().slice(0,13);
                const resp = await fetch('/api/token-usage?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end), { headers: this.authHeaders() });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (resp.ok) this.tokenData = await resp.json();
              } catch (e) { console.error('fetchTokenData:', e); }
              finally { this.tokenLoading = false; }
            },

            async loadTokenUsage() {
              await this.fetchTokenData();
              if (this.tab !== 'usage') return;
              await this.$nextTick();
              this.renderTokenChart();
            },

            renderTokenChart() {
              const canvas = document.getElementById('tokenChart');
              if (!canvas || canvas.clientWidth === 0) return;

              const palette = ['#00e5ff','#00e676','#ffd740','#ff5252','#7c4dff','#ff6e40','#64ffda','#eeff41','#40c4ff','#ea80fc'];
              const isDaily = this.tokenRange !== 'today';
              const data = this.tokenData;

              const keyNameMap = new Map();
              for (const r of data) keyNameMap.set(r.keyId, r.keyName);

              let totalReqs = 0, totalIn = 0, totalOut = 0;
              for (const r of data) { totalReqs += r.requests; totalIn += r.inputTokens; totalOut += r.outputTokens; }
              this.tokenSummary = { requests: totalReqs, input: totalIn, output: totalOut };

              const bucketMap = new Map();
              const now = new Date();
              if (this.tokenRange === 'today') {
                for (let h = 0; h < 24; h++) {
                  const d = new Date(now); d.setHours(h,0,0,0);
                  bucketMap.set(this.localHourKey(d), String(h).padStart(2,'0') + ':00 \\u2013 ' + String((h+1)%24).padStart(2,'0') + ':00');
                }
              } else {
                const days = this.tokenRange === '7d' ? 7 : 30;
                for (let i = days-1; i >= 0; i--) {
                  const d = new Date(now); d.setDate(d.getDate()-i); d.setHours(0,0,0,0);
                  bucketMap.set(this.localDateKey(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
                }
              }

              const keyIds = new Set();
              const agg = new Map();
              for (const [key] of bucketMap) agg.set(key, new Map());
              for (const r of data) {
                const utc = new Date(r.hour + ':00:00Z');
                const bucket = isDaily ? this.localDateKey(utc) : this.localHourKey(utc);
                if (!agg.has(bucket)) continue;
                keyIds.add(r.keyId);
                const m = agg.get(bucket);
                m.set(r.keyId, (m.get(r.keyId)||0) + r.inputTokens + r.outputTokens);
              }

              const keyList = [...keyIds].sort((a,b) => (keyNameMap.get(a)||a).localeCompare(keyNameMap.get(b)||b));
              const labels = [...bucketMap.values()];
              const bucketKeys = [...bucketMap.keys()];
              const datasets = keyList.map((keyId, i) => {
                const c = palette[i % palette.length];
                return {
                  label: keyNameMap.get(keyId) || keyId.slice(0,8),
                  data: bucketKeys.map(k => agg.get(k)?.get(keyId) || 0),
                  borderColor: c, backgroundColor: c + '18',
                  borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.3, fill: true,
                };
              });

              if (this.tokenChart) { this.tokenChart.stop(); this.tokenChart.destroy(); this.tokenChart = null; }

              this.tokenChart = new Chart(canvas, {
                type: 'line', data: { labels, datasets },
                options: {
                  responsive: true, maintainAspectRatio: false, animation: false,
                  interaction: { mode: 'index', intersect: false },
                  plugins: {
                    legend: { position: 'bottom', labels: { color: '#9e9e9e', font: { size: 11, family: "'DM Sans', sans-serif" }, boxWidth: 12, padding: 16, usePointStyle: true, pointStyle: 'circle' } },
                    tooltip: {
                      backgroundColor: 'rgba(12,16,21,0.95)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
                      titleColor: '#e0e0e0', bodyColor: '#b0bec5', padding: 12,
                      bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
                      callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() + ' tokens' }
                    }
                  },
                  scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#9e9e9e', font: { size: 10, family: "'DM Sans', sans-serif" }, maxRotation: 45 }, border: { color: 'rgba(255,255,255,0.06)' } },
                    y: {
                      beginAtZero: true, grid: { color: 'rgba(255,255,255,0.04)' },
                      ticks: { color: '#9e9e9e', font: { size: 10, family: "'JetBrains Mono', monospace" },
                        callback: v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v },
                      border: { color: 'rgba(255,255,255,0.06)' }
                    }
                  }
                }
              });
            },

            switchTokenRange(range) { this.tokenRange = range; this.loadTokenUsage(); },

            // ---- Settings: import/export ----

            async exportData() {
              this.exportLoading = true;
              try {
                const resp = await fetch('/api/export', { headers: this.authHeaders() });
                if (resp.status === 401) { this.kickToLogin(); return; }
                if (!resp.ok) { alert('Export failed: ' + (await resp.json()).error); return; }
                const data = await resp.json();
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'copilot-export-' + new Date().toISOString().slice(0,10) + '.json';
                a.click();
                URL.revokeObjectURL(url);
              } catch (e) { console.error('exportData:', e); alert('Export failed'); }
              finally { this.exportLoading = false; }
            },

            handleImportFile(event) {
              const file = event.target.files[0];
              if (!file) return;
              this.importFile = file;
              this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 };
              this.importData = null;

              const reader = new FileReader();
              reader.onload = (e) => {
                try {
                  const json = JSON.parse(e.target.result);
                  if (!json.data) { alert('Invalid export file: missing data field'); this.importFile = null; return; }
                  this.importData = json.data;
                  this.importPreview = {
                    ready: true,
                    exportedAt: json.exportedAt || null,
                    apiKeys: Array.isArray(json.data.apiKeys) ? json.data.apiKeys.length : 0,
                    githubAccounts: Array.isArray(json.data.githubAccounts) ? json.data.githubAccounts.length : 0,
                    usage: Array.isArray(json.data.usage) ? json.data.usage.length : 0,
                  };
                } catch { alert('Invalid JSON file'); this.importFile = null; }
              };
              reader.readAsText(file);
            },

            async doImport() {
              if (!this.importData) return;
              if (this.importMode === 'replace') {
                if (!confirm('This will DELETE ALL existing data and replace it with the imported file. Are you sure?')) return;
              }
              this.importLoading = true;
              try {
                const resp = await fetch('/api/import', {
                  method: 'POST',
                  headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                  body: JSON.stringify({ mode: this.importMode, data: this.importData }),
                });
                if (resp.status === 401) { this.kickToLogin(); return; }
                const result = await resp.json();
                if (resp.ok) {
                  alert('Import complete: ' + result.imported.apiKeys + ' keys, ' + result.imported.githubAccounts + ' accounts, ' + result.imported.usage + ' usage records');
                  this.importFile = null;
                  this.importData = null;
                  this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 };
                } else {
                  alert('Import failed: ' + (result.error || 'Unknown error'));
                }
              } catch (e) { console.error('doImport:', e); alert('Import failed'); }
              finally { this.importLoading = false; }
            },

            // ---- Common ----
            logout() { localStorage.removeItem('authKey'); localStorage.removeItem('isAdmin'); localStorage.removeItem('login_key_id'); localStorage.removeItem('login_key_name'); localStorage.removeItem('login_key_hint'); window.location.href = '/'; },
            kickToLogin() { this.logout(); }
          }
        }
      </script>`,
  });
}
