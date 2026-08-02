import crypto from "node:crypto";
import { Bot, Keyboard, InlineKeyboard, webhookCallback } from "grammy";
import type { Context as GrammyContext } from "grammy";
import type { Context as HonoContext } from "hono";
import {
  prisma,
  findOrCreateUserByTelegramId,
  getWalletBalance,
  getLookupHistory,
  submitLookup,
  confirmTelegramLoginSession,
  submitPackageLookup,
  listActiveLookupPackages,
  setUserDefaultLookupPackage,
  getUserDefaultLookupPackage,
} from "@abeltib/lookup-core/workerd";
import { isValidImei, isPlausibleSerial, normalizeImei, formatLookupResultFields } from "@abeltib/lookup-shared";

/**
 * Chat-native front end onto the exact same lookup engine the web
 * dashboard uses — same `submitLookup()`, same PROCESSING/async handling,
 * same refund-on-failure. Resolves the Telegram user through the shared
 * `findOrCreateUserByTelegramId` (telegram-identity.ts, lookup-core), so
 * someone who's used the bot and later logs into the web (or vice versa)
 * is the same account, wallet, and history — not two.
 *
 * Buying credits isn't supported here on purpose — the bank-transfer
 * proof-of-payment flow doesn't translate to a chat interface. The bot
 * points to the web dashboard's Buy Credits page instead.
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

type TelegramFrom = { id: number; first_name: string; last_name?: string; username?: string };

function displayName(from: TelegramFrom): string {
  return from.username ? `@${from.username}` : from.first_name;
}

/** Masks all but the first/last 4 characters — the group ack names the check without publishing the full identifier to a shared space. */
function maskIdentifier(identifier: string): string {
  if (identifier.length <= 8) return identifier;
  return `${identifier.slice(0, 4)}${"•".repeat(identifier.length - 8)}${identifier.slice(-4)}`;
}

function startChatKeyboard(): InlineKeyboard | undefined {
  const username = process.env.TELEGRAM_BOT_USERNAME;
  return username ? new InlineKeyboard().url("Start a chat with me", `https://t.me/${username}`) : undefined;
}

/** Best-effort DM — returns false (never throws) on the extremely common "bot can't initiate conversation with user" case, which just means this person has never opened a DM with the bot before. */
async function tryDm(ctx: GrammyContext, userId: number, text: string): Promise<boolean> {
  try {
    await ctx.api.sendMessage(userId, text);
    return true;
  } catch {
    return false;
  }
}

interface ParsedIdentifier {
  explicitCode: string | null;
  identifier: string;
  identifierType: "IMEI" | "SERIAL";
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

/** Runs the actual check (single service or package, explicit code or the user's standing default) — identical whether the request came from a DM or a group, only the reply/delivery mechanics differ (see handleIdentifierRequest). */
async function runIdentifierCheck(userId: string, parsed: ParsedIdentifier): Promise<string> {
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
      });
      return formatPackageResult(result);
    }
    const result = await submitLookup({
      userId,
      identifier: parsed.identifier,
      identifierType: parsed.identifierType,
      serviceCode: parsed.explicitCode,
      idempotencyKey: crypto.randomUUID(),
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
    });
    return formatPackageResult(result);
  }

  const result = await submitLookup({
    userId,
    identifier: parsed.identifier,
    identifierType: parsed.identifierType,
    serviceCode: DEFAULT_SERVICE_CODE,
    idempotencyKey: crypto.randomUUID(),
  });
  return formatLookupResult(result);
}

/**
 * The one place DM vs. group delivery is decided. DMs reply inline, as
 * always. In a group: never post the result itself — DM it, and leave
 * only a short, masked-identifier acknowledgment in the group (or a
 * "start a chat with me" prompt if the DM couldn't be delivered).
 */
async function handleIdentifierRequest(ctx: GrammyContext, telegramFrom: TelegramFrom, rawText: string): Promise<void> {
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const parsed = parseIdentifierMessage(rawText);
  if (!parsed) {
    // In a group, silent — most group chatter isn't a check request, and
    // replying to every unrelated message would be spam. In a DM, this is
    // the only signal the user gets that their input wasn't understood.
    if (!isGroup) {
      await ctx.reply("That doesn't look like a valid IMEI or serial number. Send just the identifier, or \"<code> <identifier>\".");
    }
    return;
  }

  const user = await requireUser(telegramFrom);
  if (!user) return;

  try {
    const replyText = await runIdentifierCheck(user.id, parsed);
    if (!isGroup) {
      await ctx.reply(replyText);
      return;
    }

    const delivered = await tryDm(ctx, telegramFrom.id, replyText);
    await ctx.reply(
      delivered
        ? `🔍 Checked ${maskIdentifier(parsed.identifier)} for ${displayName(telegramFrom)} — result sent to your DMs.`
        : `⚠️ ${displayName(telegramFrom)}, I checked ${maskIdentifier(parsed.identifier)} but couldn't DM you the result — please start a chat with me first, then try again.`,
      delivered ? undefined : { reply_markup: startChatKeyboard() },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong — please try again.";
    if (!isGroup) {
      await ctx.reply(message);
      return;
    }
    const delivered = await tryDm(ctx, telegramFrom.id, `❌ ${message}`);
    await ctx.reply(
      delivered
        ? `⚠️ ${displayName(telegramFrom)}, that check couldn't be completed — details sent to your DMs.`
        : `⚠️ ${displayName(telegramFrom)}, that check couldn't be completed, and I couldn't DM you either — please start a chat with me first.`,
      delivered ? undefined : { reply_markup: startChatKeyboard() },
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

function formatLookupResult(result: Awaited<ReturnType<typeof submitLookup>>): string {
  if (result.status === "PROCESSING") {
    return "Still checking with the provider — this one's taking a little longer. I'll have an answer soon; check /history shortly.";
  }
  if (result.status === "SUCCEEDED") {
    const data = (result.resultJson ?? {}) as Record<string, unknown>;
    const lines = formatLookupResultFields(data).map((f) => `${f.label}: ${f.value}`);
    return `✅ Found (${result.creditsCharged} credit(s) charged)\n${lines.join("\n")}`;
  }
  if (result.status === "NOT_FOUND") {
    return `No record found (${result.creditsCharged} credit(s) charged).`;
  }
  return `❌ ${result.errorMessage ?? "That check failed — any credits charged were refunded."}`;
}

function formatPackageResult(result: Awaited<ReturnType<typeof submitPackageLookup>>): string {
  if (result.status === "PROCESSING") {
    return `Still checking with the provider on part of "${result.packageName}" — I'll have a full answer soon; check /history shortly.`;
  }
  if (result.status === "FAILED") {
    return `❌ "${result.packageName}" couldn't be completed — any credits charged were refunded.`;
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

  return `📦 ${result.packageName} (${result.creditsCharged} credit(s) charged)\n\n${blocks.join("\n\n")}`;
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
    await findOrCreateUserByTelegramId(String(ctx.from.id), {
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      username: ctx.from.username,
      phoneNumber: contact.phone_number,
    });
    await ctx.reply("Got it, thanks — your phone number is saved.", { reply_markup: { remove_keyboard: true } });
  });

  bot.command("balance", async (ctx) => {
    const user = await requireUser(ctx.from);
    if (!user) return;
    const balance = await getWalletBalance(user.id);
    await ctx.reply(`Your balance: ${balance} credits.\nTop up: ${webAppUrl()}/dashboard/buy-credits`);
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

  return bot;
}

let webhookHandler: ((c: HonoContext) => Promise<Response>) | undefined;

/** Lazily builds the bot + wraps it once with grammY's Hono adapter (handles the X-Telegram-Bot-Api-Secret-Token check for us). */
export function getTelegramWebhookHandler(): (c: HonoContext) => Promise<Response> {
  if (webhookHandler) return webhookHandler;
  webhookHandler = webhookCallback(getBot(), "hono", { secretToken: process.env.TELEGRAM_WEBHOOK_SECRET });
  return webhookHandler;
}
