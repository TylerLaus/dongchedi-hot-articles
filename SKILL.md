---
name: dongchedi-hot-articles
description: 生成懂车帝热搜文章。抓懂车帝资讯页右侧「热门内容」热搜榜 TOP 5，每条热搜整合 2 篇按发布时间倒序的原文为 1 篇公众号风格的资讯稿，配图本地化以防 CDN 链接过期。当用户说「生成懂车帝热搜文章」「跑一遍懂车帝热搜」「写懂车帝热搜文」「懂车帝热搜文章」时触发。
---

# 生成懂车帝热搜文章

把懂车帝资讯页热搜榜 TOP 5 转写成 **5 篇独立的公众号资讯文章**。每篇基于该热搜下按发布时间倒序的 2 篇懂车帝原文整合而成，配图本地化。

## 执行步骤

### Step 1: 检查 state 缓存

读 `./hot-articles/state.json`。若存在且 `fetchedAt` 在 60 分钟内，跳到 Step 3（复用缓存）。否则继续 Step 2。

### Step 2: 拉数据 + 下载配图

在当前目录跑：

```bash
source ~/.nvm/nvm.sh && node ~/.claude/skills/dongchedi-hot-articles/fetch.mjs
```

脚本会顺序执行：
1. `opencli dongchedi hot --limit 5 --per 2` 拿 TOP 5 热搜 × 每条按发布时间倒序的 2 个 gid
2. 对 10 个 gid 逐个调 `opencli dongchedi article <gid>` 拿正文 + 大图
3. 下载所有图片到 `./hot-articles/images/<md5>.jpg`
4. 写清单到 `./hot-articles/state.json`

⏱ 预计 3-5 分钟。脚本会打印进度。

**失败处理**：
- 若报「EmptyResultError」或「No cookies」→ 让用户在 Chrome 打开 `https://www.dongchedi.com/news` 并刷新一下，再重跑
- 若某些 gid 404（文章不可见），脚本会把 `sources[i] = { error: "..." }`，**该条热搜仍生成文章**，只是只用剩下的 1 篇原文

### Step 3: 读 state.json，按 topic 逐条写文章

用 Read 读 `./hot-articles/state.json`。

**筛选规则（重要）**：一个 topic 只在**至少有 1 个 source 同时满足 `text` 非空 **且** `coverImages + inlineImages` 至少有 1 张本地图**时才生成文章。判断时数 path 字段：`coverImages.length + inlineImages.length > 0` 才算有图。不满足的 topic 一律跳过，**不要为它写文件**，也不要用 abstract 凭空补图。

跳过的 topic 在最后报告里列出来（rank、title、跳过原因），便于用户排查。

每个保留的 topic 写一个文件：`./hot-articles/<rank-2位>-<safe-title>.md`，例：`01-小米yu7gt实车上路.md`。文件名只保留中英文数字，去空格。

## 文章模板

```markdown
# <新标题：20 字以内，信息密度高，不抄原文>

![](images/<封面图文件名>)

<导语 100-150 字：发生了什么 + 关键参数 + 价格/时间>

<正文段落 1>

![](images/<内联图>)

<正文段落 2>

...

---

**信息来源**

- [<原文 1 title>](<原文 1 url>) · <原文 1 author>
- [<原文 2 title>](<原文 2 url>) · <原文 2 author>

> 懂车帝热搜榜第 <rank> 位 · 热度 <score>
```

## 写作风格（公众号资讯风）

- **客观汇报**：交代核心事实（什么车 / 发布 / 上市 / 价格 / 关键参数），不带「小编觉得」「咱们一起来看看」
- **导语优先**：第一段把最重要的信息说清楚（5W：what/when/where/who/how much）
- **逻辑分块**：建议顺序「外观 → 内饰 → 配置 → 动力 → 价格」，没必要的章节省略
- **段落短**：单段 100-200 字，方便公众号阅读
- **数据合并去重**：2 篇原文的事实点合并。如有矛盾（例如价格不一致），保留两个值并标注来源
- **不捏造**：所有事实必须能在原文里找到。如果两篇原文都缺关键信息（如视频文章 text 为空），用 `sources[i].abstract` 兜底
- **视频源处理**：`isVideo: true` 的 source 通常 `text` 为空，依赖 `abstract`
- **标题**：不要照抄原文标题。重写一个有信息密度、20 字以内的新标题

## 配图规则（关键：图文对齐）

`coverImages` 和 `inlineImages` 现在是对象数组：`[{ path, caption }]`。**`caption` 是图在原文里的图说**（如「全新紫色车身涂装」「7座车型第三排座椅新增大床模式」），是图文对齐的关键依据。

### 选图原则

1. **封面 1 张**：从 `coverImages[0]` 取。封面通常没有 caption（为 null）
2. **正文配图**：从 `inlineImages` 里按 caption 与段落内容的关联挑。例如：
   - 你写的段落讲「外观/紫色配色」→ 找 caption 含「紫」「涂装」「外观」的图
   - 你写的段落讲「第三排座椅大床模式」→ 找 caption 含「第三排」「大床」的图
   - 你写的段落讲「电池/动力」→ 找 caption 含「电池」「充电」「动力」「发动机」的图
3. **不要乱插**：如果某段落找不到强相关的图，宁可不插图，也不要硬塞无关图
4. **caption=null 的图**：通常是装饰/分隔图，慎用；可以放文章末尾作收尾，或不用
5. **可选：在图下面用 `*<caption>*` 显示图说**，让读者看明白图的内容（公众号常见做法）
6. 不重复用同一张图

### 配图频率

整篇文章 4-8 张图比较合适：1 张封面 + 3-7 张正文图。不需要每段都配图。

## 完成后

向用户报告：
- 生成了 N/5 篇文章
- 配图 X 张本地化
- 输出目录 `./hot-articles/`
- **跳过列表**：列出所有不满足「至少 1 source 有 text+image」的 topic（rank、title、跳过原因，例如「2 个 source 都 404」「source 都缺本地图（CDN 403）」），让用户知道为什么没生成对应文章

## state.json 结构参考

```json
{
  "fetchedAt": "2026-05-12T10:30:00.000Z",
  "topics": [
    {
      "rank": 1,
      "title": "小米YU7 GT车厘子红实车上路",
      "score": 142869,
      "searchUrl": "...",
      "sources": [
        {
          "gid": "7632279272337752638",
          "title": "千匹性能加持，极速300km/h...",
          "author": "奋斗7667104467613",
          "pubTime": "2026-04-24T11:03:00.000Z",
          "isVideo": false,
          "duration": null,
          "abstract": "（来自搜索预览的摘要）",
          "text": "（完整正文，HTML 已去标签）",
          "url": "https://www.dongchedi.com/article/...",
          "coverImages": [{ "path": "images/abc.jpg", "caption": null }],
          "inlineImages": [
            { "path": "images/def.jpg", "caption": "全新紫色车身涂装" },
            { "path": "images/ghi.jpg", "caption": "7座车型第三排新增大床模式" }
          ],
          "stats": { "read": 581, "digg": 0, "comment": 1 }
        },
        { ... second source, possibly { "error": "Article 404 not found" } }
      ]
    }
  ]
}
```
