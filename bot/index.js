import 'dotenv/config';
import http from 'http';
import { Client, GatewayIntentBits, AttachmentBuilder, SlashCommandBuilder, REST, Routes } from 'discord.js';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const SERVER_URL = process.env.GENERATE_SERVER_URL || 'http://localhost:3001';
const MAX_ITERATIONS = 10;
const MAX_REFERENCE_IMAGES = 5;
const PENDING_IMAGE_TTL_MS = 10 * 60 * 1000; // how long an uploaded image stays "ready" for the next /jarvis

if (!BOT_TOKEN) {
  console.error('Missing DISCORD_BOT_TOKEN. Copy bot/.env.example to bot/.env and add your bot token.');
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error('Missing DISCORD_CHANNEL_ID in bot/.env.');
  process.exit(1);
}

// Free host tiers (e.g. Render) sleep a service after ~15 min with no
// incoming HTTP traffic. This bot has no reason to receive HTTP requests
// otherwise, so an external uptime pinger hitting this endpoint is what
// keeps the process (and its Discord Gateway connection) alive 24/7.
const KEEPALIVE_PORT = process.env.PORT || 3002;
const keepAliveServer = http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  })
  .listen(KEEPALIVE_PORT, () => {
    console.log(`Keep-alive endpoint listening on port ${KEEPALIVE_PORT}`);
  });

const MODEL_ALIASES = {
  pro: 'gemini-3-pro-image-preview',
  flash: 'gemini-2.5-flash-image',
};

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];

const jarvisCommand = new SlashCommandBuilder()
  .setName('jarvis')
  .setDescription('Generate an image with Nano Banana')
  .addStringOption((opt) => opt.setName('prompt').setDescription('What to generate').setRequired(true))
  .addStringOption((opt) =>
    opt
      .setName('model')
      .setDescription('Which model to use (default: Pro)')
      .addChoices({ name: 'Pro (highest quality)', value: 'pro' }, { name: 'Flash (faster, cheaper)', value: 'flash' })
  )
  .addStringOption((opt) =>
    opt.setName('aspect_ratio').setDescription('Aspect ratio (default: auto)').addChoices(
      ...ASPECT_RATIOS.map((r) => ({ name: r, value: r }))
    )
  )
  .addStringOption((opt) =>
    opt
      .setName('size')
      .setDescription('Resolution (default: auto)')
      .addChoices({ name: '1K', value: '1K' }, { name: '2K', value: '2K' }, { name: '4K', value: '4K' })
  )
  .addIntegerOption((opt) =>
    opt
      .setName('iterations')
      .setDescription(`How many variations to generate in parallel (max ${MAX_ITERATIONS})`)
      .setMinValue(1)
      .setMaxValue(MAX_ITERATIONS)
  );

for (let i = 1; i <= MAX_REFERENCE_IMAGES; i++) {
  jarvisCommand.addAttachmentOption((opt) =>
    opt.setName(`image${i}`).setDescription(`Reference image ${i}`)
  );
}

function isImageAttachment(attachment) {
  if ((attachment.contentType || '').startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif)$/i.test(attachment.name || '');
}

async function attachmentToReferenceImage(attachment) {
  return withRetry(async () => {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Failed to download attachment ${attachment.name}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { mimeType: attachment.contentType || 'image/png', data: buffer.toString('base64') };
  });
}

// Guards against transient local-network blips (e.g. a fetch() that fails to
// even connect) between the bot and the generation server. Does not retry the
// whole pipeline at once, so a successful (billed) generation never gets
// re-run just because the follow-up file download had a hiccup.
async function withRetry(fn, retries = 2, delayMs = 1000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function describeError(err) {
  const cause = err.cause?.code || err.cause?.message;
  return cause ? `${err.message} (${cause})` : err.message;
}

async function generateImage({ prompt, model, aspectRatio, imageSize, referenceImages }) {
  const res = await fetch(`${SERVER_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model, aspectRatio, imageSize, referenceImages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data.historyEntry;
}

async function fetchGeneratedFiles(historyEntry) {
  const files = [];
  for (const img of historyEntry.images) {
    const res = await fetch(`${SERVER_URL}${img.url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    files.push(new AttachmentBuilder(buffer, { name: img.url.split('/').pop() }));
  }
  return files;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// userId -> { attachments: Attachment[], updatedAt: number }
// Lets someone post image(s) in a plain message, then run /jarvis right after
// without needing to fight Discord's clunky per-slot attachment-option UI.
const pendingImagesByUser = new Map();

client.on('messageCreate', async (message) => {
  if (message.channelId !== CHANNEL_ID || message.author.bot) return;

  const imageAttachments = [...message.attachments.values()].filter(isImageAttachment);
  if (imageAttachments.length === 0) return;

  const existing = pendingImagesByUser.get(message.author.id);
  const combined = [...(existing?.attachments || []), ...imageAttachments].slice(-MAX_REFERENCE_IMAGES);
  pendingImagesByUser.set(message.author.id, { attachments: combined, updatedAt: Date.now() });

  await message.react('📎').catch(() => {});
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'jarvis') return;

  if (interaction.channelId !== CHANNEL_ID) {
    await interaction.reply({ content: `This command only works in <#${CHANNEL_ID}>.`, ephemeral: true });
    return;
  }

  const prompt = interaction.options.getString('prompt', true);
  const modelChoice = interaction.options.getString('model');
  const model = modelChoice ? MODEL_ALIASES[modelChoice] : undefined;
  const aspectRatio = interaction.options.getString('aspect_ratio') || undefined;
  const imageSize = interaction.options.getString('size') || undefined;
  const iterations = interaction.options.getInteger('iterations') || 1;

  let attachments = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) =>
    interaction.options.getAttachment(`image${i + 1}`)
  ).filter(Boolean);

  let usedPendingImages = false;
  if (attachments.length === 0) {
    const pending = pendingImagesByUser.get(interaction.user.id);
    if (pending && Date.now() - pending.updatedAt < PENDING_IMAGE_TTL_MS) {
      attachments = pending.attachments;
      usedPendingImages = true;
    }
  }
  pendingImagesByUser.delete(interaction.user.id);

  const badAttachment = attachments.find((a) => !isImageAttachment(a));
  if (badAttachment) {
    await interaction.reply({ content: `\`${badAttachment.name}\` doesn't look like an image.`, ephemeral: true });
    return;
  }

  await interaction.deferReply();

  let referenceImages = [];
  try {
    referenceImages = await Promise.all(attachments.map(attachmentToReferenceImage));
  } catch (err) {
    await interaction.editReply(`Couldn't read an attached image: ${describeError(err)}`);
    return;
  }

  const outcomes = await Promise.all(
    Array.from({ length: iterations }, async () => {
      try {
        const entry = await withRetry(() =>
          generateImage({ prompt, model, aspectRatio, imageSize, referenceImages })
        );
        const files = await withRetry(() => fetchGeneratedFiles(entry));
        return { ok: true, files };
      } catch (err) {
        return { ok: false, error: describeError(err) };
      }
    })
  );

  const files = outcomes.filter((o) => o.ok).flatMap((o) => o.files);
  const errors = outcomes.filter((o) => !o.ok).map((o) => o.error);

  let content = `**${prompt}**`;
  if (usedPendingImages) content += `\n📎 used ${attachments.length} image(s) you posted just before this command`;
  if (errors.length) content += `\n⚠️ ${errors.length}/${iterations} generation(s) failed: ${errors.join('; ')}`;

  await interaction.editReply({ content, files });
});

client.once('clientReady', async () => {
  console.log(`Discord bot logged in as ${client.user.tag}, watching channel ${CHANNEL_ID}`);
  console.log(`Generation server: ${SERVER_URL}`);

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const guildId = channel.guildId;
    const rest = new REST().setToken(BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
      body: [jarvisCommand.toJSON()],
    });
    console.log(`Registered /jarvis command in guild ${guildId}`);
  } catch (err) {
    console.error('Failed to register /jarvis command:', err.message);
  }
});

client.login(BOT_TOKEN).catch((err) => {
  console.error(`Discord login failed: ${err.message}`);
  keepAliveServer.close(() => process.exit(1));
});
