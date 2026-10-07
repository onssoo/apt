# APT

葡语学习打卡 PWA。给葡萄牙语专业大一学生用（澳门大学，欧葡方向）。

**线上地址**：https://apt.example.com

---

## 是什么

一个纯前端 PWA（渐进式网页应用），不需要服务器、不上架 App Store。部署到静态托管后，在 iPhone / iPad 的 Safari 里「添加到主屏幕」，用起来和原生 App 差不多，离线也能用。

五个页面：

| 页面 | 做什么 |
|---|---|
| **今日** | 顶栏（日期、连续天数、本周 X/5）、下一步卡片、今日进度与打卡；快速听写与「记录其他阅读」收在折叠区 |
| **阅读** | 8 篇原创课文（欧葡，A1–A2），逐句点读、跟读对比、听写判定 |
| **单词** | 词库维护：添加、批量导入、搜索、错词本筛选 |
| **复习** | 间隔重复闪卡，按 1/2/4/7/15/30 天调度 |
| **统计** | 月历（周一起始）、累计数据、学习设置（含「高级」折叠）、数据备份导入导出 |

## 特点

- **发音是真正的欧葡**：用 Azure `pt-PT` 神经语音（Raquel / Duarte），不是巴葡。巴葡与欧葡在元音弱化、词尾 s 的读法上差异显著，跟巴葡练等于和课堂反着来。
- **按用途分工的双语**：生词释义英文为主（课本、老师讲解、考试都用英文，很多葡语词与英文同源），中文点开再看；语法点用中文讲解但术语标上葡语和英文；理解题只用葡语。
- **假朋友提示**：用英文学葡语会遇到一批形似意不同的词（livraria 是书店不是 library、puxar 是拉不是 push、atualmente 是目前不是 actually）。课文里出现这类词会打上橙色标签。
- **为坚持而设计**：待复习积压是这类 App 最常见的弃用原因（期末忙三天回来一看 80 个，就不想打开了）。所以有每轮上限、积压时暂停新词、周目标兜底、错词本。
- **跟读只对比不打分**：语音识别的目标是「尽量听懂」，遇到口音会自动纠正成正确文字，打分反而误导。对比原音与自己的录音就够了。

## ⚠️ 关于这份公开版本

这是公开版本，**基础设施信息已脱敏**（原始部署信息保留在私有仓库）：

| 原文 | 本仓库中的占位符 |
|---|---|
| 真实域名 | `apt.example.com` |
| VPS 公网 IP | `203.0.113.10`（RFC 5737 测试段） |
| 内网 / Tailscale IP | `100.64.0.x`（CGNAT 段）、`192.168.0.x` |
| 用户名 | `yourname` |

**部署时请把上表占位符换回你的真实值。** 涉及的文件：

```
.env.example                    VPS 地址与远端目录
deploy.sh                       VPS 主机与端口
server/caddy-apt.conf.example   站点域名与静态根目录
server/apt-tts.service          代理路径
AGENTS.md / docs/*              命名口径与部署流程
```

Azure 密钥从未进入版本库。真值只写在两处，都不入库：

| 位置 | 说明 |
|---|---|
| 本机 `.env` | 已在 `.gitignore`，权限 600 |
| VPS `/etc/apt-tts.env` | 权限 600，属主 root，由 systemd `EnvironmentFile` 读取 |

`tools/check_secrets.sh` 是 git pre-commit 钩子，提交前自动扫描工作区与暂存区，发现疑似密钥就拒绝提交。**它不依赖任何硬编码的具体密钥**，只用泛化规则（`AZURE_KEY=<长串>`、高熵串等），因此换用其他家的密钥也照样能抓。

---

## 快速开始

```bash
# 本地预览
python3 -m http.server 8000 -d site
# 打开 http://127.0.0.1:8000
```

在 iPhone 上用：Safari 打开 → 分享 → 添加到主屏幕。

## 内容工厂

课文与音频在 Mac mini 上生成，rsync 推到 VPS。脚本只依赖 Python 标准库。

```bash
cp .env.example .env         # 填入 AZURE_KEY 与 AZURE_REGION
python3 tools/validate.py    # 校验数据
python3 tools/build_audio.py # 生成音频（幂等：已存在的跳过，不消耗额度）
./deploy.sh                  # 发布
```

新增课文：编辑 `site/materials.json` → 跑 `build_audio.py` → `deploy.sh`。

音频按 `sha1(声音|文本)` 命名，改课文时只有改动的句子会重新合成。

## 仓库结构

```
site/发布物（= rsync 源 = /var/www/apt/）
tools/    只在 Mac mini 上运行，不发布
server/   VPS 配置的副本
docs/     DESIGN.md（产品设计）、CONTRACT.md（实施契约）、TASKS.md（任务书）
reports/  质检报告，不入 git
```

`site/audio/` 不入 git（体积大、无版本历史需求），VPS 与 Mac mini 各留一份。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 产品设计：功能规格、学习算法、内容规范、风险登记册 |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | 实施契约：数据格式、接口、部署流程、验收清单 |
| [`docs/TASKS.md`](docs/TASKS.md) | 开工任务书：里程碑 M0–M7、硬规则、默认决策 |
| [`docs/CONTENT_PROMPT.md`](docs/CONTENT_PROMPT.md) | 新批次课文的生成提示词模板（填主题/级别/篇数，交给强模型出 JSON） |
| [`docs/acceptance.md`](docs/acceptance.md) | 验收记录：已自动验证的项 + iPhone 真机点验清单 |
| [`AGENTS.md`](AGENTS.md) | 给 coding agent 的硬规则摘要 |

## 内容版权

课文全部原创，不引用教材或报纸原文。语法点基于欧洲葡语规范，与课堂讲法冲突时以教师为准。