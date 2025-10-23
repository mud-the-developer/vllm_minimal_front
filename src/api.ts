export interface GenerateResult {
  texts: string[];
  raw: unknown;
}

export type RequestPayload = Record<string, unknown>;

export interface ModelInfo {
  id: string;
  object?: string;
  ownedBy?: string;
}

const JSON_POST_HEADERS = { "Content-Type": "application/json" };

function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) {
    throw new Error("API base URL is required.");
  }

  const sanitizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const sanitizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${sanitizedBase}${sanitizedPath}`;
}

function extractTextsFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as Record<string, unknown>;

  if (Array.isArray(data.text)) {
    return data.text
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .filter(Boolean);
  }

  if (Array.isArray(data.outputs)) {
    return data.outputs
      .map((item) => {
        if (!item || typeof item !== "object") {
          return undefined;
        }

        const outputCandidate = item as Record<string, unknown>;
        if (typeof outputCandidate.text === "string") {
          return outputCandidate.text;
        }

        if (typeof outputCandidate.output_text === "string") {
          return outputCandidate.output_text;
        }

        return undefined;
      })
      .filter((item): item is string => Boolean(item));
  }

  if (Array.isArray((data as Record<string, unknown>).choices)) {
    const choices = (data as Record<string, unknown>).choices as unknown[];
    return choices
      .map((choice) => {
        if (!choice || typeof choice !== "object") {
          return undefined;
        }

        const record = choice as Record<string, unknown>;
        if (typeof record.text === "string") {
          return record.text;
        }

        const message = record.message;
        if (
          message &&
          typeof message === "object" &&
          "content" in (message as Record<string, unknown>)
        ) {
          const content = (message as Record<string, unknown>).content;
          if (typeof content === "string") {
            return content;
          }

          if (Array.isArray(content)) {
            return content
              .map((item) => {
                if (!item || typeof item !== "object") {
                  return "";
                }
                const part = item as Record<string, unknown>;
                if (typeof part.text === "string") {
                  return part.text;
                }
                if (typeof part.content === "string") {
                  return part.content;
                }
                return "";
              })
              .join("");
          }
        }

        return undefined;
      })
      .filter((item): item is string => Boolean(item));
  }

  if (typeof data.generated_text === "string") {
    return [data.generated_text];
  }

  return [];
}

export async function generateText(
  baseUrl: string,
  endpoint: string,
  payload: RequestPayload,
  signal?: AbortSignal
): Promise<GenerateResult> {
  const response = await fetch(joinUrl(baseUrl, endpoint), {
    method: "POST",
    headers: JSON_POST_HEADERS,
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Request failed with ${response.status}: ${message || response.statusText}`
    );
  }

  const data = (await response.json()) as unknown;

  return {
    texts: extractTextsFromPayload(data),
    raw: data
  };
}

export async function probeApi(baseUrl: string, path?: string): Promise<number> {
  const target = path ? joinUrl(baseUrl, path) : baseUrl;
  const response = await fetch(target, { method: "GET" });
  return response.status;
}

export async function listModels(baseUrl: string, path: string): Promise<ModelInfo[]> {
  const response = await fetch(joinUrl(baseUrl, path), {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Fetching models failed with ${response.status}: ${message || response.statusText}`
    );
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as Record<string, unknown>;

  if (Array.isArray(data.data)) {
    return data.data
      .map((item) => {
        if (!item || typeof item !== "object") {
          return undefined;
        }
        const record = item as Record<string, unknown>;
        const id = record.id;
        if (typeof id !== "string" || !id) {
          return undefined;
        }
        return {
          id,
          object: typeof record.object === "string" ? record.object : undefined,
          ownedBy: typeof record.owned_by === "string" ? record.owned_by : undefined
        };
      })
      .filter((item): item is ModelInfo => Boolean(item));
  }

  if (Array.isArray(data.models)) {
    return data.models
      .map((item) => {
        if (typeof item === "string") {
          return { id: item };
        }
        if (!item || typeof item !== "object") {
          return undefined;
        }
        const record = item as Record<string, unknown>;
        const id = record.id;
        if (typeof id !== "string" || !id) {
          return undefined;
        }
        return {
          id,
          object: typeof record.object === "string" ? record.object : undefined,
          ownedBy: typeof record.owned_by === "string" ? record.owned_by : undefined
        };
      })
      .filter((item): item is ModelInfo => Boolean(item));
  }

  if (Array.isArray(payload)) {
    return (payload as unknown[])
      .map((item) => (typeof item === "string" ? { id: item } : undefined))
      .filter((item): item is ModelInfo => Boolean(item));
  }

  return [];
}
