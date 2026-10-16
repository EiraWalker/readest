# Issue #4：全局解释提示词模板

规格：[Issue #4](https://github.com/EiraWalker/readest/issues/4)。本功能扩展 [Issue #2](https://github.com/EiraWalker/readest/issues/2) 的固定解释提示词，不改变原有工具栏或普通复制行为。

## 使用

1. 打开“设置 → 行为 → 批注工具 → 解释提示词”。
2. 编辑完整模板，保留精确的 `{{selection}}` 标识符；可选用 `{{source}}` 插入来源。
3. 点击“保存”。此设备上的所有书籍和已打开的阅读窗口共用该模板。
4. 在“自定义工具栏”中加入“复制解释提示词”，划选文字后点击该动作，复制填充后的模板。

`{{selection}}` 插入完整选文，保留内部换行和缩进。`{{source}}` 插入可获得的书名、作者、章节、位置和返回链接；无法获得的字段省略，无来源时插入空字符串。模板中的其他文字保持原样，不补加固定指令或来源。两个标识符大小写敏感，重复出现会全部替换；插入内容中的标识符不会再被解释，未知标记作为普通文字保留。

模板草稿需显式保存后生效；离开编辑页会放弃未保存内容。“恢复默认”先将内置中文提示词载入草稿，保存后生效。空白模板或缺少精确 `{{selection}}` 的模板不能保存，错误与编辑框关联。保存失败保留草稿，活动模板仍使用此前成功保存的值。

## 实现边界

- `ReadSettings.explanationPromptTemplate` 是可选的本机全局阅读设置，不属于按书覆盖的视图设置。旧配置没有该字段或读取到无效模板时，使用内置默认提示词。
- 提示词构造模块集中处理默认模板、校验、来源文本和一次字面替换；调用方不自行解释模板。内置默认模板在没有来源时沿用原有段落间隔。
- 设置编辑器沿用现有设置子页、多行文本框、保存、恢复默认和 i18n 约定。只有保存成功才更新活动模板，复用既有全局设置落盘和同机窗口广播。不增加云同步字段、数据库实体、权限或 AI 服务。
- 划选动作在任何异步操作前捕获有效模板和选区。等待期间的新模板用于下一次复制；旧操作不清除后来新建的选区。
- 剪贴板失败保留选区供重试。解释复制仍不经过 Copy to Notebook；按钮仍默认放在 Available，普通 Copy、Copy Link 和 Quick Action 不变。

## 验证记录

2026-10-16 开发记录：

| 检查 | 当前结果 |
| --- | --- |
| 测试先行 | 原实现运行新增复制测试，4 项因固定提示词输出而断言失败，原有 29 项通过 |
| 相关行为测试 | 9 个文件、118 项通过，含设置落盘/重新加载、广播、模板替换、异步改选、失败重试和无笔记副作用 |
| TypeScript / Biome lint | `pnpm lint` 通过；Biome 检查 2796 个文件 |
| 全量单测 | 单 worker 完整运行退出 0；1156 个文件通过、4 个跳过；13,691 项通过、16 项跳过；3612.88 秒 |
| Web 实际交互 | 独立 Chrome 配置通过：保存/校验/放弃草稿、浏览器重开保留、恢复默认后实际复制、两本 EPUB/PDF 共用、仅本书上下文仍为全局、来源插入与省略、离线保存/复制、键盘保存/恢复/复制、Copy to Notebook 开启仍无批注、浅色/深色/E-Ink/390px 窄屏/RTL |
| Web 生产构建 | `pnpm build-web` 通过；独立生产服务中重新验证保存与实际 EPUB 剪贴板输出 |
| Tauri 前端导出 | `pnpm build`、`pnpm upload-sourcemaps` 通过 |
| Windows 独立程序构建 | `node scripts/tauri.mjs build --debug --no-bundle --ci --config <独立配置> -- --locked` 通过；Rust 编译 4 分 20 秒 |
| Windows 实际交互 | Win32 `CF_UNICODETEXT` 读回 EPUB/PDF 自定义模板、来源和重试文本；两个已打开阅读窗口同步；正常退出进程并重启后模板与实际复制保留；默认恢复后跨书生效，代码换行缩进保真；真实设置只读失败保留草稿和旧模板；异步改选/改模板、原生后端拒绝与重试通过；三本测试书落盘 `booknotes` 均为空；中文校验与阻断外网后的保存/复制通过 |
| 仓库格式检查 | `pnpm format:check` 通过，检查 2835 个文件 |

实际命令：

```powershell
pnpm test --run src/__tests__/components/annotator/CopyExplanationPrompt.test.tsx --pool=threads --maxWorkers=1 --no-file-parallelism --reporter=dot
pnpm test --run src/__tests__/components/settings/ExplanationPromptEditor.test.tsx src/__tests__/utils/explanationPrompt.test.ts src/__tests__/components/annotator/CopyExplanationPrompt.test.tsx src/__tests__/utils/settingsSync.test.ts src/__tests__/utils/settings-sync.test.ts src/__tests__/store/settings-store.test.ts src/__tests__/services/settings-save.test.ts src/__tests__/utils/annotationToolbar.test.ts src/__tests__/components/settings/AnnotationToolbarCustomizerEink.test.tsx --pool=threads --maxWorkers=1 --no-file-parallelism --reporter=dot
pnpm lint
pnpm test --run --pool=threads --maxWorkers=1 --no-file-parallelism --reporter=dot
pnpm format:check
pnpm build-web
pnpm build
pnpm upload-sourcemaps
node scripts/tauri.mjs build --debug --no-bundle --ci --config <独立配置> -- --locked
```

使用仓库的 `pnpm test` 入口加载测试环境；裸调 Vitest 缺少环境变量造成的导入失败不能作为行为红灯证据。构建与全量测试分开执行；Windows 原生构建预检使用 8 GiB 提交内存余量，沿用单 Cargo 任务、关闭增量、限制 Node 内存和单前端 worker 的控制措施。临时构建配置不提交，完成后按原字节恢复。

全量测试使用 Vitest 默认断言超时，未提高 worker 启动超时或跳过失败文件。耗时主要来自逐文件 jsdom 环境（2393.44 秒），其次是导入（492.17 秒）和断言（285.10 秒）。这是完整的单 worker 资源控制模式通过，不代表此前默认并发 worker 启动问题已修复。

Web 交互先在独立开发服务 `127.0.0.1:19324` 验证。首次冷编译约 64 秒，首次页面导航超过 CLI 的 60 秒上限；页面随后自然完成加载，再以实际界面继续验证。保留该超时和后续交互记录，没有提高导航超时掩盖它。测试 PDF 的来源定位为“文档页序号：1（非印刷页码）”；测试 EPUB 的来源与所选章节、CFI 对应。Windows 换行由剪贴板转为 CRLF，段落内容保持完整。

## 原生证据与验证边界

- 独立应用标识为 `com.eirawalker.readest.issue4test`，禁用深链注册，使用独立便携设置、测试书库及 WebView 配置。测试进程正常关闭后重新启动，重开编辑器和实际复制都保留此前成功保存的模板。日常安装、默认关联和日常书库未修改。
- Debug 无安装包测试程序 SHA-256：`00D8AAC80635D5DA46750204FF2294493825E8CE90C3695739D64A807877B998`。它是独立验收程序；本次未构建正常标识的 Release 安装包，也未将测试程序部署到日常安装目录。
- 异步验收在原生 `clipboard-manager|write_text` 调用入口用 CDP 断点暂停，在另一窗口保存新模板，并在原文档内改选后恢复执行。Win32 读回旧快照；新选区保留，下一次 Win32 读回新模板与新选文。Tauri IPC 属性不可替换，早先替换函数的延迟探针未生效，不计为通过证据。
- 剪贴板失败通过调试器将一次原生命令改为测试用不存在的命令，使真实后端拒绝；界面显示失败、保留选区，重试正常写入系统剪贴板。外部 Win32 剪贴板锁探针曾超时，未得到可确认的终态失败，未计为通过；不宣称复现了所有系统剪贴板占用情况。false/异常契约另有行为测试覆盖。
- 保存失败通过将独立测试配置及备份设为只读触发；只读属性已恢复。原生断网验证只阻断外部 HTTP(S)，保留本地 Tauri IPC/资源访问；Web 另以浏览器离线模式验证。均未使用账号或配置 AI 服务。
- 浅色、深色、E-Ink CSS、390px 窄屏和 RTL 使用浏览器实际渲染验证；不代表在物理 E-Ink、Android 或 iOS 设备上验收。Windows 使用原生 WebView 截图，并通过窗口 API 确认可见；AgentCapture 的已配置 EXE 缺失，未取得 WGC 截图。
- 本地保留完整测试/构建日志、源码 SHA-256 清单、Web/原生结果 JSON、Win32 读回文本及截图。两次补充侧栏复查因控件隐藏导致自动化定位超时；此前原生“无批注”断言和最终三本书持久化零笔记断言均已通过，不将超时计为通过项。

Issue #4 保持开启，等待工作分支审阅/合并。本次完整单 worker 结果不改写 [Issue #3](https://github.com/EiraWalker/readest/issues/3) 的历史默认并发失败记录，也不关闭 Issue #2。未修改 Rust 源码，因此 Rust 格式、Clippy、Rust 单测不适用；未执行合并到 `origin/main` 后的集成门禁。
