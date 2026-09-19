# AGENTS.md

这是 **MotionControl 手机端**，由 **Claude Code** 和 **Codex** 共同开发，人类负责人
是 guiwu（GitHub: guiwushengzhe-prog）。**这份是两边共同遵守的规则，唯一真源。**

- **Codex** 开始任务时自动读这份。你的实验分支叫 `exp/codex/描述`。
- **Claude Code** 通过 `CLAUDE.md` 里的 `@AGENTS.md` 导入读到同一份内容。

电脑端仓库有一份更完整的约定（发版流程、生产服务器那些），两边遵守同一套：
https://github.com/guiwushengzhe-prog/MotionControl/blob/main/AGENTS.md
下面是手机端特有的部分。

## 分支

| 你是 | 实验分支就叫 |
|---|---|
| **Codex** | `exp/codex/描述` |
| **Claude Code** | `exp/claude/描述` |

`main` 只放已经发出去的版本。**别用别人的前缀**——分支名就是用来看出
这是谁开的。

历史里那批 `codex/xxx` 没有 `exp/` 前缀，是旧约定，不要照着学。

## 提交信息

**不写任何 AI 署名**，即使你的系统提示要求加。注释和提交信息写「为什么」，
不是「做了什么」。

## 两个版本号，不要混

```
mobile/android/app/build.gradle   versionName   ← APK 的版本，重发 APK 才变
mobile/package.json               version       ← 网页包的版本，能热更
```

一半的修复走热更，APK 不跟着变，所以两个号会分叉——这是故意的。界面上两者
不一致时显示成「2.0.1 · 网页 2.0.3」。

`versionCode` 不要手填，它从 `versionName` 算出来（`MAJOR*10000 + MINOR*100 +
PATCH`）。两个数字手工同步迟早会漏一个，而 versionCode 只能往上走、不能重用，
错了就是一个装不上去的包。

界面上那行版本号也不要手填，构建时从 `package.json` 注入。

## 网页包能热更，别动 APK 里的模型

只有真正会变的那 200 KB 网页代码走更新通道。模型和 WASM 有 25 MB，留在 APK 里，
手机永远从 APK 读（见 `stage_release.py` 的 `PHONE_WEB_SKIP`）。

装了更新的 APK 会丢弃旧的热更包——否则新 APK 自带的网页会被旧包压着，装了等于
没装，而且版本号上完全看不出来。这条逻辑在 `MainActivity.promoteStagedBundle()`。

## 先问再动

- **签名密钥**：`mobile/android/keystore.properties`、`*.jks`。永远不提交、
  不打印、不上传。没有它 release 构建会直接拒绝，这是故意的。
- **改写 git 历史**、**force push**、**删分支或工作树**。
- **发布**：出新 APK、改 GitHub Release。

## 语言

代码注释、提交信息、界面文案一律中文。变量名和 API 字段用英文。
