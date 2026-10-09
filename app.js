"use strict";

const STORE_KEY = "english-blind-listening-v1";
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
let spokenToken = 0;
let selectedReason = null;

function now() { return new Date().toISOString(); }
function emptyStore() { return { version: 1, activePackId: null, sessions: {}, seenCandidateIds: [], voice: null }; }
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyStore();
    return validateBackupState(JSON.parse(raw));
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
    storageProblem = "本机保存失败。当前内容可能只在页面内存中；请立即导出本轮 JSON，关闭或刷新页面前处理。";
    showStorageProblem();
    return false;
  }
}
function activeSession() { return db.sessions[db.activePackId] || null; }
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
function makeSession(pack) {
  const candidateOrder = {};
  for (const item of pack.items) {
    const initial = item.candidates.filter(c => c.content_role === "initial" || c.content_role === "anchor").map(c => c.id);
    const rest = item.candidates.filter(c => !initial.includes(c.id)).map(c => c.id);
    candidateOrder[item.id] = [...shuffled(initial), ...shuffled(rest)];
  }
  return {
    pack,
    progress: {
      createdAt: now(), updatedAt: now(), itemIndex: 0, stage: "ready", paused: false,
      activeAttempt: null, attempts: [], itemOutcomes: {}, feedbackEvents: [], candidateOrder
    }
  };
}
function setActivePack(pack) {
  validatePack(pack);
  if (Object.hasOwn(db.sessions, pack.pack_id) && JSON.stringify(db.sessions[pack.pack_id].pack) !== JSON.stringify(pack)) {
    throw new Error("这个训练包编号已有不同内容。请让 Work 为修订包使用新编号，避免混淆旧记录。");
  }
  const previous = structuredClone(db);
  if (!Object.hasOwn(db.sessions, pack.pack_id)) db.sessions[pack.pack_id] = makeSession(pack);
  db.activePackId = pack.pack_id;
  if (!saveStore()) {
    db = previous;
    throw new Error("本机保存失败，训练包未载入；旧记录没有被覆盖。请查看页面上的存储错误。");
  }
  render();
}
function updateProgress() {
  const session = activeSession();
  if (session) session.progress.updatedAt = now();
  saveStore();
  render();
}
function selectCandidate(followup) {
  const session = activeSession();
  const item = currentItem();
  if (!session || !item) return null;
  const progress = session.progress;
  const usedHere = progress.attempts.filter(a => a.itemId === item.id).map(a => a.candidateId);
  const ids = progress.candidateOrder[item.id];
  const unseen = ids.filter(id => !usedHere.includes(id) && !db.seenCandidateIds.includes(id));
  const preferred = followup ? unseen.filter(id => ["low_load_fallback", "fallback"].includes(item.candidates.find(c => c.id === id).content_role)) : unseen.filter(id => {
    const role = item.candidates.find(c => c.id === id).content_role;
    return role === "initial" || role === "anchor";
  });
  const id = preferred[0];
  if (!id) return null;
  progress.activeAttempt = {
    itemId: item.id, candidateId: id, selectedAt: now(), playCount: 0,
    audioCompleted: false, partialAudio: false, textShown: false,
    supportBefore: currentSupport(item.id), overallStatus: null, difficultyType: null, note: ""
  };
  progress.stage = "ready";
  updateProgress();
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
  voices = synth.getVoices().filter(v => /^en([-_]|$)/i.test(v.lang));
  const select = $("voiceSelect");
  const old = select.value || db.voice?.key;
  select.replaceChildren();
  voices.forEach(v => {
    const option = document.createElement("option");
    option.value = voiceKey(v);
    option.textContent = `${v.name} · ${v.lang}${v.localService ? " · 本机" : ""}`;
    select.append(option);
  });
  const browserDefault = document.createElement("option");
  browserDefault.value = BROWSER_DEFAULT_VOICE;
  browserDefault.textContent = "尝试浏览器默认声音（en-US；必须试听确认）";
  select.append(browserDefault);
  const googleUS = voices.find(v => v.name === "Google US English" && v.lang.toLowerCase() === "en-us");
  const preferred = googleUS || voices.find(v => /Microsoft.*(Aria|Jenny|Sonia|Guy|Ryan)/i.test(v.name)) ||
    voices.find(v => /Google.*English/i.test(v.name)) || voices.find(v => v.localService) || voices[0];
  const promoteFallback = old === BROWSER_DEFAULT_VOICE && !!googleUS && activeSession()?.progress.stage !== "playing";
  if (old && !promoteFallback && (old === BROWSER_DEFAULT_VOICE || voices.some(v => voiceKey(v) === old))) select.value = old;
  else if (preferred) select.value = voiceKey(preferred);
  if (promoteFallback) { db.voice = null; saveStore(); }
  $("voiceStatus").textContent = promoteFallback ? "检测到 Google US English。请先试听，确认后才用于训练。" : voices.length ? `检测到 ${voices.length} 个英语声音。请试听并判断是否清楚。` : "未找到明确标为英语的声音。可尝试浏览器默认 en-US；只有试听后确认发音清楚才开始。";
  $("previewVoice").disabled = false;
  $("approveVoice").disabled = !(db.voice?.approved && db.voice.key === select.value);
  render();
}
function selectedVoice() {
  if ($("voiceSelect").value === BROWSER_DEFAULT_VOICE) return { browserDefault: true, lang: "en-US" };
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
  if (!session || session.progress.paused || session.progress.stage === "complete") return;
  if (!db.voice?.approved || db.voice.key !== $("voiceSelect").value) return;
  if (!session.progress.activeAttempt && !selectCandidate(false)) { blockCurrentItem("no_unseen_candidate"); return; }
  const attempt = session.progress.activeAttempt;
  const candidate = currentCandidate();
  if (!candidate || !targetPresent(currentItem(), candidate.text) || candidate.anchor_id !== currentItem().anchor_id) {
    blockCurrentItem("candidate_validation_failed"); return;
  }
  attempt.playCount += 1;
  attempt.lastPlayAt = now();
  attempt.voicesUsed = unique([...(attempt.voicesUsed || (attempt.voice ? [attempt.voice] : [])), $("voiceSelect").value]);
  attempt.voice = $("voiceSelect").value;
  attempt.rate = 0.94;
  attempt.audioCompleted = false;
  session.progress.stage = "playing";
  db.seenCandidateIds = unique([...db.seenCandidateIds, candidate.id]);
  updateProgress();
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
function showSentenceText() {
  const attempt = activeSession()?.progress.activeAttempt;
  if (!attempt || !attempt.playCount || attempt.overallStatus) return;
  attempt.textShown = true;
  updateProgress();
}
function chooseRating(value) {
  const session = activeSession();
  const attempt = session?.progress.activeAttempt;
  if (!attempt || !attempt.audioCompleted || session.progress.stage !== "rating") return;
  attempt.overallStatus = value;
  if (value === "not_understood") {
    session.progress.stage = "reason";
    selectedReason = null;
    $("noteInput").value = $("quickNote").value;
    updateProgress();
  } else {
    attempt.note = $("quickNote").value.trim();
    finishAttempt();
  }
}
function supportForAttempt(attempt) {
  return unique([
    ...attempt.supportBefore,
    ...(attempt.playCount > 1 ? ["replay"] : []),
    ...(attempt.textShown ? ["sentence_text"] : [])
  ]);
}
function finishAttempt() {
  const session = activeSession();
  const progress = session.progress;
  const attempt = progress.activeAttempt;
  if (!attempt?.overallStatus) return;
  attempt.recordedAt = now();
  attempt.supportUsed = supportForAttempt(attempt);
  progress.attempts.push(structuredClone(attempt));
  progress.activeAttempt = null;
  $("quickNote").value = "";
  $("noteInput").value = "";
  const item = currentItem();
  const count = progress.attempts.filter(a => a.itemId === item.id).length;
  if (attempt.overallStatus !== "not_understood" || count >= item.max_observations) {
    completeItem("local_observation_recorded");
  } else if (["target_sound", "target_meaning"].includes(attempt.difficultyType)) {
    progress.stage = "feedback";
    progress.feedbackEvents.push({ itemId: item.id, afterCandidateId: attempt.candidateId, at: now(), supportUsed: ["spelling", "meaning"], reason: attempt.difficultyType });
    updateProgress();
  } else {
    progress.stage = "continue";
    updateProgress();
  }
}
function saveMiss() {
  const attempt = activeSession()?.progress.activeAttempt;
  if (!attempt || attempt.overallStatus !== "not_understood") return;
  attempt.difficultyType = selectedReason || null;
  attempt.note = $("noteInput").value.trim();
  finishAttempt();
}
function playTarget() {
  const item = currentItem();
  const session = activeSession();
  if (!item || session.progress.stage !== "feedback") return;
  const event = [...session.progress.feedbackEvents].reverse().find(e => e.itemId === item.id);
  speak(item.feedback.spelling, {
    onend: () => {
      if (event) { event.supportUsed = unique([...event.supportUsed, "target_audio"]); updateProgress(); }
    },
    onerror: () => { $("playStatus").textContent = "目标发音未完成，请重试。"; }
  });
}
function prepareFollowup() {
  const session = activeSession();
  if (!session || !["feedback", "continue"].includes(session.progress.stage)) return;
  if (session.progress.stage === "feedback" && !currentSupport(currentItem().id).includes("target_audio")) return;
  if (!selectCandidate(true)) { blockCurrentItem("no_unseen_fallback"); return; }
  $("revealedText").textContent = "";
  render();
}
function blockCurrentItem(reason) {
  const session = activeSession();
  const item = currentItem();
  if (!session || !item) return;
  session.progress.itemOutcomes[item.id] = { sessionGoalResult: "not_observed", localExitReason: reason, at: now() };
  session.progress.stage = "blocked";
  updateProgress();
  $("playStatus").textContent = "没有合格的新句可继续。请导出记录，交给 Work 补充训练包。";
}
function completeItem(reason) {
  const session = activeSession();
  const progress = session.progress;
  const item = currentItem();
  progress.itemOutcomes[item.id] = { sessionGoalResult: "observed", localExitReason: reason, at: now() };
  progress.itemIndex += 1;
  progress.stage = progress.itemIndex >= session.pack.items.length ? "complete" : "ready";
  updateProgress();
}
function togglePause() {
  const session = activeSession();
  if (!session) return;
  if (!session.progress.paused) interruptAudio();
  session.progress.paused = !session.progress.paused;
  updateProgress();
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
  const operationTestOnly = session.pack.evidence_scope !== "session_observation";
  const itemIds = session.pack.items.map(i => i.id);
  const pending = progress.activeAttempt;
  const attempts = progress.attempts.map((attempt, index) => {
    const item = session.pack.items.find(i => i.id === attempt.itemId);
    const candidate = item.candidates.find(c => c.id === attempt.candidateId);
    const exposureFlags = [
      ...(operationTestOnly ? ["prior_target_exposure"] : []),
      ...(!operationTestOnly && attempt.playCount === 1 && !attempt.partialAudio && !attempt.textShown && !attempt.supportBefore.length && !progress.attempts.slice(0, index).some(a => a.itemId === item.id) ? ["first_unprompted"] : []),
      ...(attempt.playCount > 1 ? ["replay_assisted"] : []),
      ...(attempt.partialAudio ? ["partial_audio_exposure"] : []),
      ...(attempt.textShown ? ["text_revealed"] : []),
      ...(attempt.supportBefore.some(s => ["spelling", "meaning", "target_audio"].includes(s)) ? ["post_feedback_immediate"] : [])
    ];
    return {
      order: index + 1, item_id: item.id, candidate_id: candidate.id,
      sentence: candidate.text, content_role: candidate.content_role,
      variation_dimensions: candidate.variation_dimensions,
      variation_detail: candidate.variation_detail,
      use_anchor: item.use_anchor,
      user_reported: { understanding: attempt.overallStatus, difficulty: attempt.difficultyType, note: attempt.note },
      app_observed: { play_count: attempt.playCount, replay_count: Math.max(0, attempt.playCount - 1), audio_completed: attempt.audioCompleted, partial_audio: attempt.partialAudio, sentence_text_shown: attempt.textShown, support_used: attempt.supportUsed, exposure_flags: exposureFlags, voice: attempt.voice, voices_used: attempt.voicesUsed || (attempt.voice ? [attempt.voice] : []), rate: attempt.rate, started_at: attempt.lastPlayAt, recorded_at: attempt.recordedAt },
      interpretation: interpretedLayers(attempt)
    };
  });
  const heardSentences = attempts.map(attempt => ({
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
        play_count: pending.playCount, audio_completed: pending.audioCompleted,
        partial_audio: pending.partialAudio, sentence_text_shown: pending.textShown,
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
  const current = activeSession();
  if (!fullBackup && !current) {
    $("dataStatus").textContent = "还没有当前训练包，暂无本轮记录可导出。";
    return;
  }
  if (fullBackup && storageReadBlocked) {
    $("dataStatus").textContent = "旧记录读取异常，无法制作可靠备份。请先下载异常原始数据。";
    return;
  }
  const documentData = fullBackup
    ? { schema: "blind_listening_backup_v1", exported_at: now(), state: db }
    : {
      schema: "blind_listening_export_v1", exported_at: now(), export_scope: "current_session",
      active_pack_id: db.activePackId, sessions: [exportSession(current)],
      candidate_reuse_guard_ids: db.seenCandidateIds
    };
  downloadData(
    JSON.stringify(documentData, null, 2),
    `blind-listening-${fullBackup ? "full-backup" : "current-session"}-${new Date().toISOString().slice(0, 10)}.json`
  );
  $("dataStatus").textContent = fullBackup
    ? "已导出可恢复的完整备份。请在“文件”中确认它已保存；备份含全部训练包和记录，不要误发给 Work。"
    : "已导出本轮 JSON。发送给 Work 前请先查看文件内容；网页不会自动发送。";
}
function validateBackupState(state) {
  if (!state || state.version !== 1 || !state.sessions || Array.isArray(state.sessions) ||
      typeof state.sessions !== "object" || !Array.isArray(state.seenCandidateIds) ||
      state.seenCandidateIds.some(id => typeof id !== "string")) throw new Error("备份的存储结构无效。");
  const keys = Object.keys(state.sessions);
  if (keys.length > 1000) throw new Error("备份的训练轮次数量异常。");
  if (state.activePackId !== null && (typeof state.activePackId !== "string" || !Object.hasOwn(state.sessions, state.activePackId))) {
    throw new Error("备份的当前训练包编号无效。");
  }
  for (const key of keys) {
    const session = state.sessions[key];
    if (UNSAFE_KEYS.has(key) || !session || !session.pack || !session.progress || key !== session.pack.pack_id) {
      throw new Error("备份含无效训练轮次。");
    }
    validatePack(session.pack);
    const progress = session.progress;
    if (!Number.isInteger(progress.itemIndex) || progress.itemIndex < 0 || progress.itemIndex > session.pack.items.length ||
        !["ready", "playing", "rating", "reason", "feedback", "continue", "blocked", "complete"].includes(progress.stage) ||
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
    if (progress.feedbackEvents.some(event => !event || typeof event.itemId !== "string" || !Array.isArray(event.supportUsed))) {
      throw new Error("备份的反馈记录结构无效。");
    }
  }
  return state;
}
async function importBackup(file) {
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error("备份超过 25 MB，请勿导入。");
    const backup = JSON.parse(await file.text());
    if (backup?.schema !== "blind_listening_backup_v1") throw new Error("这不是可恢复的完整备份文件。");
    const restored = validateBackupState(backup.state);
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
      throw new Error("本机保存失败，备份未恢复。请查看页面上的存储错误。");
    }
    selectedReason = activeSession()?.progress.activeAttempt?.draftReason || null;
    refreshVoices();
    render();
    $("dataStatus").textContent = "完整备份已恢复。请核对训练包与进度；声音需在这台设备重新试听。";
  } catch (error) { $("dataStatus").textContent = `恢复失败：${error.message}`; }
  finally { $("importBackup").value = ""; }
}
function exportDamagedRaw() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) throw new Error("没有可下载的原始存储内容。");
    downloadData(raw, `blind-listening-damaged-raw-${new Date().toISOString().slice(0, 10)}.txt`, "text/plain");
    $("dataStatus").textContent = "已尝试下载异常原始数据。请先在“文件”里确认保存，再考虑恢复备份。";
  } catch (error) { $("dataStatus").textContent = `原始数据导出失败：${error.message}`; }
}
function render() {
  const session = activeSession();
  const voiceReady = !!(db.voice?.approved && db.voice.key === $("voiceSelect").value && selectedVoice());
  $("voiceCard").hidden = voiceReady;
  $("trainerCard").hidden = !voiceReady || !session;
  if (!session || !voiceReady) return;
  const progress = session.progress;
  const item = currentItem();
  const attempt = progress.activeAttempt;
  const stage = progress.stage;
  $("progressLabel").textContent = item ? `第 ${progress.itemIndex + 1} 项 / 共 ${session.pack.items.length} 项` : "本次结束";
  $("stepTitle").textContent = stage === "complete" ? "本次材料已完成" : progress.paused ? "已暂停" : stage === "feedback" ? "看一下必要反馈" : stage === "continue" ? "准备换一句" : stage === "blocked" ? "需要新的训练句" : stage === "rating" || stage === "reason" ? "刚才听懂了吗？" : "准备听";
  $("instruction").textContent = progress.paused ? "进度已保存。点击“继续”后仍从这里开始。" : "点击播放，听懂对方在问什么。不用回答英语。";
  $("pauseSession").textContent = progress.paused ? "继续" : "暂停";
  const controlsEnabled = !!item && !progress.paused && ["ready", "rating"].includes(stage);
  $("playSentence").disabled = !controlsEnabled || stage !== "ready";
  $("replaySentence").disabled = !controlsEnabled || !attempt?.playCount;
  $("stopAudio").disabled = stage !== "playing";
  $("showText").disabled = !controlsEnabled || !attempt?.playCount || !!attempt?.overallStatus;
  $("revealedText").hidden = !attempt?.textShown;
  $("revealedText").textContent = attempt?.textShown ? (currentCandidate()?.text || "") : "";
  $("ratingPanel").hidden = stage !== "rating" || progress.paused;
  $("reasonPanel").hidden = stage !== "reason" || progress.paused;
  $("feedbackPanel").hidden = stage !== "feedback" || progress.paused;
  $("continueAfterFeedback").disabled = stage !== "feedback" || !item || !currentSupport(item.id).includes("target_audio");
  $("continuePanel").hidden = stage !== "continue" || progress.paused;
  $("completePanel").hidden = stage !== "complete";
  $("completeMessage").textContent = storageProblem
    ? "本机保存存在问题。关闭页面前请导出本轮 JSON，并检查文件确实保存。"
    : "结果已保存在当前浏览器。建议导出完整备份，并确认文件已保存。";
  $("targetFeedback").textContent = stage === "feedback" && item ? `${item.feedback.spelling}：${item.feedback.meaning}` : "";
  if (stage === "rating") $("quickNote").value = attempt?.note || "";
  if (stage === "reason") $("noteInput").value = attempt?.note || "";
  $("continueMessage").textContent = stage === "continue" ? "原因尚不确定。下一句会更简短，不把这次直接算成目标词失败。" : "";
  $("playStatus").textContent = stage === "playing" ? "正在朗读…" : stage === "rating" ? "可以重播，或直接选刚才的理解状态。" : stage === "blocked" ? "候选句不足。请导出记录交给 Work 补充。" : "";
  document.querySelectorAll(".reason").forEach(button => button.classList.toggle("selected", button.dataset.reason === selectedReason));
}
async function importPack(file) {
  try {
    if (file.size > MAX_PACK_BYTES) throw new Error("训练包超过 2 MB，请勿导入。");
    const pack = validatePack(JSON.parse(await file.text()));
    interruptAudio();
    setActivePack(pack);
    $("dataStatus").textContent = "训练包已载入；旧记录仍在当前浏览器。本轮导出只含当前训练包。";
  } catch (error) { $("dataStatus").textContent = `导入失败：${error.message}`; }
  $("importPack").value = "";
}
function bindEvents() {
  $("refreshVoices").addEventListener("click", refreshVoices);
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
  $("showText").addEventListener("click", showSentenceText);
  document.querySelectorAll("[data-rating]").forEach(button => button.addEventListener("click", () => chooseRating(button.dataset.rating)));
  document.querySelectorAll("[data-reason]").forEach(button => button.addEventListener("click", () => {
    selectedReason = button.dataset.reason;
    const attempt = activeSession()?.progress.activeAttempt;
    if (attempt) attempt.draftReason = selectedReason;
    updateProgress();
  }));
  for (const id of ["quickNote", "noteInput"]) {
    $(id).addEventListener("input", () => {
      const attempt = activeSession()?.progress.activeAttempt;
      if (attempt) { attempt.note = $(id).value; saveStore(); }
    });
  }
  $("saveMiss").addEventListener("click", saveMiss);
  $("playTarget").addEventListener("click", playTarget);
  $("continueAfterFeedback").addEventListener("click", prepareFollowup);
  $("continueNext").addEventListener("click", prepareFollowup);
  $("pauseSession").addEventListener("click", togglePause);
  $("changeVoice").addEventListener("click", () => {
    interruptAudio();
    db.voice = null;
    saveStore();
    refreshVoices();
  });
  $("exportJson").addEventListener("click", () => exportJson(false));
  $("exportAllJson").addEventListener("click", () => exportJson(true));
  $("importBackup").addEventListener("change", event => { if (event.target.files[0]) importBackup(event.target.files[0]); });
  $("exportDamagedRaw").addEventListener("click", exportDamagedRaw);
  $("importPack").addEventListener("change", event => { if (event.target.files[0]) importPack(event.target.files[0]); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) interruptAudio(); });
  window.addEventListener("pagehide", interruptAudio);
}
async function init() {
  bindEvents();
  showStorageProblem();
  if (!db.activePackId) {
    $("dataStatus").textContent = "此网页不附带训练包。请从手机“文件”中选择自己的 JSON 训练包。";
  } else {
    const progress = activeSession()?.progress;
    selectedReason = progress?.activeAttempt?.draftReason || null;
    if (progress?.stage === "playing") {
      progress.stage = "ready";
      if (progress.activeAttempt) progress.activeAttempt.partialAudio = true;
      saveStore();
    }
  }
  if (synth) synth.onvoiceschanged = refreshVoices;
  refreshVoices();
  render();
}
init();
