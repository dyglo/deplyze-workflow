<script lang="ts">
  import { onMount, tick } from 'svelte';
  import PanelShell from './PanelShell.svelte';
  import { getLocalTimeZone } from '../calendar/api';
  import {
    captureActiveChart,
    fileToDataUrl,
    loadAiChats,
    loadAiPrefs,
    makeAiId,
    saveAiChats,
    saveAiPrefs,
    saveAnalysisToNotes,
    streamAiChat
  } from '../ai/api';
  import {
    buildWorkspaceSnapshot,
    canUndoClientAction,
    executeApprovalCard,
    executeClientAction,
    undoClientAction,
    type AgentHostCallbacks
  } from '../ai/actionBus';
  import { renderMarkdown } from '../ai/markdown';
  import { saveAiAnalysisToPlaybook } from '../playbook/store';
  import { openSavedStrategy, openStrategyFromAi } from '../strategy/store';
  import type { BacktestReport } from '../strategy/types';
  import {
    AI_EFFORTS,
    AI_MODELS,
    type AiAgentStep,
    type AiApprovalCard,
    type AiClientAction,
    type AiConversation,
    type AiEffort,
    type AiMessage,
    type AiModelId,
    type AiRangeSelectionContext,
    type AiSourceLink,
    type AiWebSearchMode,
    type PendingImage,
    type PendingRangeAnalysisRequest
  } from '../ai/types';

  interface Props {
    theme: 'dark' | 'light';
    activeSymbol: string;
    activeFullSymbol: string;
    activeInterval?: string;
    activePrice?: number;
    activeChangePercent?: number;
    pendingRangeAnalysis?: PendingRangeAnalysisRequest | null;
    onConsumePendingRangeAnalysis?: () => void;
    agentHost?: AgentHostCallbacks;
    onClose: () => void;
  }

  let {
    theme,
    activeSymbol,
    activeFullSymbol,
    activeInterval = 'D',
    activePrice,
    activeChangePercent,
    pendingRangeAnalysis = null,
    onConsumePendingRangeAnalysis,
    agentHost,
    onClose
  }: Props = $props();

  const initialPrefs = loadAiPrefs();
  const timeZone = getLocalTimeZone();

  let chats = $state<AiConversation[]>([]);
  let chatsLoaded = $state(false);
  let activeChatId = $state<string | null>(null);
  let lastConsumedRangeId = '';
  let draft = $state('');
  let selectedModel = $state<AiModelId>(initialPrefs.model);
  let selectedEffort = $state<AiEffort>(initialPrefs.effort);
  let autoCapture = $state<boolean>(initialPrefs.autoCapture);
  let webSearchMode = $state<AiWebSearchMode>(initialPrefs.webSearchMode);

  let pendingImages = $state<PendingImage[]>([]);
  let isStreaming = $state(false);
  let streamStatus = $state('');
  let errorBanner = $state<string | null>(null);

  let chatMenuOpen = $state(false);
  let modelMenuOpen = $state(false);
  let copiedMsgId = $state<string | null>(null);
  let savedNoteMsgId = $state<string | null>(null);
  let savedPlaybookMsgId = $state<string | null>(null);

  // Keep latest captured chart per assistant message ID in memory so "Save to Notes" includes the screenshot
  const capturedChartsByMsgId = new Map<string, string>();
  let activeAbort: AbortController | null = null;

  let messagesEl: HTMLDivElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let fileInputEl: HTMLInputElement | undefined = $state();

  const activeChat = $derived(
    activeChatId ? (chats.find((c) => c.id === activeChatId) ?? null) : null
  );
  const messages = $derived(activeChat ? activeChat.messages : []);
  const currentModelObj = $derived(
    AI_MODELS.find((m) => m.id === selectedModel) ?? AI_MODELS[0]
  );
  const currentEffortLabel = $derived(
    AI_EFFORTS.find((e) => e.id === selectedEffort)?.label ?? 'Medium'
  );
  const canSend = $derived(draft.trim().length > 0 && !isStreaming);
  const formattedInterval = $derived.by(() => {
    const raw = (activeInterval || 'D').trim().toUpperCase();
    if (raw === '1') return '1m';
    if (raw === '5') return '5m';
    if (raw === '15') return '15m';
    if (raw === '30') return '30m';
    if (raw === '60') return '1h';
    if (raw === '240') return '4h';
    if (raw === 'D') return '1D';
    if (raw === 'W') return '1W';
    return activeInterval || '1D';
  });

  const SUGGESTIONS = $derived([
    `Prep a 4-chart desk & alerts around ${activeSymbol || 'XAUUSD'}`,
    'Scan OANDA markets for trapped-crowd dislocations',
    `Plan & size a 1% risk trade on ${activeSymbol || 'XAUUSD'}`,
    `Build & backtest a strategy on ${activeSymbol || 'XAUUSD'}`,
    'Audit my open positions & pre-trade risk',
    `What's the latest on ${activeSymbol || 'XAUUSD'}?`
  ]);

  onMount(() => {
    void loadAiChats().then((loaded) => {
      chats = loaded;
      chatsLoaded = true;
    });

    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (chatMenuOpen && !target.closest('[data-chat-menu]')) {
        chatMenuOpen = false;
      }
      if (modelMenuOpen && !target.closest('[data-model-menu]')) {
        modelMenuOpen = false;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        chatMenuOpen = false;
        modelMenuOpen = false;
      }
    };

    window.addEventListener('pointerdown', onDocPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      activeAbort?.abort();
      window.removeEventListener('pointerdown', onDocPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  function persistPrefs() {
    saveAiPrefs({
      model: selectedModel,
      effort: selectedEffort,
      autoCapture,
      webSearchMode
    });
  }

  function selectModel(id: AiModelId) {
    selectedModel = id;
    persistPrefs();
  }

  function selectEffort(id: AiEffort) {
    selectedEffort = id;
    persistPrefs();
  }

  function toggleAutoCapture() {
    autoCapture = !autoCapture;
    persistPrefs();
  }

  function cycleWebSearch() {
    webSearchMode =
      webSearchMode === 'auto' ? 'on' : webSearchMode === 'on' ? 'off' : 'auto';
    persistPrefs();
  }

  function startNewChat() {
    if (isStreaming) stopStreaming();
    activeChatId = null;
    errorBanner = null;
    chatMenuOpen = false;
    pendingImages = [];
    void tick().then(() => textareaEl?.focus());
  }

  function openChat(id: string) {
    if (isStreaming) stopStreaming();
    activeChatId = id;
    errorBanner = null;
    chatMenuOpen = false;
    void scrollToBottom();
  }

  function deleteChat(id: string, e: MouseEvent) {
    e.stopPropagation();
    const next = chats.filter((c) => c.id !== id);
    chats = next;
    if (activeChatId === id) {
      activeChatId = null;
    }
    void saveAiChats(next);
  }

  function stopStreaming() {
    activeAbort?.abort();
    activeAbort = null;
    isStreaming = false;
    streamStatus = '';
  }

  async function scrollToBottom() {
    await tick();
    if (messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function resizeTextarea() {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 132)}px`;
  }

  async function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    await addImageFiles(files);
  }

  async function handleFileSelect(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const files = Array.from(input.files);
    input.value = '';
    await addImageFiles(files);
  }

  async function addImageFiles(files: File[]) {
    const remaining = Math.max(0, 3 - pendingImages.length);
    for (const file of files.slice(0, remaining)) {
      try {
        const dataUrl = await fileToDataUrl(file);
        pendingImages = [
          ...pendingImages,
          {
            id: makeAiId('img'),
            dataUrl,
            label: file.name || 'Chart image'
          }
        ];
      } catch {
        // Ignore unreadable image
      }
    }
  }

  function removePendingImage(id: string) {
    pendingImages = pendingImages.filter((img) => img.id !== id);
  }

  function formatTime(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(iso));
    } catch {
      return '';
    }
  }

  function formatRelativeDate(iso: string): string {
    try {
      const d = new Date(iso);
      const diffMs = Date.now() - d.getTime();
      const mins = Math.floor(diffMs / 60_000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
    } catch {
      return '';
    }
  }

  function hostLabel(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'Source';
    }
  }

  async function copyReply(msg: AiMessage) {
    try {
      await navigator.clipboard.writeText(msg.content);
      copiedMsgId = msg.id;
      setTimeout(() => {
        if (copiedMsgId === msg.id) copiedMsgId = null;
      }, 1600);
    } catch {
      // ignore
    }
  }

  async function handleSaveToNotes(msg: AiMessage, idx: number) {
    const prevUser = idx > 0 && messages[idx - 1]?.role === 'user' ? messages[idx - 1].content : '';
    try {
      await saveAnalysisToNotes({
        symbol: activeChat?.symbol || activeSymbol || 'XAUUSD',
        fullSymbol: activeChat?.fullSymbol || activeFullSymbol || 'OANDA:XAUUSD',
        prompt: prevUser,
        analysis: msg.content,
        chartDataUrl: capturedChartsByMsgId.get(msg.id) ?? null
      });
      savedNoteMsgId = msg.id;
      setTimeout(() => {
        if (savedNoteMsgId === msg.id) savedNoteMsgId = null;
      }, 2200);
    } catch {
      errorBanner = 'Could not save analysis to Notes.';
    }
  }

  async function handleSaveToPlaybook(msg: AiMessage, idx: number) {
    const prevUser = idx > 0 && messages[idx - 1]?.role === 'user' ? messages[idx - 1].content : '';
    try {
      await saveAiAnalysisToPlaybook({
        symbol: activeChat?.symbol || activeSymbol || 'XAUUSD',
        fullSymbol: activeChat?.fullSymbol || activeFullSymbol || 'OANDA:XAUUSD',
        prompt: prevUser,
        analysis: msg.content,
        chartDataUrl: capturedChartsByMsgId.get(msg.id) ?? null
      });
      savedPlaybookMsgId = msg.id;
      setTimeout(() => {
        if (savedPlaybookMsgId === msg.id) savedPlaybookMsgId = null;
      }, 2200);
    } catch {
      errorBanner = 'Could not save analysis to Playbook.';
    }
  }

  function updateAssistantMessage(
    chatId: string,
    msgId: string,
    updater: (msg: AiMessage) => AiMessage
  ) {
    chats = chats.map((c) => {
      if (c.id !== chatId) return c;
      return {
        ...c,
        updatedAt: new Date().toISOString(),
        messages: c.messages.map((m) => (m.id === msgId ? updater(m) : m))
      };
    });
  }

  function formatIntervalLabel(rawIv: string | undefined): string {
    const raw = (rawIv || 'D').trim().toUpperCase();
    if (raw === '1') return '1m';
    if (raw === '5') return '5m';
    if (raw === '15') return '15m';
    if (raw === '30') return '30m';
    if (raw === '60') return '1h';
    if (raw === '240') return '4h';
    if (raw === 'D') return '1D';
    if (raw === 'W') return '1W';
    return rawIv || '1D';
  }

  function compactRangeChipLabel(r: AiRangeSelectionContext): string {
    const s = r.startLabel.replace(/^[A-Za-z]{3}\s+/, '').replace(/\s+'\d{2}/, '');
    const e = r.endLabel.replace(/^[A-Za-z]{3}\s+/, '').replace(/\s+'\d{2}/, '');
    return `${s} → ${e}`;
  }

  function clearActiveChatRangeScope() {
    if (!activeChatId) return;
    chats = chats.map((c) => (c.id === activeChatId ? { ...c, rangeContext: undefined } : c));
    void saveAiChats(chats);
  }

  function formatCardPrice(val: number | null | undefined, symbol: string): string {
    if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
    const upper = symbol.toUpperCase();
    const isJpy = upper.includes('JPY');
    const isFxMajor =
      !upper.includes('XAU') &&
      !upper.includes('XAG') &&
      !upper.includes('OIL') &&
      !upper.includes('BTC') &&
      !upper.includes('ETH') &&
      !upper.includes('US30') &&
      !upper.includes('NAS') &&
      !upper.includes('SPX') &&
      !upper.includes('500') &&
      !upper.includes('DXY') &&
      /^[A-Z]{6}$/.test(upper.replace(/.*:/, ''));
    const decimals = isJpy ? 3 : isFxMajor ? 5 : Math.abs(val) < 10 ? 4 : 2;
    return val.toFixed(decimals);
  }

  async function handleUndoAction(chatId: string, msgId: string, actionId: string) {
    const ok = await undoClientAction(actionId);
    if (!ok) return;
    updateAssistantMessage(chatId, msgId, (m) => ({
      ...m,
      executedActions: (m.executedActions ?? []).map((a) =>
        a.id === actionId ? { ...a, status: 'undone', canUndo: false } : a
      )
    }));
    await saveAiChats(chats);
  }

  async function handleApprovalAction(
    chatId: string,
    msgId: string,
    card: AiApprovalCard,
    mode: 'stage' | 'execute' | 'dismiss'
  ) {
    if (mode === 'dismiss') {
      updateAssistantMessage(chatId, msgId, (m) => ({
        ...m,
        approvalCards: (m.approvalCards ?? []).map((c) =>
          c.id === card.id ? { ...c, status: 'dismissed', statusNote: 'Dismissed' } : c
        )
      }));
      await saveAiChats(chats);
      return;
    }

    const res = executeApprovalCard(card, mode);
    if (!res.ok) {
      errorBanner = res.note;
      return;
    }

    errorBanner = null;
    updateAssistantMessage(chatId, msgId, (m) => ({
      ...m,
      approvalCards: (m.approvalCards ?? []).map((c) => {
        if (c.id !== card.id) return c;
        if (c.kind === 'stage_paper_order') {
          return { ...c, status: res.status, statusNote: res.note };
        }
        return { ...c, status: 'executed', statusNote: res.note };
      })
    }));
    await saveAiChats(chats);
  }

  // Consume incoming chart range analysis requests once persisted chats have loaded
  $effect(() => {
    const req = pendingRangeAnalysis;
    if (!chatsLoaded || !req || req.id === lastConsumedRangeId) return;
    lastConsumedRangeId = req.id;
    onConsumePendingRangeAnalysis?.();
    void runPendingRangeAnalysis(req);
  });

  async function runPendingRangeAnalysis(req: PendingRangeAnalysisRequest) {
    if (isStreaming) {
      stopStreaming();
    }
    const existing = activeChat;
    const sameRange =
      existing?.rangeContext &&
      existing.fullSymbol === req.fullSymbol &&
      Math.abs(existing.rangeContext.startTs - req.range.startTs) < 60 &&
      Math.abs(existing.rangeContext.endTs - req.range.endTs) < 60;

    if (!sameRange) {
      activeChatId = null;
    }

    await sendPrompt(req.prompt, {
      symbolOverride: req.symbol,
      fullSymbolOverride: req.fullSymbol,
      intervalOverride: req.interval,
      rangeOverride: req.range,
      preCapturedChartUrl: req.chartDataUrl
    });
  }

  async function sendPrompt(
    explicitText?: string,
    options?: {
      symbolOverride?: string;
      fullSymbolOverride?: string;
      intervalOverride?: string;
      rangeOverride?: AiRangeSelectionContext;
      preCapturedChartUrl?: string | null;
    }
  ) {
    const text = (explicitText ?? draft).trim();
    if (!text || isStreaming) return;

    errorBanner = null;
    modelMenuOpen = false;
    chatMenuOpen = false;
    if (!explicitText) {
      draft = '';
      await tick();
      resizeTextarea();
    }

    const nowIso = new Date().toISOString();
    const sym = options?.symbolOverride || activeSymbol || 'XAUUSD';
    const fullSym = options?.fullSymbolOverride || activeFullSymbol || sym;
    const effectiveInterval = options?.intervalOverride || activeInterval || 'D';

    // Range context: either explicit from chart range popover, or inherited from active range-scoped thread
    const effectiveRange: AiRangeSelectionContext | undefined =
      options?.rangeOverride ??
      (activeChat?.rangeContext
        ? { ...activeChat.rangeContext, mode: 'custom' }
        : undefined);

    // Collect images: use pre-captured range-highlighted screenshot when provided, else auto-capture active chart
    const attachedDataUrls: string[] = [];
    let chartCapturedUrl: string | null = null;
    const isMetaHelp = /^what can you do\??$/i.test(text);

    isStreaming = true;
    streamStatus = effectiveRange
      ? `Loading ${sym} candles & events in range...`
      : autoCapture && !isMetaHelp
        ? `Capturing ${sym} chart...`
        : 'Preparing...';

    if (options?.preCapturedChartUrl) {
      chartCapturedUrl = options.preCapturedChartUrl;
      attachedDataUrls.push(options.preCapturedChartUrl);
    } else if (autoCapture && !isMetaHelp) {
      const snap = await captureActiveChart();
      if (snap?.dataUrl) {
        chartCapturedUrl = snap.dataUrl;
        attachedDataUrls.push(snap.dataUrl);
      }
    }

    for (const img of pendingImages) {
      attachedDataUrls.push(img.dataUrl);
    }
    const extraCount = pendingImages.length;
    pendingImages = [];

    // Ensure conversation exists
    let targetChatId = activeChatId;
    if (!targetChatId || !chats.some((c) => c.id === targetChatId)) {
      const defaultTitle = effectiveRange
        ? `${sym} · ${compactRangeChipLabel(effectiveRange)}`
        : text.length > 44
          ? `${text.slice(0, 44).trim()}...`
          : text;
      const newChat: AiConversation = {
        id: makeAiId('chat'),
        title: defaultTitle.length > 48 ? `${defaultTitle.slice(0, 48).trim()}...` : defaultTitle,
        symbol: sym,
        fullSymbol: fullSym,
        rangeContext: effectiveRange,
        messages: [],
        createdAt: nowIso,
        updatedAt: nowIso
      };
      chats = [newChat, ...chats];
      targetChatId = newChat.id;
      activeChatId = targetChatId;
    } else if (options?.rangeOverride) {
      chats = chats.map((c) =>
        c.id === targetChatId ? { ...c, rangeContext: options.rangeOverride } : c
      );
    }

    const userMsg: AiMessage = {
      id: makeAiId('u'),
      role: 'user',
      content: text,
      createdAt: nowIso,
      hasChart: Boolean(chartCapturedUrl),
      imageCount: attachedDataUrls.length,
      rangeContext: effectiveRange
    };

    const assistantMsgId = makeAiId('a');
    const assistantMsg: AiMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      reasoning: '',
      createdAt: nowIso,
      hasChart: false,
      imageCount: 0,
      model: selectedModel,
      sources: [],
      agentSteps: [],
      executedActions: [],
      approvalCards: []
    };

    if (chartCapturedUrl) {
      capturedChartsByMsgId.set(assistantMsgId, chartCapturedUrl);
    } else if (extraCount > 0 && attachedDataUrls[0]) {
      capturedChartsByMsgId.set(assistantMsgId, attachedDataUrls[0]);
    }

    chats = chats.map((c) =>
      c.id === targetChatId
        ? {
            ...c,
            updatedAt: nowIso,
            messages: [...c.messages, userMsg, assistantMsg]
          }
        : c
    );

    const currentConv = chats.find((c) => c.id === targetChatId);
    const historyForApi = (currentConv?.messages ?? [])
      .filter((m) => m.id !== assistantMsgId && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    const workspace = await buildWorkspaceSnapshot(agentHost);
    const pendingActionPromises: Promise<void>[] = [];

    await scrollToBottom();

    const controller = new AbortController();
    activeAbort = controller;

    try {
      await streamAiChat(
        {
          model: selectedModel,
          effort: selectedEffort,
          messages: historyForApi,
          images: attachedDataUrls,
          context: {
            symbol: sym,
            fullSymbol: fullSym,
            interval: effectiveInterval,
            price: typeof activePrice === 'number' && Number.isFinite(activePrice) ? activePrice : undefined,
            changePercent:
              typeof activeChangePercent === 'number' && Number.isFinite(activeChangePercent)
                ? activeChangePercent
                : undefined,
            timezone: timeZone,
            range: effectiveRange
          },
          workspace,
          webSearchMode
        },
        {
          onStatus: (_phase, label) => {
            streamStatus = label;
          },
          onAgentStep: (step: AiAgentStep) => {
            streamStatus = step.label;
            updateAssistantMessage(targetChatId!, assistantMsgId, (m) => {
              const existing = m.agentSteps ?? [];
              const idx = existing.findIndex((s) => s.id === step.id);
              const nextSteps =
                idx >= 0
                  ? existing.map((s, i) => (i === idx ? step : s))
                  : [...existing, step];
              return { ...m, agentSteps: nextSteps };
            });
            void scrollToBottom();
          },
          onClientAction: (action: AiClientAction) => {
            const p = executeClientAction(action, agentHost).then((rec) => {
              updateAssistantMessage(targetChatId!, assistantMsgId, (m) => {
                const existing = m.executedActions ?? [];
                if (existing.some((a) => a.id === rec.id)) return m;
                return { ...m, executedActions: [...existing, rec] };
              });
              void scrollToBottom();
            });
            pendingActionPromises.push(p);
          },
          onApprovalCard: (card: AiApprovalCard) => {
            updateAssistantMessage(targetChatId!, assistantMsgId, (m) => {
              const existing = m.approvalCards ?? [];
              if (existing.some((c) => c.id === card.id)) return m;
              return {
                ...m,
                approvalCards: [...existing, { ...card, status: 'pending' }]
              };
            });
            void scrollToBottom();
          },
          onSources: (sources: AiSourceLink[]) => {
            updateAssistantMessage(targetChatId!, assistantMsgId, (m) => ({
              ...m,
              sources
            }));
          },
          onReasoning: (delta: string) => {
            updateAssistantMessage(targetChatId!, assistantMsgId, (m) => ({
              ...m,
              reasoning: (m.reasoning ?? '') + delta
            }));
          },
          onStrategyResult: (report: BacktestReport) => {
            const saved = openStrategyFromAi(report);
            updateAssistantMessage(targetChatId!, assistantMsgId, (m) => ({
              ...m,
              strategyResult: {
                id: saved.id,
                name: report.spec.name,
                symbol: report.spec.symbol,
                shortName: report.spec.shortName,
                interval: report.spec.interval,
                verdictStatus: report.verdict.status,
                verdictLabel: report.verdict.label,
                totalTrades: report.all.totalTrades,
                winRatePct: report.all.winRatePct,
                totalPnlUsd: report.all.totalPnlUsd,
                totalPnlPct: report.all.totalPnlPct,
                profitFactor: report.all.profitFactor,
                oosTrades: report.outOfSample.totalTrades,
                oosProfitFactor: report.outOfSample.profitFactor,
                oosPnlPct: report.outOfSample.totalPnlPct
              }
            }));
            void scrollToBottom();
          },
          onToken: (delta: string) => {
            updateAssistantMessage(targetChatId!, assistantMsgId, (m) => ({
              ...m,
              content: m.content + delta
            }));
            void scrollToBottom();
          },
          onDone: () => {
            streamStatus = '';
          },
          onError: (msg: string) => {
            errorBanner = msg;
            updateAssistantMessage(targetChatId!, assistantMsgId, (m) => ({
              ...m,
              content: m.content || `**Error:** ${msg}`
            }));
          }
        },
        controller.signal
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : 'Unable to reach AI Copilot backend.';
        errorBanner = msg;
        updateAssistantMessage(targetChatId, assistantMsgId, (m) => ({
          ...m,
          content: m.content || `**Error:** ${msg}`
        }));
      }
    } finally {
      if (pendingActionPromises.length > 0) {
        await Promise.all(pendingActionPromises.map((p) => p.catch(() => undefined)));
      }
      if (activeAbort === controller) {
        activeAbort = null;
      }
      isStreaming = false;
      streamStatus = '';
      // Remove empty assistant placeholder if aborted before any content or agent outputs arrived
      chats = chats.map((c) => {
        if (c.id !== targetChatId) return c;
        const cleaned = c.messages.filter(
          (m) =>
            !(
              m.id === assistantMsgId &&
              !m.content.trim() &&
              !(m.executedActions && m.executedActions.length > 0) &&
              !(m.approvalCards && m.approvalCards.length > 0)
            )
        );
        return { ...c, messages: cleaned };
      });
      await saveAiChats(chats);
      await scrollToBottom();
    }
  }

  function handleComposerKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendPrompt();
    }
  }
</script>

<PanelShell {theme} title="AI Copilot" {onClose}>
  {#snippet icon()}
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.75c.65 4.2 3.05 6.6 7.25 7.25-4.2.65-6.6 3.05-7.25 7.25-.65-4.2-3.05-6.6-7.25-7.25 4.2-.65 6.6-3.05 7.25-7.25Z" />
    </svg>
  {/snippet}

  <div class="ai-panel" class:light={theme === 'light'}>
    <!-- Sub-header: New chat dropdown + quick + New -->
    <div class="subheader">
      <div class="chat-switcher" data-chat-menu>
        <button
          class="chat-trigger"
          type="button"
          aria-haspopup="menu"
          aria-expanded={chatMenuOpen}
          onclick={() => (chatMenuOpen = !chatMenuOpen)}
        >
          <span class="chat-trigger-label">
            {activeChat ? activeChat.title : 'New chat'}
          </span>
          <svg class="chevron" class:open={chatMenuOpen} viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
          </svg>
        </button>

        {#if chatMenuOpen}
          <div class="chat-popover" role="menu">
            <button class="chat-menu-new" type="button" onclick={startNewChat}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3.25v9.5M3.25 8h9.5" />
              </svg>
              <span>New chat</span>
            </button>

            {#if chats.length > 0}
              <div class="menu-divider"></div>
              <div class="chat-menu-list">
                {#each chats as item (item.id)}
                  <div
                    class="chat-menu-item"
                    class:active={item.id === activeChatId}
                    role="menuitem"
                    tabindex="0"
                    onclick={() => openChat(item.id)}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openChat(item.id);
                      }
                    }}
                  >
                    <div class="chat-menu-main">
                      <span class="chat-menu-title">{item.title}</span>
                      <span class="chat-menu-meta">
                        {item.symbol} · {formatRelativeDate(item.updatedAt)}
                      </span>
                    </div>
                    <button
                      class="chat-menu-del"
                      type="button"
                      aria-label="Delete chat"
                      title="Delete chat"
                      onclick={(e) => deleteChat(item.id, e)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m4.5 4.5 7 7m0-7-7 7" />
                      </svg>
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>

      {#if activeChat}
        <button class="new-chat-btn" type="button" onclick={startNewChat} title="New chat">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.25v9.5M3.25 8h9.5" />
          </svg>
          <span>New</span>
        </button>
      {/if}
    </div>

    <!-- Main scrollable body -->
    <div bind:this={messagesEl} class="thread" class:empty={messages.length === 0}>
      {#if messages.length === 0}
        <div class="empty-stage">
          <h2 class="greeting">Hi trader, the charts are always waiting. How can I help?</h2>
          <div class="suggestions">
            {#each SUGGESTIONS as prompt (prompt)}
              <button
                class="suggestion-chip"
                type="button"
                onclick={() => void sendPrompt(prompt)}
              >
                <svg class="sparkle" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 1.5c.6 3.6 2.9 5.9 6.5 6.5-3.6.6-5.9 2.9-6.5 6.5-.6-3.6-2.9-5.9-6.5-6.5 3.6-.6 5.9-2.9 6.5-6.5Z" />
                </svg>
                <span>{prompt}</span>
              </button>
            {/each}
          </div>
        </div>
      {:else}
        <div class="messages-list">
          {#each messages as msg, idx (msg.id)}
            {#if msg.role === 'user'}
              <div class="msg-user-wrap">
                <div class="msg-user-bubble">
                  {#if msg.rangeContext}
                    <div class="msg-range-chip">
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <line x1="3.75" y1="4.25" x2="3.75" y2="15.75" />
                        <line x1="16.25" y1="4.25" x2="16.25" y2="15.75" />
                        <path d="M10 6c.42 2.25 1.75 3.58 4 4-2.25.42-3.58 1.75-4 4-.42-2.25-1.75-3.58-4-4 2.25-.42 3.58-1.75 4-4Z" />
                      </svg>
                      <span>{compactRangeChipLabel(msg.rangeContext)}</span>
                      <span class="mrc-sep">·</span>
                      <span>{formatIntervalLabel(msg.rangeContext.interval)}</span>
                      {#if typeof msg.rangeContext.netChangePct === 'number'}
                        <span
                          class="mrc-delta"
                          class:pos={msg.rangeContext.netChangePct > 0}
                          class:neg={msg.rangeContext.netChangePct < 0}
                        >
                          {msg.rangeContext.netChangePct >= 0 ? '+' : ''}{msg.rangeContext.netChangePct.toFixed(2)}%
                        </span>
                      {/if}
                    </div>
                  {/if}
                  <div class="msg-user-text">{msg.content}</div>
                  <div class="msg-user-foot">
                    <span>{formatTime(msg.createdAt)}</span>
                    {#if msg.hasChart}
                      <span class="msg-chart-tag">{msg.rangeContext ? 'Range snapped' : 'Chart snapped'}</span>
                    {:else if msg.imageCount > 0}
                      <span class="msg-chart-tag">
                        {msg.imageCount} image{msg.imageCount > 1 ? 's' : ''}
                      </span>
                    {/if}
                  </div>
                </div>
              </div>
            {:else}
              {@const isLastAssistant = idx === messages.length - 1}
              {@const hasRunningStep = (msg.agentSteps ?? []).some((s) => s.status === 'running')}
              <div class="msg-assistant">
                {#if msg.agentSteps && msg.agentSteps.length > 0}
                  <details class="agent-steps-box" open={isStreaming && isLastAssistant && !msg.content}>
                    <summary>
                      {#if isStreaming && isLastAssistant && hasRunningStep}
                        <span class="status-spinner small"></span>
                      {:else}
                        <span class="agent-steps-dot"></span>
                      {/if}
                      <span class="agent-steps-title">
                        {#if isStreaming && isLastAssistant && hasRunningStep}
                          Desk Agent · {msg.agentSteps.find((s) => s.status === 'running')?.label ?? 'Running tools...'}
                        {:else}
                          Desk Agent · {msg.agentSteps.length} {msg.agentSteps.length === 1 ? 'tool step' : 'tool steps'}
                        {/if}
                      </span>
                    </summary>
                    <div class="agent-steps-list">
                      {#each msg.agentSteps as step (step.id)}
                        <div class="agent-step-row" class:running={step.status === 'running'} class:err={step.status === 'error'}>
                          <span class="agent-step-icon">
                            {#if step.status === 'running'}
                              <span class="status-spinner tiny"></span>
                            {:else if step.status === 'error'}
                              !
                            {:else}
                              ✓
                            {/if}
                          </span>
                          <div class="agent-step-text">
                            <span class="agent-step-label">{step.label}</span>
                            {#if step.detail}
                              <span class="agent-step-detail">{step.detail}</span>
                            {/if}
                          </div>
                        </div>
                      {/each}
                    </div>
                  </details>
                {/if}

                {#if msg.executedActions && msg.executedActions.length > 0}
                  <div class="agent-actions-list">
                    {#each msg.executedActions as act (act.id)}
                      <div
                        class="agent-action-chip"
                        class:undone={act.status === 'undone'}
                        class:failed={act.status === 'failed'}
                      >
                        <span class="aac-icon">
                          {#if act.status === 'undone'}
                            ↩
                          {:else if act.status === 'failed'}
                            !
                          {:else}
                            ✓
                          {/if}
                        </span>
                        <div class="aac-main">
                          <span class="aac-label">{act.label}</span>
                          {#if act.detail}
                            <span class="aac-detail">
                              {act.status === 'undone' ? 'Undone' : act.detail}
                            </span>
                          {/if}
                        </div>
                        {#if act.status === 'executed' && act.canUndo && canUndoClientAction(act.id) && activeChat}
                          <button
                            class="aac-undo-btn"
                            type="button"
                            onclick={() => void handleUndoAction(activeChat.id, msg.id, act.id)}
                          >
                            Undo
                          </button>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}

                {#if msg.reasoning && msg.reasoning.trim().length > 0}
                  <details class="reasoning-box" open={isStreaming && isLastAssistant && !msg.content}>
                    <summary>
                      <span class="reasoning-dot" class:pulsing={isStreaming && isLastAssistant && !msg.content}></span>
                      <span>
                        {isStreaming && isLastAssistant && !msg.content ? 'Thinking...' : 'Thought process'}
                      </span>
                    </summary>
                    <div class="reasoning-body">{msg.reasoning}</div>
                  </details>
                {/if}

                {#if isStreaming && isLastAssistant && !msg.content && !(msg.reasoning && msg.reasoning.trim().length > 0) && !hasRunningStep}
                  <div class="stream-status">
                    <span class="status-spinner"></span>
                    <span>{streamStatus || 'Analyzing...'}</span>
                  </div>
                {/if}

                {#if msg.content}
                  <div class="md-content">
                    {@html renderMarkdown(msg.content)}
                  </div>
                {/if}

                {#if msg.approvalCards && msg.approvalCards.length > 0 && activeChat}
                  <div class="approval-cards-list">
                    {#each msg.approvalCards as card (card.id)}
                      {@const cardState = card.status ?? 'pending'}
                      <div class="approval-card" class:resolved={cardState !== 'pending'}>
                        {#if card.kind === 'stage_paper_order'}
                          <div class="ac-head">
                            <div class="ac-title-row">
                              <span class="ac-side-badge" class:buy={card.side === 'buy'} class:sell={card.side === 'sell'}>
                                {card.side.toUpperCase()} · {card.orderType.toUpperCase()}
                              </span>
                              <span class="ac-symbol">{card.shortName}</span>
                            </div>
                            {#if cardState !== 'pending'}
                              <span class="ac-status-pill" class:ok={cardState === 'executed' || cardState === 'staged'}>
                                {cardState === 'staged' ? 'Staged' : cardState === 'executed' ? 'Submitted' : 'Dismissed'}
                              </span>
                            {/if}
                          </div>
                          <div class="ac-rationale">{card.rationale}</div>
                          <div class="ac-grid">
                            <div class="ac-cell">
                              <span class="ac-k">Entry</span>
                              <span class="ac-v">{formatCardPrice(card.entryPrice, card.symbol)}</span>
                            </div>
                            <div class="ac-cell">
                              <span class="ac-k">Stop Loss</span>
                              <span class="ac-v neg">{formatCardPrice(card.stopLoss, card.symbol)}</span>
                            </div>
                            <div class="ac-cell">
                              <span class="ac-k">Take Profit</span>
                              <span class="ac-v pos">{formatCardPrice(card.takeProfit, card.symbol)}</span>
                            </div>
                            <div class="ac-cell">
                              <span class="ac-k">Qty</span>
                              <span class="ac-v">{card.suggestedQuantity}</span>
                            </div>
                            <div class="ac-cell">
                              <span class="ac-k">Risk</span>
                              <span class="ac-v">
                                {card.riskPct.toFixed(2)}%{card.riskUsd !== null ? ` ($${card.riskUsd.toFixed(0)})` : ''}
                              </span>
                            </div>
                            <div class="ac-cell">
                              <span class="ac-k">R:R</span>
                              <span class="ac-v">
                                {card.rrRatio !== null ? `${card.rrRatio.toFixed(2)}R` : '—'}
                              </span>
                            </div>
                          </div>
                          {#if card.spreadNote}
                            <div class="ac-meta-note">{card.spreadNote}</div>
                          {/if}
                          {#if card.warnings && card.warnings.length > 0}
                            <div class="ac-warnings">
                              {#each card.warnings as w (w)}
                                <div class="ac-warning-item">⚠ {w}</div>
                              {/each}
                            </div>
                          {/if}
                          {#if cardState === 'pending'}
                            <div class="ac-actions">
                              <button
                                class="ac-btn primary"
                                type="button"
                                onclick={() => void handleApprovalAction(activeChat.id, msg.id, card, 'stage')}
                              >
                                Stage Ticket
                              </button>
                              <button
                                class="ac-btn execute"
                                type="button"
                                onclick={() => void handleApprovalAction(activeChat.id, msg.id, card, 'execute')}
                              >
                                Place Paper Order
                              </button>
                              <button
                                class="ac-btn ghost"
                                type="button"
                                onclick={() => void handleApprovalAction(activeChat.id, msg.id, card, 'dismiss')}
                              >
                                Dismiss
                              </button>
                            </div>
                          {:else if card.statusNote}
                            <div class="ac-result-note">{card.statusNote}</div>
                          {/if}
                        {:else if card.kind === 'protect_position'}
                          <div class="ac-head">
                            <div class="ac-title-row">
                              <span class="ac-side-badge warn">
                                {card.operation === 'modify_brackets'
                                  ? 'PROTECT'
                                  : card.operation === 'close_partial'
                                    ? `TRIM ${Math.round((card.closeFraction ?? 0.5) * 100)}%`
                                    : 'CLOSE'}
                              </span>
                              <span class="ac-symbol">{card.shortName} ({card.side.toUpperCase()})</span>
                            </div>
                            {#if cardState !== 'pending'}
                              <span class="ac-status-pill" class:ok={cardState === 'executed'}>
                                {cardState === 'executed' ? 'Applied' : 'Dismissed'}
                              </span>
                            {/if}
                          </div>
                          <div class="ac-rationale">{card.rationale}</div>
                          {#if card.operation === 'modify_brackets'}
                            <div class="ac-grid two">
                              <div class="ac-cell">
                                <span class="ac-k">New Stop Loss</span>
                                <span class="ac-v neg">{formatCardPrice(card.newStopLoss, card.symbol)}</span>
                              </div>
                              <div class="ac-cell">
                                <span class="ac-k">New Take Profit</span>
                                <span class="ac-v pos">{formatCardPrice(card.newTakeProfit, card.symbol)}</span>
                              </div>
                            </div>
                          {/if}
                          {#if card.warnings && card.warnings.length > 0}
                            <div class="ac-warnings">
                              {#each card.warnings as w (w)}
                                <div class="ac-warning-item">⚠ {w}</div>
                              {/each}
                            </div>
                          {/if}
                          {#if cardState === 'pending'}
                            <div class="ac-actions">
                              <button
                                class="ac-btn primary"
                                type="button"
                                onclick={() => void handleApprovalAction(activeChat.id, msg.id, card, 'execute')}
                              >
                                Apply Protection
                              </button>
                              <button
                                class="ac-btn ghost"
                                type="button"
                                onclick={() => void handleApprovalAction(activeChat.id, msg.id, card, 'dismiss')}
                              >
                                Dismiss
                              </button>
                            </div>
                          {:else if card.statusNote}
                            <div class="ac-result-note">{card.statusNote}</div>
                          {/if}
                        {:else if card.kind === 'deploy_strategy_bot'}
                          <div class="ac-head">
                            <div class="ac-title-row">
                              <span class="ac-side-badge bot">BOT · {card.executionMode === 'auto_sim' ? 'AUTO SIM' : 'NOTIFY'}</span>
                              <span class="ac-symbol">{card.strategyName}</span>
                            </div>
                            {#if cardState !== 'pending'}
                              <span class="ac-status-pill" class:ok={cardState === 'executed'}>
                                {cardState === 'executed' ? 'Deployed' : 'Dismissed'}
                              </span>
                            {/if}
                          </div>
                          <div class="ac-rationale">{card.rationale}</div>
                          <div class="ac-grid">
                            <div class="ac-cell">
                              <span class="ac-k">Symbol</span>
                              <span class="ac-v">{card.symbol}</span>
                            </div>
                            <div class="ac-cell">
                              <span class="ac-k">Timeframe</span>
                              <span class="ac-v">{card.interval}</span>
                            </div>
                            <div class="ac-cell">
                              <span class="ac-k">Daily Loss Cap</span>
                              <span class="ac-v">{card.maxDailyLossPct.toFixed(1)}%</span>
                            </div>
                          </div>
                          {#if card.warnings && card.warnings.length > 0}
                            <div class="ac-warnings">
                              {#each card.warnings as w (w)}
                                <div class="ac-warning-item">⚠ {w}</div>
                              {/each}
                            </div>
                          {/if}
                          {#if cardState === 'pending'}
                            <div class="ac-actions">
                              <button
                                class="ac-btn primary"
                                type="button"
                                onclick={() => void handleApprovalAction(activeChat.id, msg.id, card, 'execute')}
                              >
                                Deploy SIM Bot
                              </button>
                              <button
                                class="ac-btn ghost"
                                type="button"
                                onclick={() => void handleApprovalAction(activeChat.id, msg.id, card, 'dismiss')}
                              >
                                Dismiss
                              </button>
                            </div>
                          {:else if card.statusNote}
                            <div class="ac-result-note">{card.statusNote}</div>
                          {/if}
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}

                {#if msg.sources && msg.sources.length > 0}
                  <div class="sources-row">
                    <span class="sources-label">Sources</span>
                    <div class="sources-list">
                      {#each msg.sources as src (src.url)}
                        <a
                          class="source-pill"
                          href={src.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={src.title}
                        >
                          <span class="source-host">{hostLabel(src.url)}</span>
                          <span class="source-title">{src.title}</span>
                        </a>
                      {/each}
                    </div>
                  </div>
                {/if}

                {#if msg.strategyResult}
                  {@const sr = msg.strategyResult}
                  <div class="strat-result-strip">
                    <div class="srs-top">
                      <span class="srs-name">{sr.name}</span>
                      <span
                        class="srs-verdict"
                        class:pass={sr.verdictStatus === 'pass'}
                        class:warn={sr.verdictStatus === 'marginal' || sr.verdictStatus === 'low_sample'}
                        class:fail={sr.verdictStatus === 'no_edge' || sr.verdictStatus === 'overfit'}
                      >
                        {sr.verdictLabel}
                      </span>
                    </div>
                    <div class="srs-metrics">
                      <span>{sr.shortName} · {sr.interval}</span>
                      <span>Trades: <strong>{sr.totalTrades}</strong> ({sr.winRatePct.toFixed(0)}% WR)</span>
                      <span class:pos={sr.totalPnlUsd > 0} class:neg={sr.totalPnlUsd < 0}>
                        {sr.totalPnlPct >= 0 ? '+' : ''}{sr.totalPnlPct.toFixed(2)}%
                      </span>
                      <span>
                        OOS PF: <strong>{sr.oosProfitFactor !== null ? sr.oosProfitFactor.toFixed(2) : '—'}</strong> ({sr.oosTrades}t)
                      </span>
                    </div>
                    <button
                      class="srs-open-btn"
                      type="button"
                      onclick={() => openSavedStrategy(sr.id)}
                    >
                      Open in Strategy Tester →
                    </button>
                  </div>
                {/if}

                {#if msg.content && !(isStreaming && isLastAssistant)}
                  <div class="msg-actions">
                    <button
                      class="action-btn"
                      type="button"
                      onclick={() => void copyReply(msg)}
                    >
                      {copiedMsgId === msg.id ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      class="action-btn"
                      type="button"
                      onclick={() => void handleSaveToNotes(msg, idx)}
                    >
                      {savedNoteMsgId === msg.id ? 'Saved to Notes' : 'Save to Notes'}
                    </button>
                    <button
                      class="action-btn"
                      type="button"
                      onclick={() => void handleSaveToPlaybook(msg, idx)}
                    >
                      {savedPlaybookMsgId === msg.id ? 'Saved to Playbook' : 'Save to Playbook'}
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>

    <!-- Bottom composer -->
    <div class="composer-wrap">
      {#if errorBanner}
        <div class="error-strip" role="alert">
          <span>{errorBanner}</span>
          <button
            class="error-dismiss"
            type="button"
            aria-label="Dismiss error"
            onclick={() => (errorBanner = null)}
          >
            ×
          </button>
        </div>
      {/if}

      <div class="composer-card">
        <!-- Context strip -->
        <div class="context-bar">
          <button
            class="context-chip"
            class:active={autoCapture}
            type="button"
            title={autoCapture
              ? 'Auto-capturing active chart on send (click to turn off)'
              : 'Chart auto-capture is off (click to enable)'}
            onclick={toggleAutoCapture}
          >
            <span class="live-dot" class:on={autoCapture}></span>
            <span>Active chart: <strong>{activeSymbol || 'XAUUSD'}</strong> · {formattedInterval}</span>
          </button>

          <button
            class="web-chip"
            class:on={webSearchMode === 'on'}
            class:off={webSearchMode === 'off'}
            type="button"
            title="Tavily web search: Auto runs on news/macro queries; click to switch Auto / On / Off"
            onclick={cycleWebSearch}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="5.75" />
              <path d="M2.5 8h11M8 2.25c1.6 1.6 2.25 3.6 2.25 5.75S9.6 12.15 8 13.75C6.4 12.15 5.75 10.15 5.75 8S6.4 3.85 8 2.25Z" />
            </svg>
            <span>
              Web: {webSearchMode === 'auto' ? 'Auto' : webSearchMode === 'on' ? 'On' : 'Off'}
            </span>
          </button>
        </div>

        {#if activeChat?.rangeContext}
          <div class="active-range-strip">
            <span class="ars-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <line x1="3.75" y1="4.25" x2="3.75" y2="15.75" />
                <line x1="16.25" y1="4.25" x2="16.25" y2="15.75" />
                <path d="M10 6c.42 2.25 1.75 3.58 4 4-2.25.42-3.58 1.75-4 4-.42-2.25-1.75-3.58-4-4 2.25-.42 3.58-1.75 4-4Z" />
              </svg>
            </span>
            <span class="ars-text">
              Range: {compactRangeChipLabel(activeChat.rangeContext)} · {formatIntervalLabel(activeChat.rangeContext.interval)}
            </span>
            <button
              class="ars-clear"
              type="button"
              title="Detach range scope from follow-ups"
              aria-label="Detach range scope"
              onclick={clearActiveChatRangeScope}
            >
              ×
            </button>
          </div>
        {/if}

        {#if pendingImages.length > 0}
          <div class="pending-images">
            {#each pendingImages as img (img.id)}
              <div class="pending-thumb">
                <img src={img.dataUrl} alt={img.label} />
                <button
                  class="thumb-remove"
                  type="button"
                  aria-label="Remove image"
                  onclick={() => removePendingImage(img.id)}
                >
                  ×
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <textarea
          bind:this={textareaEl}
          class="composer-input"
          rows="2"
          placeholder={`Ask anything about ${activeSymbol || 'XAUUSD'}...`}
          bind:value={draft}
          oninput={resizeTextarea}
          onkeydown={handleComposerKeydown}
          onpaste={(e) => void handlePaste(e)}
        ></textarea>

        <div class="composer-footer">
          <div class="composer-left">
            <button
              class="icon-btn"
              type="button"
              aria-label="Attach chart screenshot"
              title="Attach extra chart screenshot (or press Ctrl+V)"
              onclick={() => fileInputEl?.click()}
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <rect x="2.5" y="3.25" width="13" height="11.5" rx="2.25" />
                <circle cx="6.5" cy="7" r="1.15" />
                <path d="m3.5 13 3.4-3.25 2.4 2.25 2.6-2.75 2.6 3.75" />
              </svg>
            </button>
            <input
              bind:this={fileInputEl}
              class="hidden-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onchange={(e) => void handleFileSelect(e)}
            />
          </div>

          <div class="composer-right">
            <!-- Model & Effort selector -->
            <div class="model-picker" data-model-menu>
              <button
                class="model-trigger"
                class:open={modelMenuOpen}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={modelMenuOpen}
                onclick={() => (modelMenuOpen = !modelMenuOpen)}
              >
                <span class="model-trigger-name">{currentModelObj.shortName}</span>
                <span class="model-trigger-effort">{currentEffortLabel}</span>
                <svg class="model-chevron" class:open={modelMenuOpen} viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4.5 6.5 3.5 3.25L11.5 6.5" />
                </svg>
              </button>

              {#if modelMenuOpen}
                <div class="model-popover" role="dialog" aria-label="Model and reasoning effort">
                  <div class="model-options">
                    {#each AI_MODELS as m (m.id)}
                      <button
                        class="model-option"
                        class:selected={selectedModel === m.id}
                        type="button"
                        onclick={() => selectModel(m.id)}
                      >
                        <div class="model-option-top">
                          <span class="model-option-name">{m.name}</span>
                          {#if m.badge}
                            <span class="model-badge">{m.badge}</span>
                          {/if}
                        </div>
                        <span class="model-option-desc">{m.description}</span>
                      </button>
                    {/each}
                  </div>

                  <div class="popover-divider"></div>

                  <div class="effort-row">
                    <span class="effort-label">Effort</span>
                    <div class="effort-pills" role="radiogroup" aria-label="Reasoning effort">
                      {#each AI_EFFORTS as eff (eff.id)}
                        <button
                          class="effort-pill"
                          class:active={selectedEffort === eff.id}
                          type="button"
                          role="radio"
                          aria-checked={selectedEffort === eff.id}
                          onclick={() => selectEffort(eff.id)}
                        >
                          {eff.label}
                        </button>
                      {/each}
                    </div>
                  </div>
                </div>
              {/if}
            </div>

            {#if isStreaming}
              <button
                class="send-btn stop"
                type="button"
                aria-label="Stop generating"
                title="Stop"
                onclick={stopStreaming}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.5" fill="currentColor" stroke="none" />
                </svg>
              </button>
            {:else}
              <button
                class="send-btn"
                class:ready={canSend}
                type="button"
                disabled={!canSend}
                aria-label="Send message"
                title="Send (Enter)"
                onclick={() => void sendPrompt()}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 12.25V3.75M4.25 7.25 8 3.5l3.75 3.75" />
                </svg>
              </button>
            {/if}
          </div>
        </div>
      </div>

      <div class="disclaimer">AI can make mistakes. Not financial advice.</div>
    </div>
  </div>
</PanelShell>

<style>
  .ai-panel {
    --ai-bg: var(--dark-bg-panel);
    --ai-surface: var(--dark-bg-surface);
    --ai-elevated: var(--dark-bg-surface-alt);
    --ai-chip-bg: var(--dark-bg-surface-alt);
    --ai-chip-hover: var(--dark-bg-elevated-hover);
    --ai-border: var(--dark-border);
    --ai-border-soft: var(--dark-border-subtle);
    --ai-text: var(--dark-text-primary);
    --ai-secondary: var(--dark-text-secondary);
    --ai-user-bg: var(--dark-bg-active);
    --ai-user-text: var(--dark-text-strong);
    --ai-popover-bg: var(--dark-bg-glass-strong);
    --ai-popover-border: var(--dark-border-glass);
    --ai-popover-shadow: var(--dark-shadow-popover);
    --ai-option-selected-bg: var(--dark-bg-active);
    --ai-option-selected-text: #ffffff;
    --ai-option-selected-desc: var(--dark-text-soft);
    --ai-option-hover: var(--dark-hover);
    --ai-badge-bg: rgba(255, 167, 38, 0.16);
    --ai-badge-text: #ffb74d;
    --ai-table-head: var(--dark-bg-surface);
    --ai-code-bg: var(--dark-bg-surface-alt);
    --ai-send-bg: var(--dark-bg-elevated);
    --ai-send-color: var(--dark-text-muted);
    --ai-send-ready-bg: var(--dark-cta-bg);
    --ai-send-ready-color: var(--dark-cta-fg);

    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--ai-text);
    background: var(--ai-bg);
    transition: color 150ms ease, background-color 150ms ease;
  }

  .ai-panel.light {
    --ai-bg: #ffffff;
    --ai-surface: #ffffff;
    --ai-elevated: #f7f8fa;
    --ai-chip-bg: #f2f3f5;
    --ai-chip-hover: #e7e9ee;
    --ai-border: #e0e3eb;
    --ai-border-soft: #eceef2;
    --ai-text: #131722;
    --ai-secondary: #6a6d78;
    --ai-user-bg: #131722;
    --ai-user-text: #ffffff;
    --ai-popover-bg: #ffffff;
    --ai-popover-border: #e0e3eb;
    --ai-popover-shadow: 0 10px 28px rgba(19, 23, 34, 0.14);
    --ai-option-selected-bg: #131722;
    --ai-option-selected-text: #ffffff;
    --ai-option-selected-desc: #cfd4df;
    --ai-option-hover: #f5f6f8;
    --ai-badge-bg: #fff2df;
    --ai-badge-text: #c96a00;
    --ai-table-head: #f7f8fa;
    --ai-code-bg: #f2f3f6;
    --ai-send-bg: #eceef2;
    --ai-send-color: #9ea2ad;
    --ai-send-ready-bg: #131722;
    --ai-send-ready-color: #ffffff;
  }

  /* Sub-header */
  .subheader {
    height: 36px;
    flex: 0 0 36px;
    padding: 0 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    user-select: none;
  }

  .chat-switcher {
    position: relative;
    min-width: 0;
    flex: 1;
  }

  .chat-trigger {
    max-width: 100%;
    height: 30px;
    padding: 0 8px 0 4px;
    border: 0;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ai-text);
    background: transparent;
    font: inherit;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition: background-color 150ms ease;
  }

  .chat-trigger:hover {
    background: var(--ai-option-hover);
  }

  .chat-trigger-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chevron {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.7;
    transition: transform 150ms ease;
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .chat-popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    width: 264px;
    max-height: 320px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    padding: 6px;
    border-radius: 11px;
    border: 1px solid var(--ai-popover-border);
    background: var(--ai-popover-bg);
    box-shadow: var(--ai-popover-shadow);
    backdrop-filter: blur(18px);
    z-index: 20;
  }

  .chat-popover::-webkit-scrollbar {
    display: none;
  }

  .chat-menu-new {
    width: 100%;
    height: 32px;
    padding: 0 9px;
    border: 0;
    border-radius: 7px;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--ai-text);
    background: transparent;
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .chat-menu-new:hover {
    background: var(--ai-option-hover);
  }

  .chat-menu-new svg,
  .new-chat-btn svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
  }

  .menu-divider,
  .popover-divider {
    height: 1px;
    margin: 5px 4px;
    background: var(--ai-border-soft);
  }

  .chat-menu-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .chat-menu-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 8px;
    border-radius: 7px;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .chat-menu-item:hover,
  .chat-menu-item.active {
    background: var(--ai-option-hover);
  }

  .chat-menu-main {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .chat-menu-title {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ai-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat-menu-meta {
    font-size: 11px;
    color: var(--ai-secondary);
  }

  .chat-menu-del {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    border: 0;
    border-radius: 5px;
    display: grid;
    place-items: center;
    color: var(--ai-secondary);
    background: transparent;
    opacity: 0;
    cursor: pointer;
    transition: opacity 120ms ease, background-color 120ms ease, color 120ms ease;
  }

  .chat-menu-item:hover .chat-menu-del {
    opacity: 1;
  }

  .chat-menu-del:hover {
    color: #f23645;
    background: rgba(242, 54, 69, 0.12);
  }

  .chat-menu-del svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }

  .new-chat-btn {
    height: 26px;
    padding: 0 8px;
    flex: 0 0 auto;
    border: 1px solid var(--ai-border);
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--ai-secondary);
    background: transparent;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: color 140ms ease, background-color 140ms ease;
  }

  .new-chat-btn:hover {
    color: var(--ai-text);
    background: var(--ai-option-hover);
  }

  /* Scrollable thread */
  .thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 12px 16px 14px;
    scrollbar-width: none;
    scroll-behavior: smooth;
  }

  .thread::-webkit-scrollbar {
    display: none;
  }

  .thread.empty {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }

  .empty-stage {
    padding-bottom: 6px;
  }

  .greeting {
    margin: 0 0 14px;
    font-size: 14.5px;
    font-weight: 700;
    line-height: 1.38;
    letter-spacing: -0.01em;
    color: var(--ai-text);
  }

  .suggestions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .suggestion-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 0;
    border-radius: 10px;
    color: var(--ai-text);
    background: var(--ai-chip-bg);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.25;
    text-align: left;
    cursor: pointer;
    transition: background-color 140ms ease, transform 120ms ease;
  }

  .suggestion-chip:hover {
    background: var(--ai-chip-hover);
  }

  .suggestion-chip:active {
    transform: translateY(0.5px);
  }

  .sparkle {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    fill: currentColor;
    opacity: 0.85;
  }

  /* Messages */
  .messages-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .msg-user-wrap {
    display: flex;
    justify-content: flex-end;
  }

  .msg-user-bubble {
    max-width: 88%;
    padding: 10px 13px;
    border-radius: 14px 14px 4px 14px;
    color: var(--ai-user-text);
    background: var(--ai-user-bg);
  }

  .msg-user-text {
    font-size: 13px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .msg-user-foot {
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10.5px;
    opacity: 0.65;
  }

  .msg-chart-tag {
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.14);
  }

  .msg-range-chip {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 6px;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    background: linear-gradient(135deg, rgba(184, 51, 245, 0.24), rgba(41, 98, 255, 0.28));
    border: 1px solid rgba(124, 92, 255, 0.38);
    color: inherit;
  }

  .msg-range-chip svg {
    width: 12px;
    height: 12px;
    flex: 0 0 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .mrc-sep {
    opacity: 0.6;
  }

  .mrc-delta {
    padding: 0 4px;
    border-radius: 3px;
    font-size: 10.5px;
    font-weight: 700;
    background: rgba(255, 255, 255, 0.14);
  }

  .mrc-delta.pos {
    color: #5eead4;
  }

  .mrc-delta.neg {
    color: #fca5a5;
  }

  .active-range-strip {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 10px 4px;
    padding: 4px 8px;
    border-radius: 7px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ai-text);
    background: linear-gradient(135deg, rgba(184, 51, 245, 0.14), rgba(41, 98, 255, 0.16));
    border: 1px solid rgba(124, 92, 255, 0.3);
  }

  .ars-icon {
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
  }

  .ars-icon svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ars-text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ars-clear {
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--ai-secondary);
    font-size: 13px;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .ars-clear:hover {
    color: var(--ai-text);
    background: var(--ai-option-hover);
  }

  .msg-assistant {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .reasoning-box {
    border: 1px solid var(--ai-border-soft);
    border-radius: 9px;
    background: var(--ai-elevated);
    font-size: 12px;
  }

  .reasoning-box summary {
    padding: 7px 10px;
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--ai-secondary);
    font-weight: 500;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }

  .reasoning-box summary::-webkit-details-marker {
    display: none;
  }

  .reasoning-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ai-secondary);
  }

  .reasoning-dot.pulsing {
    background: #2962ff;
    animation: pulse 1.1s ease-in-out infinite;
  }

  .reasoning-body {
    padding: 8px 10px 9px;
    color: var(--ai-secondary);
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    max-height: 180px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none;
    scroll-behavior: smooth;
    border-top: 1px solid var(--ai-border-soft);
  }

  .reasoning-body::-webkit-scrollbar {
    display: none;
  }

  .stream-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    font-size: 12.5px;
    color: var(--ai-secondary);
  }

  .status-spinner {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1.8px solid var(--ai-border);
    border-top-color: var(--ai-text);
    animation: spin 0.75s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }

  /* Rich Markdown output */
  .md-content {
    font-size: 13px;
    line-height: 1.56;
    color: var(--ai-text);
    word-break: break-word;
  }

  .md-content :global(p) {
    margin: 0 0 9px;
  }

  .md-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .md-content :global(h3) {
    margin: 14px 0 6px;
    font-size: 13.5px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--ai-text);
  }

  .md-content :global(h3:first-child),
  .md-content :global(h4:first-child) {
    margin-top: 0;
  }

  .md-content :global(h4),
  .md-content :global(h5) {
    margin: 12px 0 5px;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--ai-text);
  }

  .md-content :global(ul),
  .md-content :global(ol) {
    margin: 0 0 9px;
    padding-left: 18px;
  }

  .md-content :global(li) {
    margin: 3px 0;
  }

  .md-content :global(hr) {
    border: 0;
    border-top: 1px solid var(--ai-border-soft);
    margin: 12px 0;
  }

  .md-content :global(blockquote) {
    margin: 8px 0;
    padding: 6px 10px;
    border-left: 2.5px solid var(--ai-border);
    color: var(--ai-secondary);
    background: var(--ai-elevated);
    border-radius: 0 6px 6px 0;
  }

  .md-content :global(code) {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--ai-code-bg);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .md-content :global(pre) {
    margin: 8px 0;
    padding: 9px 11px;
    border-radius: 8px;
    background: var(--ai-code-bg);
    overflow-x: auto;
    scrollbar-width: none;
  }

  .md-content :global(pre::-webkit-scrollbar) {
    display: none;
  }

  .md-content :global(pre code) {
    padding: 0;
    background: transparent;
  }

  .md-content :global(a) {
    color: #2962ff;
    text-decoration: none;
  }

  .md-content :global(a:hover) {
    text-decoration: underline;
  }

  .md-content :global(.ai-bias-bull) {
    color: #089981;
  }

  .md-content :global(.ai-bias-bear) {
    color: #f23645;
  }

  .md-content :global(.ai-bias-neutral) {
    color: var(--ai-secondary);
  }

  .md-content :global(.md-table-wrap) {
    margin: 10px 0;
    border: 1px solid var(--ai-border);
    border-radius: 9px;
    overflow-x: auto;
    scrollbar-width: thin;
  }

  .md-content :global(.md-table-wrap::-webkit-scrollbar) {
    height: 5px;
  }

  .md-content :global(.md-table-wrap::-webkit-scrollbar-thumb) {
    background: var(--ai-border);
    border-radius: 999px;
  }

  .md-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    word-break: normal;
    overflow-wrap: normal;
  }

  .md-content :global(th) {
    padding: 7px 8px;
    font-weight: 600;
    white-space: nowrap;
    color: var(--ai-secondary);
    background: var(--ai-table-head);
    border-bottom: 1px solid var(--ai-border);
    white-space: normal;
  }

  .md-content :global(td) {
    padding: 7px 8px;
    border-bottom: 1px solid var(--ai-border-soft);
    vertical-align: top;
    overflow-wrap: anywhere;
  }

  .md-content :global(tbody tr:last-child td) {
    border-bottom: 0;
  }

  /* Sources */
  .sources-row {
    margin-top: 2px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .sources-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--ai-secondary);
  }

  .sources-list {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .source-pill {
    max-width: 100%;
    padding: 4px 8px;
    border-radius: 7px;
    border: 1px solid var(--ai-border-soft);
    background: var(--ai-elevated);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--ai-text);
    text-decoration: none;
    transition: border-color 120ms ease;
  }

  .source-pill:hover {
    border-color: var(--ai-border);
  }

  .source-host {
    color: var(--ai-secondary);
    font-weight: 600;
    flex: 0 0 auto;
  }

  .source-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 180px;
  }

  /* Reply footer actions */
  .msg-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
  }

  .action-btn {
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--ai-border-soft);
    border-radius: 6px;
    color: var(--ai-secondary);
    background: transparent;
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: color 130ms ease, border-color 130ms ease, background-color 130ms ease;
  }

  .action-btn:hover {
    color: var(--ai-text);
    border-color: var(--ai-border);
    background: var(--ai-option-hover);
  }

  /* Composer */
  .composer-wrap {
    flex: 0 0 auto;
    padding: 6px 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .error-strip {
    padding: 7px 10px;
    border-radius: 8px;
    background: rgba(242, 54, 69, 0.12);
    border: 1px solid rgba(242, 54, 69, 0.3);
    color: #f23645;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .error-dismiss {
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }

  .composer-card {
    border: 1px solid var(--ai-border);
    border-radius: 12px;
    background: var(--ai-surface);
    display: flex;
    flex-direction: column;
    transition: border-color 150ms ease;
  }

  .composer-card:focus-within {
    border-color: color-mix(in srgb, var(--ai-text) 32%, transparent);
  }

  .context-bar {
    padding: 7px 10px 5px;
    border-bottom: 1px solid var(--ai-border-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    user-select: none;
  }

  .context-chip,
  .web-chip {
    height: 22px;
    padding: 0 7px;
    border: 0;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: inherit;
    font-size: 11px;
    color: var(--ai-secondary);
    background: transparent;
    cursor: pointer;
    transition: background-color 130ms ease, color 130ms ease;
  }

  .context-chip:hover,
  .web-chip:hover {
    background: var(--ai-option-hover);
    color: var(--ai-text);
  }

  .context-chip strong {
    font-weight: 600;
    color: var(--ai-text);
  }

  .context-chip:not(.active) strong {
    color: var(--ai-secondary);
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ai-secondary);
    opacity: 0.5;
  }

  .live-dot.on {
    background: #089981;
    opacity: 1;
  }

  .web-chip svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
  }

  .web-chip.on {
    color: #2962ff;
  }

  .web-chip.off {
    opacity: 0.55;
  }

  .pending-images {
    padding: 8px 10px 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .pending-thumb {
    position: relative;
    width: 52px;
    height: 36px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--ai-border);
  }

  .pending-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .thumb-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 16px;
    height: 16px;
    border: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.72);
    color: #ffffff;
    font-size: 11px;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .composer-input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px 6px;
    border: 0;
    resize: none;
    background: transparent;
    color: var(--ai-text);
    font: inherit;
    font-size: 13px;
    line-height: 1.45;
    outline: none;
    min-height: 48px;
    max-height: 132px;
  }

  .composer-input::placeholder {
    color: var(--ai-secondary);
  }

  .composer-footer {
    padding: 4px 8px 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .composer-left,
  .composer-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .icon-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    display: grid;
    place-items: center;
    color: var(--ai-secondary);
    background: transparent;
    cursor: pointer;
    transition: background-color 130ms ease, color 130ms ease;
  }

  .icon-btn:hover {
    color: var(--ai-text);
    background: var(--ai-option-hover);
  }

  .icon-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.45;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .hidden-file {
    display: none;
  }

  /* Model & Effort selector matching reference */
  .model-picker {
    position: relative;
  }

  .model-trigger {
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ai-text);
    background: transparent;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background-color 130ms ease;
    user-select: none;
  }

  .model-trigger:hover,
  .model-trigger.open {
    background: var(--ai-chip-bg);
  }

  .model-trigger-name {
    font-weight: 500;
  }

  .model-trigger-effort {
    color: var(--ai-secondary);
    font-weight: 400;
  }

  .model-chevron {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--ai-secondary);
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 140ms ease;
  }

  .model-chevron.open {
    transform: rotate(180deg);
  }

  .model-popover {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    width: 268px;
    padding: 6px;
    border-radius: 12px;
    border: 1px solid var(--ai-popover-border);
    background: var(--ai-popover-bg);
    box-shadow: var(--ai-popover-shadow);
    backdrop-filter: blur(18px);
    z-index: 30;
    user-select: none;
  }

  .model-options {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .model-option {
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: 9px;
    text-align: left;
    color: var(--ai-text);
    background: transparent;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font: inherit;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .model-option:hover:not(.selected) {
    background: var(--ai-option-hover);
  }

  .model-option.selected {
    color: var(--ai-option-selected-text);
    background: var(--ai-option-selected-bg);
  }

  .model-option-top {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .model-option-name {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.2;
  }

  .model-badge {
    padding: 2px 6px;
    border-radius: 5px;
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.2;
    color: var(--ai-badge-text);
    background: var(--ai-badge-bg);
  }

  .model-option-desc {
    font-size: 11.5px;
    line-height: 1.3;
    color: var(--ai-secondary);
  }

  .model-option.selected .model-option-desc {
    color: var(--ai-option-selected-desc);
  }

  .effort-row {
    padding: 6px 8px 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .effort-label {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ai-text);
  }

  .effort-pills {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: 7px;
    background: var(--ai-chip-bg);
  }

  .effort-pill {
    height: 22px;
    padding: 0 8px;
    border: 0;
    border-radius: 5px;
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--ai-secondary);
    background: transparent;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .effort-pill.active {
    color: var(--ai-option-selected-text);
    background: var(--ai-option-selected-bg);
  }

  /* Send / Stop button */
  .send-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    display: grid;
    place-items: center;
    color: var(--ai-send-color);
    background: var(--ai-send-bg);
    cursor: default;
    transition: background-color 140ms ease, color 140ms ease;
  }

  .send-btn.ready {
    color: var(--ai-send-ready-color);
    background: var(--ai-send-ready-bg);
    cursor: pointer;
  }

  .send-btn.stop {
    color: #ffffff;
    background: #f23645;
    cursor: pointer;
  }

  .send-btn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.85;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .disclaimer {
    padding: 0 2px;
    font-size: 11px;
    color: var(--ai-secondary);
  }

  .strat-result-strip {
    margin-top: 8px;
    padding: 9px 11px;
    border-radius: 8px;
    border: 1px solid var(--ai-border);
    background: var(--ai-chip-bg);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .srs-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .srs-name {
    font-size: 12px;
    font-weight: 700;
    color: var(--ai-text);
  }

  .srs-verdict {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(140, 140, 140, 0.16);
    color: var(--ai-secondary);
  }

  .srs-verdict.pass {
    background: rgba(8, 153, 129, 0.18);
    color: #089981;
  }

  .srs-verdict.warn {
    background: rgba(245, 158, 11, 0.18);
    color: #f59e0b;
  }

  .srs-verdict.fail {
    background: rgba(242, 54, 69, 0.18);
    color: #f23645;
  }

  .srs-metrics {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-size: 11px;
    color: var(--ai-secondary);
    font-variant-numeric: tabular-nums;
  }

  .srs-metrics .pos {
    color: #089981;
    font-weight: 600;
  }

  .srs-metrics .neg {
    color: #f23645;
    font-weight: 600;
  }

  .srs-open-btn {
    align-self: flex-start;
    height: 25px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--ai-border);
    background: transparent;
    color: var(--ai-text);
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  .srs-open-btn:hover {
    background: var(--ai-option-hover);
  }

  /* Agentic Steps, Tier-1 Action Chips, and Tier-2 Approval Cards */
  .status-spinner.small {
    width: 11px;
    height: 11px;
    flex: 0 0 11px;
  }

  .status-spinner.tiny {
    width: 9px;
    height: 9px;
    border-width: 1.5px;
  }

  .agent-steps-box {
    border: 1px solid var(--ai-border-soft);
    border-radius: 9px;
    background: var(--ai-elevated);
    font-size: 11.5px;
  }

  .agent-steps-box summary {
    padding: 7px 10px;
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--ai-secondary);
    font-weight: 600;
    cursor: pointer;
    list-style: none;
    user-select: none;
  }

  .agent-steps-box summary::-webkit-details-marker {
    display: none;
  }

  .agent-steps-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #089981;
    flex: 0 0 6px;
  }

  .agent-steps-title {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .agent-steps-list {
    padding: 6px 10px 8px;
    border-top: 1px solid var(--ai-border-soft);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .agent-step-row {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    color: var(--ai-text);
  }

  .agent-step-row.err {
    color: #f23645;
  }

  .agent-step-icon {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    margin-top: 1px;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 700;
    color: #089981;
  }

  .agent-step-row.err .agent-step-icon {
    color: #f23645;
  }

  .agent-step-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .agent-step-label {
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.3;
  }

  .agent-step-detail {
    font-size: 10.5px;
    color: var(--ai-secondary);
    line-height: 1.3;
  }

  .agent-actions-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .agent-action-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 9px;
    border-radius: 8px;
    border: 1px solid rgba(8, 153, 129, 0.3);
    background: rgba(8, 153, 129, 0.08);
    font-size: 11.5px;
  }

  .agent-action-chip.undone {
    border-color: var(--ai-border);
    background: var(--ai-elevated);
    opacity: 0.72;
  }

  .agent-action-chip.failed {
    border-color: rgba(242, 54, 69, 0.32);
    background: rgba(242, 54, 69, 0.08);
  }

  .aac-icon {
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 700;
    color: #089981;
    background: rgba(8, 153, 129, 0.16);
  }

  .agent-action-chip.undone .aac-icon {
    color: var(--ai-secondary);
    background: var(--ai-chip-bg);
  }

  .agent-action-chip.failed .aac-icon {
    color: #f23645;
    background: rgba(242, 54, 69, 0.16);
  }

  .aac-main {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .aac-label {
    font-weight: 600;
    color: var(--ai-text);
    line-height: 1.25;
  }

  .aac-detail {
    font-size: 10.5px;
    color: var(--ai-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .aac-undo-btn {
    height: 22px;
    padding: 0 8px;
    flex: 0 0 auto;
    border: 1px solid var(--ai-border);
    border-radius: 5px;
    background: var(--ai-surface);
    color: var(--ai-text);
    font: inherit;
    font-size: 10.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  .aac-undo-btn:hover {
    background: var(--ai-option-hover);
  }

  .approval-cards-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 2px;
  }

  .approval-card {
    padding: 10px 11px;
    border-radius: 10px;
    border: 1px solid var(--ai-border);
    background: var(--ai-elevated);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .approval-card.resolved {
    opacity: 0.85;
  }

  .ac-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .ac-title-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .ac-side-badge {
    padding: 2px 6px;
    border-radius: 5px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
    flex: 0 0 auto;
  }

  .ac-side-badge.buy {
    background: rgba(8, 153, 129, 0.18);
    color: #089981;
  }

  .ac-side-badge.sell {
    background: rgba(242, 54, 69, 0.18);
    color: #f23645;
  }

  .ac-side-badge.warn {
    background: rgba(245, 158, 11, 0.18);
    color: #d97706;
  }

  .ac-side-badge.bot {
    background: rgba(41, 98, 255, 0.16);
    color: #2962ff;
  }

  .ac-symbol {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--ai-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ac-status-pill {
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    background: var(--ai-chip-bg);
    color: var(--ai-secondary);
    flex: 0 0 auto;
  }

  .ac-status-pill.ok {
    background: rgba(8, 153, 129, 0.16);
    color: #089981;
  }

  .ac-rationale {
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--ai-secondary);
  }

  .ac-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }

  .ac-grid.two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ac-cell {
    padding: 5px 7px;
    border-radius: 6px;
    border: 1px solid var(--ai-border-soft);
    background: var(--ai-surface);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .ac-k {
    font-size: 9.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--ai-secondary);
  }

  .ac-v {
    font-size: 11.5px;
    font-weight: 700;
    color: var(--ai-text);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ac-v.pos {
    color: #089981;
  }

  .ac-v.neg {
    color: #f23645;
  }

  .ac-meta-note {
    font-size: 10.5px;
    color: var(--ai-secondary);
  }

  .ac-warnings {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(245, 158, 11, 0.11);
    border: 1px solid rgba(245, 158, 11, 0.28);
  }

  .ac-warning-item {
    font-size: 11px;
    line-height: 1.35;
    color: #d97706;
    font-weight: 500;
  }

  .ac-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
  }

  .ac-btn {
    height: 27px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--ai-border);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 120ms ease, opacity 120ms ease;
  }

  .ac-btn.primary {
    border-color: #2962ff;
    background: #2962ff;
    color: #ffffff;
  }

  .ac-btn.primary:hover {
    opacity: 0.92;
  }

  .ac-btn.execute {
    border-color: rgba(8, 153, 129, 0.45);
    background: rgba(8, 153, 129, 0.14);
    color: #089981;
  }

  .ac-btn.execute:hover {
    background: rgba(8, 153, 129, 0.22);
  }

  .ac-btn.ghost {
    background: transparent;
    color: var(--ai-secondary);
  }

  .ac-btn.ghost:hover {
    color: var(--ai-text);
    background: var(--ai-option-hover);
  }

  .ac-result-note {
    font-size: 11px;
    font-weight: 600;
    color: var(--ai-secondary);
  }
</style>
