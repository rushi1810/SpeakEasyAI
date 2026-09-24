import Groq from 'groq-sdk';
import { ChatProvider } from './ai/ChatProvider';
import { VisionProvider } from './ai/VisionProvider';
import { aiModelManager } from './ai/ModelManager';
import { GroqProvider } from './ai/GroqProvider';

let groqClient: Groq | null = null;
const SCREEN_ANALYSIS_TIMEOUT_MS = 120000;

export function initGroq(apiKey: string): void {
  groqClient = new Groq({ apiKey });
}

export function getGroqClient(): Groq {
  if (!groqClient) throw new Error('Groq client not initialized. Please set your API key in Settings.');
  return groqClient;
}

export function isGroqInitialized(): boolean {
  return groqClient !== null;
}

const chatProvider = new ChatProvider(() => getGroqClient(), aiModelManager);
const visionProvider = new VisionProvider(() => getGroqClient(), aiModelManager);
aiModelManager.setGroqProvider(new GroqProvider(() => getGroqClient()));

export interface StreamChunkCallback {
  (chunk: string): void;
}

export type AnswerIntent =
  | 'conceptual'
  | 'practical'
  | 'scenario_based'
  | 'problem_solving'
  | 'coding'
  | 'system_design'
  | 'comparison';

export type AnswerStyle = 'concise' | 'standard' | 'detailed' | 'code';

export interface GenerateAnswerOptions {
  question: string;
  transcript: string;
  resumeContext: string;
  jdContext: string;
  kbContext: string;
  sqlContext: string;
  customInstructions: string;
  model: string;
  useResumeContext?: boolean;
  preferKnowledgeBase?: boolean;
  preferSqlDataset?: boolean;
  isSqlQuestion?: boolean;
  isCoding?: boolean;
  answerIntent?: AnswerIntent;
  answerStyle?: AnswerStyle;
  wantsExample?: boolean;
  wantsSteps?: boolean;
  followUpContext?: string;
  previousAnswerContext?: string;
  screenOcrContext?: string;
  onChunk: StreamChunkCallback;
  onReset?: (model: string) => void;
}

export interface GenerateScreenAnswerOptions {
  screenshotBase64: string;
  model: string;
  transcript?: string;
  customInstructions?: string;
  imageMimeType?: string;
  onChunk: StreamChunkCallback;
  onReset?: (model: string) => void;
}

export async function generateAnswerStream(opts: GenerateAnswerOptions): Promise<string> {
  const systemPrompt = buildSystemPrompt(opts);
  const userMessage = buildUserMessage(opts);

  return chatProvider.stream({
    task: opts.isCoding ? 'Coding Answer' : opts.isSqlQuestion ? 'SQL Answer' : 'Interview Answer',
    selectedModel: opts.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    maxTokens: getAnswerMaxTokens(opts),
    temperature: 0.35,
    onChunk: opts.onChunk,
    onReset: opts.onReset
  });
}

export async function generateScreenAnswerStream(opts: GenerateScreenAnswerOptions): Promise<string> {
  const base64Data = opts.screenshotBase64.includes(',')
    ? opts.screenshotBase64.split(',')[1]
    : opts.screenshotBase64;

  const fullResponse = await visionProvider.stream({
    task: 'Screen Direct Vision Answer',
    selectedModel: opts.model,
    messages: [
      {
        role: 'system',
        content: buildScreenAnswerSystemPrompt(opts.customInstructions || '')
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${opts.imageMimeType || 'image/jpeg'};base64,${base64Data}`
            }
          },
          {
            type: 'text',
            text: buildScreenAnswerUserPrompt(opts.transcript || '')
          }
        ]
      }
    ],
    maxTokens: 640,
    temperature: 0.2,
    requestOptions: {
      timeout: SCREEN_ANALYSIS_TIMEOUT_MS,
      maxRetries: 0
    },
    onChunk: opts.onChunk,
    onReset: opts.onReset
  });

  return fullResponse.trim();
}

function isIntroductionQuestion(question: string): boolean {
  const normalized = question.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  return /\b(introduce yourself|tell me about yourself|tell us about yourself|brief me about yourself|brief about yourself|brief your self|brief myself|walk me through your background|give me a quick intro|share your background|background about yourself)\b/.test(normalized);
}

function isBehavioralQuestion(question: string): boolean {
  const normalized = question.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  return /\b(tell me about a time|describe a time|give me an example|example of when|situation where|how did you handle|challenge|conflict|failure|mistake|leadership|proud|achievement|accomplishment|strength|weakness)\b/.test(normalized);
}

function getAnswerMaxTokens(opts: GenerateAnswerOptions): number {
  if (opts.answerStyle === 'concise') {
    return opts.isCoding ? 620 : 420;
  }

  if (opts.answerStyle === 'detailed') {
    return opts.isCoding ? 1080 : 860;
  }

  if (opts.answerStyle === 'code') {
    return 980;
  }

  return opts.isCoding ? 900 : 700;
}

function buildSystemPrompt(opts: GenerateAnswerOptions): string {
  const introQuestion = isIntroductionQuestion(opts.question);
  const behavioralQuestion = isBehavioralQuestion(opts.question);
  const answerIntent = opts.answerIntent || 'conceptual';
  const answerStyle = opts.answerStyle || 'standard';
  let prompt = `You are a professional interview assistant.

Your answers should keep the clarity and structure a user would expect from a strong professional AI assistant, but the final voice must sound like the candidate is speaking directly in the interview.

Interview answer contract:
- Return only the final answer as the candidate's response.
- Do not mention that you are an AI.
- Start with a direct definition, core concept, or immediate answer in 1-2 lines.
- Explain the practical approach as if it comes from real production experience.
- Highlight the most relevant components, trade-offs, tools, or architecture decisions only when they matter.
- Mention commands, tools, or code only when they are genuinely needed.
- Include real-world impact such as performance, availability, automation, troubleshooting, or scalability when relevant.
- End with a strong closing line that summarizes the approach.
- Keep the response natural and conversational, not like a textbook, article, or tutorial.
- Avoid headings and bullet points unless the question explicitly asks for them.
- If the question says "explain in detail", expand the answer with a slightly more structured flow while still sounding spoken.

For coding questions:
- Explain the logic first in 2-3 lines.
- Then provide clean, minimal, working code if the question calls for implementation.
- Briefly explain what the code does.

For troubleshooting or scenario questions:
- Use a step-by-step debugging or resolution approach.
- Focus on how the issue would be identified and resolved in a real environment.

Tone:
- Professional
- Neutral
- Confident
- Clear and human

Core behavior:
- Understand the interviewer intent first, then answer directly.
- Classify the question intent before answering.
- Respond like a strong general-purpose AI assistant, not a rigid template engine.
- Write the final answer as spoken interview language, not as an AI explanation.
- Use clear language and practical explanations.
- Keep the answer concise when the question is simple, and slightly fuller when the question needs explanation.
- Adapt naturally to technical, HR, behavioral, scenario-based, and coding questions.
- If unsure, give the most standard and logically sound answer instead of guessing wildly.
- Silently stay consistent with earlier related context in this session, but do not mention that you are learning or adapting.

Context:
- Use resume details only for questions about the candidate's own background or experience.
- For technical or conceptual questions, answer directly from knowledge and use KB/JD context only when it clearly helps.
- When the Knowledge Base contains a relevant self-introduction, project note, workflow, architecture, design, or prepared Q&A, use the Knowledge Base as the primary source for the answer.
- For SQL or database questions, use the SQL Dataset Context as the primary source when it is relevant.
- If the SQL Dataset Context is helpful but incomplete, keep its meaning and improve the structure, clarity, and completeness before answering.
- If the SQL Dataset Context is weak or missing, answer normally from general knowledge instead of forcing the dataset.
- If the Knowledge Base does not clearly match the question, fall back to the normal answer flow using resume, JD, and general knowledge.
- Do not force Knowledge Base content into unrelated answers.
- Never invent personal facts.

Safety:
- Be correct based on the question and the provided context.
- If a detail depends on the implementation, say: "This may vary depending on implementation".
- Do not hallucinate tools, SDKs, APIs, frameworks, or internal architecture.
- Do not mention specific technologies unless the question or source context clearly indicates them.
- Do not assume real-time behavior unless it is explicitly stated.
- Do not add fake code, fake APIs, or made-up implementation details.
- It is better to be precise and slightly general than specific and wrong.

Formatting:
- Start with the direct answer.
- Then add the most useful explanation.
- Do not force the same structure for every question.
- Use the kind of structure a strong professional AI assistant would naturally use: short paragraph, bullets, mini-sections, comparison bullets, or code block depending on the question.
- Use markdown headings only when they genuinely help readability.
- Keep paragraphs short and use bullets when clearer.
- Do not add empty sections.
- Do not add follow-up questions.
- If the interviewer asks for brevity, keep the answer compact.
- If this is a follow-up question, continue from the current topic instead of restarting from zero.
- Include an example only when it meaningfully improves the answer.
- Prefer answers that feel natural and helpful rather than overly compressed or robotic.
- The answer must sound like something the candidate would actually say aloud to the interviewer.
- Do not sound like a tutor, article, documentation page, or AI assistant.
- Do not say phrases like "Here is the answer", "You can say", "A candidate could say", "The response is", or "As an AI".
- Use first-person phrasing whenever it fits naturally, especially for practical, scenario-based, behavioral, problem-solving, and system design answers.
- For conceptual answers, it is fine to define the concept directly, but still keep the tone conversational and spoken, not textbook-like.
`;

  if (introQuestion) {
    prompt += `
Special rule for self-introduction questions:
- In Answer, respond in plain spoken first-person style as if the candidate is answering aloud.
- Keep it concise and polished.
- Start naturally, ideally with the candidate's name if it is available in the resume context.
- If the resume context is missing a personal detail, skip that detail instead of inventing it.
- Prioritize concrete resume-backed facts such as years of experience, current focus, core cloud/DevOps skills, automation work, education, and certifications.
- End with a short sentence on why the role is a good fit.
- Avoid generic claims unless they are supported by the resume context.
`;
  }

  if (behavioralQuestion) {
    prompt += `
Special rule for behavioral questions:
- In Answer, use a natural STAR flow, but do not force the labels unless it helps clarity.
- Focus on one clear example instead of multiple stories.
- Keep the explanation practical and brief.
- Keep it clearly in first person.
`;
  }

  if (opts.isCoding || answerIntent === 'coding' || answerIntent === 'system_design') {
    prompt += `
Special rule for coding and system design questions:
- Start with the direct approach first, as if the candidate is explaining their thinking aloud.
- Mention practical trade-offs like performance, readability, scalability, edge cases, or maintainability when relevant.
- Include code only when the interviewer asks for code, SQL, JSON, implementation, or debugging help.
- Keep explanations practical and readable, not overly formal.
`;
  }

  if (answerIntent === 'conceptual') {
    prompt += `
Special rule for conceptual questions:
- Give a clear definition or direct explanation first.
- Then add the key point or short example that makes it easier to understand.
- Make it sound like a spoken explanation in an interview, not a generic article answer.
`;
  }

  if (answerIntent === 'practical') {
    prompt += `
Special rule for practical or experience-based questions:
- Answer with what was done, the tools or approach used, and the result.
- Keep it grounded in real work, not theory.
- Let it sound like the candidate is describing real work directly to the interviewer.
`;
  }

  if (answerIntent === 'scenario_based') {
    prompt += `
Special rule for scenario-based questions:
- Answer with clear steps and decision logic.
- Keep the approach practical and structured.
- A short numbered flow or concise bullets are fine if they improve clarity.
- Use natural spoken phrasing such as "I would" or "My approach would be" when appropriate.
`;
  }

  if (answerIntent === 'problem_solving') {
    prompt += `
Special rule for problem-solving questions:
- Start with the likely root cause.
- Then state the fix, reasoning, and a short example only if useful.
- Use natural spoken phrasing such as "I would first check" or "I’d start by".
`;
  }

  if (answerStyle === 'concise') {
    prompt += `
Special rule for concise requests:
- Start with the direct answer immediately.
- Keep the whole response compact and avoid deep theory unless absolutely necessary.
- Prefer one short paragraph or a few clean bullets.
`;
  } else if (answerStyle === 'detailed') {
    prompt += `
Special rule for detailed requests:
- Go one level deeper with reasoning, trade-offs, and step-by-step logic where useful.
- Still stay practical and interview-focused.
- Keep the structure natural, like a strong professional AI answer.
`;
  } else if (answerStyle === 'code') {
    prompt += `
Special rule for code-first requests:
- Give a short approach summary, then include the actual code.
- After the code, add a concise explanation and the main complexity/trade-off notes.
- The explanation around the code should still sound like the candidate speaking aloud.
`;
  }

  if (answerIntent === 'comparison') {
    prompt += `
Special rule for comparisons:
- Make the differences explicit.
- Use side-by-side bullets, a compact table, or clear trade-off framing when helpful.
- If the question is interview-style, phrase the conclusion like a candidate recommendation, for example "I’d use X when..."
`;
  }

  if (opts.wantsExample) {
    prompt += `
Special rule:
- Include one concrete example, but keep it minimal.
`;
  }

  if (opts.wantsSteps) {
    prompt += `
Special rule:
- Use step-by-step bullets for the explanation.
`;
  }

  if (opts.customInstructions) {
    prompt += `\nAdditional Instructions:\n${opts.customInstructions}\n`;
  }

  return prompt;
}

function buildUserMessage(opts: GenerateAnswerOptions): string {
  const introQuestion = isIntroductionQuestion(opts.question);
  const behavioralQuestion = isBehavioralQuestion(opts.question);
  const transcript = trimText(opts.transcript, 700);
  const resumeContext = trimText(opts.resumeContext, introQuestion ? 1200 : 900);
  const jdContext = trimText(opts.jdContext, 850);
  const kbContext = trimText(opts.kbContext, opts.isCoding ? 1200 : 700);
  const sqlContext = trimText(opts.sqlContext, opts.isCoding ? 1500 : 1100);
  const followUpContext = trimText(opts.followUpContext || '', 220);
  const previousAnswerContext = trimText(opts.previousAnswerContext || '', 550);
  const screenOcrContext = trimText(opts.screenOcrContext || '', 1500);
  let msg = `Interview Question: ${opts.question}\n\n`;

  msg += `Detected intent: ${opts.answerIntent || 'conceptual'}\n`;
  msg += `Preferred answer style: ${opts.answerStyle || 'standard'}\n`;

  if (transcript) {
    msg += `Current Interview Context:\n${transcript}\n\n`;
  }

  if (followUpContext) {
    msg += `Previous interviewer topic:\n${followUpContext}\n\n`;
  }

  if (previousAnswerContext) {
    msg += `Previous answer context (for this follow-up only):\n${previousAnswerContext}\n\n`;
  }

  msg += `--- SOURCE CONTEXT ---\n\n`;

  if (resumeContext) {
    const resumeLabel = opts.useResumeContext
      ? introQuestion
        ? 'Resume Context (Primary source for this self-introduction answer):'
        : 'Resume Context (Only use if it directly supports this candidate-specific answer):'
      : 'Resume Context (Optional; ignore this unless the interviewer explicitly asks about the candidate):';
    msg += `${resumeLabel}\n${resumeContext}\n\n`;
  }

  if (jdContext) {
    msg += `Job Description Context:\n${jdContext}\n\n`;
  }

  if (kbContext) {
    const kbLabel = opts.preferKnowledgeBase
      ? 'Knowledge Base Context (Primary source for this answer if relevant):'
      : 'Knowledge Base Context:';
    msg += `${kbLabel}\n${kbContext}\n\n`;
  }

  if (sqlContext) {
    const sqlLabel = opts.preferSqlDataset
      ? 'SQL Dataset Context (Primary source for this SQL answer if relevant):'
      : 'SQL Dataset Context:';
    msg += `${sqlLabel}\n${sqlContext}\n\n`;
  }

  if (screenOcrContext) {
    msg += `Visible Screen OCR Context:\n${screenOcrContext}\n\n`;
  }

  if (opts.isCoding) {
    msg += '\nNote: This is a coding/technical challenge. Keep the explanation practical, structured, and easy to revise.';
  }

  if (introQuestion) {
    msg += `\nFor this question, make the Answer sound like a natural first-person introduction.`;
  } else if (behavioralQuestion) {
    msg += `\nFor this question, use one clear real example and frame it with STAR naturally.`;
  } else if (!opts.isCoding) {
    msg += `\nFor this question, keep the clarity and structure of a strong professional AI answer, but make the final answer sound like I am speaking directly to the interviewer.`;
  }

  if (!opts.useResumeContext) {
    msg += `\nDo not rely on resume details unless the interviewer is explicitly asking about the candidate's own background or experience.`;
  }

  if (opts.preferKnowledgeBase) {
    msg += `\nThis question appears to match the Knowledge Base. Use the Knowledge Base first. If it fully answers the question, stay close to it. If it only helps partially, use it and then complete the answer normally.`;
  } else {
    msg += `\nIf the Knowledge Base is not clearly relevant, answer in the normal default way.`;
  }

  if (opts.preferSqlDataset) {
    msg += `\nThis looks like a SQL or database question. Use the SQL Dataset first. If it clearly answers the question, stay faithful to it. If it only answers part of the question, refine and complete the answer without contradicting the dataset.`;
  } else if (opts.isSqlQuestion) {
    msg += `\nThis is a SQL or database question, but the SQL Dataset may be incomplete. Use it if helpful, otherwise answer normally from strong general knowledge.`;
  }

  msg += `\nKeep the answer simple, correct, interview-safe, and easy to understand on the first read.`;
  msg += `\nDo not guess tools, SDKs, frameworks, APIs, internal architecture, or specific technologies unless they are clearly stated in the question or source context.`;
  msg += `\nKeep the structure natural and polished, but the voice must be a spoken candidate answer, not a generic AI explanation.`;
  msg += `\nWrite the final answer as if I am saying it aloud in the interview. Avoid meta-intro lines and avoid sounding like you are coaching me.`;

  msg += `\n\n${buildAnswerFormatGuide(opts, introQuestion, behavioralQuestion)}`;

  return msg;
}

function buildAnswerFormatGuide(
  opts: GenerateAnswerOptions,
  introQuestion: boolean,
  behavioralQuestion: boolean
): string {
  if (opts.answerStyle === 'code') {
    return `Preferred flow:
- Start with a short direct answer or approach summary.
- Then include the code in a fenced block.
- After the code, add a brief explanation and any important trade-offs or complexity notes.
- Keep the explanation sounding like the candidate is talking through the solution.`;
  }

  if (introQuestion) {
    return `Preferred flow:
- Give a natural first-person answer I can say aloud.
- Add 2 to 4 resume-backed highlights only if they improve clarity.
- Keep it polished and human, not robotic.`;
  }

  if (behavioralQuestion) {
    return `Preferred flow:
- Give a natural STAR-style answer in a polished spoken tone.
- Use a short paragraph or brief bullets, whichever reads more naturally.
- Keep the situation, action, and result clear.`;
  }

  if (opts.answerIntent === 'system_design') {
    return `Preferred flow:
- Start with the high-level design answer.
- Then cover the main components, trade-offs, and important risks.
- Use mini-sections or bullets only if they help readability.
- Phrase the reasoning like the candidate is explaining their design aloud.`;
  }

  if (opts.answerStyle === 'concise') {
    return `Return a compact answer:
- Start with the direct answer.
- Use one short paragraph or a few bullets.
- Include a brief example only if clearly useful or requested.`;
  }

  if (opts.answerIntent === 'comparison') {
    return `Preferred flow:
- Start with a short comparison summary.
- Then show the key differences and when to use each option.
- Bullets or a compact table are both acceptable.
- End with a spoken recommendation if relevant, such as "I’d prefer..." or "I’d use..."`;
  }

  if (opts.answerIntent === 'practical' || opts.answerIntent === 'scenario_based' || opts.answerIntent === 'problem_solving') {
    return `Preferred flow:
- Start with the direct answer.
- Then explain the approach, action, or resolution clearly.
- Add a short example only if it meaningfully helps.
- Keep the wording in spoken first-person style where natural.`;
  }

  return `Preferred flow:
- Start with the direct explanation or definition.
- Then add the key clarification points.
- Include a short example only if it improves understanding.
- Keep the structure natural, like a strong professional AI answer.
- Make the tone sound like a candidate speaking clearly in an interview, not like an AI article.`;
}

function trimText(text: string, maxChars: number): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function buildScreenAnswerSystemPrompt(customInstructions: string): string {
  let prompt = `You are a professional interview assistant reviewing a live interview screenshot.

Your job is to identify the visible question, extract visible code exactly when possible, and give a natural, polished answer with professional AI-level clarity, but in the voice of the candidate speaking to the interviewer.

Rules:
- Prioritize text visible in the screenshot.
- Use transcript context only if it clearly helps complete a partially visible question.
- Be direct, clear, and polished.
- Keep answers well-structured but natural.
- Use clear language with no fluff.
- Make the final answer sound spoken, like the candidate is answering aloud.
- No follow-up questions.
- No extra explanation beyond what is needed.
- Adapt naturally to technical, HR, behavioral, and scenario-based questions.
- If unsure, give the most standard and logically sound answer instead of guessing wildly.
- If the screenshot contains code, SQL, JSON, configuration, or markup, extract only the visible code into a dedicated section.
- If the user is asked to write, fix, complete, or explain code, include actual code in a fenced code block.
- If the screenshot asks for JSON, return actual JSON, not a description of JSON.
- If the screenshot already contains code and the likely task is to explain it, focus on that visible code instead of giving generic theory.
- If a detail depends on the implementation, say: "This may vary depending on implementation".
- Do not hallucinate tools, SDKs, APIs, frameworks, or internal architecture.
- Do not mention specific technologies unless they are clearly visible or clearly stated in the transcript context.
- Do not assume real-time behavior unless it is explicitly stated.
- Do not add fake code, fake APIs, or made-up implementation details.
- Do not sound like an AI assistant explaining the answer from outside the interview.
- If the screenshot does not contain a clear interview question, say so briefly and stop.`;

  const normalizedInstructions = trimText(customInstructions, 500);
  if (normalizedInstructions) {
    prompt += `\n\nAdditional Instructions:\n${normalizedInstructions}`;
  }

  return prompt;
}

function buildScreenAnswerUserPrompt(transcript: string): string {
  const trimmedTranscript = trimText(transcript, 500);
  let prompt = `Analyze this screenshot and answer the visible interview or coding question immediately.

Return markdown in exactly this structure:

### Detected Question
<the question you found, or "No clear interview question visible">

### Visible Code From Screen
<paste only the code that is actually visible on the screen if any; otherwise write "No visible code">

### Answer
<a natural, polished spoken answer: keep professional AI-level clarity, but make it sound like I am answering the interviewer directly>

### Explanation
- <2 to 5 short practical bullets, or "No extra explanation needed">

### Code or Example
<if the task asks to write, fix, complete, transform, or explain code/json/sql/config, include a fenced code block here; otherwise give one minimal relevant example or write "No code or example needed">

Requirements:
- If the screenshot contains visible code, transcribe only what is visible and do not invent hidden lines.
- If the visible text asks for code, return real code, not just a description.
- For JSON output, use a \`\`\`json fenced block.
- For JavaScript use \`\`\`js, TypeScript \`\`\`ts, SQL \`\`\`sql, HTML \`\`\`html, CSS \`\`\`css, Python \`\`\`python, etc.
- If the question is "write a simple json code", the Code or Example section must contain a small valid JSON example.
- If the screenshot mainly contains code and the likely task is explanation, use the visible code in your explanation.
- Keep the answer focused on the screenshot.
- Do not add follow-up questions.
- Keep the response clean, natural, and well-structured.`;

  if (trimmedTranscript) {
    prompt += `\n\nRecent transcript context (only use this if it clearly helps the screenshot):\n${trimmedTranscript}`;
  }

  return prompt;
}

export interface ScreenAnalysisResult {
  success: boolean;
  question?: string;
  ocrText?: string;
  isCoding?: boolean;
  error?: string;
}

export async function analyzeScreenContent(
  screenshotBase64: string,
  model: string,
  imageMimeType = 'image/png'
): Promise<ScreenAnalysisResult> {
  try {
    const base64Data = screenshotBase64.includes(',')
      ? screenshotBase64.split(',')[1]
      : screenshotBase64;

    const content = await visionProvider.complete({
      task: 'Screen Question OCR',
      selectedModel: model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:${imageMimeType};base64,${base64Data}`
              }
            },
            {
              type: 'text',
              text: `Analyze this screenshot from a job interview context.
Look for any interview questions, coding challenges, or technical problems visible on screen, and extract all readable OCR text.

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "question": "the exact question or problem statement you found, or null if none found",
  "ocrText": "all readable text from the screenshot, preserving visible code and SQL as much as possible",
  "isCoding": true/false (is this a coding/algorithm question?),
  "noQuestion": true/false (set to true if no interview question is visible)
}

Be precise. Do not invent hidden text.`
            }
          ]
        }
      ],
      maxTokens: 1400,
      temperature: 0.1,
      responseFormat: { type: 'json_object' },
      requestOptions: {
        timeout: SCREEN_ANALYSIS_TIMEOUT_MS,
        maxRetries: 0
      }
    });

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'Could not parse screen analysis response' };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.noQuestion || !parsed.question) {
      return {
        success: true,
        question: undefined,
        ocrText: typeof parsed.ocrText === 'string' ? parsed.ocrText : ''
      };
    }

    return {
      success: true,
      question: parsed.question,
      ocrText: typeof parsed.ocrText === 'string' ? parsed.ocrText : '',
      isCoding: parsed.isCoding || false
    };
  } catch (err: any) {
    const message = typeof err?.message === 'string' ? err.message : 'Unexpected screen analysis error';
    if (/timed out/i.test(message) || err?.name === 'APIConnectionTimeoutError') {
      return { success: false, error: 'Request timed out while analyzing the screenshot' };
    }
    return { success: false, error: message };
  }
}

export async function detectQuestionInTranscript(
  transcript: string,
  model: string
): Promise<{ isQuestion: boolean; question?: string; isCoding?: boolean }> {
  try {
    const content = await chatProvider.complete({
      task: 'Transcript Question Detection',
      selectedModel: model,
      messages: [
        {
          role: 'user',
          content: `Analyze this interview transcript snippet and determine if it contains a complete interview question that needs answering.

Treat spoken prompts without a trailing question mark as questions if they clearly ask the candidate to explain, describe, compare, implement, design, or walk through something.
Prefer the most recent actionable interviewer question, even if the transcript contains filler words or imperfect punctuation.

Transcript:
"${transcript}"

Return ONLY a JSON object (no markdown):
{
  "isQuestion": true/false,
  "question": "the extracted question if found, null otherwise",
  "isCoding": true/false
}

Only return isQuestion=true if there's a clear, complete question that the candidate needs to answer.
Do NOT treat partial, interrupted, or trailing fragments as complete questions.
If you are not sure the interviewer has finished the question, return isQuestion=false.`
        }
      ],
      maxTokens: 256,
      temperature: 0.1,
      responseFormat: { type: 'json_object' }
    });

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { isQuestion: false };

    const parsed = JSON.parse(jsonMatch[0]);
    const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';

    return {
      isQuestion: Boolean(parsed.isQuestion && question),
      question: question || undefined,
      isCoding: Boolean(parsed.isCoding)
    };
  } catch {
    return { isQuestion: false };
  }
}

export async function validateApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const testClient = new Groq({ apiKey });
    await testClient.models.list();
    return { valid: true };
  } catch (err: any) {
    if (err.status === 401) return { valid: false, error: 'Invalid API key' };
    if (err.status === 429) return { valid: true };
    return { valid: false, error: err.message };
  }
}
