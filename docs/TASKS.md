# 葡语打卡 App 开工任务书（TASKS.md）

| 项目 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-10-07 |
| 依据 | DESIGN.md v1.4、CONTRACT.md v1.5（已按评审意见、机队事实、最终命名与坚持率分析修订） |
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
6. **`/api/tts` 是 POST，不进 Service Worker 缓存**。sw.js 只拦截 GET 请求，POST 直接放行；前端用内存 `TTS_MEM` 按文本去重，代理侧按 `sha1(声音|文本)` 落盘缓存。页面类 GET 资源仍可忽略查询串。
7. **句子不走发音代理**。代理限 100 字符，课文句子超限会返回 400。句子只有「预生成音频」这一条路，没有兜底（无音频则静默不发声）；只有单词才走代理，链路是「预生成音频 → `POST /api/tts`」。**系统语音（`speechSynthesis`）已整条移除**，任何地方都不要再调用它。
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
│   ├── apt-tts.service
│   └── caddy-apt.conf.example
├── reports/               # 质检报告，不入 git
├── docs/
│   ├── DESIGN.md
│   ├── CONTRACT.md
│   ├── TASKS.md
│   └── acceptance.md
├── deploy.sh
├── .env.example           # AZURE_KEY= AZURE_REGION= VOICE= VOICE2= VPS= SITE_HOST= VPS_SSH_PORT= VPS_SSH_KEY= REMOTE_DIR=
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

把第 0 节（硬规则）复制一份到仓库根目录的 **`AGENTS.md`**（旧名 `CLAUDE.md`，2026-10-07 改名）。各家的编码 agent 都会自动读这个文件。

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
| T5 | `/api/` 访问日志 | `log_skip /api/*`（Caddy 无 `access_log off` 等价指令） |
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

**执行顺序：M0 → M1 → M2 → M5 → M6 → M3 → M4**；上线后追加 **M7 质量修复**（已经跑完，见下）。
M5 插在 M3 之前，因为坚持率改进的价值高于内容工厂工具化；M7 的七个 bug 优先级高于一切新功能。

### M0 基线入仓

| 任务 | 内容 | 验收 |
|---|---|---|
| M0-1 | 建仓（`~/apt`），把基线代码按第 1 节结构原样放好；把 `build_audio.py` 里的路径改成从仓库根目录运行（`site/materials.json`、`site/audio/`） | `python3 -m http.server -d site 8000` 能打开五个页面 |
| M0-2 | `.gitignore`、`.env.example`；`check_secrets.sh` 用 grep 检查 `site/` 和暂存区里有没有 32 位以上的十六进制串或 `Ocp-Apim`，并安装为 git pre-commit 钩子 | 故意写入一个假密钥，提交被拒 |
| M0-3 | **在 Gitea 建私有仓 `yourname/apt`**（`http://100.64.0.1:3001`，用户 `yourname`），description 写「APT — 葡语学习打卡 PWA（Ann 的葡萄牙语训练）」，按 `~/router/REPO-MAP.md` 登记流程加一行并打 topic `app`；把 Caddy 站点块样例存进 `server/caddy-apt.conf.example`。**仓库必须 private**（参照 lababa 是 public，本项目含 Azure 密钥相关配置） | 仓库可见性为 private；REPO-MAP 已登记 |

### M1 上线最小闭环

| 任务 | 内容 | 验收 |
|---|---|---|
| M1-1 | 改 `site/manifest.json` 与 `index.html` 的 meta：`name`/`short_name`/`apple-mobile-web-app-title` 一律 **`APT`**。写 `server/` 下三个文件。Caddy 示例要包含：`apt.example.com` 站点块；`root * /var/www/apt` + `file_server`；`@sw`（`/sw.js`）配 `no-cache, no-store, must-revalidate`；`@data`（页面、`logic.js` 与 json）配 `no-cache`；`@audio`（`/audio/*`）配 `immutable`；`@api`（`/api/*`）走 `reverse_proxy 127.0.0.1:8787`；并加 `log_skip /api/*`。**注意 Caddy 无内建限流、不需要 ssl_certificate、不需要 certbot** | 文件可以直接追加到线上 Caddyfile 试用 |
| M1-2 | 按 CONTRACT 16.1 的顺序部署：建目录 → rsync 静态物（不带 `--delete`）→ 部署代理并本地 curl 自测 → **备份 `/etc/caddy/Caddyfile` 后追加 `apt.example.com` 块（不动 lababa 块）** → `caddy validate` → reload → 上传音频 | CONTRACT 17.1 的 I1–I10 全部通过 |
| M1-3 | `voice_compare.py`：3 个声音 × 2 段文本（一段叙述，一段对话），声音顺序随机，编号为 A/B/C，输出 `site/compare/index.html`，页面上不显示声音名（标题写 APT）；对应答案写到 `reports/compare_key.txt`，不发布 | 学生在手机上能播放并选出编号；选定后删除远端的 `compare/` |
| M1-4 | 用选定的声音为首批 8 课生成音频，并发布 | CONTRACT 17.2 的 C1–C4 通过；在真机上播放课文句子，确认是欧葡口音 |

### M2 前端修补（在基线index.html 上改）

| 任务 | 内容 | 验收 |
|---|---|---|
| M2-1 | **schema 4**：旧数据里的 `set.v3` 视为 schema 3。新单词的 id 改为字符串（`Date.now().toString(36)` 加随机 4 位），旧的数字 id 保留不动；`byId` 统一用 `String()` 比较，`onclick` 里的 id 要加引号。`words[].upd` 记录最后修改时间（毫秒），新增和复习判定时都要更新。删除单词时往 `D.del` 写入墓碑 `{id,t}`。所有迁移逻辑只写在 `migrate()` 里 | 用基线版导出的备份导入后，一切正常；再次导出的文件包含 `schema:4`；新旧 id 的词都能正常发音、删除和复习 |
| M2-2 | **防丢数据**：`save()` 加 try/catch，写入失败时显示红色横幅，提示「立即导出备份」。导出时记录 `set.lastExport`，超过 7 天没导出就在今日页显示提醒卡，当天可以关闭。启动时调用一次 `navigator.storage?.persist?.()`，不支持就忽略 | 手动模拟写入失败能看到横幅；把 `lastExport` 改成 8 天前能看到提醒卡 |
| M2-3 | **触控与字号**：所有按钮最小高度 44px；例句、生词释义等学习内容不小于 15px，新增 `.ex` 类，不要再借用 `.mu` | 在 iPhone 上逐页检查 |
| M2-4 | **降级链对齐 CONTRACT 6.2 与 9.1**：单词走「预生成音频 → `POST api/tts`」，句子只有「预生成音频」一条路，无音频则静默不发声。任何失败都静默降级，不弹窗 | DESIGN A10；断网、代理停掉、返回 429 三种情况分别测试 |
| M2-5 | **系统语音路径已移除，不要实现**：`speechSynthesis` 整条链路已在 2026-10-07 删除（设置页的「备用发音」项、启动时的语音包检测提示都删掉）。不要再加 `getVoices()` 检查或下载提示 | 全仓搜索 `speechSynthesis`，业务代码里零命中 |
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
| M5-8（需内容格式配合） | 逐句译文：`build_audio.py` 支持保留作者在 `materials.json` 里提供的 `sents[].en` / `sents[].zh`；阅读模式下**点句尾的「译」按钮**显示这句的译文（不再用长按，iOS 长按会弹选词菜单）。没有逐句翻译的旧课文照常整篇显示，不报错 | 有逐句翻译的课文点「译」正常；旧课文不报错 |

**M5 的数据改动并入 schema 4 的 `migrate()`**（`lapse`、`set.revBatch`、`set.weekGoal`），**不另外升版本号**。

**内容端配合**：M5-8 需要作者在 `materials.json` 里提供 `sents[].zh`。从下一批课文开始随课文一起给出逐句翻译，旧课文不补也不影响。

### M3 内容工厂工具

| 任务 | 内容 | 验收 |
|---|---|---|
| M3-1 | `validate.py`：实现 CONTRACT 6.4 的全部校验，再加 id 格式和 JSON 语法检查。出错时退出码非 0，并逐条给出课文 id 和字段 | 构造的 6 类坏数据都能被拦下 |
| M3-2 | `build_audio.py`：读取 `.env`；先调用 `validate`；结束时打印报告（本次新合成字符数、复用数、每课句数），并确认 `wa` 和 `words` 长度一致 | 连续跑两次，第二次新合成字符数为 0 |
| M3-3 | `qa_audio.py`：用 mlx-audio 的 STT 模型（Whisper large-v3-turbo 或 Parakeet，具体调用方式查 mlx-audio 文档）把音频转写成葡语文本。归一化规则和听写判定一致（小写、去标点、去重音）。词级差异率超过阈值（默认 15%，可配置）的写入 `reports/qa-日期.md`，附上原文、转写结果和音频路径。转写结果按音频文件名缓存到 `tools/.qa_cache/` | 首批 8 课生成报告；故意把一句话配上错误音频，能被检出 |
| M3-4 | `clean_orphans.py`：列出 `site/audio/` 里没被 materials.json 引用的文件，默认只列出不删；加 `--apply` 参数才真正删除本地文件。远端文件不自动删 | 改一句课文、重新构建后，旧音频出现在清单里 |
| M3-5 | `deploy.sh`：一条命令 5 步 —— ① validate → ② 检查音频齐全（`validate.py --audio` + `wa` 与 `words` 等长、`sents` 已生成）→ ③ `rsync -av -e "ssh -p $VPS_SSH_PORT" site/ $VPS:$REMOTE_DIR/`（不带 `--delete`，走 2222）→ ④ 用 curl 取线上 materials.json 并核对 `version` → ⑤ 抽查首页 HTTP 200。环境变量：`SITE_HOST`（默认 `apt.example.com`）、`VPS`、`VPS_SSH_PORT`（默认 2222）、`VPS_SSH_KEY`（可选私钥）、`REMOTE_DIR` | 一条命令完成发布，任一步失败即中止 |
| M3-6（可选） | 慢速音频：用 SSML `<prosody rate="-25%">` 生成 `sents[].s`；前端在 0.75x 时优先播放 `s`。默认关闭，用环境变量开启 | 开启后，慢速播放听起来不发虚 |

### M4 测试

| 任务 | 内容 | 验收 |
|---|---|---|
| M4-1 | 把 `day`、`addDays`、`streak`、复习调度、`cmpW`、`splitS`、`migrate` 拆进 `site/logic.js`，在 `index.html` 里引用，同时加进 `sw.js` 的 `FILES` 清单。`test_logic.mjs` 只用 node 内置的 `assert` | `node tools/test_logic.mjs` 全部通过，至少覆盖：跨月和跨年的 streak、box 的上下界、「没记住」后重新入队、cmpW 的重音差异/漏词/多词三种情况、旧版数据迁移 |
| M4-2 | 填写 `docs/acceptance.md`：在 iPhone 和 iPad 主屏模式下逐项勾选，并记录 iOS 版本 | 全部通过，或者每个未通过项都附有说明 |

### M6 双释义（已完成，2026-10-07 补记任务书）

> 这一节是**补记**：代码里早有 `M6-1`…`M6-6` 标记，但任务书一直没写，
> 于是出现「README 说 M0–M6，TASKS 只到 M4」的不一致。现按已实现的代码补上。

| 任务 | 内容 | 验收 |
|---|---|---|
| M6-1 | 格式兼容：`normWord` / `normTrans` 同时吃对象新格式与数组旧格式 | 新旧两种写法都渲染正确 |
| M6-2 | 释义显示设置：`set.show` = both / en / zh，学习内容英文为主、中文在下 | 三种设置各验一次 |
| M6-3 | 英文释义：生词与逐句都有 `en`；无 `trans` 时全文翻译由 `sents` 拼出 | L01–L08 英中齐全 |
| M6-4 | 批量导入：`parseImportLine` 支持三种写法，重复与坏行跳过并报数 | 导入后条数正确 |
| M6-5 | 假朋友：`ff` 字段 → 橙色标签 + 词下说明；带 `ff` 的课文必须有 `reviewed` | 全套共 7 个，validate 硬校验 |
| M6-6 | 搜索：`matchWord` 支持去重音与部分匹配 | 搜得到、搜得准 |

### M7 质量修复（已完成，2026-10-07）

> 起因：上线后逐条读代码 + 爬线上页面，发现七个「她每天都会碰到」的 bug，
> 外加界面过满、内容只做了八分之一。**优先级高于一切新功能。**

| 任务 | 内容 | 验收 |
|---|---|---|
| M7-1 | 修 bug 1–5、9、10，每个 bug 单独一个 commit：① `migrate(null)` 丢默认值导致首屏 `undefined`；② `streak()` 只看有没有记录，连续天数每天早上归零；③ 复习次数在 `ans()` 与 `roundEnd()` 双计；④ 快速听写借用课文状态导致抽错句；⑤ 备份提醒对「从没导出过」的人永久失效；⑨ 今日页误报「今天完成了」；⑩ 空词库显示「复习完成啦」 | 清空数据后首屏数字正确；今天未打卡时连续天数显示到昨天；答 10 题今日复习计数为 10 |
| M7-2 | `test_logic.mjs` 补用例：今天有记录但未打卡的 streak、`migrate(null)`、`migrate({})`；快速听写取句拆进 `logic.js`。**顺带修掉测试报告块夹在文件中间造成的假绿**（其后 36 个用例失败也不报） | `node tools/test_logic.mjs` 全过（103 项） |
| M7-3 | 逐句译文改为点「译」按钮 + 「译文全显」（原 `oncontextmenu` 长按在 iOS 上会弹选词菜单，不可靠）；0.75x 同时设 `playbackRate` 与 `defaultPlaybackRate`；导出优先 `navigator.share({files})`，不支持再退回下载 | 代码部分由 `tools/test_render.mjs` 自动验；**iPhone 主屏录屏由 owner 完成**（清单见 `docs/acceptance.md`） |
| M7-4 | 15 处 `alert` 全改 toast（`toast(msg, ms)`），只保留删除 / 覆盖导入 / 未达标打卡三处 `confirm`；删掉失效的系统语音设置（`sysVoiceOK`、`checkVoices`、下载语音包弹窗、设置页「备用发音」）与 `stopAll()` 里的 `speechSynthesis.cancel()` | `grep -c 'alert(' site/index.html` = 0 |
| M7-5 | 今日页只留顶栏（日期/连续天数/本周）+ 下一步卡片 + 今日进度；快速听写与「记录其他阅读」收进折叠区；设置页分「学习设置（含高级折叠）」与「数据备份」两张卡；日历改周一开头 | 一屏内可见「下一步」按钮 |
| M7-6 | 内容升到 `version: 2`：L01 删 4 个错误假朋友、补 `professora`；L02–L08 补英文（标题/生词/逐句）；`sents` 成为逐句翻译唯一来源，删 `trans` 与 `trans_lines`；`build_audio.py` 以作者 `sents` 为准（`sp: "b"` 用 VOICE2）；`validate.py` 加段落对齐、`ff` 需 `reviewed`、巴葡黑名单；前端按 `pt` 给老单词本补 `en`/`ff` 且不动 `box`/`due`/`lapse` | `validate.py --audio` 通过；`build_audio.py` 新合成 6 条 / 复用 167 条 / 59 字符；线上 101 个生词全部有英文 |

**M7 顺带修掉的部署缺陷**（原 `deploy.sh` 有三个「看起来能跑」的问题）：

1. `validate.py --audio … | grep … || true` 把退出码吃掉 —— 音频全缺也照样发布；
2. 第 4 步只 `echo` 本地 `version`，从不核对线上；
3. 定义了 `SSH="ssh -p $VPS_PORT"` 却从未使用，rsync 走默认 22 端口（公网 22 已被封），脚本根本跑不通。

现在：音频缺失即中止 → rsync 走 `VPS_SSH_PORT`（可选 `VPS_SSH_KEY`）→ curl 核对线上 `version` → 抽查首页 HTTP 200。

**验证工具**：`tools/test_logic.mjs`（103 项纯函数测试）与 `tools/test_render.mjs`（37 项无头 Chrome 真实渲染断言，可打本地也可打线上）。两者都只依赖 node 内置模块。

### M8 课文生产流水线（已完成，2026-10-07）

> 目标：让 Agent（或 Ann 自己）能**按规范产出课文并自动上线**，人只在 A/B 模式把关。
> 规范的真源是 [`skills/apt-lesson/SKILL.md`](../skills/apt-lesson/SKILL.md)。

| 任务 | 内容 | 验收 |
|---|---|---|
| M8-1 | 规范做成 skill：`skills/apt-lesson/SKILL.md`（三种模式、JSON 结构、`sents` 切句与段落对齐、欧葡口径、生词选词、假朋友、级别长度、交付报告）；`docs/CONTENT_PROMPT.md` 缩成一行指向它；`AGENTS.md` 顶部加「课文任务先读 apt-lesson」 | 新 Agent 读到 `AGENTS.md` 即被导向规范 |
| M8-2 | `tools/merge_lesson.py`：`id:"auto"` 自动分配编号；按 `tools/ff_list.json` **自动补假朋友**；正文查重（含前 120 字）；复用 `validate.py` 的单篇规则；并入前断言**已有课文的序列化内容逐字节未变**；草稿归档到 `drafts/done/`；`--dry-run` | 连续并入多篇编号正确，原有课文零变化 |
| M8-3 | `validate.py` 扩充：`level` 允许 B1/B2；`ex` 不在正文中（一课一条汇总）；有破折号对话段却无任何 `sp:"b"`；单句超 200 字符；跨课生词重复；`src.kind=adapted/imported` 缺 `src.url` 报错；`trans`/`trans_lines` 等废弃字段提醒；**`ff` 必须来自白名单**（取代原「有 ff 必须有 reviewed」） | 逐条构造坏数据都能被拦下或提醒 |
| M8-4 | 前端：`by:"ann"` 的课文在列表顶部单独分组为「我导入的」；有 `src` 的显示来源站名与外链；`ann` 的课文页底部一行小字「译文与讲解由 AI 生成，仅供参考，以老师讲法为准」 | 三种状态在 iPhone 主屏 App 里各验一次 |
| M8-5 | `build_audio.py --only L09[,L10]`，并在结尾打印本次处理了哪几课 | 只给指定课文配音，其他课不动 |
| M8-6（第二期，未做） | App 内「导入文章」表单 → `POST /api/inbox` → Mac mini 定时用 C 模式自动处理并上线；她的课文单独放 `site/materials-ann.json`（前端合并显示，Caddy 加口令）；`GET /api/inbox/status` 回执；隐藏/重新生成按钮 | 见 `skills/apt-lesson` 第 14 节 |

**端到端实测（2026-10-07）**：按规范手写 `drafts/cafe.json`（A2 对话，13 生词）→
`merge_lesson.py` 分配 **L09**、自动标注假朋友 `o compromisso`、草稿归档 →
`build_audio.py --only L09` **新合成 24 条 / 528 字符**（旧课零重录）→
按哈希逐一核对 **4 句 `sp:"b"` 全部用 VOICE2（Duarte）**、其余用 Raquel →
`deploy.sh` 上线 → 线上真实渲染与交互验证 **70/70**。

**顺带修掉的**：`deploy.sh` 在 `SITE_HOST` 还是 `.env.example` 的占位符时，会 curl 失败并
抛一段 Python traceback，看不出真正原因。现在开头就明确报「SITE_HOST 还是占位符」并退出。

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
2. **Mac mini M2 的SSH**（已核定，无需提供）：`ssh -i ~/.ssh/your-mac-mini-key yourname@100.64.0.2`。
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
| M2-4 | 降级链对齐 | CONTRACT 6.2、9.1 |
| M2-5 | 系统语音路径移除（不要实现） | CONTRACT 6.2、9.1 |
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
| M5-8 | 逐句译文 | DESIGN 5.2、A23、CONTRACT 6.2 |

## 附录 版本记录

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v1.0 | 2026-10-07 | 基于 DESIGN v1.1 与 CONTRACT v1.1 编写，含硬规则、仓库结构、默认决策、四个里程碑共 21 个任务 | Dr. Dai Lei |
| v1.5 | 2026-10-07 | **补记 M6（双释义，6 个任务）与 M7（质量修复，6 个任务）两节**——代码早有 M6/M7 标记而任务书没有，造成「README 说 M0–M6、TASKS 只到 M4」；同步硬规则 6/7（`/api/tts` 改 POST、句子无兜底、系统语音已移除）与 M2-5（改为「不要实现系统语音」） |
| v1.3 | 2026-10-07 | **新增 M5 坚持率改进（8 个任务）**，执行顺序定为 M0→M1→M2→M5→M3→M4；硬规则增至 15 条（新增：不动复习重排逻辑、`lapse` 与 `box` 禁止一起清零）；默认决策补 D8–D14；附录补 M5 任务索引 |
| v1.2 | 2026-10-07 | 确定命名：站名 APT、仓库 `yourname/apt`、域名 `apt.example.com`、目录 `/var/www/apt`、服务 `apt-tts`、localStorage 键 `aptapp`。新增命名口径对照表；硬规则第 3 条改为固定 `aptapp`；M1-1 增 manifest 改名项；仓库树顶部改为 `apt/` |
| v1.1 | 2026-10-07 | 按 router 机队事实修订：硬规则增Caddy/M2/泛解析三条（共 12 条）；M0 增建私有仓任务；M1-1 与 M1-2 改为 Caddy 部署；默认决策增 T11–T14；全部 CONTRACT 章节引用顺延至 v1.2 编号；任务数 21 → 22 | Dr. Dai Lei |