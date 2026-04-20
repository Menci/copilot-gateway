import { html } from "hono/html";

export function dashboardAssets() {
  return html`
    <style>
    select option { background: #13181f; color: #e0e0e0; }
    </style>

    <script>
    function dashboardApp() {
    const isAdmin = localStorage.getItem('isAdmin') === '1';
    const TABS = isAdmin ? ['upstream', 'keys', 'usage', 'models', 'settings'] : ['keys', 'usage', 'models'];
    const defaultTab = isAdmin ? 'upstream' : 'keys';
    const initTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;

    // Chart instances and key name map stored outside Alpine to avoid reactive proxy wrapping
    const _charts = { key: null, model: null };
    const _keyNameMap = new Map();
    const _detailMaps = { key: null, model: null };

    function destroyCharts() {
      for (const k of ['key', 'model']) {
        if (_charts[k]) { _charts[k].stop(); _charts[k].destroy(); _charts[k] = null; }
      }
    }

    const pad2 = (n) => String(n).padStart(2, '0');

    function formatTokenCount(n) {
      return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
    }

    function renderHitRate(cacheRead, cacheCreation) {
      const total = cacheRead + cacheCreation;
      return total > 0 ? ((cacheRead / total) * 100).toFixed(1) + '%' : '\\u2014';
    }

    function tooltipLabelWidth(chart) {
      return chart.data.datasets.reduce((maxLen, ds) => Math.max(maxLen, String(ds.label || '').length), 0);
    }

    function formatTooltipHeader(labelWidth) {
      return '  ' + ''.padEnd(labelWidth + 1)
        + 'Req'.padStart(5)
        + '  ' + 'Total'.padStart(7)
        + '  ' + 'Input'.padStart(7)
        + '  ' + 'Output'.padStart(7)
        + '  ' + 'CacheW'.padStart(7)
        + '  ' + 'HitRate'.padStart(7);
    }

    function formatTooltipRow(label, labelWidth, detail) {
      return label.padEnd(labelWidth + 1)
        + String(detail.requests).padStart(5)
        + '  ' + formatTokenCount(detail.input + detail.output).padStart(7)
        + '  ' + formatTokenCount(detail.input).padStart(7)
        + '  ' + formatTokenCount(detail.output).padStart(7)
        + '  ' + formatTokenCount(detail.cacheCreation).padStart(7)
        + '  ' + renderHitRate(detail.cacheRead, detail.cacheCreation).padStart(7);
    }

    const CLAUDE_TIER = { opus: 0, sonnet: 1, haiku: 2 };

    // Display form for Claude model IDs: turn "claude-opus-4.7" into "claude-opus-4-7"
    // to match Anthropic's canonical dashed versioning. The backend normalizes
    // it back on entry.
    function substituteModelName(id) {
      if (!id || !id.startsWith('claude-')) return id;
      return id.replace(/(\\d)\\.(\\d)/g, '$1-$2');
    }

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
      loginKeyId: localStorage.getItem('login_key_id') || '',
      tab: initTab,
      meLoaded: false,
      githubAccounts: [],
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
      chartsReady: false,
      tokenLoading: false,
      tokenSummary: { requests: 0, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      hiddenKeys: new Set(),
      hiddenModels: new Set(),
      redactKeys: false,
      exportLoading: false,
      importFile: null,
      importData: null,
      importMode: 'merge',
      importLoading: false,
      importPreview: { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0 },
      // Models tab — chat playground
      allModels: [],
      modelsSearch: '',
      chatModelId: '',
      chatMessages: [],     // {role, text, imageUrl?}
      chatInput: '',
      chatImageUrl: '',
      chatShowImage: false,
      chatSending: false,
      chatStreamText: '',
      _chatAbort: null,

      get baseUrl() { return location.origin; },

      get githubConnected() { return this.githubAccounts.length > 0; },

      get chatModelInfo() {
        return this.allModels.find(m => m.id === this.chatModelId) || null;
      },

      get chatModelCaps() {
        const s = this.chatModelInfo?.capabilities?.supports;
        if (!s) return [];
        const caps = [];
        if (s.vision) caps.push('vision');
        if (s.tool_calls) caps.push('tools');
        if (s.streaming) caps.push('streaming');
        if (s.adaptive_thinking) caps.push('thinking');
        return caps;
      },

      get filteredChatModels() {
        let models = this.allModels.filter(m => m.capabilities?.type !== 'embeddings');
        if (this.modelsSearch.trim()) {
          const q = this.modelsSearch.toLowerCase();
          models = models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        }
        const enabled = models.filter(m => m.model_picker_enabled);
        const legacy = models.filter(m => !m.model_picker_enabled);
        if (enabled.length && legacy.length) return [...enabled, { _divider: true }, ...legacy];
        return [...enabled, ...legacy];
      },

      get activeKey() {
        const sel = this.selectedKeyId && this.keys.find((k) => k.id === this.selectedKeyId);
        if (sel) return sel.key;
        return this.isAdmin ? '<your-api-key>' : this.authKey;
      },

      truncateKey(key) {
        if (!key || key.length <= 12) return key;
        return key.slice(0, 4) + '\\u2026' + key.slice(-4);
      },

      formatHitRate(cacheRead, cacheCreation) {
        return renderHitRate(cacheRead, cacheCreation);
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
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
          + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
        },

        claudeCodeSnippet() {
          // Claude Code uses a client-side [1m] suffix to enable 1M context window.
          // CC strips it before sending the model name to the API via
          // normalizeModelStringForAPI() (src/utils/model/model.ts), so the
          // gateway never sees it. The suffix triggers two client-side effects:
          //   1. getContextWindowForModel() returns 1_000_000 (src/utils/context.ts)
          //   2. "context-1m-2025-08-07" beta header is added (src/utils/betas.ts)
          //      (the gateway filters this out — Copilot API doesn't support it)
          const force1m = ['claude-opus-4-7'];
          const addCtx = (id) => {
            if (force1m.includes(id)) return id + '[1m]';
            const p = this.claudeContextMap[id];
            return p >= 1000000 ? id + '[1m]' : id;
          };
          const lines = [
            'export ANTHROPIC_BASE_URL=' + this.baseUrl,
            'export ANTHROPIC_AUTH_TOKEN=' + this.activeKey,
            'export ANTHROPIC_MODEL=' + addCtx(this.claudeModel),
            'export ANTHROPIC_DEFAULT_SONNET_MODEL=' + addCtx(this.claudeSonnetModel),
            'export ANTHROPIC_DEFAULT_HAIKU_MODEL=' + this.claudeSmallModel,
            "export CLAUDE_CODE_EXTRA_BODY='" + '{"thinking":{"type":"adaptive"}}' + "'",
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
            this.loadTokenUsage();
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
          if (t !== 'usage') {
            destroyCharts();
            this.chartsReady = false;
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
              this.renderTokenCharts();
            }
          } else if (t === 'keys') {
            await this.loadKeys();
          } else if (t === 'models') {
            if (this.allModels.length === 0) await this.loadAllModels();
          }
        },

        async loadModels() {
          try {
            const resp = await fetch('/api/models', { headers: this.authHeaders() });
            if (!resp.ok) {
              console.error('loadModels: HTTP', resp.status);
              return;
            }
            const { data: rawData } = await resp.json();
            const seen = new Set();
            const data = rawData
              .map((m) => ({ ...m, id: substituteModelName(m.id) }))
              .filter((m) => !seen.has(m.id) && seen.add(m.id));

            this.allModels = data;
            if (!this.chatModelId) {
              const first = this.filteredChatModels.find(m => !m._divider);
              if (first) this.chatModelId = first.id;
            }

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
            } catch (e) {
              console.error('loadModels:', e);
            }
          },

          async loadMe() {
            try {
              const resp = await fetch('/auth/me', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              const data = await resp.json();
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
                this.logout();
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
                this.logout();
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
                  this.logout();
                  return;
                }
                const d = await resp.json();
                if (d.status === 'complete') {
                  this.cancelDeviceFlow();
                  await this.loadMe();
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
                this.logout();
                return;
              }
              if (resp.ok) {
                await this.loadMe();
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
                this.logout();
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
                this.logout();
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
                this.logout();
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
                this.logout();
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
                this.logout();
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
                this.logout();
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
            await navigator.clipboard.writeText(text);
            this.copied = tag;
            setTimeout(() => {
              this.copied = false;
            }, 2000);
          },

          localHourKey(d) {
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours());
          },

          localDateKey(d) {
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
          },

          async fetchTokenData() {
            this.tokenLoading = true;
            try {
              const now = new Date();
              const rangeStart = new Date(now);
              if (this.tokenRange === 'today') {
                rangeStart.setTime(now.getTime() - 23 * 3600000);
                rangeStart.setMinutes(0, 0, 0);
              } else if (this.tokenRange === '7d') {
                rangeStart.setDate(rangeStart.getDate() - 6);
                rangeStart.setHours(0, 0, 0, 0);
              } else {
                rangeStart.setDate(rangeStart.getDate() - 29);
                rangeStart.setHours(0, 0, 0, 0);
              }
              const start = rangeStart.toISOString().slice(0, 13);
              const end = new Date(now.getTime() + 3600000).toISOString().slice(0, 13);
              let tokenUrl = '/api/token-usage?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end);
              if (!this.isAdmin && this.loginKeyId) tokenUrl += '&key_id=' + encodeURIComponent(this.loginKeyId);
              const resp = await fetch(tokenUrl, { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
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
            this.renderTokenCharts();
          },

          buildBucketMap() {
            const bucketMap = new Map();
            const now = new Date();
            if (this.tokenRange === 'today') {
              const cur = new Date(now);
              cur.setMinutes(0, 0, 0);
              for (let i = 23; i >= 0; i--) {
                const d = new Date(cur.getTime() - i * 3600000);
                const h = d.getHours();
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
            return bucketMap;
          },

          aggregateBuckets(records, dimension) {
            const isDaily = this.tokenRange !== 'today';
            const bucketMap = this.buildBucketMap();
            const agg = new Map();
            const detail = new Map();
            for (const [key] of bucketMap) {
              agg.set(key, new Map());
              detail.set(key, new Map());
            }
            for (const r of records) {
              const utc = new Date(r.hour + ':00:00Z');
              const bucket = isDaily ? this.localDateKey(utc) : this.localHourKey(utc);
              if (!agg.has(bucket)) continue;
              const m = agg.get(bucket);
              const val = r[dimension];
              m.set(val, (m.get(val) || 0) + r.inputTokens + r.outputTokens);
              const dm = detail.get(bucket);
              const prev = dm.get(val) || { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
              prev.requests += r.requests;
              prev.input += r.inputTokens;
              prev.output += r.outputTokens;
              prev.cacheRead += r.cacheReadTokens ?? 0;
              prev.cacheCreation += r.cacheCreationTokens ?? 0;
              dm.set(val, prev);
            }
            return { bucketMap, agg, detail };
          },

          updateSummary() {
            const filtered = this.tokenData.filter((r) => !this.hiddenKeys.has(r.keyId) && !this.hiddenModels.has(r.model));
            let totalReqs = 0, totalIn = 0, totalOut = 0, totalCR = 0, totalCC = 0;
            for (const r of filtered) {
              totalReqs += r.requests;
              totalIn += r.inputTokens;
              totalOut += r.outputTokens;
              totalCR += r.cacheReadTokens ?? 0;
              totalCC += r.cacheCreationTokens ?? 0;
            }
            this.tokenSummary = {
              requests: totalReqs,
              total: totalIn + totalOut,
              input: totalIn,
              output: totalOut,
              cacheRead: totalCR,
              cacheCreation: totalCC,
            };
          },

          refreshChartsData() {
            const bucketMap = this.buildBucketMap();
            const bucketKeysArr = [...bucketMap.keys()];

            if (_charts.key) {
              const filtered = this.tokenData.filter((r) => !this.hiddenModels.has(r.model));
              const { agg, detail } = this.aggregateBuckets(filtered, 'keyId');
              _detailMaps.key = detail;
              for (let i = 0; i < _charts.key.data.datasets.length; i++) {
                const ds = _charts.key.data.datasets[i];
                ds.data = bucketKeysArr.map((k) => agg.get(k)?.get(ds._keyId) || 0);
                const userHidden = this.hiddenKeys.has(ds._keyId);
                const allZero = ds.data.every((v) => v === 0);
                _charts.key.setDatasetVisibility(i, !userHidden && !allZero);
              }
              _charts.key.update('none');
            }

            if (_charts.model) {
              const filtered = this.tokenData.filter((r) => !this.hiddenKeys.has(r.keyId));
              const { agg, detail } = this.aggregateBuckets(filtered, 'model');
              _detailMaps.model = detail;
              for (let i = 0; i < _charts.model.data.datasets.length; i++) {
                const ds = _charts.model.data.datasets[i];
                ds.data = bucketKeysArr.map((k) => agg.get(k)?.get(ds._model) || 0);
                const userHidden = this.hiddenModels.has(ds._model);
                const allZero = ds.data.every((v) => v === 0);
                _charts.model.setDatasetVisibility(i, !userHidden && !allZero);
              }
              _charts.model.update('none');
            }

            this.updateSummary();
          },

          renderTokenCharts() {
            const canvasKey = document.getElementById('tokenChartByKey');
            const canvasModel = document.getElementById('tokenChartByModel');
            if (!canvasKey || !canvasModel || canvasKey.clientWidth === 0) return;

            const palette = ['#00e5ff', '#00e676', '#ffd740', '#ff5252', '#7c4dff', '#ff6e40', '#64ffda', '#eeff41', '#40c4ff', '#ea80fc'];
            const data = this.tokenData;
            const self = this;

            const keyNameMap = _keyNameMap;
            keyNameMap.clear();
            const allKeyIds = new Set();
            const allModels = new Set();
            for (const r of data) {
              keyNameMap.set(r.keyId, r.keyName);
              allKeyIds.add(r.keyId);
              allModels.add(r.model);
            }

            const bucketMap = this.buildBucketMap();
            const labels = [...bucketMap.values()];
            const bucketKeysArr = [...bucketMap.keys()];

            const { agg: keyAgg, detail: keyDetail } = this.aggregateBuckets(data, 'keyId');
            const { agg: modelAgg, detail: modelDetail } = this.aggregateBuckets(data, 'model');
            _detailMaps.key = keyDetail;
            _detailMaps.model = modelDetail;

            const keyList = [...allKeyIds].sort((a, b) => (keyNameMap.get(a) || a).localeCompare(keyNameMap.get(b) || b));
            const modelList = [...allModels].sort();

            const keyDatasets = keyList.map((keyId, i) => {
              const c = palette[i % palette.length];
              return {
                label: self.redactKeys ? keyId.slice(0, 8) : (keyNameMap.get(keyId) || keyId.slice(0, 8)),
                data: bucketKeysArr.map((k) => keyAgg.get(k)?.get(keyId) || 0),
                borderColor: c,
                backgroundColor: c + '40',
                borderWidth: 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.3,
                fill: 'stack',
                _keyId: keyId,
              };
            });

            const modelDatasets = modelList.map((model, i) => {
              const c = palette[i % palette.length];
              return {
                label: model,
                data: bucketKeysArr.map((k) => modelAgg.get(k)?.get(model) || 0),
                borderColor: c,
                backgroundColor: c + '40',
                borderWidth: 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.3,
                fill: 'stack',
                _model: model,
              };
            });

            this.updateSummary();

            const makeOptions = (onClick, chartType) => ({
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
                  onClick,
                },
                tooltip: {
                  backgroundColor: 'rgba(12,16,21,0.95)',
                  borderColor: 'rgba(255,255,255,0.1)',
                  borderWidth: 1,
                  titleColor: '#e0e0e0',
                  bodyColor: '#b0bec5',
                  padding: 12,
                  beforeBodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
                  bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
                  filter: (item) => item.parsed.y > 0,
                  itemSort: (a, b) => b.parsed.y - a.parsed.y,
                  callbacks: {
                    beforeBody: (items) => {
                      if (!items.length) return [];
                      return formatTooltipHeader(tooltipLabelWidth(items[0].chart));
                    },
                    label: (ctx) => {
                      const bucket = bucketKeysArr[ctx.dataIndex];
                      const dimKey = chartType === 'key' ? ctx.dataset._keyId : ctx.dataset._model;
                      const detailMap = _detailMaps[chartType];
                      const detail = detailMap?.get(bucket)?.get(dimKey);
                      if (!detail) return ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() + ' tokens';
                      return formatTooltipRow(String(ctx.dataset.label || ''), tooltipLabelWidth(ctx.chart), detail);
                    },
                  },
                },
              },
              scales: {
                x: {
                  stacked: true,
                  grid: { color: 'rgba(255,255,255,0.04)' },
                  ticks: { color: '#9e9e9e', font: { size: 10, family: "'DM Sans', sans-serif" }, maxRotation: 45 },
                  border: { color: 'rgba(255,255,255,0.06)' },
                },
                y: {
                  stacked: true,
                  beginAtZero: true,
                  grid: { color: 'rgba(255,255,255,0.04)' },
                  ticks: {
                    color: '#9e9e9e',
                    font: { size: 10, family: "'JetBrains Mono', monospace" },
                    callback: (v) => formatTokenCount(Number(v)),
                  },
                  border: { color: 'rgba(255,255,255,0.06)' },
                },
              },
            });

            destroyCharts();

            _charts.key = new Chart(canvasKey, {
              type: 'line',
              data: { labels, datasets: keyDatasets },
              options: makeOptions((_e, legendItem, legend) => {
                const ds = legend.chart.data.datasets[legendItem.datasetIndex];
                if (self.hiddenKeys.has(ds._keyId)) self.hiddenKeys.delete(ds._keyId);
                else self.hiddenKeys.add(ds._keyId);
                self.refreshChartsData();
              }, 'key'),
            });

            _charts.model = new Chart(canvasModel, {
              type: 'line',
              data: { labels, datasets: modelDatasets },
              options: makeOptions((_e, legendItem, legend) => {
                const ds = legend.chart.data.datasets[legendItem.datasetIndex];
                if (self.hiddenModels.has(ds._model)) self.hiddenModels.delete(ds._model);
                else self.hiddenModels.add(ds._model);
                self.refreshChartsData();
              }, 'model'),
            });

            this.chartsReady = true;
            this.refreshChartsData();
          },

          toggleRedactKeys() {
            this.redactKeys = !this.redactKeys;
            if (_charts.key) {
              for (const ds of _charts.key.data.datasets) {
                ds.label = this.redactKeys ? ds._keyId.slice(0, 8) : (_keyNameMap.get(ds._keyId) || ds._keyId.slice(0, 8));
              }
              _charts.key.update('none');
            }
          },

          switchTokenRange(range) {
            this.tokenRange = range;
            destroyCharts();
            this.chartsReady = false;
            this.loadTokenUsage();
          },

          async exportData() {
            this.exportLoading = true;
            try {
              const resp = await fetch('/api/export', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
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
                this.logout();
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

          // ---- Models tab ----

          async loadAllModels() {
            if (this.allModels.length === 0) await this.loadModels();
          },

          selectChatModel(id) {
            this.chatModelId = id;
            if (this._chatAbort) {
              this._chatAbort.abort();
              this._chatAbort = null;
              this.chatSending = false;
            }
          },

          clearChat() {
            if (this._chatAbort) {
              this._chatAbort.abort();
              this._chatAbort = null;
            }
            this.chatMessages = [];
            this.chatSending = false;
            this.chatStreamText = '';
          },

          buildChatApiMessages() {
            return this.chatMessages.map(m => {
              if (m.role === 'assistant') return { role: 'assistant', content: m.text };
              if (m.imageUrl) {
                return {
                  role: 'user',
                  content: [
                    { type: 'image_url', image_url: { url: m.imageUrl } },
                    { type: 'text', text: m.text },
                  ],
                };
              }
              return { role: 'user', content: m.text };
            });
          },

          scrollChat() {
            this.$nextTick(() => {
              const el = this.$refs.chatScroll;
              if (el) el.scrollTop = el.scrollHeight;
            });
          },

          async sendChatMessage() {
            const text = this.chatInput.trim();
            const img = this.chatImageUrl.trim();
            if (!text && !img) return;
            if (!this.chatModelId) return;

            this.chatMessages.push({ role: 'user', text: text || '(image)', imageUrl: img || null });
            this.chatInput = '';
            this.chatImageUrl = '';
            this.chatShowImage = false;
            this.chatSending = true;
            this.chatStreamText = '';

            const controller = new AbortController();
            this._chatAbort = controller;

            try {
              const resp = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': this.authKey, 'x-models-playground': '1' },
                body: JSON.stringify({
                  model: this.chatModelId,
                  messages: this.buildChatApiMessages(),
                  stream: true,
                }),
                signal: controller.signal,
              });

              if (!resp.ok) {
                const errText = await resp.text();
                this.chatMessages.push({ role: 'assistant', text: '[Error ' + resp.status + '] ' + errText });
                this.chatSending = false;
                this._chatAbort = null;
                this.scrollChat();
                return;
              }

              const reader = resp.body.getReader();
              const decoder = new TextDecoder();
              let buf = '';
              let assistantText = '';
              const idx = this.chatMessages.length;
              this.chatMessages.push({ role: 'assistant', text: '' });

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\\n');
                buf = lines.pop();
                for (const line of lines) {
                  if (!line.startsWith('data: ')) continue;
                  const payload = line.slice(6);
                  if (payload === '[DONE]') continue;
                  try {
                    const chunk = JSON.parse(payload);
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) {
                      assistantText += delta;
                      this.chatMessages[idx].text = assistantText;
                    }
                  } catch {}
                }
                this.scrollChat();
              }

              if (!assistantText) {
                this.chatMessages[idx].text = '(empty response)';
              }
            } catch (e) {
              if (e.name !== 'AbortError') {
                this.chatMessages.push({ role: 'assistant', text: '[Error] ' + e.message });
              }
            } finally {
              this.chatSending = false;
              this._chatAbort = null;
              this.scrollChat();
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

        };
      }
    </script>
  `;
}
