import "./style.css";
import {
  generateText,
  probeApi,
  listModels,
  type RequestPayload,
  type ModelInfo
} from "./api";

type StatusKind = "ready" | "loading" | "error";
type ApiMode = "vllm-generate" | "openai-completions" | "openai-chat";
type ThemeMode = "light" | "dark";

interface StoredSettings {
  apiBase: string;
  endpoint: string;
  mode: ApiMode;
  model: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  minP?: number;
  repetitionPenalty?: number;
  showRaw: boolean;
}

interface ConversationEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  raw?: unknown;
  pending?: boolean;
  error?: boolean;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  tokensPerSecond?: number;
  reasoning?: string[];
  fresh?: boolean;
}

interface UsageStats {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

const STORAGE_KEY = "vllm.front.settings";
const THEME_STORAGE_KEY = "vllm.front.theme";
const ENV_BASE = import.meta.env?.VITE_API_BASE_URL as string | undefined;
const DEFAULT_BASE = ENV_BASE ?? "http://127.0.0.1:8000";
const DEFAULT_MODE: ApiMode = "openai-chat";
const MODE_ENDPOINTS: Record<ApiMode, string> = {
  "vllm-generate": "/generate",
  "openai-completions": "/v1/completions",
  "openai-chat": "/v1/chat/completions"
};
const MODEL_LIST_PATHS: Partial<Record<ApiMode, string>> = {
  "openai-completions": "/v1/models",
  "openai-chat": "/v1/models"
};

let messageCounter = 0;

function loadSettings(): Partial<StoredSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Partial<StoredSettings>;
  } catch (error) {
    console.warn("Unable to load stored settings:", error);
    return {};
  }
}

function persistSettings(settings: StoredSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("Unable to persist settings:", error);
  }
}

function ensureNumber(value: string, fallback: number): number {
  if (value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function setStatus(statusEl: HTMLElement, status: StatusKind, message: string) {
  statusEl.dataset.status = status;
  const messageEl = statusEl.querySelector<HTMLSpanElement>("[data-role=status-message]");
  if (messageEl) {
    messageEl.textContent = message;
  }
}

interface ProcessedText {
  visible: string;
  reasoning: string[];
}

function splitThinkingSegments(text: string): ProcessedText {
  const reasoning: string[] = [];
  if (!text.includes("<think>")) {
    return { visible: text, reasoning };
  }

  const pattern = /<think>([\s\S]*?)<\/think>/gi;
  let visible = text;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const segment = match[1]?.trim();
    if (segment) {
      reasoning.push(segment);
    }
  }

  visible = visible.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trim();

  return { visible, reasoning };
}

function showError(errorEl: HTMLElement, message: string) {
  errorEl.textContent = message;
  errorEl.removeAttribute("hidden");
}

function clearError(errorEl: HTMLElement) {
  errorEl.textContent = "";
  errorEl.setAttribute("hidden", "true");
}

function getDefaultEndpoint(mode: ApiMode): string {
  return MODE_ENDPOINTS[mode];
}

function getModelListPath(mode: ApiMode): string | undefined {
  return MODEL_LIST_PATHS[mode];
}

function parseStops(input: string): string[] | undefined {
  const items = input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return items.length ? items : undefined;
}

function composePrompt(systemPrompt: string, userPrompt: string): string {
  const trimmedSystem = systemPrompt.trim();
  if (!trimmedSystem) {
    return userPrompt;
  }
  return `${trimmedSystem}\n\n${userPrompt}`;
}

function extractUsage(payload: unknown): UsageStats {
  const stats: UsageStats = {};
  if (!payload || typeof payload !== "object") {
    return stats;
  }

  const data = payload as Record<string, unknown>;
  const usageNode = data.usage;
  const statsNode = data.statistics ?? data.stats ?? data.meta;

  const candidates = [usageNode, statsNode, data];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;

    if (typeof record.completion_tokens === "number") {
      stats.completionTokens = record.completion_tokens;
    }
    if (typeof record.prompt_tokens === "number") {
      stats.promptTokens = record.prompt_tokens;
    }
    if (typeof record.total_tokens === "number") {
      stats.totalTokens = record.total_tokens;
    }
    if (typeof record.generated_tokens === "number") {
      stats.completionTokens ??= record.generated_tokens;
    }
    if (typeof record.num_generated_tokens === "number") {
      stats.completionTokens ??= record.num_generated_tokens;
    }
    if (typeof record.num_output_tokens === "number") {
      stats.completionTokens ??= record.num_output_tokens;
    }
    if (typeof record.output_tokens === "number") {
      stats.completionTokens ??= record.output_tokens;
    }
    if (typeof record.num_input_tokens === "number") {
      stats.promptTokens ??= record.num_input_tokens;
    }
    if (typeof record.input_tokens === "number") {
      stats.promptTokens ??= record.input_tokens;
    }
    if (typeof record.prompt_token_count === "number") {
      stats.promptTokens ??= record.prompt_token_count;
    }
    if (typeof record.generated_token_count === "number") {
      stats.completionTokens ??= record.generated_token_count;
    }
    if (!stats.totalTokens && typeof record.total_token_count === "number") {
      stats.totalTokens = record.total_token_count;
    }
  }

  if (
    typeof stats.totalTokens !== "number" &&
    typeof stats.promptTokens === "number" &&
    typeof stats.completionTokens === "number"
  ) {
    stats.totalTokens = stats.promptTokens + stats.completionTokens;
  }

  return stats;
}

function formatTime(timestamp: Date): string {
  return timestamp.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatMetadata(entry: ConversationEntry): string {
  const parts: string[] = [formatTime(entry.timestamp)];

  if (typeof entry.completionTokens === "number") {
    parts.push(`Completion ${entry.completionTokens} tok`);
  }
  if (typeof entry.durationMs === "number") {
    parts.push(`${(entry.durationMs / 1000).toFixed(2)} s`);
  }
  if (
    typeof entry.tokensPerSecond === "number" &&
    Number.isFinite(entry.tokensPerSecond)
  ) {
    parts.push(`${entry.tokensPerSecond.toFixed(1)} tok/s`);
  }

  if (entry.error) {
    parts.push("Error");
  } else if (entry.pending) {
    parts.push("Pending");
  }

  return parts.join(" · ");
}

function buildLayout(): {
  elements: {
    statusLine: HTMLElement;
    pingButton: HTMLButtonElement;
    form: HTMLFormElement;
    apiMode: HTMLSelectElement;
    model: HTMLInputElement;
    modelField: HTMLDivElement;
    modelStatus: HTMLParagraphElement;
    modelOptions: HTMLDivElement;
    refreshModels: HTMLButtonElement;
    endpoint: HTMLInputElement;
    systemPrompt: HTMLTextAreaElement;
    prompt: HTMLTextAreaElement;
    maxTokens: HTMLInputElement;
    temperature: HTMLInputElement;
    topP: HTMLInputElement;
    minP: HTMLInputElement;
    repetitionPenalty: HTMLInputElement;
    stopSequences: HTMLInputElement;
    submitButton: HTMLButtonElement;
    cancelButton: HTMLButtonElement;
    errorBox: HTMLElement;
    chatThread: HTMLDivElement;
    tokenStats: HTMLSpanElement;
    themeToggle: HTMLButtonElement;
    themeIcon: HTMLElement;
    showRaw: HTMLInputElement;
  };
  defaults: StoredSettings;
} {
  const stored = loadSettings();
  const defaultMode = (stored.mode as ApiMode | undefined) ?? DEFAULT_MODE;
  const defaults: StoredSettings = {
    apiBase: ENV_BASE ?? stored.apiBase ?? DEFAULT_BASE,
    endpoint: stored.endpoint ?? MODE_ENDPOINTS[defaultMode],
    mode: defaultMode,
    model: stored.model ?? "",
    maxTokens: stored.maxTokens ?? 64,
    temperature: stored.temperature ?? 0.7,
    topP: stored.topP ?? 0.95,
    minP: stored.minP,
    repetitionPenalty: stored.repetitionPenalty,
    showRaw: stored.showRaw ?? false
  };

  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("Missing #app container.");
  }

  app.innerHTML = `
    <form id="generate-form" class="app-shell">
      <aside class="panel panel--left">
        <header class="panel-header">
          <h2>Connection</h2>
          <p>Configure how the UI reaches your vLLM server.</p>
        </header>
        <section class="status-line" data-status="ready" id="status-line">
          <div class="status-dot" aria-hidden="true"></div>
          <span data-role="status-message">Ready</span>
          <button type="button" id="ping-button" class="ghost-btn">Test</button>
        </section>
        <div class="field">
          <label for="api-mode">API mode</label>
          <select id="api-mode" name="apiMode">
            <option value="openai-chat"${defaults.mode === "openai-chat" ? " selected" : ""}>OpenAI Chat Completions (/v1/chat/completions)</option>
            <option value="openai-completions"${defaults.mode === "openai-completions" ? " selected" : ""}>OpenAI Completions (/v1/completions)</option>
            <option value="vllm-generate"${defaults.mode === "vllm-generate" ? " selected" : ""}>Raw Generate (/generate)</option>
          </select>
        </div>
        <div class="field" id="model-field">
          <label for="model">Model</label>
          <div class="model-selector">
            <p class="model-status" id="model-status">모델 목록을 불러오지 않았습니다.</p>
            <div class="model-options" id="model-options"></div>
            <div class="model-actions">
              <button type="button" id="refresh-models" class="ghost-btn">모델 목록 새로고침</button>
            </div>
          </div>
          <input
            type="text"
            id="model"
            name="model"
            value="${defaults.model}"
            placeholder="목록에서 선택하거나 직접 입력하세요"
          />
          <small>OpenAI 호환 엔드포인트에서 필요한 값입니다.</small>
        </div>
        <div class="field">
          <label for="endpoint">Endpoint path</label>
          <input type="text" id="endpoint" name="endpoint" value="${defaults.endpoint}" placeholder="/generate" required />
        </div>
      </aside>

      <section class="chat-panel">
        <header class="chat-header">
          <div class="chat-header__intro">
            <h1>vLLM Minimal Playground</h1>
            <p>Keep parameters light, iterate fast, and watch responses arrive like a chat thread.</p>
          </div>
          <div class="chat-header-actions">
            <button type="button" id="theme-toggle" class="ghost-btn theme-toggle" aria-label="다크 모드로 전환">
              <span data-theme-icon>🌙</span>
            </button>
            <span id="token-stats" class="token-stats" hidden></span>
          </div>
        </header>
        <div class="chat-thread" id="chat-thread">
          <div class="chat-placeholder">
            설정을 마치고 메시지를 입력하면 대화를 시작할 수 있습니다.
          </div>
        </div>
        <div class="composer">
          <label for="prompt">Message</label>
          <textarea id="prompt" name="prompt" rows="4" placeholder="Ask the model something..." required></textarea>
          <div class="composer-actions">
            <button type="button" id="cancel-btn" class="ghost-btn" disabled>Stop</button>
            <button type="submit" id="submit-btn" class="primary-btn">Send</button>
          </div>
          <p id="error-box" class="error" hidden></p>
        </div>
      </section>

      <aside class="panel panel--right">
        <header class="panel-header">
          <h2>Generation settings</h2>
          <p>Keep responses short to minimize GPU time.</p>
        </header>
        <details open>
          <summary>Basics</summary>
          <div class="field">
            <label for="system-prompt">System prompt (optional)</label>
            <textarea id="system-prompt" name="systemPrompt" rows="3" placeholder="High-level guidance sent before each user message."></textarea>
          </div>
          <div class="field">
            <label for="max-tokens">Max new tokens</label>
            <input type="number" id="max-tokens" name="maxTokens" min="1" max="4096" step="1" value="${defaults.maxTokens}" />
            <small>Lower values keep responses short and reduce GPU time.</small>
          </div>
          <div class="field">
            <label for="temperature">Temperature</label>
            <input type="number" id="temperature" name="temperature" min="0" max="2" step="0.05" value="${defaults.temperature}" />
          </div>
          <div class="field">
            <label for="top-p">Top P</label>
            <input type="number" id="top-p" name="topP" min="0" max="1" step="0.01" value="${defaults.topP}" />
          </div>
        </details>
        <details>
          <summary>Advanced controls</summary>
          <div class="field">
            <label for="min-p">Min P</label>
            <input type="number" id="min-p" name="minP" min="0" max="1" step="0.01" value="${defaults.minP ?? ""}" />
            <small>Raw generate 모드에서만 사용됩니다.</small>
          </div>
          <div class="field">
            <label for="repetition-penalty">Repetition penalty</label>
            <input type="number" id="repetition-penalty" name="repetitionPenalty" min="0" max="10" step="0.01" value="${defaults.repetitionPenalty ?? ""}" />
            <small>Raw generate 모드에서만 사용됩니다.</small>
          </div>
          <div class="field">
            <label for="stop-sequences">Stop sequences (comma separated)</label>
            <input type="text" id="stop-sequences" name="stopSequences" placeholder="END,###" />
          </div>
          <div class="field field--inline">
            <label class="inline-label" for="show-raw">Show raw response JSON</label>
            <input type="checkbox" id="show-raw" name="showRaw" ${defaults.showRaw ? "checked" : ""} />
          </div>
        </details>
      </aside>
    </form>
  `;

  const statusLine = document.querySelector<HTMLElement>("#status-line");
  const pingButton = document.querySelector<HTMLButtonElement>("#ping-button");
  const form = document.querySelector<HTMLFormElement>("#generate-form");
  const apiMode = document.querySelector<HTMLSelectElement>("#api-mode");
  const model = document.querySelector<HTMLInputElement>("#model");
  const modelField = document.querySelector<HTMLDivElement>("#model-field");
  const modelStatus = document.querySelector<HTMLParagraphElement>("#model-status");
  const modelOptions = document.querySelector<HTMLDivElement>("#model-options");
  const refreshModels = document.querySelector<HTMLButtonElement>("#refresh-models");
  const endpoint = document.querySelector<HTMLInputElement>("#endpoint");
  const systemPrompt = document.querySelector<HTMLTextAreaElement>("#system-prompt");
  const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
  const maxTokens = document.querySelector<HTMLInputElement>("#max-tokens");
  const temperature = document.querySelector<HTMLInputElement>("#temperature");
  const topP = document.querySelector<HTMLInputElement>("#top-p");
  const minP = document.querySelector<HTMLInputElement>("#min-p");
  const repetitionPenalty = document.querySelector<HTMLInputElement>("#repetition-penalty");
  const stopSequences = document.querySelector<HTMLInputElement>("#stop-sequences");
  const submitButton = document.querySelector<HTMLButtonElement>("#submit-btn");
  const cancelButton = document.querySelector<HTMLButtonElement>("#cancel-btn");
  const errorBox = document.querySelector<HTMLElement>("#error-box");
  const chatThread = document.querySelector<HTMLDivElement>("#chat-thread");
  const tokenStats = document.querySelector<HTMLSpanElement>("#token-stats");
  const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
  const themeIcon = themeToggle?.querySelector<HTMLElement>("[data-theme-icon]");
  const showRaw = document.querySelector<HTMLInputElement>("#show-raw");

  if (
    !statusLine ||
    !pingButton ||
    !form ||
    !apiMode ||
    !model ||
    !modelField ||
    !modelStatus ||
    !modelOptions ||
    !refreshModels ||
    !endpoint ||
    !systemPrompt ||
    !prompt ||
    !maxTokens ||
    !temperature ||
    !topP ||
    !minP ||
    !repetitionPenalty ||
    !stopSequences ||
    !submitButton ||
    !cancelButton ||
    !errorBox ||
    !chatThread ||
    !tokenStats ||
    !themeToggle ||
    !themeIcon ||
    !showRaw
  ) {
    throw new Error("Failed to initialize UI elements.");
  }

  return {
    elements: {
      statusLine,
      pingButton,
      form,
      apiMode,
      model,
      modelField,
      modelStatus,
      modelOptions,
      refreshModels,
      endpoint,
      systemPrompt,
      prompt,
      maxTokens,
      temperature,
      topP,
      minP,
      repetitionPenalty,
      stopSequences,
      submitButton,
      cancelButton,
      errorBox,
      chatThread,
      tokenStats,
      themeToggle,
      themeIcon,
      showRaw
    },
    defaults
  };
}

function bootstrap(): void {
  const { elements, defaults } = buildLayout();

  const settings: StoredSettings = { ...defaults };
  const conversation: ConversationEntry[] = [];

  let controller: AbortController | undefined;
  let lastMode: ApiMode = settings.mode;
  let modelList: ModelInfo[] = [];
  let loadingModels = false;
  let manualThemeOverride = false;

  const resolveBaseUrl = () => settings.apiBase?.trim() || DEFAULT_BASE;

  const getStoredTheme = (): ThemeMode | undefined => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        return stored;
      }
    } catch (error) {
      console.warn("Unable to load stored theme:", error);
    }
    return undefined;
  };

  const storeTheme = (mode: ThemeMode) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch (error) {
      console.warn("Unable to persist theme:", error);
    }
  };

  const clearStoredTheme = () => {
    try {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } catch (error) {
      console.warn("Unable to clear stored theme:", error);
    }
  };

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const storedTheme = getStoredTheme();
  manualThemeOverride = Boolean(storedTheme);
  let themeMode: ThemeMode =
    storedTheme ?? (prefersDark.matches ? "dark" : "light");

  const updateThemeToggle = (mode: ThemeMode) => {
    if (mode === "dark") {
      elements.themeIcon.textContent = "🌞";
      elements.themeToggle.setAttribute("aria-label", "라이트 모드로 전환");
      elements.themeToggle.setAttribute("title", "라이트 모드로 전환");
    } else {
      elements.themeIcon.textContent = "🌙";
      elements.themeToggle.setAttribute("aria-label", "다크 모드로 전환");
      elements.themeToggle.setAttribute("title", "다크 모드로 전환");
    }
  };

  const applyTheme = (mode: ThemeMode, options?: { persist?: boolean }) => {
    document.documentElement.setAttribute("data-theme", mode);
    themeMode = mode;
    updateThemeToggle(mode);
    if (options?.persist === true) {
      storeTheme(mode);
      manualThemeOverride = true;
    } else if (options?.persist === false) {
      clearStoredTheme();
      manualThemeOverride = false;
    }
  };

  applyTheme(themeMode, { persist: manualThemeOverride });

  const handleSystemThemeChange = (event: MediaQueryListEvent) => {
    if (!manualThemeOverride) {
      applyTheme(event.matches ? "dark" : "light", { persist: false });
    }
  };

  if (typeof prefersDark.addEventListener === "function") {
    prefersDark.addEventListener("change", handleSystemThemeChange);
  } else if (typeof prefersDark.addListener === "function") {
    prefersDark.addListener(handleSystemThemeChange);
  }

  elements.themeToggle.addEventListener("click", () => {
    const nextTheme: ThemeMode = themeMode === "dark" ? "light" : "dark";
    applyTheme(nextTheme, { persist: true });
  });

  const createMessageId = () => `msg-${Date.now()}-${messageCounter++}`;

  const persistFromControls = () => {
    settings.mode = (elements.apiMode.value as ApiMode) || DEFAULT_MODE;
    settings.endpoint =
      elements.endpoint.value.trim() || getDefaultEndpoint(settings.mode);
    settings.model = elements.model.value.trim();
    settings.maxTokens = ensureNumber(elements.maxTokens.value, defaults.maxTokens);
    settings.temperature = ensureNumber(elements.temperature.value, defaults.temperature);
    settings.topP = ensureNumber(elements.topP.value, defaults.topP);
    const minP = ensureNumber(elements.minP.value, NaN);
    settings.minP = Number.isNaN(minP) ? undefined : minP;
    const repPenalty = ensureNumber(elements.repetitionPenalty.value, NaN);
    settings.repetitionPenalty = Number.isNaN(repPenalty) ? undefined : repPenalty;
    settings.showRaw = elements.showRaw.checked;
    persistSettings(settings);
  };

  const updateModelStatus = (message: string) => {
    elements.modelStatus.textContent = message;
  };

  const highlightSelectedModel = (value: string) => {
    const buttons = elements.modelOptions.querySelectorAll<HTMLButtonElement>("[data-model-id]");
    buttons.forEach((button) => {
      if (button.dataset.modelId === value && value) {
        button.classList.add("active");
        button.setAttribute("aria-pressed", "true");
      } else {
        button.classList.remove("active");
        button.removeAttribute("aria-pressed");
      }
    });
  };

  const updateModelStatusForSelection = () => {
    const selected = elements.model.value.trim();

    if (!modelList.length) {
      updateModelStatus(
        selected ? `선택된 모델: ${selected}` : "모델을 선택하거나 직접 입력하세요."
      );
      return;
    }

    const serverModel = modelList[0]?.id;
    const parts: string[] = [];

    if (selected) {
      parts.push(`선택된 모델: ${selected}`);
    } else {
      parts.push("모델을 선택하세요.");
    }

    if (serverModel) {
      parts.push(`서버 모델: ${serverModel}`);
    }

    updateModelStatus(parts.join(" · "));
  };

  const renderModelOptions = (list: ModelInfo[]) => {
    elements.modelOptions.innerHTML = "";

    if (!list.length) {
      return;
    }

    list.forEach((info) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-chip";
      button.dataset.modelId = info.id;
      button.textContent = info.id;
      button.title = info.ownedBy ? `${info.id} · ${info.ownedBy}` : info.id;
      button.addEventListener("click", () => {
        elements.model.value = info.id;
        highlightSelectedModel(info.id);
        updateModelStatusForSelection();
        persistFromControls();
      });
      elements.modelOptions.appendChild(button);
    });

    highlightSelectedModel(elements.model.value.trim());
  };

  const updateTokenStatsDisplay = () => {
    const statsElement = elements.tokenStats;
    const lastAssistant = [...conversation]
      .reverse()
      .find((entry) => entry.role === "assistant" && !entry.pending && !entry.error);

    if (!lastAssistant) {
      statsElement.setAttribute("hidden", "true");
      statsElement.textContent = "";
      return;
    }

    const parts: string[] = [];
    if (typeof lastAssistant.completionTokens === "number") {
      parts.push(`Completion ${lastAssistant.completionTokens} tok`);
    }
    if (typeof lastAssistant.durationMs === "number") {
      parts.push(`${(lastAssistant.durationMs / 1000).toFixed(2)} s`);
    }
    if (
      typeof lastAssistant.tokensPerSecond === "number" &&
      Number.isFinite(lastAssistant.tokensPerSecond)
    ) {
      parts.push(`${lastAssistant.tokensPerSecond.toFixed(1)} tok/s`);
    }

    if (!parts.length) {
      statsElement.setAttribute("hidden", "true");
      statsElement.textContent = "";
      return;
    }

    statsElement.textContent = parts.join(" · ");
    statsElement.removeAttribute("hidden");
  };

  const renderConversation = () => {
    elements.chatThread.innerHTML = "";

    if (!conversation.length) {
      const placeholder = document.createElement("div");
      placeholder.className = "chat-placeholder";
      placeholder.textContent =
        "설정을 마친 뒤 메시지를 입력하면 대화가 여기에 표시됩니다.";
      elements.chatThread.appendChild(placeholder);
      updateTokenStatsDisplay();
      return;
    }

    const showRawResponses = elements.showRaw.checked;

    conversation.forEach((entry) => {
      const article = document.createElement("article");
      article.className = `message message--${entry.role}`;
      if (entry.pending) {
        article.classList.add("message--pending");
      }
      if (entry.error) {
        article.classList.add("message--error");
      }
      if (entry.fresh) {
        article.classList.add("message--fresh");
      }

      if (entry.reasoning && entry.reasoning.length) {
        const reasoningDetails = document.createElement("details");
        reasoningDetails.className = "message-reasoning";
        const summary = document.createElement("summary");
        summary.textContent = `Show hidden reasoning (${entry.reasoning.length})`;
        reasoningDetails.appendChild(summary);
        const reasoningPre = document.createElement("pre");
        reasoningPre.textContent = entry.reasoning.join("\n\n");
        reasoningDetails.appendChild(reasoningPre);
        article.appendChild(reasoningDetails);
      }

      const bubble = document.createElement("div");
      bubble.className = "message-content";
      bubble.textContent = entry.content || "(No visible content)";
      article.appendChild(bubble);

      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = formatMetadata(entry);
      article.appendChild(meta);

      if (entry.raw && showRawResponses) {
        const details = document.createElement("details");
        details.className = "message-raw";
        const summary = document.createElement("summary");
        summary.textContent = "View raw response";
        details.appendChild(summary);
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(entry.raw, null, 2);
        details.appendChild(pre);
        article.appendChild(details);
      }

      elements.chatThread.appendChild(article);
    });

    elements.chatThread.scrollTop = elements.chatThread.scrollHeight;
    updateTokenStatsDisplay();
  };

  const addMessage = (entry: ConversationEntry) => {
    conversation.push(entry);
    renderConversation();
  };

  const updateMessage = (
    target: ConversationEntry,
    updates: Partial<ConversationEntry>
  ) => {
    const becameFresh = updates.fresh === true;
    Object.assign(target, updates);
    renderConversation();
    if (becameFresh) {
      window.setTimeout(() => {
        if (target.fresh) {
          target.fresh = false;
          renderConversation();
        }
      }, 800);
    }
  };

  const loadModels = async (options?: { force?: boolean }) => {
    const mode = (elements.apiMode.value as ApiMode) || DEFAULT_MODE;
    const base = resolveBaseUrl();
    const path = getModelListPath(mode);

    if (!path) {
      modelList = [];
      elements.modelOptions.innerHTML = "";
      updateModelStatus("Raw generate 모드에서는 모델 선택이 필요하지 않습니다.");
      loadingModels = false;
      elements.refreshModels.disabled = false;
      return;
    }

    if (loadingModels && !options?.force) {
      return;
    }

    loadingModels = true;
    elements.refreshModels.disabled = true;
    updateModelStatus("모델 목록을 불러오는 중...");

    try {
      const result = await listModels(base, path);
      const activeMode = (elements.apiMode.value as ApiMode) || DEFAULT_MODE;
      if (activeMode !== mode) {
        loadingModels = false;
        elements.refreshModels.disabled = false;
        return;
      }

      modelList = result;
      if (!modelList.length) {
        elements.modelOptions.innerHTML = "";
        const selected = elements.model.value.trim();
        updateModelStatus(
          selected
            ? `선택된 모델: ${selected} · 서버 목록이 비어 있습니다.`
            : "모델 목록이 비어 있습니다. 직접 입력하세요."
        );
        updateTokenStatsDisplay();
        return;
      }

      renderModelOptions(modelList);

      if (!elements.model.value.trim() && modelList.length) {
        elements.model.value = modelList[0].id;
        persistFromControls();
      }

      updateModelStatusForSelection();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "모델 목록을 불러오지 못했습니다.";
      updateModelStatus(message);
      modelList = [];
      elements.modelOptions.innerHTML = "";
    } finally {
      loadingModels = false;
      elements.refreshModels.disabled = false;
    }
  };

  const applyModeEffects = (isInitial = false) => {
    const mode = (elements.apiMode.value as ApiMode) || DEFAULT_MODE;
    const defaultEndpoint = getDefaultEndpoint(mode);
    const currentEndpoint = elements.endpoint.value.trim();
    const previousDefault = getDefaultEndpoint(lastMode);

    elements.endpoint.placeholder = defaultEndpoint;

    const shouldUpdateEndpoint =
      !currentEndpoint || (!isInitial && currentEndpoint === previousDefault);

    if (shouldUpdateEndpoint) {
      elements.endpoint.value = defaultEndpoint;
    }

    if (mode === "vllm-generate") {
      elements.modelField.setAttribute("hidden", "true");
      elements.model.required = false;
      modelList = [];
      elements.modelOptions.innerHTML = "";
      updateModelStatus("Raw generate 모드에서는 모델 선택이 필요하지 않습니다.");
    } else {
      elements.modelField.removeAttribute("hidden");
      elements.model.required = true;
      if (!isInitial || !modelList.length) {
        void loadModels({ force: true });
      } else {
        highlightSelectedModel(elements.model.value.trim());
        updateModelStatusForSelection();
      }
    }

    lastMode = mode;
  };

  applyModeEffects(true);

  if (document.hasFocus()) {
    elements.prompt.focus();
  }

  elements.refreshModels.addEventListener("click", () => {
    void loadModels({ force: true });
  });

  elements.model.addEventListener("input", () => {
    highlightSelectedModel(elements.model.value.trim());
    updateModelStatusForSelection();
  });

  elements.model.addEventListener("change", () => {
    highlightSelectedModel(elements.model.value.trim());
    updateModelStatusForSelection();
    persistFromControls();
  });

  elements.showRaw.addEventListener("change", () => {
    persistFromControls();
    renderConversation();
  });

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError(elements.errorBox);

    const userPrompt = elements.prompt.value.trim();
    if (!userPrompt) {
      showError(elements.errorBox, "Please enter a message before sending.");
      return;
    }

    const base = resolveBaseUrl();
    const mode = (elements.apiMode.value as ApiMode) || DEFAULT_MODE;
    const endpoint =
      elements.endpoint.value.trim() || getDefaultEndpoint(mode);

    if (!base || !endpoint) {
      showError(elements.errorBox, "Both API base URL and endpoint path are required.");
      return;
    }

    if (mode !== "vllm-generate" && !elements.model.value.trim()) {
      showError(elements.errorBox, "Model ID is required for OpenAI-compatible endpoints.");
      return;
    }

    const payload: RequestPayload = {};
    const maxTokens = ensureNumber(elements.maxTokens.value, defaults.maxTokens);
    const temperature = ensureNumber(elements.temperature.value, defaults.temperature);
    const topP = ensureNumber(elements.topP.value, defaults.topP);
    const stopSequences = parseStops(elements.stopSequences.value);

    if (mode === "vllm-generate") {
      payload.prompt = composePrompt(elements.systemPrompt.value, userPrompt);
      payload.max_tokens = maxTokens;
      payload.temperature = temperature;
      payload.top_p = topP;

      const minP = ensureNumber(elements.minP.value, defaults.minP ?? NaN);
      if (!Number.isNaN(minP)) {
        payload.min_p = minP;
      }

      const repetitionPenalty = ensureNumber(
        elements.repetitionPenalty.value,
        defaults.repetitionPenalty ?? NaN
      );
      if (!Number.isNaN(repetitionPenalty)) {
        payload.repetition_penalty = repetitionPenalty;
      }

      if (stopSequences) {
        payload.stop = stopSequences;
      }
    } else if (mode === "openai-completions") {
      const modelId = elements.model.value.trim();

      payload.model = modelId;
      payload.prompt = composePrompt(elements.systemPrompt.value, userPrompt);
      payload.max_tokens = maxTokens;
      payload.temperature = temperature;
      payload.top_p = topP;
      if (stopSequences) {
        payload.stop = stopSequences.length === 1 ? stopSequences[0] : stopSequences;
      }
    } else {
      const modelId = elements.model.value.trim();

      const messages: Array<{ role: string; content: string }> = [];
      const systemText = elements.systemPrompt.value.trim();
      if (systemText) {
        messages.push({ role: "system", content: systemText });
      }
      messages.push({ role: "user", content: userPrompt });

      payload.model = modelId;
      payload.messages = messages;
      payload.max_tokens = maxTokens;
      payload.temperature = temperature;
      payload.top_p = topP;
      if (stopSequences) {
        payload.stop = stopSequences.length === 1 ? stopSequences[0] : stopSequences;
      }
    }

    persistFromControls();

    const requestStartedAt = performance.now();

    const userMessage: ConversationEntry = {
      id: createMessageId(),
      role: "user",
      content: userPrompt,
      timestamp: new Date()
    };

    addMessage(userMessage);
    elements.prompt.value = "";

    const assistantMessage: ConversationEntry = {
      id: createMessageId(),
      role: "assistant",
      content: "모델 응답을 기다리는 중...",
      pending: true,
      timestamp: new Date()
    };
    addMessage(assistantMessage);

    try {
      controller = new AbortController();
      elements.submitButton.disabled = true;
      elements.cancelButton.disabled = false;
      setStatus(elements.statusLine, "loading", "Awaiting model response...");

      const result = await generateText(base, endpoint, payload, controller.signal);
      const durationMs = performance.now() - requestStartedAt;
      const usage = extractUsage(result.raw);
      const completionTokens = usage.completionTokens ?? usage.totalTokens;
      const tokensPerSecond =
        completionTokens && durationMs > 0
          ? completionTokens / (durationMs / 1000)
          : undefined;

      const processedOutputs = result.texts.map(splitThinkingSegments);
      const visibleParts = processedOutputs
        .map((item) => item.visible.trim())
        .filter((part) => part.length > 0);
      const reasoningSegments = processedOutputs.flatMap((item) => item.reasoning);
      const displayContent =
        visibleParts.length > 0
          ? visibleParts.join("\n\n")
          : reasoningSegments.length
          ? "[Hidden reasoning only]"
          : "No text returned by the server.";

      updateMessage(assistantMessage, {
        content: displayContent,
        reasoning: reasoningSegments.length ? reasoningSegments : undefined,
        raw: result.raw,
        pending: false,
        error: false,
        fresh: true,
        durationMs,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        tokensPerSecond,
        timestamp: new Date()
      });

      setStatus(elements.statusLine, "ready", "Response received.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        updateMessage(assistantMessage, {
          content: "요청이 취소되었습니다.",
          pending: false,
          error: true,
          timestamp: new Date()
        });
        setStatus(elements.statusLine, "ready", "Request cancelled.");
        showError(elements.errorBox, "Request cancelled.");
      } else if (error instanceof Error) {
        updateMessage(assistantMessage, {
          content: error.message,
          pending: false,
          error: true,
          timestamp: new Date()
        });
        setStatus(elements.statusLine, "error", "Request failed.");
        showError(elements.errorBox, error.message);
      } else {
        updateMessage(assistantMessage, {
          content: "An unknown error occurred.",
          pending: false,
          error: true,
          timestamp: new Date()
        });
        setStatus(elements.statusLine, "error", "Request failed.");
        showError(elements.errorBox, "An unknown error occurred.");
      }
    } finally {
      controller = undefined;
      elements.submitButton.disabled = false;
      elements.cancelButton.disabled = true;
      elements.prompt.focus();
    }
  });

  elements.cancelButton.addEventListener("click", () => {
    if (controller) {
      controller.abort();
    }
  });

  elements.apiMode.addEventListener("change", () => {
    applyModeEffects();
    persistFromControls();
  });

  elements.pingButton.addEventListener("click", async () => {
    clearError(elements.errorBox);
    setStatus(elements.statusLine, "loading", "Pinging server...");
    try {
      const base = resolveBaseUrl();
      const mode = (elements.apiMode.value as ApiMode) || DEFAULT_MODE;
      const probePath = mode === "vllm-generate" ? "/docs" : "/v1/models";
      const statusCode = await probeApi(base, probePath);
      if (statusCode >= 200 && statusCode < 300) {
        setStatus(elements.statusLine, "ready", "Good");
        clearError(elements.errorBox);
      } else {
        setStatus(elements.statusLine, "error", "Bad");
        showError(
          elements.errorBox,
          `Server responded with status ${statusCode}.`
        );
      }
    } catch (error) {
      setStatus(elements.statusLine, "error", "Bad");
      if (error instanceof Error) {
        showError(elements.errorBox, error.message);
      } else {
        showError(elements.errorBox, "Could not reach server.");
      }
    }
  });
}

bootstrap();
