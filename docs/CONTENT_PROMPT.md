# 新批次课文的生成提示词（CONTENT_PROMPT.md）

> **这份文件是模板，不是范文。** 出新一批课文时，把这个文件整段交给一个强模型
> （Claude 网页版、或 Mac mini 上跑 API 脚本都行），只改下面三个变量。
> 产出的 JSON 直接替换 `site/materials.json` 里的 `lessons` 数组，然后走
> `validate.py` → `build_audio.py` → `deploy.sh`。
>
> 为什么要有这份文件：把「写成什么样」的规则固定下来，每批只花时间在**检查**上，
> 而不是每次重新想格式。上一批 L01 的四个假朋友全是错的，就是因为没有规则、
> 又是自动生成后没人看。

---

## 你要填的三个变量

| 变量 | 说明 | 例 |
|---|---|---|
| `{{主题}}` | 这一批课文围绕什么（最好对着她这周课上的主题/语法） | 在澳门点餐、问路、聊周末计划 |
| `{{级别}}` | `A1` 或 `A2` | A1 |
| `{{篇数}}` | 生成几篇 | 3 |

---

## 给模型的指令（以下整段复制）

你是欧洲葡萄牙语（pt-PT）教材作者，为一名澳门大学葡语专业大一学生写课文。
她母语中文，用英文学葡语（课本、老师讲解、考试都用英文），水平 A1–A2。

### 一、产出格式：一个 JSON 对象

顶层是 `{"lessons": [...]}`，每篇课文的结构**必须**严格如下（字段名不能改）：

```json
{
 "id": "L09",
 "level": "A1",
 "min": 5,
 "reviewed": "YYYY-MM-DD",
 "title": "葡语标题",
 "zh": "中文标题",
 "en": "English title",
 "text": "第一段。第二句。\n第二段。第二句。",
 "note": "语法点讲解（中文，术语标葡语和英文）",
 "sents": [
  {"p": 0, "t": "第一句。", "en": "First sentence.", "zh": "第一句。"},
  {"p": 0, "t": "第二句。", "en": "Second sentence.", "zh": "第二句。"}
 ],
 "words": [
  {"pt": "a palavra", "en": "the word", "zh": "这个词", "ex": "例句。"}
 ],
 "qs": [
  ["葡语问题？", "葡语参考答案。"]
 ]
}
```

### 二、`sents` 是逐句翻译的**唯一来源**（最容易错，先看这条）

- 正文 `text` 用 `\n` 分段；`sents[].p` 是**段落序号，从 0 开始**。
- **同一段（`p` 相同）的 `t` 用空格拼起来，必须与 `text` 对应段落逐字一致**，
  包括标点与大小写。`tools/validate.py` 会硬校验这一条，不一致直接退出码 1。
- 一句一条：按 `.`、`?`、`!` 切句；冒号后的完整分句如果自己成句，也单独一条。
- 对话行的破折号**留在 `t` 里**（`"— Bom dia!"`）。合成音频时脚本会自己剥掉行首破折号。
- 每句都要有 `en` 和 `zh`。**不要**另外写 `trans` 或 `trans_lines` —— v2 起已删除，
  全文翻译由前端按段落拼 `sents`。

### 三、语言口径：只能是欧洲葡语（pt-PT）

这是 AI 最常犯错的地方。**下面的巴葡用法一律不许出现**（`validate.py` 会自动扫）：

| 不许用（巴葡） | 要用（欧葡） |
|---|---|
| `ônibus` | `autocarro` |
| `trem` | `comboio` |
| `celular` | `telemóvel` |
| `café da manhã` | `pequeno-almoço` |
| `geladeira` | `frigorífico` |
| `banheiro`（当"厕所"用） | `casa de banho` |
| `garçom` | `empregado de mesa` |
| `estou fazendo`（进行时） | `estou a fazer` |
| `você`（当"你"用） | 省略主语，或 `o senhor` / `a senhora` |
| `legal`（当"好/酷"用） | `fixe`、`ótimo` |

其他必须遵守的欧葡特征：

- 代词式动词代词**后置**：`Chamo-me`、`Deito-me`（不是 `Me chamo`）
- 完成过去时 `-ar` 动词的 nós 形式**加音标**：`apanhámos`、`comprámos`、`entrámos`
- `se faz favor` = 请（欧葡特有）
- 月份与季节**小写**：`maio`、`o verão`（新正字法）
- 日期 `DD/MM/AAAA` 不补零；小数用逗号
- 变音符号**全部保留**（只有听写判定时才忽略重音）
- 词汇：`livraria` 是书店（`biblioteca` 才是图书馆）、`o sítio` 是地方、`apanhar` 是搭乘

### 四、生词表 `words`

- **每课 10–14 个**。`pt` 要带冠词（`a palavra`、`o comboio`），词组照原样（`gostar de`）。
- `en` 英文释义（主），`zh` 中文释义（辅）。英文释义里可以点出巴西说法做对照：
  `"bus (Brazil: ônibus)"`。
- `ex` 例句：**从本课正文里挑一句**，不要另写。
- `ff`（假朋友）**只在真正会搞错时才标**，见下。
- 生词按在课文中出现的顺序排列。

### 五、假朋友 `ff`：宁可不标，也不要标错

`ff` 会在词旁显示橙色标签，只有**少用且准确**时才有提醒作用。
标错一次，她以后就对这个标签视而不见了。

**允许出现的**（英文母语者/用英文学葡语的人真会搞错的）：

| 词 | 说明 |
|---|---|
| `a livraria` | ≠ library。图书馆是 `a biblioteca` |
| `o largo` | ≠ large。形容词 `largo` 是 wide；large 是 `grande` |
| `atualmente` | ≠ actually。是"目前"；actually 是 `na verdade` |
| `puxar` | ≠ push。是"拉"；推是 `empurrar` |
| `a professora` | ≠ professor（英文多指大学教授）。葡语从小学到大学都叫 professor/professora |
| `o colégio` | ≠ college。一般指中小学；大学是 `universidade` |
| `provar` | 餐桌上/试衣间里是 taste / try on；"证明"才是 `provar que…` |
| `o tempo` | 是天气或时间；英文 tempo 指节奏速度 |
| `o curso` | ≠ course（一门课）。是整个学位专业；一门课叫 `a cadeira` |
| `a fábrica` | ≠ fabric。是工厂；fabric 是 `o tecido` |
| `sensível` | ≠ sensible。是 sensitive；sensible 是 `sensato` |

`ff` 文字写成「≠ 英文词。正确说法是……」的形式。

⚠️ **任何一篇课文只要有 `ff`，就必须同时有 `reviewed` 字段**（填当天日期）。
`validate.py` 会拒绝没有 `reviewed` 的带 `ff` 课文 —— 这是强制人工过一眼的闸门。

### 六、正文与语法

- 正文长度：A1 每篇 8–10 句 / 约 100–130 词；A2 每篇 8–12 句 / 约 130–170 词。
- 全部原创，**不引用教材、报纸、歌词原文**。
- 语法点按欧葡规范讲；与课堂讲法冲突时**以老师为准**（`note` 里可以点出这个差异）。
- `note` 用中文，但术语标上葡语和英文，例如：
  「代词式动词（verbos pronominais / pronominal verbs）……」
- 每课 3 个 `qs` 理解题，**问题和答案都只用葡语**。

### 七、`id` 与难度

- `id` 形如 `L09`、`L10`（`L` + 至少两位数字），必须与已有课文不重复。
- `level` 只写 `A1` 或 `A2`；`min` 是预计学习分钟数（A1 填 5，A2 填 6–8）。

### 八、交付前自检（把这几条命令的输出一起给我）

```bash
python3 tools/validate.py --audio      # 段落对齐 / ff 有没有 reviewed / 巴葡黑名单
python3 tools/build_audio.py           # 看「新合成字符数」，正常只有新增生词那几百
./deploy.sh
```

**如果 `build_audio.py` 报出几千字符的新合成**，说明 `sents` 的切句与正文对不上，
音频没能复用 —— 停下来检查第二条（`sents` 拼接是否与 `text` 逐字一致），不要硬发。

---

## 成本与额度

每课音频约 1,500–2,000 字符，Azure 每月 50 万免费额度，够几百课。
同一个词只用同一个声音合成一次，之后全家共用缓存，不再消耗额度。
**不要随意更换主声音** —— 从 `RaquelNeural` 换成别的，等于所有音频重合成一遍。

## 价值最高的一件事

每学期开学让她把课程大纲或教材单元列表拍给你，**每批素材对着她这周课上的主题和语法**。
这样 App 是在"帮她应付课堂"，而不是另一份额外作业 —— 坚持率会高很多。
