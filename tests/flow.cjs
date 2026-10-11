"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto").webcrypto;
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const { pack, phonePack, simplePack, twoItemPack } = require("./fixtures.cjs");
const KEY = "english-blind-listening-v1";

function harness(initial = null, query = "") {
  const storeKey = query === "?demo=1" ? "english-blind-listening-demo-v1" : KEY;
  const saved = new Map(initial ? [[storeKey, JSON.stringify(initial)]] : []);
  const elements = new Map();
  const downloads = [];
  let failWrites = false;
  let clipboardFails = false;
  let blob = null;
  let clipboardText = null;
  let nextTimer = 1;
  const timers = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, hidden: false, disabled: false, textContent: "", children: [], parentElement: { hidden: false },
      addEventListener() {}, replaceChildren() { this.children = []; this.value = ""; },
      append(child) { this.children.push(child); if (this.children.length === 1) this.value = child.value; },
      remove() {}, click() { if (blob) downloads.push(blob); },
      classList: { toggle() {} }
    });
    return elements.get(id);
  };
  const storage = {
    getItem(key) { return saved.get(key) || null; },
    setItem(key, value) { if (failWrites) throw new Error("quota"); saved.set(key, value); }
  };
  const document = {
    getElementById: element, querySelectorAll: () => [],
    createElement: tag => element(`created-${tag}-${Math.random()}`),
    body: { append() {} }, hidden: false, addEventListener() {}
  };
  const synth = { getVoices: () => [{ name: "Local English", lang: "en-US", localService: true }], cancel() {}, speak() {} };
  const window = { speechSynthesis: synth, confirm: () => true, addEventListener() {}, location: { search: query } };
  const navigator = { clipboard: { async writeText(value) { if (clipboardFails) throw new Error("denied"); clipboardText = value; } } };
  const context = vm.createContext({
    console, document, window, navigator, localStorage: storage, crypto, structuredClone, Blob, atob, TextEncoder, TextDecoder,
    URL: { createObjectURL(value) { blob = value; return "blob:test"; }, revokeObjectURL() {} },
    SpeechSynthesisUtterance: class {},
    setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    pack
  });
  vm.runInContext(app, context);
  return {
    context,
    eval: source => vm.runInContext(source, context),
    element, saved, downloads, setFailWrites: value => { failWrites = value; },
    lastDownload: async () => JSON.parse(await downloads.at(-1).text()),
    file: data => ({ size: JSON.stringify(data).length, text: async () => JSON.stringify(data) }),
    copied: () => clipboardText,
    runTimers: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    setClipboardFailure: value => { clipboardFails = value; }
  };
}

async function run() {
  const demo = harness(null, "?demo=1");
  const formalPack = structuredClone(pack);
  formalPack.evidence_scope = "session_observation";
  demo.context.formalPack = formalPack;
  assert.throws(() => demo.eval("setActivePack(formalPack)"), /演示页面不能导入正式训练包/);
  assert.equal(demo.eval("Object.keys(db.sessions).length"), 1, "rejected import leaves the demo session alone");
  assert.equal(demo.eval("activeSession().pack.evidence_scope"), "operation_test_only");
  const pasted = harness();
  const transferCode = `BLP1:${Buffer.from(JSON.stringify(phonePack)).toString("base64")}`;
  pasted.element("packPaste").value = transferCode;
  pasted.eval("importPastedPack()");
  assert.equal(pasted.eval("activeSession().pack.pack_id"), phonePack.pack_id, "chat transfer code imports the test pack");
  assert.equal(pasted.element("packPaste").value, "", "successful paste clears the input");
  assert.equal(pasted.eval("activeSession().pack.evidence_scope"), "operation_test_only");
  pasted.element("packPaste").value = "BLP1:broken";
  pasted.eval("importPastedPack()");
  assert.equal(pasted.eval("activeSession().pack.pack_id"), phonePack.pack_id, "bad code does not replace active pack");
  assert.equal(pasted.element("packPaste").value, "BLP1:broken", "failed paste remains editable");
  assert.match(pasted.element("dataStatus").textContent, /导入失败/);
  assert.equal(pasted.element("importStatus").hidden, false, "import error is shown beside the button");
  assert.match(pasted.element("importStatus").textContent, /导入失败/);
  const plain = harness();
  plain.element("packPaste").value = `\`\`\`json\n${JSON.stringify(phonePack)}\n\`\`\``;
  plain.eval("importPastedPack()");
  assert.equal(plain.eval("activeSession().pack.pack_id"), phonePack.pack_id, "fenced JSON imports too");
  const simplePackText = JSON.stringify(simplePack);
  const simple = harness();
  simple.element("packPaste").value = simplePackText;
  simple.eval("importPastedPack()");
  assert.equal(simple.eval("activeSession().pack.pack_id"), "PHONE-TEST-20261010-B", "plain chat JSON imports");
  simple.eval("selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; render()");
  simple.eval("chooseRating('target_sound')");
  assert.equal(simple.eval("activeSession().progress.stage"), "spelling", "failure first shows English, not meaning");
  assert.equal(simple.eval("activeSession().progress.activeAttempt.answerShown"), undefined);
  assert.equal(simple.eval("activeSession().progress.activeAttempt.overallStatus"), "not_understood");
  simple.eval("revealMeaning(); finishAttempt()");
  assert.equal(simple.eval("activeSession().progress.attempts[0].overallStatus"), "not_understood");
  assert.equal(simple.eval("activeSession().progress.attempts[0].difficultyType"), "target_sound");
  assert.equal(simple.eval("activeSession().progress.attempts[0].writtenCheck"), undefined, "written check may be skipped");
  assert.equal(simple.eval("activeSession().progress.stage"), "complete");

  const automaticFeedback = harness();
  automaticFeedback.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; chooseRating('not_understood')");
  assert.equal(automaticFeedback.eval("activeSession().progress.stage"), "spelling", "one fail tap first exposes English");
  assert.equal(automaticFeedback.eval("activeSession().progress.activeAttempt.difficultyType"), null, "specific reason remains unknown by default");
  automaticFeedback.eval("togglePause()");
  automaticFeedback.runTimers();
  assert.equal(automaticFeedback.eval("activeSession().progress.stage"), "spelling", "pause cannot reveal answer in the background");
  automaticFeedback.eval("togglePause()");
  automaticFeedback.runTimers();
  assert.equal(automaticFeedback.eval("activeSession().progress.stage"), "answer", "meaning appears automatically after English");
  assert.equal(automaticFeedback.eval("activeSession().progress.activeAttempt.answerShown"), true);

  const backgroundFeedback = harness();
  backgroundFeedback.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; chooseRating('not_understood'); switchView('materials')");
  backgroundFeedback.runTimers();
  assert.equal(backgroundFeedback.eval("activeSession().progress.activeAttempt.answerShown"), undefined,
    "switching to materials cannot record an answer the learner never saw");
  backgroundFeedback.eval("switchView('train')");
  backgroundFeedback.runTimers();
  assert.equal(backgroundFeedback.eval("activeSession().progress.activeAttempt.answerShown"), true);

  const optionalFeedback = harness();
  optionalFeedback.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; chooseRating('not_understood')");
  optionalFeedback.eval("document.getElementById('optionalDiagnosis').open = true; cancelAutomaticMeaning(); setWrittenCheck('recognized'); setDifficulty('target_sound')");
  optionalFeedback.runTimers();
  assert.equal(optionalFeedback.eval("activeSession().progress.stage"), "spelling", "opened optional check holds back the meaning");
  const refreshedEnglish = harness(JSON.parse(optionalFeedback.saved.get(KEY)));
  assert.equal(refreshedEnglish.eval("activeSession().progress.stage"), "spelling", "English-first state survives refresh");
  refreshedEnglish.runTimers();
  assert.equal(refreshedEnglish.eval("activeSession().progress.stage"), "answer", "meaning resumes after refresh");
  optionalFeedback.eval("revealMeaning(); finishAttempt(); exportJson(false)");
  const optionalRecord = (await optionalFeedback.lastDownload()).sessions[0].attempts[0];
  assert.equal(optionalRecord.user_reported.difficulty, "target_sound");
  assert.equal(optionalRecord.user_reported.written_check, "recognized");
  const reloadedFeedback = harness(JSON.parse(automaticFeedback.saved.get(KEY)));
  assert.equal(reloadedFeedback.eval("activeSession().progress.stage"), "answer", "answer exposure survives refresh");

  const nextPlay = harness();
  nextPlay.context.twoItemPack = twoItemPack;
  nextPlay.eval("setActivePack(twoItemPack); selectCandidate(false); db.voice = { key: document.getElementById('voiceSelect').value, approved: true }; saveStore(); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; chooseRating('direct'); playNext()");
  assert.equal(nextPlay.eval("activeSession().progress.attempts.length"), 1, "one judgment becomes one record");
  assert.equal(nextPlay.eval("activeSession().progress.itemIndex"), 1);
  assert.equal(nextPlay.eval("activeSession().progress.stage"), "playing", "next button starts next sentence directly");
  nextPlay.eval("playNext()");
  assert.equal(nextPlay.eval("activeSession().progress.attempts.length"), 1, "double tap does not duplicate a record");

  const h = harness();
  h.eval('now = () => "2026-10-09T11:00:00.000Z"');
  h.eval("setActivePack(pack)");
  assert.notEqual(h.eval("db.activeSessionId"), pack.pack_id);
  const firstSession = h.eval("db.activeSessionId");
  h.eval("selectCandidate(false)");
  h.eval("activeSession().progress.paused = true; saveStore()");
  const resumed = harness(JSON.parse(h.saved.get(KEY)));
  assert.equal(resumed.eval("activeSession().progress.paused"), true, "pause survives reload");
  resumed.eval("activeSession().progress.paused = false; saveStore()");
  resumed.eval('now = () => "2026-10-11T11:00:00.000Z"');
  resumed.eval('activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.activeAttempt.overallStatus = "direct"; finishAttempt()');
  const firstId = resumed.eval("activeSession().progress.attempts[0].recordId");
  assert.equal(resumed.eval("activeSession().progress.attempts[0].recordedAt"), "2026-10-11T11:00:00.000Z");
  assert.match(resumed.eval("activeSession().progress.attempts[0].localDate"), /^\d{4}-\d{2}-\d{2}$/);
  resumed.eval("exportJson(false)");
  const firstExport = await resumed.lastDownload();
  assert.equal(firstExport.record_count, 1);
  assert.equal(firstExport.sessions[0].attempts[0].record_id, firstId);
  assert.equal(firstExport.sessions[0].session_id, firstSession);
  assert.equal(resumed.eval("db.acknowledgedRecordIds.length"), 0, "download is not acknowledgment");
  resumed.eval("exportJson(false)");
  const repeated = await resumed.lastDownload();
  assert.equal(repeated.sessions[0].attempts[0].record_id, firstId, "repeat export keeps stable record ID");
  assert.equal(repeated.export_id, firstExport.export_id, "repeat export reuses its manifest");

  const oldManifest = harness(JSON.parse(resumed.saved.get(KEY)));
  oldManifest.context.oldExportId = firstExport.export_id;
  oldManifest.eval("delete db.pendingExports[oldExportId].payloadChecksum; saveStore()");
  const oldFormatReport = structuredClone(firstExport);
  delete oldFormatReport.payload_checksum;
  oldManifest.eval("exportJson(false)");
  assert.notEqual((await oldManifest.lastDownload()).export_id, firstExport.export_id, "new export does not overwrite old unconfirmed manifest");
  oldManifest.context.oldFormatFile = oldManifest.file(oldFormatReport);
  await oldManifest.eval("confirmReturned(oldFormatFile)");
  assert.equal(oldManifest.eval("db.acknowledgedRecordIds.length"), 1, "old unconfirmed JSON remains confirmable");

  const failedConfirm = harness(JSON.parse(resumed.saved.get(KEY)));
  failedConfirm.context.firstFile = failedConfirm.file(firstExport);
  failedConfirm.setFailWrites(true);
  await failedConfirm.eval("confirmReturned(firstFile)");
  assert.equal(failedConfirm.eval("db.acknowledgedRecordIds.length"), 0, "failed ack save rolls back");

  resumed.eval('now = () => "2026-10-13T11:00:00.000Z"');
  resumed.eval("startNewSession()");
  const reviewSession = resumed.eval("db.activeSessionId");
  assert.notEqual(reviewSession, firstSession);
  assert.equal(resumed.eval("activeSession().mode"), "review");
  resumed.eval("db.seenCandidateIds = pack.items[0].candidates.map(candidate => candidate.id); saveStore()");
  assert.equal(resumed.eval("!!selectCandidate(false)"), true, "old seen IDs must not block a review session");
  resumed.eval('activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.activeAttempt.overallStatus = "direct"; finishAttempt()');
  resumed.eval("exportJson(false)");
  const missedDayExport = await resumed.lastDownload();
  assert.equal(missedDayExport.record_count, 2, "unconfirmed records survive missed reporting days");
  assert.equal(missedDayExport.sessions.length, 2, "increment spans sessions");
  assert.ok(missedDayExport.sessions[1].attempts[0].app_observed.exposure_flags.includes("review_session"));
  assert.ok(missedDayExport.sessions[1].attempts[0].app_observed.exposure_flags.includes("prior_target_exposure"));
  assert.ok(!missedDayExport.sessions[1].attempts[0].app_observed.exposure_flags.includes("first_unprompted"));
  resumed.context.firstFile = resumed.file(firstExport);
  await resumed.eval("confirmReturned(firstFile)");
  assert.deepEqual(Array.from(resumed.eval("db.acknowledgedRecordIds")), [firstId]);
  resumed.eval("exportJson(false)");
  const remainingExport = await resumed.lastDownload();
  assert.equal(remainingExport.record_count, 1, "first confirmation must not acknowledge later record");
  assert.equal(remainingExport.sessions[0].session_id, reviewSession);
  resumed.context.remainingFile = resumed.file(remainingExport);
  await resumed.eval("confirmReturned(remainingFile)");
  assert.equal(resumed.eval("db.acknowledgedRecordIds.length"), 2);
  const before = resumed.downloads.length;
  resumed.eval("exportJson(false)");
  assert.equal(resumed.downloads.length, before, "no empty increment download");

  resumed.eval("exportJson(true)");
  const backup = await resumed.lastDownload();
  assert.equal(backup.schema, "blind_listening_backup_v2");
  const restored = harness();
  restored.context.backupFile = restored.file(backup);
  await restored.eval("importBackup(backupFile)");
  assert.equal(restored.eval("Object.keys(db.sessions).length"), 2);
  assert.equal(restored.eval("db.acknowledgedRecordIds.length"), 2);
  assert.equal(restored.eval("db.sessions[db.activeSessionId].progress.attempts.length"), 1);
  restored.eval("exportJson(false)");
  assert.equal(restored.downloads.length, 0, "restored ack state prevents duplicate report");

  const migratedSource = JSON.parse(resumed.saved.get(KEY));
  const session = migratedSource.sessions[firstSession];
  delete session.progress.attempts[0].recordId;
  delete session.progress.attempts[0].localDate;
  delete session.sessionId;
  delete session.mode;
  delete session.priorTargetByItem;
  const old = { version: 1, activePackId: pack.pack_id, sessions: { [pack.pack_id]: session },
    seenCandidateIds: migratedSource.seenCandidateIds, voice: null };
  const legacy = harness(old);
  assert.equal(legacy.eval("db.version"), 2);
  assert.equal(legacy.eval("activeSession().mode"), "review");
  const legacyId = legacy.eval("activeSession().progress.attempts[0].recordId");
  assert.equal(legacyId, harness(old).eval("activeSession().progress.attempts[0].recordId"), "legacy ID stable on reload");
  const legacyRestored = harness();
  legacyRestored.context.oldBackupFile = legacyRestored.file({ schema: "blind_listening_backup_v1", state: old });
  await legacyRestored.eval("importBackup(oldBackupFile)");
  assert.equal(legacyRestored.eval("activeSession().progress.attempts[0].recordId"), legacyId);

  const interruptedSource = JSON.parse(h.saved.get(KEY));
  interruptedSource.sessions[firstSession].progress.stage = "playing";
  interruptedSource.sessions[firstSession].progress.activeAttempt.playCount = 1;
  const interrupted = harness(interruptedSource);
  assert.equal(interrupted.eval("activeSession().progress.stage"), "ready");
  assert.equal(interrupted.eval("activeSession().progress.activeAttempt.partialAudio"), true);
  assert.equal(interrupted.eval("activeSession().progress.activeAttempt.overallStatus"), null, "refresh during playback is not a failure");
  assert.equal(interrupted.eval("activeSession().progress.attempts.length"), 0);

  const failed = harness();
  failed.setFailWrites(true);
  assert.throws(() => failed.eval("setActivePack(pack)"), /保存失败/);
  assert.equal(failed.eval("Object.keys(db.sessions).length"), 0, "failed import rolls back");
  assert.match(failed.element("storageWarning").textContent, /保存失败/);

  const twoItems = structuredClone(pack);
  twoItems.pack_id = "two-items-local-test";
  const secondItem = structuredClone(twoItems.items[0]);
  secondItem.id = "M02_INTERESTED_IN";
  secondItem.target = "interested in";
  secondItem.anchor_id = "M02_LOCAL_TEST";
  secondItem.candidates = [
    ["M02-Q1", "What are you interested in?", "initial"],
    ["M02-Q2", "Which field are you interested in?", "initial"],
    ["M02-Q3", "Are you interested in sales?", "fallback"]
  ].map(([id, text, content_role]) => ({ id, text, content_role, anchor_id: secondItem.anchor_id,
    variation_dimensions: [], variation_detail: null, work_reviewed: true }));
  twoItems.items.push(secondItem);
  const sameDay = harness();
  sameDay.context.pack = twoItems;
  sameDay.eval('now = () => "2026-10-10T03:00:00.000Z"');
  sameDay.eval("setActivePack(pack)");
  const sameSessionId = sameDay.eval("db.activeSessionId");
  sameDay.eval("selectCandidate(false)");
  sameDay.eval('activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.activeAttempt.overallStatus = "direct"; finishAttempt()');
  sameDay.eval("togglePause(); togglePause()");
  sameDay.eval("selectCandidate(false)");
  sameDay.eval('activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.activeAttempt.overallStatus = "direct"; finishAttempt()');
  assert.equal(sameDay.eval("db.activeSessionId"), sameSessionId);
  sameDay.eval("exportJson(false)");
  assert.equal((await sameDay.lastDownload()).sessions[0].attempts.length, 2, "same-day breaks keep one session");

  const interleaved = harness();
  interleaved.eval("setActivePack(pack)");
  const original = interleaved.eval("db.activeSessionId");
  interleaved.eval("startNewSession()");
  const createdBeforeExposure = interleaved.eval("db.activeSessionId");
  assert.equal(interleaved.eval("activeSession().mode"), "first_exposure");
  interleaved.context.original = original;
  interleaved.context.createdBeforeExposure = createdBeforeExposure;
  interleaved.eval('db.voice = {key: "Local English|en-US", approved: true}; db.activeSessionId = original; saveStore(); playSentence()');
  interleaved.eval("interruptAudio(); db.activeSessionId = createdBeforeExposure; saveStore(); playSentence()");
  assert.equal(interleaved.eval("activeSession().progress.activeAttempt.priorTargetExposure"), true,
    "interleaved sessions must recheck prior exposure at playback");
  interleaved.eval('activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.activeAttempt.overallStatus = "direct"; activeSession().progress.stage = "judged"; finishAttempt()');
  interleaved.eval("exportJson(false)");
  assert.ok((await interleaved.lastDownload()).sessions[0].attempts[0].app_observed.exposure_flags.includes("prior_target_exposure"));

  const oneClick = harness();
  oneClick.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'");
  oneClick.eval("chooseRating('direct')");
  assert.equal(oneClick.eval("activeSession().progress.stage"), "judged", "one tap saves judgment without a second save button");
  const afterJudgment = harness(JSON.parse(oneClick.saved.get(KEY)));
  assert.equal(afterJudgment.eval("activeSession().progress.activeAttempt.overallStatus"), "direct", "unfinished judged item survives refresh");
  const judgedBackupSource = harness(JSON.parse(oneClick.saved.get(KEY)));
  judgedBackupSource.eval("exportJson(true)");
  const judgedBackup = await judgedBackupSource.lastDownload();
  const judgedRestored = harness();
  judgedRestored.context.judgedBackupFile = judgedRestored.file(judgedBackup);
  await judgedRestored.eval("importBackup(judgedBackupFile)");
  assert.equal(judgedRestored.eval("activeSession().progress.stage"), "judged", "full backup preserves a one-tap saved judgment");
  afterJudgment.eval("startCorrection(); chooseRating('slow'); finishAttempt()");
  assert.equal(afterJudgment.eval("activeSession().progress.attempts.length"), 1, "correction does not duplicate the record");
  assert.equal(afterJudgment.eval("activeSession().progress.attempts[0].firstJudgment.understanding"), "direct");
  assert.equal(afterJudgment.eval("activeSession().progress.attempts[0].overallStatus"), "slow");
  afterJudgment.eval("exportJson(false)");
  const correctedExport = await afterJudgment.lastDownload();
  assert.equal(correctedExport.sessions[0].attempts[0].user_reported.first_judgment.understanding, "direct");
  assert.equal(correctedExport.sessions[0].attempts[0].app_observed.judgment_corrected, true);

  const replayed = harness();
  replayed.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 2; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; chooseRating('direct')");
  assert.equal(replayed.eval("activeSession().progress.activeAttempt.overallStatus"), "slow", "replay maps understood to delayed understanding");
  replayed.eval("finishAttempt(); exportJson(false)");
  assert.ok((await replayed.lastDownload()).sessions[0].attempts[0].app_observed.exposure_flags.includes("replay_assisted"));

  const unknown = harness();
  unknown.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; revealSpelling()");
  assert.equal(unknown.eval("activeSession().progress.activeAttempt.overallStatus"), "not_understood");
  assert.equal(unknown.eval("activeSession().progress.activeAttempt.difficultyType"), null, "answer before judgment records unknown reason");
  assert.equal(unknown.eval("activeSession().progress.activeAttempt.textShownBeforeJudgment"), true);
  unknown.eval("setWrittenCheck('recognized'); revealMeaning(); finishAttempt(); exportJson(false)");
  const unknownRecord = (await unknown.lastDownload()).sessions[0].attempts[0];
  assert.equal(unknownRecord.user_reported.written_check, "recognized");
  assert.equal(unknownRecord.app_observed.answer_shown, true);
  assert.ok(unknownRecord.app_observed.exposure_flags.includes("text_before_judgment"));
  assert.equal(unknownRecord.item_kind, "Chunk");
  assert.equal(unknownRecord.task_type, "chunk");

  const promptedCorrection = harness();
  promptedCorrection.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; chooseRating('target_sound'); startCorrection(); chooseRating('direct'); finishAttempt(); exportJson(false)");
  const promptedRecord = (await promptedCorrection.lastDownload()).sessions[0].attempts[0];
  assert.equal(promptedRecord.user_reported.first_judgment.difficulty, "target_sound");
  assert.equal(promptedRecord.user_reported.understanding, "direct");
  assert.ok(promptedRecord.app_observed.exposure_flags.includes("corrected_after_prompt"));
  assert.ok(!promptedRecord.app_observed.exposure_flags.includes("first_unprompted"), "correction after reading cannot become independent success");

  const unattempted = harness();
  unattempted.eval("setActivePack(pack); skipCurrent(); exportJson(false)");
  const skippedRecord = (await unattempted.lastDownload()).sessions[0].attempts[0];
  assert.equal(skippedRecord.user_reported.understanding, "skipped");
  assert.equal(skippedRecord.app_observed.play_count, 0);
  assert.equal(skippedRecord.app_observed.skip_reason, "not_attempted");
  assert.equal(unattempted.eval("activeSession().progress.stage"), "complete");

  const partial = harness();
  partial.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.partialAudio = true; activeSession().progress.stage = 'ready'; skipCurrent()");
  assert.equal(partial.eval("activeSession().progress.activeAttempt.overallStatus"), "not_understood", "active skip after listening is unknown failure");
  assert.equal(partial.eval("activeSession().progress.stage"), "spelling");

  const copy = harness(JSON.parse(afterJudgment.saved.get(KEY)));
  await copy.eval("copyRecords()");
  const copied = JSON.parse(copy.copied());
  assert.equal(copied.record_count, 1);
  assert.equal(copy.eval("db.acknowledgedRecordIds.length"), 0, "copy does not acknowledge");
  copy.element("confirmPaste").value = JSON.stringify({ ...copied, record_count: 999 });
  await copy.eval("confirmPasted()");
  assert.equal(copy.eval("db.acknowledgedRecordIds.length"), 0, "modified payload cannot be confirmed");
  copy.element("confirmPaste").value = JSON.stringify(copied);
  await copy.eval("confirmPasted()");
  assert.equal(copy.eval("db.acknowledgedRecordIds.length"), 1);
  await copy.eval("confirmPasted()");
  assert.equal(copy.eval("db.acknowledgedRecordIds.length"), 1, "repeat confirmation is idempotent");

  const manual = harness(JSON.parse(afterJudgment.saved.get(KEY)));
  manual.setClipboardFailure(true);
  await manual.eval("copyRecords()");
  assert.equal(manual.element("manualCopy").hidden, false);
  assert.equal(JSON.parse(manual.element("manualCopyText").value).record_count, 1, "manual fallback contains full JSON");

  const failedExport = harness(JSON.parse(afterJudgment.saved.get(KEY)));
  const pendingBeforeFailure = failedExport.eval("Object.keys(db.pendingExports).length");
  failedExport.setFailWrites(true);
  await failedExport.eval("copyRecords()");
  assert.equal(failedExport.copied(), null, "failed manifest save stops copying");
  assert.equal(failedExport.eval("Object.keys(db.pendingExports).length"), pendingBeforeFailure, "failed export keeps previous manifest state");

  const failedJudgment = harness();
  failedJudgment.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; saveStore()");
  failedJudgment.setFailWrites(true);
  failedJudgment.eval("chooseRating('direct')");
  assert.equal(failedJudgment.eval("activeSession().progress.stage"), "rating", "failed local save rolls back judgment");
  assert.equal(failedJudgment.eval("activeSession().progress.activeAttempt.overallStatus"), null);

  const conflict = harness();
  conflict.eval("setActivePack(pack)");
  const changedPack = structuredClone(pack);
  changedPack.items[0].candidates[0].text = "Please turn on the light.";
  conflict.context.changedPack = changedPack;
  assert.throws(() => conflict.eval("setActivePack(changedPack)"), /已有不同内容/);
  changedPack.pack_id = "different-pack-same-candidate-id";
  assert.throws(() => conflict.eval("setActivePack(changedPack)"), /候选句编号已被其他内容使用/);
  assert.equal(conflict.eval("Object.keys(db.sessions).length"), 1, "conflicting import preserves old session");

  const tooLong = harness();
  tooLong.eval("setActivePack(pack); selectCandidate(false); activeSession().progress.activeAttempt.playCount = 1; activeSession().progress.activeAttempt.audioCompleted = true; activeSession().progress.stage = 'rating'; chooseRating('direct'); finishAttempt()");
  tooLong.eval("activeSession().progress.attempts[0].note = 'x'.repeat(70000); saveStore()");
  await tooLong.eval("copyRecords()");
  assert.equal(tooLong.copied(), null, "oversize report is not truncated into clipboard");
  assert.match(tooLong.element("dataStatus").textContent, /没有截断/);
  tooLong.eval("exportJson(false)");
  assert.equal((await tooLong.lastDownload()).sessions[0].attempts[0].user_reported.note.length, 70000);

  const legacyReasonSource = JSON.parse(oneClick.saved.get(KEY));
  const pendingSession = legacyReasonSource.sessions[legacyReasonSource.activeSessionId];
  pendingSession.progress.stage = "reason";
  pendingSession.progress.activeAttempt.overallStatus = "not_understood";
  pendingSession.progress.activeAttempt.draftReason = "target_sound";
  delete pendingSession.progress.activeAttempt.firstJudgment;
  const legacyReason = harness(legacyReasonSource);
  assert.equal(legacyReason.eval("activeSession().progress.stage"), "spelling", "old unfinished reason step resumes in new feedback flow");
  assert.equal(legacyReason.eval("activeSession().progress.activeAttempt.firstJudgment.source"), "legacy_pending_reason");
  assert.equal(legacyReason.eval("activeSession().progress.attempts.length"), 0, "legacy pending item is not silently finalized");

  const voiceConsent = harness();
  voiceConsent.eval("db.allowRemoteVoice = true; saveStore()");
  const reopenedVoice = harness(JSON.parse(voiceConsent.saved.get(KEY)));
  assert.equal(reopenedVoice.element("allowRemoteVoice").checked, true, "explicit remote voice choice survives refresh");
}

run().then(() => console.log("PASS")).catch(error => { console.error(error); process.exitCode = 1; });
