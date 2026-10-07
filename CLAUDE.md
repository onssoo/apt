# APT —— 给 coding agent 的硬规则

> 每次开工前必读。完整文档在 `docs/`。
> 本文件是 `docs/TASKS.md` 第 0 节的副本，放在根目录以便自动加载。

## 命名口径（先对一遍，勿自创）

| 位置 | 值 |
|---|---|
| 站名 / App 主屏名 | **APT** |
| 仓库 | Gitea **`dailei/apt`**（private） |
| 域名 | **`apt.lababa.live`** |
| VPS 静态根目录 | `/var/www/apt` |
| 代理服务 | `apt-tts`（unit、env、StateDirectory 同名） |
| 代理环境文件 | `/etc/apt-tts.env`（600） |
| 代理缓存目录 | `/var/lib/apt-tts` |
| localStorage 键 | **`aptapp`** |
| M2 上的仓库目录 | `~/apt` |

⚠️ **`pt-PT` 与 `pt-BR` 是语言标签，不在改名范围内。**

## 硬规则

1. **零依赖**：不引入框架、构建步骤、npm 包、CDN、第三方脚本或字体。Python只用标准库；唯一例外是 `tools/qa_audio.py`，可以依赖 mlx-audio。
2. **密钥不入前端、不入仓库**：提交前运行 `tools/check_secrets.sh`，有命中就拒绝提交。
3. **向后兼容**：localStorage 键固定为 `aptapp`。结构变更全部集中在 `migrate()` 里，按 `set.schema` 递增。代码里必须留一个读旧键 `ptapp` 的兜底分支。
4. **发布边界**：`site/` 里只放发布物，脚本放 `tools/` 和 `server/`。
5. **rsync 不带 `--delete`**。远端文件只由 `tools/clean_orphans.py` 显式清理。
6. **`/api/tts` 的缓存匹配不得使用 `ignoreSearch`**。忽略查询串会导致所有单词播同一段音频。其余页面类资源可以忽略。
7. **句子不走发音代理**。代理限 100 字符，课文句子超限会返回 400。句子降级链是「预生成音频 → 系统语音」，只有单词才走代理。
8. **真机验证**：每个前端任务都必须在 iPhone 的「主屏幕 App」模式下验证。桌面浏览器和模拟器的结果不算数。
9. **不要装 nginx，不要跑 certbot**。线上 VPS 已装 **Caddy v2.11.4** 并在跑 lababa 应用，80/443 已占。配置一律改 `/etc/caddy/Caddyfile`，改前必须备份，`caddy validate` 通过后才 reload。
10. **合成与质检只在 Mac mini M2 上跑**。VPS 只有 1.9 GiB 内存且已跑 Caddy + lababa + PostgreSQL，不要在上面跑音频合成或 Whisper。M2 地址 `100.89.60.63`，用户 `dail`。
11. **不需要添加 DNS A 记录**。`lababa.live` 已配泛解析 `*`，`apt.lababa.live` 自动生效。
12. **不要动已有的复习重排逻辑**。点「没记住」使 `box=0`、`due=今天` 并放回队尾，该词当轮必然再现直到点「记住了」。**不需要也不允许**额外实现「一轮结束后重排错词」。
13. **`lapse` 与 `box` 语义不同，禁止一起清零**。`box` 是当前熟练度（决定下次复习日期），`lapse` 是历史累计失败次数（只增不减）。点「没记住」时 `box=0` 且 `lapse+=1`；听写判错只加 `lapse` 不动 `box`。任何情况下都不重置 `lapse`。
14. **冲突处理**：文档和代码冲突、或者文档没写到的地方，先停下来提问，不要自行决定。改了行为，要同步修改 DESIGN 和 CONTRACT。
15. **提交粒度**：一个任务一个 commit，提交信息以任务编号开头，例如 `M2-1: schema 4 migration`。

## 执行顺序

**M0 → M1 → M2 → M5 → M6 → M3 → M4**

- **M0** 基线入仓（仓库结构、.gitignore、密钥扫描、Gitea 私有仓）
- **M1** 上线最小闭环（VPS 配置、部署、盲听、首批音频）
- **M2** 前端修补（schema 4 迁移、防丢数据、触控字号、降级链、渲染安全）
- **M5** 坚持率改进（每轮上限、积压处理、下一步卡片、复习反馈、错词本、周目标、快速听写、逐句中文）
- **M6** 双释义（格式兼容、显示设置、英文释义、批量导入、假朋友、搜索）
- **M3** 内容工厂工具（validate 已完成、build_audio 已完成、qa_audio、clean_orphans、deploy 已完成）
- **M4** 测试与验收（纯函数已拆分，48 项通过；待真机验收记录）

## 常用命令

```bash
# 校验数据（含音频齐全检查）
python3 tools/validate.py --audio

# 生成音频（幂等：已存在的跳过，不消耗额度）
python3 tools/build_audio.py
python3 tools/build_audio.py --limit 1 --slow    # 单篇 + 慢速版

# 跑纯函数测试
node tools/test_logic.mjs

# 密钥扫描
sh tools/check_secrets.sh

# 本地预览
python3 -m http.server 8000 -d site

# 发布
./deploy.sh
```

## 内容格式（docs/DESIGN.md 第 6 章）

两种格式都支持，校验与渲染通过 `norm_word` / `norm_trans` 归一：

| | 新格式（M6 起） | 旧格式（首批未重写时） |
|---|---|---|
| 生词 | `{pt, en, zh, ex, ff?}` | `[pt, zh, ex?]` |
| 全文翻译 | `{en, zh}` | 字符串（视为中文） |
| 逐句翻译 | `trans_lines: [{en, zh}]` 或 `en_lines` + `zh_lines` | `zh_lines` |
| 标题 | `en` 字段 | 无 |

`ff`（假朋友）为可选字段，填了就显示橙色标签。

## Azure TTS

- 端点：`https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`
- 本项目 region = `eastus`，pt-PT 声音：`RaquelNeural`（主）、`DuarteNeural`（对话第二角色）、`FernandaNeural`（备选）
- 额度：每月 50 万字符。首批 8 课约 1 万字符。脚本打印本次消耗字符数用于对账。
- 密钥只在 `.env`（Mac mini，已 gitignore）与 `/etc/apt-tts.env`（VPS，600 root）。