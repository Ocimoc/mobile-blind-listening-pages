"use strict";

const DEMO_MODE = /(?:\?|&)demo=1(?:&|$)/.test(window.location?.search || "");
const STORE_KEY = DEMO_MODE ? "english-blind-listening-demo-v1" : "english-blind-listening-v1";
const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
const MAX_PACK_BYTES = 2 * 1024 * 1024;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const VARIATION_KEYS = new Set(["form_syntax", "semantic_relation", "communicative_function", "event_context"]);
const BROWSER_DEFAULT_VOICE = "browser-default-en-US";
const $ = (id) => document.getElementById(id);
const synth = window.speechSynthesis;
let storageProblem = null;
let storageReadBlocked = false;
let db = loadStore();
let voices = [];
let allowRemoteVoice = false;
let spokenToken = 0;
let currentView = "train";
let feedbackTimer = null;
const COPY_LIMIT = 60000;
const DEMO_PACK = {
  schema_version: 1, pack_id: "DEMO-INTERACTION-20261011", evidence_scope: "operation_test_only",
  items: [
    ["lamp", "Word", "The lamp is on.", "台灯"],
    ["turn on", "Chunk", "Please turn on the fan.", "打开；开启"],
    ["borrow", "Word", "Can I borrow this book?", "借入"],
    ["in front of", "Chunk", "The box is in front of the door.", "在……前面"],
    ["arrive", "Word", "We will arrive at noon.", "到达"]
  ].map(([target, kind, sentence, meaning], index) => ({
    id: `DEMO-ITEM-${index + 1}`, kind, target, locked_meaning_or_function: meaning,
    training_focus: "演示手机交互", session_goal: "试用页面按钮", use_anchor: "虚构日常句",
    anchor_id: `DEMO-ANCHOR-${index + 1}`, max_observations: 1,
    feedback: { spelling: target, meaning },
    candidates: [{ id: `DEMO-SENTENCE-${index + 1}`, text: sentence, content_role: "initial",
      variation_dimensions: [], anchor_id: `DEMO-ANCHOR-${index + 1}`, work_reviewed: true }]
  }))
};

function now() { return new Date().toISOString(); }
function emptyStore() { return { version: 2, activeSessionId: null, sessions: {}, seenCandidateIds: [], acknowledgedRecordIds: [], pendingExports: {}, voice: null, allowRemoteVoice: false }; }
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function localDate(instant) {
  const date = new Date(instant);
  const year = date.getFullYear();
  return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function migrateStore(state) {
  if (state.version !== 1) return state;
  const sessions = {};
  for (const [packId, session] of Object.entries(state.sessions)) {
    const sessionId = `legacy-session-${encodeURIComponent(packId)}`;
    session.sessionId = sessionId;
    session.mode = "review"; // Older records cannot prove whether this was a first exposure.
    session.progress.attempts.forEach((attempt, index) => {
      attempt.recordId ||= `legacy-record-${encodeURIComponent(packId)}-${index + 1}`;
      attempt.localDate ||= localDate(attempt.recordedAt || session.progress.createdAt);
    });
    sessions[sessionId] = session;
  }
  return { version: 2, activeSessionId: state.activePackId === null ? null : `legacy-session-${encodeURIComponent(state.activePackId)}`,
    sessions, seenCandidateIds: state.seenCandidateIds, acknowledgedRecordIds: [], pendingExports: {}, voice: state.voice || null, allowRemoteVoice: false };
}
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    const state = validateBackupState(migrateStore(JSON.parse(raw)));
    if (state.allowRemoteVoice === undefined) state.allowRemoteVoice = false;
    return state;
  } catch (_) {
    storageReadBlocked = true;
    storageProblem = "本机旧记录无法安全读取。网页已停止写入，避免覆盖原数据；请先导出原始数据或联系处理。";
  }
  return emptyStore();
}
function showStorageProblem() {
  const warning = $("storageWarning");
  warning.hidden = !storageProblem;
  warning.textContent = storageProblem || "";
  $("exportDamagedRaw").hidden = !storageReadBlocked;
}
function saveStore() {
  if (storageReadBlocked) { showStorageProblem(); return false; }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
    storageProblem = null;
    showStorageProblem();
    return true;
  } catch (_) {
    storageProblem = "本机保存失败。当前内容可能只在页面内存中；请立即导出完整备份并确认文件已保存，关闭或刷新页面前处理。";
    showStorageProblem();
    return false;
  }
}
function commitChange(change) {
  const previous = structuredClone(db);
  change();
  const session = activeSession();
  if (session) session.progress.updatedAt = now();
  if (!saveStore()) { db = previous; render(); return false; }
  render();
  return true;
}
function switchView(view) {
  if (!["train", "materials", "more"].includes(view)) return;
  cancelAutomaticMeaning();
  if (view !== "train" && currentView === "train") interruptAudio();
  currentView = view;
  for (const name of ["train", "materials", "more"]) {
    $(`${name}View`).hidden = name !== view;
  }
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
    button.setAttribute("aria-current", button.dataset.view === view ? "page" : "false");
  });
  window.scrollTo?.(0, 0);
  scheduleAutomaticMeaning();
}
function activeSession() { return db.sessions[db.activeSessionId] || null; }
function currentItem() {
  const session = activeSession();
  return session?.pack.items[session.progress.itemIndex] || null;
}
function currentCandidate() {
  const session = activeSession();
  const item = currentItem();
  return item?.candidates.find(c => c.id === session.progress.activeAttempt?.candidateId) || null;
}
function unique(values) { return [...new Set(values)]; }
function shuffled(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function phrasePresent(text, phrase) {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = phrase.trim().split(/\s+/).map(escape).join("\\s+");
  return new RegExp(`(^|[^A-Za-z])${body}(?=$|[^A-Za-z])`, "i").test(text);
}
function targetPresent(item, text) {
  if (item.kind !== "Frame") return phrasePresent(text, item.target);
  const parts = item.target.split("___");
  if (parts.length !== 2) return false;
  const prefix = parts[0].trim().toLowerCase();
  const suffix = parts[1].trim().toLowerCase();
  const sentence = text.trim().toLowerCase();
  return sentence.startsWith(prefix) && sentence.endsWith(suffix) && sentence.length > prefix.length + suffix.length;
}
function validatePack(pack) {
  if (!pack || pack.schema_version !== 1 || typeof pack.pack_id !== "string" || !Array.isArray(pack.items) || !pack.items.length || pack.items.length > 100) {
    throw new Error("训练包缺少版本、编号或 item 列表。");
  }
  if (!pack.pack_id.trim() || UNSAFE_KEYS.has(pack.pack_id)) throw new Error("训练包编号无效。");
  const itemIds = new Set();
  const candidateIds = new Set();
  const required = ["id", "kind", "target", "locked_meaning_or_function", "training_focus", "session_goal", "use_anchor", "anchor_id"];
  for (const item of pack.items) {
    if (required.some(key => typeof item[key] !== "string" || !item[key].trim())) throw new Error("训练包有 item 缺少必需字段。");
    if (!["Word", "Chunk", "Frame"].includes(item.kind) || itemIds.has(item.id) || UNSAFE_KEYS.has(item.id)) throw new Error("item 类型或编号无效。");
    if (!Array.isArray(item.candidates) || item.candidates.length < 1 || item.candidates.length > 100) throw new Error("item 候选句数量无效。");
    if (!item.feedback || typeof item.feedback.spelling !== "string" || typeof item.feedback.meaning !== "string") throw new Error("item 缺少必要反馈材料。");
    if (item.feedback.details !== undefined && typeof item.feedback.details !== "string") throw new Error("反馈说明格式无效。");
    if (item.task_type !== undefined && !["word", "chunk", "in_sentence_recognition", "sentence_understanding"].includes(item.task_type)) throw new Error("训练任务类型无效。");
    if (!Number.isInteger(item.max_observations) || item.max_observations < 1 || item.max_observations > 3) throw new Error("局部观察上限无效。");
    itemIds.add(item.id);
  }
  for (const item of pack.items) {
    for (const candidate of item.candidates) {
      if (typeof candidate.id !== "string" || candidateIds.has(candidate.id) || typeof candidate.text !== "string") throw new Error("候选句编号或文本无效。");
      if (!candidate.text.trim() || /[\r\n]/.test(candidate.text) || /[.!?]\s+\S/.test(candidate.text) || !/[.!?]$/.test(candidate.text.trim())) {
        throw new Error(`候选句 ${candidate.id} 必须是单条完整英文句子。`);
      }
      if (!targetPresent(item, candidate.text)) throw new Error(`候选句 ${candidate.id} 缺少完整目标形式。`);
      if (candidate.anchor_id !== item.anchor_id || candidate.work_reviewed !== true) throw new Error(`候选句 ${candidate.id} 尚未确认用途边界。`);
      if (!Array.isArray(candidate.variation_dimensions) || candidate.variation_dimensions.some(v => !VARIATION_KEYS.has(v))) throw new Error("变化维度无效。");
      if (!["initial", "anchor", "low_load_fallback", "fallback", "form", "relation_context"].includes(candidate.content_role)) throw new Error("候选句角色无效。");
      for (const other of pack.items) {
        if (other.id !== item.id && other.kind !== "Frame" && phrasePresent(candidate.text, other.target)) {
          throw new Error(`候选句 ${candidate.id} 同时含另一训练目标。`);
        }
      }
      candidateIds.add(candidate.id);
    }
  }
  return pack;
}
function hasPriorExposure(item, currentSessionId = null) {
  const current = currentSessionId ? db.sessions[currentSessionId] : null;
  const usedHere = new Set([
    ...(current?.progress.attempts || []).map(attempt => attempt.candidateId),
    ...(current?.progress.activeAttempt?.playCount > 0 ? [current.progress.activeAttempt.candidateId] : [])
  ]);
  if (item.candidates.some(candidate => db.seenCandidateIds.includes(candidate.id) && !usedHere.has(candidate.id))) return true;
  const candidateIds = new Set(item.candidates.map(candidate => candidate.id));
  const sentences = new Set(item.candidates.map(candidate => candidate.text.trim().toLowerCase()));
  return Object.values(db.sessions).some(previous => {
    if (previous.sessionId === currentSessionId) return false;
    return previous.pack.items.some(oldItem => {
      if (oldItem.target !== item.target && !oldItem.candidates.some(candidate =>
          candidateIds.has(candidate.id) || sentences.has(candidate.text.trim().toLowerCase()))) return false;
      return previous.progress.attempts.some(attempt => attempt.itemId === oldItem.id && attempt.playCount > 0) ||
        (previous.progress.activeAttempt?.itemId === oldItem.id && previous.progress.activeAttempt.playCount > 0);
    });
  });
}
function makeSession(pack) {
  const candidateOrder = {};
  const priorTargetByItem = {};
  for (const item of pack.items) {
    const initial = item.candidates.filter(c => c.content_role === "initial" || c.content_role === "anchor").map(c => c.id);
    const rest = item.candidates.filter(c => !initial.includes(c.id)).map(c => c.id);
    candidateOrder[item.id] = [...shuffled(initial), ...shuffled(rest)];
    priorTargetByItem[item.id] = hasPriorExposure(item);
  }
  return {
    sessionId: newId(),
    mode: Object.values(priorTargetByItem).some(Boolean) ? "review" : "first_exposure",
    priorTargetByItem,
    pack,
    progress: {
      createdAt: now(), updatedAt: now(), itemIndex: 0, stage: "ready", paused: false,
      activeAttempt: null, attempts: [], itemOutcomes: {}, feedbackEvents: [], candidateOrder
    }
  };
}
function setActivePack(pack) {
  validatePack(pack);
  if (DEMO_MODE && pack.evidence_scope === "session_observation") {
    throw new Error("演示页面不能导入正式训练包。请打开不带 ?demo=1 的正式网址。");
  }
  const existing = Object.values(db.sessions).filter(session => session.pack.pack_id === pack.pack_id);
  if (existing.some(session => JSON.stringify(session.pack) !== JSON.stringify(pack))) {
    throw new Error("这个训练包编号已有不同内容。请让 Work 为修订包使用新编号，避免混淆旧记录。");
  }
  const oldCandidates = new Map(Object.values(db.sessions).flatMap(session => session.pack.items.flatMap(item => item.candidates.map(candidate => [candidate.id, candidate.text]))));
  if (pack.items.some(item => item.candidates.some(candidate => oldCandidates.has(candidate.id) && oldCandidates.get(candidate.id) !== candidate.text))) {
    throw new Error("候选句编号已被其他内容使用。请让 Work 为新句换编号；旧记录没有改变。");
  }
  const previous = structuredClone(db);
  const session = existing.at(-1) || makeSession(pack);
  db.sessions[session.sessionId] = session;
  db.activeSessionId = session.sessionId;
  if (!saveStore()) {
    db = previous;
    throw new Error("本机保存失败，训练包未载入；旧记录没有被覆盖。请查看页面上的存储错误。");
  }
  render();
  switchView("train");
}
function startNewSession() {
  const current = activeSession();
  if (!current) return;
  interruptAudio();
  const previous = structuredClone(db);
  const session = makeSession(current.pack);
  db.sessions[session.sessionId] = session;
  db.activeSessionId = session.sessionId;
  if (!saveStore()) {
    db = previous;
    $("dataStatus").textContent = "保存失败，未开启新一轮。旧进度仍在。";
    return;
  }
  render();
  $("dataStatus").textContent = `已开始独立的新一轮（${session.mode === "review" ? "复习" : "尚无既往听力记录"}）。旧轮次及记录仍保留。`;
  switchView("train");
}
function updateProgress() {
  const session = activeSession();
  if (session) session.progress.updatedAt = now();
  const saved = saveStore();
  render();
  return saved;
}
function selectCandidate(followup) {
  const session = activeSession();
  const item = currentItem();
  if (!session || !item) return null;
  const previous = structuredClone(db);
  const progress = session.progress;
  if (hasPriorExposure(item, session.sessionId)) {
    session.priorTargetByItem ||= {};
    session.priorTargetByItem[item.id] = true;
    session.mode = "review";
  }
  const usedHere = progress.attempts.filter(a => a.itemId === item.id).map(a => a.candidateId);
  const ids = progress.candidateOrder[item.id];
  const available = ids.filter(id => !usedHere.includes(id));
  const preferred = followup ? available.filter(id => ["low_load_fallback", "fallback"].includes(item.candidates.find(c => c.id === id).content_role)) : available.filter(id => {
    const role = item.candidates.find(c => c.id === id).content_role;
    return role === "initial" || role === "anchor";
  });
  const id = preferred.find(candidateId => !db.seenCandidateIds.includes(candidateId)) ||
    (session.priorTargetByItem?.[item.id] ? preferred[0] : null);
  if (!id) return null;
  progress.activeAttempt = {
    itemId: item.id, candidateId: id, selectedAt: now(), playCount: 0,
    audioCompleted: false, partialAudio: false, textShown: false,
    supportBefore: currentSupport(item.id), overallStatus: null, difficultyType: null, note: ""
  };
  progress.stage = "ready";
  if (!updateProgress()) { db = previous; render(); return null; }
  return item.candidates.find(c => c.id === id);
}
function currentSupport(itemId) {
  const events = activeSession().progress.feedbackEvents.filter(e => e.itemId === itemId);
  return unique(events.flatMap(e => e.supportUsed));
}
function voiceKey(voice) { return `${voice.name}|${voice.lang}`; }
function refreshVoices() {
  if (!synth) {
    $("voiceStatus").textContent = "这个浏览器没有 speechSynthesis，无法播放。请换支持语音合成的浏览器。";
    $("previewVoice").disabled = true;
    $("approveVoice").disabled = true;
    return;
  }
  const englishVoices = synth.getVoices().filter(v => /^en([-_]|$)/i.test(v.lang));
  voices = englishVoices.filter(v => v.localService === true || allowRemoteVoice);
  const select = $("voiceSelect");
  const old = select.value || db.voice?.key;
  select.replaceChildren();
  voices.forEach(v => {
    const option = document.createElement("option");
    option.value = voiceKey(v);
    option.textContent = `${v.name} · ${v.lang} · ${v.localService === true ? "本机" : "在线或来源未知"}`;
    select.append(option);
  });
  if (allowRemoteVoice) {
    const browserDefault = document.createElement("option");
    browserDefault.value = BROWSER_DEFAULT_VOICE;
    browserDefault.textContent = "浏览器默认声音 · 来源未知（en-US）";
    select.append(browserDefault);
  }
  const preferred = voices.find(v => v.localService === true) || voices[0];
  if (old && ((allowRemoteVoice && old === BROWSER_DEFAULT_VOICE) || voices.some(v => voiceKey(v) === old))) select.value = old;
  else if (preferred) select.value = voiceKey(preferred);
  $("voiceStatus").textContent = voices.length
    ? `可选 ${voices.length} 个英语声音。请试听并判断是否清楚。`
    : "没有检测到本机英语声音。若要尝试在线或来源未知的声音，请先勾选下方选项。";
  $("previewVoice").disabled = !select.value;
  $("approveVoice").disabled = !select.value || !(db.voice?.approved && db.voice.key === select.value);
  render();
}
function selectedVoice() {
  if (allowRemoteVoice && $("voiceSelect").value === BROWSER_DEFAULT_VOICE) return { browserDefault: true, lang: "en-US" };
  return voices.find(v => voiceKey(v) === $("voiceSelect").value) || null;
}
function speak(text, callbacks = {}) {
  if (!synth || !selectedVoice()) { $("playStatus").textContent = "没有可用英语声音。"; return false; }
  spokenToken += 1;
  const token = spokenToken;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = selectedVoice();
  if (!voice.browserDefault) utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = 0.94;
  utterance.onend = () => { if (token === spokenToken) callbacks.onend?.(); };
  utterance.onerror = event => { if (token === spokenToken) callbacks.onerror?.(event); };
  synth.speak(utterance);
  return true;
}
function interruptAudio() {
  spokenToken += 1;
  synth?.cancel();
  const attempt = activeSession()?.progress.activeAttempt;
  const progress = activeSession()?.progress;
  if (progress?.stage === "playing" && attempt) {
    attempt.partialAudio = true;
    attempt.audioCompleted = false;
    progress.stage = "ready";
    updateProgress();
  }
}
function playSentence() {
  const session = activeSession();
  if (!session || session.progress.paused || !["ready", "rating"].includes(session.progress.stage)) return;
  if (!db.voice?.approved || db.voice.key !== $("voiceSelect").value) return;
  $("trainNotice").hidden = true;
  if (!session.progress.activeAttempt && !selectCandidate(false)) { if (!storageProblem) blockCurrentItem("no_unseen_candidate"); return; }
  const beforePlay = structuredClone(db);
  const attempt = session.progress.activeAttempt;
  const candidate = currentCandidate();
  if (!candidate || !targetPresent(currentItem(), candidate.text) || candidate.anchor_id !== currentItem().anchor_id) {
    blockCurrentItem("candidate_validation_failed"); return;
  }
  if (attempt.playCount === 0) {
    attempt.priorTargetExposure = hasPriorExposure(currentItem(), session.sessionId) || !!session.priorTargetByItem?.[currentItem().id];
    if (attempt.priorTargetExposure) {
      session.priorTargetByItem ||= {};
      session.priorTargetByItem[currentItem().id] = true;
      session.mode = "review";
    }
    attempt.reviewAtPlay = session.mode === "review";
  }
  attempt.playCount += 1;
  attempt.lastPlayAt = now();
  attempt.voicesUsed = unique([...(attempt.voicesUsed || (attempt.voice ? [attempt.voice] : [])), $("voiceSelect").value]);
  attempt.voice = $("voiceSelect").value;
  attempt.rate = 0.94;
  attempt.audioCompleted = false;
  session.progress.stage = "playing";
  db.seenCandidateIds = unique([...db.seenCandidateIds, candidate.id]);
  if (!updateProgress()) { db = beforePlay; render(); return; }
  const ok = speak(candidate.text, {
    onend: () => {
      attempt.audioCompleted = true;
      attempt.lastCompletedAt = now();
      session.progress.stage = "rating";
      updateProgress();
    },
    onerror: () => {
      attempt.partialAudio = true;
      session.progress.stage = "ready";
      updateProgress();
      $("playStatus").textContent = "朗读失败，请换一个英语声音后重试。";
    }
  });
  if (!ok) { session.progress.stage = "ready"; updateProgress(); }
}
function taskType(item) {
  return item.task_type || ({ Word: "word", Chunk: "chunk", Frame: "sentence_understanding" })[item.kind];
}
function cancelAutomaticMeaning() {
  if (feedbackTimer !== null) clearTimeout(feedbackTimer);
  feedbackTimer = null;
}
function scheduleAutomaticMeaning() {
  cancelAutomaticMeaning();
  const session = activeSession();
  if (!session || currentView !== "train" || session.progress.stage !== "spelling" || session.progress.paused || document.hidden || $("optionalDiagnosis").open) return;
  feedbackTimer = setTimeout(() => {
    feedbackTimer = null;
    if (currentView === "train" && activeSession()?.progress.stage === "spelling" && !activeSession().progress.paused && !document.hidden && !$("optionalDiagnosis").open) revealMeaning();
  }, 3000);
}
function chooseRating(value) {
  const session = activeSession();
  const attempt = session?.progress.activeAttempt;
  if (!attempt || !attempt.audioCompleted || !["rating", "correcting"].includes(session.progress.stage)) return;
  if (!["direct", "slow", "not_understood", "target_sound", "target_meaning", "integration"].includes(value)) return;
  const status = value === "direct" && attempt.playCount > 1 ? "slow" : ["direct", "slow"].includes(value) ? value : "not_understood";
  const difficulty = ["target_sound", "target_meaning", "integration"].includes(value) ? value : null;
  cancelAutomaticMeaning();
  if (!commitChange(() => {
    if (!attempt.firstJudgment) attempt.firstJudgment = { understanding: status, difficulty, at: now() };
    else {
      attempt.judgmentCorrected = true;
      if (attempt.textShown || attempt.answerShown) attempt.promptedCorrection = true;
    }
    attempt.overallStatus = status;
    attempt.difficultyType = difficulty;
    attempt.judgedAt = now();
    attempt.note = $("quickNote").value.trim() || attempt.note || "";
    if (status === "not_understood") {
      attempt.textShown = true;
      attempt.textShownAfterJudgment = true;
      session.progress.stage = attempt.answerShown ? "answer" : "spelling";
    } else {
      session.progress.stage = attempt.answerShown ? "answer" : "judged";
    }
  })) return;
  scheduleAutomaticMeaning();
  if (status === "not_understood" && session.progress.stage === "spelling" && ["word", "chunk", "in_sentence_recognition"].includes(taskType(currentItem()))) playTarget();
}
function revealSpelling() {
  const session = activeSession();
  const attempt = session?.progress.activeAttempt;
  if (!attempt || !attempt.audioCompleted || !["rating", "judged"].includes(session.progress.stage)) return;
  if (!commitChange(() => {
    if (!attempt.firstJudgment) {
      attempt.firstJudgment = { understanding: "not_understood", difficulty: null, at: now(), source: "answer_before_judgment" };
      attempt.overallStatus = "not_understood";
      attempt.difficultyType = null;
      attempt.textShownBeforeJudgment = true;
      attempt.judgedAt = now();
      attempt.note = $("quickNote").value.trim();
    }
    attempt.textShown = true;
    session.progress.stage = "spelling";
  })) return;
  scheduleAutomaticMeaning();
  if (["word", "chunk", "in_sentence_recognition"].includes(taskType(currentItem()))) playTarget();
}
function setWrittenCheck(value) {
  const session = activeSession();
  const attempt = session?.progress.activeAttempt;
  if (!attempt || session.progress.stage !== "spelling" || !["recognized", "not_recognized"].includes(value)) return;
  if (!["word", "chunk", "in_sentence_recognition"].includes(taskType(currentItem()))) return;
  commitChange(() => { attempt.writtenCheck = value; });
}
function setDifficulty(value) {
  const session = activeSession();
  const attempt = session?.progress.activeAttempt;
  if (!attempt || session.progress.stage !== "spelling" || attempt.overallStatus !== "not_understood") return;
  if (!["target_sound", "target_meaning", "integration"].includes(value)) return;
  if (value === "integration" && taskType(currentItem()) !== "sentence_understanding") return;
  commitChange(() => { attempt.difficultyType = value; });
}
function revealMeaning() {
  const session = activeSession();
  const attempt = session?.progress.activeAttempt;
  if (!attempt || session.progress.stage !== "spelling") return;
  cancelAutomaticMeaning();
  commitChange(() => {
    attempt.answerShown = true;
    attempt.answerShownAt = now();
    session.progress.stage = "answer";
  });
}
function startCorrection() {
  const session = activeSession();
  if (!session?.progress.activeAttempt || !["judged", "spelling", "answer"].includes(session.progress.stage)) return;
  cancelAutomaticMeaning();
  commitChange(() => { session.progress.stage = "correcting"; });
}
function skipCurrent() {
  const session = activeSession();
  if (!session || session.progress.paused || !["ready", "rating"].includes(session.progress.stage)) return;
  if (!session.progress.activeAttempt && !selectCandidate(false)) { if (!storageProblem) blockCurrentItem("no_unseen_candidate"); return; }
  const attempt = session.progress.activeAttempt;
  if (attempt.playCount > 0) {
    if (!commitChange(() => {
      attempt.firstJudgment = { understanding: "not_understood", difficulty: null, at: now(), source: "skip_after_attempt" };
      attempt.overallStatus = "not_understood";
      attempt.difficultyType = null;
      attempt.judgedAt = now();
      attempt.textShown = true;
      session.progress.stage = "spelling";
    })) return;
    scheduleAutomaticMeaning();
    if (["word", "chunk", "in_sentence_recognition"].includes(taskType(currentItem()))) playTarget();
  } else {
    if (!commitChange(() => {
      attempt.overallStatus = "skipped";
      attempt.skipReason = "not_attempted";
      attempt.judgedAt = now();
    })) return;
    finishAttempt();
  }
}
function supportForAttempt(attempt) {
  return unique([
    ...attempt.supportBefore,
    ...(attempt.playCount > 1 ? ["replay"] : []),
    ...(attempt.textShown ? ["sentence_text"] : []),
    ...(attempt.answerShown ? ["meaning"] : []),
    ...(attempt.targetAudioPlayed ? ["target_audio"] : [])
  ]);
}
function finishAttempt() {
  const session = activeSession();
  if (!session) return;
  const progress = session.progress;
  const attempt = progress.activeAttempt;
  if (!attempt?.overallStatus || !["judged", "answer", "spelling", "ready", "feedback", "continue"].includes(progress.stage)) return;
  if (attempt.overallStatus === "not_understood" && progress.stage === "spelling" && !attempt.answerShown) return;
  const item = currentItem();
  const count = progress.attempts.filter(a => a.itemId === item.id).length + 1;
  const followup = attempt.overallStatus === "not_understood" && count < item.max_observations;
  if (!commitChange(() => {
    attempt.recordedAt = now();
    attempt.localDate = localDate(attempt.recordedAt);
    attempt.recordId ||= newId();
    attempt.supportUsed = supportForAttempt(attempt);
    progress.attempts.push(structuredClone(attempt));
    progress.activeAttempt = null;
    if (attempt.answerShown) progress.feedbackEvents.push({ itemId: item.id, afterCandidateId: attempt.candidateId, at: now(), supportUsed: unique(["spelling", "meaning", ...(attempt.targetAudioPlayed ? ["target_audio"] : [])]), reason: attempt.difficultyType });
    if (!followup) {
      progress.itemOutcomes[item.id] = { sessionGoalResult: attempt.overallStatus === "skipped" ? "not_observed" : "observed", localExitReason: attempt.overallStatus === "skipped" ? "not_attempted_skip" : "local_observation_recorded", at: now() };
      progress.itemIndex += 1;
      progress.stage = progress.itemIndex >= session.pack.items.length ? "complete" : "ready";
    } else progress.stage = "continue";
  })) return;
  $("quickNote").value = "";
  $("optionalDiagnosis").open = false;
  if (followup) prepareFollowup();
}
function playNext() {
  const session = activeSession();
  const progress = session?.progress;
  if (!progress || progress.paused || !["judged", "answer", "feedback", "continue"].includes(progress.stage)) return;
  const oldCount = progress.attempts.length;
  cancelAutomaticMeaning();
  finishAttempt();
  const next = activeSession()?.progress;
  if (next?.attempts.length === oldCount + 1 && next.stage === "ready") playSentence();
}
function playTarget() {
  const item = currentItem();
  const session = activeSession();
  if (!item || !["spelling", "answer", "feedback"].includes(session.progress.stage)) return;
  speak(item.feedback.spelling, {
    onend: () => {
      const attempt = session.progress.activeAttempt;
      if (attempt) commitChange(() => { attempt.targetAudioPlayed = true; });
      else {
        const event = [...session.progress.feedbackEvents].reverse().find(e => e.itemId === item.id);
        if (event) { event.supportUsed = unique([...event.supportUsed, "target_audio"]); updateProgress(); }
      }
    },
    onerror: () => { $("playStatus").textContent = "目标发音未完成，请重试。"; }
  });
}
function prepareFollowup() {
  const session = activeSession();
  if (!session || !["feedback", "continue"].includes(session.progress.stage)) return;
  if (!selectCandidate(true)) { if (!storageProblem) blockCurrentItem("no_unseen_fallback"); return; }
  $("revealedText").textContent = "";
  render();
}
function blockCurrentItem(reason) {
  const session = activeSession();
  const item = currentItem();
  if (!session || !item) return;
  commitChange(() => {
    session.progress.itemOutcomes[item.id] = { sessionGoalResult: "not_observed", localExitReason: reason, at: now() };
    session.progress.stage = "blocked";
  });
  $("playStatus").textContent = "没有合格的新句可继续。请导出记录，交给 Work 补充训练包。";
}
function togglePause() {
  const session = activeSession();
  if (!session) return;
  cancelAutomaticMeaning();
  if (!session.progress.paused) interruptAudio();
  if (commitChange(() => { session.progress.paused = !session.progress.paused; })) scheduleAutomaticMeaning();
}
function interpretedLayers(attempt) {
  const result = { target_sound_recognition: "uncertain", target_meaning_access: "uncertain", sentence_integration: "uncertain" };
  if (attempt.difficultyType === "target_sound") result.target_sound_recognition = "fail";
  if (attempt.difficultyType === "target_meaning") result.target_meaning_access = "fail";
  if (attempt.difficultyType === "integration") result.sentence_integration = "fail";
  return { values: result, basis: attempt.difficultyType ? "user_selected_specific_difficulty" : "insufficient_layer_specific_evidence" };
}
function exportSession(session) {
  const progress = session.progress;
  // A pack must explicitly opt into session observation; older pilot packs remain test-only.
  const operationTestOnly = DEMO_MODE || session.pack.evidence_scope !== "session_observation";
  const itemIds = session.pack.items.map(i => i.id);
  const pending = progress.activeAttempt;
  const attempts = progress.attempts.map((attempt, index) => {
    const item = session.pack.items.find(i => i.id === attempt.itemId);
    const candidate = item.candidates.find(c => c.id === attempt.candidateId);
    const priorExposure = attempt.priorTargetExposure ?? (session.mode === "review" || !!session.priorTargetByItem?.[item.id]);
    const reviewAtPlay = attempt.reviewAtPlay ?? (session.mode === "review");
    const exposureFlags = [
      ...(operationTestOnly ? ["prior_target_exposure"] : []),
      ...(reviewAtPlay ? ["review_session"] : []),
      ...(priorExposure ? ["prior_target_exposure"] : []),
      ...(!operationTestOnly && !reviewAtPlay && !priorExposure && attempt.playCount === 1 && !attempt.partialAudio && !attempt.textShownBeforeJudgment && !attempt.promptedCorrection && !attempt.supportBefore.length && !progress.attempts.slice(0, index).some(a => a.itemId === item.id) ? ["first_unprompted"] : []),
      ...(attempt.playCount > 1 ? ["replay_assisted"] : []),
      ...(attempt.partialAudio ? ["partial_audio_exposure"] : []),
      ...(attempt.textShown ? ["text_revealed"] : []),
      ...(attempt.textShownBeforeJudgment ? ["text_before_judgment"] : []),
      ...(attempt.answerShown ? ["answer_revealed"] : []),
      ...(attempt.judgmentCorrected ? ["judgment_corrected"] : []),
      ...(attempt.promptedCorrection ? ["corrected_after_prompt"] : []),
      ...(attempt.overallStatus === "skipped" ? ["not_attempted_skip"] : []),
      ...(attempt.supportBefore.some(s => ["spelling", "meaning", "target_audio"].includes(s)) ? ["post_feedback_immediate"] : [])
    ];
    return {
      record_id: attempt.recordId, session_id: session.sessionId, pack_id: session.pack.pack_id,
      local_date: attempt.localDate, order: index + 1, item_id: item.id, candidate_id: candidate.id,
      sentence: candidate.text, content_role: candidate.content_role,
      variation_dimensions: candidate.variation_dimensions,
      variation_detail: candidate.variation_detail,
      use_anchor: item.use_anchor, anchor_id: item.anchor_id, session_goal: item.session_goal,
      item_kind: item.kind, task_type: taskType(item), target: item.target,
      training_focus: item.training_focus, locked_meaning_or_function: item.locked_meaning_or_function,
      user_reported: { understanding: attempt.overallStatus, difficulty: attempt.difficultyType, first_judgment: attempt.firstJudgment || null, written_check: attempt.writtenCheck || "not_checked", note: attempt.note },
      app_observed: { play_count: attempt.playCount, replay_count: Math.max(0, attempt.playCount - 1), audio_completed: attempt.audioCompleted, partial_audio: attempt.partialAudio, sentence_text_shown: attempt.textShown, text_before_judgment: !!attempt.textShownBeforeJudgment, answer_shown: !!attempt.answerShown, judgment_corrected: !!attempt.judgmentCorrected, corrected_after_prompt: !!attempt.promptedCorrection, skip_reason: attempt.skipReason || null, support_used: attempt.supportUsed, exposure_flags: exposureFlags, voice: attempt.voice, voices_used: attempt.voicesUsed || (attempt.voice ? [attempt.voice] : []), rate: attempt.rate, selected_at: attempt.selectedAt, started_at: attempt.lastPlayAt, judged_at: attempt.judgedAt || null, recorded_at: attempt.recordedAt },
      interpretation: interpretedLayers(attempt)
    };
  });
  const heardSentences = attempts.filter(attempt => attempt.app_observed.play_count > 0).map(attempt => ({
    order: attempt.order, item_id: attempt.item_id, candidate_id: attempt.candidate_id,
    sentence: attempt.sentence, play_count: attempt.app_observed.play_count,
    audio_completed: attempt.app_observed.audio_completed,
    partial_audio: attempt.app_observed.partial_audio
  }));
  let pendingAttempt = null;
  if (pending) {
    const item = session.pack.items.find(i => i.id === pending.itemId);
    const candidate = item?.candidates.find(c => c.id === pending.candidateId);
    if (candidate) {
      pendingAttempt = {
        item_id: pending.itemId, candidate_id: pending.candidateId, sentence: candidate.text,
        content_role: candidate.content_role, variation_dimensions: candidate.variation_dimensions,
        variation_detail: candidate.variation_detail, use_anchor: item.use_anchor,
        item_kind: item.kind, task_type: taskType(item), target: item.target,
        play_count: pending.playCount, audio_completed: pending.audioCompleted,
        partial_audio: pending.partialAudio, sentence_text_shown: pending.textShown,
        text_before_judgment: !!pending.textShownBeforeJudgment,
        answer_shown: !!pending.answerShown, written_check: pending.writtenCheck || "not_checked",
        first_judgment: pending.firstJudgment || null,
        current_understanding: pending.overallStatus || null,
        current_difficulty: pending.difficultyType || null,
        note_draft: pending.note || null, difficulty_draft: pending.draftReason || null
      };
      if (pending.playCount > 0) {
        heardSentences.push({
          order: heardSentences.length + 1, item_id: item.id, candidate_id: candidate.id,
          sentence: candidate.text, play_count: pending.playCount,
          audio_completed: pending.audioCompleted, partial_audio: pending.partialAudio
        });
      }
    }
  }
  const heardIds = new Set(heardSentences.map(a => a.candidate_id));
  return {
    source_pack_id: session.pack.pack_id, source_session_id: session.pack.source_session_id,
    evidence_scope: operationTestOnly ? "operation_test_only" : "session_observation",
    independent_listening_evidence: operationTestOnly ? false : null,
    session_goal_by_item: Object.fromEntries(session.pack.items.map(i => [i.id, i.session_goal])),
    progress: { stage: progress.stage, paused: progress.paused, current_item_index: progress.itemIndex, active_candidate_id: progress.activeAttempt?.candidateId || null, created_at: progress.createdAt, updated_at: progress.updatedAt },
    planned_item_ids: itemIds,
    encountered_item_ids: unique(heardSentences.map(a => a.item_id)),
    unencountered_item_ids: itemIds.filter(id => !heardSentences.some(a => a.item_id === id)),
    unheard_candidate_ids: session.pack.items.flatMap(i => i.candidates.map(c => c.id)).filter(id => !heardIds.has(id)),
    heard_sentences_in_order: heardSentences,
    item_outcomes: progress.itemOutcomes,
    attempts,
    feedback_events: progress.feedbackEvents,
    pending_attempt: pendingAttempt
  };
}
function downloadData(data, filename, mime = "application/json") {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportJson(fullBackup = false) {
  if (fullBackup && storageReadBlocked) {
    $("moreStatus").textContent = "旧记录读取异常，无法制作可靠备份。请先下载异常原始数据。";
    return;
  }
  if (fullBackup) {
    downloadData(JSON.stringify({ schema: "blind_listening_backup_v2", exported_at: now(), state: db }, null, 2),
      `blind-listening-full-backup-${localDate(now())}.json`);
    $("moreStatus").textContent = "已尝试下载完整备份。请在手机“文件”中确认保存；备份含全部历史，不要当成每日回传发给 Work。";
    return;
  }
  const prepared = prepareIncrement();
  if (!prepared) return;
  downloadData(prepared.text, `blind-listening-to-work-${localDate(prepared.exportedAt)}-${prepared.exportId.slice(0, 8)}.json`);
  $("dataStatus").textContent = `已尝试下载 ${prepared.recordIds.length} 条待回传记录。请确认文件已保存并交给 Work；下载不会清除待回传记录。`;
}
function payloadChecksum(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function prepareIncrement() {
  if (storageReadBlocked) {
    $("dataStatus").textContent = "旧记录读取异常，无法可靠生成增量回传。请先下载异常原始数据。";
    return;
  }
  const acknowledged = new Set(db.acknowledgedRecordIds);
  const sessions = Object.values(db.sessions).map(session => {
    const all = exportSession(session);
    const attempts = all.attempts.filter(attempt => !acknowledged.has(attempt.record_id));
    if (!attempts.length) return null;
    const itemIds = unique(attempts.map(attempt => attempt.item_id));
    return {
      session_id: session.sessionId, pack_id: session.pack.pack_id,
      source_session_id: session.pack.source_session_id || null,
      mode: session.mode, created_at: session.progress.createdAt,
      evidence_scope: all.evidence_scope,
      session_goal_by_item: Object.fromEntries(itemIds.map(id => [id, all.session_goal_by_item[id]])),
      progress: all.progress,
      unencountered_item_ids: all.unencountered_item_ids,
      item_outcomes: Object.fromEntries(itemIds.filter(id => Object.hasOwn(all.item_outcomes, id)).map(id => [id, all.item_outcomes[id]])),
      attempts
    };
  }).filter(Boolean);
  const recordIds = sessions.flatMap(session => session.attempts.map(attempt => attempt.record_id));
  if (!recordIds.length) {
    $("dataStatus").textContent = "没有尚未确认回传的已完成练习记录。进行练习后再导出；未完成的当前句会保留在进度中。";
    return;
  }
  const matchingExports = Object.entries(db.pendingExports).filter(([, manifest]) =>
    manifest.recordIds.length === recordIds.length && manifest.recordIds.every((id, index) => id === recordIds[index]));
  const previousExport = matchingExports.find(([, manifest]) => manifest.payloadChecksum) || matchingExports[0];
  // Keep pre-checksum manifests intact so previously downloaded files remain confirmable.
  let exportId = previousExport?.[1].payloadChecksum ? previousExport[0] : newId();
  let exportedAt = previousExport?.[1].payloadChecksum ? previousExport[1].exportedAt : now();
  const documentData = {
    schema: "blind_listening_increment_v2", export_id: exportId, exported_at: exportedAt,
    export_scope: "unacknowledged_completed_records", deduplicate_by: "record_id", record_count: recordIds.length,
    sessions, candidate_reuse_guard_ids: db.seenCandidateIds
  };
  let checksum = payloadChecksum(documentData);
  if (previousExport?.[1].payloadChecksum && previousExport[1].payloadChecksum !== checksum) {
    exportId = newId(); exportedAt = now();
    documentData.export_id = exportId; documentData.exported_at = exportedAt;
    checksum = payloadChecksum(documentData);
  }
  documentData.payload_checksum = checksum;
  const previous = structuredClone(db.pendingExports);
  db.pendingExports[exportId] = { recordIds, exportedAt, payloadChecksum: checksum };
  if (!saveStore()) {
    db.pendingExports = previous;
    $("dataStatus").textContent = "本机保存失败，未导出增量回传。请立即导出完整备份并确认文件已保存。";
    return null;
  }
  return { text: JSON.stringify(documentData, null, 2), recordIds, exportId, exportedAt };
}
async function copyRecords() {
  const prepared = prepareIncrement();
  if (!prepared) return;
  $("manualCopy").hidden = true;
  $("manualCopyText").value = "";
  const bytes = new TextEncoder().encode(prepared.text).length;
  if (bytes > COPY_LIMIT) {
    $("dataStatus").textContent = `完整记录约 ${Math.ceil(bytes / 1024)} KB，手机复制容易丢失。请点“下载 JSON 文件”；没有截断任何记录。`;
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error("浏览器不支持直接复制");
    await navigator.clipboard.writeText(prepared.text);
    $("dataStatus").textContent = `已复制完整的 ${prepared.recordIds.length} 条记录。请发给 Work；复制不等于成功回传。`;
  } catch (_) {
    $("manualCopyText").value = prepared.text;
    $("manualCopy").hidden = false;
    $("manualCopy").open = true;
    $("dataStatus").textContent = "自动复制被浏览器阻止。可长按下方内容全选复制，或下载 JSON 文件；记录仍待回传。";
  }
}
async function confirmReturned(file) {
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error("文件超过 25 MB。");
    await confirmReturnedReport(JSON.parse(await file.text()));
  } catch (error) { $("dataStatus").textContent = `确认失败：${error.message}`; }
  finally { $("confirmReturned").value = ""; }
}
async function confirmPasted() {
  try {
    const value = $("confirmPaste").value.trim();
    if (new TextEncoder().encode(value).length > MAX_BACKUP_BYTES) throw new Error("内容超过 25 MB，请使用文件。");
    await confirmReturnedReport(JSON.parse(value));
    if ($( "dataStatus" ).textContent.startsWith("已确认")) $("confirmPaste").value = "";
  } catch (error) { $("dataStatus").textContent = `确认失败：${error.message}`; }
}
async function confirmReturnedReport(report) {
  try {
    if (report?.schema !== "blind_listening_increment_v2" || typeof report.export_id !== "string") {
      throw new Error("请选择此前导出的每日回传 JSON，而非完整备份。");
    }
    const ids = report.sessions?.flatMap(session => session.attempts?.map(attempt => attempt.record_id) || []) || [];
    const pending = Object.hasOwn(db.pendingExports, report.export_id) ? db.pendingExports[report.export_id] : null;
    if (!pending && ids.length && ids.every(id => db.acknowledgedRecordIds.includes(id))) {
      $("dataStatus").textContent = "这份文件中的记录此前已确认回传，无需重复确认。";
      return;
    }
    if (!pending) throw new Error("找不到这份导出文件的本机待确认记录，不能确认回传。");
    if (ids.length !== pending.recordIds.length || ids.some((id, index) => id !== pending.recordIds[index])) {
      throw new Error("文件中的记录编号与当时导出的清单不一致。");
    }
    if (pending.payloadChecksum) {
      const withoutChecksum = { ...report };
      delete withoutChecksum.payload_checksum;
      if (report.payload_checksum !== pending.payloadChecksum || payloadChecksum(withoutChecksum) !== pending.payloadChecksum) {
        throw new Error("记录内容与当时导出的版本不一致，请使用原始完整数据。");
      }
    }
    const remaining = pending.recordIds.filter(id => !db.acknowledgedRecordIds.includes(id));
    if (!remaining.length) {
      $("dataStatus").textContent = "这份文件中的记录此前已确认回传，无需重复确认。";
      return;
    }
    if (!window.confirm(`请先确认你已把这份 JSON 交给 Work。现在标记其中 ${remaining.length} 条记录为已回传？原始记录会保留。`)) return;
    const previous = structuredClone(db.acknowledgedRecordIds);
    const previousPending = structuredClone(db.pendingExports);
    db.acknowledgedRecordIds = unique([...db.acknowledgedRecordIds, ...remaining]);
    const acknowledged = new Set(db.acknowledgedRecordIds);
    for (const [id, manifest] of Object.entries(db.pendingExports)) {
      if (manifest.recordIds.every(recordId => acknowledged.has(recordId))) delete db.pendingExports[id];
    }
    if (!saveStore()) {
      db.acknowledgedRecordIds = previous;
      db.pendingExports = previousPending;
      throw new Error("本机保存失败，回传进度没有更新。请保留导出文件。");
    }
    $("dataStatus").textContent = `已确认回传 ${remaining.length} 条记录。原始记录仍保留；之后新增的记录仍会出现在下一份增量文件中。`;
  } catch (error) { throw error; }
}
function validateBackupState(state) {
  if (!state || state.version !== 2 || !state.sessions || Array.isArray(state.sessions) ||
      typeof state.sessions !== "object" || !Array.isArray(state.seenCandidateIds) ||
      state.seenCandidateIds.some(id => typeof id !== "string") ||
      !Array.isArray(state.acknowledgedRecordIds) || (state.allowRemoteVoice !== undefined && typeof state.allowRemoteVoice !== "boolean") || !state.pendingExports ||
      typeof state.pendingExports !== "object" || Array.isArray(state.pendingExports)) throw new Error("备份的存储结构无效。");
  const keys = Object.keys(state.sessions);
  if (keys.length > 1000) throw new Error("备份的训练轮次数量异常。");
  if (state.activeSessionId !== null && (typeof state.activeSessionId !== "string" || !Object.hasOwn(state.sessions, state.activeSessionId))) {
    throw new Error("备份的当前轮次编号无效。");
  }
  const recordIds = new Set();
  for (const key of keys) {
    const session = state.sessions[key];
    if (UNSAFE_KEYS.has(key) || !session || !session.pack || !session.progress || key !== session.sessionId ||
        !["first_exposure", "review"].includes(session.mode)) {
      throw new Error("备份含无效训练轮次。");
    }
    validatePack(session.pack);
    const progress = session.progress;
    if (!Number.isInteger(progress.itemIndex) || progress.itemIndex < 0 || progress.itemIndex > session.pack.items.length ||
        !["ready", "playing", "rating", "reason", "judged", "correcting", "spelling", "answer", "feedback", "continue", "blocked", "complete"].includes(progress.stage) ||
        typeof progress.paused !== "boolean" ||
        !Array.isArray(progress.attempts) || !Array.isArray(progress.feedbackEvents) ||
        !progress.itemOutcomes || typeof progress.itemOutcomes !== "object" ||
        !progress.candidateOrder || typeof progress.candidateOrder !== "object") {
      throw new Error("备份的训练进度结构无效。");
    }
    for (const item of session.pack.items) {
      const order = progress.candidateOrder[item.id];
      const validIds = new Set(item.candidates.map(candidate => candidate.id));
      if (!Array.isArray(order) || order.some(id => !validIds.has(id))) throw new Error("备份的候选句顺序无效。");
    }
    for (const attempt of [...progress.attempts, ...(progress.activeAttempt ? [progress.activeAttempt] : [])]) {
      const item = session.pack.items.find(candidateItem => candidateItem.id === attempt?.itemId);
      if (!item || !item.candidates.some(candidate => candidate.id === attempt.candidateId)) {
        throw new Error("备份的练习记录与训练包不匹配。");
      }
    }
    for (const attempt of progress.attempts) {
      if (typeof attempt.recordId !== "string" || !attempt.recordId || recordIds.has(attempt.recordId) ||
          typeof attempt.localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(attempt.localDate)) {
        throw new Error("备份含重复或无效练习记录编号。");
      }
      recordIds.add(attempt.recordId);
    }
    if (progress.feedbackEvents.some(event => !event || typeof event.itemId !== "string" || !Array.isArray(event.supportUsed))) {
      throw new Error("备份的反馈记录结构无效。");
    }
  }
  if (state.acknowledgedRecordIds.some(id => typeof id !== "string" || !recordIds.has(id)) ||
      new Set(state.acknowledgedRecordIds).size !== state.acknowledgedRecordIds.length) {
    throw new Error("备份的回传进度无效。");
  }
  for (const [id, manifest] of Object.entries(state.pendingExports)) {
    if (UNSAFE_KEYS.has(id) || !manifest || !Array.isArray(manifest.recordIds) ||
        manifest.recordIds.some(recordId => !recordIds.has(recordId))) throw new Error("备份的待确认导出清单无效。");
  }
  return state;
}
async function importBackup(file) {
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error("备份超过 25 MB，请勿导入。");
    const backup = JSON.parse(await file.text());
    if (!["blind_listening_backup_v1", "blind_listening_backup_v2"].includes(backup?.schema)) throw new Error("这不是可恢复的完整备份文件。");
    const restored = validateBackupState(migrateStore(backup.state));
    if (Object.keys(db.sessions).length && !storageReadBlocked) {
      throw new Error("当前浏览器已有记录。为避免覆盖，请先在空白浏览器环境中恢复。");
    }
    if (storageReadBlocked && !window.confirm("旧记录已损坏。恢复备份会覆盖原始存储。请先下载异常原始数据；确认现在恢复？")) return;
    const previous = db;
    const previousReadBlocked = storageReadBlocked;
    db = restored;
    storageReadBlocked = false;
    if (!saveStore()) {
      db = previous;
      storageReadBlocked = previousReadBlocked;
      if (storageReadBlocked) storageProblem = "本机旧记录仍未恢复。网页已停止写入，避免覆盖原数据。";
      showStorageProblem();
      throw new Error("本机保存失败，备份未恢复。请查看页面上的存储错误。");
    }
    allowRemoteVoice = !!db.allowRemoteVoice;
    $("allowRemoteVoice").checked = allowRemoteVoice;
    refreshVoices();
    render();
    $("moreStatus").textContent = "完整备份已恢复。请核对训练包与进度；声音需在这台设备重新试听。";
  } catch (error) { $("moreStatus").textContent = `恢复失败：${error.message}`; }
  finally { $("importBackup").value = ""; }
}
function exportDamagedRaw() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) throw new Error("没有可下载的原始存储内容。");
    downloadData(raw, `blind-listening-damaged-raw-${new Date().toISOString().slice(0, 10)}.txt`, "text/plain");
    $("moreStatus").textContent = "已尝试下载异常原始数据。请先在“文件”里确认保存，再考虑恢复备份。";
  } catch (error) { $("moreStatus").textContent = `原始数据导出失败：${error.message}`; }
}
function render() {
  const session = activeSession();
  const sessionSelect = $("sessionSelect");
  sessionSelect.replaceChildren();
  for (const saved of Object.values(db.sessions)) {
    const option = document.createElement("option");
    option.value = saved.sessionId;
    option.textContent = `${saved.pack.pack_id} · ${localDate(saved.progress.createdAt)} · ${saved.mode === "review" ? "复习" : "首次"} · ${saved.progress.stage === "complete" ? "已完成" : "可继续"} · ${saved.sessionId.slice(0, 8)}`;
    sessionSelect.append(option);
  }
  sessionSelect.disabled = !session;
  $("startNewSession").disabled = !session;
  if (session) sessionSelect.value = session.sessionId;
  const voiceReady = !!(db.voice?.approved && db.voice.key === $("voiceSelect").value && selectedVoice());
  $("homeCard").hidden = !!session && voiceReady && !session.progress.paused && session.progress.stage !== "complete";
  $("demoLink").hidden = DEMO_MODE || !!session;
  $("homeTitle").textContent = session ? (session.progress.stage === "complete" ? "这包练完了" : "继续训练") : "还没有训练包";
  $("homeSummary").textContent = session
    ? `${session.pack.pack_id} · ${session.progress.stage === "complete" ? "可交回记录或开始新一轮" : `第 ${session.progress.itemIndex + 1} 项 / 共 ${session.pack.items.length} 项`}${session.progress.paused ? " · 已暂停" : ""}`
    : "先到“材料与记录”粘贴 Work 给你的训练包。";
  $("homeAction").textContent = session ? (session.progress.stage === "complete" ? "交回记录" : "继续训练") : "导入训练包";
  $("voiceCard").hidden = voiceReady;
  $("trainerCard").hidden = !voiceReady || !session;
  if (!session || !voiceReady) return;
  const progress = session.progress;
  const item = currentItem();
  const attempt = progress.activeAttempt;
  const stage = progress.stage;
  const activeTask = item ? taskType(item) : null;
  const taskLabels = { word: "单词听辨", chunk: "词块听辨", in_sentence_recognition: "句中识别", sentence_understanding: "整句理解" };
  $("progressLabel").textContent = item ? `第 ${progress.itemIndex + 1} 项 / 共 ${session.pack.items.length} 项 · ${taskLabels[activeTask]}` : "本次结束";
  $("stepTitle").textContent = progress.paused ? "已暂停" : ({ ready: "听这一句", playing: "正在播放", rating: "听完了", correcting: "改刚才的判断", judged: "判断已记下", spelling: "先看英文", answer: "看正确意思", feedback: "目标词提示", continue: "继续下一句", blocked: "需要新的训练句", complete: "这包练完了" })[stage] || "准备听";
  $("instruction").textContent = progress.paused ? "进度已保存。点“继续”后从这里接着练。" : ({ ready: "先听，不看英文。", playing: "听完后点一次判断。", rating: "按刚才的真实情况点一次。", correcting: "改正误触会保留第一次选择和看答案的记录。", judged: "准备好就播放下一句。", spelling: "先看英文；意思稍后自动出现。要检查看字认识吗，可展开下方选项。", answer: "准备好就播放下一句。", feedback: "这是旧轮次留下的反馈步骤。", continue: "这一句已保存，继续听另一句。", blocked: "没有合格的新句，可交回记录请 Work 补充。", complete: "记录已保存在本机。" })[stage] || "";
  $("pauseSession").textContent = progress.paused ? "继续" : "暂停";
  const controlsEnabled = !!item && !progress.paused && ["ready", "rating"].includes(stage);
  $("playSentence").hidden = stage !== "ready" || progress.paused;
  $("replaySentence").hidden = stage !== "rating" || progress.paused;
  $("stopAudio").hidden = stage !== "playing" || progress.paused;
  $("playSentence").parentElement.hidden = !["ready", "playing", "rating"].includes(stage) || progress.paused;
  $("playSentence").disabled = !controlsEnabled || stage !== "ready";
  $("replaySentence").disabled = !controlsEnabled || !attempt?.playCount;
  $("stopAudio").disabled = stage !== "playing";
  $("skipCurrent").hidden = !["ready", "rating"].includes(stage) || progress.paused;
  $("showText").disabled = stage !== "rating" || !attempt?.audioCompleted;
  $("revealedText").textContent = attempt?.textShown ? (currentCandidate()?.text || "") : "";
  $("ratingPanel").hidden = !["rating", "correcting"].includes(stage) || progress.paused;
  document.querySelectorAll("[data-rating='direct']").forEach(button => { button.textContent = (attempt?.playCount || 0) > 1 ? "重听后懂了" : "马上懂了"; });
  document.querySelectorAll("[data-rating='slow']").forEach(button => { button.hidden = (attempt?.playCount || 0) > 1; });
  $("judgedPanel").hidden = stage !== "judged" || progress.paused;
  $("judgedSummary").textContent = `已记下：${attempt?.overallStatus === "direct" ? "马上懂了" : "后来才懂"}`;
  $("spellingPanel").hidden = stage !== "spelling" || progress.paused;
  $("writtenCheck").hidden = !["word", "chunk", "in_sentence_recognition"].includes(activeTask);
  document.querySelectorAll("[data-written]").forEach(button => button.classList.toggle("selected", button.dataset.written === attempt?.writtenCheck));
  $("reasonChoices").hidden = attempt?.overallStatus !== "not_understood";
  document.querySelectorAll("[data-reason]").forEach(button => {
    button.classList.toggle("selected", button.dataset.reason === attempt?.difficultyType);
    button.hidden = button.dataset.reason === "integration" && activeTask !== "sentence_understanding";
  });
  $("answerPanel").hidden = stage !== "answer" || progress.paused;
  $("answerEnglish").textContent = attempt?.textShown ? (currentCandidate()?.text || "") : "";
  const finalItem = progress.itemIndex === session.pack.items.length - 1 &&
    (attempt?.overallStatus !== "not_understood" || progress.attempts.filter(a => a.itemId === item?.id).length + 1 >= item?.max_observations);
  document.querySelectorAll("[data-play-next]").forEach(button => { button.textContent = finalItem ? "完成这轮" : "播放下一句"; });
  $("legacyPanel").hidden = !["feedback", "continue"].includes(stage) || progress.paused;
  $("legacyMessage").textContent = stage === "feedback" && item ? `${item.feedback.spelling}：${item.feedback.meaning}` : "这句已记下，继续听另一句。";
  $("legacyPlayTarget").hidden = stage !== "feedback";
  $("completePanel").hidden = stage !== "complete";
  $("completeMessage").textContent = storageProblem
    ? "本机保存存在问题。关闭页面前请导出完整备份，并检查文件确实保存。"
    : DEMO_MODE ? "演示完成。可以在“更多”开始新一轮；演示记录不必交回 Work。"
    : "记录已保存在当前浏览器。点“去交回记录”，复制或下载新增记录；完整备份在“更多”里。";
  $("targetFeedback").textContent = stage === "answer" && item ? `${item.feedback.spelling}：${item.feedback.meaning}` : "";
  $("extraFeedback").hidden = !item?.feedback.details;
  $("extraFeedback").textContent = item?.feedback.details || "";
  if (["rating", "correcting"].includes(stage)) $("quickNote").value = attempt?.note || "";
  $("playStatus").textContent = stage === "playing" ? "正在朗读…" : stage === "blocked" ? "候选句不足。请交回记录给 Work 补充。" : "";
}
function decodePastedPack(input) {
  let value = input.trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();
  if (value.startsWith("BLP1:")) {
    const encoded = value.slice(5).replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > Math.ceil(MAX_PACK_BYTES * 4 / 3) + 4) {
      throw new Error("传输码格式或长度无效。");
    }
    let bytes;
    try { bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0)); }
    catch (_) { throw new Error("传输码不完整或被改动。请从 BLP1: 开头重新复制到最后一个字符。"); }
    if (bytes.length > MAX_PACK_BYTES) throw new Error("训练包超过 2 MB，请勿导入。");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (new TextEncoder().encode(value).length > MAX_PACK_BYTES) throw new Error("训练包超过 2 MB，请勿导入。");
  return value;
}
function loadPackText(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { throw new Error("内容不完整或不是训练包。请重新复制完整传输码或 JSON。"); }
  const pack = validatePack(parsed);
  interruptAudio();
  setActivePack(pack);
  $("dataStatus").textContent = `训练包 ${pack.pack_id} 已载入；已有轮次会继续，历史记录保留。`;
  $("trainNotice").textContent = "训练包已导入。先试听并确认英语声音，然后播放第一句。";
  $("trainNotice").hidden = false;
  return pack;
}
function showImportStatus(message, error = false) {
  $("dataStatus").textContent = message;
  $("importStatus").textContent = message;
  $("importStatus").classList.toggle("error", error);
  $("importStatus").hidden = false;
}
function importPastedPack() {
  try {
    if (!$("packPaste").value.trim()) throw new Error("还没有粘贴训练包。");
    showImportStatus("正在导入训练包…");
    const pack = loadPackText(decodePastedPack($("packPaste").value));
    $("packPaste").value = "";
    showImportStatus(`已导入 ${pack.pack_id}，页面已切回训练。`);
  } catch (error) { showImportStatus(`导入失败：${error.message}`, true); }
}
async function importPack(file) {
  try {
    if (file.size > MAX_PACK_BYTES) throw new Error("训练包超过 2 MB，请勿导入。");
    showImportStatus("正在导入训练包…");
    const pack = loadPackText(await file.text());
    showImportStatus(`已导入 ${pack.pack_id}，页面已切回训练。`);
  } catch (error) { showImportStatus(`导入失败：${error.message}`, true); }
  $("importPack").value = "";
}
function bindEvents() {
  $("restartDemo").addEventListener("click", startNewSession);
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
  $("homeAction").addEventListener("click", () => {
    const session = activeSession();
    if (!session || session.progress.stage === "complete") switchView("materials");
    else {
      switchView("train");
      if (session.progress.paused) togglePause();
      ( $("trainerCard").hidden ? $("voiceCard") : $("trainerCard") ).scrollIntoView?.({ behavior: "smooth" });
    }
  });
  $("goRecords").addEventListener("click", () => switchView("materials"));
  $("sessionSelect").addEventListener("change", () => {
    interruptAudio();
    const previous = db.activeSessionId;
    db.activeSessionId = $("sessionSelect").value;
    if (!saveStore()) {
      db.activeSessionId = previous;
      render();
      $("dataStatus").textContent = "保存失败，未切换轮次。";
      return;
    }
    render();
    switchView("train");
  });
  $("startNewSession").addEventListener("click", startNewSession);
  $("refreshVoices").addEventListener("click", refreshVoices);
  $("allowRemoteVoice").addEventListener("change", () => {
    interruptAudio();
    allowRemoteVoice = $("allowRemoteVoice").checked;
    db.allowRemoteVoice = allowRemoteVoice;
    db.voice = null;
    saveStore();
    refreshVoices();
  });
  $("voiceSelect").addEventListener("change", () => { db.voice = null; saveStore(); $("approveVoice").disabled = true; render(); });
  $("previewVoice").addEventListener("click", () => {
    $("approveVoice").disabled = true;
    $("voiceStatus").textContent = "正在试听。请听完再确认声音是否清楚。";
    speak("Hello. Please listen to this voice.", {
      onend: () => { $("voiceStatus").textContent = "试听结束。若声音清楚，可开始训练。"; $("approveVoice").disabled = false; },
      onerror: () => { $("voiceStatus").textContent = "试听失败。请换一个英语声音。"; }
    });
  });
  $("approveVoice").addEventListener("click", () => { db.voice = { key: $("voiceSelect").value, approved: true, approvedAt: now() }; saveStore(); render(); });
  $("playSentence").addEventListener("click", playSentence);
  $("replaySentence").addEventListener("click", playSentence);
  $("stopAudio").addEventListener("click", interruptAudio);
  $("skipCurrent").addEventListener("click", skipCurrent);
  $("showText").addEventListener("click", revealSpelling);
  $("revealAfterJudgment").addEventListener("click", revealSpelling);
  document.querySelectorAll("[data-rating]").forEach(button => button.addEventListener("click", () => chooseRating(button.dataset.rating)));
  document.querySelectorAll("[data-reason]").forEach(button => button.addEventListener("click", () => setDifficulty(button.dataset.reason)));
  $("optionalDiagnosis").addEventListener("toggle", () => { if ($("optionalDiagnosis").open) cancelAutomaticMeaning(); else scheduleAutomaticMeaning(); });
  document.querySelectorAll("[data-correct]").forEach(button => button.addEventListener("click", startCorrection));
  document.querySelectorAll("[data-written]").forEach(button => button.addEventListener("click", () => setWrittenCheck(button.dataset.written)));
  $("quickNote").addEventListener("input", () => {
    const attempt = activeSession()?.progress.activeAttempt;
    if (attempt) {
      const previous = attempt.note;
      attempt.note = $("quickNote").value;
      if (!saveStore()) attempt.note = previous;
    }
  });
  $("revealMeaning").addEventListener("click", revealMeaning);
  $("playTarget").addEventListener("click", playTarget);
  document.querySelectorAll("[data-play-next]").forEach(button => button.addEventListener("click", playNext));
  $("legacyPlayTarget").addEventListener("click", playTarget);
  $("legacyContinue").addEventListener("click", prepareFollowup);
  $("pauseSession").addEventListener("click", togglePause);
  $("changeVoice").addEventListener("click", () => {
    interruptAudio();
    db.voice = null;
    saveStore();
    refreshVoices();
  });
  $("exportJson").addEventListener("click", () => exportJson(false));
  $("copyRecords").addEventListener("click", copyRecords);
  $("confirmPasted").addEventListener("click", confirmPasted);
  $("confirmReturned").addEventListener("change", event => { if (event.target.files[0]) confirmReturned(event.target.files[0]); });
  $("exportAllJson").addEventListener("click", () => exportJson(true));
  $("importBackup").addEventListener("change", event => { if (event.target.files[0]) importBackup(event.target.files[0]); });
  $("exportDamagedRaw").addEventListener("click", exportDamagedRaw);
  $("importPack").addEventListener("change", event => { if (event.target.files[0]) importPack(event.target.files[0]); });
  $("importPastedPack").addEventListener("click", importPastedPack);
  document.addEventListener("visibilitychange", () => { if (document.hidden) { cancelAutomaticMeaning(); interruptAudio(); } else scheduleAutomaticMeaning(); });
  window.addEventListener("pagehide", () => { cancelAutomaticMeaning(); interruptAudio(); });
}
async function init() {
  bindEvents();
  $("demoBanner").hidden = !DEMO_MODE;
  showStorageProblem();
  allowRemoteVoice = !!db.allowRemoteVoice;
  $("allowRemoteVoice").checked = allowRemoteVoice;
  if (!db.activeSessionId) {
    $("dataStatus").textContent = "还没有训练包：可在这里粘贴完整 JSON 或传输码，也可从手机“文件”选择 JSON。";
  } else {
    const progress = activeSession()?.progress;
    if (progress?.stage === "playing") {
      progress.stage = "ready";
      if (progress.activeAttempt) progress.activeAttempt.partialAudio = true;
      saveStore();
    }
    if (progress?.stage === "reason" && progress.activeAttempt?.overallStatus === "not_understood") {
      progress.activeAttempt.firstJudgment ||= { understanding: "not_understood", difficulty: progress.activeAttempt.draftReason || null, at: now(), source: "legacy_pending_reason" };
      progress.activeAttempt.difficultyType = progress.activeAttempt.draftReason || null;
      progress.activeAttempt.textShown = true;
      progress.activeAttempt.textShownAfterJudgment = true;
      progress.stage = "spelling";
      saveStore();
    }
  }
  if (synth) synth.onvoiceschanged = refreshVoices;
  refreshVoices();
  if (DEMO_MODE && !db.activeSessionId && !storageReadBlocked) {
    try { setActivePack(DEMO_PACK); }
    catch (error) { $("dataStatus").textContent = `演示包未载入：${error.message}`; }
  }
  render();
  scheduleAutomaticMeaning();
  switchView("train");
}
init();
