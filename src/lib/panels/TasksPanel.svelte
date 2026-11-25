<script lang="ts">
  import { onMount } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import SessionClockStrip from './SessionClockStrip.svelte';
  import { loadRoutinesState, type RitualItem } from '../routines/store';
  import {
    fetchCalendarWeek,
    getLocalTimeZone,
    getTodayIso,
    getWeekStart,
    type EconomicEvent
  } from '../calendar/api';
  import {
    computeAlignment,
    fetchMacroRegime,
    findNearestHighImpactForSymbol,
    getCachedMacroRegime,
    normalizeShortSymbol,
    resolveMacroForSymbol,
    type MacroRegimeResponse
  } from '../insights/api';
  import {
    computePlaybookEdge,
    formatRMultiple,
    subscribePlaybook,
    type PlaybookState
  } from '../playbook/store';
  import { getPaperInstrumentSpec } from '../paper/instruments';
  import {
    computeAccountMetrics,
    getActivePaperAccount,
    getPaperLiveQuote,
    pushOrderDraft,
    subscribePaper,
    subscribePaperQuotes
  } from '../paper/store';
  import type { OrderSide, OrderType, PaperLedgerState, PaperLiveQuote } from '../paper/types';
  import {
    formatQuotePrice,
    loadWatchlistState,
    type BiasDirection,
    type WatchlistState
  } from '../watchlist/store';
  import { makeWorkspaceId } from '../workspace/storage';
  import {
    calculatePositionSize,
    createDefaultTasksState,
    logPreTradePlanToNotes,
    saveTasksState,
    subscribeTasks,
    type TasksState
  } from '../tasks/store';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    activeFullSymbol: string;
    activePrice?: number;
    onClose: () => void;
  }

  let { theme, activeSymbol, activeFullSymbol, activePrice, onClose }: Props = $props();

  type TabId = 'pretrade' | 'todo';
  type TodoFilter = 'open' | 'done' | 'all';

  let activeTab = $state<TabId>('pretrade');
  let todoFilter = $state<TodoFilter>('open');
  let tasksState = $state<TasksState>(createDefaultTasksState());

  let newRuleText = $state('');
  let newTodoText = $state('');
  let tagSymbolOnTodo = $state(true);
  let showContractOverride = $state(false);
  let loggedFeedback = $state(false);
  let paperSentFeedback = $state(false);
  let paperState = $state<PaperLedgerState | null>(null);
  let paperQuotes = $state<Record<string, PaperLiveQuote>>({});

  // One-time non-destructive migration banner for retired Routines rituals
  const ROUTINES_MIGRATION_KEY = 'deplyzeworkflow.routines_migrated_v1';
  let legacyRituals = $state<RitualItem[]>([]);
  let showLegacyBanner = $state(false);

  const paperEquity = $derived.by(() => {
    if (!paperState?.connected) return null;
    const acc = getActivePaperAccount(paperState);
    return computeAccountMetrics(acc, paperQuotes).equity;
  });

  // Live Pre-Trade Guardrail inputs (Calendar + Macro Regime + Watchlist Bias + Playbook Edge)
  let playbookState = $state<PlaybookState>({ entries: [], customSetupTypes: [] });
  let watchlistState = $state<WatchlistState | null>(null);
  let macroRegime = $state<MacroRegimeResponse | null>(getCachedMacroRegime());
  let calendarEventsByDate = $state<Record<string, EconomicEvent[]>>({});
  let calendarLoaded = $state(false);

  const normalizedActiveSym = $derived(normalizeShortSymbol(activeSymbol || 'XAUUSD'));

  const upcomingNewsRisk = $derived(
    findNearestHighImpactForSymbol(calendarEventsByDate, normalizedActiveSym, 12)
  );

  const symbolWatchlistBias = $derived.by((): BiasDirection => {
    if (!watchlistState) return 'none';
    const activeGroup =
      watchlistState.groups.find((g) => g.id === watchlistState?.activeGroupId) ??
      watchlistState.groups[0];
    if (!activeGroup) return 'none';
    for (const sec of activeGroup.sections) {
      for (const item of sec.items) {
        if (normalizeShortSymbol(item.shortName) === normalizedActiveSym) {
          return item.bias;
        }
      }
    }
    return 'none';
  });

  const symbolMacro = $derived(resolveMacroForSymbol(macroRegime, normalizedActiveSym));
  const macroAlignment = $derived(computeAlignment(symbolMacro?.bias, symbolWatchlistBias));

  const symbolPlaybookEdge = $derived.by(() => {
    const matching = playbookState.entries.filter(
      (e) => normalizeShortSymbol(e.symbol) === normalizedActiveSym
    );
    return computePlaybookEdge(matching);
  });

  const guardrailStatus = $derived.by((): { tone: 'warn' | 'ok' | 'neutral'; label: string } => {
    if (upcomingNewsRisk && (upcomingNewsRisk.level === 'danger' || upcomingNewsRisk.level === 'caution')) {
      return { tone: 'warn', label: 'Caution' };
    }
    if (macroAlignment === 'conflict') {
      return { tone: 'warn', label: 'Conflict' };
    }
    if (macroAlignment === 'aligned') {
      return { tone: 'ok', label: 'Aligned' };
    }
    if (symbolMacro?.bias === 'tailwind' || symbolMacro?.bias === 'headwind') {
      return { tone: 'neutral', label: symbolMacro.bias === 'tailwind' ? 'Tailwind' : 'Headwind' };
    }
    return { tone: 'neutral', label: 'Live' };
  });

  const checkedCount = $derived(tasksState.rules.filter((r) => r.checked).length);
  const totalRules = $derived(tasksState.rules.length);
  const allReady = $derived(totalRules > 0 && checkedCount === totalRules);
  const progressPct = $derived(totalRules > 0 ? Math.round((checkedCount / totalRules) * 100) : 0);

  const calc = $derived(calculatePositionSize(activeSymbol || 'XAUUSD', tasksState.risk));

  const visibleTodos = $derived.by(() => {
    if (todoFilter === 'open') return tasksState.todos.filter((t) => !t.done);
    if (todoFilter === 'done') return tasksState.todos.filter((t) => t.done);
    return tasksState.todos;
  });

  const openTodoCount = $derived(tasksState.todos.filter((t) => !t.done).length);

  onMount(() => {
    const unsubTasks = subscribeTasks((loaded) => {
      tasksState = loaded;
    });
    const unsubPlaybook = subscribePlaybook((pb) => {
      playbookState = pb;
    });

    void loadWatchlistState()
      .then((wl) => {
        watchlistState = wl;
      })
      .catch(() => {
        // non-fatal
      });

    void fetchMacroRegime()
      .then((r) => {
        macroRegime = r;
      })
      .catch(() => {
        // non-fatal
      });

    const tz = getLocalTimeZone();
    const todayIso = getTodayIso(tz);
    void fetchCalendarWeek(getWeekStart(todayIso), tz)
      .then((res) => {
        calendarEventsByDate = res.eventsByDate ?? {};
        calendarLoaded = true;
      })
      .catch(() => {
        calendarLoaded = true;
      });

    const unsubPaper = subscribePaper((s) => {
      paperState = s;
    });
    const unsubPaperQuotes = subscribePaperQuotes((q) => {
      paperQuotes = q;
    });

    const alreadyDismissed =
      typeof localStorage !== 'undefined' && localStorage.getItem(ROUTINES_MIGRATION_KEY) === '1';
    if (!alreadyDismissed) {
      void loadRoutinesState()
        .then((rs) => {
          if (Array.isArray(rs?.items) && rs.items.length > 0) {
            legacyRituals = rs.items;
            showLegacyBanner = true;
          }
        })
        .catch(() => {
          // ignore
        });
    }

    return () => {
      unsubTasks();
      unsubPlaybook();
      unsubPaper();
      unsubPaperQuotes();
    };
  });

  function commit(next: TasksState) {
    tasksState = next;
    void saveTasksState(next);
  }

  function toggleRule(id: string) {
    commit({
      ...tasksState,
      rules: tasksState.rules.map((r) => (r.id === id ? { ...r, checked: !r.checked } : r))
    });
  }

  function addRule() {
    const label = newRuleText.trim();
    if (!label) return;
    commit({
      ...tasksState,
      rules: [...tasksState.rules, { id: makeWorkspaceId('rule'), label, checked: false }]
    });
    newRuleText = '';
  }

  function removeRule(id: string) {
    commit({
      ...tasksState,
      rules: tasksState.rules.filter((r) => r.id !== id)
    });
  }

  function resetChecklist() {
    commit({
      ...tasksState,
      rules: tasksState.rules.map((r) => ({ ...r, checked: false }))
    });
  }

  function updateRisk<K extends keyof TasksState['risk']>(key: K, value: TasksState['risk'][K]) {
    commit({
      ...tasksState,
      risk: { ...tasksState.risk, [key]: value }
    });
  }

  function fillLiveEntry() {
    if (typeof activePrice !== 'number' || !Number.isFinite(activePrice)) return;
    const raw = formatQuotePrice(activePrice, activeSymbol).replace(/,/g, '');
    updateRisk('entry', raw);
  }

  function fillPaperEquity() {
    if (paperEquity === null || !Number.isFinite(paperEquity)) return;
    updateRisk('accountBalance', Number(paperEquity.toFixed(2)));
  }

  function handleSendToPaperTicket() {
    if (!calc.valid || !calc.direction) return;
    const sym = activeFullSymbol || activeSymbol || 'OANDA:XAUUSD';
    const short = activeSymbol || 'XAUUSD';
    const spec = getPaperInstrumentSpec(sym);
    const side: OrderSide = calc.direction === 'LONG' ? 'buy' : 'sell';
    const entry = Number(tasksState.risk.entry);
    const sl = Number(tasksState.risk.stopLoss);
    const tp = Number(tasksState.risk.takeProfit);
    const units = Number((calc.lotSize * spec.lotUnits).toFixed(4));
    const liveQ = getPaperLiveQuote(sym);

    let type: OrderType = 'limit';
    if (liveQ && Number.isFinite(entry) && Math.abs(entry - liveQ.last) <= spec.pipSize * 5) {
      type = 'market';
    } else if (liveQ && Number.isFinite(entry)) {
      const isStop =
        (side === 'buy' && entry > liveQ.ask) || (side === 'sell' && entry < liveQ.bid);
      type = isStop ? 'stop' : 'limit';
    }

    pushOrderDraft({
      symbol: sym,
      shortName: short,
      side,
      type,
      price: type === 'market' ? null : entry,
      quantity: units >= 10 ? Math.round(units) : units,
      stopLoss: Number.isFinite(sl) && sl > 0 ? sl : null,
      takeProfit: Number.isFinite(tp) && tp > 0 ? tp : null,
      source: 'sizer'
    });

    paperSentFeedback = true;
    setTimeout(() => {
      paperSentFeedback = false;
    }, 2000);
  }

  async function handleLogToNotes() {
    await logPreTradePlanToNotes({
      symbol: activeSymbol || 'XAUUSD',
      fullSymbol: activeFullSymbol || activeSymbol || 'OANDA:XAUUSD',
      rules: tasksState.rules,
      risk: tasksState.risk,
      calc
    });
    loggedFeedback = true;
    setTimeout(() => {
      loggedFeedback = false;
    }, 2000);
  }

  function addTodo() {
    const title = newTodoText.trim();
    if (!title) return;
    commit({
      ...tasksState,
      todos: [
        {
          id: makeWorkspaceId('todo'),
          title,
          symbol: tagSymbolOnTodo && activeSymbol ? activeSymbol : undefined,
          done: false,
          createdAt: new Date().toISOString()
        },
        ...tasksState.todos
      ]
    });
    newTodoText = '';
  }

  function toggleTodo(id: string) {
    commit({
      ...tasksState,
      todos: tasksState.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    });
  }

  function removeTodo(id: string) {
    commit({
      ...tasksState,
      todos: tasksState.todos.filter((t) => t.id !== id)
    });
  }

  function dismissLegacyRoutines() {
    showLegacyBanner = false;
    try {
      localStorage.setItem(ROUTINES_MIGRATION_KEY, '1');
    } catch {
      // ignore
    }
  }

  function importLegacyToChecklist() {
    const existing = new Set(tasksState.rules.map((r) => r.label.trim().toLowerCase()));
    const added = legacyRituals
      .map((item) => item.label.trim())
      .filter((label) => label.length > 0 && !existing.has(label.toLowerCase()))
      .map((label) => ({
        id: makeWorkspaceId('rule'),
        label,
        checked: false
      }));
    if (added.length > 0) {
      commit({ ...tasksState, rules: [...tasksState.rules, ...added] });
    }
    dismissLegacyRoutines();
  }

  function importLegacyToTodo() {
    const existing = new Set(tasksState.todos.map((t) => t.title.trim().toLowerCase()));
    const nowIso = new Date().toISOString();
    const added = legacyRituals
      .map((item) => item.label.trim())
      .filter((title) => title.length > 0 && !existing.has(title.toLowerCase()))
      .map((title) => ({
        id: makeWorkspaceId('todo'),
        title,
        symbol: 'Routine',
        done: false,
        createdAt: nowIso
      }));
    if (added.length > 0) {
      commit({ ...tasksState, todos: [...added, ...tasksState.todos] });
    }
    dismissLegacyRoutines();
  }
</script>

<PanelShell {theme} title="Tasks" {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="3.75" />
      <path d="M6.75 10.35 9 12.6l4.25-4.85" />
    </svg>
  {/snippet}

  <div class="tasks-panel" class:light={theme === 'light'}>
    <!-- Market Session Clock moved from retired Routines panel -->
    <SessionClockStrip {theme} />

    {#if showLegacyBanner && legacyRituals.length > 0}
      <div class="legacy-banner">
        <div class="lb-text">
          Routines moved here ({legacyRituals.length} saved rituals kept in <code>routines.json</code>). Import them?
        </div>
        <div class="lb-acts">
          <button class="lb-btn" type="button" onclick={importLegacyToChecklist}>To Checklist</button>
          <button class="lb-btn" type="button" onclick={importLegacyToTodo}>To To-Do</button>
          <button class="lb-btn ghost" type="button" onclick={dismissLegacyRoutines}>Dismiss</button>
        </div>
      </div>
    {/if}

    <!-- Segmented tab header -->
    <div class="tab-bar" role="tablist">
      <button
        class="seg-tab"
        class:active={activeTab === 'pretrade'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'pretrade'}
        onclick={() => (activeTab = 'pretrade')}
      >
        Pre-Trade Gate
      </button>
      <button
        class="seg-tab"
        class:active={activeTab === 'todo'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'todo'}
        onclick={() => (activeTab = 'todo')}
      >
        To-Do {#if openTodoCount > 0}<span class="tab-count">{openTodoCount}</span>{/if}
      </button>
    </div>

    <div class="scroll-body">
      {#if activeTab === 'pretrade'}
        <!-- Readiness card -->
        <div class="section-card">
          <div class="card-head">
            <div class="head-left">
              <span class="card-title">Checklist</span>
              <span class="sym-pill">{activeSymbol || 'XAUUSD'}</span>
            </div>
            <div class="head-right">
              <span class="score-badge" class:ready={allReady}>
                {checkedCount}/{totalRules} {allReady ? 'Ready' : ''}
              </span>
              {#if checkedCount > 0}
                <button class="text-btn" type="button" onclick={resetChecklist}>Reset</button>
              {/if}
            </div>
          </div>

          <div class="progress-track">
            <div class="progress-fill" class:ready={allReady} style:width="{progressPct}%"></div>
          </div>

          <div class="rule-list">
            {#each tasksState.rules as rule (rule.id)}
              <div class="rule-row" class:checked={rule.checked}>
                <button
                  class="check-toggle"
                  type="button"
                  aria-pressed={rule.checked}
                  onclick={() => toggleRule(rule.id)}
                >
                  <span class="check-box" class:checked={rule.checked}>
                    {#if rule.checked}
                      <svg viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M2.5 6.2 5 8.7 9.5 3.5" />
                      </svg>
                    {/if}
                  </span>
                  <span class="rule-label">{rule.label}</span>
                </button>
                <button
                  class="del-btn"
                  type="button"
                  title="Remove rule"
                  aria-label="Remove rule"
                  onclick={() => removeRule(rule.id)}
                >
                  ×
                </button>
              </div>
            {/each}
          </div>

          <div class="add-inline">
            <input
              type="text"
              placeholder="+ Add entry rule..."
              bind:value={newRuleText}
              onkeydown={(e) => {
                if (e.key === 'Enter') addRule();
              }}
            />
            {#if newRuleText.trim()}
              <button class="add-submit" type="button" onclick={addRule}>Add</button>
            {/if}
          </div>
        </div>

        <!-- Live Pre-Trade Guardrail (Calendar Shield + Macro Alignment + Playbook Record) -->
        <div class="section-card guardrail-card">
          <div class="card-head">
            <div class="head-left">
              <span class="card-title">Live Guardrail</span>
              <span class="sym-pill">{activeSymbol || 'XAUUSD'}</span>
            </div>
            <span
              class="guard-status"
              class:warn={guardrailStatus.tone === 'warn'}
              class:ok={guardrailStatus.tone === 'ok'}
            >
              {guardrailStatus.label}
            </span>
          </div>

          <div class="guard-rows">
            <div class="guard-row">
              <span
                class="guard-dot"
                class:danger={upcomingNewsRisk?.level === 'danger'}
                class:warn={upcomingNewsRisk?.level === 'caution'}
                class:ok={calendarLoaded && !upcomingNewsRisk}
              ></span>
              <span class="guard-key">News</span>
              <span class="guard-val">
                {#if upcomingNewsRisk}
                  {upcomingNewsRisk.event.country} {upcomingNewsRisk.event.title} in {upcomingNewsRisk.countdownLabel}
                {:else if calendarLoaded}
                  Clear — no red-folder event in 12h
                {:else}
                  Checking schedule...
                {/if}
              </span>
            </div>

            <div class="guard-row">
              <span
                class="guard-dot"
                class:ok={macroAlignment === 'aligned' || (macroAlignment === 'neutral' && symbolMacro?.bias === 'tailwind')}
                class:warn={macroAlignment === 'conflict'}
                class:danger={macroAlignment === 'neutral' && symbolMacro?.bias === 'headwind'}
              ></span>
              <span class="guard-key">Macro</span>
              <span class="guard-val">
                {#if symbolMacro}
                  {#if macroAlignment === 'aligned'}
                    {symbolMacro.bias === 'tailwind' ? 'Tailwind' : 'Headwind'} aligns with {symbolWatchlistBias} bias
                  {:else if macroAlignment === 'conflict'}
                    Conflict: {symbolMacro.bias === 'tailwind' ? 'Tailwind' : 'Headwind'} vs {symbolWatchlistBias} bias
                  {:else}
                    {symbolMacro.reason}
                  {/if}
                {:else}
                  Reading macro yields & DXY...
                {/if}
              </span>
            </div>

            <div class="guard-row">
              <span
                class="guard-dot"
                class:ok={symbolPlaybookEdge.totalR !== null && symbolPlaybookEdge.totalR > 0}
                class:danger={symbolPlaybookEdge.totalR !== null && symbolPlaybookEdge.totalR < 0}
              ></span>
              <span class="guard-key">Edge</span>
              <span class="guard-val">
                {#if symbolPlaybookEdge.totalLogged > 0}
                  {#if symbolPlaybookEdge.winRatePct !== null}{symbolPlaybookEdge.winRatePct}% Win · {/if}{#if symbolPlaybookEdge.totalR !== null}{formatRMultiple(symbolPlaybookEdge.totalR)} · {/if}{symbolPlaybookEdge.totalLogged} {symbolPlaybookEdge.totalLogged === 1 ? 'setup' : 'setups'}
                {:else}
                  No {activeSymbol || 'XAUUSD'} setups logged in Playbook
                {/if}
              </span>
            </div>
          </div>
        </div>

        <!-- Position Size & Risk Calculator -->
        <div class="section-card">
          <div class="card-head">
            <div class="head-left">
              <span class="card-title">Position Size</span>
              <span class="spec-hint">{calc.specLabel}</span>
            </div>
            <button
              class="text-btn"
              type="button"
              onclick={() => (showContractOverride = !showContractOverride)}
            >
              {showContractOverride ? 'Auto' : 'Contract'}
            </button>
          </div>

          {#if showContractOverride}
            <div class="field-single">
              <label for="tk-contract">Contract size / lot (blank = auto)</label>
              <input
                id="tk-contract"
                type="number"
                step="any"
                placeholder="e.g. 100 for Gold, 100000 for FX"
                value={tasksState.risk.contractSizeOverride}
                oninput={(e) =>
                  updateRisk('contractSizeOverride', (e.currentTarget as HTMLInputElement).value)
                }
              />
            </div>
          {/if}

          <div class="calc-grid">
            <div class="field">
              <div class="label-row">
                <label for="tk-bal">Account ($)</label>
                {#if paperEquity !== null}
                  <button class="live-fill" type="button" onclick={fillPaperEquity}>Paper</button>
                {/if}
              </div>
              <input
                id="tk-bal"
                type="number"
                step="any"
                min="0"
                value={tasksState.risk.accountBalance}
                oninput={(e) =>
                  updateRisk('accountBalance', Number((e.currentTarget as HTMLInputElement).value) || 0)
                }
              />
            </div>

            <div class="field">
              <label for="tk-risk">Risk (%)</label>
              <input
                id="tk-risk"
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={tasksState.risk.riskPercent}
                oninput={(e) =>
                  updateRisk('riskPercent', Number((e.currentTarget as HTMLInputElement).value) || 0)
                }
              />
            </div>

            <div class="field">
              <div class="label-row">
                <label for="tk-entry">Entry</label>
                {#if typeof activePrice === 'number' && Number.isFinite(activePrice)}
                  <button class="live-fill" type="button" onclick={fillLiveEntry}>Use live</button>
                {/if}
              </div>
              <input
                id="tk-entry"
                type="number"
                step="any"
                placeholder="Price"
                value={tasksState.risk.entry}
                oninput={(e) => updateRisk('entry', (e.currentTarget as HTMLInputElement).value)}
              />
            </div>

            <div class="field">
              <label for="tk-sl">Stop Loss</label>
              <input
                id="tk-sl"
                type="number"
                step="any"
                placeholder="Invalidation"
                value={tasksState.risk.stopLoss}
                oninput={(e) => updateRisk('stopLoss', (e.currentTarget as HTMLInputElement).value)}
              />
            </div>
          </div>

          <div class="field-single">
            <label for="tk-tp">Take Profit (optional, for R:R)</label>
            <input
              id="tk-tp"
              type="number"
              step="any"
              placeholder="Target price"
              value={tasksState.risk.takeProfit}
              oninput={(e) => updateRisk('takeProfit', (e.currentTarget as HTMLInputElement).value)}
            />
          </div>

          <div class="calc-result" class:valid={calc.valid}>
            <div class="result-top">
              <div>
                <div class="res-label">Recommended Size</div>
                <div class="res-lots">
                  {calc.valid ? `${calc.lotSize.toFixed(2)} lots` : '—'}
                </div>
              </div>
              {#if calc.direction}
                <span class="dir-pill" class:long={calc.direction === 'LONG'} class:short={calc.direction === 'SHORT'}>
                  {calc.direction}
                </span>
              {/if}
            </div>

            <div class="result-metrics">
              <div class="metric">
                <span class="m-lbl">Risk</span>
                <span class="m-val">${calc.riskAmount.toFixed(2)}</span>
              </div>
              <div class="metric">
                <span class="m-lbl">SL Dist</span>
                <span class="m-val">
                  {calc.valid ? `${calc.slPips.toFixed(1)} ${calc.pipName}` : '—'}
                </span>
              </div>
              <div class="metric">
                <span class="m-lbl">R:R</span>
                <span
                  class="m-val"
                  class:good-rr={calc.rrRatio !== null && calc.rrRatio >= 2}
                  class:weak-rr={calc.rrRatio !== null && calc.rrRatio < 1.5}
                >
                  {calc.rrRatio !== null ? `1 : ${calc.rrRatio.toFixed(2)}` : '—'}
                </span>
              </div>
            </div>
          </div>

          <div class="plan-actions">
            <button
              class="log-btn primary-paper"
              type="button"
              disabled={!calc.valid || !calc.direction}
              onclick={handleSendToPaperTicket}
            >
              {paperSentFeedback ? 'Sent to Ticket' : 'Send to Paper Ticket'}
            </button>
            <button class="log-btn" type="button" onclick={() => void handleLogToNotes()}>
              {loggedFeedback ? 'Saved to Notes' : 'Log to Notes'}
            </button>
          </div>
        </div>
      {:else}
        <!-- Trading To-Do tab -->
        <div class="section-card">
          <div class="todo-compose">
            <input
              type="text"
              placeholder="Add trading task (e.g. Backtest NY open)..."
              bind:value={newTodoText}
              onkeydown={(e) => {
                if (e.key === 'Enter') addTodo();
              }}
            />
            <div class="todo-compose-bar">
              <button
                class="tag-toggle"
                class:active={tagSymbolOnTodo}
                type="button"
                onclick={() => (tagSymbolOnTodo = !tagSymbolOnTodo)}
              >
                #{activeSymbol || 'XAUUSD'}
              </button>
              <button class="add-submit" type="button" disabled={!newTodoText.trim()} onclick={addTodo}>
                Add task
              </button>
            </div>
          </div>

          <div class="filter-pills">
            {#each [
              { id: 'open', label: 'Open' },
              { id: 'done', label: 'Done' },
              { id: 'all', label: 'All' }
            ] as f (f.id)}
              <button
                class="fpill"
                class:active={todoFilter === f.id}
                type="button"
                onclick={() => (todoFilter = f.id as TodoFilter)}
              >
                {f.label}
              </button>
            {/each}
          </div>

          {#if visibleTodos.length === 0}
            <div class="empty-msg">
              {todoFilter === 'done' ? 'No completed tasks yet' : 'All caught up'}
            </div>
          {:else}
            <div class="rule-list">
              {#each visibleTodos as todo (todo.id)}
                <div class="rule-row" class:checked={todo.done}>
                  <button
                    class="check-toggle"
                    type="button"
                    aria-pressed={todo.done}
                    onclick={() => toggleTodo(todo.id)}
                  >
                    <span class="check-box" class:checked={todo.done}>
                      {#if todo.done}
                        <svg viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M2.5 6.2 5 8.7 9.5 3.5" />
                        </svg>
                      {/if}
                    </span>
                    <span class="todo-text-wrap">
                      <span class="rule-label">{todo.title}</span>
                      {#if todo.symbol}
                        <span class="todo-sym">{todo.symbol}</span>
                      {/if}
                    </span>
                  </button>
                  <button
                    class="del-btn"
                    type="button"
                    title="Delete task"
                    onclick={() => removeTodo(todo.id)}
                  >
                    ×
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</PanelShell>

<style>
  .tasks-panel {
    --tk-bg: var(--dark-bg-panel);
    --tk-card: var(--dark-bg-surface);
    --tk-surface: var(--dark-bg-surface-alt);
    --tk-border: var(--dark-border);
    --tk-border-soft: var(--dark-border-subtle);
    --tk-text: var(--dark-text-primary);
    --tk-secondary: var(--dark-text-secondary);
    --tk-hover: var(--dark-hover);
    --tk-tab-bg: var(--dark-bg-surface-alt);
    --tk-tab-active: var(--dark-bg-active);
    --tk-btn-bg: var(--dark-cta-bg);
    --tk-btn-fg: var(--dark-cta-fg);

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--tk-text);
    background: var(--tk-bg);
  }

  .tasks-panel.light {
    --tk-bg: #ffffff;
    --tk-card: #ffffff;
    --tk-surface: #f5f6f8;
    --tk-border: #e0e3eb;
    --tk-border-soft: #eceef2;
    --tk-text: #131722;
    --tk-secondary: #6a6d78;
    --tk-hover: rgba(0, 0, 0, 0.03);
    --tk-tab-bg: #f2f3f5;
    --tk-tab-active: #ffffff;
    --tk-btn-bg: #131722;
    --tk-btn-fg: #ffffff;
  }

  .tab-bar {
    margin: 4px 14px 10px;
    padding: 3px;
    border-radius: 9px;
    background: var(--tk-tab-bg);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px;
    flex: 0 0 auto;
    user-select: none;
  }

  .seg-tab {
    height: 30px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--tk-secondary);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease;
  }

  .seg-tab.active {
    background: var(--tk-tab-active);
    color: var(--tk-text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }

  .tab-count {
    padding: 1px 6px;
    border-radius: 99px;
    font-size: 10.5px;
    background: var(--tk-border-soft);
    color: var(--tk-text);
  }

  .scroll-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    scroll-behavior: smooth;
    padding: 0 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .scroll-body::-webkit-scrollbar {
    display: none;
  }

  .section-card {
    padding: 12px;
    border-radius: 11px;
    border: 1px solid var(--tk-border);
    background: var(--tk-card);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .head-left,
  .head-right {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .card-title {
    font-size: 13px;
    font-weight: 700;
  }

  .sym-pill,
  .spec-hint {
    padding: 2px 7px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--tk-secondary);
    background: var(--tk-surface);
  }

  .score-badge {
    font-size: 11.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--tk-secondary);
  }

  .score-badge.ready {
    color: #089981;
  }

  .text-btn {
    border: 0;
    background: transparent;
    color: var(--tk-secondary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
  }

  .text-btn:hover {
    color: var(--tk-text);
    background: var(--tk-hover);
  }

  .progress-track {
    height: 4px;
    border-radius: 99px;
    background: var(--tk-surface);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    border-radius: 99px;
    background: #2962ff;
    transition: width 180ms ease, background-color 180ms ease;
  }

  .progress-fill.ready {
    background: #089981;
  }

  .rule-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .rule-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 4px;
    border-radius: 7px;
    transition: background-color 120ms ease;
  }

  .rule-row:hover {
    background: var(--tk-hover);
  }

  .check-toggle {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--tk-text);
    display: flex;
    align-items: flex-start;
    gap: 9px;
    text-align: left;
    font: inherit;
    font-size: 12.5px;
    line-height: 1.38;
    cursor: pointer;
    padding: 2px;
  }

  .check-box {
    width: 16px;
    height: 16px;
    margin-top: 1px;
    flex: 0 0 16px;
    border-radius: 5px;
    border: 1.5px solid var(--tk-border);
    display: grid;
    place-items: center;
    transition: background-color 130ms ease, border-color 130ms ease;
  }

  .check-box.checked {
    border-color: #089981;
    background: #089981;
    color: #ffffff;
  }

  .check-box svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .rule-row.checked .rule-label {
    color: var(--tk-secondary);
    text-decoration: line-through;
  }

  .del-btn {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--tk-secondary);
    font-size: 15px;
    opacity: 0;
    cursor: pointer;
    transition: opacity 120ms ease, color 120ms ease;
  }

  .rule-row:hover .del-btn {
    opacity: 1;
  }

  .del-btn:hover {
    color: #f23645;
  }

  .add-inline {
    display: flex;
    gap: 6px;
    padding-top: 4px;
    border-top: 1px solid var(--tk-border-soft);
  }

  .add-inline input,
  .todo-compose input,
  .field input,
  .field-single input {
    width: 100%;
    box-sizing: border-box;
    height: 30px;
    padding: 0 9px;
    border-radius: 7px;
    border: 1px solid var(--tk-border);
    background: var(--tk-surface);
    color: var(--tk-text);
    font: inherit;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    outline: none;
  }

  .add-inline input {
    border-color: transparent;
    background: transparent;
    padding: 0 4px;
  }

  .add-inline input:focus {
    border-color: var(--tk-border);
    background: var(--tk-surface);
    padding: 0 9px;
  }

  .add-submit {
    height: 30px;
    padding: 0 11px;
    flex: 0 0 auto;
    border: 0;
    border-radius: 7px;
    background: var(--tk-btn-bg);
    color: var(--tk-btn-fg);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .add-submit:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Risk calc */
  .calc-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .field,
  .field-single {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field label,
  .field-single label {
    font-size: 11px;
    color: var(--tk-secondary);
  }

  .label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .live-fill {
    border: 0;
    background: transparent;
    color: #2962ff;
    font: inherit;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }

  .calc-result {
    padding: 10px 11px;
    border-radius: 9px;
    background: var(--tk-surface);
    border: 1px solid var(--tk-border-soft);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .result-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .res-label {
    font-size: 11px;
    color: var(--tk-secondary);
  }

  .res-lots {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }

  .dir-pill {
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
  }

  .dir-pill.long {
    background: rgba(8, 153, 129, 0.15);
    color: #089981;
  }

  .dir-pill.short {
    background: rgba(242, 54, 69, 0.15);
    color: #f23645;
  }

  .result-metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding-top: 7px;
    border-top: 1px solid var(--tk-border-soft);
  }

  .metric {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .m-lbl {
    font-size: 10.5px;
    color: var(--tk-secondary);
  }

  .m-val {
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .good-rr {
    color: #089981;
  }

  .weak-rr {
    color: #f23645;
  }

  .plan-actions {
    display: grid;
    grid-template-columns: 1.25fr 1fr;
    gap: 6px;
  }

  .log-btn {
    height: 32px;
    border: 1px solid var(--tk-border);
    border-radius: 8px;
    background: transparent;
    color: var(--tk-text);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 130ms ease, opacity 130ms ease;
  }

  .log-btn.primary-paper {
    background: var(--tk-btn-bg);
    color: var(--tk-btn-fg);
    border-color: transparent;
  }

  .log-btn:disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }

  .log-btn:hover:not(:disabled) {
    background: var(--tk-hover);
  }

  .log-btn.primary-paper:hover:not(:disabled) {
    background: var(--tk-btn-bg);
    opacity: 0.9;
  }

  .legacy-banner {
    padding: 8px 14px;
    border-bottom: 1px solid var(--tk-border);
    background: var(--tk-surface);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .lb-text {
    font-size: 11px;
    line-height: 1.38;
    color: var(--tk-secondary);
  }

  .lb-text code {
    font-size: 10.5px;
    color: var(--tk-text);
  }

  .lb-acts {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .lb-btn {
    height: 23px;
    padding: 0 8px;
    border-radius: 5px;
    border: 1px solid var(--tk-border);
    background: transparent;
    color: var(--tk-text);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .lb-btn:hover {
    background: var(--tk-hover);
  }

  .lb-btn.ghost {
    border-color: transparent;
    color: var(--tk-secondary);
  }

  /* To-Do */
  .todo-compose {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .todo-compose-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .tag-toggle {
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--tk-border);
    border-radius: 6px;
    background: transparent;
    color: var(--tk-secondary);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .tag-toggle.active {
    color: var(--tk-text);
    background: var(--tk-surface);
  }

  .filter-pills {
    display: flex;
    gap: 5px;
  }

  .fpill {
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: 99px;
    background: var(--tk-surface);
    color: var(--tk-secondary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
  }

  .fpill.active {
    background: var(--tk-btn-bg);
    color: var(--tk-btn-fg);
  }

  .todo-text-wrap {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .todo-sym {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--tk-secondary);
  }

  .empty-msg {
    padding: 28px 12px;
    text-align: center;
    font-size: 12.5px;
    color: var(--tk-secondary);
  }

  /* Live Pre-Trade Guardrail */
  .guardrail-card {
    gap: 8px;
  }

  .guard-status {
    padding: 2px 7px;
    border-radius: 99px;
    font-size: 10.5px;
    font-weight: 600;
    background: var(--tk-surface);
    color: var(--tk-secondary);
  }

  .guard-status.ok {
    background: rgba(8, 153, 129, 0.14);
    color: #089981;
  }

  .guard-status.warn {
    background: rgba(245, 158, 11, 0.16);
    color: #f59e0b;
  }

  .guard-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .guard-row {
    display: flex;
    align-items: baseline;
    gap: 7px;
    font-size: 11.5px;
    line-height: 1.35;
  }

  .guard-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 6px;
    border-radius: 50%;
    background: var(--tk-secondary);
    opacity: 0.55;
    transform: translateY(-1px);
  }

  .guard-dot.ok {
    background: #089981;
    opacity: 1;
  }

  .guard-dot.warn {
    background: #f59e0b;
    opacity: 1;
  }

  .guard-dot.danger {
    background: #f23645;
    opacity: 1;
  }

  .guard-key {
    width: 38px;
    flex: 0 0 38px;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--tk-secondary);
  }

  .guard-val {
    flex: 1;
    min-width: 0;
    color: var(--tk-text);
    font-variant-numeric: tabular-nums;
  }
</style>
