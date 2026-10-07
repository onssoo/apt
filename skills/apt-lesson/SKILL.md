---
name: apt-lesson
description: 为 APT（欧洲葡语学习 PWA）制作阅读课文。三种模式：原创、网上找素材改编、导入指定文章。产出一篇课文 JSON 到 drafts/，经 merge → validate → build_audio → deploy 上线。凡是要新增或修改 site/materials.json 课文时使用。
---

# APT 课文制作规范（v1）

> **动手前必读。** 本规范取代旧的 `docs/CONTENT_PROMPT.md`（那份只剩一行指向这里）。
> 凡是新增课文、改课文、导入文章，都按这份走。

## 0. 读者是谁

澳门大学葡语专业大一学生。母语中文，课堂用英文授课，学**欧洲葡语（pt-PT）**，水平 A1→A2，逐步到 B1。

App 的阅读页会真实使用课文的每一个字段：点句播放（`sents[].a`）、逐句译文（`sents[].en/zh`）、
全文翻译（由 `sents` 按段落拼出）、语法点（`note`）、生词卡（`words`，可一键加入单词本并进入间隔复习）、
假朋友标签（`ff`）、理解题（`qs`）、跟读与听写（都按句子切）。

**每个字段都会被真人看到，不能写着凑数。**

## 1. 三种模式

| 模式 | 触发 | 正文来源 | 级别 | 假朋友 | 上线 |
|---|---|---|---|---|---|
| **A 原创** | 给了主题/语法点 | 自己写 | A1/A2（可 B1） | 白名单自动标 | 人工确认后 deploy |
| **B 改编** | "找一篇关于××的文章" | 上网搜，**读懂后重写**，不转载 | A1/A2（可 B1） | 白名单自动标 | 人工确认后 deploy |
| **C 导入** | 给了一段葡语原文 | **原文逐字保留** | 按实际难度判定 | 白名单自动标 | **可直接自动上线**（见第 11.2） |

`by` 字段：`"dad"`（A/B）或 `"ann"`（C，导入人）。前端据此把 `ann` 的课文单独分组为「我导入的」，
并在课文页底部显示一行小字说明译文与讲解是 AI 生成的。

## 2. 产出与流程（必须照做）

1. 写**一篇**课文 JSON 到 `drafts/<简短英文slug>.json`（一个对象，**不是数组**）。
   **绝对不要直接编辑 `site/materials.json`** —— 那个文件已经 50KB，手改迟早弄坏别的课文。
2. `id` 一律写 `"auto"`，由 merge 脚本分配编号。
3. 依次运行：

   ```bash
   python3 tools/merge_lesson.py drafts/<slug>.json   # 分配 id、补假朋友、查重、单篇校验、并入
   python3 tools/validate.py --audio                  # 全量校验（含音频齐全）
   python3 tools/build_audio.py --only <刚分配的id>    # 只给这篇配音；看「新合成字符数」
   ./deploy.sh                                        # C 模式可自动；A/B 等人确认
   ```

4. 最后输出一份**交付报告**（见第 12 节）。

开工前先看一遍 `site/materials.json` 里已有的 `title` 与 `words[].pt`：**不要重复已有主题，
生词也尽量不与旧课重复**（validate 会对跨课重复提出提醒）。

## 3. JSON 结构

```json
{
 "id": "auto",
 "level": "A2",
 "min": 7,
 "title": "No mercado",
 "zh": "在市场",
 "en": "At the market",
 "tags": ["Macau", "compras"],
 "src": {"kind": "adapted", "site": "Hoje Macau", "title": "原文标题", "url": "https://…", "date": "2026-09-30"},
 "by": "dad",
 "text": "第一段第一句。第一段第二句。\n— Bom dia! Queria um quilo de laranjas, se faz favor.\n— Com certeza. Mais alguma coisa?",
 "note": "……",
 "sents": [
  {"p": 0, "t": "第一段第一句。", "en": "…", "zh": "…"},
  {"p": 0, "t": "第一段第二句。", "en": "…", "zh": "…"},
  {"p": 1, "t": "— Bom dia!", "en": "Good morning!", "zh": "早上好！"},
  {"p": 1, "t": "Queria um quilo de laranjas, se faz favor.", "sp": "b", "en": "…", "zh": "…"},
  {"p": 2, "t": "— Com certeza.", "sp": "b", "en": "Certainly.", "zh": "当然。"}
 ],
 "words": [
  {"pt": "a laranja", "en": "orange", "zh": "橙子", "ex": "Queria um quilo de laranjas, se faz favor."}
 ],
 "qs": [["O que quer comprar a cliente?", "Quer comprar um quilo de laranjas."]]
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | 写 `"auto"`，merge 分配 `L` + 两位以上数字 |
| `level` | 是 | A1 / A2 / B1 / B2 |
| `min` | 是 | 预计学习分钟：A1 5，A2 6–8，B1 8–12 |
| `reviewed` | 否 | **Agent 一律不写。** 只有人自己确认过才补 `"YYYY-MM-DD"` |
| `title` / `zh` / `en` | 是 | 葡语 / 中文 / 英文标题 |
| `text` | 是 | `\n` 分段；不能有连续空格或行首行尾空格 |
| `sents` | 是 | 见第 4 节 |
| `words` | 是 | 见第 6 节 |
| `note` | 是 | 见第 9 节 |
| `qs` | 是 | 见第 9 节 |
| `src` | B/C 必填 | `kind`: original / adapted / imported；B、C 必须写 `url` |
| `by` | 否 | dad / ann |
| `tags` | 否 | 1–3 个葡语主题词 |
| **不许写** | — | `trans`、`trans_lines`、`a`、`s`、`wa`、`speaker`、`ff`（都由脚本生成，见第 8 节） |

## 4. `sents`：最容易错，先读这一节

- `p` 是**段落号，从 0 开始**，与 `text` 按 `\n` 切开后的顺序一致。
- **同一段的 `t` 用一个空格连接后，必须与该段逐字相同** —— 包括标点、大小写、引号、破折号。
  `validate.py` 会硬校验这一条，不一致直接退出码 1，merge 也会拒绝并入。
- 按 `. ? ! …` 切句。冒号、分号后面如果是完整分句可以切开，**标点留在前一句末尾**。
- 单句最长 **200 字符**（超了 validate 会提醒，跟读与听写也会变得难用）。A/B 模式超长就改写；
  C 模式只能在 `;`、`:` 或连词前的逗号处切，且 `t` 必须保持原文。
- **对话**：
  - 破折号**留在 `t` 里**（`"— Bom dia!"`）。合成音频时脚本会剥掉行首破折号，不会读出来。
  - **第二个说话人的每一句都要标 `"sp": "b"`**，包括同一段里破折号后面的那一句。
    漏标的话整篇只有 Raquel 一个声音，对话会听起来像自问自答。
    `validate.py` 会检查「有破折号对话段但没有任何 `sp:"b"`」并提醒。
  - 超过两个人时，第三人归到 main 或 b 里更接近的一方。
- 每句都要有 `en` 和 `zh`（见第 7 节）。

## 5. 欧葡口径：只能用 pt-PT

`validate.py` 会对下面这些提出提醒，但规则本身要自己守住：

| 巴葡（不许） | 欧葡（要用） |
|---|---|
| `ônibus` / `trem` / `celular` | `autocarro` / `comboio` / `telemóvel` |
| `café da manhã` / `geladeira` / `banheiro`（厕所） | `pequeno-almoço` / `frigorífico` / `casa de banho` |
| `garçom` / `legal`（好）/ `você`（泛用） | `empregado de mesa` / `fixe`、`ótimo` / 省略主语或 `o senhor`、`a senhora` |
| `estou fazendo` | `estou a fazer` |
| `Me chamo` / `Se levanta` | `Chamo-me` / `Levanta-se`（代词后置；否定句、疑问词、某些副词后前置） |
| `compramos`（过去时） | `comprámos`（`-ar` 动词 nós 完成过去时加重音） |

还有：`se faz favor`（请）；月份与季节小写；新正字法（`ação`、`ótimo`、欧葡保留 `facto` 的 c）；
日期 `DD/MM/AAAA`；小数用逗号；变音符号全部保留。

**C 模式特别注意**：如果原文是**巴葡**，**不要转写、不要导入**，停下来在报告里说明。
用欧葡声音读巴葡文本会教错发音。validate 也会扫出巴葡词并提醒。

## 6. 生词 `words`

- 数量：A1/A2 **10–14 个**；B1 12–16 个；C 模式上限 16 个。按在正文中**第一次出现的顺序**排列。
- 选词优先级：对理解本文必不可少 > 高频实用 > 本课语法点涉及的词。
  **不选**一眼能猜出的同源词（`universidade`、`família`、`música`），也不选旧课已经出现过的词。
- `pt` 写词典形：动词用不定式；名词带冠词（`o` / `a`）；形容词用阳性单数
  （性别不规则时写 `bonito, -a`）；固定搭配照原样（`gostar de`、`ter … anos`）。
- `en` 是主释义，简短，写**本文中的义项**。可以括注巴葡对照：`"bus (Brazil: ônibus)"`。
- `zh` 是辅释义，简体中文。
- `ex` **必须是正文里的一句原句** —— 直接复制对应的 `sents[].t`（对话行去掉破折号）。
  不要另写例句。validate 会对「不在正文中」的 `ex` 提出提醒。
- **`ff` 不要写**，见下一节。

## 7. 翻译 `sents[].en` / `zh`

- 自然、准确，不逐词硬译，但不增删信息。
- 专有名词保留原拼写（`Largo do Senado`），中文第一次出现时可以括注（议事亭前地）。
- `en` 用自然的英式或国际英语，与她的课本口径一致。
- `zh` 用简体，口吻自然。澳门地名用当地通行的中文名。
- 习语译意思，并在 `note` 里解释字面意义。

## 8. 假朋友 `ff`：不用你标，系统自动标

假朋友由 **`tools/merge_lesson.py` 按 `tools/ff_list.json` 白名单自动补**：

- 你（Agent）在任何模式下都**不要写 `ff` 字段**。
- merge 时扫描生词，命中白名单就自动填上写好的说明；写了不在白名单里的 `ff` 会被移除。
- `validate.py` 的规则是「**`ff` 必须来自白名单**」，不来自白名单直接报错。

**遇到白名单里没有的真假朋友时**：不要自己加进生词，在**交付报告**里单列一行
「候选假朋友：`o 词` — 英文误解义 — 建议说明」，由人决定是否加进 `tools/ff_list.json`。

## 9. `note` 语法点 与 `qs` 理解题

**`note`**：中文，2–4 个要点，150–300 字。

- **每一点都要引用本文的原句作例子**，不要泛泛讲语法。
- 术语写成「中文（葡语术语 / English term）」，例如
  「代词式动词（verbos pronominais / pronominal verbs）」。
- 只讲本文真正用到的语法；欧葡与巴葡不同时点出差异。
- 结尾不要客套话。

**`qs`**：3 题（B1 可 4 题），**问题和答案都只用葡语**，且必须能从正文找到答案。

- A1 问事实（`Onde…?`、`Quem…?`、`O que…?`），A2 起可以加一题问原因（`Porque…?`）。
- 答案用完整短句，不要只写一个词。

## 10. 级别与长度

| 级别 | 段落 | 句数 | 词数 | 语法范围 |
|---|---|---|---|---|
| A1 | 2–3 | 8–10 | 100–130 | 现在时、ser/estar/ter/ir、缩合介词、基本代词 |
| A2 | 2–4 | 8–12 | 130–170 | ＋完成过去时、未完成过去时、ir＋不定式、代词后置 |
| B1 | 3–5 | 10–16 | 170–250 | ＋将来时、条件式、简单虚拟式、被动 se |

C 模式按实际难度定级；超过 250 词就拆成几篇（见第 11.2 节）。

## 11. 模式细则

### 11.1 B 模式：找素材并改编

- **只用欧葡来源**，优先澳门本地内容：Hoje Macau、Ponto Final、Tribuna de Macau、TDM、
  RTP Notícias、Público、P3、Observador、Lusa、Ciberdúvidas da Língua Portuguesa。
  **不要用 `.br` 站点。**
- 优先找与她**本周课堂主题**相关的；如果给了课程大纲或单元，按单元找。
- **改编不是转载**：读懂原文后用目标级别重写。可以保留事实和专有名词，
  但**连续照搬原文不超过一句**。`src.kind = "adapted"` 并写 `url`。
- 回避：政治争议、灾难或暴力细节、广告软文、时效性太强的数字（具体价格、汇率）。

### 11.2 C 模式：导入指定文章

- `text` **保持原文**，只做三件事：去掉多余空白、按原文分段、去掉图片说明/广告/「相关阅读」等非正文内容。
  **不改字词。**
- 超过 250 词：按段落拆成若干篇，`title` 后加 ` (1/3)`，`tags` 与 `src` 相同。
- `src.kind = "imported"`，`by` 填导入人（她自己导入就是 `"ann"`），`reviewed` **不写**。
- 原文有明显错别字**不要改**，在报告里列出来。
- 导入的课文**不需要人审核**，可以直接 `deploy.sh` 上线。前端会给她看到
  「我导入的」分组和一行「译文与讲解由 AI 生成，仅供参考」的小字。

## 12. 交付报告（做完必须输出）

```
课文：<title>（<level>，<句数> 句，<词数> 词，<生词数> 个生词）   草稿：drafts/xxx.json
模式：A / B / C      来源：<url 或 原创>      分配编号：L09
validate：通过 / <错误摘要>          build_audio：新合成 <N> 字符
自动标注的假朋友：<n 个，列出来>
需要你决定的：
- 候选假朋友：<词 — 英文误解义 — 建议说明>
- 拿不准的翻译或语法：……
- 巴葡疑点 / 原文错字：……
```

## 13. 禁止

- 编造来源、编造词义、编造假朋友。
- 手写 `a` / `s` / `wa` / `speaker` / `ff` 字段，或改动已有课文的 `text`
  （改了 `text` 旧音频就失效，还会重新消耗 Azure 额度）。
- 直接编辑 `site/materials.json`（一律走 `drafts/` + `merge_lesson.py`）。
- 更换 `VOICE` / `VOICE2`（换了等于全部音频重录）。
- A/B 模式在人确认前执行 `deploy.sh`。

## 14. 第二期（尚未实现，不要按这个做）

计划中但**还没做**的部分：她的导入课文单独放 `site/materials-ann.json`（前端合并显示），
App 内「导入文章」表单 → `POST /api/inbox` → Mac mini 定时用 C 模式自动处理并上线。
在实现之前，C 模式仍然走本文档第 2 节的命令行流程，草稿并入 `site/materials.json`。
