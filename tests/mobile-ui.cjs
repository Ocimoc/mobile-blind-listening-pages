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
    browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
    await context.route("https://blp.test/**", route => {
      const name = new URL(route.request().url()).pathname;
      if (!types[name]) return route.fulfill({ status: 404, body: "" });
      const file = path.join(root, name === "/" ? "index.html" : name.slice(1));
      return route.fulfill({ status: 200, contentType: `${types[name]}; charset=utf-8`, body: fs.readFileSync(file) });
    });
    await context.addInitScript(() => {
      const voice = { name: "Local English", lang: "en-US", localService: true };
      Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
        getVoices: () => [voice], cancel() {}, speak(utterance) { setTimeout(() => utterance.onend?.(), 20); }
      } });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    });
    const page = await context.newPage();
    await page.goto("https://blp.test/");
    assert.equal(await page.locator("#homeTitle").innerText(), "还没有训练包");
    await page.locator("#homeAction").click();
    assert.equal(await page.locator("#materialsView").isVisible(), true);
    await page.locator("#packPaste").fill(JSON.stringify(pack));
    await page.locator("#importPastedPack").click();
    assert.equal(await page.locator("#trainView").isVisible(), true);
    await page.locator("#previewVoice").click();
    await page.locator("#approveVoice").click();
    assert.equal(await page.locator("#trainerCard").isVisible(), true);
    await page.locator("#playSentence").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    if (process.env.BLP_SCREENSHOT) await page.screenshot({ path: process.env.BLP_SCREENSHOT, fullPage: true });
    assert.equal(await page.locator("#ratingPanel .choice").count(), 3);
    assert.equal(await page.locator("#spellingPanel").isVisible(), false);
    await page.locator('[data-rating="not_understood"]').click();
    assert.equal(await page.locator("#spellingPanel").isVisible(), true);
    assert.equal(await page.locator("#answerPanel").isVisible(), false);
    assert.match(await page.locator("#revealedText").innerText(), /Please turn on the light/);
    if (process.env.BLP_FEEDBACK_SCREENSHOT) await page.screenshot({ path: process.env.BLP_FEEDBACK_SCREENSHOT, fullPage: true });
    await page.locator("#optionalDiagnosis summary").click();
    await page.locator('[data-written="recognized"]').click();
    await page.locator('[data-reason="target_sound"]').click();
    await page.locator("#revealMeaning").click();
    assert.equal(await page.locator("#answerPanel").isVisible(), true);
    await page.locator("#answerPanel [data-correct]").click();
    await page.locator('[data-rating="slow"]').click();
    await page.locator("#answerPanel [data-play-next]").click();
    assert.equal(await page.locator("#completePanel").isVisible(), true);
    await page.locator("#goRecords").click();
    assert.equal(await page.locator("#materialsView").isVisible(), true);
    if (process.env.BLP_MATERIALS_SCREENSHOT) await page.screenshot({ path: process.env.BLP_MATERIALS_SCREENSHOT, fullPage: true });
    await page.locator("#copyRecords").click();
    await page.waitForFunction(() => /已复制完整|复制失败/.test(document.getElementById("dataStatus").textContent));
    assert.match(await page.locator("#dataStatus").innerText(), /已复制完整/);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const report = JSON.parse(copied);
    assert.equal(report.record_count, 1);
    assert.equal(report.sessions[0].attempts[0].user_reported.first_judgment.understanding, "not_understood");
    assert.equal(report.sessions[0].attempts[0].user_reported.understanding, "slow");
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
    assert.equal(await page.locator("#judgedPanel").isVisible(), true);
    await page.reload();
    assert.equal(await page.locator("#judgedPanel").isVisible(), true, "demo judgement survives refresh");
    await page.locator("#judgedPanel [data-play-next]").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    assert.match(await page.locator("#progressLabel").innerText(), /第 2 项/);
    await page.locator('[data-rating="not_understood"]').click();
    assert.equal(await page.locator("#spellingPanel").isVisible(), true);
    await page.locator("#answerPanel").waitFor({ state: "visible", timeout: 6000 });
    await page.locator("#answerPanel [data-play-next]").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    assert.match(await page.locator("#progressLabel").innerText(), /第 3 项/);
    await page.locator("#replaySentence").click();
    await page.locator("#ratingPanel").waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-rating="direct"]').innerText(), "重听后懂了");
    assert.equal(await page.locator('[data-rating="slow"]').isVisible(), false);
    await page.locator('[data-rating="direct"]').click();
    assert.equal(await page.evaluate(() => activeSession().progress.activeAttempt.overallStatus), "slow");
    const priorDemoSession = await page.evaluate(() => activeSession().sessionId);
    await page.locator("#restartDemo").click();
    assert.notEqual(await page.evaluate(() => activeSession().sessionId), priorDemoSession);
    assert.equal(await page.evaluate(() => activeSession().progress.itemIndex), 0);
    await page.goto("https://blp.test/index.html");
    assert.equal(await page.locator("#demoBanner").isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("english-blind-listening-v1")), normalStore);
    await context.close();
    console.log("PASS mobile UI simulation");
  } finally {
    await browser?.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
