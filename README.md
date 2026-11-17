# 点式交付：旧字段拆分、双合同与可审计缺失

一个可运行的虚构数据管道，用来回答一个具体问题：

> 旧字段 `legacy_segment` 要拆成 `country_code` 与 `region_code`。部分历史值无法无损拆开，下游的升级节奏又不同。旧合同不能悄悄改变含义，新合同也不能把猜测值当作完整值。那么某一条记录，在各合同中实际是什么值？缺失的那部分，依据是什么？

答案不是一段说明文字，而是页面里可点开的记录轨迹：同一行记录，v1 交付什么、v2 交付什么（或为什么被隔离 / 排除），以及每一步的理由。

```bash
npm start      # http://localhost:4173
npm run demo   # 在终端跑完整个七步故事
npm test       # 65 个测试：拆分规则 + 合同不变式 + 交付/回填语义
```

零依赖：Node 24 内置 `node:sqlite`、`node:http`，前端为原生 HTML/CSS/JS，无构建步骤。

---

## 一、模型

### 三方 + 一个审计面

| 角色 | 在这个实现里 | 职责 |
|---|---|---|
| 接入器 | `POST /api/ingest` → `ingestBatch` | 入库时立刻预检；结构性问题在入口就挂起批次，不等人发现 |
| 字段迁移服务 | `runPreflight` / `projectRecord` / `startBackfill` | 只做能证明的拆分；投影带 `source_hash`、`basis` 与修订号 |
| 旧订阅端 | `legacy-ledger` | 只支持 v1，永远收到原始字符串 |
| 新订阅端 ×2 | `geo-router`（严格）、`risk-scoring`（可隔离） | 必须显式切换；对 `needs_review` 有各自的策略 |
| 审计面 | `records` / `decisions` / `deliveries` / `events` | 原值不改写；每次投影与交付都可追溯 |

### 一条记录的状态机

```
入库 → split_status = NULL（未投影）
        │
        ├─ resolved      两个字段都有可信来源
        ├─ needs_review  规则无法证明唯一解；必须带 reason_code + basis，v2 中 region_presence = unknown
        └─ blocked       源值本身不可用（空、占位符、多值、保留码）；不进入 v2
```

关键决定：**`region_presence` 有三个值，而不是两个。**

- `present` —— 地区码存在且有据可查；
- `absent` —— 原值本身就只到国家一级（`US`），"没有地区" 是事实；
- `unknown` —— 无法判断（`CA` 可能是国家也可能是美国加州）。

v1 合同把 `absent` 和 `unknown` 压成同一个字符串，这是它已知的语义，也是 v2 存在的理由。**这个区分就是整个方案的核心。**

### 拆分规则：证明，或者交给人

`src/splitter.js` 只做可证明的转换，规则全在 `src/catalog.js` 里显式登记：

- 精确匹配 ISO 3166-2 的子区码 → `resolved`
- 裸两字母码同时落在国家码与州码交集（`CA`、`DE`、`IN`…）→ `needs_review / BARE_CODE_COLLISION`，给出至少两个候选解释，**永远不选一个**
- 三字母国家码、大小写、空白、别名 → 各自有独立的 `reason_code`，因为它们的风险不同
- 占位符、空值、多值、保留码 → `blocked`，不投递

每条结果都带一句中文 `basis`，写明"证明了什么、没证明什么"。测试里强制断言 `basis` 非空。

---

## 二、两版合同

两版同时发布、各自计算 SHA-256（canonical JSON）。页面上并排展示，可核对完整哈希。

**v1 `pointwise.segment@1`** —— 冻结。字段只有 `record_id / legacy_segment / ingested_at`；合同文本自己声明"不区分没有地区与地区无法解析"。哈希被钉在测试里（`test/contracts.test.js`），改动会立刻失败。

**v2 `pointwise.segment@2`** —— 显式缺失。除两个位置字段外，强制要求 `split_status / region_presence / reason_code / provenance / basis / source_hash`。不变式包括：

1. `resolved` ⇒ 国家码非空；
2. `resolved` 且 `region_code=null` ⇒ `region_presence` 必须是 `absent`；
3. `needs_review` ⇒ `region_presence` 必须是 `unknown`，且 `reason_code`、`basis` 非空；
4. 任何 `null` 都不得表示"转换失败"——失败必须在 `split_status` 与 `reason_code` 里显式出现。
5. `needs_review` 记录不得同时携带 `country_code` / `region_code`：否则消费端会把半猜测当成值。
6. `source_hash` 必须是 64 位小写十六进制，`region_code` 必须匹配 `^[A-Z0-9]{1,3}$`——schema 里声明的约束在校验器里真的执行，而不是只写在文档上。

`buildV2Bundle` 会先自检，再交给消费端；`validateV2Bundle` 返回可读的错误列表，而不是布尔值。

---

## 三、消费端怎样确认切换

不是"声明一下就切换"，而是一个绑定哈希的握手（`POST /api/consumers/:id/switch`）：

1. 迁移服务发布 v2，页面显示完整 SHA-256；
2. 消费端在页面输入它所确认的哈希前缀（≥12 位）；
3. 服务端把前缀与已发布的摘要比对：不一致直接拒绝，并在对话框里解释是哪一位不匹配；
4. 成功后记录 `contract_version`、完整 `contract_sha`、`switched_at`。

之后每次交付都会把 `contract_sha` 重新写进交付载荷。若合同在发布后被改动（哈希变化），旧订阅端下一次交付会发现不匹配，而不是静默按新语义解析。

**已发布记录与现行摘要分开显示。** 交付载荷的哈希由代码里的合同文档算出，`contracts` 表记录的是"当时交给消费端的是哪一版"。两者正常时相同；如果代码里的合同变了却没有重新发布，页面会把该版本标成"现行摘要与已发布记录不一致"，并同时列出两个哈希——不会只显示现行摘要，让一次未发布的变更看起来像正常发布。测试 `a contract whose current digest differs from its published record is reported as drifted` 覆盖这个状态；此时消费端也不能完成切换，交付会以 `CONTRACT_CHANGED` 拒收，而不是按新语义解析。

**迟到的确认不会改变订阅状态。** `POST /api/deliveries/:id/ack` 只写 `acked_at` 与 `ack_note`；`legacy-ledger` 在 300 分钟后确认 v1 交付，它的 `contract_version` 仍然是 1。测试 `late acknowledgement never changes subscription state` 对整个 consumer 对象做深比较。

---

## 四、怎样拒绝不兼容数据

v2 交付有三道门，按顺序，每道都返回具体代码而不是笼统失败：

| 门 | 代码 |
|---|---|
| 订阅门 | `NOT_SWITCHED`、`UNSUPPORTED_VERSION`、`SHA_UNCONFIRMED`、`CONTRACT_CHANGED` |
| 合同门 | `V2_BUNDLE_INVALID`（schema / 不变式不成立） |
| 批次门 | `BATCH_BLOCKED`、`BATCH_ON_HOLD`、`BACKFILL_INCOMPLETE`、`LOSSY_VALUES_PRESENT`、`REVIEW_SHARE_EXCEEDED` |
| 消费端策略门 | `STRICT_NO_QUARANTINE`、`STRICT_NO_EXCLUSION` |

两个消费端的策略差异是刻意的：

- `geo-router` 严格：本批出现任何待复核或需排除的记录 → 整批拒绝，代码区分是"数据不可靠"还是"我方无法隔离"；
- `risk-scoring` 宽松：接收整批，把 `needs_review` 放进隔离区并在回执里报数量。

**v1 交付完全不受这些门影响。** 批次被挂起或阻断时，`legacy-ledger` 照常收到原始字符串，原列也照常交付——这正是"保留原列"的意义：迁移失败不会让老流程断流。

**保留原列、增加无法转换状态、阻止特定批次，三种手段都在。** 阻断（`blockBatch`）只标记尚未处理的记录，已有投影保留；可解除（`unblockBatch`）并按当前规则/判定重新投影。暂缓（`setBatchHold`）把理由存在批次行上，拒收信息与页面都引用同一个理由。逐条人工判定（`applyDecision`）与按来源批量策略（`applyBatchPolicy`，**跳过已有独立判定的行**）作用于单条记录，不改写原始值。

**接入是原子的。** 批次行、记录行、预检与事件写在同一个事务里（`src/db.js` 的 `transaction`）。空批次或中途失败不会留下一个 `record_count = 0`、永远无法投影也无法交付的孤儿批次。

---

## 五、预检、回填与中断

**预检是只读快照。** `runPreflight` 只读 `legacy_segment` 原始值，计算规则视角下的分布、候选解释与策略检查，不写任何投影。因此它可以反复运行，结果稳定（测试 `preflight is read-only and repeatable`）。

**预检不等于当前状态。** 人工判定与回填会改变实际投影，所以页面同时显示 `preflightDrift`（预检后有多少条人工判定、多少条尚未投影），并在预检视图里写明差异。交付门读的是 `batchProjectionStats`（当前状态），不是预检报告。

预检报告还会记下生成它时的**规则集指纹**（`ruleset`）。如果拆分规则在预检之后被修改，旧报告就可能与今天的投影矛盾；此时页面会明确写出"规则集发生过变更"，把差异归因于规则，而不是伪装成一次人工判定。

**回填可中断、可恢复、不重复。** 游标是 `(target_batch, seq)`，只挑 `split_status IS NULL` 的行。中断后 `cursor_seq` 停在第 N 条，恢复时从 `seq > cursor_seq` 继续。测试断言：中断前已落盘的 7 条投影，恢复后 `projection_rev` 仍为 1，没有任何记录被投影两次。

回填按**批次 id** 定位，不按标签：标签只是展示文本，两个来源完全可能都叫「月度对账」，按标签查会静默回填其中一个。同一批次同时只允许一个未完成（running / interrupted）的回填，否则进度会分裂成两份账。

演示中 `离线表单导入 #B03` 预置为第 12 条后中断，可直接点"恢复"观察。

---

## 六、页面能做什么

五个视图，全部操作都会写 `events`：

1. **总览** —— 分布条（resolved / needs_review / blocked / pending）、批次卡、事件流；
2. **预检** —— 切批次、看规则视角与候选解释、逐条处置、入库新值；
3. **合同** —— 一键发布两版、并排对比、完整哈希、切换握手的步骤说明；
4. **消费端** —— 带哈希校验的切换对话框、交付与拒绝记录（代码翻成中文）、回填中断/恢复、一键"模拟迟到确认"；
5. **记录轨迹** —— 选中任意记录，看 v1 原值、v2 投影、`basis`、历史判定与下一步该谁做什么。尚未投递的记录会显示"按合同应有的值"并明确标注，而不是假装投递发生过。

轨迹视图里 `null` 不会显示成空白，而是一个带警示色的虚线标记，旁边直接给出 `region_presence` 与 `reason_code`——缺失本身是被记录的。

---

## 七、代码地图

```
src/db.js          schema、canonical JSON、SHA-256
src/catalog.js     原因码注册表、ISO 3166-2 子集、策略常量
src/splitter.js    纯函数拆分器（无数据库依赖，可单测）
src/contracts.js   两版合同文档、摘要、v2 不变式校验
src/service.js     预检、投影、判定、回填、交付、握手
src/server.js      node:http 路由 + 静态资源
src/cli.js         seed / reset / demo / state
public/            原生前端（无构建）
test/              65 个测试
```

数据落在 `data/lab.sqlite`，`npm run reset` 可重建。`public/fonts/` 内的字体为 OFL 授权，许可文本随字体附带。
