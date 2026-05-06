import puppeteer from "@cloudflare/puppeteer";

interface Env {
  BROWSER: Fetcher;
  AI: Ai;
}

interface AnalyzeRequest {
  url: string;
  expectedTakeaway: string;
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
  screenshot: string;
  analysis: AnalysisResult;
}

interface BrowserResult {
  screenshot: string;
  pageText: string;
  pageTitle: string;
}

function isValidUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function runBrowserPhase(
  env: Env,
  targetUrl: string
): Promise<BrowserResult> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(targetUrl, {
      waitUntil: "networkidle0",
      timeout: 15000,
    });

    const screenshotBuffer = await page.screenshot({
      type: "jpeg",
      quality: 80,
      fullPage: false,
    });

    const screenshot = `data:image/jpeg;base64,${Buffer.from(screenshotBuffer).toString("base64")}`;

    // @ts-expect-error — runs in browser context where document exists
    const rawText = await page.evaluate(() => document.body.innerText);
    const pageText = rawText.slice(0, 6000);

    const pageTitle = await page.title();

    return { screenshot, pageText, pageTitle };
  } finally {
    await browser.close();
  }
}

async function runAIPhase(
  env: Env,
  pageText: string,
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

  const userPrompt = `THE INTENDED TAKEAWAY (what the site owner wants visitors to think):
"${expectedTakeaway}"

THE ACTUAL PAGE CONTENT (what a visitor sees):
${pageText}`;

  try {
    const response = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    })) as { response?: string };

    const text = response.response ?? "";
    return parseAIResponse(text);
  } catch (e) {
    return {
      mainTakeaway: "AI analysis failed.",
      grade: "?",
      alignmentVerdict: `AI inference error: ${e instanceof Error ? e.message : "Unknown error"}`,
      whatsWorking: [],
      whatsConfusing: [],
      whatsMissing: [],
    };
  }
}

function parseAIResponse(raw: string): AnalysisResult {
  let jsonStr = raw.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      mainTakeaway:
        typeof parsed.mainTakeaway === "string"
          ? parsed.mainTakeaway
          : raw.slice(0, 200),
      grade:
        typeof parsed.grade === "string" ? parsed.grade : "?",
      alignmentVerdict:
        typeof parsed.alignmentVerdict === "string"
          ? parsed.alignmentVerdict
          : "Could not determine alignment.",
      whatsWorking: Array.isArray(parsed.whatsWorking)
        ? parsed.whatsWorking.map(String)
        : [],
      whatsConfusing: Array.isArray(parsed.whatsConfusing)
        ? parsed.whatsConfusing.map(String)
        : [],
      whatsMissing: Array.isArray(parsed.whatsMissing)
        ? parsed.whatsMissing.map(String)
        : [],
    };
  } catch {
    return {
      mainTakeaway: raw.slice(0, 300) || "AI returned an unparseable response.",
      grade: "?",
      alignmentVerdict: "Could not parse AI response into structured format.",
      whatsWorking: [],
      whatsConfusing: [],
      whatsMissing: [],
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/analyze" && request.method === "POST") {
      try {
        const body = (await request.json()) as Partial<AnalyzeRequest>;

        if (!body.url || !isValidUrl(body.url)) {
          return Response.json(
            { error: "Invalid URL provided. Must be a valid HTTP or HTTPS URL." },
            { status: 400 }
          );
        }

        if (!body.expectedTakeaway || body.expectedTakeaway.trim().length === 0) {
          return Response.json(
            { error: "Expected takeaway is required." },
            { status: 400 }
          );
        }

        // Browser phase
        let browserResult: BrowserResult;
        try {
          browserResult = await runBrowserPhase(env, body.url);
        } catch (e) {
          const message =
            e instanceof Error ? e.message : "Unknown browser error";
          if (message.includes("timeout")) {
            return Response.json(
              { error: "Failed to load page: timeout after 15 seconds" },
              { status: 500 }
            );
          }
          return Response.json(
            { error: `Failed to load page: ${message}` },
            { status: 500 }
          );
        }

        // Handle pages with no text
        if (browserResult.pageText.trim().length === 0) {
          return Response.json({
            screenshot: browserResult.screenshot,
            analysis: {
              mainTakeaway: "This page appears to have no readable text content.",
              grade: "F",
              alignmentVerdict: "Unable to assess — no text found on page.",
              whatsWorking: [],
              whatsConfusing: ["The page has no visible text content for analysis."],
              whatsMissing: ["All text content."],
            },
          } satisfies AnalyzeResponse);
        }

        // AI phase
        const analysis = await runAIPhase(
          env,
          browserResult.pageText,
          body.expectedTakeaway.trim()
        );

        return Response.json({
          screenshot: browserResult.screenshot,
          analysis,
        } satisfies AnalyzeResponse);
      } catch (e) {
        return Response.json(
          { error: "Invalid request body. Expected JSON with 'url' and 'expectedTakeaway'." },
          { status: 400 }
        );
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
