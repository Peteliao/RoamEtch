# P0-4 iOS 真机与内存基线矩阵

状态：**全部 pending（0/64）**。本文件定义执行与取证契约，不表示真机已经通过。
不得用 Playwright WebKit、iPhone 模拟器、桌面 Chromium CDP 指标或 synthesized
结果填写 `ios-evidence.json`。当前刻意不创建该证据文件；缺失证据时校验必须失败。

## 1. 两种基线的边界

| 基线 | 执行环境 | 测量来源 | 用途 |
| --- | --- | --- | --- |
| Chromium 合成内存回归 | production preview + Playwright Chromium | CDP `Performance.getMetrics` | 每次变更的可重复回归 |
| iOS 真机发布门槛 | 物理 iPhone + Safari / 主屏幕 PWA | Xcode Instruments、MetricKit、设备日志 | 发布前 P0-4 证据 |

Playwright 的 `devices['iPhone 13']` 只改变 WebKit 的视口、UA 和触摸模拟；
它既不是 iOS，也不会产生 Safari 的进程内存、jetsam、系统终止或存储配额行为。
`npm run test:memory` 的结果**不能**作为真机证据，也不推断 Safari 内存数值。
每个场景把 CDP 基线、峰值、增量、阈值、计数和 pageerror/crash 结果写入
`test-results/memory/reports/`，同时作为 JSON reporter 附件保存；该目录被 Git 忽略。

### 1.1 Chromium 回归基线（2026-11-27）

环境：Windows x64、Chromium 159.0.8154.6、430×932 视口、production preview。
构建指纹：`sha256:f78c622b7be4e07a3f8a5b0a7aeafe307ecd84a1a7340fd5e1ae126ce8ae789f`。
每个场景在开始前和最终采样前执行 GC；瞬时峰值按 75 ms 间隔采样并等待所有在途请求。

| 场景 | 输入 | 峰值 JS heap | Task 增量 | GC 后保留节点增量 | 结果 |
| --- | --- | ---: | ---: | ---: | --- |
| `cold-start` | 3 × 20,000 点 | 18.92 MiB | 0.977 s | +5 | 通过 |
| `health-check` | 20,000 点 | 12.82 MiB | 0.444 s | +46 | 通过 |
| `gps-preview-repair-restore` | 20,000 点，修复 3 点后恢复 | 71.42 MiB | 2.633 s | -234 | 通过 |
| `recording-recovery` | 20,000 点 + 400 spill | 17.26 MiB | 0.946 s | -9 | 通过 |

对应预算分别为 220 / 300 / 350 / 220 MiB heap，12 / 15 / 30 / 15 s Task；
非分析场景保留节点上限为 6,000，GPS 分析视图为 240,000。逐场景 JSON 由测试生成，
CI 失败时上传。这些数值只用于回归比较，不构成 iOS 内存、jetsam 或生命周期结论。

## 2. 固定矩阵（64 个必需单元）

两个环境均须测试 Safari 与 PWA，因此 `2 环境 × 2 模式 × 16 场景 = 64`。

| 环境 | 物理设备 | RAM | OS | 模式 |
| --- | --- | --- | --- | --- |
| `legacy-low-memory` | iPhone SE (2nd generation)，硬件 UDID | 3 GB | 最低受支持正式 iOS | Safari、PWA |
| `current` | 发布时实际在售的当前代物理 iPhone，记录准确型号 | 至少 8 GB | 发布时最新正式 iOS | Safari、PWA |

- “最低”是项目承诺支持的 iOS 下限，不是“能开机的最旧系统”。执行前由 release
  owner 确认。若以 iOS 16 作为兼容基线，iPhone SE (2nd generation) 的
  **iOS 16.7.12 是候选维护版**，仍须核对 Apple 发布说明、设备签名状态和项目支持策略；
  在确认前不得把候选版本写成已核验策略。
- “最新”不能固定写死。每次发布前从 Apple 官方 iPhone 系统更新/安全发布说明核实
  正式版本与 build，并记录 URL 和核验时间；不使用 beta。
- 不让旧 SE2 安装其不支持的“最新 iOS”，也不把“旧机 + 最低”替换成当前机。
- PWA 必须通过 HTTPS 添加到主屏幕并以 standalone 启动；Safari 必须处于 browser
  模式。记录 display mode、URL、应用版本和是否使用已有缓存。

| 场景 ID | 每个模式必须执行的步骤 | 核心通过条件 |
| --- | --- | --- |
| `cold-start` | 预置数据后彻底结束进程，冷启动并打开最近行程 | 无崩溃；行程/预览计数正确；记录启动时长与峰值 |
| `large-track` | 导入/打开至少 20,000 点轨迹，缩放、拖动、查看数据 | 预览有界、无卡死；点数一致；DOM/内存有界 |
| `health-check` | 在大轨迹上运行存储完整性检查 | 问题计数准确；检查前后数据完全不变 |
| `gps-cleaning` | 对 20,000 点夹具预览并清洗已知 3 点异常簇 | 原始快照 20,000；清洗后 19,997；无数据丢失 |
| `gps-restore` | 从上一步快照恢复，再核对预览与数据库 | 恢复 20,000；快照保留；结果一致 |
| `recording-recovery` | paused/recording 行程预置 400 条新鲜 spill 后冷启动 | 恢复至 20,400；spill 清除；预览最多 500 |
| `large-backup` | 至少 20 份媒体、40 MiB 媒体载荷，导出并恢复至少 50 MiB 归档 | 归档/恢复计数和哈希一致；无崩溃 |
| `offline` | 缓存完成后断网冷启动，打开轨迹、照片和导出 | 核心功能可用；明确记录降级；无假成功 |
| `lock-screen` | 录制中锁屏，等待真实采样间隔后解锁 | 状态和点数真实一致；按产品策略记录暂停/继续 |
| `background` | 切后台、切换应用、返回，覆盖 Safari 与 PWA | 无静默丢点；记录 OS 实际授予的执行时间 |
| `incoming-call` | 录制中用第二台真实电话呼入，接听、保持后挂断并返回应用 | 至少一次真实来电；记录恢复前后点数、采样间隔与录音状态，`recordingResumed: true` |
| `network-switch` | 录制中在 Wi‑Fi、蜂窝、飞行模式之间至少切换两次，并让定位暂时停止后恢复 | 网络状态即时变化；心跳不能刷新 GPS 新鲜度；至少两次真实切换，`locationFreshnessSeparated: true` |
| `app-update` | 从上一正式版开始录制并留下 spill，再更新到当前候选 Web 资源/SW，重载或重启 PWA | 当前候选指纹生效；迁移与 spill 恢复成功，`updateInstalled: true`、`spillRecovered: true` |
| `quota` | 专用可重置设备/Profile 填至真实配额边界，触发 `QuotaExceededError` | 用户可见降级；已有数据不损坏；测试后清理 |
| `memory-pressure` | Instruments 施加受控压力或触发真实 OS warning | 有真实 pressure 事件；界面恢复且数据一致 |
| `system-termination` | 录制/处理中由 OS 终止（不是手动关页），再冷启动 | 有真实终止及恢复证据；核对 spill/数据库 |

媒体内容应使用可重复的合成 fixture，备份规模是发布门槛，不是默认每次开发测试。
配额、锁屏、后台、内存压力和系统终止必须在物理设备上执行；脚本注入事件只能
作为辅助日志，不能冒充 OS 事件。

## 3. 证据采集与字段

每条 run 写入 `docs/qa/ios-evidence.json`，结构以
[`ios-evidence.schema.json`](ios-evidence.schema.json) 为准，并由
`scripts/verify-ios-evidence.mjs` 做语义校验。

必须记录：

- 全局：`schemaVersion: 1`、`matrixVersion: p0-4-v2`、`capturedAt`、`provenance`、构建指纹、
  `dist` 文件数和总字节数、最低/最新 iOS 的 version/build/source/verifiedAt。
  `capturedAt` 必须带时区且不得未来；默认有效期为 30 天，每条 run 的结束时间不得晚于它。
- 采集证明：`provenance.method` 只能是 `physical-device`，并记录 collector/collectorVersion、
  实际使用的来源列表和 Ed25519 attestation；synthesized 证据明确拒绝。
- 设备：tier、准确 model、硬件 UDID、RAM、`physical: true`。UDID 是设备标识，
  证据仓库只保留必要脱敏值，验证脚本要求 40 位十六进制或 `8-16` 分段格式。
- 执行：唯一 run ID、tester、开始/结束时间、Safari/PWA、browser/standalone、
  16 个场景之一、设备/OS 兼容配对。
- 数据：轨迹点数、媒体数量、媒体字节、备份归档字节。
- 结果：expected/actual 深比较值、`countsCorrect: true`、pageErrors/crashes/dataLoss、
  实际系统终止次数。failed、pending、blocked 都不能进入发布证据。
- 内存：source（`xcode-instruments`、`metric-kit` 或 `device-log`）、peakBytes、
  pressureEvents、jetsamEvents。不得填写 Chromium heap 估算值。
- 附件：至少一份截图/视频和一份日志/trace/Instruments/device-log；每份有安全相对
  路径和 SHA-256。保留 Instruments 模板/采样区间、MetricKit payload 或系统日志时间线，
  使峰值、压力、jetsam 和终止可以追溯。

`provenance.sources` 只能包含 `xcode-instruments`、`metric-kit`、`device-log`，且必须覆盖
每条 run 实际声明的 `memory.source`。`attestation` 格式为
`{ algorithm: "ed25519", keyId: "sha256:<64hex>", signature: "<base64>" }`：`keyId` 是可信
公钥 DER SPKI 编码的 SHA-256；签名覆盖除 attestation 自身外的完整证据，使用递归排序对象键、
无空白的 JSON 序列化（脚本导出 `canonicalizeIosEvidenceJson` 供采集方生成相同载荷）。
私钥不得进入仓库，证据文件也不能自行指定可信公钥。

发布方把 Ed25519 公钥的 base64 SPKI 编码存入仓库变量
`IOS_EVIDENCE_TRUSTED_PUBLIC_KEY`，或本地通过 `--trusted-public-key` 传入。验证方只接受该可信
密钥对应的 `keyId` 和有效签名；来源篡改、替换为攻击者密钥或 synthesized 方法都会失败。
有效期可用 `--max-age-days <days>` 或 `IOS_EVIDENCE_MAX_AGE_DAYS` 配置，release workflow 读取
同名仓库变量，未设置时使用 30 天。

建议附件目录：`docs/qa/evidence/<build-fingerprint>/<run-id>/`。大二进制可归档到发布
存储，但 JSON 中路径与 SHA-256 必须能由验证方取得。

## 4. 构建指纹与验证

先构建，再对**最终 `dist` 内容**计算指纹；证据不记录 commit SHA，避免文档提交
改变指纹的循环。指纹按 POSIX 相对路径排序，逐文件计算内容 SHA-256，再汇总
`path\0size\0fileHash\n`。不包含 mtime，因此提交文档不会改变它。

```sh
npm run build
npm run verify:ios-evidence -- --print-fingerprint
# 配置发布方可信公钥后，在真机完成全部 64 单元并生成有效签名：
npm run verify:ios-evidence -- --evidence docs/qa/ios-evidence.json --evidence-root docs/qa/evidence
```

`--evidence-root` 是发布门禁必填项；验证器逐份检查附件存在、为普通文件且 SHA-256 一致，
并拒绝通过符号链接逃逸证据目录的路径。仅有 JSON 中的哈希字段不能通过门禁。

有归档构建、本机没有对应 `dist` 时，可使用
`--fingerprint sha256:<64hex>` 验证内容身份，但仍需可信归档核对文件数/总字节数。
校验包括：64 单元齐全且唯一、设备/OS/模式/场景正确、物理设备和硬件 UDID、
构建指纹和 artifact 统计匹配、所有 run 通过、计数/异常约束、采集时间/TTL、可信来源与
Ed25519 provenance 签名、附件存在及哈希。

当前缺失 `ios-evidence.json` 时命令**预期退出 1**，这是 pending 的表现，不是
基础设施故障。`tests/iosEvidence.test.ts` 用合成 fixture 测试通过和拒绝路径；
fixture 只存在测试进程中，不会生成真机证据。

## 5. 执行顺序与发布门槛

1. 固定候选构建，记录指纹、设备型号/UDID、iOS version/build 和 Apple 来源。
2. Safari 先跑每个环境；再添加 PWA，明确区分已有缓存与首次安装。
3. 每个场景按上表预置数据、开始 Instruments/日志采集、执行、结束进程并核对结果。
4. 失败立即保留证据，不覆盖为 passed；修复后产生新 run 并重新计算构建指纹。
5. 64/64 通过且附件可验证后，才可把 P0-4 标记为完成。任何缺失单元、失败、
   模拟器冒充、指纹不符或数据丢失都会阻止发布门槛通过。

`.github/workflows/release.yml` 在最终构建之后、打包和创建 GitHub Release 之前无条件执行
`verify:ios-evidence`，并显式传入证据目录；门禁失败会同时阻止依赖它的镜像发布。普通 CI 与
GitHub Pages deploy 不调用此真机门禁，仍按各自流程运行。当前真实证据仍为 0/64，缺失证据、
可信公钥或附件时 release workflow 预期失败，不得用测试 fixture 替代。
