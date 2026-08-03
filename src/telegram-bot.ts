import crypto from "node:crypto";
import { Bot, Keyboard, InlineKeyboard, webhookCallback } from "grammy";
import type { Context as GrammyContext } from "grammy";
import type { Context as HonoContext } from "hono";
import {
  prisma,
  findOrCreateUserByTelegramId,
  resolveTelegramGroup,
  getWalletBalance,
  getLookupHistory,
  submitLookup,
  confirmTelegramLoginSession,
  submitPackageLookup,
  listActiveLookupPackages,
  setUserDefaultLookupPackage,
  getUserDefaultLookupPackage,
  createPendingGroupCheck,
  consumePendingGroupCheck,
} from "@abeltib/lookup-core/workerd";
import { isValidImei, isPlausibleSerial, normalizeImei, formatLookupResultFields, AppError, type IdentifierType } from "@abeltib/lookup-shared";

/**
 * Chat-native front end onto the exact same lookup engine the web
 * dashboard uses — same `submitLookup()`, same PROCESSING/async handling,
 * same refund-on-failure. Resolves the Telegram user through the shared
 * `findOrCreateUserByTelegramId` (telegram-identity.ts, lookup-core), so
 * someone who's used the bot and later logs into the web (or vice versa)
 * is the same account, wallet, and history — not two.
 *
 * Buying credits happens in the Mini App, not chat — the pick-a-package,
 * pick-a-channel, submit-proof wizard doesn't translate to a text
 * interface. /balance and /deposit both deep-link straight into the Mini
 * App's /deposit page (depositKeyboard()) so it opens inside Telegram, not
 * a browser tab; the actual verification (Verify.ET) and crediting all
 * happen server-side in lookup-web, same as the desktop dashboard.
 *
 * Bare IMEI/serial messages run the user's standing package default
 * (User.defaultLookupPackageId, set via /package) once they've chosen
 * one; until then they still just run BASIC_INFO, unchanged. Either way,
 * "<CODE> <identifier>" overrides for one message — CODE is tried as a
 * package code first, then as a single service code, since both are
 * unique uppercase-snake identifiers and never legally collide.
 * /services lists service codes, /package lists package codes.
 *
 * Group support: the same identifier-parsing/run logic works when the bot
 * is added to a group, but the *delivery* differs — a group is a shared,
 * semi-public space, so the actual result (device details, blacklist
 * status, etc.) is never posted there. Only a short "checked, sent to your
 * DMs" acknowledgment goes in the group; the real result is DMed to
 * whoever sent it. This requires that person to have already started a
 * private chat with the bot at least once — Telegram forbids a bot from
 * DMing someone cold — so a failed DM in the group flow falls back to a
 * "start a chat with me first" prompt with a deep link, rather than
 * silently losing the result.
 *
 * Note: recognizing a *bare* IMEI/serial (not a "/command") in a group
 * requires the bot's Privacy Mode to be OFF (set once via @BotFather →
 * /setprivacy → Disable for this bot) — Telegram's platform-level
 * default only delivers commands and @mentions to a bot in a group,
 * nothing else. /check works in groups either way, since real slash
 * commands are always delivered regardless of privacy mode.
 */

const DEFAULT_SERVICE_CODE = "BASIC_INFO";

const SHARE_PHONE_KEYBOARD = new Keyboard().requestContact("📱 Share my phone number").resized().oneTime();

function webAppUrl(): string {
  return process.env.WEB_APP_URL || "http://localhost:3000";
}

/** The Mini App's URL — same origin as the web dashboard, under /miniapp (see lookup-web/src/app/miniapp/). Trims any trailing slash on WEB_APP_URL first so this never ends up with a doubled "//miniapp". */
function miniAppUrl(): string {
  return `${webAppUrl().replace(/\/+$/, "")}/miniapp`;
}

/** Computed lazily (not a module-level constant) — same reasoning as getBot() reading TELEGRAM_BOT_TOKEN inside the function body: env bindings aren't guaranteed available at bare module-evaluation time on Workers. */
function openAppKeyboard(): InlineKeyboard {
  return new InlineKeyboard().webApp("📱 Open App", miniAppUrl());
}

/** Deep-links straight into the Mini App's deposit wizard (lookup-web's /miniapp/deposit) — package → payment channel → account details → proof submission → auto-verification, entirely inside Telegram. Replaces the old plain-browser link out to the web dashboard's /dashboard/buy-credits. */
function depositKeyboard(): InlineKeyboard {
  return new InlineKeyboard().webApp("💳 Deposit", `${miniAppUrl()}/deposit`);
}

type TelegramFrom = { id: number; first_name: string; last_name?: string; username?: string };

function displayName(from: TelegramFrom): string {
  return from.username ? `@${from.username}` : from.first_name;
}

/** Masks all but the first/last 4 characters — the group ack names the check without publishing the full identifier to a shared space. */
function maskIdentifier(identifier: string): string {
  if (identifier.length <= 8) return identifier;
  return `${identifier.slice(0, 4)}${"•".repeat(identifier.length - 8)}${identifier.slice(-4)}`;
}

/** Best-effort DM — returns false (never throws) on the extremely common "bot can't initiate conversation with user" case, which just means this person has never opened a DM with the bot before. */
async function tryDm(ctx: GrammyContext, userId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
  try {
    await ctx.api.sendMessage(userId, text, keyboard ? { reply_markup: keyboard } : undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-tap alternates attached to every result (DM and group ack alike) —
 * SIM Lock + Carrier, Activation, and MDM Lock are common enough follow-up
 * checks that retyping "<CODE> <identifier>" is friction worth removing.
 * Encodes as `chk:<serviceCode>:<identifier>` in callback_data (well under
 * Telegram's 64-byte limit for every code here) — the callback_query
 * handler below reconstructs the same "<CODE> <identifier>" text these
 * buttons are a shortcut for and feeds it straight back through
 * handleIdentifierRequest, so DM/group delivery, credits, rate limiting,
 * and group kill-switch behavior are all identical to typing it by hand.
 */
const SERVICE_BUTTONS: { label: string; code: string }[] = [
  { label: "🔒 SIM Lock + Carrier", code: "CARRIER_SIM_LOCK_ONLY_255" },
  { label: "✅ Activation Status", code: "ACTIVATION_CHECK_131" },
  { label: "🔐 MDM Lock", code: "MDM_ON_OFF_STATUS_S1_204" },
];

/** Omits whichever of the three the just-run check already was — no point offering "MDM Lock" as a follow-up on a result that's already the MDM Lock check. Returns undefined once nothing's left to offer. */
function serviceButtonsKeyboard(identifier: string, justRanCode: string | null): InlineKeyboard | undefined {
  const remaining = SERVICE_BUTTONS.filter((b) => b.code !== justRanCode);
  if (remaining.length === 0) return undefined;

  const keyboard = new InlineKeyboard();
  remaining.forEach((b, i) => {
    if (i > 0) keyboard.row();
    keyboard.text(b.label, `chk:${b.code}:${identifier}`);
  });
  return keyboard;
}

interface ParsedIdentifier {
  explicitCode: string | null;
  identifier: string;
  identifierType: IdentifierType;
}

function parseIdentifierMessage(text: string): ParsedIdentifier | null {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  let explicitCode: string | null = null;
  let rawIdentifier = trimmed;
  if (parts.length >= 2 && /^[A-Z0-9_]+$/.test(parts[0] ?? "")) {
    explicitCode = parts[0] as string;
    rawIdentifier = parts.slice(1).join(" ");
  }

  const normalized = normalizeImei(rawIdentifier);
  if (isValidImei(normalized)) return { explicitCode, identifier: normalized, identifierType: "IMEI" };
  if (isPlausibleSerial(rawIdentifier)) return { explicitCode, identifier: rawIdentifier, identifierType: "SERIAL" };
  return null;
}

interface ChannelContext {
  telegramGroupId?: string;
}

/**
 * `dmText` is the full result (DM-only). `teaserLine` is the one line safe
 * to post in a group — a status summary, never the raw identifier or
 * blacklist/lock details. Used to build the masked-teaser group ack.
 */
interface CheckOutcome {
  dmText: string;
  teaserLine: string;
}

/** Runs the actual check (single service or package, explicit code or the user's standing default) — identical whether the request came from a DM or a group, only the reply/delivery mechanics differ (see handleIdentifierRequest). Always tags channel "BOT" — this file is the only caller of submitLookup/submitPackageLookup that ever runs outside the web dashboard/Mini App. */
async function runIdentifierCheck(userId: string, parsed: ParsedIdentifier, channelCtx: ChannelContext): Promise<CheckOutcome> {
  if (parsed.explicitCode) {
    // Try as a package code first — packages and services are both unique,
    // uppercase-snake identifiers, so a code is never ambiguous between the two.
    const pkg = await prisma.lookupPackage.findUnique({ where: { code: parsed.explicitCode } });
    if (pkg) {
      const result = await submitPackageLookup({
        userId,
        identifier: parsed.identifier,
        identifierType: parsed.identifierType,
        packageCode: parsed.explicitCode,
        idempotencyKey: crypto.randomUUID(),
        channel: "BOT",
        telegramGroupId: channelCtx.telegramGroupId,
      });
      return formatPackageResult(result);
    }
    const result = await submitLookup({
      userId,
      identifier: parsed.identifier,
      identifierType: parsed.identifierType,
      serviceCode: parsed.explicitCode,
      idempotencyKey: crypto.randomUUID(),
      channel: "BOT",
      telegramGroupId: channelCtx.telegramGroupId,
    });
    return formatLookupResult(result);
  }

  const defaultPackage = await getUserDefaultLookupPackage(userId);
  if (defaultPackage) {
    const result = await submitPackageLookup({
      userId,
      identifier: parsed.identifier,
      identifierType: parsed.identifierType,
      packageCode: defaultPackage.code,
      idempotencyKey: crypto.randomUUID(),
      channel: "BOT",
      telegramGroupId: channelCtx.telegramGroupId,
    });
    return formatPackageResult(result);
  }

  const result = await submitLookup({
    userId,
    identifier: parsed.identifier,
    identifierType: parsed.identifierType,
    serviceCode: DEFAULT_SERVICE_CODE,
    idempotencyKey: crypto.randomUUID(),
    channel: "BOT",
    telegramGroupId: channelCtx.telegramGroupId,
  });
  return formatLookupResult(result);
}

/** Pulls a plain-text model name out of a provider's resultJson, if present — safe to show in a group (unlike the IMEI/serial or blacklist/lock fields), so it's the headline of the masked-teaser group ack. */
function extractModel(data: Record<string, unknown>): string | undefined {
  const raw = data.model ?? data.modelName ?? data["apple/modelName"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/**
 * Builds the "get your result" deep link for someone the bot couldn't DM
 * cold — creates a one-shot `PendingGroupCheck` carrying their original
 * request, so tapping the link's `/start` re-runs *that exact check*
 * automatically instead of asking them to retype it. Returns undefined if
 * TELEGRAM_BOT_USERNAME isn't configured (deep links need the bot's @handle).
 */
async function buildDeepLinkKeyboard(
  parsed: ParsedIdentifier,
  telegramFrom: TelegramFrom,
  telegramGroupId: string | undefined,
  telegramChatId: string | undefined,
): Promise<InlineKeyboard | undefined> {
  const username = process.env.TELEGRAM_BOT_USERNAME;
  if (!username) return undefined;
  const { token } = await createPendingGroupCheck({
    telegramUserId: String(telegramFrom.id),
    explicitCode: parsed.explicitCode,
    identifier: parsed.identifier,
    identifierType: parsed.identifierType,
    telegramGroupId,
    telegramChatId,
  });
  return new InlineKeyboard().url("📩 Get my result", `https://t.me/${username}?start=${token}`);
}

/** Model shown plainly (harmless in a shared group), IMEI/serial masked — the actual report (blacklist status, lock state, etc.) never gets posted publicly, only DMed. */
function buildGroupTeaser(parsed: ParsedIdentifier, outcome: CheckOutcome, from: TelegramFrom, delivered: boolean): string {
  const idLabel = parsed.identifierType === "IMEI" ? "IMEI" : "Serial";
  const lines = [
    `🔍 Check for ${displayName(from)}`,
    `${idLabel}: ${maskIdentifier(parsed.identifier)}`,
    outcome.teaserLine,
    "",
    delivered ? "✅ Full report sent to your DM." : "⚠️ Couldn't DM you — tap below to get your result.",
  ];
  return lines.join("\n");
}

/**
 * Posts the group acknowledgment in its own try/catch, deliberately
 * isolated from the caller's error handling — this is exactly the call
 * that was previously observed throwing ("400: Bad Request: chat not
 * found") and, because it shared a catch block with the DM logic above it,
 * leaking that raw Telegram API error text as a second DM to the user. A
 * failure to post *into the group* is logged server-side only; it must
 * never surface as a user-facing message, let alone the raw exception.
 */
async function postGroupAck(ctx: GrammyContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  try {
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
  } catch (error) {
    console.error("Failed to post group acknowledgment:", error);
  }
}

/**
 * The one place DM vs. group delivery is decided. DMs reply inline, as
 * always. In a group: never post the result itself — DM it, and leave
 * only a masked-teaser acknowledgment in the group (model plainly shown,
 * identifier masked), with a deep-link button if the DM couldn't be
 * delivered.
 */
async function handleIdentifierRequest(ctx: GrammyContext, telegramFrom: TelegramFrom, rawText: string): Promise<void> {
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const parsed = parseIdentifierMessage(rawText);
  if (!parsed) {
    // A group is shared, semi-public chatter — but a bare notice ("that's
    // not a valid check") is cheap and keeps the happy path discoverable,
    // rather than silently swallowing anything that doesn't parse.
    await ctx.reply(
      isGroup
        ? "That doesn't look like an IMEI or serial number — this isn't related to a device check, so I'll leave it there. Send just the identifier, or use /check <identifier>."
        : "That doesn't look like a valid IMEI or serial number. Send just the identifier, or \"<code> <identifier>\".",
    );
    return;
  }

  // Lazily register/refresh this group (title, last-active) and respect an
  // admin's kill switch (Bot & Mini App page) — a disabled group is silent,
  // same as an unrecognized message, not an error.
  let telegramGroupId: string | undefined;
  let telegramChatId: string | undefined;
  if (isGroup && ctx.chat) {
    const group = await resolveTelegramGroup(String(ctx.chat.id), "title" in ctx.chat ? ctx.chat.title : "Unnamed group");
    if (!group.isActive) return;
    telegramGroupId = group.id;
    telegramChatId = String(ctx.chat.id);
  }

  const user = await requireUser(telegramFrom);
  if (!user) return;

  try {
    const outcome = await runIdentifierCheck(user.id, parsed, { telegramGroupId });
    const followUpKeyboard = serviceButtonsKeyboard(parsed.identifier, parsed.explicitCode);
    if (!isGroup) {
      await ctx.reply(outcome.dmText, followUpKeyboard ? { reply_markup: followUpKeyboard } : undefined);
      return;
    }

    const delivered = await tryDm(ctx, telegramFrom.id, outcome.dmText, followUpKeyboard);
    const keyboard = delivered ? followUpKeyboard : await buildDeepLinkKeyboard(parsed, telegramFrom, telegramGroupId, telegramChatId);
    await postGroupAck(ctx, buildGroupTeaser(parsed, outcome, telegramFrom, delivered), keyboard);
  } catch (error) {
    // Insufficient balance is the one failure mode that isn't a system
    // error: debitCredits() rejects it *before* any provider is ever
    // called (lookup-service.ts debits first, routes to the provider
    // second) — so a broke/new account never costs us a provider call.
    // It deserves its own clear, actionable message (with a deposit
    // button) rather than the generic fallback below, which would
    // wrongly claim credits were charged-then-refunded when nothing was
    // ever charged.
    if (error instanceof AppError && error.code === "INSUFFICIENT_BALANCE") {
      const message = "⚠️ You don't have enough credits for this check.";
      if (!isGroup) {
        await ctx.reply(message, { reply_markup: depositKeyboard() });
        return;
      }
      const delivered = await tryDm(ctx, telegramFrom.id, message, depositKeyboard());
      const keyboard = delivered ? undefined : await buildDeepLinkKeyboard(parsed, telegramFrom, telegramGroupId, telegramChatId);
      await postGroupAck(
        ctx,
        delivered
          ? `⚠️ ${displayName(telegramFrom)}, you're out of credits for that check — check your DMs to top up.`
          : `⚠️ ${displayName(telegramFrom)}, you're out of credits, and I couldn't DM you either.`,
        keyboard,
      );
      return;
    }

    // Never forward a caught error's raw .message to the user — internal/
    // provider failures can contain API error text (see postGroupAck's doc
    // comment for exactly the incident this guards against). Log the real
    // error server-side (visible via `wrangler tail`) and show a generic,
    // friendly fallback instead.
    console.error("handleIdentifierRequest failed:", error);
    const friendly = "❌ That check couldn't be completed — any credits charged were refunded. Please try again in a moment.";
    if (!isGroup) {
      await ctx.reply(friendly);
      return;
    }
    const delivered = await tryDm(ctx, telegramFrom.id, friendly);
    const keyboard = delivered ? undefined : await buildDeepLinkKeyboard(parsed, telegramFrom, telegramGroupId, telegramChatId);
    await postGroupAck(
      ctx,
      delivered
        ? `⚠️ ${displayName(telegramFrom)}, that check couldn't be completed — details sent to your DMs.`
        : `⚠️ ${displayName(telegramFrom)}, that check couldn't be completed, and I couldn't DM you either.`,
      keyboard,
    );
  }
}

async function requireUser(telegramFrom: { id: number; first_name: string; last_name?: string; username?: string } | undefined) {
  if (!telegramFrom) return null;
  const { user } = await findOrCreateUserByTelegramId(String(telegramFrom.id), {
    firstName: telegramFrom.first_name,
    lastName: telegramFrom.last_name,
    username: telegramFrom.username,
  });
  return user;
}

function formatLookupResult(result: Awaited<ReturnType<typeof submitLookup>>): CheckOutcome {
  if (result.status === "PROCESSING") {
    return {
      dmText: "Still checking with the provider — this one's taking a little longer. I'll have an answer soon; check /history shortly.",
      teaserLine: "⏳ Still checking",
    };
  }
  if (result.status === "SUCCEEDED") {
    const data = (result.resultJson ?? {}) as Record<string, unknown>;
    const lines = formatLookupResultFields(data).map((f) => `${f.label}: ${f.value}`);
    const model = extractModel(data);
    return {
      dmText: `✅ Found (${result.creditsCharged} credit(s) charged)\n${lines.join("\n")}`,
      teaserLine: model ? `📱 ${model}` : "✅ Found",
    };
  }
  if (result.status === "NOT_FOUND") {
    return { dmText: `No record found (${result.creditsCharged} credit(s) charged).`, teaserLine: "No record found" };
  }
  return {
    dmText: `❌ ${result.errorMessage ?? "That check failed — any credits charged were refunded."}`,
    teaserLine: "❌ Check failed",
  };
}

function formatPackageResult(result: Awaited<ReturnType<typeof submitPackageLookup>>): CheckOutcome {
  if (result.status === "PROCESSING") {
    return {
      dmText: `Still checking with the provider on part of "${result.packageName}" — I'll have a full answer soon; check /history shortly.`,
      teaserLine: "⏳ Still checking",
    };
  }
  if (result.status === "FAILED") {
    return {
      dmText: `❌ "${result.packageName}" couldn't be completed — any credits charged were refunded.`,
      teaserLine: "❌ Check failed",
    };
  }

  const blocks = result.items.map((item) => {
    if (item.status === "SUCCEEDED") {
      const data = (item.resultJson ?? {}) as Record<string, unknown>;
      const lines = formatLookupResultFields(data).map((f) => `  ${f.label}: ${f.value}`);
      return `✅ ${item.serviceCode}\n${lines.join("\n")}`;
    }
    if (item.status === "NOT_FOUND") return `— ${item.serviceCode}: no record found`;
    if (item.status === "PROCESSING") return `⏳ ${item.serviceCode}: still checking`;
    return `❌ ${item.serviceCode}: ${item.errorMessage ?? "failed"}`;
  });

  const firstSuccess = result.items.find((item) => item.status === "SUCCEEDED");
  const model = firstSuccess ? extractModel((firstSuccess.resultJson ?? {}) as Record<string, unknown>) : undefined;

  return {
    dmText: `📦 ${result.packageName} (${result.creditsCharged} credit(s) charged)\n\n${blocks.join("\n\n")}`,
    teaserLine: model ? `📱 ${model}` : "✅ Found",
  };
}

let bot: Bot | undefined;

function getBot(): Bot {
  if (bot) return bot;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  bot = new Bot(token);

  bot.command("start", async (ctx) => {
    const telegramFrom = ctx.from;
    if (!telegramFrom) return;

    // Resolved/created up front regardless of the branch below, so a first-
    // ever /start via a login deep link still creates their account, same
    // as a bare /start would.
    const user = await requireUser(telegramFrom);
    if (!user) return;

    // `t.me/<bot>?start=<token>` deep links arrive as "/start <token>" —
    // ctx.match is grammY's parsed payload after the command. This is the
    // verify.et-style web login flow (lookup-web/telegram-login-session.ts):
    // no phone number, ever, unlike the Telegram Login Widget's
    // oauth.telegram.org fallback. A bare /start (organic bot discovery)
    // has an empty match and falls through to the normal welcome message.
    const loginToken = ctx.match?.trim();
    if (loginToken?.startsWith("chk_")) {
      // The "smoother onboarding" path: someone in a group whose DM
      // couldn't be delivered cold tapped the deep-link button instead of
      // being told to go start a chat and retype their IMEI. Their
      // original request travelled inside the token (PendingGroupCheck) —
      // fulfilling it here means this /start *is* their check, no
      // re-typing needed.
      const consumed = await consumePendingGroupCheck(loginToken, String(telegramFrom.id));
      if (!consumed) {
        await ctx.reply("That link has expired or was already used — please send your IMEI or serial again in the group.");
        return;
      }
      const parsed: ParsedIdentifier = {
        explicitCode: consumed.explicitCode,
        identifier: consumed.identifier,
        identifierType: consumed.identifierType,
      };
      try {
        const outcome = await runIdentifierCheck(user.id, parsed, { telegramGroupId: consumed.telegramGroupId ?? undefined });
        await ctx.reply(`Thanks for starting a chat — here's your result:\n\n${outcome.dmText}`);
        if (consumed.telegramChatId) {
          try {
            await ctx.api.sendMessage(consumed.telegramChatId, `✅ ${displayName(telegramFrom)}, I sent your result — check your DMs!`);
          } catch (error) {
            console.error("Failed to post group follow-up:", error);
          }
        }
      } catch (error) {
        console.error("Deep-link check failed:", error);
        await ctx.reply("❌ That check couldn't be completed — any credits charged were refunded. Please try again.");
      }
      return;
    }

    if (loginToken) {
      const confirmed = await confirmTelegramLoginSession(loginToken, {
        telegramId: String(telegramFrom.id),
        firstName: user.firstName,
        lastName: user.lastName || undefined,
        username: user.telegramUsername ?? undefined,
      });
      await ctx.reply(
        confirmed
          ? "✅ You're logged in on DeviceIQ! You can close Telegram and go back to your browser."
          : "That login link has expired or was already used — go back to the website and try again.",
      );
      return;
    }

    await ctx.reply(
      `Welcome to DeviceIQ, ${user.name}!\n\nSend me an IMEI or serial number to check it, or open the app below for a full dashboard — balance, services, history, and deposits.\n\n` +
        "/services — see what's available and their codes\n" +
        "/package — bundle several checks into one report\n" +
        "/balance — your credit balance\n" +
        "/deposit — add credits (TeleBirr, bank transfer, and more)\n" +
        "/history — your last few checks\n" +
        "/settings — how to pick a specific service per check",
      { reply_markup: openAppKeyboard() },
    );

    if (!user.phoneNumber) {
      await ctx.reply(
        "Want your phone number on file too (useful for account recovery and support)? Totally optional.",
        { reply_markup: SHARE_PHONE_KEYBOARD },
      );
    }
  });

  bot.command("app", async (ctx) => {
    const user = await requireUser(ctx.from);
    if (!user) return;
    await ctx.reply("Open the DeviceIQ app for your balance, services, history, and deposits:", { reply_markup: openAppKeyboard() });
  });

  bot.on("message:contact", async (ctx) => {
    const contact = ctx.message.contact;
    if (contact.user_id !== ctx.from.id) {
      // Telegram lets you share *any* contact card from your phone, not just
      // your own — only trust one that actually matches the sender.
      await ctx.reply("That looks like someone else's contact card — please share your own using the button.", {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    try {
      await findOrCreateUserByTelegramId(String(ctx.from.id), {
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        username: ctx.from.username,
        phoneNumber: contact.phone_number,
      });
      await ctx.reply("Got it, thanks — your phone number is saved.", { reply_markup: { remove_keyboard: true } });
    } catch (error) {
      // Phone numbers are unique across accounts (one real number can't
      // back two accounts, e.g. switching Telegram accounts on the same
      // phone and re-sharing the same contact) — a friendly message here
      // instead of letting a raw DB constraint error vanish silently.
      const isDuplicatePhone = error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002";
      console.error("Failed to save shared phone number:", error);
      await ctx.reply(
        isDuplicatePhone
          ? "That phone number is already linked to a different account — each number can only back one account."
          : "Couldn't save your phone number — please try again.",
        { reply_markup: { remove_keyboard: true } },
      );
    }
  });

  bot.command("balance", async (ctx) => {
    const user = await requireUser(ctx.from);
    if (!user) return;
    const balance = await getWalletBalance(user.id);
    await ctx.reply(`Your balance: ${balance} credits.`, { reply_markup: depositKeyboard() });
  });

  bot.command("deposit", async (ctx) => {
    const user = await requireUser(ctx.from);
    if (!user) return;
    await ctx.reply(
      "Top up your balance — pick a package and a payment channel (TeleBirr, CBE, and others), get the account to pay, and submit your reference number, a screenshot, or the confirmation SMS. Verified automatically, credits added the moment it clears:",
      { reply_markup: depositKeyboard() },
    );
  });

  bot.command("services", async (ctx) => {
    const services = await prisma.lookupServiceType.findMany({ where: { isActive: true }, orderBy: { creditCost: "asc" } });
    if (services.length === 0) {
      await ctx.reply("No services are available right now.");
      return;
    }
    const lines = services.map((s) => `• ${s.name} — ${s.creditCost} credit(s) (code: ${s.code})`);
    await ctx.reply(
      `Available services:\n${lines.join("\n")}\n\nSend a bare IMEI/serial for ${DEFAULT_SERVICE_CODE} (or your /package default, if set), or "<code> <identifier>" for a specific one.\n\n` +
        "Works in groups too — add me and send an IMEI (or use /check <identifier>). Results always go to your DMs, never posted in the group.",
    );
  });

  bot.command("history", async (ctx) => {
    const user = await requireUser(ctx.from);
    if (!user) return;
    const { items, total } = await getLookupHistory(user.id, { page: 1, pageSize: 5 });
    if (items.length === 0) {
      await ctx.reply("No lookups yet — send me an IMEI or serial to get started.");
      return;
    }
    const lines = items.map((i) => `${i.identifier} — ${i.serviceCode} — ${i.status}`);
    await ctx.reply(`Your last ${items.length} of ${total} lookups:\n${lines.join("\n")}\n\nFull history: ${webAppUrl()}/dashboard/lookup/history`);
  });

  bot.command("settings", async (ctx) => {
    const user = await requireUser(ctx.from);
    await ctx.reply(
      `Default service for a bare IMEI/serial is ${DEFAULT_SERVICE_CODE}, unless you've set a standing package with /package. To use a different one just this once, send "<code> <identifier>", e.g. "BLACKLIST_CHECK 356938035643809" (a package code works here too). See /services and /package for the full lists and codes.`,
    );
    if (user && !user.phoneNumber) {
      await ctx.reply("You haven't shared a phone number yet — optional, but useful for account recovery.", {
        reply_markup: SHARE_PHONE_KEYBOARD,
      });
    }
  });

  bot.command("package", async (ctx) => {
    const user = await requireUser(ctx.from);
    if (!user) return;

    const arg = ctx.match?.trim();
    if (!arg) {
      const packages = await listActiveLookupPackages();
      if (packages.length === 0) {
        await ctx.reply("No packages are available right now.");
        return;
      }
      const current = await getUserDefaultLookupPackage(user.id);
      const lines = packages.map((p) => `• ${p.name} — ${p.creditCost} credit(s) (code: ${p.code})\n  ${p.services.map((s) => s.name).join(" + ")}`);
      await ctx.reply(
        `Available packages:\n${lines.join("\n")}\n\n` +
          `Your current default: ${current ? current.name : "none — single-service default applies"}\n\n` +
          'Send "/package <code>" to make one your standing default for bare IMEI/serial messages, or "/package off" to clear it.',
      );
      return;
    }

    if (arg.toLowerCase() === "off") {
      await setUserDefaultLookupPackage(user.id, null);
      await ctx.reply("Default package cleared — bare IMEI/serial messages go back to the single-service default.");
      return;
    }

    try {
      const code = arg.toUpperCase();
      await setUserDefaultLookupPackage(user.id, code);
      await ctx.reply(`Default package set to "${code}" — every bare IMEI/serial now runs this bundle until you change it.`);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Something went wrong.");
    }
  });

  // Privacy-mode-independent group entry point (see the file-level doc
  // comment) — real slash commands are always delivered to the bot in a
  // group even with Privacy Mode on, unlike bare text.
  bot.command("check", async (ctx) => {
    const telegramFrom = ctx.from;
    if (!telegramFrom) return;
    const arg = ctx.match?.trim();
    if (!arg) {
      await ctx.reply('Usage: /check <identifier>, or "/check <code> <identifier>" for a specific service or package.');
      return;
    }
    await handleIdentifierRequest(ctx, telegramFrom, arg);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // unrecognized command — grammY's command handlers above already caught known ones

    const telegramFrom = ctx.from;
    if (!telegramFrom) return;
    await handleIdentifierRequest(ctx, telegramFrom, text);
  });

  // The one-tap follow-up buttons attached to every result (see
  // serviceButtonsKeyboard) — reconstructs the same "<CODE> <identifier>"
  // text those buttons are shorthand for and feeds it through the exact
  // same path a typed message takes, so DM/group delivery, credits, rate
  // limiting, and the group kill-switch all behave identically to typing
  // it by hand. Works for anyone in the group who taps it, not just the
  // original sender — each tap runs (and charges) under whoever tapped.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("chk:")) return;

    await ctx.answerCallbackQuery(); // dismiss the tap's loading spinner immediately; the result arrives as a new message once the check finishes

    const telegramFrom = ctx.from;
    if (!telegramFrom) return;

    const rest = data.slice(4);
    const separatorIndex = rest.indexOf(":");
    if (separatorIndex < 0) return;
    const code = rest.slice(0, separatorIndex);
    const identifier = rest.slice(separatorIndex + 1);

    await handleIdentifierRequest(ctx, telegramFrom, `${code} ${identifier}`);
  });

  return bot;
}

let webhookHandler: ((c: HonoContext) => Promise<Response>) | undefined;

/** Lazily builds the bot + wraps it once with grammY's Hono adapter (handles the X-Telegram-Bot-Api-Secret-Token check for us). */
export function getTelegramWebhookHandler(): (c: HonoContext) => Promise<Response> {
  if (webhookHandler) return webhookHandler;
  webhookHandler = webhookCallback(getBot(), "hono", { secretToken: process.env.TELEGRAM_WEBHOOK_SECRET });
  return webhookHandler;
}
