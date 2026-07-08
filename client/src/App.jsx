import { useEffect, useRef, useState } from 'react';

const MODELS = [
  { id: 'gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image (Nano Banana Pro) — highest quality' },
  { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image (Nano Banana) — fast, high-volume' },
  { id: 'custom', label: 'Custom model ID…' },
];

const ASPECT_RATIOS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const IMAGE_SIZES = ['auto', '1K', '2K', '4K'];
const PERSON_GENERATION = [
  { id: 'auto', label: 'Auto (model default)' },
  { id: 'ALLOW_ALL', label: 'Allow all people' },
  { id: 'ALLOW_ADULT', label: 'Allow adults only' },
  { id: 'ALLOW_NONE', label: 'Block all people' },
];
const SAFETY_LEVELS = [
  { id: 'default', label: 'Default (recommended)' },
  { id: 'block_none', label: 'Block none (least restrictive)' },
];

function fileToReferenceImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const [meta, data] = reader.result.split(',');
      const mimeType = meta.match(/data:(.*);base64/)?.[1] || file.type;
      resolve({ id: `${file.name}-${Date.now()}-${Math.random()}`, name: file.name, mimeType, data, previewUrl: reader.result });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const EMPTY_USAGE = {
  promptTokenCount: 0,
  candidatesTokenCount: 0,
  thoughtsTokenCount: 0,
  totalTokenCount: 0,
  requestCount: 0,
  imageCount: 0,
};

const BUDGET_STORAGE_KEY = 'nanoBananaTokenBudget';

async function urlToReferenceImage(url, name) {
  const res = await fetch(url);
  const blob = await res.blob();
  const file = new File([blob], name, { type: blob.type || 'image/png' });
  return fileToReferenceImage(file);
}

async function generateOne(prompt, settings) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      model: settings.model === 'custom' ? settings.customModel : settings.model,
      aspectRatio: settings.aspectRatio,
      imageSize: settings.imageSize,
      personGeneration: settings.personGeneration,
      systemInstruction: settings.systemInstruction || undefined,
      referenceImages: settings.referenceImages.map(({ mimeType, data }) => ({ mimeType, data })),
      safetyLevel: settings.safetyLevel,
      seed: settings.seed === '' ? undefined : settings.seed,
      candidateCount: settings.candidateCount,
      useGoogleSearch: settings.useGoogleSearch,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

export default function App() {
  const [promptText, setPromptText] = useState('A nano banana wearing a tiny lab coat');
  const [iterations, setIterations] = useState(1);
  const [model, setModel] = useState('gemini-3-pro-image-preview');
  const [customModel, setCustomModel] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [imageSize, setImageSize] = useState('1K');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [systemInstruction, setSystemInstruction] = useState('');
  const [referenceImages, setReferenceImages] = useState([]);
  const [personGeneration, setPersonGeneration] = useState('auto');
  const [safetyLevel, setSafetyLevel] = useState('default');
  const [seed, setSeed] = useState('');
  const [candidateCount, setCandidateCount] = useState(1);
  const [useGoogleSearch, setUseGoogleSearch] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const [usage, setUsage] = useState(EMPTY_USAGE);
  const [tokenBudget, setTokenBudget] = useState(() => {
    const stored = Number(localStorage.getItem(BUDGET_STORAGE_KEY));
    return stored > 0 ? stored : 2000000;
  });
  const [preview, setPreview] = useState(null);
  const composerRef = useRef(null);

  useEffect(() => {
    if (!preview) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape') setPreview(null);
      if (e.key === 'ArrowRight') showRelativeImage(1);
      if (e.key === 'ArrowLeft') showRelativeImage(-1);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [preview]);

  function openPreview(entry, index) {
    setPreview({ entry, index });
  }

  function showRelativeImage(delta) {
    setPreview((prev) => {
      if (!prev) return prev;
      const count = prev.entry.images.length;
      return { ...prev, index: (prev.index + delta + count) % count };
    });
  }

  useEffect(() => {
    fetch('/api/history')
      .then((res) => res.json())
      .then((data) => setHistory(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Failed to load history', err))
      .finally(() => setHistoryLoading(false));

    fetch('/api/usage')
      .then((res) => res.json())
      .then((data) => setUsage((prev) => (data.totalTokenCount >= prev.totalTokenCount ? data : prev)))
      .catch((err) => console.error('Failed to load usage', err));
  }, []);

  useEffect(() => {
    localStorage.setItem(BUDGET_STORAGE_KEY, String(tokenBudget));
  }, [tokenBudget]);

  function applyUsageUpdate(next) {
    // Guards against out-of-order responses from parallel requests briefly
    // making the displayed total tick backwards.
    setUsage((prev) => (next.totalTokenCount >= prev.totalTokenCount ? next : prev));
  }

  async function addReferenceFromUrl(url, name) {
    try {
      const refImg = await urlToReferenceImage(url, name);
      setReferenceImages((prev) => [...prev, refImg]);
    } catch (err) {
      console.error('Failed to add reference image', err);
    }
  }

  async function handleReferenceFiles(e) {
    const files = Array.from(e.target.files || []);
    const results = await Promise.all(files.map(fileToReferenceImage));
    setReferenceImages((prev) => [...prev, ...results]);
    e.target.value = '';
  }

  function removeReferenceImage(id) {
    setReferenceImages((prev) => prev.filter((r) => r.id !== id));
  }

  function handleComposerDragOver(e) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleComposerDragLeave() {
    setIsDragOver(false);
  }

  async function handleComposerDrop(e) {
    e.preventDefault();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      const results = await Promise.all(files.map(fileToReferenceImage));
      setReferenceImages((prev) => [...prev, ...results]);
      return;
    }

    const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (uri) {
      await addReferenceFromUrl(uri, uri.split('/').pop() || 'reference.png');
    }
  }

  function reuseEntry(entry) {
    setPromptText(entry.prompt);
    if (MODELS.some((m) => m.id === entry.model)) {
      setModel(entry.model);
    } else {
      setModel('custom');
      setCustomModel(entry.model);
    }
    setAspectRatio(entry.aspectRatio || 'auto');
    setImageSize(entry.imageSize || 'auto');
    setSystemInstruction(entry.systemInstruction || '');
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function useEntryAsReference(entry) {
    for (const [i, img] of entry.images.entries()) {
      await addReferenceFromUrl(img.url, `${entry.id}-${i}`);
    }
  }

  function handleGenerate() {
    const prompt = promptText.trim();
    if (!prompt) return;

    const settings = {
      model,
      customModel,
      aspectRatio,
      imageSize,
      personGeneration,
      systemInstruction,
      referenceImages,
      safetyLevel,
      seed,
      candidateCount,
      useGoogleSearch,
    };

    const runCount = Math.max(1, Math.min(20, Number(iterations) || 1));
    const initialJobs = Array.from({ length: runCount }, (_, i) => ({
      id: `${Date.now()}-${i}`,
      prompt,
      status: 'pending',
      error: null,
    }));
    setJobs(initialJobs);
    setIsRunning(true);

    const requests = initialJobs.map((job) =>
      generateOne(job.prompt, settings)
        .then((data) => {
          setJobs((prev) => prev.filter((j) => j.id !== job.id));
          setHistory((prev) => [data.historyEntry, ...prev]);
          applyUsageUpdate(data.usageTotals);
        })
        .catch((err) => {
          setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, status: 'error', error: err.message } : j)));
        })
    );

    Promise.allSettled(requests).then(() => setIsRunning(false));
  }

  const budgetPct = tokenBudget > 0 ? Math.min(100, (usage.totalTokenCount / tokenBudget) * 100) : 0;
  const overBudget = usage.totalTokenCount >= tokenBudget;

  return (
    <div className="app">
      <div className="usage-bar">
        <div
          className={`usage-bar-fill ${overBudget ? 'over-budget' : ''}`}
          style={{ width: `${budgetPct}%` }}
        />
        <div className="usage-bar-content">
          <span className="usage-bar-total">{usage.totalTokenCount.toLocaleString()} tokens used</span>
          <span className="usage-bar-detail">
            {usage.promptTokenCount.toLocaleString()} in · {usage.candidatesTokenCount.toLocaleString()} out ·{' '}
            {usage.requestCount.toLocaleString()} generations
          </span>
          <label className="usage-bar-budget">
            Budget
            <input
              type="number"
              min={0}
              value={tokenBudget}
              onChange={(e) => setTokenBudget(Math.max(0, Number(e.target.value)))}
            />
          </label>
        </div>
      </div>

      <h1>🍌 Nano Banana Studio</h1>

      <div
        className={`composer ${isDragOver ? 'drag-over' : ''}`}
        ref={composerRef}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
      >
        <textarea
          className="prompts-input"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          placeholder="Write your prompt here. Drag & drop images anywhere in this box to add as reference."
          rows={5}
        />

        {referenceImages.length > 0 && (
          <div className="reference-thumbs">
            {referenceImages.map((ref) => (
              <div key={ref.id} className="reference-thumb">
                <img src={ref.previewUrl} alt={ref.name} />
                <button onClick={() => removeReferenceImage(ref.id)}>✕</button>
              </div>
            ))}
          </div>
        )}

        {isDragOver && <div className="drop-hint">Drop image to add as reference</div>}

        <div className="options-row">
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {model === 'custom' && (
            <label>
              Model ID
              <input
                type="text"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="e.g. gemini-3.1-flash-image-preview"
              />
            </label>
          )}

          <label>
            Aspect ratio
            <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
              {ASPECT_RATIOS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>

          <label>
            Size
            <select value={imageSize} onChange={(e) => setImageSize(e.target.value)}>
              {IMAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label>
            Iterations
            <input
              type="number"
              min={1}
              max={20}
              value={iterations}
              onChange={(e) => setIterations(Number(e.target.value))}
            />
          </label>

          <button onClick={handleGenerate} disabled={isRunning}>
            {isRunning ? 'Generating…' : iterations > 1 ? `Generate ${iterations} in parallel` : 'Generate'}
          </button>
        </div>

        <button className="advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? '▾ Hide advanced options' : '▸ Show advanced options'}
        </button>

        {showAdvanced && (
          <div className="advanced-panel">
            <label className="full-width">
              System instruction
              <textarea
                value={systemInstruction}
                onChange={(e) => setSystemInstruction(e.target.value)}
                placeholder="e.g. Always render in a flat vector illustration style"
                rows={2}
              />
            </label>

            <label className="full-width">
              Reference images
              <input type="file" accept="image/*" multiple onChange={handleReferenceFiles} />
            </label>

            <div className="options-row">
              <label>
                People
                <select value={personGeneration} onChange={(e) => setPersonGeneration(e.target.value)}>
                  {PERSON_GENERATION.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Safety filtering
                <select value={safetyLevel} onChange={(e) => setSafetyLevel(e.target.value)}>
                  {SAFETY_LEVELS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Seed
                <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" />
              </label>

              <label>
                Variations per prompt
                <input
                  type="number"
                  min={1}
                  max={4}
                  value={candidateCount}
                  onChange={(e) => setCandidateCount(Number(e.target.value))}
                />
              </label>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={useGoogleSearch}
                  onChange={(e) => setUseGoogleSearch(e.target.checked)}
                />
                Ground with Google Search
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="gallery-header">
        <h2>Generations</h2>
        {historyLoading && history.length === 0 && <span className="muted">Loading…</span>}
      </div>

      <div className="grid">
        {jobs.map((job) => (
          <div key={job.id} className="card card-pending">
            <p className="prompt-label">{job.prompt}</p>
            {job.status === 'pending' && <div className="spinner" />}
            {job.status === 'error' && <p className="error">{job.error}</p>}
          </div>
        ))}

        {history.map((entry) => (
          <div key={entry.id} className="card gallery-card">
            <div className="result-images">
              {entry.images.map((img, i) => (
                <img
                  key={i}
                  src={img.url}
                  alt={entry.prompt}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/uri-list', img.url)}
                  onClick={() => openPreview(entry, i)}
                />
              ))}
            </div>
            <div className="card-overlay">
              <p className="prompt-label">{entry.prompt}</p>
              {entry.usage?.totalTokenCount > 0 && (
                <p className="card-usage">{entry.usage.totalTokenCount.toLocaleString()} tokens</p>
              )}
              <div className="card-actions">
                <button onClick={() => reuseEntry(entry)} title="Reuse this prompt and settings">
                  ↺ Reuse
                </button>
                <button onClick={() => useEntryAsReference(entry)} title="Add as reference image">
                  🖼 Use as reference
                </button>
              </div>
            </div>
          </div>
        ))}

        {!historyLoading && history.length === 0 && jobs.length === 0 && (
          <p className="muted">No generations yet — write a prompt above and hit generate.</p>
        )}
      </div>

      {preview && (
        <div className="lightbox-backdrop" onClick={() => setPreview(null)}>
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            <div className="lightbox-image-wrap">
              <button className="lightbox-close" onClick={() => setPreview(null)} title="Close (Esc)">
                ✕
              </button>

              {preview.entry.images.length > 1 && (
                <>
                  <button className="lightbox-nav lightbox-prev" onClick={() => showRelativeImage(-1)}>
                    ‹
                  </button>
                  <button className="lightbox-nav lightbox-next" onClick={() => showRelativeImage(1)}>
                    ›
                  </button>
                </>
              )}

              <img
                className="lightbox-image"
                src={preview.entry.images[preview.index].url}
                alt={preview.entry.prompt}
              />
            </div>

            <div className="lightbox-caption">
              <p className="prompt-label">{preview.entry.prompt}</p>
              <div className="lightbox-meta">
                {preview.entry.images.length > 1 && (
                  <span className="muted">
                    {preview.index + 1} / {preview.entry.images.length}
                  </span>
                )}
                {preview.entry.usage?.totalTokenCount > 0 && (
                  <span className="muted">{preview.entry.usage.totalTokenCount.toLocaleString()} tokens</span>
                )}
              </div>
              <div className="card-actions">
                <button
                  onClick={() => {
                    reuseEntry(preview.entry);
                    setPreview(null);
                  }}
                >
                  ↺ Reuse
                </button>
                <button onClick={() => useEntryAsReference(preview.entry)}>🖼 Use as reference</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
