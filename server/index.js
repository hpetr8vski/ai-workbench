import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pLimit from 'p-limit';
import { GoogleGenAI } from '@google/genai';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;
const DEFAULT_MODEL = process.env.IMAGE_MODEL || 'gemini-3-pro-image-preview';
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY) || 4;
const MAX_UPLOAD_MB = process.env.MAX_UPLOAD_MB || '50mb';

const GENERATIONS_DIR = path.join(__dirname, 'generations');
const INDEX_FILE = path.join(GENERATIONS_DIR, 'index.json');
const USAGE_FILE = path.join(GENERATIONS_DIR, 'usage.json');

const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
];

if (!process.env.GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY. Copy server/.env.example to server/.env and add your key.');
  process.exit(1);
}

await fs.mkdir(GENERATIONS_DIR, { recursive: true });

async function readHistoryIndex() {
  try {
    const raw = await fs.readFile(INDEX_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeHistoryIndex(index) {
  await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

// Serializes read-modify-write access to index.json so concurrent parallel
// generations (this app's whole point) don't clobber each other's entries.
let historyQueue = Promise.resolve();
function appendHistoryEntry(entry) {
  historyQueue = historyQueue.then(async () => {
    const index = await readHistoryIndex();
    index.unshift(entry);
    await writeHistoryIndex(index);
  });
  return historyQueue;
}

function extensionForMime(mimeType) {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  return 'jpg';
}

const EMPTY_USAGE_TOTALS = {
  promptTokenCount: 0,
  candidatesTokenCount: 0,
  thoughtsTokenCount: 0,
  totalTokenCount: 0,
  requestCount: 0,
  imageCount: 0,
};

async function loadUsageTotals() {
  try {
    const raw = await fs.readFile(USAGE_FILE, 'utf-8');
    return { ...EMPTY_USAGE_TOTALS, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY_USAGE_TOTALS };
  }
}

const usageTotals = await loadUsageTotals();

// usageTotals is updated synchronously in-memory (safe: Node has no
// interleaving between awaits), then persisted through a serialized queue.
let usageQueue = Promise.resolve();
function persistUsageTotals() {
  const snapshot = { ...usageTotals };
  usageQueue = usageQueue.then(() => fs.writeFile(USAGE_FILE, JSON.stringify(snapshot, null, 2)));
  return usageQueue;
}

function recordUsage(usageMetadata, imageCount) {
  const requestUsage = {
    promptTokenCount: usageMetadata?.promptTokenCount || 0,
    candidatesTokenCount: usageMetadata?.candidatesTokenCount || 0,
    thoughtsTokenCount: usageMetadata?.thoughtsTokenCount || 0,
    totalTokenCount: usageMetadata?.totalTokenCount || 0,
  };
  usageTotals.promptTokenCount += requestUsage.promptTokenCount;
  usageTotals.candidatesTokenCount += requestUsage.candidatesTokenCount;
  usageTotals.thoughtsTokenCount += requestUsage.thoughtsTokenCount;
  usageTotals.totalTokenCount += requestUsage.totalTokenCount;
  usageTotals.requestCount += 1;
  usageTotals.imageCount += imageCount;
  persistUsageTotals();
  return requestUsage;
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const limit = pLimit(MAX_CONCURRENCY);

const app = express();
app.use(cors());
app.use(express.json({ limit: MAX_UPLOAD_MB }));
app.use('/generations', express.static(GENERATIONS_DIR));

app.get('/api/history', async (_req, res) => {
  res.json(await readHistoryIndex());
});

app.get('/api/usage', (_req, res) => {
  res.json(usageTotals);
});

app.post('/api/generate', async (req, res) => {
  const {
    prompt,
    model,
    aspectRatio,
    imageSize,
    personGeneration,
    systemInstruction,
    referenceImages,
    safetyLevel,
    seed,
    candidateCount,
    useGoogleSearch,
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const resolvedModel = model || DEFAULT_MODEL;

  const imageConfig = {};
  if (aspectRatio && aspectRatio !== 'auto') imageConfig.aspectRatio = aspectRatio;
  if (imageSize && imageSize !== 'auto') imageConfig.imageSize = imageSize;
  if (personGeneration && personGeneration !== 'auto') imageConfig.personGeneration = personGeneration;

  const config = { responseModalities: ['TEXT', 'IMAGE'] };
  if (Object.keys(imageConfig).length > 0) config.imageConfig = imageConfig;
  if (systemInstruction) config.systemInstruction = systemInstruction;
  if (seed !== undefined && seed !== null && seed !== '') config.seed = Number(seed);
  if (candidateCount) config.candidateCount = Math.max(1, Math.min(4, Number(candidateCount)));
  if (useGoogleSearch) config.tools = [{ googleSearch: {} }];
  if (safetyLevel === 'block_none') {
    config.safetySettings = SAFETY_CATEGORIES.map((category) => ({ category, threshold: 'BLOCK_NONE' }));
  }

  const parts = [];
  for (const ref of referenceImages || []) {
    if (ref && ref.data && ref.mimeType) {
      parts.push({ inlineData: { data: ref.data, mimeType: ref.mimeType } });
    }
  }
  parts.push({ text: prompt });

  try {
    const result = await limit(() =>
      ai.models.generateContent({
        model: resolvedModel,
        contents: [{ role: 'user', parts }],
        config,
      })
    );

    const images = [];
    let text = null;
    for (const candidate of result.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.inlineData) {
          images.push({ data: part.inlineData.data, mimeType: part.inlineData.mimeType });
        } else if (part.text && !text) {
          text = part.text;
        }
      }
    }

    if (images.length === 0) {
      return res.status(502).json({ error: 'Model returned no image', text });
    }

    const requestUsage = recordUsage(result.usageMetadata, images.length);

    const entryId = crypto.randomUUID();
    const savedImages = [];
    for (let i = 0; i < images.length; i++) {
      const filename = `${entryId}-${i}.${extensionForMime(images[i].mimeType)}`;
      await fs.writeFile(path.join(GENERATIONS_DIR, filename), Buffer.from(images[i].data, 'base64'));
      savedImages.push({ url: `/generations/${filename}`, mimeType: images[i].mimeType });
    }

    const historyEntry = {
      id: entryId,
      prompt,
      model: resolvedModel,
      aspectRatio: aspectRatio || null,
      imageSize: imageSize || null,
      systemInstruction: systemInstruction || null,
      createdAt: new Date().toISOString(),
      images: savedImages,
      text,
      usage: requestUsage,
    };

    await appendHistoryEntry(historyEntry);

    res.json({ historyEntry, usageTotals });
  } catch (err) {
    console.error('Generation failed:', err);
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, defaultModel: DEFAULT_MODEL, maxConcurrency: MAX_CONCURRENCY });
});

// In production there's no separate Vite dev server, so this same service
// also serves the built client (client/dist), letting one host cover both
// the API and the web app.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/generations).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL} | Max concurrent Gemini calls: ${MAX_CONCURRENCY}`);
});
