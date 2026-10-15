# Issue #2：复制解释提示词交付与接续

更新时间：2026-10-15。规格与后续验收记录见 [Issue #2](https://github.com/EiraWalker/readest/issues/2)。

## 当前状态

功能代码已实现，分支为 `feat/issue-2-copy-explanation-prompt`，起点为 `9fd7a4820`。
本轮从 `be21fe8f6` 继续，已完成 Windows Tauri debug/no-bundle 构建和独立程序、独立书库的原生验收。
原生验收发现并修复了“系统剪贴板拒绝访问时，WebView 回退仍可能报告成功”的问题；新增回归测试后，全量单测、类型检查和 Biome 均通过。
EPUB/PDF 实际系统剪贴板、跨页、失败保留与重试、异步改选、键盘、工具栏持久化、离线及无笔记副作用均已核对。
本轮详细命令、验证方法、输出样本及截图见 [Windows 验收记录](issue-2/windows-validation.md)。
此前 Web 生产构建和 Web 实际交互验证已通过；本轮修复只改变原生失败分支，Web 分支未改动。
尚待使用者自行粘贴到 ChatGPT Desktop 核对，Issue 保持开启；未合并或发布安装包。

## 使用与实现

在“设置 → 行为 → 自定义工具栏”中，把“复制解释提示词”从 Available 加入工具栏。
划选文字后点击按钮，将复制固定中文解释任务、完整选文以及可用的来源信息，供用户自行粘贴到 ChatGPT Desktop。

- 新按钮默认不显示，不加入 Quick Action，不改动已有工具栏顺序。
- 元数据限定为此次选区所属书籍；标题依次采用解析标题、书库标题、明确标注的文件名。
- 章节通过阅读引擎已有索引按选区起止锚点解析；没有匹配时只查询已加载文档内的前置标题。
- 跨文档选区保留各段正文、阅读顺序和各段可用 CFI；返回链接遵循既有偏好，标明返回选区起点。
- 固定版式采用确认的一基文档页序号，并注明“非印刷页码”。脚注只有可靠映射后才补充源章节。
- 点击时同步建立快照，等待既有剪贴板封装返回结果；失败可重试，旧操作不会清除后来新建的选区。
- Copy to Notebook 开启时也不创建摘录。没有新增 schema、设置字段、权限、Rust 功能或 AI 服务依赖。

| 代码入口（相对 `apps/readest-app/`） | 职责 |
| --- | --- |
| `src/app/reader/utils/explanationPrompt.ts` | 同步来源快照、章节端点处理、纯文本提示词构造 |
| `src/app/reader/components/annotator/Annotator.tsx` | 动作接入、共享剪贴板、反馈及异步选区保护 |
| `src/app/reader/components/annotator/AnnotationTools.tsx` | 工具定义及可访问名称 |
| `src/utils/annotationToolbar.ts`、`src/types/annotator.ts` | 工具注册；默认列表保持原样 |
| `src/types/view.ts` | 声明引擎已有的同步 `getProgressOf` 接口 |
| `src/utils/clipboard.ts` | 原生写入失败返回 false，避免 WebView 假成功；保留 Web 原有回退 |
| `public/locales/zh-CN/translation.json`、`zh-TW/translation.json` | 按钮、说明、成功和失败消息 |
| `src/__tests__/components/annotator/CopyExplanationPrompt.test.tsx` | 29 个动作到剪贴板的行为场景，含原生失败/WebView 假成功回归 |
| `src/__tests__/utils/annotationToolbar.test.ts` | 注册和默认行为兼容 |
| `src/__tests__/components/settings/AnnotationToolbarCustomizerEink.test.tsx` | 工具加入、移除、顺序及持久化 |

## 已完成的验证

以下命令从仓库根目录执行，结果对应当前功能源码。

| 检查 | 结果 |
| --- | --- |
| `pnpm test --run --maxWorkers=2 --testTimeout=15000 --reporter=dot` | 1,154 个文件通过，4 个跳过；13,667 项测试通过，16 项跳过 |
| 下列 3 个相关测试文件 | 55 项通过 |
| `pnpm lint` | TypeScript 与 Biome 通过 |
| `pnpm tauri build --debug --no-bundle --config <本地隔离配置>` | Windows 构建通过；包含 Next.js 编译、类型检查、静态导出及 Rust 编译 |
| `pnpm --filter @readest/readest-app build-web` | 上一提交的 Web 生产构建通过，本轮未重跑 |
| `pnpm test --run src/__tests__/next-config.test.ts --maxWorkers=1` | 还原临时构建配置后 5 项通过 |
| `pnpm exec biome check`（本轮两个 TS 文件） | 格式及 lint 通过 |
| `git diff --check` | 通过 |

```powershell
pnpm test --run src/__tests__/components/annotator/CopyExplanationPrompt.test.tsx src/__tests__/utils/annotationToolbar.test.ts src/__tests__/components/settings/AnnotationToolbarCustomizerEink.test.tsx --maxWorkers=2
```

行为测试覆盖真实 DOM Range、书籍模型和 Foliate 目录进度索引，包括嵌套及跨章节、独立书籍、长文本和缩进、多片段、PDF 页序号、脚注、缺失元数据、链接偏好、剪贴板 false/异常、等待期间改选及无笔记副作用。
章节边界测试曾先失败，再修复并通过，包含元素边界和“终点是下一标题首字符之前”的排他端点。

Web 实际验证使用独立 Edge 会话和仓库内 Alice EPUB/PDF 测试文件：

- 从设置启用按钮，使用键盘激活，读取实际系统剪贴板，核对完整选文、书名、Lewis Carroll、Chapter 1、CFI、链接和中文任务。
- 强制浏览器写入与兼容回退均失败，确认错误提示及选区保留；恢复 API 后，离线重试成功。
- 在 PDF 文字层复制，确认文档页序号 1、非印刷页码提示及 PDF 自身元数据。
- 开启 Copy to Notebook，确认未创建摘录；核对深色及 e-ink/RTL 外观。

验证截图：[深色](issue-2/web-dark.png)、[e-ink](issue-2/web-eink.png)。

## 新环境恢复

本次使用 Node.js 24.13.0、pnpm 11.1.1、Rust 1.99 MSVC。Windows 需要 Visual Studio 2022 C++ Build Tools 的“使用 C++ 的桌面开发”、Windows SDK 和 WebView2。
依赖准备以仓库 [CONTRIBUTING.md](../../../CONTRIBUTING.md#getting-started) 为准；pnpm 版本由根 `package.json` 固定。

```powershell
git clone --recurse-submodules --branch feat/issue-2-copy-explanation-prompt https://github.com/EiraWalker/readest.git readest-source
Set-Location readest-source
git submodule update --init --recursive
npm install --global pnpm@11.1.1
pnpm install --frozen-lockfile
pnpm --filter @readest/readest-app setup-vendors
pnpm tauri info
```

若用户配置指向不可用镜像，在当前 PowerShell 会话同时设置以下变量，再重试安装和 vendor 准备。pnpm 11 不再读取 `npm_config_*`；`npx` 仍需要 npm 的变量。可先用 `pnpm config get registry` 核对实际地址，无需修改全局配置。

```powershell
$env:pnpm_config_registry='https://registry.npmjs.org'
$env:npm_config_registry='https://registry.npmjs.org'
pnpm config get registry
```
保留仓库跟踪的 `.env`、`.env.web` 和 `.env.tauri`；本功能的本地阅读、复制不需要填写 AI Key。
不要把 `.env.local.example` 中的占位符当作可用服务配置。

先运行 `pnpm dev-web` 可以继续前端工作；Windows 原生验收运行 `pnpm tauri build --debug --no-bundle`。
上一轮 16 GB 环境同时运行全量测试和构建曾导致编译工具耗尽内存；本轮 Windows 11 x64 为 32 GB，但其他程序运行时可用内存较少，仍采用以下限制，并将全量测试与构建分开执行。
本轮初次 Rust 构建用时 24 分 01 秒；修复后的构建用时 4 分 10 秒，两次均成功：

```powershell
$env:CARGO_BUILD_JOBS='1'
$env:CARGO_PROFILE_DEV_DEBUG='0'
$env:CARGO_INCREMENTAL='0'
$env:NODE_OPTIONS='--max-old-space-size=3072'
$env:GOMEMLIMIT='1GiB'
$env:GOMAXPROCS='2'
$env:RAYON_NUM_THREADS='2'
$env:CIRCLE_NODE_TOTAL='3'
```

当前 Next.js 版本默认开启 Turbopack 生产文件系统缓存。中断后的缓存和编译器内存重叠曾引发资源分配错误。
本轮构建临时设置了 `experimental.turbopackFileSystemCacheForBuild: false` 和 `experimental.cpus: 1`，前端编译通过；构建后已按原文件还原，没有包含在功能提交中。
新环境如遇同类问题，可依据 [Next.js 缓存文档](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache) 临时关闭生产缓存后重试；避免提交机器专用配置。

## 剩余交接

1. 使用独立测试程序，划选 Alice EPUB 或 PDF 的文字，点击“复制解释提示词”。
2. 由使用者自行切换到 ChatGPT Desktop 粘贴，核对中文任务、完整原文、书名、作者、章节或文档页序号与选区一致，再自行决定发送。
3. 把人工交接结果补充到 Issue #2，由维护者决定合并及关闭 Issue。

没有自动启动、控制 ChatGPT Desktop、粘贴或发送。release 优化构建、签名及安装包未执行；本轮验收对象是独立的 Windows debug 可执行程序。

若测试机已有 Readest，可用 `--config` 加载自行创建的本地 Tauri 覆盖，使用独立 identifier，并把 `plugins.deep-link.desktop.schemes` 设为 `[]`，避免测试程序注册日常协议。
在独立测试可执行文件目录创建 `settings.json`（内容 `{}`）可触发既有 portable 模式，从而隔离书库。
这些测试配置不随源码提交。测试时使用独立的 WebView2 用户目录，禁用更新，不运行安装程序；现有安装和日常书库未参与验收，已有协议处理项与测试前一致。

## 上一轮清理与本轮交付边界

上一轮按用户要求停止原生编译，删除当时的构建目录、依赖目录、生成的 vendor/权限/schema/TypeScript 缓存及浏览器测试缓存。
同时删除临时 `.npmrc`、`.env.local` 和 `tauri.issue2.local.json`，还原构建工具改写的跟踪文件。
本轮已重新恢复依赖和 vendor，完成构建后还原临时 Next.js 配置，以及 Tauri/Turso 子模块的构建生成文件。提交仅包含剪贴板修复、回归测试与验收文档/证据；依赖、缓存、vendor、构建产物和隔离配置未提交。
独立测试可执行程序及完整本地日志作为接续材料保留，便于完成人工粘贴验收。源码不依赖本机临时路径或临时配置。
系统级已安装的编译工具不属于项目构建产物；已有 Readest 安装与日常书库未参与本次清理。
