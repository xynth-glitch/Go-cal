const solveBtn = document.getElementById('solveBtn');
const voiceBtn = document.getElementById('voiceBtn');
const solutionCard = document.getElementById('solutionCard');
const solutionContent = document.getElementById('solutionContent');
const teacherMode = document.getElementById('teacherMode');
const currentChunk = document.getElementById('currentChunk');
const timeline = document.getElementById('chunksTimeline');
const playPauseBtn = document.getElementById('playPauseBtn');
const progressBar = document.getElementById('progressBar');
const teacherAudio = document.getElementById('teacherAudio');

let currentPlan = [];

const IS_DEV =
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.search.includes('debug=1');

function devLog(...args) {
  if (IS_DEV) console.debug('[TeacherMode]', ...args);
}

const connectorCache = new Map([
  ['intro', 'Bahut achcha question hai, ab step by step samajhte hain.'],
  ['focus', 'Ab expression pe dhyan do.'],
  ['mistake', 'Yahan students usually mistake kar dete hain, carefully dekhna.']
]);
const conceptCache = new Map();

class NarrationManager {
  constructor({ connectorCacheRef, conceptCacheRef }) {
    this.connectorCache = connectorCacheRef;
    this.conceptCache = conceptCacheRef;
    this.ttsTimeoutMs = 12000;
  }

  buildStaticSolution(question) {
    if (question.includes('(a+b)^2') || question.includes('(a+b)²')) {
      return [
        'Given expression: (a+b)^2',
        'Apply identity: (a+b)^2 = a^2 + 2ab + b^2',
        'Final expanded form: a^2 + 2ab + b^2'
      ];
    }

    return [
      `Question: ${question}`,
      'Step 1: Identify known formula or operation.',
      'Step 2: Apply operation carefully with sign/term tracking.',
      'Step 3: Simplify and verify final form.'
    ];
  }

  humanizeStep(step) {
    return `Yahan pe ${step} aa raha hai, isko calmly break karte hain.`;
  }

  buildChunks(solutionSteps) {
    const conceptKey = solutionSteps.join('|');
    if (this.conceptCache.has(conceptKey)) {
      return this.conceptCache.get(conceptKey).map((c) => ({ ...c }));
    }

    const chunks = [];
    let t = 0;

    chunks.push({
      text: this.connectorCache.get('intro'),
      target: solutionSteps[0],
      startTime: t,
      stepId: 0
    });
    t += 2.8;

    solutionSteps.forEach((step, i) => {
      chunks.push({
        text: `${this.connectorCache.get('focus')} ${this.humanizeStep(step)}`,
        target: step,
        startTime: Number(t.toFixed(2)),
        stepId: i
      });
      t += 3.8;

      if (i === 1) {
        chunks.push({
          text: this.connectorCache.get('mistake'),
          target: step,
          startTime: Number(t.toFixed(2)),
          stepId: i
        });
        t += 2.6;
      }
    });

    this.conceptCache.set(conceptKey, chunks);
    return chunks.map((c) => ({ ...c }));
  }

  async generateVoiceAudio(chunks) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.ttsTimeoutMs);

    try {
      const response = await fetch('/api/teacher-mode/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          provider: 'sarvam',
          modelPriority: ['bulbul:v3', 'bulbul:v2'],
          style: {
            tone: 'natural-hinglish',
            concise: true,
            avoidFiller: true,
            pace: 'teacher-conversational'
          },
          chunks
        })
      });

      if (!response.ok) {
        devLog('TTS non-OK response', response.status);
        return null;
      }

      const data = await response.json();
      return data.audioUrl || null;
    } catch (err) {
      devLog('TTS failed, using script-only fallback', err?.message || err);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class SyncEngine {
  constructor({ audioEl, progressEl, currentChunkEl, solutionRoot, timelineRoot, playPauseEl }) {
    this.audioEl = audioEl;
    this.progressEl = progressEl;
    this.currentChunkEl = currentChunkEl;
    this.solutionRoot = solutionRoot;
    this.timelineRoot = timelineRoot;
    this.playPauseEl = playPauseEl;

    this.state = { chunks: [], activeIndex: -1, mode: 'idle' };
    this.scriptTimers = [];

    this.onTimeUpdate = this.onTimeUpdate.bind(this);
    this.onAudioEnded = this.onAudioEnded.bind(this);

    this.audioEl.addEventListener('timeupdate', this.onTimeUpdate);
    this.audioEl.addEventListener('ended', this.onAudioEnded);
  }

  setSession({ chunks, hasAudio }) {
    this.cleanupScriptTimers();
    this.state = { chunks, activeIndex: -1, mode: hasAudio ? 'audio' : 'script' };
    this.progressEl.value = 0;
    this.playPauseEl.textContent = '▶ Play';
    this.clearHighlights();
  }

  cleanupScriptTimers() {
    this.scriptTimers.forEach((id) => clearTimeout(id));
    this.scriptTimers = [];
  }

  destroy() {
    this.cleanupScriptTimers();
    this.audioEl.pause();
    this.audioEl.removeEventListener('timeupdate', this.onTimeUpdate);
    this.audioEl.removeEventListener('ended', this.onAudioEnded);
  }

  play() {
    if (!this.state.chunks.length) return;

    if (this.state.mode === 'audio' && this.audioEl.src) {
      this.audioEl.play();
      this.playPauseEl.textContent = '⏸ Pause';
      return;
    }

    this.runScriptOnlySync();
    this.playPauseEl.textContent = '⏸ Pause';
  }

  pause() {
    if (this.state.mode === 'audio') {
      this.audioEl.pause();
    } else {
      this.cleanupScriptTimers();
    }
    this.playPauseEl.textContent = '▶ Play';
  }

  replay() {
    if (!this.state.chunks.length) return;

    this.cleanupScriptTimers();
    this.progressEl.value = 0;
    this.state.activeIndex = -1;
    this.clearHighlights();

    if (this.state.mode === 'audio' && this.audioEl.src) {
      this.audioEl.currentTime = 0;
      this.audioEl.play();
      this.playPauseEl.textContent = '⏸ Pause';
    } else {
      this.runScriptOnlySync();
      this.playPauseEl.textContent = '⏸ Pause';
    }
  }

  seekByPercent(percent) {
    if (this.state.mode === 'audio' && this.audioEl.duration) {
      this.audioEl.currentTime = (percent / 100) * this.audioEl.duration;
    } else {
      const idx = Math.min(
        this.state.chunks.length - 1,
        Math.max(0, Math.round((percent / 100) * (this.state.chunks.length - 1)))
      );
      this.activateChunk(idx);
    }
  }

  jumpToChunk(index) {
    if (!this.state.chunks[index]) return;

    if (this.state.mode === 'audio' && this.audioEl.src) {
      this.audioEl.currentTime = this.state.chunks[index].startTime;
      if (this.audioEl.paused) {
        this.audioEl.play();
      }
      this.playPauseEl.textContent = '⏸ Pause';
      return;
    }

    this.cleanupScriptTimers();
    this.activateChunk(index);
  }

  runScriptOnlySync() {
    this.cleanupScriptTimers();

    this.state.chunks.forEach((chunk, i) => {
      const timer = setTimeout(() => {
        this.activateChunk(i);
        if (i === this.state.chunks.length - 1) {
          this.playPauseEl.textContent = '▶ Play';
          this.progressEl.value = 100;
        } else {
          this.progressEl.value = ((i + 1) / this.state.chunks.length) * 100;
        }
      }, chunk.startTime * 1000);

      this.scriptTimers.push(timer);
    });
  }

  onAudioEnded() {
    this.playPauseEl.textContent = '▶ Play';
    this.progressEl.value = 100;
  }

  onTimeUpdate() {
    if (!this.state.chunks.length) return;

    const duration = this.audioEl.duration || 1;
    this.progressEl.value = (this.audioEl.currentTime / duration) * 100;

    const idx = this.getChunkIndexForTime(this.audioEl.currentTime);
    if (idx !== this.state.activeIndex) {
      this.activateChunk(idx);
    }
  }

  getChunkIndexForTime(time) {
    for (let i = this.state.chunks.length - 1; i >= 0; i -= 1) {
      if (time >= this.state.chunks[i].startTime) return i;
    }
    return 0;
  }

  clearHighlights() {
    document.querySelectorAll('.solution-step').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.timeline-item').forEach((el) => el.classList.remove('active'));
  }

  activateChunk(index) {
    const chunk = this.state.chunks[index];
    if (!chunk) return;

    this.state.activeIndex = index;
    this.currentChunkEl.textContent = chunk.text;

    this.clearHighlights();

    const activeStep = document.querySelector(`.solution-step[data-step-id="${chunk.stepId}"]`);
    if (activeStep) {
      activeStep.classList.add('active');
      activeStep.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const activeTimeline = document.querySelector(`.timeline-item[data-chunk-id="${index}"]`);
    if (activeTimeline) {
      activeTimeline.classList.add('active');
      activeTimeline.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

const narrationManager = new NarrationManager({
  connectorCacheRef: connectorCache,
  conceptCacheRef: conceptCache
});
const syncEngine = new SyncEngine({
  audioEl: teacherAudio,
  progressEl: progressBar,
  currentChunkEl: currentChunk,
  solutionRoot: solutionContent,
  timelineRoot: timeline,
  playPauseEl: playPauseBtn
});

solveBtn.addEventListener('click', async () => {
  const q = document.getElementById('questionInput').value.trim();
  if (!q) return;

  currentPlan = narrationManager.buildStaticSolution(q);
  solutionContent.innerHTML = currentPlan
    .map((s, i) => `<span class="solution-step" data-step-id="${i}">${s}</span>`)
    .join('');

  solutionCard.classList.remove('hidden');
  teacherMode.open = false;
  syncEngine.setSession({ chunks: [], hasAudio: false });
  currentChunk.textContent = 'Voice explanation generate karne ke liye microphone button dabaiye.';
  timeline.innerHTML = '';
  progressBar.value = 0;
  teacherAudio.pause();
  teacherAudio.removeAttribute('src');
  teacherAudio.load();
});

voiceBtn.addEventListener('click', async () => {
  if (!currentPlan.length) return;

  voiceBtn.disabled = true;
  voiceBtn.textContent = 'Generating Teacher Explanation...';
  currentChunk.textContent = 'Generating Teacher Explanation...';

  teacherMode.open = true;

  const chunks = narrationManager.buildChunks(currentPlan);
  const audioUrl = await narrationManager.generateVoiceAudio(chunks);

  renderTimeline(chunks);
  syncEngine.setSession({ chunks, hasAudio: Boolean(audioUrl) });

  if (audioUrl) {
    teacherAudio.src = audioUrl;
    currentChunk.textContent = 'Ready! Play dabao aur live teacher mode start karo.';
  } else {
    teacherAudio.removeAttribute('src');
    teacherAudio.load();
    currentChunk.textContent = 'Audio unavailable. Script-based sync preview mode active.';
  }

  voiceBtn.disabled = false;
  voiceBtn.textContent = '🎤 Voice Explanation';
});

playPauseBtn.addEventListener('click', () => {
  const isPlayingAudio = !teacherAudio.paused && !!teacherAudio.src;
  const isScriptMode = !teacherAudio.src;

  if (isPlayingAudio) {
    syncEngine.pause();
    return;
  }

  if (isScriptMode && playPauseBtn.textContent.includes('Pause')) {
    syncEngine.pause();
    return;
  }

  syncEngine.play();
});

progressBar.addEventListener('input', () => {
  syncEngine.seekByPercent(Number(progressBar.value));
});

window.addEventListener('beforeunload', () => {
  syncEngine.destroy();
});

function renderTimeline(chunks) {
  timeline.innerHTML = chunks
    .map(
      (c, i) =>
        `<button class="timeline-item" data-chunk-id="${i}" type="button"><strong>${c.startTime}s</strong> — ${c.text}<br /><small>Target: ${c.target}</small></button>`
    )
    .join('');

  timeline.querySelectorAll('.timeline-item').forEach((el) => {
    el.addEventListener('click', () => {
      syncEngine.jumpToChunk(Number(el.dataset.chunkId));
    });
  });
}
