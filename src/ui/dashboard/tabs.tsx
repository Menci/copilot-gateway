import { html } from "hono/html";

function spinner(cls: string) {
  return html`<svg class="animate-spin ${cls}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"/><path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75"/></svg>`;
}

function codeBlock(
  lang: string,
  ref: string,
  snippetFn: string,
  copyId: string,
) {
  return html`
    <div class="relative group">
      <pre
        class="bg-surface-900 rounded-xl p-4 pr-10 overflow-x-auto border border-white/[0.04]"
      ><code class="language-${lang}" x-ref="${ref}" x-effect="$el.textContent = ${snippetFn}(); Prism.highlightElement($el)"></code></pre>
      <button
        @click="copySnippet(${snippetFn}(), '${copyId}')"
        class="absolute top-2.5 right-2.5 p-1.5 rounded-md bg-surface-700/80 text-gray-500 hover:text-accent-cyan hover:bg-surface-600 transition-all opacity-0 group-hover:opacity-100"
        :title="copied === '${copyId}' ? 'Copied!' : 'Copy'"
      >
        <svg
          x-show="copied !== '${copyId}'"
          class="w-3.5 h-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <svg
          x-show="copied === '${copyId}'"
          class="w-3.5 h-3.5 text-accent-emerald"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    </div>
  `;
}

export function renderDashboardHeader() {
  return html`
    <header
      class="border-b border-white/5 bg-surface-900/80 backdrop-blur-md sticky top-0 z-50"
    >
      <div class="max-w-6xl mx-auto px-6 py-3 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div class="flex items-center gap-3">
          <div
            class="w-8 h-8 rounded-lg bg-surface-700 glow-border flex items-center justify-center"
          >
            <svg
              class="w-4 h-4 text-accent-cyan"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span class="font-semibold text-white text-sm tracking-tight"
          >Copilot Gateway</span>
        </div>

        <nav class="flex gap-1 bg-surface-800 rounded-lg p-0.5 w-fit">
          <template x-if="isAdmin">
            <button
              @click="switchTab('upstream')"
              class="px-4 py-2 rounded-md text-sm font-medium transition-all"
              :class="tab === 'upstream' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              Upstream
            </button>
          </template>
          <button
            @click="switchTab('keys')"
            class="px-4 py-2 rounded-md text-sm font-medium transition-all"
            :class="tab === 'keys' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            API Keys
          </button>
          <button
            @click="switchTab('usage')"
            class="px-4 py-2 rounded-md text-sm font-medium transition-all"
            :class="tab === 'usage' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            Usage
          </button>
          <template x-if="isAdmin">
            <button
              @click="switchTab('settings')"
              class="px-4 py-2 rounded-md text-sm font-medium transition-all"
              :class="tab === 'settings' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              Settings
            </button>
          </template>
        </nav>

        <button @click="logout()" class="btn-ghost text-xs ml-auto">Logout</button>
      </div>
    </header>
  `;
}

export function renderUpstreamTab() {
  return html`
    <template x-if="isAdmin">
      <div
        x-show="tab === 'upstream'"
        x-transition:enter="transition ease-out duration-200"
        x-transition:enter-start="opacity-0"
        x-transition:enter-end="opacity-100"
      >
        <template x-if="meLoaded && githubAccounts.length === 0">
          <div
            class="glass-card p-6 mb-8 glow-border animate-in flex items-center justify-between"
          >
            <div>
              <h3 class="text-white font-medium mb-1">Connect GitHub Account</h3>
              <p class="text-sm text-gray-400">
                Link your GitHub account to use Copilot API with your own token.
              </p>
            </div>
            <button
              @click="startGithubAuth()"
              class="btn-primary"
              :disabled="deviceFlow.loading"
            >
              <span x-show="!deviceFlow.loading">Connect GitHub</span>
              <span x-show="deviceFlow.loading" class="flex items-center gap-2">
                ${spinner("h-4 w-4")}
                Connecting…
              </span>
            </button>
          </div>
        </template>

        <template x-if="deviceFlow.userCode">
          <div
            class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in"
          >
            <div class="glass-card p-8 max-w-md w-full mx-4 glow-cyan">
              <h3 class="text-white text-lg font-semibold mb-2">
                GitHub Authorization
              </h3>
              <p class="text-gray-400 text-sm mb-6">
                Enter this code on GitHub to authorize:
              </p>

              <div
                class="bg-surface-900 rounded-xl p-6 text-center mb-6 glow-border"
              >
                <code
                  class="text-3xl font-mono font-bold text-accent-cyan tracking-[0.3em]"
                  x-text="deviceFlow.userCode"
                ></code>
              </div>

              <p class="text-gray-500 text-xs text-center mb-2">
                Visit <a
                  :href="deviceFlow.verificationUri"
                  class="text-accent-cyan hover:underline"
                  x-text="deviceFlow.verificationUri"
                  target="_blank"
                ></a>
              </p>
              <a
                :href="deviceFlow.verificationUri"
                target="_blank"
                class="btn-primary w-full block text-center mb-4"
              >
                Open GitHub
              </a>

              <div
                class="flex items-center justify-center gap-2 text-sm text-gray-500"
              >
                ${spinner("h-4 w-4")}
                Waiting for authorization...
              </div>

              <button @click="cancelDeviceFlow()" class="btn-ghost w-full mt-4">
                Cancel
              </button>
            </div>
          </div>
        </template>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          <div class="glass-card p-6 hover-lift animate-in delay-1">
            <div class="flex items-center justify-between mb-4">
              <span
                class="text-xs font-medium text-gray-500 uppercase tracking-widest"
              >Premium Requests</span>
              <div
                class="w-2 h-2 rounded-full status-pulse"
                :class="usageData ? (usagePercent > 90 ? 'bg-accent-rose' : usagePercent > 70 ? 'bg-accent-amber' : 'bg-accent-emerald') : 'bg-gray-600'"
              >
              </div>
            </div>
            <template x-if="usageData">
              <div>
                <div class="flex items-baseline gap-2 mb-3">
                  <span
                    class="text-3xl font-bold text-white font-mono"
                    x-text="usageData.quota_snapshots.premium_interactions.entitlement - usageData.quota_snapshots.premium_interactions.remaining"
                  ></span>
                  <span class="text-sm text-gray-500">/ <span
                    x-text="usageData.quota_snapshots.premium_interactions.entitlement"
                  ></span></span>
                </div>
                <div class="progress-track">
                  <div
                    class="progress-fill"
                    :class="usagePercent > 90 ? 'bg-accent-rose' : usagePercent > 70 ? 'bg-gradient-to-r from-accent-amber to-accent-rose' : 'bg-gradient-to-r from-accent-cyan to-accent-emerald'"
                    :style="'width:' + usagePercent + '%'"
                  >
                  </div>
                </div>
                <p class="text-xs text-gray-500 mt-2">
                  <span
                    x-text="usageData.quota_snapshots.premium_interactions.remaining"
                  ></span> remaining · Resets <span
                    x-text="formatDate(usageData.quota_reset_date)"
                  ></span>
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

          <div class="glass-card p-6 hover-lift animate-in delay-2">
            <div class="flex items-center justify-between mb-4">
              <span
                class="text-xs font-medium text-gray-500 uppercase tracking-widest"
              >Chat Quota</span>
              <svg
                class="w-4 h-4 text-gray-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
                />
              </svg>
            </div>
            <template x-if="usageData">
              <div>
                <div class="flex items-baseline gap-2 mb-1">
                  <span
                    class="text-2xl font-bold text-white font-mono"
                    x-text="usageData.quota_snapshots.chat.unlimited ? '\\u221e' : usageData.quota_snapshots.chat.remaining"
                  ></span>
                  <span
                    class="text-xs text-gray-500"
                    x-show="!usageData.quota_snapshots.chat.unlimited"
                  >remaining</span>
                  <span
                    class="text-xs text-accent-emerald"
                    x-show="usageData.quota_snapshots.chat.unlimited"
                  >unlimited</span>
                </div>
                <p class="text-xs text-gray-500">
                  Plan: <span
                    class="text-gray-300"
                    x-text="usageData.copilot_plan"
                  ></span>
                </p>
              </div>
            </template>
            <template x-if="!usageData">
              <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
            </template>
          </div>

          <div class="glass-card p-6 hover-lift animate-in delay-3">
            <div class="flex items-center justify-between mb-4">
              <span
                class="text-xs font-medium text-gray-500 uppercase tracking-widest"
              >Completions</span>
              <svg
                class="w-4 h-4 text-gray-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
            </div>
            <template x-if="usageData">
              <div>
                <div class="flex items-baseline gap-2 mb-1">
                  <span
                    class="text-2xl font-bold text-white font-mono"
                    x-text="usageData.quota_snapshots.completions.unlimited ? '\\u221e' : usageData.quota_snapshots.completions.remaining"
                  ></span>
                  <span
                    class="text-xs text-gray-500"
                    x-show="!usageData.quota_snapshots.completions.unlimited"
                  >remaining</span>
                  <span
                    class="text-xs text-accent-emerald"
                    x-show="usageData.quota_snapshots.completions.unlimited"
                  >unlimited</span>
                </div>
                <p class="text-xs text-gray-500">Code completions</p>
              </div>
            </template>
            <template x-if="!usageData">
              <div class="h-8 bg-surface-600 rounded animate-pulse"></div>
            </template>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div class="glass-card p-6 animate-in delay-4">
            <div class="flex items-center justify-between mb-4">
              <h3
                class="text-xs font-medium text-gray-500 uppercase tracking-widest"
              >
                GitHub Accounts
              </h3>
              <template x-if="meLoaded && githubAccounts.length > 0">
                <button
                  @click="startGithubAuth()"
                  class="btn-ghost text-xs"
                  :disabled="deviceFlow.loading"
                >
                  <span x-show="!deviceFlow.loading">+ Add</span>
                  <span
                    x-show="deviceFlow.loading"
                    class="flex items-center gap-1.5"
                  >
                    ${spinner("h-3 w-3")}
                    Adding…
                  </span>
                </button>
              </template>
            </div>
            <template x-if="!meLoaded">
              <div class="space-y-3">
                <div class="flex items-center gap-3">
                  <div
                    class="w-9 h-9 rounded-lg bg-surface-600 animate-pulse shrink-0"
                  >
                  </div>
                  <div class="space-y-1.5 flex-1">
                    <div class="h-4 w-28 bg-surface-600 rounded animate-pulse">
                    </div>
                    <div class="h-3 w-20 bg-surface-600 rounded animate-pulse">
                    </div>
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
                  <div
                    @click="!acct.active && switchGithubAccount(acct.id)"
                    class="flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors"
                    :class="acct.active ? 'bg-accent-cyan/5 border border-accent-cyan/15' : 'hover:bg-white/[0.03] cursor-pointer border border-transparent'"
                  >
                    <div class="flex items-center gap-3">
                      <div class="relative">
                        <img
                          :src="acct.avatar_url"
                          class="w-9 h-9 rounded-lg ring-1 ring-white/5"
                        />
                        <div
                          x-show="acct.active"
                          class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-accent-emerald ring-2 ring-surface-800"
                        >
                        </div>
                      </div>
                      <div>
                        <p
                          class="text-sm text-white font-medium"
                          x-text="acct.name || acct.login"
                        >
                        </p>
                        <p class="text-xs text-gray-500" x-text="'@' + acct.login">
                        </p>
                      </div>
                    </div>
                    <div class="flex items-center gap-2">
                      <span
                        x-show="acct.active"
                        class="text-[10px] font-medium text-accent-emerald uppercase tracking-widest"
                      >Active</span>
                      <button
                        @click.stop="disconnectGithub(acct.id, acct.login)"
                        class="text-gray-600 hover:text-accent-rose transition-colors p-1"
                        title="Disconnect"
                      >
                        <svg
                          class="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </template>
              </div>
            </template>
          </div>

          <div class="glass-card p-6 animate-in delay-5">
            <h3
              class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4"
            >
              API Endpoints
            </h3>
            <div class="space-y-3 font-mono text-xs">
              <div class="flex items-center gap-2">
                <span
                  class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold"
                >POST</span>
                <span class="text-gray-300">/v1/chat/completions</span>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold"
                >POST</span>
                <span class="text-gray-300">/v1/messages</span>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold"
                >POST</span>
                <span class="text-gray-300">/v1/responses</span>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="px-2 py-0.5 rounded bg-accent-emerald/10 text-accent-emerald text-[10px] font-bold"
                >POST</span>
                <span class="text-gray-300">/v1/embeddings</span>
              </div>
              <div class="flex items-center gap-2">
                <span
                  class="px-2 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan text-[10px] font-bold"
                >GET</span>
                <span class="text-gray-300">/v1/models</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  `;
}

export function renderKeysTab() {
  return html`
    <div x-show="tab === 'keys'">
      <div class="glass-card p-6 mb-6 animate-in">
        <div class="flex items-center justify-between mb-6">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest"
          >API Keys</span>
          <div x-show="isAdmin" class="flex items-center gap-2">
            <input
              type="text"
              x-model="newKeyName"
              placeholder="Name"
              class="!text-xs !py-1.5 !px-3 !w-32 !rounded-lg"
              @keydown.enter="createNewKey()"
            />
            <button
              @click="createNewKey()"
              class="btn-primary !text-xs !py-1.5 !px-3 !rounded-lg whitespace-nowrap"
              :disabled="!newKeyName.trim() || keyCreating"
            >
              <span x-show="!keyCreating">+ Create</span>
              <span x-show="keyCreating" class="flex items-center gap-1.5">
                ${spinner("h-3 w-3")}
                Creating…
              </span>
            </button>
          </div>
        </div>

        <div class="overflow-x-auto">
          <template x-if="keys.length === 0 && !keysLoading">
            <p class="text-sm text-gray-500 py-4 text-center">
              No API keys yet. Create one above.
            </p>
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
                  <th
                    class="text-left py-2 pr-4 pl-7 text-xs font-medium text-gray-500 uppercase tracking-widest"
                  >
                    Name
                  </th>
                  <th
                    class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest"
                  >
                    Key
                  </th>
                  <th
                    class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest"
                  >
                    Created
                  </th>
                  <th
                    class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest"
                  >
                    Last Used
                  </th>
                  <th
                    x-show="isAdmin"
                    class="text-right py-2 pr-2 text-xs font-medium text-gray-500 uppercase tracking-widest"
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                <template x-for="k in keys" :key="k.id">
                  <tr
                    @click="selectedKeyId = k.id"
                    class="border-b border-white/[0.03] transition-colors cursor-pointer"
                    :class="selectedKeyId === k.id ? 'bg-accent-cyan/5 hover:bg-accent-cyan/8' : 'hover:bg-white/[0.02]'"
                  >
                    <td class="py-3 pr-4 pl-2">
                      <div class="flex items-center gap-2">
                        <div
                          class="w-1.5 h-1.5 rounded-full shrink-0 transition-colors"
                          :class="selectedKeyId === k.id ? 'bg-accent-cyan' : 'bg-transparent'"
                        >
                        </div>
                        <span class="text-white font-medium" x-text="k.name"></span>
                      </div>
                    </td>
                    <td class="py-3 pr-4">
                      <code
                        class="text-xs font-mono text-gray-500 bg-surface-800 rounded px-2 py-1"
                        x-text="truncateKey(k.key)"
                      ></code>
                    </td>
                    <td class="py-3 pr-4">
                      <span
                        class="text-gray-500 text-xs cursor-default"
                        :title="fullDateTime(k.created_at)"
                        x-text="timeAgo(k.created_at)"
                      ></span>
                    </td>
                    <td class="py-3 pr-4">
                      <span
                        x-show="k.last_used_at"
                        class="text-gray-500 text-xs cursor-default"
                        :title="fullDateTime(k.last_used_at)"
                        x-text="timeAgo(k.last_used_at)"
                      ></span>
                      <span x-show="!k.last_used_at" class="text-gray-600 text-xs"
                      >Never</span>
                    </td>
                    <td class="py-3 pr-2 text-right">
                      <div class="flex items-center justify-end gap-1">
                        <button
                          @click.stop="copySnippet(k.key, 'key-' + k.id)"
                          class="text-gray-600 hover:text-accent-cyan transition-colors p-1"
                          title="Copy key"
                        >
                          <svg
                            x-show="copied !== 'key-' + k.id"
                            class="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                          >
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path
                              d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                            />
                          </svg>
                          <svg
                            x-show="copied === 'key-' + k.id"
                            class="w-4 h-4 text-accent-emerald"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                        <template x-if="isAdmin">
                          <button
                            @click.stop="renameKeyById(k.id, k.name)"
                            class="text-gray-600 hover:text-accent-violet transition-colors p-1"
                            title="Rename key"
                          >
                            <svg
                              class="w-4 h-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                            >
                              <path
                                d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"
                              />
                              <path d="m15 5 4 4" />
                            </svg>
                          </button>
                        </template>
                        <template x-if="isAdmin">
                          <button
                            @click.stop="rotateKeyById(k.id, k.name)"
                            class="text-gray-600 hover:text-accent-amber transition-colors p-1"
                            :disabled="keyRotating === k.id"
                            title="Rotate key"
                          >
                            <svg
                              class="w-4 h-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                            >
                              <path d="M21.5 2v6h-6" />
                              <path d="M2.5 22v-6h6" />
                              <path d="M2.5 12a10 10 0 0 1 16.5-5.7L21.5 8" />
                              <path d="M21.5 12a10 10 0 0 1-16.5 5.7L2.5 16" />
                            </svg>
                          </button>
                        </template>
                        <template x-if="isAdmin">
                          <button
                            @click.stop="deleteKeyById(k.id, k.name)"
                            class="text-gray-600 hover:text-accent-rose transition-colors p-1"
                            :disabled="keyDeleting === k.id"
                            title="Delete key"
                          >
                            <svg
                              class="w-4 h-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                            >
                              <polyline points="3 6 5 6 21 6" />
                              <path
                                d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
                              />
                            </svg>
                          </button>
                        </template>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </template>
        </div>
      </div>

      <div class="glass-card p-6 animate-in delay-1">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest"
        >Configuration</span>
        <template x-if="selectedKeyId">
          <p class="text-xs text-accent-cyan mt-2 flex items-center gap-1.5">
            <svg
              class="w-3.5 h-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            Configs below use the selected key.
          </p>
        </template>

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
            <div>
              <div class="mb-3">
                <span class="text-sm font-semibold text-white">Claude Code</span>
              </div>

              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div class="flex items-center gap-2">
                  <label class="text-xs text-gray-500">Model:</label>
                  <select
                    x-model="claudeModel"
                    class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                  >
                    <template x-for="m in claudeModelsBig" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
                <div class="flex items-center gap-2">
                  <label class="text-xs text-gray-500">Sonnet:</label>
                  <select
                    x-model="claudeSonnetModel"
                    class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                  >
                    <template x-for="m in claudeModelsSonnet" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
                <div class="flex items-center gap-2">
                  <label class="text-xs text-gray-500">Haiku:</label>
                  <select
                    x-model="claudeSmallModel"
                    class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                  >
                    <template x-for="m in claudeModelsSmall" :key="m">
                      <option :value="m" x-text="m"></option>
                    </template>
                  </select>
                </div>
              </div>

              <p class="text-[11px] text-gray-600 mb-2">
                Add to <code class="text-gray-500">~/.bashrc</code>, <code
                  class="text-gray-500"
                >~/.zshrc</code>, or equivalent
              </p>
              ${codeBlock("bash", "claudeCode", "claudeCodeSnippet", "claude")}
            </div>

            <div>
              <div class="mb-3">
                <span class="text-sm font-semibold text-white">Codex</span>
              </div>

              <div class="flex items-center gap-2 mb-3">
                <label class="text-xs text-gray-500">Model:</label>
                <select
                  x-model="codexModel"
                  class="text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                >
                  <template x-for="m in codexModels" :key="m">
                    <option :value="m" x-text="m"></option>
                  </template>
                </select>
              </div>

              <p class="text-[11px] text-gray-600 mb-2">
                Add to <code class="text-gray-500">~/.codex/config.toml</code>
              </p>
              ${codeBlock("toml", "codexCode", "codexSnippet", "codex")}

              <p class="text-[11px] text-gray-600 mt-4 mb-2">
                Add to <code class="text-gray-500">~/.bashrc</code>, <code
                  class="text-gray-500"
                >~/.zshrc</code>, or equivalent
              </p>
              ${codeBlock("bash", "codexEnv", "codexEnvSnippet", "codexEnv")}
            </div>
          </div>
        </template>
      </div>
    </div>
  `;
}

export function renderUsageTab() {
  return html`
    <div x-show="tab === 'usage'">
      <div class="glass-card p-6 animate-in">
        <div
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6"
        >
          <div class="flex items-center gap-3">
            <span
              class="text-xs font-medium text-gray-500 uppercase tracking-widest"
            >Token Usage — By Key</span>
            <button
              @click="toggleRedactKeys()"
              class="p-1 rounded transition-colors text-gray-600 hover:text-gray-400"
              title="Redact key names"
            >
              <svg x-show="!redactKeys" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg x-show="redactKeys" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            </button>
            <template x-if="tokenLoading">
              ${spinner("h-3.5 w-3.5 text-gray-500")}
            </template>
          </div>
          <div class="flex items-center gap-1 bg-surface-800 rounded-lg p-0.5">
            <button
              @click="switchTokenRange('today')"
              class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === 'today' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              Last Day
            </button>
            <button
              @click="switchTokenRange('7d')"
              class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === '7d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              7 Days
            </button>
            <button
              @click="switchTokenRange('30d')"
              class="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === '30d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              30 Days
            </button>
          </div>
        </div>

        <div style="height: 320px; position: relative;">
          <template x-if="tokenLoading && !chartsReady">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="flex flex-col items-center gap-3">
                ${spinner("h-6 w-6 text-accent-cyan/60")}
                <span class="text-xs text-gray-500">Loading usage data…</span>
              </div>
            </div>
          </template>
          <canvas id="tokenChartByKey"></canvas>
        </div>

        <div class="mt-6 pt-5 border-t border-white/5">
          <span
            class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4 block"
          >By Model</span>
          <div style="height: 320px; position: relative;">
            <template x-if="tokenLoading && !chartsReady">
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="flex flex-col items-center gap-3">
                  ${spinner("h-6 w-6 text-accent-cyan/60")}
                  <span class="text-xs text-gray-500">Loading usage data…</span>
                </div>
              </div>
            </template>
            <canvas id="tokenChartByModel"></canvas>
          </div>
        </div>

        <div class="grid grid-cols-3 gap-4 mt-6 pt-5 border-t border-white/5">
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Requests</p>
            <template x-if="tokenLoading && !chartsReady">
              <div class="h-7 w-16 mx-auto bg-surface-600 rounded animate-pulse">
              </div>
            </template>
            <template x-if="!tokenLoading || chartsReady">
              <p
                class="text-lg font-bold font-mono text-white"
                x-text="tokenSummary.requests.toLocaleString()"
              >
              </p>
            </template>
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Input Tokens</p>
            <template x-if="tokenLoading && !chartsReady">
              <div class="h-7 w-20 mx-auto bg-surface-600 rounded animate-pulse">
              </div>
            </template>
            <template x-if="!tokenLoading || chartsReady">
              <p
                class="text-lg font-bold font-mono text-white"
                x-text="tokenSummary.input.toLocaleString()"
              >
              </p>
            </template>
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Output Tokens</p>
            <template x-if="tokenLoading && !chartsReady">
              <div class="h-7 w-20 mx-auto bg-surface-600 rounded animate-pulse">
              </div>
            </template>
            <template x-if="!tokenLoading || chartsReady">
              <p
                class="text-lg font-bold font-mono text-white"
                x-text="tokenSummary.output.toLocaleString()"
              >
              </p>
            </template>
          </div>
        </div>

        <div class="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-white/5">
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Cache Read</p>
            <template x-if="tokenLoading && !chartsReady">
              <div class="h-7 w-20 mx-auto bg-surface-600 rounded animate-pulse">
              </div>
            </template>
            <template x-if="!tokenLoading || chartsReady">
              <p
                class="text-lg font-bold font-mono text-white"
                x-text="tokenSummary.cacheRead.toLocaleString()"
              >
              </p>
            </template>
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Cache Write</p>
            <template x-if="tokenLoading && !chartsReady">
              <div class="h-7 w-20 mx-auto bg-surface-600 rounded animate-pulse">
              </div>
            </template>
            <template x-if="!tokenLoading || chartsReady">
              <p
                class="text-lg font-bold font-mono text-white"
                x-text="tokenSummary.cacheCreation.toLocaleString()"
              >
              </p>
            </template>
          </div>
          <div class="text-center">
            <p class="text-xs text-gray-500 mb-1">Cache Hit Rate</p>
            <template x-if="tokenLoading && !chartsReady">
              <div class="h-7 w-16 mx-auto bg-surface-600 rounded animate-pulse">
              </div>
            </template>
            <template x-if="!tokenLoading || chartsReady">
              <p
                class="text-lg font-bold font-mono text-green-400"
                x-text="(tokenSummary.cacheRead + tokenSummary.cacheCreation) > 0 ? ((tokenSummary.cacheRead / (tokenSummary.cacheRead + tokenSummary.cacheCreation)) * 100).toFixed(1) + '%' : '\u2014'"
              >
              </p>
            </template>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderSettingsTab() {
  return html`
    <template x-if="isAdmin">
      <div
        x-show="tab === 'settings'"
        x-transition:enter="transition ease-out duration-200"
        x-transition:enter-start="opacity-0"
        x-transition:enter-end="opacity-100"
      >
        <div class="glass-card p-6 mb-6 animate-in">
          <h3 class="text-white font-semibold mb-1">Export Data</h3>
          <p class="text-sm text-gray-400 mb-4">
            Download all API keys, GitHub accounts, and usage data as a JSON file.
          </p>
          <button
            @click="exportData()"
            class="btn-primary"
            :disabled="exportLoading"
          >
            <span x-show="!exportLoading" class="flex items-center gap-2">
              <svg
                class="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Export JSON
            </span>
            <span x-show="exportLoading" class="flex items-center gap-2">
              ${spinner("h-4 w-4")}
              Exporting...
            </span>
          </button>
        </div>

        <div class="glass-card p-6 animate-in">
          <h3 class="text-white font-semibold mb-1">Import Data</h3>
          <p class="text-sm text-gray-400 mb-4">
            Restore data from a previously exported JSON file.
          </p>

          <div class="mb-4">
            <label
              class="block w-full cursor-pointer border-2 border-dashed border-white/10 hover:border-accent-cyan/30 rounded-xl p-8 text-center transition-colors"
              :class="importFile ? 'border-accent-cyan/40 bg-accent-cyan/5' : ''"
            >
              <input
                type="file"
                accept=".json"
                class="hidden"
                @change="handleImportFile($event)"
              >
              <template x-if="!importFile">
                <div>
                  <svg
                    class="w-8 h-8 mx-auto mb-2 text-gray-500"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p class="text-sm text-gray-400">
                    Click to select a JSON export file
                  </p>
                </div>
              </template>
              <template x-if="importFile">
                <div>
                  <svg
                    class="w-8 h-8 mx-auto mb-2 text-accent-cyan"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path
                      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                    />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <p class="text-sm text-white" x-text="importFile.name"></p>
                  <p
                    class="text-xs text-gray-500 mt-1"
                    x-text="'Exported: ' + (importPreview.exportedAt ? new Date(importPreview.exportedAt).toLocaleString() : 'unknown')"
                  >
                  </p>
                </div>
              </template>
            </label>
          </div>

          <template x-if="importPreview.ready">
            <div>
              <div class="grid grid-cols-3 gap-3 mb-4">
                <div class="bg-surface-800 rounded-lg p-3 text-center">
                  <p class="text-xs text-gray-500 mb-1">API Keys</p>
                  <p
                    class="text-lg font-bold font-mono text-white"
                    x-text="importPreview.apiKeys"
                  >
                  </p>
                </div>
                <div class="bg-surface-800 rounded-lg p-3 text-center">
                  <p class="text-xs text-gray-500 mb-1">GitHub Accounts</p>
                  <p
                    class="text-lg font-bold font-mono text-white"
                    x-text="importPreview.githubAccounts"
                  >
                  </p>
                </div>
                <div class="bg-surface-800 rounded-lg p-3 text-center">
                  <p class="text-xs text-gray-500 mb-1">Usage Records</p>
                  <p
                    class="text-lg font-bold font-mono text-white"
                    x-text="importPreview.usage"
                  >
                  </p>
                </div>
              </div>

              <div class="flex gap-3 mb-4">
                <button
                  @click="importMode = 'merge'"
                  class="flex-1 p-3 rounded-lg border text-left transition-all"
                  :class="importMode === 'merge' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
                >
                  <p
                    class="text-sm font-medium"
                    :class="importMode === 'merge' ? 'text-accent-cyan' : 'text-white'"
                  >
                    Merge
                  </p>
                  <p class="text-xs text-gray-500 mt-0.5">
                    Keep existing data, add/update imported records
                  </p>
                </button>
                <button
                  @click="importMode = 'replace'"
                  class="flex-1 p-3 rounded-lg border text-left transition-all"
                  :class="importMode === 'replace' ? 'border-red-400/50 bg-red-400/5' : 'border-white/10 hover:border-white/20'"
                >
                  <p
                    class="text-sm font-medium"
                    :class="importMode === 'replace' ? 'text-red-400' : 'text-white'"
                  >
                    Replace
                  </p>
                  <p class="text-xs text-gray-500 mt-0.5">
                    Wipe all existing data and restore from file
                  </p>
                </button>
              </div>

              <template x-if="importMode === 'replace'">
                <div
                  class="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4"
                >
                  <p class="text-sm text-red-400">
                    This will permanently delete all existing data before importing.
                    This cannot be undone.
                  </p>
                </div>
              </template>

              <button
                @click="doImport()"
                class="btn-primary"
                :disabled="importLoading"
                :class="importMode === 'replace' ? 'bg-red-500/80 hover:bg-red-500' : ''"
              >
                <span x-show="!importLoading" class="flex items-center gap-2">
                  <svg
                    class="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span
                    x-text="importMode === 'replace' ? 'Replace All Data' : 'Merge Data'"
                  ></span>
                </span>
                <span x-show="importLoading" class="flex items-center gap-2">
                  ${spinner("h-4 w-4")}
                  Importing...
                </span>
              </button>
            </div>
          </template>
        </div>
      </div>
    </template>
  `;
}
