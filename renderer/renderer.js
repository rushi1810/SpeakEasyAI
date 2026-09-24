'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let appMode = 'setup';     // 'setup' | 'interview'
// Diagnostic toggle: when true, test a video-only getDisplayMedia first to help isolate crashes.
const DIAG_TRY_VIDEO_ONLY = true; // set false to disable diagnostic test

let currentLayout = 'landscape'; // 'landscape' | 'portrait'
let sessionActive = false;
let micActive = false;
let systemAudioCaptureStarting = false;
let aiPanelOpen = false;
let sessionElapsed = 0;
let mediaRecorder = null;
let audioChunks = [];
let chunkInterval = null;
let stream = null;
let currentSettings = null;
let deepgramLiveActive = false;
let mediaRecorderMode = null;
let chunkTranscriptionChain = Promise.resolve();
let streamRenderTimer = null;
let audioChunkCounter = 0;
let deepgramAudioChunkCounter = 0;
let audioContext = null;
let sourceNode = null;
let audioWorkletNode = null;
let audioFrameQueue = [];
let audioFrameQueueBytes = 0;
let audioProducedTotal = 0;
let audioConsumedTotal = 0;
let audioDroppedTotal = 0;
let audioSendLoop = null;
let audioQueueDiagnosticsTimer = null;
const DEBUG_AUDIO = false;
const CHUNK_INTERVAL_MS = 900;
const MAX_AUDIO_QUEUE_BYTES = 32768;
const AUDIO_CHUNK_TARGET_BYTES = 1600;
const AUDIO_SEND_LOOP_MS = 20;
const LIVE_CHUNK_MS = 180;
const STREAM_RENDER_INTERVAL_MS = 120;
const TRANSCRIPT_BOX_MAX_ENTRIES = 180;

// --- RAG Functions ---
async function uploadResume(files) {
  if (!files || files.length === 0) return;
  const file = files[0];
  if (!file.path) {
    showToast('Could not access the selected resume file path');
    return;
  }
  const status = document.getElementById('resumeStatus');
  status.textContent = 'Processing...';
  status.style.color = 'var(--color-primary)';
  
  const result = await window.electronAPI.processFile({ filePath: file.path, source: 'resume' });
  if (result.success) {
    status.textContent = `✓ ${result.fileName}`;
    showToast('Resume uploaded and indexed');
  } else {
    status.textContent = 'Error uploading';
    status.style.color = '#ef4444';
    showToast('Failed: ' + result.error);
  }
}

async function uploadJD(files) {
  if (!files || files.length === 0) return;
  const file = files[0];
  if (!file.path) {
    showToast('Could not access the selected JD file path');
    return;
  }
  const status = document.getElementById('jdStatus');
  status.textContent = 'Processing...';
  
  const result = await window.electronAPI.processFile({ filePath: file.path, source: 'jd' });
  if (result.success) {
    status.textContent = `✓ ${result.fileName}`;
    showToast('JD uploaded and indexed');
  } else {
    status.textContent = 'Error';
    showToast('Failed: ' + result.error);
  }
}

async function uploadKB(files) {
  if (!files || files.length === 0) return;
  showToast(`Uploading ${files.length} knowledge documents...`);
  
  for (const file of files) {
    if (!file.path) {
      showToast(`Skipped ${file.name || 'a file'}: path unavailable`);
      continue;
    }
    await window.electronAPI.processFile({ filePath: file.path, source: 'kb' });
  }
  
  refreshRAGStatus();
  showToast('Knowledge Base updated');
}

async function updateJDFromText(text) {
  if (!text.trim()) return;
  await window.electronAPI.updateJDText(text);
  showToast('JD text indexed');
}

async function refreshRAGStatus() {
  const status = await window.electronAPI.getRAGStatus();
  
  // Update Resume status
  if (status.resume.length > 0) {
    document.getElementById('resumeStatus').textContent = `✓ ${status.resume[0]}`;
  }
  
  // Update JD status
  if (status.jd.length > 0) {
    document.getElementById('jdStatus').textContent = `✓ ${status.jd[0]}`;
  }

  // Update KB list
  const kbList = document.getElementById('kbList');
  if (status.kb.length > 0) {
    kbList.innerHTML = status.kb.map(name => `
      <div class="kb-item">
        <span>📄 ${name}</span>
      </div>
    `).join('');
  } else {
    kbList.innerHTML = '<div style="font-size:11px;color:rgba(255,255,255,0.2);padding:4px">No KB documents loaded</div>';
  }
  const sqlDatasetStatus = document.getElementById('sqlDatasetStatus');
  const sqlDatasetHint = document.getElementById('sqlDatasetHint');
  if (sqlDatasetStatus && sqlDatasetHint && status.sqlStatus) {
    if (status.sqlStatus.available) {
      const pendingOcrText = status.sqlStatus.pendingOcrFiles > 0
        ? `, ${status.sqlStatus.pendingOcrFiles} image files waiting for OCR`
        : '';
      sqlDatasetStatus.textContent = `${status.sqlStatus.indexedDocuments} SQL files indexed${pendingOcrText}`;
      sqlDatasetHint.textContent = `Folder: ${status.sqlStatus.rootPath}`;
    } else {
      sqlDatasetStatus.textContent = 'No data_set folder found yet';
      sqlDatasetHint.textContent = `Expected folder: ${status.sqlStatus.rootPath}`;
    }
  }
}

window.uploadResume = uploadResume;
window.uploadJD = uploadJD;
window.uploadKB = uploadKB;
window.updateJDFromText = updateJDFromText;
window.refreshRAGStatus = refreshRAGStatus;

let kbQuestions = [];
let automaticKBDResults = [];
let selectedKBQuestionId = null;
let kbQuestionFetchInFlight = false;
let kbQuestionLoadError = '';
let kbSearchQuery = '';
let kbdExpanded = false;

function normalizeKBDSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreKBDQuestionMatch(question, answer, query) {
  const normalizedQuestion = normalizeKBDSearchText(question);
  const normalizedAnswer = normalizeKBDSearchText(answer);
  const haystack = `${normalizedQuestion} ${normalizedAnswer}`.trim();
  if (!query || !haystack) return 0;

  let score = 0;
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;

  if (normalizedQuestion === query) score += 100;
  if (normalizedQuestion.startsWith(query)) score += 40;
  if (normalizedQuestion.includes(query)) score += 30;

  for (const term of terms) {
    if (normalizedQuestion.includes(term)) score += 20;
    if (normalizedAnswer.includes(term)) score += 8;
    if (haystack.includes(term)) score += 5;
  }

  if (terms.every(term => normalizedQuestion.includes(term))) score += 25;
  if (terms.every(term => haystack.includes(term))) score += 10;

  return score;
}

function getFilteredKBDQuestions() {
  const trimmed = kbSearchQuery.trim();
  if (!trimmed) return [];

  const query = normalizeKBDSearchText(trimmed);
  if (!query) return [];

  return kbQuestions
    .map(item => {
      const question = String(item.question || '');
      const answer = String(item.answer || '');
      return {
        ...item,
        _score: scoreKBDQuestionMatch(question, answer, query)
      };
    })
    .filter(item => item._score > 0)
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return (a.question || '').localeCompare(b.question || '') || (a.id || '').localeCompare(b.id || '');
    });
}

function renderKBDSearchResults() {
  const listEl = document.getElementById('kbQuestionList');
  if (!listEl) return;

  const searchInput = document.getElementById('kbdQuestionSearch');
  kbSearchQuery = searchInput ? (searchInput.value || '') : kbSearchQuery;

  if (kbQuestionFetchInFlight) {
    listEl.innerHTML = '<div class="kb-question-loading">Loading KBD questions...</div>';
    return;
  }

  if (kbQuestionLoadError) {
    listEl.innerHTML = `<div class="kb-question-error">${esc(kbQuestionLoadError)}</div>`;
    return;
  }

  if (!Array.isArray(kbQuestions) || !kbQuestions.length) {
    listEl.innerHTML = '<div class="kb-question-empty">No KBD questions available.</div>';
    return;
  }

  const trimmed = kbSearchQuery.trim();
  const results = trimmed ? getFilteredKBDQuestions() : automaticKBDResults.map(item => ({ ...item, _score: Number(item.score || 0) }));

  if (!results.length) {
    listEl.innerHTML = trimmed
      ? '<div class="kb-question-empty">No matching KBD questions found.</div>'
      : '<div class="kb-question-empty">No highly relevant KBD question found.</div>';
    return;
  }

  // Show 3 results when collapsed, 8 when expanded
  const maxVisible = kbdExpanded ? 8 : 3;
  const visible = results.slice(0, maxVisible);
  const remaining = results.length - visible.length;

  listEl.innerHTML = visible.map(item => `
    <button class="kb-question-item${selectedKBQuestionId === item.id ? ' active' : ''}" type="button" data-kbd-id="${esc(item.id)}" onclick="selectKBDQuestion('${esc(item.id)}')">
      ${esc(item.question || 'Untitled KBD question')}
    </button>
  `).join('') + (remaining > 0 ? `<div class="kb-question-more" onclick="expandKBDResults()">${kbdExpanded ? 'Show less ▲' : '+ Show more ▼'}</div>` : '');

  const buttons = [...document.querySelectorAll('.kb-question-item')];
  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.kbdId === selectedKBQuestionId);
  });
}

async function refreshKBDQuestions(forceRefresh = false) {
  const listEl = document.getElementById('kbQuestionList');
  if (!listEl) return;

  if (!forceRefresh && kbQuestionFetchInFlight) return;
  kbQuestionFetchInFlight = true;
  listEl.innerHTML = '<div class="kb-question-loading">Loading KBD questions...</div>';

  try {
    kbQuestionLoadError = '';
    const records = await window.electronAPI.getKBDQuestions();
    if (!Array.isArray(records)) {
      const message = records && records.error ? records.error : 'KBD request failed.';
      throw new Error(message);
    }

    kbQuestions = [...new Map(records.map(item => [String(item.id), item])).values()];
    renderKBDSearchResults();
  } catch (err) {
    console.error('KBD: Failed to refresh questions', err);
    kbQuestionLoadError = 'Unable to load KBD questions. Check the KBD folder or API connection.';
    listEl.innerHTML = `<div class="kb-question-error">${esc(kbQuestionLoadError)}</div>`;
  } finally {
    kbQuestionFetchInFlight = false;
    renderKBDSearchResults();
  }
}

async function selectKBDQuestion(id) {
  const record = kbQuestions.find(item => item.id === id);
  if (!record) {
    showToast('Selected KBD question could not be found.');
    return;
  }

  selectedKBQuestionId = id;
  renderKBDSearchResults();

  try {
    const response = await window.electronAPI.getKBDQuestionAnswer(id);
    const answerText = response && response.success && response.entry && response.entry.answer
      ? response.entry.answer
      : (record.answer || '');

    if (!answerText) {
      throw new Error(response && response.error ? response.error : 'KBD answer unavailable');
    }

    if (window.electronAPI && window.electronAPI.recordKBDSelection) {
      window.electronAPI.recordKBDSelection({
        id: record.id,
        question: record.question,
        answer: answerText,
        score: Number(record._score || 0),
        query: kbSearchQuery
      }).catch(() => undefined);
    }

    if (!aiPanelOpen) openAIPanel();
    panelResponses.push({
      question: record.question || 'KBD Question',
      html: renderMarkdown(answerText),
      raw: answerText,
      sourceStamp: 'KBD'
    });
    panelCurrentIdx = panelResponses.length - 1;
    panelIsStreaming = false;
    panelStreamingText = answerText;
    teleprompterRawText = answerText;
    teleprompterQuestion = record.question || 'KBD Question';
    renderPanelContent();
    syncTeleprompterContent(answerText, {
      question: teleprompterQuestion,
      status: 'KBD answer loaded'
    });
    renderTeleprompterText(true);
    showToast('KBD answer loaded');
  } catch (error) {
    console.error('KBD: Failed to fetch question answer', error);
    showToast('Unable to load the selected KBD answer.');
  }
}

window.refreshKBDQuestions = refreshKBDQuestions;
window.selectKBDQuestion = selectKBDQuestion;

function toggleKBDExpanded() {
  kbdExpanded = !kbdExpanded;
  const kbdStrip = document.querySelector('.ai-kbd-strip');
  const expandBtn = document.getElementById('kbdExpandBtn');
  if (kbdStrip) {
    kbdStrip.classList.toggle('expanded', kbdExpanded);
  }
  if (expandBtn) {
    expandBtn.textContent = kbdExpanded ? 'Show Less ▲' : 'Show More ▼';
  }
  renderKBDSearchResults();
}

function expandKBDResults() {
  toggleKBDExpanded();
}

window.toggleKBDExpanded = toggleKBDExpanded;
window.expandKBDResults = expandKBDResults;

const kbdQuestionSearchInput = document.getElementById('kbdQuestionSearch');
if (kbdQuestionSearchInput) {
  kbdQuestionSearchInput.addEventListener('input', async (event) => {
    kbSearchQuery = event.target.value || '';
    renderKBDSearchResults();

    if (kbSearchQuery.trim()) {
      try {
        const response = await window.electronAPI.searchKBDQuestions(kbSearchQuery, 8);
        if (response && response.success && Array.isArray(response.results) && response.results.length) {
          window.electronAPI.recordKBDSearch(kbSearchQuery, response.results.length).catch(() => undefined);
        }
      } catch (err) {
        console.warn('KBD manual search failed:', err);
      }
    }
  });
}

window.electronAPI.onKBDRelatedQuestions((payload) => {
  automaticKBDResults = Array.isArray(payload && payload.results) ? payload.results : [];
  renderKBDSearchResults();
});

window.electronAPI.onKBDUpdated(() => {
  refreshKBDQuestions(true).catch(err => console.error('Failed to refresh KBD questions:', err));
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    refreshKBDQuestions(true).catch(err => console.error('Failed to load KBD questions:', err));
  });
} else {
  refreshKBDQuestions(true).catch(err => console.error('Failed to load KBD questions:', err));
}

// ── AI Panel State ────────────────────────────────────────────────────────
const panelResponses = []; // array of { question, html, raw, sourceStamp }
let panelCurrentIdx = -1;
let panelStreamingText = '';
let panelIsStreaming = false;
let isClickThrough = false;
let transcriptBoxOpen = false;
let topBarOpen = true;
let teleprompterOpen = false;
let teleprompterPaused = false;
let teleprompterSpeed = 28;
let teleprompterFontSize = 28;
let teleprompterFrame = null;
let teleprompterLastTick = 0;
let teleprompterQuestion = 'Latest answer';
let teleprompterRawText = '';

// ── Helpers & Toasts ───────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function openGroqConsole() {
  window.electronAPI.openExternal('https://console.groq.com/keys');
}
window.openGroqConsole = openGroqConsole;

let toastTimeout;
function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2200);
}

function debugToast(msg) {
  showToast(msg);
}

window.onerror = function(msg, url, line, col, error) {
  debugToast('JS Error: ' + msg + ' at line ' + line);
  return false;
};


// ── Panel-open class helper (makes bar flat-bottom when panel is attached) ──
function setBarPanelOpen(open) {
  const bar = document.getElementById('interviewBar');
  if (!bar) return;
  if (open) bar.classList.add('panel-open');
  else bar.classList.remove('panel-open');
}

function stopTeleprompterLoop() {
  if (teleprompterFrame) {
    cancelAnimationFrame(teleprompterFrame);
    teleprompterFrame = null;
  }
  teleprompterLastTick = 0;
}

function startTeleprompterLoop() {
  if (teleprompterFrame) return;

  const tick = timestamp => {
    teleprompterFrame = requestAnimationFrame(tick);
    const viewport = document.getElementById('teleprompterViewport');
    if (!teleprompterOpen || teleprompterPaused || !viewport) {
      teleprompterLastTick = timestamp;
      return;
    }

    if (!teleprompterLastTick) {
      teleprompterLastTick = timestamp;
      return;
    }

    const deltaSeconds = (timestamp - teleprompterLastTick) / 1000;
    teleprompterLastTick = timestamp;

    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    if (maxScroll <= 0 || viewport.scrollTop >= maxScroll) return;

    viewport.scrollTop = Math.min(maxScroll, viewport.scrollTop + (teleprompterSpeed * deltaSeconds));
  };

  teleprompterFrame = requestAnimationFrame(tick);
}

function setTeleprompterStatus(text) {
  const statusEl = document.getElementById('teleprompterStatus');
  if (statusEl) statusEl.textContent = text;
}

function updateTeleprompterControls() {
  const fontInfo = document.getElementById('teleprompterFontInfo');
  const speedInfo = document.getElementById('teleprompterSpeedInfo');
  const pauseBtn = document.getElementById('teleprompterPauseBtn');
  const contentEl = document.getElementById('teleprompterContent');

  if (fontInfo) fontInfo.textContent = `${teleprompterFontSize}px`;
  if (speedInfo) speedInfo.textContent = `${(teleprompterSpeed / 28).toFixed(1)}x`;
  if (pauseBtn) pauseBtn.textContent = teleprompterPaused ? 'Resume' : 'Pause';
  if (contentEl) contentEl.style.fontSize = `${teleprompterFontSize}px`;
}

function resetTeleprompterScroll() {
  const viewport = document.getElementById('teleprompterViewport');
  if (viewport) viewport.scrollTop = 0;
  teleprompterLastTick = 0;
}

function stripMarkdownForTeleprompter(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, block => {
      const code = block
        .replace(/```[\w-]*\n?/g, '')
        .replace(/```/g, '')
        .trim();
      return code ? `\n\n${code}\n\n` : '\n\n';
    })
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^---$/gm, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderTeleprompterText(resetScroll = false) {
  const questionEl = document.getElementById('teleprompterQuestion');
  const contentEl = document.getElementById('teleprompterContent');
  if (!contentEl) return;

  if (questionEl) {
    questionEl.textContent = teleprompterQuestion || 'Latest answer';
  }

  const cleanedText = stripMarkdownForTeleprompter(teleprompterRawText);
  if (!cleanedText) {
    contentEl.innerHTML = '<p class="teleprompter-empty">Generate an answer and it will appear here in an easier near-camera reading layout.</p>';
  } else {
    const paragraphs = cleanedText
      .split(/\n{2,}/)
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => `<p>${esc(part).replace(/\n/g, '<br>')}</p>`)
      .join('');

    contentEl.innerHTML = paragraphs || `<p>${esc(cleanedText).replace(/\n/g, '<br>')}</p>`;
  }

  updateTeleprompterControls();
  if (resetScroll) resetTeleprompterScroll();
}

function syncTeleprompterContent(text, options = {}) {
  teleprompterRawText = text || '';
  if (options.question !== undefined) {
    teleprompterQuestion = options.question || 'Latest answer';
  }
  renderTeleprompterText(Boolean(options.resetScroll));
  if (options.status) {
    setTeleprompterStatus(options.status);
  }
}

function refreshExpandedLayout() {
  const expanded = aiPanelOpen || transcriptBoxOpen || teleprompterOpen;
  setBarPanelOpen(expanded);
  window.electronAPI.resizeToInterview(expanded);
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  // 1. Register event listeners IMMEDIATELY
  // Global error handlers to capture renderer-side exceptions
  window.addEventListener('error', (ev) => {
    try { console.error('[RENDERER-ERROR]', ev.error || ev.message, ev); } catch (e) { console.error('[RENDERER-ERROR] (log failure)', e); }
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try { console.error('[RENDERER-UNHANDLED-REJECTION]', ev.reason); } catch (e) { console.error('[RENDERER-UNHANDLED-REJECTION] (log failure)', e); }
  });

  window.electronAPI.onModeChanged(data => {
    console.log('Mode changed event:', data);
    if (data.mode === 'interview') showInterviewMode();
    else if (data.mode === 'dashboard') showSetupMode();
  });

  window.electronAPI.onTranscriptUpdate(data => {
    updateTranscript(data);
  });

  window.electronAPI.onSessionTimerUpdate(elapsed => {
    sessionElapsed = elapsed;    updateTimer(elapsed);
  });

  window.electronAPI.onCollapseStateChanged(data => {
    toggleCollapsed(data.collapsed);
  });

  if (window.electronAPI.onStartMicCapture) {
    window.electronAPI.onStartMicCapture(() => {
      if (!micActive && !systemAudioCaptureStarting) {
      void startSystemAudioCapture();
      }
    });
  }
  window.electronAPI.onStopMicCapture(() => stopSystemAudioCapture());
  if (window.electronAPI.onStartSystemAudioCapture) {
    window.electronAPI.onStartSystemAudioCapture(() => {
      if (!micActive && !systemAudioCaptureStarting) {
      void startSystemAudioCapture();
      }
    });
  }
  if (window.electronAPI.onStopSystemAudioCapture) {
  window.electronAPI.onStopSystemAudioCapture(() => stopSystemAudioCapture());
  }

  window.electronAPI.onClickThroughChanged(v => {
    isClickThrough = v;
    const btn = document.getElementById('btnClickThrough');
    if (btn) {
      btn.classList.toggle('active', v);
      btn.classList.toggle('click-through', v);
    }
    showToast(v ? 'Click-through ON' : 'Click-through OFF');
  });

  // Handle AI Panel messages from main
  window.electronAPI.onAIPanelMessage(raw => {
    try {
      const msg = JSON.parse(raw);
      handleAIIncomingMessage(msg);
    } catch(e) {
      console.error('AI panel message error:', e);
    }
  });

  window.electronAPI.onToast(data => {
    if (data && data.msg) showToast(data.msg);
  });

  // Clipboard detected → show and auto-generate answer
  if (window.electronAPI.onClipboardDetected) {
    window.electronAPI.onClipboardDetected(raw => {
      try {
        const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const item = payload?.item || payload;
        if (!item || !item.text) return;
        showToast('📋 Clipboard Detected');
        // Populate chat input
        const input = document.getElementById('chatInput');
        if (input) input.value = item.text;
        // Open AI panel and ensure layout
        if (!aiPanelOpen) openAIPanel();
        window.electronAPI.resizeToInterview(true);
        // Determine isCoding from detected type
        const isCoding = /Code|SQL|JavaScript|Python|Java|C#|Coding|LeetCode|HackerRank/i.test(item.type || '');
        // Trigger generateAnswer automatically
        void window.electronAPI.generateAnswer({ question: item.text, isCoding: Boolean(isCoding) });
      } catch (e) {
        console.warn('Clipboard handler error', e);
      }
    });
  }

  // Handle layout changes from main
  if (window.electronAPI.onLayoutChanged) {
    window.electronAPI.onLayoutChanged(data => {
      currentLayout = data.layout;
      applyLayoutClass(currentLayout);
    });
  }

  // Pause auto-resize while user manually drags the window edge
  if (window.electronAPI.onUserResizeStart) {
    window.electronAPI.onUserResizeStart(() => {
      userIsResizing = true;
      if (userResizeCooldown) clearTimeout(userResizeCooldown);
    });
  }
  if (window.electronAPI.onUserResizeEnd) {
    window.electronAPI.onUserResizeEnd(() => {
      if (userResizeCooldown) clearTimeout(userResizeCooldown);
      userResizeCooldown = setTimeout(() => {
        userIsResizing = false;
        userResizeCooldown = null;
      }, 3000);
    });
  }

  // 2. Load settings and state
  try {
    const settings = await window.electronAPI.getSettings();
    currentSettings = settings;

    // Populate saved values
    if (settings.groqApiKey) {
      document.getElementById('apiKeyInput').value = settings.groqApiKey;
      setApiKeyStatus('valid', '✓ Key saved');
      enableStartIfReady();
    }
    if (settings.company) document.getElementById('companyInput').value = settings.company;
    if (settings.position) document.getElementById('positionInput').value = settings.position;
    if (settings.customInstructions) document.getElementById('instructionsInput').value = settings.customInstructions;
    if (settings.autoAnswer !== undefined) {
      const toggle = document.getElementById('autoAIToggle');
      if (toggle) toggle.checked = settings.autoAnswer;
    }
    if (settings.windowOpacity !== undefined) {
      document.body.style.opacity = settings.windowOpacity / 100;
      const slider = document.getElementById('panelOpacitySlider');
      if (slider) slider.value = settings.windowOpacity;
    }

    // Load sessions & RAG status in background
    loadSessions().catch(e => console.error('Failed to load sessions:', e));
    refreshRAGStatus().catch(e => console.error('Failed to refresh RAG status:', e));
    refreshKBDQuestions(true).catch(e => console.error('Failed to refresh KBD questions:', e));

    // Load current layout state
    if (window.electronAPI.getLayout) {
      window.electronAPI.getLayout().then(data => {
        currentLayout = data.layout || 'landscape';
        applyLayoutClass(currentLayout);
      }).catch(() => {});
    }

  } catch (err) {
    console.error('Init error:', err);
    showToast('Initialization error. Check settings.');
  }

  showScreen('setupScreen');
}

// ── Screen management ──────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function showInterviewMode() {
  appMode = 'interview';
  sessionActive = true;
  showScreen('interviewScreen');
  window.electronAPI.resizeToInterview(false);
}

function showSetupMode() {
  appMode = 'setup';
  sessionActive = false;
  aiPanelOpen = false;
  transcriptBoxOpen = false;
  teleprompterOpen = false;
  teleprompterPaused = false;
  stopTeleprompterLoop();
  document.getElementById('aiPanelContainer')?.classList.remove('visible');
  document.getElementById('transcriptBoxContainer')?.classList.remove('visible');
  document.getElementById('teleprompterContainer')?.classList.remove('visible');
  document.getElementById('btnAIPanel')?.classList.remove('active');
  document.getElementById('btnTranscriptBox')?.classList.remove('active');
  document.getElementById('btnTeleprompter')?.classList.remove('active');
  setBarPanelOpen(false);
  showScreen('setupScreen');
  window.electronAPI.resizeToDashboard();
  updateTimer(0);
  loadSessions();
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('tabStart').classList.toggle('active', tab === 'start');
  document.getElementById('tabSessions').classList.toggle('active', tab === 'sessions');
  document.getElementById('panelStart').classList.toggle('active', tab === 'start');
  document.getElementById('panelSessions').classList.toggle('active', tab === 'sessions');
  if (tab === 'sessions') loadSessions();
}

// ── API Key ────────────────────────────────────────────────────────────────
function onApiKeyInput() {
  const val = document.getElementById('apiKeyInput').value.trim();
  enableStartIfReady();
}

async function verifyApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) return;

  setApiKeyStatus('checking', 'Checking...');
  document.getElementById('btnVerify').disabled = true;

  const result = await window.electronAPI.validateApiKey(key);

  if (result.valid) {
    await window.electronAPI.saveSettings({ groqApiKey: key });
    setApiKeyStatus('valid', '✓ Valid key');
    enableStartIfReady();
    showToast('API key saved!');
  } else {
    setApiKeyStatus('invalid', result.error || 'Invalid key');
  }
  document.getElementById('btnVerify').disabled = false;
}

function setApiKeyStatus(state, text) {
  const el = document.getElementById('apiKeyStatus');
  el.className = 'api-key-status ' + state;
  el.textContent = text;
}

function enableStartIfReady() {
  const key = document.getElementById('apiKeyInput').value.trim();
  document.getElementById('btnStart').disabled = !key;
}

// ── Session ────────────────────────────────────────────────────────────────
async function startSession() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) { showToast('Please enter your Groq API key first'); return; }

  const opts = {
    company: document.getElementById('companyInput').value.trim(),
    position: document.getElementById('positionInput').value.trim(),
    resume: "", // Now handled by RAG service in main.ts
    jdText: document.getElementById('jdInput').value.trim(),
    customInstructions: document.getElementById('instructionsInput').value.trim()
  };

  // Save API key if not already saved
  await window.electronAPI.saveSettings({ groqApiKey: key });

  const btnStart = document.getElementById('btnStart');
  btnStart.disabled = true;
  btnStart.textContent = 'Starting...';

  try {
    await window.electronAPI.startSession(opts);
    // Explicit transition as backup to main event
    showInterviewMode();
  } catch (e) {
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnStart').textContent = 'Start Interview Session';
    showToast('Failed to start session: ' + e.message);
  }
}

async function stopSession() {
  if (!confirm('End the interview session?')) return;
  stopSystemAudioCapture();
  await window.electronAPI.endSession();
  document.getElementById('btnStart').disabled = false;
  document.getElementById('btnStart').textContent = 'Start Interview Session';
  if (window.electronAPI && typeof window.electronAPI.closeApp === 'function') {
    await window.electronAPI.closeApp();
  }
}

async function loadSessions() {
  const sessions = await window.electronAPI.getSessions();
  const list = document.getElementById('sessionsList');
  if (!sessions || sessions.length === 0) {
    list.innerHTML = '<div class="no-sessions">No past sessions yet</div>';
    return;
  }
  list.innerHTML = sessions.slice(0, 10).map(s => {
    const date = new Date(s.startTime).toLocaleDateString();
    const dur = s.endTime ? formatTime(Math.floor((s.endTime - s.startTime) / 1000)) : 'In progress';
    return `<div class="session-item">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div class="session-company">${esc(s.company || 'Interview')} ${s.position ? '— ' + esc(s.position) : ''}</div>
          <div class="session-meta">${date} · ${dur} · ${s.aiConversations?.length || 0} AI answers</div>
        </div>
        <button class="icon-btn" onclick="exportSession('${s.id}')" title="Export as TXT">📥</button>
      </div>
    </div>`;
  }).join('');
}

async function exportSession(sessionId) {
  const sessions = await window.electronAPI.getSessions();
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;

  let text = `INTERVIEW SESSION: ${s.company || 'N/A'}\n`;
  text += `Position: ${s.position || 'N/A'}\n`;
  text += `Date: ${new Date(s.startTime).toLocaleString()}\n`;
  text += `Duration: ${s.endTime ? formatTime(Math.floor((s.endTime - s.startTime) / 1000)) : 'In progress'}\n`;
  text += `\n` + `─`.repeat(40) + `\n\n`;

  text += `TRANSCRIPT:\n`;
  if (s.transcript && s.transcript.length > 0) {
    s.transcript.forEach(t => {
      text += `[${new Date(t.timestamp).toLocaleTimeString()}] ${t.text}\n`;
    });
  } else {
    text += `No transcript recorded.\n`;
  }

  text += `\n` + `─`.repeat(40) + `\n\n`;
  text += `AI CONVERSATIONS:\n`;
  if (s.aiConversations && s.aiConversations.length > 0) {
    s.aiConversations.forEach((c, idx) => {
      text += `Q${idx+1}: ${c.question}\n`;
      text += `A${idx+1}: ${c.answer}\n\n`;
    });
  } else {
    text += `No AI conversations recorded.\n`;
  }

  const filename = `Session_${s.company || 'Interview'}_${new Date(s.startTime).toISOString().split('T')[0]}.txt`.replace(/[<>:"/\\|?*]/g, '_');
  
  // Create download link
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Session exported to downloads');
}

async function exportCurrentSession() {
  const sessions = await window.electronAPI.getSessions();
  if (!sessions || sessions.length === 0) {
    showToast('No sessions found to export');
    return;
  }
  
  // The first session is usually the most recent one (unshifted in store.ts)
  const latest = sessions[0];
  exportSession(latest.id);
}

// ── System audio capture (desktop output only, no microphone) ─────────────
async function startSystemAudioCapture() {
  if (micActive || systemAudioCaptureStarting) return;
  systemAudioCaptureStarting = true;

  try {
    console.log('[SYSTEM-AUDIO] Requesting display/system audio');
    currentSettings = await window.electronAPI.getSettings();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('getDisplayMedia is not available in this environment.');
    }

    // Request display media which triggers main's display media handler (provides loopback audio on Windows)
    let displayStream;

    try {
      if (DIAG_TRY_VIDEO_ONLY) {
        try {
          console.log('[SYSTEM-AUDIO][DIAG] Attempting video-only getDisplayMedia test');
          const vidStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          console.log('[SYSTEM-AUDIO][DIAG] video-only getDisplayMedia returned. Stopping tracks.');
          try { vidStream.getTracks().forEach(t => t.stop()); } catch (e) { console.warn('[SYSTEM-AUDIO][DIAG] failed to stop video-only tracks', e); }
        } catch (e) {
          console.warn('[SYSTEM-AUDIO][DIAG] video-only getDisplayMedia failed:', e && e.name, e && e.message);
          // continue to real attempt — log but do not abort diagnostic
        }
      }

      console.log('[SYSTEM-AUDIO][BEFORE_GETDISPLAY] Calling getDisplayMedia with { video: true, audio: true } at', Date.now());
      displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      console.log('[SYSTEM-AUDIO][AFTER_GETDISPLAY] getDisplayMedia returned at', Date.now());
    } catch (err) {
      console.error('[SYSTEM-AUDIO] getDisplayMedia failed:', err && err.name, err && err.message);
      console.error(err && err.stack);
      // Provide a clearer user-facing message
      if (err && err.name === 'NotAllowedError') {
        throw new Error('Desktop/system audio permission denied. Please allow desktop audio capture and try again.');
      }
      if (err && err.name === 'NotFoundError') {
        throw new Error('No display/system audio source was found. Ensure your system supports loopback capture and try again.');
      }
      throw new Error('System audio capture could not be started: ' + (err && err.message ? err.message : 'unknown error'));
    }

    stream = displayStream;

    // Inspect tracks in detail
    const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    const videoTracks = stream.getVideoTracks ? stream.getVideoTracks() : [];

    console.log('[SYSTEM-AUDIO][TRACKS] audioCount=', audioTracks.length, 'videoCount=', videoTracks.length);
    if (videoTracks && videoTracks.length) {
      videoTracks.forEach((t, idx) => {
        try {
          console.log('[SYSTEM-AUDIO] Stopping video track:', { id: t.id, label: t.label, kind: t.kind, enabled: t.enabled });
          t.stop();
          console.log('[SYSTEM-AUDIO] Video track stopped:', t.id);
        } catch (e) {
          console.warn('[SYSTEM-AUDIO] Video track stop failed for', t && t.id, e);
        }
      });
      console.log('[SYSTEM-AUDIO] All video tracks stopped');
    }

    if (!audioTracks || audioTracks.length === 0) {
      throw new Error('System audio track not available. Please allow desktop/system audio capture.');
    }

    try {
      const settings = audioTracks[0].getSettings ? audioTracks[0].getSettings() : null;
      console.log('[SYSTEM-AUDIO] Audio track settings:', settings);
    } catch (e) {
      console.warn('[SYSTEM-AUDIO] Failed to read audio track settings', e);
    }

    micActive = true;
    const btnMic = document.getElementById('btnMic');
    if (btnMic) btnMic.classList.add('active', 'mic');

    const hasDeepgramSpeech = Boolean(currentSettings && currentSettings.deepgramApiKey);
    const hasGroqSpeech = Boolean(currentSettings && currentSettings.groqApiKey);

    if (!hasDeepgramSpeech && !hasGroqSpeech) {
      throw new Error('Speech API key missing. Add a Deepgram or Groq API key in Settings.');
    }

    if (hasDeepgramSpeech) {
      setTranscriptStatus('connecting');
      updateTranscriptText('System audio listening: connecting to Deepgram live STT...');
      try {
        await startLiveDeepgramStreaming();
        return;
      } catch (err) {
        console.error('[SYSTEM-AUDIO] Deepgram live STT failed:', err);
        if (!hasGroqSpeech) {
          throw err;
        }
        const reason = err && err.message ? ` (${err.message})` : '';
        showToast(`Deepgram live STT unavailable${reason}. Using fallback transcription.`);
        updateTranscriptText('System audio is active. Deepgram live transcription is unavailable.');
      }
    }

    startChunkedRecording();
  } catch (err) {
    micActive = false;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    const btnMic = document.getElementById('btnMic');
    if (btnMic) btnMic.classList.remove('active', 'mic');
    console.error('[SYSTEM-AUDIO] Capture error:', err);
    setTranscriptStatus('error');
    updateTranscriptText('System audio capture could not be started. Please allow desktop/system audio capture and try again.');
    showToast(err && err.message ? err.message : 'System audio capture failed');
  } finally {
    systemAudioCaptureStarting = false;
  }
}

function startAudioQueueDiagnostics() {
  if (!DEBUG_AUDIO || audioQueueDiagnosticsTimer) return;
  audioQueueDiagnosticsTimer = setInterval(() => {
    if (!deepgramLiveActive) return;
    const queueDepth = audioFrameQueueBytes;
    const bufferedAmount = window.electronAPI && typeof window.electronAPI.getDeepgramBufferedAmount === 'function'
      ? Promise.resolve(window.electronAPI.getDeepgramBufferedAmount()).catch(() => 0)
      : Promise.resolve(0);

    bufferedAmount.then(value => {
      console.log(
        '[SYSTEM-AUDIO][QUEUE] produced=%d consumed=%d queued=%d dropped=%d websocketBufferedAmount=%d',
        audioProducedTotal,
        audioConsumedTotal,
        queueDepth,
        audioDroppedTotal,
        Number(value || 0)
      );
    });
  }, 1000);
}

function stopAudioQueueDiagnostics() {
  if (audioQueueDiagnosticsTimer) {
    clearInterval(audioQueueDiagnosticsTimer);
    audioQueueDiagnosticsTimer = null;
  }
}

function flushQueuedAudioToDeepgram() {
  if (!deepgramLiveActive || !audioFrameQueue.length) return;

  const frames = [];
  let totalLength = 0;
  while (audioFrameQueue.length && totalLength < AUDIO_CHUNK_TARGET_BYTES) {
    const nextFrame = audioFrameQueue.shift();
    if (!nextFrame || !nextFrame.length) continue;
    frames.push(nextFrame);
    totalLength += nextFrame.byteLength;
    audioFrameQueueBytes -= nextFrame.byteLength;
  }

  if (!frames.length) return;

  const chunk = new Uint8Array(totalLength);
  let offset = 0;
  for (const frame of frames) {
    chunk.set(frame, offset);
    offset += frame.byteLength;
  }

  audioConsumedTotal += chunk.byteLength;
  deepgramAudioChunkCounter += 1;
  if (deepgramAudioChunkCounter === 1) {
    console.log('[DEEPGRAM] First PCM frame sent:', chunk.byteLength, 'bytes');
  }
  window.electronAPI.sendLiveSttAudio({ audioBuffer: chunk });
}

function queueDeepgramAudioFrame(frameBytes) {
  if (!frameBytes || !frameBytes.byteLength) return;
  if (!deepgramLiveActive) return;

  const frame = frameBytes instanceof Uint8Array
    ? new Uint8Array(frameBytes)
    : new Uint8Array(frameBytes.buffer.slice(frameBytes.byteOffset, frameBytes.byteOffset + frameBytes.byteLength));

  audioProducedTotal += frame.byteLength;

  while (audioFrameQueueBytes + frame.byteLength > MAX_AUDIO_QUEUE_BYTES && audioFrameQueue.length) {
    const oldest = audioFrameQueue.shift();
    if (oldest) {
      audioFrameQueueBytes -= oldest.byteLength;
      audioDroppedTotal += 1;
    }
  }

  if (audioFrameQueueBytes + frame.byteLength > MAX_AUDIO_QUEUE_BYTES) {
    audioDroppedTotal += 1;
    console.warn('[SYSTEM-AUDIO] Dropped queued PCM frame to keep bounded audio buffer');
    return;
  }

  audioFrameQueue.push(frame);
  audioFrameQueueBytes += frame.byteLength;
}

function stopAudioProcessing() {
  if (audioSendLoop) {
    clearInterval(audioSendLoop);
    audioSendLoop = null;
  }
  stopAudioQueueDiagnostics();
  audioFrameQueue = [];
  audioFrameQueueBytes = 0;

  if (audioWorkletNode) {
    try {
      audioWorkletNode.port.onmessage = null;
      audioWorkletNode.disconnect();
    } catch (e) {
      console.warn('[SYSTEM-AUDIO] Failed to disconnect audioWorkletNode:', e);
    }
    audioWorkletNode = null;
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (e) {
      console.warn('[SYSTEM-AUDIO] Failed to disconnect sourceNode:', e);
    }
    sourceNode = null;
  }

  if (audioContext) {
    try {
      audioContext.close();
    } catch (e) {
      console.warn('[SYSTEM-AUDIO] Failed to close audioContext:', e);
    }
    audioContext = null;
  }

  audioChunkCounter = 0;
  deepgramAudioChunkCounter = 0;
  audioProducedTotal = 0;
  audioConsumedTotal = 0;
  audioDroppedTotal = 0;
}

async function startSystemAudioProcessor() {
  if (!stream || !(window.AudioContext || window.webkitAudioContext)) {
    throw new Error('Web Audio API is not available in this environment.');
  }

  stopAudioProcessing();

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioCtor();
  console.log('[SYSTEM-AUDIO] AudioContext sampleRate:', audioContext.sampleRate);

  const audioTrack = stream.getAudioTracks && stream.getAudioTracks()[0];
  const trackSettings = audioTrack && audioTrack.getSettings ? audioTrack.getSettings() : {};
  const inputChannelCount = typeof trackSettings.channelCount === 'number' ? trackSettings.channelCount : 2;
  console.log('[SYSTEM-AUDIO] Input channel count:', inputChannelCount);
  console.log('[SYSTEM-AUDIO] Audio track state:', audioTrack ? audioTrack.readyState : 'unknown');
  console.log('[SYSTEM-AUDIO] Audio track enabled:', audioTrack ? audioTrack.enabled : 'unknown');

  sourceNode = audioContext.createMediaStreamSource(stream);

  try {
    const workletUrl = new URL('./worklets/system-audio-processor.js', window.location.href).toString();
    await audioContext.audioWorklet.addModule(workletUrl);
    console.log('[SYSTEM-AUDIO] AudioWorklet initialized');
  } catch (e) {
    console.error('[SYSTEM-AUDIO] Failed to initialize AudioWorklet:', e);
    stopAudioProcessing();
    throw new Error('AudioWorklet failed to initialize');
  }

  audioWorkletNode = new AudioWorkletNode(audioContext, 'system-audio-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers'
  });

  audioWorkletNode.port.onmessage = event => {
    const payload = event.data || {};
    if (payload.type === 'ready') {
      console.log('[SYSTEM-AUDIO] AudioWorklet ready');
      return;
    }
    if (payload.type !== 'pcm' || !payload.data) return;

    const frameBytes = payload.data instanceof ArrayBuffer
      ? new Uint8Array(payload.data)
      : new Uint8Array(payload.data);

    audioChunkCounter += 1;
    if (audioChunkCounter === 1) {
      console.log('[SYSTEM-AUDIO] First PCM frame received:', payload.sampleCount || frameBytes.length, 'samples');
    }

    if (deepgramLiveActive) {
      queueDeepgramAudioFrame(frameBytes);
    }
  };

  sourceNode.connect(audioWorkletNode);
  console.log('[SYSTEM-AUDIO] sourceNode -> audioWorkletNode connected');

  audioWorkletNode.port.postMessage({
    type: 'config',
    sampleRate: audioContext.sampleRate,
    outputSampleRate: 16000,
    channels: inputChannelCount
  });

  if (!audioSendLoop) {
    audioSendLoop = setInterval(() => {
      if (!deepgramLiveActive) return;
      flushQueuedAudioToDeepgram();
    }, AUDIO_SEND_LOOP_MS);
  }

  startAudioQueueDiagnostics();
  console.log('[SYSTEM-AUDIO] PCM processor started');
  return { audioContext, sourceNode, audioWorkletNode };
}

function closeDeepgramConnection(manualClose = true) {
  if (deepgramLiveActive || manualClose) {
    deepgramLiveActive = false;
    stopAudioProcessing();
    window.electronAPI.stopLiveDeepgram().catch(() => {});
  }
}

async function startLiveDeepgramStreaming() {
  if (!stream) throw new Error('System audio stream not ready');
  console.log('[DEEPGRAM] Connecting');
  const result = await window.electronAPI.startLiveDeepgram();
  if (!result || !result.success) {
    throw new Error(result && result.error ? result.error : 'Unable to connect to Deepgram');
  }
  console.log('[DEEPGRAM] WebSocket connected');
  deepgramLiveActive = true;
  await startSystemAudioProcessor();
  setTranscriptStatus('ready');
  updateTranscriptText('System audio listening');
}

function startChunkedRecording() {
  if (!stream) return;

  closeDeepgramConnection(true);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch {}
  }
  mediaRecorder = null;
  mediaRecorderMode = 'chunked-groq';
  setTranscriptStatus('ready');
  updateTranscriptText('Listening with Groq Whisper transcription...');

  const startNewChunk = () => {
    if (!micActive || mediaRecorderMode !== 'chunked-groq' || !stream) return;

    audioChunks = [];
    try {
      const mimeType = getChunkMimeType();
      mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const capturedChunks = audioChunks.slice();
        const recorderMimeType = mediaRecorder ? mediaRecorder.mimeType : mimeType;
        if (capturedChunks.length === 0) return;

        const blob = new Blob(capturedChunks, { type: recorderMimeType });
        if (blob.size < 1000) return;

        chunkTranscriptionChain = chunkTranscriptionChain
          .catch(() => {})
          .then(async () => {
            try {
              const arrayBuffer = await blob.arrayBuffer();
              const result = await window.electronAPI.transcribeAudioChunk({
                audioBuffer: new Uint8Array(arrayBuffer),
                mimeType: recorderMimeType
              });
              if (result && !result.success) {
                console.error('Chunk transcription failed:', result.error);
              }
            } catch (err) {
              console.error('Chunk transcription error:', err);
            }
          });
      };

      mediaRecorder.start();
    } catch (err) {
      console.error('MediaRecorder chunking error:', err);
    }
  };

  startNewChunk();

  if (chunkInterval) clearInterval(chunkInterval);
  chunkInterval = setInterval(() => {
    if (mediaRecorderMode !== 'chunked-groq') return;
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try { mediaRecorder.stop(); } catch {}
    }
    if (micActive) {
      setTimeout(startNewChunk, 80);
    }
  }, CHUNK_INTERVAL_MS);
}

function stopSystemAudioCapture() {
  systemAudioCaptureStarting = false;
  micActive = false;
  mediaRecorderMode = null;

  deepgramLiveActive = false;
  audioFrameQueue = [];
  stopAudioProcessing();
  closeDeepgramConnection(true);

  if (chunkInterval) {
    clearInterval(chunkInterval);
    chunkInterval = null;
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch {}
  }
  mediaRecorder = null;
  audioChunks = [];

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  const btnMic = document.getElementById('btnMic');
  if (btnMic) btnMic.classList.remove('active', 'mic');
  setTranscriptStatus('idle');
}

function toggleMic() {
  if (micActive) {
    stopSystemAudioCapture();
    showToast('System audio paused');
  } else {
    startSystemAudioCapture();
    showToast('System audio active');
  }
}

// ── Transcript display ────────────────────────────────────────────────────
function updateTranscript(entry) {
  const payload = typeof entry === 'string' ? { text: entry, isPartial: false } : (entry || {});
  const text = String(payload.text || '').trim();
  if (!text) return;

  const el = document.getElementById('transcriptText');
  if (el) {
    el.textContent = text.length > 90 ? '...' + text.slice(-90) : text;
    setTranscriptStatus('active');
  }
  if (!payload.isPartial) {
    const box = document.getElementById('transcriptBoxContent');
    if (box) {
      const div = document.createElement('div');
      div.style.marginBottom = '8px';
      div.textContent = text;
      box.appendChild(div);
      while (box.childElementCount > TRANSCRIPT_BOX_MAX_ENTRIES) {
        box.removeChild(box.firstElementChild);
      }
      box.scrollTop = box.scrollHeight;
    }
  }
}

function updateTranscriptText(text) {
  const el = document.getElementById('transcriptText');
  if (el) el.textContent = text;
}

function setTranscriptStatus(status) {
  const dot = document.getElementById('transcriptDot');
  if (!dot) return;
  dot.className = 'transcript-dot';
  dot.style.background = '';
  if (status === 'connecting') { dot.classList.add('connecting'); updateTranscriptText('System audio: connecting...'); }
  else if (status === 'ready') { dot.style.background = '#4ade80'; updateTranscriptText('System audio listening'); }
  else if (status === 'active') { dot.style.background = '#4ade80'; dot.className = 'transcript-dot'; }
  else if (status === 'idle') { dot.classList.add('idle'); updateTranscriptText('System audio off'); }
  else if (status === 'error') { dot.style.background = '#f87171'; }
}

// ── AI Actions ────────────────────────────────────────────────────────────
async function triggerAIAnswer() {
  debugToast('AI Answer Triggered');
  const btn = document.getElementById('btnAIAnswer');
  if (!btn) { debugToast('Btn not found'); return; }
  btn.classList.add('active');
  btn.textContent = '⏳ Generating...';
  try {
    debugToast('Calling generateAnswer IPC...');
    await window.electronAPI.generateAnswer({ question: '', isCoding: false });
    debugToast('IPC called successfully');
  } catch(e) {
    debugToast('AI Answer Error: ' + e.message);
  } finally {
    btn.classList.remove('active');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> AI Answer';
  }
}
window.triggerAIAnswer = triggerAIAnswer;

async function triggerAnalyzeScreen() {
  const btn = document.getElementById('btnAnalyzeScreen');
  btn.classList.add('active');
  btn.textContent = '⏳ Analyzing...';
  try {
    await window.electronAPI.analyzeScreen();
    // openAIPanel() is called inside handleAIIncomingMessage('analyzing-screen')
  } finally {
    btn.classList.remove('active');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> Screen';
  }
}

function toggleAutoAI(checked) {
  window.electronAPI.toggleAutoAnswer(checked);
  showToast(checked ? 'Auto AI enabled' : 'Auto AI disabled');
}

async function toggleAIPanel() {
  if (aiPanelOpen) closeAIPanel();
  else openAIPanel();
}

// ── Window controls ───────────────────────────────────────────────────────
function openSettings() {
  window.electronAPI.openSettings();
}

function closeApp() {
  window.electronAPI.closeApp();
}

function collapseApp() {
  window.electronAPI.collapseToLogo();
}

function toggleCollapsed(collapsed) {
  const logo = document.getElementById('collapsedLogo');
  const setupScreen = document.getElementById('setupScreen');
  const interviewScreen = document.getElementById('interviewScreen');
  if (collapsed) {
    if (setupScreen) setupScreen.classList.remove('active');
    if (interviewScreen) interviewScreen.classList.remove('active');
    logo.classList.add('visible');
  } else {
    logo.classList.remove('visible');
    if (appMode === 'interview') showScreen('interviewScreen');
    else showScreen('setupScreen');
  }
}

function expandApp() {
  window.electronAPI.expandFromLogo();
}

function toggleClickThrough() {
  isClickThrough = !isClickThrough;
  window.electronAPI.setClickThrough(isClickThrough);
}

// ── Layout toggle (landscape ↔ portrait) ──────────────────────────────────
async function toggleLayout() {
  const result = await window.electronAPI.toggleLayout();
  currentLayout = result.layout;
  applyLayoutClass(currentLayout);
  showToast(currentLayout === 'portrait' ? '📱 Portrait mode' : '🖥️ Landscape mode');
}

function applyLayoutClass(layout) {
  document.body.classList.toggle('layout-portrait', layout === 'portrait');
  document.body.classList.toggle('layout-landscape', layout === 'landscape');

  // Update all toggle buttons icon/title
  document.querySelectorAll('.btn-layout-toggle').forEach(btn => {
    btn.title = layout === 'portrait' ? 'Switch to Landscape' : 'Switch to Portrait';
    btn.innerHTML = layout === 'portrait'
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="8" x2="22" y2="8"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="7" y1="6" x2="17" y2="6"/></svg>`;
  });
}

function updatePanelOpacity(val) {
  document.body.style.opacity = parseInt(val) / 100;
  window.electronAPI.setOpacity(parseInt(val));
}

// ── Timer ─────────────────────────────────────────────────────────────────
function updateTimer(elapsed) {
  const el = document.getElementById('sessionTimer');
  if (el) el.textContent = formatTime(elapsed);
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}


// ── Connected AI Panel Logic ───────────────

function highlightCode(code, lang) {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderMarkdown(md) {
  if (!md) return '';
  let html = md
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const highlighted = highlightCode(code.trim(), lang);
      return `<pre><button class="panel-copy-btn" onclick="copyCode(this)">Copy</button><code class="${lang ? 'language-'+lang : ''}">${highlighted}</code></pre>`;
    })
    .replace(/`([^`]+)`/g, '<code class="qa-inline-code">$1</code>')
    .replace(/^### (.+)$/gm, '<h3 class="qa-h3">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="qa-h2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="qa-h1">$1</h1>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^---$/gm, '<hr class="qa-divider">')
    .replace(/^> (.+)$/gm, '<blockquote class="qa-quote">$1</blockquote>')
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul class="qa-list">${m}</ul>`)
    .replace(/^\d+\. (.+)$/gm, '<qli>$1</qli>')
    .replace(/(<qli>.*<\/qli>\n?)+/g, m => `<ol class="qa-list qa-list-ordered">${m.replace(/qli/g, 'li')}</ol>`)
    .replace(/\n\n/g, '</p><p class="qa-p">')
    .replace(/\n/g, '<br>');

  if (!html.startsWith('<h') && !html.startsWith('<ul') && !html.startsWith('<pre') && !html.startsWith('<blockquote')) {
    html = `<p class="qa-p">${html}</p>`;
  }

  return html;
}

window.copyCode = function(btn) {
  const code = btn.closest('pre').querySelector('code').innerText;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}

window.copyFullAnswer = function() {
  if (panelCurrentIdx < 0) return;
  const rawText = panelIsStreaming ? panelStreamingText : (panelResponses[panelCurrentIdx] ? panelResponses[panelCurrentIdx].raw || '' : '');
  if (rawText) {
    navigator.clipboard.writeText(rawText);
    showToast('Answer copied to clipboard');
  }
}

function renderStreamingAnswerBody() {
  if (!aiPanelOpen) return;

  const answerBody = document.getElementById('currentAnswerBody');
  if (!answerBody) {
    renderPanelContent();
    return;
  }

  answerBody.innerHTML = panelIsStreaming
    ? renderStreamingPreview(panelStreamingText)
    : renderMarkdown(panelStreamingText);
  const contentEl = document.getElementById('aiPanelContent');
  if (contentEl) {
    contentEl.scrollTop = contentEl.scrollHeight;
  }
}

function renderStreamingPreview(text) {
  return `
    <div style="white-space:pre-wrap;line-height:1.65;color:#e5eefc;font-size:14px;">
      ${esc(text)}
    </div>
  `;
}

function scheduleStreamingPanelRender() {
  if (!aiPanelOpen) return;
  if (streamRenderTimer) return;
  streamRenderTimer = setTimeout(() => {
    streamRenderTimer = null;
    renderStreamingAnswerBody();
  }, STREAM_RENDER_INTERVAL_MS);
}

function handleAIIncomingMessage(msg) {
  if (msg.type === 'toggle-teleprompter') {
    toggleTeleprompter();

  } else if (msg.type === 'new-response') {
    panelStreamingText = '';
    panelIsStreaming = true;
    panelResponses.push({ question: msg.question || 'Answer', html: '', raw: '', sourceStamp: msg.sourceStamp || '' });
    panelCurrentIdx = panelResponses.length - 1;
    syncTeleprompterContent('', {
      question: msg.question || 'Answer',
      resetScroll: true,
      status: 'Waiting for the answer...'
    });

    if (teleprompterOpen) {
      renderTeleprompterText(true);
    } else {
      openAIPanel();
      renderPanelContent();
    }

  } else if (msg.type === 'stream-text') {
    if (typeof msg.delta === 'string') {
      panelStreamingText += msg.delta;
    } else {
      panelStreamingText = msg.text || '';
    }
    if (panelResponses[panelCurrentIdx]) {
      panelResponses[panelCurrentIdx].raw = panelStreamingText;
      if (msg.sourceStamp) panelResponses[panelCurrentIdx].sourceStamp = msg.sourceStamp;
    }
    syncTeleprompterContent(panelStreamingText, {
      status: teleprompterPaused ? 'Auto-scroll paused' : 'Following the live answer...'
    });
    scheduleStreamingPanelRender();

  } else if (msg.type === 'finalize-response') {
    panelIsStreaming = false;
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = null;
    }
    if (panelResponses[panelCurrentIdx]) {
      panelResponses[panelCurrentIdx].html = renderMarkdown(panelStreamingText);
      panelResponses[panelCurrentIdx].raw = panelStreamingText;
    }
    syncTeleprompterContent(panelStreamingText, {
      status: teleprompterPaused ? 'Auto-scroll paused' : 'Ready to read'
    });
    renderStreamingAnswerBody();

  } else if (msg.type === 'analyzing-screen') {
    panelStreamingText = '';
    panelIsStreaming = true;
    panelResponses.push({ question: 'Screen Analysis', html: '', raw: '', sourceStamp: '' });
    panelCurrentIdx = panelResponses.length - 1;
    if (msg.sourceStamp && panelResponses[panelCurrentIdx]) {
      panelResponses[panelCurrentIdx].sourceStamp = msg.sourceStamp;
    }
    syncTeleprompterContent('', {
      question: 'Screen Analysis',
      resetScroll: true,
      status: 'Analyzing the screen...'
    });
    if (!teleprompterOpen) {
      openAIPanel();
      document.getElementById('aiPanelContent').innerHTML = '<div class="ai-loading-state"><div class="ai-spinner-small"></div>Analyzing screen...</div>';
    }

  } else if (msg.type === 'update-current-question') {
    if (panelResponses[panelCurrentIdx] && msg.question) {
      panelResponses[panelCurrentIdx].question = msg.question;
      syncTeleprompterContent(panelIsStreaming ? panelStreamingText : (panelResponses[panelCurrentIdx].raw || ''), {
        question: msg.question
      });
      renderPanelContent();
    }

  } else if (msg.type === 'no-question') {
    panelIsStreaming = false;
    const fallbackText = 'No clear interview question was detected on the screen.';
    if (panelResponses[panelCurrentIdx]) {
      panelResponses[panelCurrentIdx].question = 'Screen Analysis';
      panelResponses[panelCurrentIdx].raw = fallbackText;
      panelResponses[panelCurrentIdx].html = renderMarkdown(fallbackText);
    }
    panelStreamingText = fallbackText;
    syncTeleprompterContent(fallbackText, {
      question: 'Screen Analysis',
      status: 'No question detected'
    });
    renderPanelContent();

  } else if (msg.type === 'error') {
    panelIsStreaming = false;
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = null;
    }
    syncTeleprompterContent(`Error: ${msg.text}`, {
      status: 'Something went wrong'
    });
    if (!teleprompterOpen) {
      openAIPanel();
      document.getElementById('aiPanelContent').innerHTML = `<p style="color:#f87171;">${esc(msg.text)}</p>`;
    } else {
      renderTeleprompterText();
    }
  } else if (msg.type === 'close-panel') {
    if (aiPanelOpen) closeAIPanel();
    if (teleprompterOpen) closeTeleprompter();
  }
}

// ── Keyboard shortcuts ───────────────
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (aiPanelOpen) closeAIPanel();
    if (transcriptBoxOpen) closeTranscriptBox();
    if (teleprompterOpen) closeTeleprompter();
  }
});

function renderPanelContent() {
  const contentEl = document.getElementById('aiPanelContent');
  const titleEl = document.getElementById('aiPanelTitle');
  if (panelCurrentIdx < 0 || panelResponses.length === 0) {
    contentEl.innerHTML = '<div class="ai-loading-state">No answers yet.</div>';
    titleEl.textContent = 'AI Response';
  } else {
    const r = panelResponses[panelCurrentIdx];
      titleEl.textContent = 'Interview Details';
      const answerHtml = panelIsStreaming
        ? renderStreamingPreview(panelStreamingText)
        : (r.html || renderMarkdown(panelStreamingText));
      const qText = r.question || 'Extracted context or general inquiry';
      const sourceStampHtml = r.sourceStamp
        ? `<div style="margin-top:10px;display:inline-flex;align-items:center;padding:5px 10px;border-radius:999px;background:rgba(125,211,252,0.08);border:1px solid rgba(125,211,252,0.18);color:#93c5fd;font-size:11px;font-weight:600;">${esc(r.sourceStamp)}</div>`
        : '';

      contentEl.innerHTML = `
      <div class="qa-container">
        <div class="qa-question-card">
          <div class="qa-q-header">
            <div class="qa-q-icon">💬</div>
            <span class="qa-q-label">QUESTION</span>
          </div>
          <div class="qa-q-text">${esc(qText)}</div>
          ${sourceStampHtml}
          <button class="qa-copy-btn" onclick="copyFullAnswer()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-right:6px"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Copy Answer
          </button>
        </div>
        <div class="qa-answer-card" id="currentAnswerBody">
          ${answerHtml}
        </div>
      </div>
    `;
  }
  updatePanelNav();
}

function updatePanelNav() {
  const total = panelResponses.length;
  document.getElementById('panelPrevBtn').disabled = panelCurrentIdx <= 0;
  document.getElementById('panelNextBtn').disabled = panelCurrentIdx >= total - 1 || total === 0;
  document.getElementById('panelPageInfo').textContent = total > 0 ? `${panelCurrentIdx + 1}/${total}` : '0/0';
}

function navigatePanel(dir) {
  if (panelIsStreaming) return;
  panelCurrentIdx += dir;
  renderPanelContent();
}

function clearPanel() {
  panelResponses.length = 0;
  panelCurrentIdx = -1;
  panelStreamingText = '';
  panelIsStreaming = false;
  syncTeleprompterContent('', {
    question: 'Latest answer',
    resetScroll: true,
    status: 'Waiting for the next AI answer...'
  });
  renderPanelContent();
}

function openAIPanel() {
  if (aiPanelOpen) return;
  if (teleprompterOpen) closeTeleprompter(true);
  aiPanelOpen = true;
  const container = document.getElementById('aiPanelContainer');
  if (container) container.classList.add('visible');
  document.getElementById('btnAIPanel')?.classList.add('active');
  renderPanelContent();
  refreshExpandedLayout();
}

function openTranscriptBox() {
  if (transcriptBoxOpen) return;
  transcriptBoxOpen = true;
  const container = document.getElementById('transcriptBoxContainer');
  if (container) container.classList.add('visible');
  document.getElementById('btnTranscriptBox')?.classList.add('active');
  refreshExpandedLayout();
}

function toggleTranscriptBox() {
  if (transcriptBoxOpen) closeTranscriptBox();
  else openTranscriptBox();
}

function clearTranscriptBox() {
  const box = document.getElementById('transcriptBoxContent');
  if (box) box.innerHTML = '';
}

function toggleTopBar() {
  topBarOpen = !topBarOpen;
  const bar = document.getElementById('interviewBar');
  if (bar) {
    bar.style.display = topBarOpen ? 'flex' : 'none';
  }
}

function closeAIPanel(preserveExpanded = false) {
  aiPanelOpen = false;
  const container = document.getElementById('aiPanelContainer');
  if (container) container.classList.remove('visible');
  document.getElementById('btnAIPanel')?.classList.remove('active');
  if (!preserveExpanded) {
    refreshExpandedLayout();
  }

  if (!preserveExpanded && !topBarOpen && !transcriptBoxOpen && !teleprompterOpen) {
    toggleTopBar();
  }
}

function openTeleprompter() {
  if (teleprompterOpen) return;
  if (aiPanelOpen) closeAIPanel(true);

  teleprompterOpen = true;
  teleprompterPaused = false;
  const container = document.getElementById('teleprompterContainer');
  if (container) container.classList.add('visible');
  document.getElementById('btnTeleprompter')?.classList.add('active');
  renderTeleprompterText();
  updateTeleprompterControls();
  refreshExpandedLayout();
  startTeleprompterLoop();

  if (!teleprompterRawText) {
    setTeleprompterStatus('Waiting for the next AI answer...');
  } else if (panelIsStreaming) {
    setTeleprompterStatus('Following the live answer...');
  } else {
    setTeleprompterStatus('Ready to read');
  }

  window.electronAPI.getSettings()
    .then(settings => {
      currentSettings = settings;
      const tip = document.getElementById('teleprompterTip');
      if (!tip) return;
      tip.textContent = settings.windowPosition === 'top-center'
        ? 'Keep the overlay near your webcam for the most natural eye-line.'
        : 'Tip: top-center placement usually looks most natural on camera.';
    })
    .catch(() => {});
}

function closeTeleprompter(preserveExpanded = false) {
  teleprompterOpen = false;
  teleprompterPaused = false;
  const container = document.getElementById('teleprompterContainer');
  if (container) container.classList.remove('visible');
  document.getElementById('btnTeleprompter')?.classList.remove('active');
  updateTeleprompterControls();
  stopTeleprompterLoop();

  if (!preserveExpanded) {
    refreshExpandedLayout();
  }

  if (!preserveExpanded && !topBarOpen && !aiPanelOpen && !transcriptBoxOpen) {
    toggleTopBar();
  }
}

function toggleTeleprompter() {
  if (teleprompterOpen) closeTeleprompter();
  else openTeleprompter();
}

function toggleTeleprompterPause() {
  teleprompterPaused = !teleprompterPaused;
  teleprompterLastTick = 0;
  updateTeleprompterControls();

  if (!teleprompterRawText) {
    setTeleprompterStatus('Waiting for the next AI answer...');
  } else if (teleprompterPaused) {
    setTeleprompterStatus('Auto-scroll paused');
  } else if (panelIsStreaming) {
    setTeleprompterStatus('Following the live answer...');
  } else {
    setTeleprompterStatus('Ready to read');
  }
}

function adjustTeleprompterSpeed(delta) {
  teleprompterSpeed = Math.max(10, Math.min(72, teleprompterSpeed + delta));
  teleprompterLastTick = 0;
  updateTeleprompterControls();
}

function adjustTeleprompterFont(delta) {
  teleprompterFontSize = Math.max(22, Math.min(40, teleprompterFontSize + delta));
  updateTeleprompterControls();
}

function closeTranscriptBox() {
  transcriptBoxOpen = false;
  const container = document.getElementById('transcriptBoxContainer');
  if (container) container.classList.remove('visible');
  document.getElementById('btnTranscriptBox')?.classList.remove('active');
  refreshExpandedLayout();
  if (!topBarOpen && !aiPanelOpen && !teleprompterOpen) {
    toggleTopBar();
  }
}

// ── Exports ──────────────────────────────────────────────────────────────
window.openSettings = openSettings;
window.closeApp = closeApp;
window.collapseApp = collapseApp;
window.switchTab = switchTab;
window.verifyApiKey = verifyApiKey;
window.onApiKeyInput = onApiKeyInput;
window.startSession = startSession;
window.stopSession = stopSession;
window.triggerAIAnswer = triggerAIAnswer;
window.triggerAnalyzeScreen = triggerAnalyzeScreen;
window.toggleMic = toggleMic;
window.toggleAutoAI = toggleAutoAI;
window.toggleAIPanel = toggleAIPanel;
window.expandApp = expandApp;
window.toggleClickThrough = toggleClickThrough;
window.toggleLayout = toggleLayout;
window.toggleTopBar = toggleTopBar;
window.updatePanelOpacity = updatePanelOpacity;
window.navigatePanel = navigatePanel;
window.clearPanel = clearPanel;
window.openAIPanel = openAIPanel;
window.closeAIPanel = closeAIPanel;
window.openTranscriptBox = openTranscriptBox;
window.closeTranscriptBox = closeTranscriptBox;
window.toggleTranscriptBox = toggleTranscriptBox;
window.clearTranscriptBox = clearTranscriptBox;
window.toggleTeleprompter = toggleTeleprompter;
window.openTeleprompter = openTeleprompter;
window.closeTeleprompter = closeTeleprompter;
window.toggleTeleprompterPause = toggleTeleprompterPause;
window.adjustTeleprompterSpeed = adjustTeleprompterSpeed;
window.adjustTeleprompterFont = adjustTeleprompterFont;
window.resetTeleprompterScroll = resetTeleprompterScroll;
window.exportSession = exportSession;
window.exportCurrentSession = exportCurrentSession;

// ── Auto-Resize Logic ──────────────────────────────────────────────────────
// ── Auto-Resize Logic ──────────────────────────────────────────────────────
// The ResizeObserver auto-fits the window to content height.
// BUT if the user manually drags the window edge, we must NOT fight them —
// so we pause auto-resize while (and shortly after) the user is resizing.

let resizeDebounceTimer = null;
let userIsResizing = false;          // true while user is dragging a window edge
let userResizeCooldown = null;       // keeps the flag true for 3s after drag ends

function computeInterviewHeight() {
  const bar = document.getElementById('interviewBar');
  if (!bar) return 86;
  let total = 0;
  for (const child of bar.children) {
    if (child.offsetParent !== null) {          // only visible nodes
      total += child.getBoundingClientRect().height;
    }
  }
  const gap = 5 * Math.max(0, bar.children.length - 1);
  return Math.ceil(total) + gap + 10;           // +10px breathing room
}

const resizeObserver = new ResizeObserver(() => {
  if (appMode !== 'interview') return;
  if (userIsResizing) return;                   // ← don't fight the user
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(() => {
    if (userIsResizing) return;                 // double-check after debounce
    const minWidth = currentLayout === 'portrait' ? 420 : 520;
    const width    = Math.max(document.body.scrollWidth, minWidth);
    const height   = computeInterviewHeight();
    window.electronAPI.updateOverlayBounds({ width, height });
  }, 60);
});

resizeObserver.observe(document.body);

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  debugToast('Renderer Ready');
  init();
});
