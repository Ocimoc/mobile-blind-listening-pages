"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");
const { simplePack: pack } = require("./fixtures.cjs");
const types = { "/": "text/html", "/index.html": "text/html", "/app.js": "text/javascript", "/styles.css": "text/css" };
async function run() {
  let browser;
  try {
    const downloadsPath = path.join(root, "..", "browser-downloads");
    fs.mkdirSync(downloadsPath, { recursive: true });
    browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", downloadsPath });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
    await context.route("https://blp.test/**", route => {
      const name = new URL(route.request().url()).pathname;
      if (!types[name]) return route.fulfill({ status: 404, body: "" });
      const file = path.join(root, name === "/" ? "index.html" : name.slice(1));
      return route.fulfill({ status: 200, contentType: `${types[name]}; charset=utf-8`, body: fs.readFileSync(file) });
    });
    await context.addInitScript(() => {
      const voice = { name: "Local English", lang: "en-US", localService: true };
      window.__spoken = [];
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
        getVoices: () => [voice], cancel() {}, speak(utterance) { window.__spoken.push(utterance.text); setTimeout(() => utterance.onend?.(), 20); }
      } });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    });
    const page = await context.newPage();
    await page.goto("https://blp.test/");
    assert.equal(await page.locator("#homeTitle").innerText(), "还没有训练包");
    await page.locator("#homeAction").click();
    assert.equal(await page.locator("#materialsView").isVisible(), true);
    if (process.env.BLP_DAY1_TRANSFER_PATH) {
      const longCode = fs.readFileSync(process.env.BLP_DAY1_TRANSFER_PATH, "utf8");
      assert.ok(longCode.length > 6000, "exercise a real long transfer code");
      await page.locator("#packPaste").fill(longCode);
      await page.locator("#importPastedPack").click();
      assert.equal(await page.locator("#trainView").isVisible(), true);
      assert.match(await page.locator("#homeSummary").innerText(), /第 1 天 · 第 1 包/);
      assert.equal(await page.locator("#trainNotice").isVisible(), true);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.locator("#homeAction").click();
    }
    await page.locator("#packPaste").fill("BLP1:broken");
    await page.locator("#importPastedPack").click();
    assert.equal(await page.locator("#importStatus").isVisible(), true);
    assert.match(await page.locator("#importStatus").innerText(), /导入失败/);
    await page.locator("#importPack").setInputFiles({ name: "training-pack.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(pack)) });
    await page.locator("#trainView").waitFor({ state: "visible" });
    assert.equal(await page.locator("#trainView").isVisible(), true);
    assert.equal(await page.locator("#trainNotice").isVisible(), true);
    await page.locator("#previewVoice").click();
    await page.locator("#approveVoice").click();
    assert.equal(await page.locator("#trainerCard").isVisible(), true);
    await page.reload();
    assert.equal(await page.locator("#trainerCard").isVisible(), true, "confirmed voice survives reload without another sample");
    assert.equal(await page.locator("#voiceCard").isVisible(), false);
    assert.match(await page.locator("#progressLabel").innerText(), /第 1 \/ 1 项/);
    await page.locator("#playSentence").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    if (process.env.BLP_SCREENSHOT) await page.screenshot({ path: process.env.BLP_SCREENSHOT, fullPage: true });
    assert.equal(await page.locator("#ratingPanel .choice").count(), 3);
    assert.equal(await page.locator("#spellingPanel").isVisible(), false);
    await page.locator('[data-rating="not_understood"]').click();
    assert.equal(await page.locator("#spellingPanel").isVisible(), true);
    assert.equal(await page.locator("#answerPanel").isVisible(), false);
    assert.match(await page.locator("#revealedText").innerText(), /Please turn on the light/);
    assert.deepEqual(await page.evaluate(() => window.__spoken), ["Please turn on the light.", "Please turn on the light."],
      "failure immediately replays the full sentence");
    await page.waitForFunction(() => activeSession().progress.activeAttempt.feedbackReplayCompletedCount === 1);
    await page.locator("#spellingPanel details").last().locator("summary").click();
    await page.locator("#replaySpellingSentence").click();
    await page.waitForFunction(() => activeSession().progress.activeAttempt.feedbackReplayCompletedCount === 2);
    assert.equal((await page.evaluate(() => window.__spoken)).at(-1), "Please turn on the light.");
    if (process.env.BLP_FEEDBACK_SCREENSHOT) await page.screenshot({ path: process.env.BLP_FEEDBACK_SCREENSHOT, fullPage: true });
    await page.locator("#optionalDiagnosis summary").click();
    await page.locator('[data-written="recognized"]').click();
    await page.locator('[data-reason="target_sound"]').click();
    await page.locator("#revealMeaning").click();
    assert.equal(await page.locator("#answerPanel").isVisible(), true);
    await page.locator("#answerPanel details summary").click();
    await page.locator("#replayAnswerSentence").click();
    await page.waitForFunction(() => activeSession().progress.activeAttempt.feedbackReplayCompletedCount === 3);
    assert.equal((await page.evaluate(() => window.__spoken)).at(-1), "Please turn on the light.");
    await page.locator("#answerPanel [data-correct]").click();
    await page.locator('[data-rating="slow"]').click();
    await page.locator("#answerPanel [data-play-next]").click();
    assert.equal(await page.locator("#completePanel").isVisible(), true);
    await page.locator("#goRecords").click();
    assert.equal(await page.locator("#materialsView").isVisible(), true);
    assert.match(await page.locator("#recordSummary").innerText(), /本机已完成 1 条题目，今天 1 条，待交回 1 条/);
    if (process.env.BLP_MATERIALS_SCREENSHOT) await page.screenshot({ path: process.env.BLP_MATERIALS_SCREENSHOT, fullPage: true });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#exportJson").click()
    ]);
    assert.equal(await download.failure(), null);
    assert.match(download.suggestedFilename(), /\.json$/);
    assert.equal(JSON.parse(fs.readFileSync(await download.path(), "utf8")).record_count, 1);
    assert.equal(await page.evaluate(() => db.acknowledgedRecordIds.length), 0, "downloading is not handoff confirmation");
    await page.locator("#copyRecords").click();
    await page.waitForFunction(() => /已复制今天|复制失败/.test(document.getElementById("dataStatus").textContent));
    assert.match(await page.locator("#dataStatus").innerText(), /已复制今天/);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const report = JSON.parse(copied);
    assert.equal(report.record_count, 1);
    assert.equal(report.sessions[0].attempts[0].user_reported.first_judgment.understanding, "not_understood");
    assert.equal(report.sessions[0].attempts[0].user_reported.understanding, "slow");
    assert.equal(report.sessions[0].attempts[0].app_observed.feedback_sentence_replay_count, 3);
    await page.locator("#confirmPaste").fill(copied);
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#confirmPasted").click();
    await page.waitForFunction(() => /已确认回传|确认失败/.test(document.getElementById("dataStatus").textContent));
    assert.match(await page.locator("#dataStatus").innerText(), /已确认回传/);
    const normalStore = await page.evaluate(() => localStorage.getItem("english-blind-listening-v1"));
    await page.goto("https://blp.test/index.html?demo=1");
    assert.equal(await page.locator("#demoBanner").isVisible(), true);
    assert.equal(await page.locator("#homeTitle").innerText(), "继续训练");
    assert.equal(await page.evaluate(() => activeSession().pack.evidence_scope), "operation_test_only");
    assert.equal(await page.evaluate(() => localStorage.getItem("english-blind-listening-v1")), normalStore,
      "demo must not change real training storage");
    await page.locator("#previewVoice").click();
    await page.locator("#approveVoice").click();
    await page.locator("#playSentence").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    await page.locator('[data-rating="direct"]').click();
    assert.equal(await page.locator("#answerPanel").isVisible(), true);
    assert.equal(await page.locator("#sentenceMeaning").innerText(), "台灯亮着。");
    assert.match(await page.locator("#targetFeedback").innerText(), /lamp：台灯/);
    if (process.env.BLP_ANSWER_SCREENSHOT) await page.screenshot({ path: process.env.BLP_ANSWER_SCREENSHOT, fullPage: true });
    await page.reload();
    assert.equal(await page.locator("#answerPanel").isVisible(), true, "demo judgement and meaning survive refresh");
    await page.locator("#answerPanel [data-play-next]").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    assert.match(await page.locator("#progressLabel").innerText(), /第 2 \/ 5 项/);
    await page.locator('[data-rating="not_understood"]').click();
    assert.equal(await page.locator("#spellingPanel").isVisible(), true);
    await page.locator("#answerPanel").waitFor({ state: "visible", timeout: 6000 });
    await page.locator("#answerPanel [data-play-next]").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    assert.match(await page.locator("#progressLabel").innerText(), /第 3 \/ 5 项/);
    await page.locator("#replaySentence").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-rating="direct"]').innerText(), "重听后懂了");
    assert.equal(await page.locator('[data-rating="slow"]').isVisible(), false);
    await page.locator('[data-rating="direct"]').click();
    assert.equal(await page.evaluate(() => activeSession().progress.activeAttempt.overallStatus), "slow");
    assert.equal(await page.locator("#answerPanel").isVisible(), true);
    const priorDemoSession = await page.evaluate(() => activeSession().sessionId);
    await page.locator("#restartDemo").click();
    assert.notEqual(await page.evaluate(() => activeSession().sessionId), priorDemoSession);
    assert.equal(await page.evaluate(() => activeSession().progress.itemIndex), 0);
    assert.equal(await page.locator("#trainerCard").isVisible(), true, "new round reuses the confirmed voice");
    assert.equal(await page.locator("#voiceCard").isVisible(), false);
    await page.goto("https://blp.test/index.html");
    assert.equal(await page.locator("#demoBanner").isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("english-blind-listening-v1")), normalStore);

    const challengePack = structuredClone(pack);
    challengePack.pack_id = "synthetic-mobile-new-sentence-challenge";
    challengePack.items[0].practice_flow = "adaptive_new_sentence_v1";
    challengePack.items[0].max_observations = 3;
    challengePack.items[0].candidates = [
      ["UI-INITIAL", "Please turn on the lamp.", "initial"],
      ["UI-CONTEXT", "Will you turn on the fan?", "relation_context"],
      ["UI-FORM", "Turn on the radio, please.", "form"],
      ["UI-SUPPORT", "Turn on the light.", "low_load_fallback"]
    ].map(([id, text, content_role]) => ({ id, text, content_role, anchor_id: pack.items[0].anchor_id,
      translation_zh: "虚构测试句。", variation_dimensions: [], work_reviewed: true }));
    await page.evaluate(() => localStorage.removeItem("english-blind-listening-v1"));
    await page.reload();
    await page.locator("#importPack").setInputFiles({ name: "challenge.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(challengePack)) });
    await page.locator("#previewVoice").click();
    await page.locator("#approveVoice").click();
    assert.match(await page.locator("#challengeStep").innerText(), /第 1 句/);
    await page.locator("#playSentence").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    await page.locator('[data-rating="not_understood"]').click();
    await page.locator("#revealMeaning").click();
    assert.equal(await page.locator("#answerPanel [data-play-next]").innerText(), "换句检验");
    await page.locator("#answerPanel [data-play-next]").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    assert.match(await page.locator("#challengeStep").innerText(), /第 2 句/);
    assert.equal((await page.evaluate(() => window.__spoken)).at(-1), "Will you turn on the fan?");
    await page.reload();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    await page.locator('[data-rating="direct"]').click();
    assert.equal(await page.locator("#answerPanel [data-play-next]").innerText(), "再换一句");
    await page.locator("#answerPanel [data-play-next]").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    assert.match(await page.locator("#challengeStep").innerText(), /第 3 句/);
    assert.equal((await page.evaluate(() => window.__spoken)).at(-1), "Turn on the radio, please.");
    await page.locator('[data-rating="direct"]').click();
    await page.locator("#answerPanel [data-play-next]").click();
    assert.equal(await page.locator("#completePanel").isVisible(), true);
    assert.deepEqual(await page.evaluate(() => activeSession().progress.attempts.map(attempt => attempt.candidateId)),
      ["UI-INITIAL", "UI-CONTEXT", "UI-FORM"]);
    await context.close();
    console.log("PASS mobile UI simulation");
  } finally {
    await browser?.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
