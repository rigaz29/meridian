import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "get_my_positions", "get_wallet_balance"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_pool_eligibility", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
{ intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";

// Supports OpenRouter (default), MiniMax, or any OpenAI-compatible provider.
// MiniMax  : set LLM_BASE_URL=https://api.minimax.io/v1  and LLM_API_KEY or MINIMAX_API_KEY
// LM Studio: set LLM_BASE_URL=http://localhost:1234/v1   and LLM_API_KEY=lm-studio
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
const IS_MINIMAX   = LLM_BASE_URL.includes("minimax.io");

const client = new OpenAI({
  baseURL: LLM_BASE_URL,
  apiKey:  process.env.LLM_API_KEY || process.env.MINIMAX_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
});

const DEFAULT_MODEL = process.env.LLM_MODEL || (IS_MINIMAX ? "MiniMax-M2.7" : "openrouter/healer-alpha");

// Read Retry-After header from a 429 error object (OpenAI SDK wraps headers).
function getRateLimitWaitMs(error, defaultMs) {
  const retryAfter = error?.headers?.["retry-after"] ?? error?.response?.headers?.["retry-after"];
  if (retryAfter != null) {
    const secs = parseFloat(retryAfter);
    if (!isNaN(secs) && secs > 0) return Math.min(secs * 1000, 120_000);
  }
  return defaultMs;
}

const TOOL_REQUIRED_INTENTS = /\b(deploy|open position|open|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|self.?update|pull latest|git pull|update yourself|config|setting|threshold|set |change|update |balance|wallet|position|portfolio|pnl|yield|range|screen|candidate|find pool|search|research|token|smart wallet|whale|watch.?list|tracked wallet|performance|history|stats|report|lesson|learned|teach|pin|unpin)\b/i;

function shouldRequireRealToolUse(goal, agentType, requireTool) {
  if (requireTool) return true;
  if (agentType === "MANAGER") return false;
  if (agentType === "SCREENER") return false; // ⛔ NO DEPLOY is a valid outcome — don't force tool call
  return TOOL_REQUIRED_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return (
    /invalid message role:\s*system/i.test(message) ||
    /role.*system.*not (supported|allowed)/i.test(message) ||
    /system.*role.*invalid/i.test(message) ||
    /does not support.*system/i.test(message) ||
    /unsupported.*role.*system/i.test(message)
  );
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { requireTool = false, interactive = false, onToolStart = null, onToolFinish = null, lessonSignals = null } = options;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType, signals: lessonSignals });
  const perfSummary = getPerformanceSummary();
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, requireTool);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || DEFAULT_MODEL;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      // MiniMax fallback: highspeed variant (lower latency, same quality tier)
      const FALLBACK_MODEL = IS_MINIMAX ? "MiniMax-M2.7-highspeed" : "stepfun/step-3.5-flash:free";
      let response;
      let usedModel = activeModel;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // MiniMax requires temperature in (0.0, 1.0] — clamp to avoid API rejection
          const temperature = IS_MINIMAX
            ? Math.max(0.01, Math.min(1.0, config.llm.temperature))
            : config.llm.temperature;
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            tool_choice: toolChoice,
            temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            // Only rebuild from scratch on the first step (before any tool results accumulated).
            // On later steps, just strip any leading system message to avoid losing tool history.
            if (step === 0) {
              messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            } else {
              // Replace the leading system message with an embedded user message
              if (messages[0]?.role === "system") {
                const sysContent = messages[0].content;
                messages = [
                  { role: "user", content: `[SYSTEM INSTRUCTIONS]\n${sysContent}` },
                  ...messages.slice(1),
                ];
              }
            }
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            log("agent", "Provider rejected tool_choice=required — retrying with tool_choice=auto");
            attempt -= 1;
            continue;
          }
          // 429 inside the retry loop — honour Retry-After if present, then backoff
          if (error.status === 429 && attempt < 2) {
            const waitMs = getRateLimitWaitMs(error, (attempt + 1) * 15_000);
            log("agent", `Rate limited (attempt ${attempt + 1}/3) — waiting ${Math.round(waitMs / 1000)}s`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          // Network-level errors (ETIMEDOUT, ECONNRESET, fetch failure) — retry like transient errors
          const isNetworkError =
            error.code === "ETIMEDOUT" || error.code === "ECONNRESET" || error.code === "ECONNREFUSED" ||
            /ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network.*error/i.test(error.message);
          if (isNetworkError && attempt < 2) {
            const wait = (attempt + 1) * 10_000;
            log("agent", `Network error (${error.code || "fetch"}) — retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        // MiniMax returns base_resp errors on HTTP 200 (native API format leaking through)
        // status_code 1000 = OK, 1002 = rate limit, 1013 = service unavailable
        if (IS_MINIMAX && response.base_resp?.status_code != null && response.base_resp.status_code !== 1000) {
          const mmCode = response.base_resp.status_code;
          const mmMsg  = response.base_resp.status_msg || "";
          if ((mmCode === 1002 || mmCode === 1013) && attempt < 2) {
            const wait = (attempt + 1) * 8_000;
            if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
              usedModel = FALLBACK_MODEL;
              log("agent", `MiniMax error ${mmCode} — switching to fallback model ${FALLBACK_MODEL}`);
            } else {
              log("agent", `MiniMax error ${mmCode} (${mmMsg}), retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
              await new Promise((r) => setTimeout(r, wait));
            }
            continue;
          }
          log("error", `MiniMax API error ${mmCode}: ${mmMsg}`);
          throw new Error(`MiniMax API error ${mmCode}: ${mmMsg}`);
        }
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                const repaired = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                if (repaired.length > 100_000) {
                  tc.function.arguments = "{}";
                  log("error", `Repaired JSON too large for ${tc.function.name} (${repaired.length} bytes) — cleared to {}`);
                } else {
                  tc.function.arguments = repaired;
                }
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
          if (noToolRetryCount >= 2) {
            return {
              content: "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
              userMessage: goal,
            };
          }
          messages.push({
            role: "user",
            content: "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // Rate limited — honour Retry-After header, fallback to 30s
      if (error.status === 429) {
        const waitMs = getRateLimitWaitMs(error, 30_000);
        log("agent", `Rate limited — waiting ${Math.round(waitMs / 1000)}s...`);
        await sleep(waitMs);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lightweight single-shot LLM call — no tools, no full agentLoop setup overhead.
 * Used for confirmations and quick yes/no reasoning.
 * Returns the response text string, or null on error.
 */
export async function quickLLMCall(userPrompt, { model = null, maxTokens = 128, systemPrompt = null } = {}) {
  try {
    const activeModel = model || DEFAULT_MODEL;
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });
    const response = await client.chat.completions.create({
      model: activeModel,
      max_tokens: maxTokens,
      messages,
    });
    return response.choices?.[0]?.message?.content || null;
  } catch (err) {
    log("agent_warn", `quickLLMCall failed: ${err.message}`);
    return null;
  }
}
