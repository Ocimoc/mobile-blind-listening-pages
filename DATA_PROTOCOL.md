# 训练数据与 Work 接收约定

此文件描述网页**实际输出**。界面判断是原始证据；长期掌握、复习间隔和泛化结论由 Work 另行推断，不写回旧记录。网页不会把旧词库的预测分组变成个人实测。

## 输入训练包

沿用 `schema_version: 1`。`pack_id` 标识材料，`session_id` 由网页独立生成。每个 item 沿用 `id`、`kind`（`Word`、`Chunk`、`Frame`）、`target`、`training_focus`、`session_goal`、`use_anchor`、`anchor_id`、`feedback`、`candidates` 等字段。可新增可选 `task_type`：`word`、`chunk`、`in_sentence_recognition`、`sentence_understanding`；旧包未提供时按 `kind` 推断。`feedback.details` 可提供额外说明，必须是字符串。每条候选句可提供 `translation_zh`，只用于显示对应原句的完整中文意思；缺少时网页明确提示，不会拿目标释义代替。重新导入同编号且只补该字段的包，会更新会话所持材料，不改已完成练习记录。

每个候选句仍须完整、含目标、编号不重复且经过 `work_reviewed: true`。相同 `pack_id` 的不同内容会拒绝导入；旧候选句编号若对应不同文本也会拒绝。重复导入同一包会继续已存轮次，不删除历史。导入区不会预览英文目标句。

## 本地进度与判断

`index.html?demo=1` 使用独立的 `english-blind-listening-demo-v1` 本地存储键和虚构训练包，`evidence_scope: operation_test_only`。它用于试按钮与传输流程，不作为真实学习证据，也不会读取或改写正式训练键 `english-blind-listening-v1`。

本地存储仍使用 `english-blind-listening-v1` 和 `version: 2`，旧备份与旧轮次继续读取。当前题在 `activeAttempt` 中保存，所以点击判断、暂停或刷新后不会自动产生新的失败记录。完成当前题并进入下一句时，才把它写入 `attempts`，赋予稳定 `recordId`。同一题纠正误触只更新一个当前题，保留 `firstJudgment` 和 `judgmentCorrected`。若在答题前看英文，自动保存 `not_understood`、未知原因和 `textShownBeforeJudgment`；若听前跳过，保存 `skipped`、`skipReason: not_attempted`、`playCount: 0`。播放后主动跳过记为未懂、未知原因。自动暂停、切 App、音频中断不会创建 Fail。

## 增量回传

仍输出 `blind_listening_increment_v2`，只含尚未确认回传的**已完成记录**。默认“下载今天记录”只选手机本地日期为当天的未确认记录，并增加可选 `selected_local_date` 字段；“下载全部待交回记录”沿用旧行为，包含所有日期的未确认记录。两种导出都不要求先确认旧文件，也不删除原始记录。`record_id` 用于 Work 去重，`pack_id`、`session_id`、`local_date` 和时间戳用于跨天、跨轮次整理；`content_role`、`variation_dimensions`、`candidate_reuse_guard_ids` 用于区分旧句、新句和变化维度。

每条记录继续包含旧字段 `user_reported.understanding/difficulty/note` 和 `app_observed.play_count/replay_count/audio_completed/partial_audio/sentence_text_shown/support_used/exposure_flags`。新记录另外包含：

| 字段 | 含义 |
| --- | --- |
| `item_kind`, `task_type`, `target`, `training_focus`, `session_goal`, `use_anchor`, `anchor_id` | 当次任务与语境；不要把词、块、句中识别和整句理解合并为同一能力证据。 |
| `user_reported.first_judgment` | 第一次主动判断及时间；旧记录为 `null`，不补猜。 |
| `user_reported.written_check` | `recognized`、`not_recognized` 或 `not_checked`；未检查不等于看字不认识。 |
| `app_observed.text_before_judgment`, `answer_shown`, `judgment_corrected`, `skip_reason` | 提示、答案、纠正和跳过的实际过程。 |
| `app_observed.feedback_sentence_replay_count`, `feedback_sentence_replay_completed_count`, `feedback_voices_used` | 判断之后整句重读的开始次数、完成次数和所用声音，包含判断后自动重读与手动点“再听整句”；与盲听阶段的 `play_count`／`replay_count` 分开。旧记录缺少时保持未知。 |
| `app_observed.selected_at`, `judged_at`, `recorded_at` | 选中材料、判断和完成记录的时间。 |

`understanding` 在新记录中为 `direct`、`slow`、`not_understood` 或 `skipped`。主界面只让用户选择“马上懂了／后来才懂／还没懂”。没懂的具体原因可在英文反馈中自愿补充：`target_sound`、`target_meaning`、`integration`；未选为 `null`。旧记录原值不改写。首次播放后“马上懂了”记 `direct`；重听后这个按钮改为“重听后懂了”，记 `slow`，同时保留 `replay_count`。提示后才改成“懂”会保留原判断，并带 `text_before_judgment` 或 `judgment_corrected` 等标记，不能当独立盲听成功。

点“马上懂了”或“重听后懂了”后，原句、逐句中文和学习点立即显示，`answer_shown` 记为真；点“还没懂”后，逐句中文在整句重读后自动显示，或由用户提前点击显示。旧记录的 `answer_shown` 不回填。

`exposure_flags` 中 `first_unprompted` 描述首次无提示听的条件，不等于“掌握”；`replay_assisted`、`text_before_judgment`、`answer_revealed`、`post_feedback_immediate`、`review_session`、`prior_target_exposure` 等标记会限制后续解释。旧记录缺少新字段时应当视为“未记录／未知”，不能补推断。

新版在三种判断后自动重读**原完整句子**一次；“再听整句”按钮也播放原句。不会自动或单独朗读目标词。判断后的重读另记 `sentence_audio_after_judgment` 与 `feedback_sentence_replay`；不改变首次判断和盲听重播次数。旧记录中已经存在的 `target_audio` 原样保留，不能改写成整句重听。

## 复制、确认与备份

同一范围的复制与下载使用同一完整增量 JSON，不截断。`export_id`、`record_count`、记录 ID 顺序和 `payload_checksum` 用于网页核对用户粘贴回来的**原始完整文件内容**。这个校验值用于发现意外改动，**不是服务器签名，也不能证明 Work 已收到**。目前没有 Work 端回执协议，因此用户只有在 Work 真正接收并核对后才手动确认。旧导出清单没有校验值时仍按原有记录 ID 规则处理。重复发送请 Work 按 `record_id` 去重；确认失败保留待回传状态。

`blind_listening_backup_v2` 是单独的完整备份，包含训练包、进度、旧记录和回传状态，不当作每日增量发送。恢复只接受没有任何轮次的浏览器环境，或在旧存储损坏且用户确认时覆盖；不会静默覆盖现有历史。
