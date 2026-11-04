# 从 GitHub Release 安装 dsh-followup

> 不需要 npm。Release 里带了一个预构建包，装完重启 App 即可。
> 适用：DSH 桌面端（macOS）和 `dsh web` 的 web profile。

## 先确认两件事

1. **插件是装到哪个 profile**
   - 桌面 App：`desktop`
   - `dsh web` 起的网页：`web`
2. **桌面 App 要先完全退出**
   - 点窗口左上角红叉只是关窗口，进程还在。
   - 用 `⌘Q`，或菜单栏 **DeepSeek Harness → Quit DeepSeek Harness**，确认 Dock 图标消失。

## 方式 A：直接装 Release 里的 tarball（推荐）

### 1. 下载 tarball

浏览器打开：

https://github.com/bingomu/dsh-followup/releases/tag/v0.2.1

下载 **Assets** 里的：

```
bingomu-dsh-followup-0.2.1.tgz
```

或者终端：

```bash
cd ~/Downloads
curl -L -O https://github.com/bingomu/dsh-followup/releases/download/v0.2.1/bingomu-dsh-followup-0.2.1.tgz
```

### 2. 找到 dsh 命令

桌面 App 自带 CLI，但通常不在 PATH 里：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --version
```

如果这条能打印版本，后面就用这个完整路径。
想以后直接敲 `dsh`，可以加个别名：

```bash
alias dsh='"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"'
```

### 3. 装进 desktop profile

**先 `⌘Q` 完全退出桌面 App**，然后：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add \
  "file:$HOME/Downloads/bingomu-dsh-followup-0.2.1.tgz"
```

看到类似输出就成功了：

```
dependencies:
+ @bingomu/dsh-followup 0.2.1
```

CLI 会自动把它加进 `dsh.profile.bundles`，不需要再手工改 `package.json`。

### 4. 重新打开 App

这一次要**重新打开**（不是刷新页面），因为宿主半要在启动时组装。

### 5. 验证

- 左栏底部出现 **「跟进」**（带数字角标）
- 任意对话右上角出现项目标记（`dsh-followup v0.2.1`）
- 数据目录：`~/.dsh/followup/`（`tasks.json`、`projects.json`）

## 方式 B：直接从 GitHub 源码装

同样是先退出桌面 App，然后：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add github:bingomu/dsh-followup
```

这个会从 GitHub 拉源码（仓库里没有构建步骤，装完就能用），但比 tarball 慢，也不带 Release 的校验。

## 方式 C：web profile

如果你用的是 `dsh web`：

```bash
dsh plugin --profile web add \
  "https://github.com/bingomu/dsh-followup/releases/download/v0.2.1/bingomu-dsh-followup-0.2.1.tgz"
```

然后重启 web 进程。

## 卸载

先完全退出 App，然后：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove @bingomu/dsh-followup
```

再打开 App。

数据不会删：`~/.dsh/followup/` 还在。要彻底清空就手动删这个目录。

## 常见问题

**`dsh: command not found`**
用上面的完整路径，或加 alias。

**`Open DeepSeek Harness Desktop once to initialize its profile...`**
说明 `desktop` profile 还没建，或者 App 没完全退出。先打开一次 App、再 `⌘Q`，然后重试。

**装完没反应**
- 确认是 `⌘Q` 退出后重开的，不是只刷新页面。
- 检查 profile：`~/.dsh/profiles/desktop/package.json` 里应该有
  `"@bingomu/dsh-followup"` 和 `dsh.profile.bundles` 里的同名条目。
- 看 App 日志里有没有 `dsh-followup` 的报错。

**想确认版本**
```bash
python3 -c "import json;print(json.load(open('$HOME/.dsh/profiles/desktop/node_modules/@bingomu/dsh-followup/package.json'))['version'])"
```
