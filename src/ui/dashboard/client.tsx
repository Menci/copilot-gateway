import { html } from "hono/html";

export function dashboardAssets() {
  return html`
    <style>
    select option { background: #13181f; color: #e0e0e0; }
    </style>

    <script>
    function dashboardApp() {
    const isAdmin = localStorage.getItem('isAdmin') === '1';
    const TABS = isAdmin ? ['upstream', 'keys', 'usage', 'settings'] : ['keys', 'usage'];
    const defaultTab = isAdmin ? 'upstream' : 'keys';
    const initTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;

    const CLAUDE_TIER = { opus: 0, sonnet: 1, haiku: 2 };

    function claudeTier(id) {
      for (const t in CLAUDE_TIER) {
        if (id.includes(t)) return CLAUDE_TIER[t];
      }
      return 99;
    }

    function sortClaudeBig(a, b) {
      const ta = claudeTier(a);
      const tb = claudeTier(b);
      return ta !== tb ? ta - tb : b.localeCompare(a);
    }

    function sortClaudeSmall(a, b) {
      const ta = claudeTier(a);
      const tb = claudeTier(b);
      return ta !== tb ? tb - ta : b.localeCompare(a);
    }

    function sortClaudeSonnet(a, b) {
      const da = Math.abs(claudeTier(a) - CLAUDE_TIER.sonnet);
      const db = Math.abs(claudeTier(b) - CLAUDE_TIER.sonnet);
      return da !== db ? da - db : b.localeCompare(a);
    }

    function sortCodex(a, b) {
      const am = a.includes('mini') ? 1 : 0;
      const bm = b.includes('mini') ? 1 : 0;
      return am !== bm ? am - bm : b.localeCompare(a);
    }

    return {
      authKey: '',
      isAdmin,
      tab: initTab,
      meLoaded: false,
      githubAccounts: [],
      githubConnected: false,
      usageData: null,
      usageError: false,
      usagePercent: 0,
      deviceFlow: { loading: false, userCode: null, verificationUri: null, deviceCode: null, pollTimer: null },
      keys: [],
      keysLoading: false,
      now: Date.now(),
      newKeyName: '',
      selectedKeyId: null,
      keyCreating: false,
      keyDeleting: null,
      keyRotating: null,
      copied: false,
      modelsLoaded: false,
      claudeModelsBig: [],
      claudeModelsSonnet: [],
      claudeModelsSmall: [],
      claudeContextMap: {},
      claudeModel: '',
      claudeSonnetModel: '',
      claudeSmallModel: '',
      codexModels: [],
      codexModel: '',
      tokenRange: 'today',
      tokenData: [],
      tokenChart: null,
      perKeyCharts: [],
      tokenLoading: false,
      tokenSummary: { requests: 0, input: 0, output: 0 },
      exportLoading: false,
      importFile: null,
      importData: null,
      importMode: 'merge',
      importLoading: false,
      importPreview: { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 },

      get baseUrl() { return location.origin; },

      get activeKey() {
        const sel = this.selectedKeyId && this.keys.find((k) => k.id === this.selectedKeyId);
        if (sel) return sel.key;
        return this.isAdmin ? '<your-api-key>' : this.authKey;
      },

      truncateKey(key) {
        if (!key || key.length <= 12) return key;
        return key.slice(0, 4) + '\\u2026' + key.slice(-4);
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
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
          + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        },

        claudeCodeSnippet() {
          // Claude Code uses a client-side [1m] suffix to enable 1M context window.
          // CC strips it before sending the model name to the API via
          // normalizeModelStringForAPI() (src/utils/model/model.ts), so the
          // gateway never sees it. The suffix triggers two client-side effects:
          //   1. getContextWindowForModel() returns 1_000_000 (src/utils/context.ts)
          //   2. "context-1m-2025-08-07" beta header is added (src/utils/betas.ts)
          //      (the gateway filters this out — Copilot API doesn't support it)
          const addCtx = (id) => {
            const p = this.claudeContextMap[id];
            return p >= 1000000 ? id + '[1m]' : id;
          };
          const lines = [
            'export ANTHROPIC_BASE_URL=' + this.baseUrl,
            'export ANTHROPIC_AUTH_TOKEN=' + this.activeKey,
            'export ANTHROPIC_MODEL=' + addCtx(this.claudeModel),
            'export ANTHROPIC_DEFAULT_SONNET_MODEL=' + addCtx(this.claudeSonnetModel),
            'export ANTHROPIC_DEFAULT_HAIKU_MODEL=' + this.claudeSmallModel,
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
          if (!this.authKey) {
            window.location.href = '/';
            return;
          }

          this.loadModels();

          if (this.tab === 'upstream' && this.isAdmin) {
            this.loadMe();
            this.loadUsage();
          } else if (this.tab === 'keys') {
            this.loadKeys();
          } else if (this.tab === 'usage') {
            this.tokenLoading = true;
            this.fetchTokenData().then(() => {
              if (this.tab === 'usage') {
                this.$nextTick().then(() => { this.renderTokenChart(); this.renderPerKeyCharts(); });
              }
            });
          }

          setInterval(() => {
            if (this.tab === 'upstream' && this.isAdmin) this.loadUsage();
            if (this.tab === 'usage') this.loadTokenUsage();
          }, 60000);

          setInterval(() => {
            this.now = Date.now();
          }, 30000);

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
            for (const c of this.perKeyCharts) { c.stop(); c.destroy(); }
            this.perKeyCharts = [];
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
              this.renderPerKeyCharts();
            }
          } else if (t === 'keys') {
            await this.loadKeys();
          }
        },

        async loadModels() {
          try {
            const resp = await fetch('/api/models', { headers: this.authHeaders() });
            if (!resp.ok) return;
            const { data } = await resp.json();

            const claudeFiltered = data
              .filter((m) => m.id.startsWith('claude-') && m.supported_endpoints?.includes('/v1/messages'));

              const claudeAll = claudeFiltered.map((m) => m.id);
              this.claudeContextMap = {};
              for (const m of claudeFiltered) {
                const limits = m.capabilities?.limits;
                const total = (limits?.max_prompt_tokens || 0) + (limits?.max_output_tokens || 0);
                if (total) this.claudeContextMap[m.id] = total;
              }

              this.claudeModelsBig = [...claudeAll].sort(sortClaudeBig);
              this.claudeModelsSonnet = [...claudeAll].sort(sortClaudeSonnet);
              this.claudeModelsSmall = [...claudeAll].sort(sortClaudeSmall);
              this.claudeModel = this.claudeModelsBig[0] || '';
              this.claudeSonnetModel = this.claudeModelsSonnet[0] || '';
              this.claudeSmallModel = this.claudeModelsSmall[0] || '';

              this.codexModels = data
                .filter((m) => m.supported_endpoints?.includes('/responses'))
                .map((m) => m.id)
                .sort(sortCodex);
              this.codexModel = this.codexModels[0] || '';

              this.modelsLoaded = true;
            } catch {}
          },

          async loadMe() {
            try {
              const resp = await fetch('/auth/me', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              const data = await resp.json();
              this.githubConnected = data.github_connected;
              this.githubAccounts = data.accounts || [];
            } catch (e) {
              console.error('loadMe:', e);
            } finally {
              this.meLoaded = true;
            }
          },

          async loadUsage() {
            try {
              const resp = await fetch('/api/copilot-quota', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                this.usageData = await resp.json();
                const pi = this.usageData.quota_snapshots.premium_interactions;
                this.usagePercent = pi.entitlement > 0
                  ? Math.round(((pi.entitlement - pi.remaining) / pi.entitlement) * 100)
                  : 0;
                this.usageError = false;
              } else {
                this.usageError = true;
              }
            } catch {
              this.usageError = true;
            }
          },

          formatDate(s) {
            return s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
          },

          async startGithubAuth() {
            this.deviceFlow.loading = true;
            try {
              const resp = await fetch('/auth/github', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              const d = await resp.json();
              if (d.user_code) {
                Object.assign(this.deviceFlow, {
                  userCode: d.user_code,
                  verificationUri: d.verification_uri,
                  deviceCode: d.device_code,
                });
                this.pollDeviceFlow(d.interval || 5);
              }
            } catch (e) {
              console.error('startGithubAuth:', e);
            } finally {
              this.deviceFlow.loading = false;
            }
          },

          pollDeviceFlow(interval) {
            this.deviceFlow.pollTimer = setInterval(async () => {
              try {
                const resp = await fetch('/auth/github/poll', {
                  method: 'POST',
                  headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                  body: JSON.stringify({ device_code: this.deviceFlow.deviceCode }),
                });
                if (resp.status === 401) {
                  this.kickToLogin();
                  return;
                }
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
              } catch (e) {
                console.error('poll:', e);
              }
            }, interval * 1000);
          },

          cancelDeviceFlow() {
            clearInterval(this.deviceFlow.pollTimer);
            Object.assign(this.deviceFlow, {
              pollTimer: null,
              userCode: null,
              verificationUri: null,
              deviceCode: null,
            });
          },

          async disconnectGithub(userId, login) {
            if (!confirm('Disconnect @' + login + '? The stored token will be deleted.')) return;
            try {
              const resp = await fetch('/auth/github/' + userId, { method: 'DELETE', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
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
            } catch (e) {
              console.error('disconnectGithub:', e);
            }
          },

          async switchGithubAccount(userId) {
            try {
              const resp = await fetch('/auth/github/switch', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId }),
              });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                await this.loadMe();
                await this.loadUsage();
              } else {
                alert('Failed to switch account');
              }
            } catch (e) {
              console.error('switchGithubAccount:', e);
            }
          },

          async loadKeys() {
            this.keysLoading = true;
            try {
              const resp = await fetch('/api/keys', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                this.keys = await resp.json();
                if (this.selectedKeyId && !this.keys.some((k) => k.id === this.selectedKeyId)) {
                  this.selectedKeyId = null;
                }
              }
            } catch (e) {
              console.error('loadKeys:', e);
            } finally {
              this.keysLoading = false;
            }
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
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                const created = await resp.json();
                this.selectedKeyId = created.id;
                this.newKeyName = '';
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to create key');
              }
            } catch (e) {
              console.error('createKey:', e);
            } finally {
              this.keyCreating = false;
            }
          },

          async deleteKeyById(id, name) {
            if (!confirm('Delete key "' + name + '"? This cannot be undone.')) return;
            this.keyDeleting = id;
            try {
              const resp = await fetch('/api/keys/' + id, { method: 'DELETE', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to delete key');
              }
            } catch (e) {
              console.error('deleteKey:', e);
            } finally {
              this.keyDeleting = null;
            }
          },

          async rotateKeyById(id, name) {
            if (!confirm('Rotate key "' + name + '"? The old key will stop working immediately.')) return;
            this.keyRotating = id;
            try {
              const resp = await fetch('/api/keys/' + id + '/rotate', { method: 'POST', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                this.selectedKeyId = id;
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to rotate key');
              }
            } catch (e) {
              console.error('rotateKey:', e);
            } finally {
              this.keyRotating = null;
            }
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
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to rename key');
              }
            } catch (e) {
              console.error('renameKey:', e);
            }
          },

          async copySnippet(text, tag) {
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              const ta = document.createElement('textarea');
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
            }
            this.copied = tag;
            setTimeout(() => {
              this.copied = false;
            }, 2000);
          },

          localHourKey(d) {
            const p = (n) => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours());
          },

          localDateKey(d) {
            const p = (n) => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
          },

          async fetchTokenData() {
            this.tokenLoading = true;
            try {
              const now = new Date();
              const rangeStart = new Date(now);
              if (this.tokenRange === 'today') {
                rangeStart.setHours(0, 0, 0, 0);
              } else if (this.tokenRange === '7d') {
                rangeStart.setDate(rangeStart.getDate() - 6);
                rangeStart.setHours(0, 0, 0, 0);
              } else {
                rangeStart.setDate(rangeStart.getDate() - 29);
                rangeStart.setHours(0, 0, 0, 0);
              }
              const start = rangeStart.toISOString().slice(0, 13);
              const end = new Date(now.getTime() + 3600000).toISOString().slice(0, 13);
              const resp = await fetch('/api/token-usage?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end), { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (resp.ok) this.tokenData = await resp.json();
            } catch (e) {
              console.error('fetchTokenData:', e);
            } finally {
              this.tokenLoading = false;
            }
          },

          async loadTokenUsage() {
            await this.fetchTokenData();
            if (this.tab !== 'usage') return;
            await this.$nextTick();
            this.renderTokenChart();
            this.renderPerKeyCharts();
          },

          renderTokenChart() {
            const canvas = document.getElementById('tokenChart');
            if (!canvas || canvas.clientWidth === 0) return;

            const palette = ['#00e5ff', '#00e676', '#ffd740', '#ff5252', '#7c4dff', '#ff6e40', '#64ffda', '#eeff41', '#40c4ff', '#ea80fc'];
            const isDaily = this.tokenRange !== 'today';
            const data = this.tokenData;

            const keyNameMap = new Map();
            for (const r of data) keyNameMap.set(r.keyId, r.keyName);

            let totalReqs = 0;
            let totalIn = 0;
            let totalOut = 0;
            for (const r of data) {
              totalReqs += r.requests;
              totalIn += r.inputTokens;
              totalOut += r.outputTokens;
            }
            this.tokenSummary = { requests: totalReqs, input: totalIn, output: totalOut };

            const bucketMap = new Map();
            const now = new Date();
            if (this.tokenRange === 'today') {
              for (let h = 0; h < 24; h++) {
                const d = new Date(now);
                d.setHours(h, 0, 0, 0);
                bucketMap.set(this.localHourKey(d), String(h).padStart(2, '0') + ':00 \\u2013 ' + String((h + 1) % 24).padStart(2, '0') + ':00');
              }
            } else {
              const days = this.tokenRange === '7d' ? 7 : 30;
              for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                d.setHours(0, 0, 0, 0);
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
              m.set(r.keyId, (m.get(r.keyId) || 0) + r.inputTokens + r.outputTokens);
            }

            const keyList = [...keyIds].sort((a, b) => (keyNameMap.get(a) || a).localeCompare(keyNameMap.get(b) || b));
            const labels = [...bucketMap.values()];
            const bucketKeys = [...bucketMap.keys()];
            const datasets = keyList.map((keyId, i) => {
              const c = palette[i % palette.length];
              return {
                label: keyNameMap.get(keyId) || keyId.slice(0, 8),
                data: bucketKeys.map((k) => agg.get(k)?.get(keyId) || 0),
                borderColor: c,
                backgroundColor: c + '18',
                borderWidth: 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.3,
                fill: true,
              };
            });

            if (this.tokenChart) {
              this.tokenChart.stop();
              this.tokenChart.destroy();
              this.tokenChart = null;
            }

            this.tokenChart = new Chart(canvas, {
              type: 'line',
              data: { labels, datasets },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                  legend: {
                    position: 'bottom',
                    labels: {
                      color: '#9e9e9e',
                      font: { size: 11, family: "'DM Sans', sans-serif" },
                      boxWidth: 12,
                      padding: 16,
                      usePointStyle: true,
                      pointStyle: 'circle',
                    },
                  },
                  tooltip: {
                    backgroundColor: 'rgba(12,16,21,0.95)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    titleColor: '#e0e0e0',
                    bodyColor: '#b0bec5',
                    padding: 12,
                    bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
                    callbacks: {
                      label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() + ' tokens',
                    },
                  },
                },
                scales: {
                  x: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                      color: '#9e9e9e',
                      font: { size: 10, family: "'DM Sans', sans-serif" },
                      maxRotation: 45,
                    },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                  y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                      color: '#9e9e9e',
                      font: { size: 10, family: "'JetBrains Mono', monospace" },
                      callback: (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v,
                    },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                },
              },
            });
          },

          renderPerKeyCharts() {
            // Destroy existing per-key charts
            for (const c of this.perKeyCharts) { c.stop(); c.destroy(); }
            this.perKeyCharts = [];

            const palette = ['#00e5ff', '#00e676', '#ffd740', '#ff5252', '#7c4dff', '#ff6e40', '#64ffda', '#eeff41', '#40c4ff', '#ea80fc'];
            const isDaily = this.tokenRange !== 'today';
            const data = this.tokenData;

            // Group data by keyId
            const keyGroups = new Map();
            for (const r of data) {
              if (!keyGroups.has(r.keyId)) keyGroups.set(r.keyId, { name: r.keyName || r.keyId.slice(0, 8), records: [] });
              keyGroups.get(r.keyId).records.push(r);
            }

            // Build buckets (same as renderTokenChart)
            const bucketMap = new Map();
            const now = new Date();
            if (this.tokenRange === 'today') {
              for (let h = 0; h < 24; h++) {
                const d = new Date(now);
                d.setHours(h, 0, 0, 0);
                bucketMap.set(this.localHourKey(d), String(h).padStart(2, '0') + ':00 \u2013 ' + String((h + 1) % 24).padStart(2, '0') + ':00');
              }
            } else {
              const days = this.tokenRange === '7d' ? 7 : 30;
              for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                d.setHours(0, 0, 0, 0);
                bucketMap.set(this.localDateKey(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
              }
            }

            const labels = [...bucketMap.values()];
            const bucketKeys = [...bucketMap.keys()];

            // Remove old containers and create new ones
            const container = document.getElementById('perKeyChartsContainer');
            if (!container) return;
            container.innerHTML = '';

            for (const [keyId, group] of keyGroups) {
              // Aggregate by model per bucket
              const modelSet = new Set();
              const agg = new Map();
              for (const [key] of bucketMap) agg.set(key, new Map());
              for (const r of group.records) {
                const utc = new Date(r.hour + ':00:00Z');
                const bucket = isDaily ? this.localDateKey(utc) : this.localHourKey(utc);
                if (!agg.has(bucket)) continue;
                modelSet.add(r.model);
                const m = agg.get(bucket);
                m.set(r.model, (m.get(r.model) || 0) + r.inputTokens + r.outputTokens);
              }

              const models = [...modelSet].sort();
              if (models.length === 0) continue;

              const datasets = models.map((model, i) => {
                const c = palette[i % palette.length];
                return {
                  label: model,
                  data: bucketKeys.map((k) => agg.get(k)?.get(model) || 0),
                  borderColor: c,
                  backgroundColor: c + '18',
                  borderWidth: 2,
                  pointRadius: 2,
                  pointHoverRadius: 5,
                  tension: 0.3,
                  fill: true,
                };
              });

              // Create wrapper div
              const wrapper = document.createElement('div');
              wrapper.className = 'glass-card p-6 mb-6';
              const h3 = document.createElement('h3');
              h3.style.cssText = 'color:#e0e0e0;font-size:14px;font-weight:600;margin-bottom:12px';
              h3.textContent = group.name;
              const chartDiv = document.createElement('div');
              chartDiv.style.cssText = 'height:280px;position:relative';
              const canvasEl = document.createElement('canvas');
              chartDiv.appendChild(canvasEl);
              wrapper.appendChild(h3);
              wrapper.appendChild(chartDiv);
              container.appendChild(wrapper);

              const canvas = canvasEl;
              const chart = new Chart(canvas, {
                type: 'line',
                data: { labels, datasets },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  animation: false,
                  interaction: { mode: 'index', intersect: false },
                  plugins: {
                    legend: {
                      position: 'bottom',
                      labels: {
                        color: '#9e9e9e',
                        font: { size: 11, family: "'DM Sans', sans-serif" },
                        boxWidth: 12,
                        padding: 16,
                        usePointStyle: true,
                        pointStyle: 'circle',
                      },
                    },
                    tooltip: {
                      backgroundColor: 'rgba(12,16,21,0.95)',
                      borderColor: 'rgba(255,255,255,0.1)',
                      borderWidth: 1,
                      titleColor: '#e0e0e0',
                      bodyColor: '#b0bec5',
                      padding: 12,
                      bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
                      callbacks: {
                        label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() + ' tokens',
                      },
                    },
                  },
                  scales: {
                    x: {
                      grid: { color: 'rgba(255,255,255,0.04)' },
                      ticks: {
                        color: '#9e9e9e',
                        font: { size: 10, family: "'DM Sans', sans-serif" },
                        maxRotation: 45,
                      },
                      border: { color: 'rgba(255,255,255,0.06)' },
                    },
                    y: {
                      beginAtZero: true,
                      grid: { color: 'rgba(255,255,255,0.04)' },
                      ticks: {
                        color: '#9e9e9e',
                        font: { size: 10, family: "'JetBrains Mono', monospace" },
                        callback: (v) => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : v,
                      },
                      border: { color: 'rgba(255,255,255,0.06)' },
                    },
                  },
                },
              });
              this.perKeyCharts.push(chart);
            }
          },

          switchTokenRange(range) {
            this.tokenRange = range;
            this.loadTokenUsage();
          },

          async exportData() {
            this.exportLoading = true;
            try {
              const resp = await fetch('/api/export', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              if (!resp.ok) {
                alert('Export failed: ' + (await resp.json()).error);
                return;
              }
              const data = await resp.json();
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'copilot-export-' + new Date().toISOString().slice(0, 10) + '.json';
              a.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              console.error('exportData:', e);
              alert('Export failed');
            } finally {
              this.exportLoading = false;
            }
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
                if (!json.data) {
                  alert('Invalid export file: missing data field');
                  this.importFile = null;
                  return;
                }
                this.importData = json.data;
                this.importPreview = {
                  ready: true,
                  exportedAt: json.exportedAt || null,
                  apiKeys: Array.isArray(json.data.apiKeys) ? json.data.apiKeys.length : 0,
                  githubAccounts: Array.isArray(json.data.githubAccounts) ? json.data.githubAccounts.length : 0,
                  usage: Array.isArray(json.data.usage) ? json.data.usage.length : 0,
                };
              } catch {
                alert('Invalid JSON file');
                this.importFile = null;
              }
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
              if (resp.status === 401) {
                this.kickToLogin();
                return;
              }
              const result = await resp.json();
              if (resp.ok) {
                alert('Import complete: ' + result.imported.apiKeys + ' keys, ' + result.imported.githubAccounts + ' accounts, ' + result.imported.usage + ' usage records');
                this.importFile = null;
                this.importData = null;
                this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 };
              } else {
                alert('Import failed: ' + (result.error || 'Unknown error'));
              }
            } catch (e) {
              console.error('doImport:', e);
              alert('Import failed');
            } finally {
              this.importLoading = false;
            }
          },

          logout() {
            localStorage.removeItem('authKey');
            localStorage.removeItem('isAdmin');
            localStorage.removeItem('login_key_id');
            localStorage.removeItem('login_key_name');
            localStorage.removeItem('login_key_hint');
            window.location.href = '/';
          },

          kickToLogin() {
            this.logout();
          },
        };
      }
    </script>
  `;
}
