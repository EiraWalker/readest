# Issue #2 Windows 原生验收（2026-10-15）

## 结果与修复

Windows Tauri debug/no-bundle 构建成功，独立程序的实际系统剪贴板验收通过。手工交接到 ChatGPT Desktop 尚未执行，Issue 保持开启。

测试开始时，Tauri 剪贴板插件和独立 Win32 `OpenClipboard` 均拒绝访问，但 WebView2 的浏览器回退可能返回成功。原实现因此显示成功并清除选区。修复既有 `writeTextToClipboard` 原生分支：原生插件失败即返回 false，不再尝试可能假成功的 WebView 回退。Web 分支保持原行为；没有增加权限、原生能力或配置项。

先增加高层回归测试，以真实共享剪贴板封装和可控原生 SDK 驱动工具栏：原生拒绝而浏览器承诺成功时，修复前测试失败；修复后错误反馈、选区保留、无笔记副作用及原生重试全部通过。原生新程序也实际观察到错误提示、无成功提示、保留选区及再次尝试。用户关闭剪贴板同步软件后，独立 Win32 访问恢复，以下成功路径再通过实际写入和独立读取验证。

最后剪贴板所有者曾显示为同步软件，但没有证据证明它就是持锁者，因此不将其定为根因，也没有终止或修改该软件。

## 环境与隔离

- Windows 11 x64，32 GB 内存；Node.js 24.13.0、pnpm 11.1.1、Rust/Cargo 1.99 MSVC、Visual Studio 2022、WebView2 155.0.4283.45。
- 源码从 `be21fe8f6` 恢复，子模块按 gitlink 递归初始化；依赖及 vendor 已准备。
- 独立 identifier：`com.eirawalker.readest.issue2test`；测试 EXE 同目录 `settings.json` 启用已有 portable 模式。书库与 WebView2 profile 均为专用目录，无账号或 AI Key。
- `READEST_DISABLE_UPDATER=1`，本地覆盖将 `plugins.deep-link.desktop.schemes` 设为 `[]`。没有运行安装程序；三个已有协议处理项测试前后均一致。
- 自动化仅连接测试程序 WebView2 的 loopback CDP 端口，不连接日常浏览器或 Readest。结束时正常关闭测试程序。

## 实际命令与检查

依赖恢复和内存限制见[交付文档](../issue-2-handoff.md#新环境恢复)。实际工作根目录为 `E:\Codex\readest-issue2-20261015`，以下命令在其 `repo` 目录执行，测试和构建分开运行。

```powershell
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm --filter @readest/readest-app setup-vendors
pnpm tauri info

pnpm test --run src/__tests__/components/annotator/CopyExplanationPrompt.test.tsx src/__tests__/utils/annotationToolbar.test.ts src/__tests__/components/settings/AnnotationToolbarCustomizerEink.test.tsx --maxWorkers=2
pnpm test --run --maxWorkers=2 --testTimeout=15000 --reporter=dot
pnpm lint

pnpm tauri build --debug --no-bundle --config E:\Codex\readest-issue2-20261015\tauri.issue2.local.json

# 还原 next.config.mjs 的临时内存限制之后
pnpm test --run src/__tests__/next-config.test.ts --maxWorkers=1
pnpm exec biome check apps/readest-app/src/utils/clipboard.ts apps/readest-app/src/__tests__/components/annotator/CopyExplanationPrompt.test.tsx
git diff --check
```

| 检查 | 实际结果 |
| --- | --- |
| 原生失败/WebView 假成功回归 | 修复前红，修复后绿 |
| 三个相关文件 | 55 项通过 |
| 全量单测 | 1,154 个文件通过、4 个跳过；13,667 项通过、16 项跳过；1,022.76 秒 |
| `pnpm lint` | TypeScript 通过，Biome 检查 2,792 个文件通过 |
| 首次原生构建 | 前端编译、类型检查和导出通过；Rust 24 分 01 秒，退出码 0 |
| 含修复的原生构建 | 前端编译、类型检查和导出通过；Rust 4 分 10 秒，退出码 0 |
| 还原临时配置后的测试 | 5 项通过 |
| 最终两个 TS 文件的 Biome 检查 | 通过，无自动修复 |

默认推送钩子随后再次运行了无参数的全量测试，`library-search-ssr.test.ts` 的 `imports without browser globals` 在 5,015 ms 超时；该轮已中断，**没有计为通过**。原因尚未确认，已独立记录为 [Issue #3](https://github.com/EiraWalker/readest/issues/3)。不以受限参数下通过代替默认参数通过，也没有改动该 SSR 测试、Vitest 配置或仓库钩子。

本次推送采用一次性的本地 `core.hooksPath`，仍顺序执行仓库要求的三项检查，仅为全量测试加上本机已使用的资源及超时参数；该 hook 和配置不提交：

```sh
pnpm -C apps/readest-app format:check
pnpm -C apps/readest-app lint
pnpm -C apps/readest-app test --run --maxWorkers=2 --testTimeout=15000 --reporter=dot
```

验收 EXE SHA256：`A0EE032F8062B68585669DD3D88B7597123887B00F71079547CFB5065C74F05C`。这是未经 release 优化、签名和安装包封装的 debug 程序。

本地隔离配置内容如下，不随源码提交：

```json
{
  "productName": "Readest Issue 2 Test",
  "identifier": "com.eirawalker.readest.issue2test",
  "plugins": { "deep-link": { "desktop": { "schemes": [] } } }
}
```

## 验收方法与矩阵

使用仓库 `sample-alice.epub`、`sample-alice.pdf`，以及仅含测试材料的 EPUB（嵌套章节、多行代码、长选区、非线性脚注文档和缺失标题/作者）。原生成功后，通过独立 Python/Win32 程序读取 `CF_UNICODETEXT`，与所选正文比较；不以 DOM、WebView 返回值或 IPC 参数代替系统剪贴板成功证据。

异步改选使用 CDP 在真实 `plugin:clipboard-manager|write_text` 入口暂停：点击时快照 A，暂停期间选择 B，再恢复实际原生调用。没有替换 bridge 或伪造原生写入结果。早期系统拒绝访问时仅采集到的 IPC 文本，在[证据记录](windows-evidence.json)中明确标记为 `clipboardWrite: blocked`；后续系统读取成功另列。

| Issue 场景 | Windows 实际核对 | 行为测试补充 |
| --- | --- | --- |
| 自动标题、作者 | EPUB 标题与 Lewis Carroll；PDF 独立元数据标题与 Chuck；缺标题时用书库显示名，缺作者时省略 | 明确文件名降级、全缺字段省略 |
| 选区章节 | 选区在 Section A.1，屏幕进度为 Section A.2，输出 A.1 | 元素边界、排他终点、无目录前置标题 |
| 多书/分屏 | 三本书同时打开，分别复制，标题、作者、返回链接不串书 | 独立书籍模型 |
| 跨章节 | A.1 至 A.2 的正文及起止章节 | 仅起点可识别、跨文档等边界 |
| 默认中文 prompt | 无账号、Key 或模板配置即可复制 | 固定任务及引用材料边界 |
| 多行/长选区 | 缩进、换行及末尾换行保留；41,641 字符全部写入并读回 | 多片段和空白边界 |
| PDF、跨页 | 真实鼠标跨第 1、2 页拖选；两段正文、两段 CFI 顺序正确，页序号 1–2，明确非印刷页码；链接标为返回选区起点 | 不可信页号省略、片段定位缺失 |
| 脚注 | 真实弹窗全文、实际脚注文档 CFI；未可靠映射的章节省略 | 无任何源定位时仍可复制 |
| 失败及重试 | 系统拒绝写入时错误提示、保留选区、再次尝试；系统访问恢复后实际复制成功 | false、异常、原生失败/WebView 假成功及恢复成功 |
| 异步改选 | 系统剪贴板为点击时 A，新选区 B 保留；原生失败路径也保留 B | 原生选区尚未进入 React 状态的竞争 |
| 无副作用 | Copy to Notebook 开启，普通 Copy 创建 1 条摘录作为正对照；多次解释复制后仍为 1 条 | 无笔记、高亮或设置写入 |
| 设置兼容 | Available 默认、非 Quick Action；加入/移除、真实鼠标排序；等待设置保存后重载顺序保留 | 旧列表顺序不被改变 |
| 空选区 | 成功后清除选区并关闭工具栏 | 空白不写入、不提示成功 |
| 平台/可访问性 | Windows 实际鼠标划选，Enter/Space 激活；浅色、深色及 e-ink 检视 | 可访问名称、自定义工具栏 e-ink |
| 离线 | 阻断外部 HTTP(S) 后仍写入成功；动作只有本地剪贴板 IPC，没有外部请求 | 不依赖 AI 服务 |
| ChatGPT Desktop 手工交接 | **待使用者自行粘贴核对** | 不自动控制外部应用 |

完整输出样本：[EPUB](windows-clipboard-epub.txt)、[跨页 PDF](windows-clipboard-pdf-cross-page.txt)。机器可读的逐项记录：[windows-evidence.json](windows-evidence.json)。构建、红绿回归、全量测试及 lint 原始日志保留在本地交付材料中。

截图：[深色](windows-dark.png)、[e-ink](windows-eink.png)、[PDF 跨页选区](windows-pdf-cross-page.png)、[原生失败保留选区](windows-error.png)。

临时 Next.js 配置及子模块的权限文档/schema 生成改动已还原，未提交依赖、vendor、构建产物或机器配置。没有执行 release/签名/安装包验收，也没有合并分支。
