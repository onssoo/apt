# 葡语打卡 App 开工任务书（TASKS.md）

| 项目 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-10-07 |
| 依据 | DESIGN.md v1.4、CONTRACT.md v1.4（已按评审意见、机队事实、最终命名与坚持率分析修订） |
| 基线代码 | 第四轮交付的 index.html、sw.js、manifest.json、materials.json（8 课）、build_audio.py、tts_proxy.py |
| 本期目标 | 上线最小闭环 → 修补已知缺陷 → 内容工厂工具化 → 纯函数测试 |
| 不在本期 | 多设备同步、家长视图、录音上传、SM-2、IndexedDB 迁移、账号体系 |

---

## 命名口径（先对一遍，勿自创）

| 位置 | 值 |
|---|---|
| 站名 / App 主屏名 | **APT** |
| 仓库 | Gitea **`yourname/apt`**（private） |
| 域名 | **`apt.example.com`** |
| VPS 静态根目录 | `/var/www/apt` |
| 代理服务 | `apt-tts`（unit、env、StateDirectory 同名） |
| 代理环境文件 | `/etc/apt-tts.env`（600） |
| 代理缓存目录 | `/var/lib/apt-tts` |
| localStorage 键 | **`aptapp`**（初版曾用 `ptapp`，项目未部署，直接改净） |
| M2 上的仓库目录 | `~/apt` |

⚠️ **`pt-PT` 与 `pt-BR` 是语言标签，不在改名范围内**，谁看到都不要动。

---

## 0. 硬规则（每个任务都适用）

1. **零依赖**：不引入框架、构建步骤、npm 包、CDN、第三方脚本或字体。Python 脚本只用标准库；唯一例外是 `tools/qa_audio.py`，可以依赖 mlx-audio。
2. **密钥不入前端、不入仓库**：提交前运行 `tools/check_secrets.sh`，有命中就拒绝提交。
3. **向后兼容**：localStorage 键固定为 **`aptapp`**（见命名口径）。结构变更全部集中在 `migrate()` 一个函数里，按 `set.schema` 递增。项目尚未部署，不需要兼容 `ptapp`；但代码里必须留一个读旧键的兜底分支，防止有人已试用过早期版本。
4. **发布边界**：`site/` 里只放发布物，脚本放 `tools/` 和 `server/`。
5. **rsync 不带 `--delete`**。远端文件只由 `tools/clean_orphans.py` 显式清理。
6. **`/api/tts` 的缓存匹配不得使用 `ignoreSearch`**。忽略查询串会导致所有单词播同一段音频。其余页面类资源可以忽略。
7. **句子不走发音代理**。代理限 100 字符，课文句子超限会返回 400。句子降级链是「预生成音频 → 系统语音」，只有单词才走代理。
8. **真机验证**：每个前端任务都必须在 iPhone 的「主屏幕 App」模式下验证。桌面浏览器和模拟器的结果不算数。
9. **不要装 nginx，不要跑 certbot**。线上 VPS 已装**Caddy v2.11.4**并在跑 lababa 应用，80/443 已占。配置一律改 `/etc/caddy/Caddyfile`，改前必须备份，`caddy validate` 通过后才 reload。
10. **合成与质检只在 Mac mini M2 上跑**。VPS 只有 1.9 GiB 内存且已跑 Caddy + lababa + PostgreSQL，不要在上面跑音频合成或 Whisper。M2 地址 `100.64.0.2`，用户 `dail`。
11. **不需要添加 DNS A 记录**。`example.com` 已配泛解析 `*`，`apt.example.com` 自动生效，只需在 Caddyfile 加站点块。
12. **不要动已有的复习重排逻辑**。点「没记住」使 `box=0`、`due=今天` 并放回队尾，该词当轮必然再现直到点「记住了」。这是现状也是正确行为，**不需要也不允许**额外实现「一轮结束后重排错词」。
13. **`lapse` 与 `box` 语义不同，禁止一起清零**。`box` 是当前熟练度（决定下次复习日期），`lapse` 是历史累计失败次数（只增不减）。点「没记住」时 `box=0` 且 `lapse+=1`；听写判错只加 `lapse` 不动 `box`。任何情况下都不重置 `lapse`。
14. **冲突处理**：文档和代码冲突、或者文档没写到的地方，先停下来提问，不要自行决定。改了行为，要同步修改 DESIGN 和 CONTRACT。
15. **提交粒度**：一个任务一个 commit，提交信息以任务编号开头，例如 `M2-1: schema 4 migration`。

---

## 1. 仓库结构

```
apt/
├── site/                  # 发布单元 = rsync 源 = /var/www/apt/
│   ├── index.html
│   ├── logic.js           # M4-1拆出的纯函数
│   ├── sw.js
│   ├── manifest.json
│   ├── icon.png
│   ├── materials.json
│   └── audio/             # 构建产物，不入 git
├── tools/                 # 只在 Mac mini 上运行，不发布
│   ├── validate.py
│   ├── build_audio.py
│   ├── qa_audio.py
│   ├── voice_compare.py
│   ├── clean_orphans.py
│   ├── check_secrets.sh
│   └── test_logic.mjs
├── server/                # VPS 配置的副本
│   ├── tts_proxy.py
│   ├── aapt-tts.service
│   └── nginx-pt.conf.example
├── reports/               # 质检报告，不入 git
├── docs/
│   ├── DESIGN.md
│   ├── CONTRACT.md
│   ├── TASKS.md
│   └── acceptance.md
├── deploy.sh
├── .env.example           # AZURE_KEY= AZURE_REGION= VOICE= VOICE2= VPS=
└── .gitignore
```

`.gitignore` 至少包含：

```
.env
site/audio/
site/compare/
reports/
tools/.qa_cache/
*.wav
.DS_Store
```

**如果 coder 使用 Claude Code 这类工具**：把第 0 节（硬规则）复制一份到仓库根目录的 `CLAUDE.md`，它每次开工都会自动读到这些规则。

---

## 2. 已定默认决策（避免开工被卡住）

| 编号 | 事项 | 本期默认 |
|---|---|---|
| D1/T1 | 主声音 | 先用 Raquel；M1-3 盲听后再改 `.env` 的 `VOICE`，重跑构建 |
| D2 | 家长进度查看 | 不做 |
| D3 | 听写严格度 | 逐词三色 |
| D4/T10 | 存储 | 保留 localStorage，补写入失败捕获和备份提醒（M2-2） |
| D5 | 复习算法 | 固定间隔表 |
| D6 | 音频离线 | 手动「下载全部」，同时支持按需播放 |
| D7 | 录音上传 | 不做 |
| T2/T3 | 代理日限额 | 5000 字符，内存计数 |
| T4 | 代理令牌 | 不加 |
| T5 | `/api/` 访问日志 | `access_log off;` |
| T6 | 后端框架 | 代理保持标准库 |
| T7 | 仓库 | 私有远程仓库 |
| T8 | 孤儿音频 | `clean_orphans.py` 手动执行，默认只列出不删除 |
| T9 | 前端结构 | `index.html` 加 `logic.js` 两个文件，仍然不需要构建 |
| T11 | 反向代理 | **Caddy v2.11.4**（线上已装）。不装 nginx、不跑 certbot、不加限流插件 |
| T12 | 音频合成与质检位置 | **只在 Mac mini M2**（`100.64.0.2`）。VPS 1.9 GiB 不跑重活 |
| T13 | 仓库 | Gitea `yourname/apt`，**private**，托管在 2014 mini（`100.64.0.1:3001`） |
| T14 | DNS | 不动。`example.com` 泛解析已覆盖 `apt.example.com` |
| D8 | 每轮复习上限 | **30**，`set.revBatch` 可调 |
| D9 | 积压阈值 | **50**。超过则暂停新词、打卡改为「完成一轮」 |
| D10 | 每周达标天数 | **5**，`set.weekGoal` 可调 |
| D11 | 默认目标 | **新词 5 / 阅读 15 分钟**，之后让她自己往上调 |
| D12 | 快速听写句子来源 | 从她**读过的课文**里随机抽 5 句，只抽有音频的 |
| D13 | 复习反馈文案 | 显示「下次：N 天后」，**不显示「第 X 次」** |
| D14 | 错词本阈值 | `lapse >= 3` |

---

## 3. 里程碑与任务

**执行顺序：M0 → M1 → M2 → M5 → M3 → M4。** M5 插在 M3 之前，因为坚持率改进的价值高于内容工厂工具化。

### M0 基线入仓

| 任务 | 内容 | 验收 |
|---|---|---|
| M0-1 | 建仓（`~/apt`），把基线代码按第 1 节结构原样放好；把 `build_audio.py` 里的路径改成从仓库根目录运行（`site/materials.json`、`site/audio/`） | `python3 -m http.server -d site 8000` 能打开五个页面 |
| M0-2 | `.gitignore`、`.env.example`；`check_secrets.sh` 用 grep 检查 `site/` 和暂存区里有没有 32 位以上的十六进制串或 `Ocp-Apim`，并安装为 git pre-commit 钩子 | 故意写入一个假密钥，提交被拒 |
| M0-3 | **在 Gitea 建私有仓 `yourname/apt`**（`http://100.64.0.1:3001`，用户 `yourname`），description 写「APT — 葡语学习打卡 PWA（Ann 的葡萄牙语训练）」，按 `~/router/REPO-MAP.md` 登记流程加一行并打 topic `app`；把 Caddy 站点块样例存进 `server/caddy-apt.conf.example`。**仓库必须 private**（参照 lababa 是 public，本项目含 Azure 密钥相关配置） | 仓库可见性为 private；REPO-MAP 已登记 |

### M1 上线最小闭环

| 任务 | 内容 | 验收 |
|---|---|---|
| M1-1 | 改 `site/manifest.json` 与 `index.html` 的 meta：`name`/`short_name`/`apple-mobile-web-app-title` 一律 **`APT`**。写 `server/` 下三个文件。Caddy 示例要包含：`apt.example.com` 站点块；`root * /home/ubuntu/pt` + `file_server`；`@sw`（`/sw.js`）配 `no-cache, no-store, must-revalidate`；`@data`（页面与 json）配 `no-cache`；`@audio`（`/audio/*`）配 `immutable`；`@api`（`/api/*`）走 `reverse_proxy 127.0.0.1:8787`；并加 `log_skip /api/`。**注意 Caddy 无内建限流、不需要 ssl_certificate、不需要 certbot** | 文件可以直接追加到线上 Caddyfile 试用 |
| M1-2 | 按 CONTRACT 16.1 的顺序部署：建目录 → rsync 静态物（不带 `--delete`）→ 部署代理并本地 curl 自测 → **备份 `/etc/caddy/Caddyfile` 后追加 `apt.example.com` 块（不动 lababa 块）** → `caddy validate` → reload → 上传音频 | CONTRACT 17.1 的 I1–I10 全部通过 |
| M1-3 | `voice_compare.py`：3 个声音 × 2 段文本（一段叙述，一段对话），声音顺序随机，编号为 A/B/C，输出 `site/compare/index.html`，页面上不显示声音名（标题写 APT）；对应答案写到 `reports/compare_key.txt`，不发布 | 学生在手机上能播放并选出编号；选定后删除远端的 `compare/` |
| M1-4 | 用选定的声音为首批 8 课生成音频，并发布 | CONTRACT 17.2 的 C1–C4 通过；在真机上播放课文句子，确认是欧葡口音 |

### M2 前端修补（在基线index.html 上改）

| 任务 | 内容 | 验收 |
|---|---|---|
| M2-1 | **schema 4**：旧数据里的 `set.v3` 视为 schema 3。新单词的 id 改为字符串（`Date.now().toString(36)` 加随机 4 位），旧的数字 id 保留不动；`byId` 统一用 `String()` 比较，`onclick` 里的 id 要加引号。`words[].upd` 记录最后修改时间（毫秒），新增和复习判定时都要更新。删除单词时往 `D.del` 写入墓碑 `{id,t}`。所有迁移逻辑只写在 `migrate()` 里 | 用基线版导出的备份导入后，一切正常；再次导出的文件包含 `schema:4`；新旧 id 的词都能正常发音、删除和复习 |
| M2-2 | **防丢数据**：`save()` 加 try/catch，写入失败时显示红色横幅，提示「立即导出备份」。导出时记录 `set.lastExport`，超过 7 天没导出就在今日页显示提醒卡，当天可以关闭。启动时调用一次 `navigator.storage?.persist?.()`，不支持就忽略 | 手动模拟写入失败能看到横幅；把 `lastExport` 改成 8 天前能看到提醒卡 |
| M2-3 | **触控与字号**：所有按钮最小高度 44px；例句、生词释义等学习内容不小于 15px，新增 `.ex` 类，不要再借用 `.mu` | 在 iPhone 上逐页检查 |
| M2-4 | **降级链对齐 CONTRACT 8.1 和 6.2**：单词走「预生成音频 → `api/tts` → 系统语音」，句子走「预生成音频 → 系统语音」。任何失败都静默降级，不弹窗 | DESIGN A10；断网、代理停掉、返回 429 三种情况分别测试 |
| M2-5 | **系统语音提示**：异步检查 `speechSynthesis.getVoices()`（iOS 上需要监听 `voiceschanged` 事件）；没有 pt-PT 声音时，在设置卡里显示一次性提示，告诉她下载路径 | 删掉系统里的葡语声音后能看到提示 |
| M2-6 | **渲染安全**：课文的 id 不符合 `^L\d{2,}$` 就跳过不渲染；检查所有插值都经过 `esc()` | 在 materials.json 里注入 `<img onerror>`，页面不执行 |
| M2-7 | **跟读提示**：第一次进入跟读模式时，提示「建议戴耳机」，只提示一次 | 无 |

整个 M2 的验收标准：DESIGN 13.2 的 A1–A15，加上 CONTRACT 17.3 的 A16–A20，结果记录在 `docs/acceptance.md`。

### M5 坚持率改进（执行顺序：M2 之后、M3 之前）

**为什么排在这里**：M5 决定的是她偷懒三天之后还会不会回来。这些改动要等 M2 的数据契约（schema 4）落地后才能安全实施，但优先级高于 M3 的工具化。

**优先级**：先做 M5-2（控制积压）与 M5-1（降低默认目标），再做 M5-3 与 M5-4。前两条决定她回来后会不会打开 App，后两条是让每天用起来更顺手。

| 任务 | 内容 | 验收 |
|---|---|---|
| M5-1 | 默认目标改为每天新词 **5**、阅读 **15** 分钟（只影响新用户，已有设置不动） | 清空数据后，默认值正确 |
| M5-2 | **每轮复习最多 30 个**（`set.revBatch`，设置里可调），一轮结束后提示「再来一组 / 今天到此为止」，两个选项都给。待复习**超过 50** 时，今日页提示「今天先复习，不加新词」，且打卡条件从「新词达标」改为「完成一轮复习」 | 造 80 个到期词：第一轮只出 30 个，提示文案与打卡条件正确 |
| M5-3 | 今日页**顶部**显示「下一步」卡片，一句话加一个按钮，三态顺序固定：有到期词 → 复习；无到期词且有未读完课文 → 继续读该课文；都完成 → 打卡。原进度条保留在卡片下方 | 三种状态各验证一次 |
| M5-4 | 复习反馈：点「记住了」后提示约 0.8 秒「下次：N 天后」（**不要显示「第 X 次」**，box 上限为 6 会让人困惑）；本轮结束显示小结（共几个词、一次记住几个、待巩固几个） | 小结数字与实际操作一致 |
| M5-5 | 错词本：`words[].lapse`，每次「没记住」加 1；听写中写错且单词本里已有的词也加 1（不动 `box`）。单词页加「总记不住的词」筛选（`lapse >= 3`，按 `lapse` 从高到低排） | 连续点 3 次「没记住」后，该词出现在筛选结果里 |
| M5-6 | 周目标：连续天数旁边显示「本周 X/5」（周一零点重置，达标天数可设，默认 5） | 跨周时正确清零 |
| M5-7 | 快速听写：今日页与复习完成页放入口，**从她读过的课文里随机抽 5 句**（只抽有 `sents[].a` 音频的句子），沿用现有听写判定逻辑 | 没读过任何课文时不显示入口 |
| M5-8（需内容格式配合） | 逐句中文：`build_audio.py` 支持保留作者在 `materials.json` 里提供的 `sents[].zh`（可选字段）；阅读模式下**长按**某句显示这句的中文。没有逐句翻译的旧课文照常整篇显示，不报错 | 有逐句翻译的课文长按正常；旧课文不报错 |

**M5 的数据改动并入 schema 4 的 `migrate()`**（`lapse`、`set.revBatch`、`set.weekGoal`），**不另外升版本号**。

**内容端配合**：M5-8 需要作者在 `materials.json` 里提供 `sents[].zh`。从下一批课文开始随课文一起给出逐句翻译，旧课文不补也不影响。

### M3 内容工厂工具

| 任务 | 内容 | 验收 |
|---|---|---|
| M3-1 | `validate.py`：实现 CONTRACT 6.4 的全部校验，再加 id 格式和 JSON 语法检查。出错时退出码非 0，并逐条给出课文 id 和字段 | 构造的 6 类坏数据都能被拦下 |
| M3-2 | `build_audio.py`：读取 `.env`；先调用 `validate`；结束时打印报告（本次新合成字符数、复用数、每课句数），并确认 `wa` 和 `words` 长度一致 | 连续跑两次，第二次新合成字符数为 0 |
| M3-3 | `qa_audio.py`：用 mlx-audio 的 STT 模型（Whisper large-v3-turbo 或 Parakeet，具体调用方式查 mlx-audio 文档）把音频转写成葡语文本。归一化规则和听写判定一致（小写、去标点、去重音）。词级差异率超过阈值（默认 15%，可配置）的写入 `reports/qa-日期.md`，附上原文、转写结果和音频路径。转写结果按音频文件名缓存到 `tools/.qa_cache/` | 首批 8 课生成报告；故意把一句话配上错误音频，能被检出 |
| M3-4 | `clean_orphans.py`：列出 `site/audio/` 里没被 materials.json 引用的文件，默认只列出不删；加 `--apply` 参数才真正删除本地文件。远端文件不自动删 | 改一句课文、重新构建后，旧音频出现在清单里 |
| M3-5 | `deploy.sh`：依次执行 validate → 检查 `wa` 是否完整 → `rsync -av site/ $VPS:/var/www/apt/`（不带 `--delete`）→ 用 curl 取线上的 materials.json，核对 `version` | 一条命令完成发布 |
| M3-6（可选） | 慢速音频：用 SSML `<prosody rate="-25%">` 生成 `sents[].s`；前端在 0.75x 时优先播放 `s`。默认关闭，用环境变量开启 | 开启后，慢速播放听起来不发虚 |

### M4 测试

| 任务 | 内容 | 验收 |
|---|---|---|
| M4-1 | 把 `day`、`addDays`、`streak`、复习调度、`cmpW`、`splitS`、`migrate` 拆进 `site/logic.js`，在 `index.html` 里引用，同时加进 `sw.js` 的 `FILES` 清单。`test_logic.mjs` 只用 node 内置的 `assert` | `node tools/test_logic.mjs` 全部通过，至少覆盖：跨月和跨年的 streak、box 的上下界、「没记住」后重新入队、cmpW 的重音差异/漏词/多词三种情况、旧版数据迁移 |
| M4-2 | 填写 `docs/acceptance.md`：在 iPhone 和 iPad 主屏模式下逐项勾选，并记录 iOS 版本 | 全部通过，或者每个未通过项都附有说明 |

---

## 4. 完成定义（DoD）

一个任务完成，需要同时满足：

1. 代码已提交，提交信息带任务编号；
2. 对应的验收项已在真机上通过；
3. 如果改动了行为，DESIGN 和 CONTRACT 已同步更新；
4. `check_secrets.sh` 通过；
5. 基线版的备份文件导入新版后仍然正常。

---

## 5. 开工前需要家长提供

1. **VPS 登录方式**（已核定，无需提供）：`ssh -p 2222 -i ~/~/.ssh/your-vps-key.pem ubuntu@203.0.113.10`，或走 tailnet `ubuntu@100.64.0.3`。⚠️ 公网 22 会被云镜封，必须走 2222。
2. **Mac mini M2 的SSH**（已核定，无需提供）：`ssh -i ~/router/~/.ssh/your-mac-mini-key dail@100.64.0.2`。
3. Azure 资源所在的 region（密钥由家长自己写进 M2 的 `.env` 和 VPS 的 `/etc/apt-tts.env`，不要发给 coder）；
4. **学生是否已经在使用旧版。如果已经在用，先请她导出一份备份**，作为 M2-1 的迁移测试样本。这份备份既是测试样本，也是出问题时的退路；
5. 学生能参与 M1-3 盲听的时间。

---

## 附录 任务编号索引

| 编号 | 任务 | 依据条款 |
|---|---|---|
| M0-1 | 基线入仓与路径调整 | CONTRACT 10.1 |
| M0-2 | 密钥扫描与 gitignore | CONTRACT 13.1 |
| M0-3 | Gitea 私有仓与 Caddy 样例 | CONTRACT 3.0、16.1 |
| M1-1 | VPS 配置文件写全 | CONTRACT 16.1、16.2 |
| M1-2 | 按修正顺序部署 | CONTRACT 16.1 |
| M1-3 | 音色盲听对比页 | DESIGN D1 |
| M1-4 | 首批音频生成与发布 | CONTRACT 17.2 |
| M2-1 | schema 4 迁移 | CONTRACT 11.4、18.1 |
| M2-2 | 防丢数据 | DESIGN 8.1、14R1 |
| M2-3 | 触控与字号 | DESIGN 9.4、9.5 |
| M2-4 | 降级链对齐 | CONTRACT 6.2、8.1 |
| M2-5 | 系统语音提示 | DESIGN 12 |
| M2-6 | 渲染安全 | CONTRACT 6.4、12.3 |
| M2-7 | 跟读提示 | DESIGN 7.3 |
| M3-1 | 数据校验工具 | CONTRACT 6.4 |
| M3-2 | 构建脚本完善 | CONTRACT 10.4 |
| M3-3 | 音频质检 | CONTRACT 10.5 |
| M3-4 | 孤儿清理 | CONTRACT T8 |
| M3-5 | 发布脚本 | CONTRACT 10.3 |
| M3-6 | 慢速音频（可选） | DESIGN 7.1 |
| M4-1 | 纯函数拆分与测试 | CONTRACT 6.2 |
| M4-2 | 真机验收记录 | DESIGN 13.2、CONTRACT 17.3 |
| M5-1 | 默认目标下调 | DESIGN 14.1、16 D11 |
| M5-2 | 每轮上限与积压处理 | DESIGN 14.1、A17–A18 |
| M5-3 | 下一步卡片 | DESIGN 14.3、A16 |
| M5-4 | 复习即时反馈 | DESIGN 14.3、A19 |
| M5-5 | 错词本 | DESIGN 5.3、A20、CONTRACT 11.2.1 |
| M5-6 | 周目标 | DESIGN 14.3、A21 |
| M5-7 | 快速听写 | DESIGN 14.4、A22 |
| M5-8 | 逐句中文 | DESIGN 5.2、A23、CONTRACT 6.2 |

## 附录 版本记录

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v1.0 | 2026-10-07 | 基于 DESIGN v1.1 与 CONTRACT v1.1 编写，含硬规则、仓库结构、默认决策、四个里程碑共 21 个任务 | Dr. Dai Lei |
| v1.3 | 2026-10-07 | **新增 M5 坚持率改进（8 个任务）**，执行顺序定为 M0→M1→M2→M5→M3→M4；硬规则增至 15 条（新增：不动复习重排逻辑、`lapse` 与 `box` 禁止一起清零）；默认决策补 D8–D14；附录补 M5 任务索引 |
| v1.2 | 2026-10-07 | 确定命名：站名 APT、仓库 `yourname/apt`、域名 `apt.example.com`、目录 `/var/www/apt`、服务 `apt-tts`、localStorage 键 `aptapp`。新增命名口径对照表；硬规则第 3 条改为固定 `aptapp`；M1-1 增 manifest 改名项；仓库树顶部改为 `apt/` |
| v1.1 | 2026-10-07 | 按 router 机队事实修订：硬规则增Caddy/M2/泛解析三条（共 12 条）；M0 增建私有仓任务；M1-1 与 M1-2 改为 Caddy 部署；默认决策增 T11–T14；全部 CONTRACT 章节引用顺延至 v1.2 编号；任务数 21 → 22 | Dr. Dai Lei |