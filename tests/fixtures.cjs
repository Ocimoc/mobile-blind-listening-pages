"use strict";

// Synthetic operation fixtures only. No learner pack or record is stored here.
function makeCandidate(id, text, role, anchor = "TEST_DEVICE") {
  return { id, text, content_role: role, variation_dimensions: [], anchor_id: anchor, work_reviewed: true };
}
const pack = {
  schema_version: 1, pack_id: "synthetic-flow-test", evidence_scope: "session_observation",
  items: [{
    id: "TEST_TURN_ON", kind: "Chunk", target: "turn on", locked_meaning_or_function: "打开设备",
    training_focus: "合成测试", session_goal: "验证网页记录流程", use_anchor: "虚构设备操作",
    anchor_id: "TEST_DEVICE", max_observations: 2,
    feedback: { spelling: "turn on", meaning: "打开设备" },
    candidates: [
      makeCandidate("TEST-INITIAL", "Please turn on the lamp.", "initial"),
      makeCandidate("TEST-FALLBACK", "Could you turn on the fan?", "fallback")
    ]
  }]
};
const phonePack = structuredClone(pack);
phonePack.pack_id = "synthetic-transfer-test";
phonePack.evidence_scope = "operation_test_only";
const simplePack = structuredClone(pack);
simplePack.pack_id = "PHONE-TEST-20261010-B";
simplePack.evidence_scope = "operation_test_only";
simplePack.items[0].id = "T1";
simplePack.items[0].max_observations = 1;
simplePack.items[0].candidates = [makeCandidate("C1-20261010-B", "Please turn on the light.", "initial")];
const twoItemPack = structuredClone(simplePack);
twoItemPack.pack_id = "synthetic-two-item-flow";
twoItemPack.items.push({
  id: "TEST_BORROW", kind: "Word", target: "borrow", locked_meaning_or_function: "借入",
  training_focus: "合成测试", session_goal: "验证下一句直接播放", use_anchor: "虚构日常句",
  anchor_id: "TEST_BORROW_ANCHOR", max_observations: 1,
  feedback: { spelling: "borrow", meaning: "借入" },
  candidates: [makeCandidate("TEST-BORROW-SENTENCE", "Can I borrow the book?", "initial", "TEST_BORROW_ANCHOR")]
});

module.exports = { pack, phonePack, simplePack, twoItemPack };
