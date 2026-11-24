# dsh-tavern-STcontext

在 DSH Tavern 中导入 SillyTavern 预设，使用宿主冻结的可见历史生成正文。聊天按预设显示排版、行动选项和状态栏。插件保存美化前的消息源文，每次请求分别计算模型应收到的历史。

## 安装与使用

STcontext v0.9.0 支持 Tavern 插件 API 7 及以上。生成正文还需要宿主提供 `capabilities.bodyGeneration === 1` 和 `bodyGenerator({ prepare, generate })`。更新实际使用的 Tavern Profile 后，请重启酒馆。[上游正文生成接口](https://github.com/flizzywine/dsh-tavern/commit/09620ebe)

使用附带 STcontext 的 Tavern 发行包时，在「设置 → DSH Tavern → 插件」启用 STcontext。首次随包安装默认停用，启用后仍可自行选择正文生成方式。已有同名安装的用户可以沿用原来的预设、模型和本局设置。

在 STcontext 面板导入预设、选择正文模型并保存后，从酒馆侧栏「＋ → 插件 → STcontext」打开独立页，在「正文生成默认设置」中选择：

- **由 STcontext 直接生成**：宿主准备材料后直接调用插件，不额外请求前台模型。
- **前台检索后由 STcontext 生成**：前台模型先查询世界书，再由插件生成正文，会产生额外的前台模型请求。

宿主提供 `capabilities.bodyGenerationDefaults === 1` 和 `bodyGenerationDefaults()` 时，独立页与「设置 → DSH Tavern → 剧情」共用同一份正文默认设置。独立页还可以取消以 STcontext 作为默认生成器。旧版宿主继续在「设置 → DSH Tavern → 剧情」选择 STcontext 和生成方式。

本局设置可以覆盖全局选择。正常发送、最新正文重生成和失败输入重试均使用宿主原有按钮，停止也由宿主控制。插件面板不再提供独立的开始、取消和任务状态轮询，保留预设设置、模型选择和请求预览。

宿主支持共享预设时，可在 STcontext 的「当前预设」下拉框中从「DSH Tavern 预设库」选择已有的 SillyTavern 预设，也可以选择「跟随本局宿主预设」。预设只需导入宿主一次，在宿主预设库修改后，插件会在下一次生成或重生成读取最新内容。生成模型仍在 STcontext 中设置。旧版宿主可以继续在插件中导入 JSON。

支持双通道正文的宿主分别保存源文、聊天显示和模型历史。可在 STcontext 的「正文生成默认设置」中开启「追加宿主正则」，宿主规则随后分别作用于显示和模型层。旧版宿主若支持追加正则，可在剧情设置中开启。缺少双通道能力的旧宿主显示源文，生成预览会提示这一限制。

插件正文一次性显示。插件不可用、生成失败或完整上下文超限时明确报错，不回退到宿主生成。正文提交后的结算仍由宿主完成。宿主在操作开始时通过 `prepare` 冻结预设、模型及采样配置，正常轮次在前台检索之前冻结；生成期间切换或移除预设、修改模型只影响后续操作。已有预设及独立模型设置无需转换，保留插件数据即可。

旧存档缺少可靠材料快照时由宿主明确拒绝生成，建议先用更新后的新会话验证。插件将完整预设压缩后连同冻结的模型配置交给宿主，继续兼容旧版未压缩快照；生成途中编辑、切换或移除预设不会改变当前操作和重试使用的配置。配置快照仍按宿主要求最多 2 MiB，压缩后超过这一限制会在调用模型前提示精简预设。因此，能导入不代表一定能生成；脚本输入输出、模型请求和上下文预算也分别校验。两种回调均受宿主 10 分钟超时及取消信号约束。

当前自动生成接口只支持文本输入；本轮带附件时会明确报错，不会忽略附件继续生成。

在 STcontext 面板选择正文模型及其支持的推理强度，生成和重生成均使用此设置。模型选择与预算使用 DSH 的 `llm.prepareCall`、`listProviders`、`listModels`，可选复用 `tokenMeter`。普通请求由 DSH 发送。若预设只额外要求停止串，DSH 的 `deepseek-official` 和 `deepseek-account` 可直接传递。其他服务商的停止串，以及强制工具选择或签名请求，使用下文的 OpenAI 或 Gemini 兼容发送接口，需要公开的 `listConfigurableProviders`、`settings.describe` 和相应的认证配置。插件负责预算检查、取消和响应校验，宿主负责正文生命周期和结算。

从 0.2.x 升级后，原有的前台/后台跟随设置需要在面板重新选择并保存。没有选择模型时不会发送正文请求；已选模型不可用时直接报错，不自动切换。模型列表可单独刷新；个别服务商读取失败不会影响其他服务商的模型选择。

运行包已包含固定版本的 QuickJS/WASM 与 JavaScript 语法解析器（`lib/vendor/`），使用时不需要 `npm install` 或构建，也不需要安装 SillyTavern。复制或打包时必须包含整个 `lib/`，包括 `.wasm` 文件和许可声明。

本地目录安装：在 PowerShell 中进入本插件目录，执行以下命令，将运行文件复制到 Tavern 用户插件目录。设置过 `DSH_HOME` 时应使用实际启动 Tavern 的同一个值；以下命令以 Desktop 默认目录 `%USERPROFILE%\.dsh` 为例；CLI 默认使用 `%USERPROFILE%\.dsh-tavern`，使用 CLI 时应将根目录改成该路径。

```powershell
$stcontextDshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$stcontextTarget = Join-Path $stcontextDshRoot 'profile-data\tavern\data\plugins\dsh-tavern-STcontext'
New-Item -ItemType Directory -Force -Path $stcontextTarget | Out-Null
Copy-Item -LiteralPath '.\package.json', '.\index.mjs', '.\client.js', '.\NOTICE' -Destination $stcontextTarget -Force
Copy-Item -LiteralPath '.\lib' -Destination $stcontextTarget -Recurse -Force
```

复制后重启 Tavern，在「设置 → DSH Tavern → 插件」检查 `dsh-tavern-STcontext` 已加载；曾停用过此插件时在这里启用。开发更新同样复制上述运行文件并重启。不要将工作目录直接改成已安装宿主的程序目录。

如果 0.2.0 在导入时提示“没有名为 dsh-tavern-stcontext/upload/begin 的插件处理函数”，请升级到 0.2.1 或更新版本并重启 Tavern。0.2.0 的宿主端依赖声明不兼容 DSH 0.2.1 的 Cordis 加载器，会导致面板已显示但宿主端未启动；刷新页面不足以重新加载宿主端。

单独安装时，可在插件管理页输入 `koabop/dsh-tavern-STcontext`，或下载发行附件 `dsh-tavern-STcontext-vX.Y.Z.zip` 后上传。GitHub 安装可在管理页手动检查发行更新，普通 ZIP 安装可重新上传新版 ZIP。宿主附带版本的更新入口由对应宿主发行包提供。[GitHub Releases](https://github.com/koabop/dsh-tavern-STcontext/releases)

在 DeepSeek Harness「设置 → STcontext」可直接导入预设、选择模型并保存，无需先打开游戏。需要调整生成设置或查看本次请求时，在游戏中通过侧栏「＋ → STcontext」或输入框上方的「STcontext」打开面板：

1. 导入预设 JSON，查看兼容报告；预设不会编译进源码。
2. 选择预设和「插件正文模型」，按需设置「推理等级」，点击「保存设置」。所有预设统一使用 SPreset 流程，自动处理 ST 基础配置、SPreset 扩展和受限酒馆助手脚本，不需要选择请求模式。等级按所选模型的详细能力加载；没有可选等级时显示「模型默认」并禁用选择，不发送额外的推理等级参数。切换模型会清除旧模型的等级设置，读取失败时可通过「刷新模型列表」重试。
3. 保存设置并将 STcontext 设为默认正文生成器后，使用宿主的发送、重生成、失败重试和停止按钮。正文提交后继续完成主会话同步和结算，此时停止不会撤销正文。
4. 可查看或下载本次实际请求。新正文提交后结算失败时，通过宿主重试结算；不会撤掉已提交正文。

在「生成设置」的「玩家设定」多行输入框中填写玩家的身份、外貌、性格、背景等，点击「保存设置」后对所有会话生效。内容按原文填入预设的 `Persona Description`（`personaDescription`）占位项，沿用其顺序和消息角色，不展开宏或执行脚本。预设缺少或关闭该占位项时，插件会在提示词前部补入并给出提示。留空或清空后保存不额外添加玩家设定；宿主原有角色与玩家材料仍完整保留。玩家设定随每次生成配置一起冻结，生成途中修改只影响后续操作。

面板按预设、生成设置和使用说明分区，窄屏自动纵向排列。侧栏和弹窗在可用高度内上下滚动，设置页沿用宿主的滚动区域。兼容报告默认收起，阻止生成的问题会自动展开显示。界面不提供温度、top_p、输出 token 上限等参数控件；导入预设中的原有字段继续保留。

预设以 gzip 压缩、Base64 编码后保存在当前宿主的插件数据中，更新插件不会覆盖，已有预设无需重新导入。支持编辑、另存副本、导出、切换和移除。提供 `getPluginDataLimits()` 的宿主允许单个预设最多 **10 MiB**（按 UTF-8 字节计量），导入、草稿校验和编辑保存使用同一限制。全部预设、配置、元数据和报告的最终 JSON 大小按宿主返回的额度校验；上游当前为每插件 **256 MiB**，早期提供此接口的版本为 8 MiB。原始文件大小之和不等于压缩后的存储占用。

面板显示单文件上限、存储已用和剩余空间，可点击“刷新预设与容量”重试容量查询。没有容量查询接口的旧宿主沿用单文件 2 MiB、总存储 250 KiB 的兼容限制，并提示升级；查询失败时不猜测额度，导入和保存等待查询恢复。超过额度或保存失败不会替换原有预设，编辑草稿继续保留。

导入、编辑保存、预设读取和导出均分块传输；列表只返回概要，当前预设的兼容报告按需分块读取。读取期间使用有容量和时效限制的快照，避免逐块重读全库或重复解压；读取失效时可重试。上传分块与读取快照不持久化。

## 让工作台排查预设

启用 STcontext 后，在支持工作台工具的酒馆里，在出问题的游玩页点「更多 → 遇到问题？交给调试 Agent」，例如说：**“检查当前 STcontext 预设为什么不能重生成，先不要改。”** 不针对某一局时，也可以在卡片工作台指定预设的来源和名称。工作台会区分酒馆共享库与插件导入库，指出哪些字段会阻止生成，哪些只是提示；不会因为同名就修改另一份预设。

需要修复时，可以说：“只修刚才定位到的那一项，保留其他规则，再检查一次。”共享预设由酒馆工具修改工作副本；插件私有预设先预览，通过当前会话的审批后才保存。如果没弹出审批，酒馆的默认「完全权限」会自动拒绝这类请求。你可以自行选择允许询问的会话权限后重试，也可以在 STcontext 编辑器手动修改。没获批准或版本已变化，都不会覆盖原记录。修改不切换选中预设，也不改旧楼层；静态复查不调用模型，要确认实际效果，仍需在游玩页发送或重生成一次。不支持工作台工具的宿主仍可使用原有面板和生成器。

## 预设编辑

在「设置 → STcontext」、游戏侧栏或 STcontext 弹窗中选择预设，点击「编辑预设」。界面参考 SillyTavern 的 [Prompt Manager](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/PromptManager.js)，独立实现，不需要运行或安装 SillyTavern。

- **提示词**：搜索名称、标识或正文，启用/停用，拖动或用上下按钮排序；新增、复制条目，编辑名称、角色、正文和聊天内深度，选择是否合并相邻系统消息。当前顺序采用与生成器相同的 100001 选择规则，其他顺序组保持不变。移出当前顺序的条目仍保留，勾选即可重新加入；永久删除可通过完整 JSON 完成。原有触发配置保留，不提供专用选择控件。
- **正则规则**：新增、启停、编辑查找/替换、选择输入/输出位置、排序和删除原生正则。深度、范围等其余选项仍保留，可用完整 JSON 修改；新增规则默认关闭。
- **助手脚本**：递归查看 `extensions.tavern_helper.scripts` 中的文件夹和内嵌助手脚本，显示 UTF-8 体积并启用/停用；停用文件夹会阻止其中脚本执行。启用的脚本在 QuickJS 受限沙箱中执行生成期事件、ToolManager 工具注册与回复后处理。
- **完整 JSON**：编辑 SPreset、助手脚本、其他采样项和扩展配置。表单只更新操作过的字段，未映射字段、其他顺序组及扩展数据保留。表单编辑会重新格式化 JSON；未经编辑的导入文件仍可按原始内容导出。

「校验草稿」检查结构并给出静态兼容报告，不调用模型或执行预设脚本。结构无效时不能保存；存在兼容问题的预设仍可保存供继续修复，但生成仍由原有校验阻止。材料占位项的正文来自宿主材料或插件设置中的「玩家设定」，不可当作普通提示词编辑；历史发送与显示规则在各自的阶段执行。

「保存预设」覆盖当前记录，名称可直接修改；「另存为副本」保留原记录并选用副本。「导出草稿」可保存尚未通过校验的 JSON；预设管理中的「导出预设」始终导出已保存版本。保存只影响下一次生成，已经准备好的操作继续使用冻结配置。

切换、导入、移除预设或关闭编辑器前，未保存修改会提示确认。宿主切走面板时暂存在当前插件客户端内存，返回同一入口可继续；刷新页面、重启或卸载插件不会保留草稿，应先保存或导出。多窗口修改使用版本检查，过期草稿不能覆盖新版本，可另存副本或导出后重新加载。JSON 校验失败、存储超限或版本冲突不会替换原预设。

## 兼容范围

- ST 聊天补全的 100001 顺序、启用项、角色、材料 marker 和深度提示词。上游 `reason=normal` 使用 `normal`，`regenerate/retry` 使用 `regenerate`；非空 `injection_trigger` 必须包含当前类型才生效。
- 支持局部 setvar/getvar、块式 setvar、if/else、基本变量操作、user/char、注释、random/roll、嵌套宏，以及 lastUserMessage/lastCharMessage/lastMessageId。聊天宏只读取本次冻结的可见历史与输入；替换进去的文本不会再次执行宏。全局变量宏也只在本次编译内共享，不读写宿主状态。
- 原生 `extensions.regex_scripts`；SPreset RegexBinding 只保留原数据，不重复执行。
- 只有 SPreset 一条执行路径：ST 基础组装 → 可选的 SPreset 处理函数 → 受限助手事件与请求拦截 → 模型调用 → 助手回包处理与 SPreset 输出格式化。普通 ST 预设的扩展阶段为空操作。具体接口和限制见 [兼容契约](docs/compatibility.md)。
- 昆仑 IDE 1.2r 直接运行导入文件里的助手脚本，支持工具描述承载上下文及 buffer_content 解包；已删除按脚本指纹解析模板的昆仑专用适配器。测试覆盖更改脚本名称和指纹后的同一行为。
- **Reverie 1.2** 默认剧情可使用原文件。插件读取命定预设助手 v3.18.1 已保存的字数、人称和语言等设置，运行文件内的「消息后处理」脚本，并向模型传递 `Participant:` 停止串。使用时保持输入噪声关闭，选择非工具尾部。远程助手面板、场外讨论和独立辅助生成超出当前支持范围。[设置与限制](docs/compatibility.md#reverie-12-默认剧情)
- 面板不再提供模式选择；旧 adapter 设置自动忽略并在下次保存时移除。不支持的内嵌扩展会报错，不回退到忽略扩展的路径。
- 支持助手事件、registerMacroLike、本次临时变量、ready/pagehide 生命周期及虚拟 fetch。fetch 只在 QuickJS 内处理一次生成请求/完整回包，没有网络能力，不修改宿主全局 fetch。已知 SPreset 引擎加载器按完整内容指纹映射到内置接口；其他远程加载、DOM 操作、日志上传和工具 action 不执行。

导入报告会定位启用条目中的未知宏、脚本语法错误、未实现的扩展选项与可静态识别的协议要求。导入不执行预设脚本，不调用模型；不兼容文件仍可保存和导出原文件。静态检查不能证明任意程序的所有分支，运行时还会校验最终请求与材料完整性。

支持预置 assistant.tool_calls / tool 历史、auto/none/required/指定函数选择、Gemini toolConfig，以及 thoughtSignature、signature、extra_content.google.thoughtSignature。工具历史验证调用 ID、名称与结果配对，签名别名冲突和选择冲突均报错；历史调用不会执行。Meowssiah 1.9.12 原文件已通过编译和两种协议的模拟生成、输出格式化测试。

兼容发送支持明确配置 `api` 与 `baseURL` 的 `openai-completions`（Chat Completions）和 `google-generative-ai`（Gemini）；原生 google 可沿用目录中的默认 API 地址。只使用 API Key 或配置中的认证头，不读取凭据文件，不复用 OAuth。OpenAI 风格消息的签名扩展原样保留，Gemini 转为原生 functionCall/functionResponse/thoughtSignature；服务商仍需接受相应字段及签名值。其他协议、无法表达的选择子集、未实现的 compat 设置会拒绝发送。此接口只发一次完整 JSON 请求，不走 DSH 的流式中间件、重试或 OAuth 刷新；不修改宿主或全局网络函数。详细限制见[兼容契约](docs/compatibility.md)。

标准 OpenAI 的 `thinkingFormat: openai`、已知关闭的 compat 开关和空配置项不会阻止发送；仍不支持的有效选项会在报错中列出具体字段名。无需为了使用预设而删除服务商的默认兼容配置。

宿主导出有效分支的可见历史。插件按预设的角色、正则顺序和本次消息深度准备发送文本。旧楼层可以只发送摘要，或从请求中省略。人物、世界书与聊天使用宿主已解析的材料，旧楼层里的字面宏或 EJS 不会再次执行。

为保留长对话的公共请求前缀，插件先把动态世界书、写作要求与本轮状态放在完整历史之后、本轮输入之前。通常使用带来源标题的 `user` 材料消息。Reverie 1.2 使用 `system` 材料消息，供「消息后处理」脚本将它们移入预设的上下文槽位。宿主明确标记的固定世界书仍按 `worldInfoAfter` 占位项及缺失补入规则排列；固定与动态内容已混合的世界书整段后移，不猜测拆分。材料保持完整，不作为新增楼层写入历史，也不修改导入预设及其提示词角色。预设脚本仍可改写最终顺序和角色，服务商缓存命中不作保证；具体规则见[兼容契约](docs/compatibility.md)。

写入规则在解码模型回包后执行一次。显示规则交给宿主展示当前消息，发送规则在组装后续请求时从楼层源文重新计算。两个目标都勾选的规则在两个通道各自生效。旧存档如果仅存有美化 HTML 或已丢失摘要，插件沿用仍可获得的历史。

启用的 SPreset 和助手请求钩子可以在本轮请求副本中整理正文、编码材料、合并历史或写入工具说明。请求预览显示实际编译结果；格式化器可从完整工具回包中恢复正文。插件不将显示模板写入模型历史。

每个处理阶段使用新的受限运行时，只通过 JSON 传入数据。默认 SPreset 函数 500 ms，整组助手脚本每阶段 1800 ms、最多 32 个；64 MiB JS 堆、1024 KiB 栈，输入/输出及最终请求各最多 8 MiB。普通助手脚本单脚本最多 512 KiB；包含 UI/DOM 挂载与生成期钩子/ToolManager 的打包型助手脚本单脚本最多 4 MiB，其浏览器 UI 与定时器以惰性内存桩运行，仅生效生成期事件、ToolManager 工具与回复后处理。助手回包阶段用冻结输入、固定时间和随机序列重建请求上下文，逐字验证与编译时捕获的请求相同，再交付完整回包；重放不产生模型调用。外围 Worker 保留编译 20 秒、输出 5 秒超时与取消。网络、文件、进程、模块加载、定时器、宿主 API 和凭据不暴露给脚本。预算在最终改写后按实际消息和工具重新计算。

插件在隔离的 QuickJS 环境执行预设生成相关逻辑。脚本菜单、控制台和外部服务不随插件加载。消息里的 HTML 面板由宿主隔离渲染，其外观和交互取决于宿主支持的前端接口。

采样支持 temperature、输出 token 上限、独立模型选择及模型提供的推理强度。尚未映射的采样参数列在兼容报告中。超限、未支持的脚本/宏/模型协议均报错，不自动截断、降级或切换模型。预设中的上下文容量不是模型能力保证。

请求预览只在内存中保留最近三局，重启后清除；不持久化完整故事。导出请求会包含完整可见材料，请按自己的需要保存。

## 发布打包

给 `package.json` 中的版本打对应的 `v` 标签后，运行 `npm run package:release -- vX.Y.Z <输出目录>`。命令从对应 Git 提交生成可直接上传到 Tavern 的 ZIP，并输出版本、提交、文件字节数和 SHA-256。可用 `HEAD` 打包当前提交进行验证。发布时把生成的 ZIP 附到同名 GitHub Release。

ZIP 包含 `package.json`、`index.mjs`、`client.js`、完整 `lib/` 和根目录的分发声明。DSH Tavern 获准随其官方发行包原样分发 STcontext v0.8.2，第三方许可收录于 `lib/vendor/LICENSES.txt`。[随包分发授权](NOTICE)

宿主集成时保留包名 `dsh-tavern-STcontext`，以便升级后沿用同一份插件数据和生成器选择。更新来源由宿主安装记录维护，随包分发时请在宿主清单中登记上游仓库 `koabop/dsh-tavern-STcontext`、固定发行标签及 ZIP 的 SHA-256。

## 验证

真实样本可通过环境变量指定。`STCONTEXT_LYRA_FIXTURE` 覆盖天琴座的行动面板与深度 9/10 历史切换；`STCONTEXT_WAVE_FIXTURE` 覆盖浪潮的工具及文本输出；`STCONTEXT_MEOWSSIAH_FIXTURE` 覆盖猫神 2.1 的连续两轮工具历史。样本保存在本机，测试使用固定回包。

将 `STCONTEXT_REVERIE_FIXTURE` 指向 Reverie 1.2 原文件后，运行 `node --test tests/plugin.test.mjs tests/protocol.test.mjs` 可验证导入、默认剧情生成和重生成。测试检查当前玩家输入、动态材料、停止串、聊天显示，以及深度 10 发送旧正文、深度 11 切换为摘要。协议测试还检查 OpenAI 保留三段原消息，以及 Gemini 按 SillyTavern 的顺序合并尾部文本。模型使用固定回包。

运行 `npm test`。可选设置 `STCONTEXT_PRESET_FIXTURE` 为本地预设路径后运行测试，会验证该文件的请求编译与一次输出正则；测试不会发送模型请求，也不会把该文件复制进仓库。

`tests/cache-prefix.test.mjs` 覆盖连续轮次的公共请求前缀、固定与动态材料布局、深度插入及 SPreset/协议兼容；这些离线检查不代表真实服务商缓存命中率。

`STCONTEXT_PRESET_FIXTURE` 面向昆仑原文件，验证统一流程的请求编译、原脚本解包及材料保护。`STCONTEXT_COMPAT_FIXTURE` 面向 Meowssiah 原文件，验证内置引擎映射、工具历史/选择/签名、两种协议的实际 JSON 和模拟回包格式化。运行 `node --test tests/helper.test.mjs tests/preset.test.mjs tests/spreset.test.mjs tests/protocol.test.mjs` 可覆盖两者。协议测试包含本机临时 HTTP 服务，不调用付费模型；网络沙箱需要允许回环连接。其余流水线、脚本隔离、取消与预算测试使用内存材料和模拟模型，不搭建真实 ST 对照环境，也不表示真实提供商联调已通过。

维护内置依赖时执行 `npm ci --ignore-scripts`、`npm run build:runtime`，然后运行测试。`package-lock.json` 固定依赖；`lib/vendor/manifest.json` 记录产物摘要，许可收录于 `lib/vendor/LICENSES.txt`。升级解释器后应重新检查权限边界和资源限制测试。

设置 `STCONTEXT_HOST_REPO` 后，`tests/client-browser.test.mjs` 使用宿主的 Playwright 与 React 开发依赖检查侧栏、弹窗和设置页在窄屏、低高度窗口中的滚动和保存。可通过 `STCONTEXT_BROWSER_EXECUTABLE` 指定本机 Chromium 或 Edge 路径。

跨仓库联调额外设置 `STCONTEXT_HOST_REPO` 为新版上游 Tavern 工作区路径，并用该宿主的 `bin/test-tavern.mjs` 运行本插件的 `tests/host-smoke.test.mjs`。测试覆盖实际宿主材料导出、统一生成器、正文替换及失败输入补全、原生会话同步和起点结算，模型回包使用测试桩，存档只在内存中。默认使用最小测试预设；可额外设置 `STCONTEXT_PRESET_FIXTURE` 验证已有的昆仑适配预设。插件的 `generation.test.mjs` 在设置 `DSH_BOOT_MODULE` 时还会验证真实 DSH LLM 服务。需要可用的 DSH Session 测试运行时；可显式指定 `DSH_BOOT_MODULE`。

设置 `STCONTEXT_HOST_REPO` 后，`tests/host-generation.test.mjs` 还会验证新正文从宿主准备、STcontext 编译、工具返回到保存和一次结算的完整链路；此测试使用最小测试预设，不需要用户预设文件，并覆盖直接生成、前台检索后生成、冻结配置及回执复用。同一测试文件还会让仓库内的合成打包脚本经过分片上传、配置冻结、编译、ToolManager 回包格式化和一次结算，覆盖直接生成与前台工具调用两种模式，不需要私有预设文件。测试共用 `tests/fixtures/host-harness.mjs` 的宿主装配，模型为模拟回包。

同时设置 `DSH_BOOT_MODULE` 和 `STCONTEXT_HOST_REPO` 后，`tests/host-loading.test.mjs` 会通过真实 Cordis 和 Tavern 保护入口验证插件加载、预设导入、卸载与重新加载，并覆盖有、无可选 `tokenMeter` 服务的环境。

尚未宣称兼容全部 SillyTavern 扩展或所有版本的宏引擎。预设组织改变是否降低模型拒绝率，需要结合所选模型实际验证。
