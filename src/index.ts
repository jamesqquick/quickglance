interface AnalyzeRequest {
  url: string;
  expectedTakeaway: string;
  refresh?: boolean;
}

interface AnalysisResult {
  mainTakeaway: string;
  grade: string;
  alignmentVerdict: string;
  whatsWorking: string[];
  whatsConfusing: string[];
  whatsMissing: string[];
}

interface AnalyzeResponse {
  id: string;
  url: string;
  expectedTakeaway: string;
  screenshot: string;
  analysis: AnalysisResult;
  cached: boolean;
  createdAt: number;
}

interface StoredAnalysis {
  url: string;
  expectedTakeaway: string;
  screenshot: string;
  analysis: AnalysisResult;
  createdAt: number;
}

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

class BrowserSnapshotError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "BrowserSnapshotError";
  }
}

class AIResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIResponseError";
  }
}

async function computeAnalysisId(
  url: string,
  expectedTakeaway: string
): Promise<string> {
  const normalized = `${new URL(url.trim()).toString()}::${expectedTakeaway.trim()}`;
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface BrowserResult {
  screenshot: string;
  pageMarkdown: string;
  pageTitle: string;
}

interface BrowserSnapshotResponse {
  success: boolean;
  result?: {
    screenshot?: string;
    markdown?: string;
  };
  meta?: {
    title?: string;
  };
  errors?: Array<{
    message: string;
  }>;
}

function isValidUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      (hostname.includes(":") &&
        (hostname.startsWith("fc") ||
          hostname.startsWith("fd") ||
          /^fe[89ab][0-9a-f]?:/.test(hostname))) ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function runBrowserPhase(
  env: Env,
  targetUrl: string,
  refresh: boolean
): Promise<BrowserResult> {
  const response = await env.BROWSER.quickAction("snapshot", {
    url: targetUrl,
    ...(refresh ? { cacheTTL: 0 } : {}),
    formats: ["screenshot", "markdown"],
    viewport: { width: 1280, height: 800 },
    gotoOptions: {
      waitUntil: "networkidle2",
      timeout: 15000,
    },
    screenshotOptions: {
      type: "jpeg",
      quality: 80,
      fullPage: false,
    },
  });

  const snapshot = await response.json<BrowserSnapshotResponse>();
  if (!response.ok || !snapshot.success) {
    throw new BrowserSnapshotError(
      snapshot.errors?.[0]?.message ?? "Browser Run could not capture the page.",
      response.status
    );
  }

  const screenshotBase64 = snapshot.result?.screenshot;
  if (!screenshotBase64) {
    throw new BrowserSnapshotError("Browser Run returned no screenshot.", 502);
  }

  return {
    screenshot: `data:image/jpeg;base64,${screenshotBase64}`,
    pageMarkdown: snapshot.result?.markdown?.slice(0, 6000) ?? "",
    pageTitle: snapshot.meta?.title ?? "Untitled page",
  };
}

async function runAIPhase(
  env: Env,
  pageMarkdown: string,
  pageTitle: string,
  screenshot: string,
  expectedTakeaway: string
): Promise<AnalysisResult> {
  const systemPrompt = `You are a brutally honest landing page critic. A user has told you what their page is SUPPOSED to communicate. Your job is to visit the page as a clueless first-time visitor, figure out what it ACTUALLY communicates, and compare the two.

You must respond with ONLY a JSON object (no markdown, no explanation outside the JSON) with this exact structure:
{
  "mainTakeaway": "A single sentence: what you ACTUALLY think this page is about after reading it cold.",
  "grade": "A letter grade from A+ to F rating how well the page delivers the intended takeaway. Be dramatic. An A+ means the page practically screams the intended message. An F means you'd never guess it.",
  "alignmentVerdict": "2-3 sentences comparing the intended takeaway vs what you actually got. Be specific and direct. If there's a gap, name it.",
  "whatsWorking": ["2-4 bullet points about what messaging is clear and effective"],
  "whatsConfusing": ["2-4 bullet points about what is unclear, ambiguous, or contradictory"],
  "whatsMissing": ["2-4 bullet points about information a visitor would expect but can't find"]
}`;

  const userPrompt = `PAGE TITLE:
"${pageTitle}"

THE INTENDED TAKEAWAY (what the site owner wants visitors to think):
"${expectedTakeaway}"

THE ACTUAL PAGE CONTENT (rendered as Markdown):
${pageMarkdown}`;

  const response = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: screenshot, detail: "high" } },
        ],
      },
    ],
    temperature: 0.7,
    max_completion_tokens: 2048,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "landing_page_analysis",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            mainTakeaway: { type: "string" },
            grade: {
              type: "string",
              enum: ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"],
            },
            alignmentVerdict: { type: "string" },
            whatsWorking: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 4,
            },
            whatsConfusing: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 4,
            },
            whatsMissing: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 4,
            },
          },
          required: [
            "mainTakeaway",
            "grade",
            "alignmentVerdict",
            "whatsWorking",
            "whatsConfusing",
            "whatsMissing",
          ],
        },
      },
    },
  });

  const text = response.choices[0]?.message.content?.trim() ?? "";
  if (!text) {
    throw new AIResponseError("AI returned an empty response.");
  }
  return parseAIResponse(text);
}

function parseAIResponse(raw: string): AnalysisResult {
  let jsonStr = raw.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new AIResponseError("AI response was not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new AIResponseError("AI response was not a JSON object.");
  }

  const p = parsed as Record<string, unknown>;
  if (
    typeof p.mainTakeaway !== "string" ||
    typeof p.grade !== "string" ||
    typeof p.alignmentVerdict !== "string" ||
    !Array.isArray(p.whatsWorking) ||
    !Array.isArray(p.whatsConfusing) ||
    !Array.isArray(p.whatsMissing)
  ) {
    throw new AIResponseError("AI response was missing required fields.");
  }

  return {
    mainTakeaway: p.mainTakeaway,
    grade: p.grade,
    alignmentVerdict: p.alignmentVerdict,
    whatsWorking: p.whatsWorking.map(String),
    whatsConfusing: p.whatsConfusing.map(String),
    whatsMissing: p.whatsMissing.map(String),
  };
}

async function storeAnalysis(
  env: Env,
  id: string,
  payload: StoredAnalysis
): Promise<void> {
  await env.JQQ_BROWSER_RUN_ANALYSES.put(id, JSON.stringify(payload), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
}

async function readStoredAnalysis(
  env: Env,
  id: string
): Promise<StoredAnalysis | null> {
  const raw = await env.JQQ_BROWSER_RUN_ANALYSES.get(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredAnalysis;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /api/results/:id — fetch a cached analysis by ID
    if (
      url.pathname.startsWith("/api/results/") &&
      request.method === "GET"
    ) {
      const id = url.pathname.slice("/api/results/".length).trim();
      if (!id || !/^[a-f0-9]+$/i.test(id)) {
        return Response.json({ error: "Invalid result ID." }, { status: 400 });
      }

      const stored = await readStoredAnalysis(env, id);
      if (!stored) {
        return Response.json(
          { error: "Result not found or expired." },
          { status: 404 }
        );
      }

      return Response.json({
        id,
        url: stored.url,
        expectedTakeaway: stored.expectedTakeaway,
        screenshot: stored.screenshot,
        analysis: stored.analysis,
        cached: true,
        createdAt: stored.createdAt,
      } satisfies AnalyzeResponse);
    }

    // POST /api/analyze — run (or look up cached) analysis
    if (url.pathname === "/api/analyze" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.ANALYZE_LIMITER.limit({ key: ip });
      if (!success) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }

      let body: Partial<AnalyzeRequest>;
      try {
        body = (await request.json()) as Partial<AnalyzeRequest>;
      } catch {
        return Response.json(
          { error: "Invalid request body. Expected JSON with 'url' and 'expectedTakeaway'." },
          { status: 400 }
        );
      }

      try {
        if (typeof body.url !== "string" || !isValidUrl(body.url)) {
          return Response.json(
            { error: "Invalid URL provided. Must be a valid HTTP or HTTPS URL." },
            { status: 400 }
          );
        }

        if (
          typeof body.expectedTakeaway !== "string" ||
          body.expectedTakeaway.trim().length === 0
        ) {
          return Response.json(
            { error: "Expected takeaway is required." },
            { status: 400 }
          );
        }

        if (body.expectedTakeaway.trim().length > 500) {
          return Response.json(
            { error: "Expected takeaway must be under 500 characters." },
            { status: 400 }
          );
        }

        const trimmedUrl = new URL(body.url.trim()).toString();
        const trimmedTakeaway = body.expectedTakeaway.trim();
        const id = await computeAnalysisId(trimmedUrl, trimmedTakeaway);

        // Cache lookup unless caller explicitly forced a refresh
        if (!body.refresh) {
          const cached = await readStoredAnalysis(env, id);
          if (cached) {
            return Response.json({
              id,
              url: cached.url,
              expectedTakeaway: cached.expectedTakeaway,
              screenshot: cached.screenshot,
              analysis: cached.analysis,
              cached: true,
              createdAt: cached.createdAt,
            } satisfies AnalyzeResponse);
          }
        }

        // Browser phase
        let browserResult: BrowserResult;
        try {
          browserResult = await runBrowserPhase(
            env,
            trimmedUrl,
            body.refresh === true
          );
        } catch (e) {
          const message =
            e instanceof Error ? e.message : "Unknown browser error";
          if (message.toLowerCase().includes("timeout")) {
            return Response.json(
              { error: "Failed to load page: timeout after 15 seconds" },
              { status: 504 }
            );
          }
          const status =
            e instanceof BrowserSnapshotError &&
            (e.status === 429 || e.status === 503)
              ? e.status
              : 502;
          return Response.json(
            { error: `Failed to load page: ${message}` },
            { status }
          );
        }

        // Handle pages with no text
        if (browserResult.pageMarkdown.trim().length === 0) {
          const emptyAnalysis: AnalysisResult = {
            mainTakeaway: "This page appears to have no readable text content.",
            grade: "F",
            alignmentVerdict: "Unable to assess — no text found on page.",
            whatsWorking: [],
            whatsConfusing: ["The page has no visible text content for analysis."],
            whatsMissing: ["All text content."],
          };
          const createdAt = Date.now();
          await storeAnalysis(env, id, {
            url: trimmedUrl,
            expectedTakeaway: trimmedTakeaway,
            screenshot: browserResult.screenshot,
            analysis: emptyAnalysis,
            createdAt,
          });
          return Response.json({
            id,
            url: trimmedUrl,
            expectedTakeaway: trimmedTakeaway,
            screenshot: browserResult.screenshot,
            analysis: emptyAnalysis,
            cached: false,
            createdAt,
          } satisfies AnalyzeResponse);
        }

        // AI phase
        let analysis: AnalysisResult;
        try {
          analysis = await runAIPhase(
            env,
            browserResult.pageMarkdown,
            browserResult.pageTitle,
            browserResult.screenshot,
            trimmedTakeaway
          );
        } catch (e) {
          const message =
            e instanceof Error ? e.message : "Unknown AI error";
          console.error("AI phase failed:", e);
          return Response.json(
            { error: `AI analysis failed: ${message}` },
            { status: 502 }
          );
        }

        const createdAt = Date.now();
        await storeAnalysis(env, id, {
          url: trimmedUrl,
          expectedTakeaway: trimmedTakeaway,
          screenshot: browserResult.screenshot,
          analysis,
          createdAt,
        });

        return Response.json({
          id,
          url: trimmedUrl,
          expectedTakeaway: trimmedTakeaway,
          screenshot: browserResult.screenshot,
          analysis,
          cached: false,
          createdAt,
        } satisfies AnalyzeResponse);
      } catch (e) {
        const message = e instanceof Error ? e.message : "An unexpected error occurred";
        return Response.json(
          { error: `Internal error: ${message}` },
          { status: 500 }
        );
      }
    }

    // GET / — serve the form page
    if (url.pathname === "/" && request.method === "GET") {
      const homeUrl = new URL("/index.html", url.origin);
      return env.ASSETS.fetch(new Request(homeUrl.toString()));
    }

    // GET /results/:id — serve the results HTML page
    if (url.pathname.startsWith("/results/") && request.method === "GET") {
      const resultsUrl = new URL("/results.html", url.origin);
      return env.ASSETS.fetch(new Request(resultsUrl.toString()));
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
