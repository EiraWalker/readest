# Issue #2：复制解释提示词交付与接续

更新时间：2026-10-15。规格与后续验收记录见 [Issue #2](https://github.com/EiraWalker/readest/issues/2)。

## 当前状态

功能代码已实现，分支为 `feat/issue-2-copy-explanation-prompt`，起点为 `9fd7a4820`。
全量单测、类型检查、Biome、Web 生产构建和 Web 实际交互验证已通过。
按用户要求，Windows 构建已在 Rust 依赖编译阶段终止；尚未生成可供验收的 Windows 程序，也未完成 Windows Tauri 手工验证。
Issue 应保持开启，待新环境完成原生验收后再更新状态。

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
| `public/locales/zh-CN/translation.json`、`zh-TW/translation.json` | 按钮、说明、成功和失败消息 |
| `src/__tests__/components/annotator/CopyExplanationPrompt.test.tsx` | 28 个动作到剪贴板的行为场景 |
| `src/__tests__/utils/annotationToolbar.test.ts` | 注册和默认行为兼容 |
| `src/__tests__/components/settings/AnnotationToolbarCustomizerEink.test.tsx` | 工具加入、移除、顺序及持久化 |

## 已完成的验证

以下命令从仓库根目录执行，结果对应当前功能源码。

| 检查 | 结果 |
| --- | --- |
| `pnpm test --run --maxWorkers=2 --testTimeout=15000 --reporter=dot` | 1,154 个文件通过，4 个跳过；13,666 项测试通过，16 项跳过 |
| 下列 3 个相关测试文件 | 54 项通过 |
| `pnpm lint` | TypeScript 与 Biome 通过 |
| `pnpm --filter @readest/readest-app build-web` | Web 生产构建通过 |
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

若 npm 用户配置指向不可用镜像，可在当前 PowerShell 会话临时设置 `$env:npm_config_registry='https://registry.npmjs.org'` 后重试安装和 vendor 准备。
保留仓库跟踪的 `.env`、`.env.web` 和 `.env.tauri`；本功能的本地阅读、复制不需要填写 AI Key。
不要把 `.env.local.example` 中的占位符当作可用服务配置。

先运行 `pnpm dev-web` 可以继续前端工作；Windows 原生验收运行 `pnpm tauri build --debug --no-bundle`。
本机 16 GB 内存下，同时运行全量测试和构建曾导致编译工具耗尽内存；应分开执行。
后续单任务构建使用了以下会话变量，已完成 Next.js 静态导出和类型检查，随后在 Rust 编译期间按用户要求停止：

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
最后一次构建还临时设置了 `experimental.turbopackFileSystemCacheForBuild: false`，前端编译通过；该本地配置改动已在清理时还原，没有包含在功能提交中。
新环境如遇同类问题，可依据 [Next.js 缓存文档](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache) 临时关闭生产缓存后重试；避免提交机器专用配置。

## 优先接续的验收

1. 在新环境安装依赖并准备 vendor，执行类型/代码检查及上述 54 项相关测试。
2. 单任务完成 Windows 原生构建，记录实际命令和结果。尚无已通过的 Windows 构建结论可沿用。
3. 使用独立测试程序和书库，导入 `apps/readest-app/src/__tests__/fixtures/data/` 下的 `sample-alice.epub` 与 `sample-alice.pdf`，不要覆盖日常安装或书库。
4. 从 Available 启用按钮，核对 Windows 原生剪贴板中的完整文字、标题、章节、CFI、返回链接及 PDF 文档页序号；确认成功后选区清除。
5. 核对 Copy to Notebook 无副作用、键盘操作、深浅色/e-ink；失败重试和异步改选已有行为测试，平台上出现差异时再补充回归。
6. 由使用者自行粘贴到 ChatGPT Desktop，核对内容后发送；实现不自动启动、粘贴或发送。
7. 把 Windows 结果和剩余问题记录到 Issue #2，再决定合并及关闭 Issue。

若测试机已有 Readest，可用 `--config` 加载自行创建的本地 Tauri 覆盖，使用独立 identifier，并把 `plugins.deep-link.desktop.schemes` 设为 `[]`，避免测试程序注册日常协议。
在独立测试可执行文件目录创建 `settings.json`（内容 `{}`）可触发既有 portable 模式，从而隔离书库。
这些测试配置不随源码提交；完成测试后删除。

## 本次清理与交付边界

按用户要求停止原生编译，删除本次构建目录、依赖目录、生成的 vendor/权限/schema/TypeScript 缓存及浏览器测试缓存。
同时删除临时 `.npmrc`、`.env.local` 和 `tauri.issue2.local.json`，还原构建工具改写的跟踪文件。
功能源码、测试、本文与两张验证截图保留在分支中。源码不依赖本机临时路径或临时配置。
系统级已安装的编译工具不属于项目构建产物；已有 Readest 安装与日常书库未参与本次清理。
