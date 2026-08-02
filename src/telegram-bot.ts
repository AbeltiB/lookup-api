import crypto from "node:crypto";
import { Bot, Keyboard, webhookCallback } from "grammy";
import type { Context } from "hono";
import { prisma, findOrCreateUserByTelegramId, getWalletBalance, getLookupHistory, submitLookup } from "@abeltib/lookup-core/workerd";
import { isValidImei, isPlausibleSerial, normalizeImei } from "@abeltib/lookup-shared";

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
 * No persisted "default service" preference yet (would need a schema
 * change) — bare IMEI/serial messages always run BASIC_INFO; send
 * "<SERVICE_CODE> <identifier>" for anything else. /services lists the
 * codes.
 */

const DEFAULT_SERVICE_CODE = "BASIC_INFO";

const SHARE_PHONE_KEYBOARD = new Keyboard().requestContact("📱 Share my phone number").resized().oneTime();

function webAppUrl(): string {
  return process.env.WEB_APP_URL || "http://localhost:3000";
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
    const lines = Object.entries(data).map(([key, value]) => `${key}: ${value}`);
    return `✅ Found (${result.creditsCharged} credit(s) charged)\n${lines.join("\n")}`;
  }
  if (result.status === "NOT_FOUND") {
    return `No record found (${result.creditsCharged} credit(s) charged).`;
  }
  return `❌ ${result.errorMessage ?? "That check failed — any credits charged were refunded."}`;
}

let bot: Bot | undefined;

function getBot(): Bot {
  if (bot) return bot;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  bot = new Bot(token);

  bot.command("start", async (ctx) => {
    const user = await requireUser(ctx.from);
    if (!user) return;
    await ctx.reply(
      `Welcome to DeviceIQ, ${user.name}!\n\nSend me an IMEI or serial number to check it.\n\n` +
        "/services — see what's available and their codes\n" +
        "/balance — your credit balance\n" +
        "/history — your last few checks\n" +
        "/settings — how to pick a specific service per check",
    );

    if (!user.phoneNumber) {
      await ctx.reply(
        "Want your phone number on file too (useful for account recovery and support)? Totally optional.",
        { reply_markup: SHARE_PHONE_KEYBOARD },
      );
    }
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
    await ctx.reply(`Available services:\n${lines.join("\n")}\n\nSend a bare IMEI/serial for ${DEFAULT_SERVICE_CODE}, or "<code> <identifier>" for a specific one.`);
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
      `Default service for a bare IMEI/serial is ${DEFAULT_SERVICE_CODE}. To use a different one, send "<code> <identifier>", e.g. "BLACKLIST_CHECK 356938035643809". See /services for the full list and codes.`,
    );
    if (user && !user.phoneNumber) {
      await ctx.reply("You haven't shared a phone number yet — optional, but useful for account recovery.", {
        reply_markup: SHARE_PHONE_KEYBOARD,
      });
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // unrecognized command — grammY's command handlers above already caught known ones

    const user = await requireUser(ctx.from);
    if (!user) return;

    const parts = text.split(/\s+/);
    let serviceCode = DEFAULT_SERVICE_CODE;
    let rawIdentifier = text;
    if (parts.length >= 2 && /^[A-Z0-9_]+$/.test(parts[0] ?? "")) {
      serviceCode = parts[0] as string;
      rawIdentifier = parts.slice(1).join(" ");
    }

    const normalized = normalizeImei(rawIdentifier);
    const identifierType = isValidImei(normalized) ? "IMEI" : isPlausibleSerial(rawIdentifier) ? "SERIAL" : null;
    if (!identifierType) {
      await ctx.reply("That doesn't look like a valid IMEI or serial number. Send just the identifier, or \"<code> <identifier>\".");
      return;
    }

    try {
      const result = await submitLookup({
        userId: user.id,
        identifier: identifierType === "IMEI" ? normalized : rawIdentifier,
        identifierType,
        serviceCode,
        idempotencyKey: crypto.randomUUID(),
      });
      await ctx.reply(formatLookupResult(result));
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : "Something went wrong — please try again.");
    }
  });

  return bot;
}

let webhookHandler: ((c: Context) => Promise<Response>) | undefined;

/** Lazily builds the bot + wraps it once with grammY's Hono adapter (handles the X-Telegram-Bot-Api-Secret-Token check for us). */
export function getTelegramWebhookHandler(): (c: Context) => Promise<Response> {
  if (webhookHandler) return webhookHandler;
  webhookHandler = webhookCallback(getBot(), "hono", { secretToken: process.env.TELEGRAM_WEBHOOK_SECRET });
  return webhookHandler;
}
