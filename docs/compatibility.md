# ST / SPreset 兼容契约

本插件提供 ST 聊天补全预设的受限执行环境；不提供完整 SillyTavern 页面、酒馆助手 API 或任意扩展宿主。导入的源 JSON 原样保存；通过预设编辑器修改后保存编辑版本，未操作的字段和扩展数据保留，表单修改会重新格式化 JSON。代码中不捆绑用户预设。

所有预设只使用 SPreset 路径，包含 ST 基础组装、可选 SPreset 配置和受限助手脚本。没有昆仑专用执行分支，也不按预设名选择实现。面板不提供模式选择，旧 adapter 设置被忽略并在后续保存时清理。不支持的内嵌扩展明确报错，不自动改用忽略扩展的路径。

## 顺序与数据边界

1. 宿主冻结预设、模型、采样配置、插件玩家设定、叙事阻尼器与命运之骰的注入选项和可见材料。已有快照缺少某项注入设置时按关闭处理，不回读当前设置。
2. 从有效楼层源文按本轮消息深度运行发送规则，再按 100001 顺序、触发类型、材料 marker 与深度插入组装消息，展开预设自己的原生宏。
3. 依次执行启用的 ChatSquash、ToolBindings 和 FinalRequestProcessing。随后初始化助手，并按以下顺序处理新请求。
   1. 触发 `GENERATION_STARTED`。存在相应监听器或打包脚本时，再触发 `GENERATION_AFTER_COMMANDS`。
   2. 展开助手宏，触发 `CHAT_COMPLETION_PROMPT_READY`，加入助手声明的工具。
   3. 触发 `GENERATE_AFTER_DATA`。其 `prompt` 和 `messages` 指向同一消息列表，监听器可替换该列表。
   4. 对仍保留的预设 EJS 模板求值，触发 `CHAT_COMPLETION_SETTINGS_READY`，再执行虚拟 fetch 请求拦截。回包重放若读取旧版（v1）助手执行快照，沿用该请求编译时的事件顺序。
4. 校验最终请求的消息、工具、模型路由与预算。预览中 historyProjections 列出命中的楼层角色、深度、规则及前后长度。
5. 单次模型调用；不执行工具动作或自动继续 agent 循环。
6. 验证完整结束、工具名称和完整 JSON → 虚拟 fetch 完整 JSON 回包处理 → 再验证剩余工具 → toolCallFormatter → OutputPreprocessing（final=true）。
7. 对解包结果应用一次写入型正则，向宿主提交源文和显示规则。每次后续组装按当轮楼层深度计算发送历史。

请求预览保留实际编译结果。最终请求脚本可读写本轮沙箱中的聊天元数据和输入楼层 extra。产生的快照随候选正文暂存，核对已选楼层、版本、输入和正文后写入宿主按轮存储。下轮、重生成和回退分别从对应历史读取。插件预设文件、宿主聊天和凭据保持独立。

提示词的 `role: "model"` 兼容为 `assistant`，适用于顺序提示词、深度注入和材料占位项；仅在组装请求时映射，导入、导出和未修改角色的编辑保留原值。启用的条目会在兼容报告中提示此映射，未加入顺序或已禁用的条目不参与发送。其他未知消息角色仍会拒绝导入。

插件设置中的非空「玩家设定」按原文填入 `personaDescription`，使用预设指定的顺序和角色；缺少或未启用该占位项时沿用必要材料补入规则。内容按字面材料处理，不展开宏或执行 EJS，也不移除已包含在宿主人物上下文中的玩家资料。留空或仅有空白时沿用原有宿主材料映射。

### 本轮材料与缓存前缀

- 仅将宿主 `context` 中 `kind=worldbook` 且 `id=tavern:constant-worldbook` 的段识别为固定世界书，经 `worldInfoAfter` 及原有缺失占位项补入规则发送。其他世界书段整体作为本轮材料；宿主已合并的固定与动态内容不按标题或文本猜测拆分。
- `injectNarrativeDamper`（叙事阻尼器）与 `injectFateDice`（命运之骰）各自为 `true` 时，插件在 WorldInfo 加入该机制的常驻说明，把可核实的实际裁定附在本轮玩家输入末尾。实际结果不写入固定世界书。无法确认结果属于目标轮次时，跳过对应裁定并在请求预览中提示。两项均不控制宿主机制或重掷。
- 动态世界书、写作要求和生成前状态先放在完整历史之后、紧接本轮输入之前。通常采用带来源标题的 `user` 材料消息。识别到 Reverie 的命定预设助手后，插件使用 `system` 材料消息，供预设「消息后处理」脚本将这些材料归入上下文。请求处理器可改写这些发送副本；保存的提示词角色和聊天楼层保持原样。
- 深度提示词先按纯历史与本轮输入计算位置，再插入本轮材料。`depth=1` 位于本轮材料之前，`depth=0` 位于本轮输入之后。材料数量不改变历史深度。同一深度按显式 `injection_order` 递增排列，例如 `-1` 先于 `0`；深度本身须为非负整数。
- ChatSquash 仅对插件自动生成的 `turnMaterial` 跳过 `user_prefix/user_suffix`，避免将宿主材料标为玩家发言；其来源仍为 `materials`，`separate_chat_history` 按原有来源边界分组。后移可能增加分组，依赖固定消息索引的自定义脚本需据实际请求检查。最终脚本仍能改变顺序或角色；布局仅保留可复用前缀，不保证服务商命中。

回归覆盖见 [`tests/cache-prefix.test.mjs`](../tests/cache-prefix.test.mjs)；测试使用离线材料和模拟协议，不调用模型。

## 已实现的处理阶段

| 配置 | 输入 | 返回值 / 行为 |
| --- | --- | --- |
| ChatSquash | 逻辑消息 | 支持 enabled、conditional_enabled/tag、separate_chat_history、role、user/char 前后缀、prefix/suffix_system、分隔符；条件标签只从预设文本移除 |
| squashed_post_script | 合并的字符串 | 返回字符串；每个合并组调用一次 |
| ToolBindings | 启用提示词关联的 form 或 code | form 生成参数 schema；code 作为函数体返回工具声明，只取 name/description/parameters |
| FinalRequestProcessing.script | `{ request }` | 返回 OpenAI 风格请求；初始含 messages、model、temperature、max_tokens，存在工具时带 tools |
| OutputPreprocessing.toolCallFormatter.script | `{ calls, defaultText }` | 返回完整正文字符串；calls 中 arguments 保持模型回包形式，调用前已验证完整 JSON |
| OutputPreprocessing.script | `{ buffer, final: true, state: {} }` | 返回 `{ output: string, hold?: '', state?: object }`；state.rejected=true 时拒绝正文；状态不持久化 |

SPreset 函数可以是普通函数或箭头函数，支持能够在预算内完成的纯 JavaScript Promise。没有异步 I/O、定时器或宿主函数桥接；悬空 Promise 会失败。SPreset 函数之间不能通过 globalThis 传递状态，只能通过阶段输出传递数据。助手脚本的临时上下文在同次虚拟请求内共享，独立于这些函数。console 是不输出、不存储日志的空实现。

工具声明关联的提示词必须启用，并满足当前 normal/regenerate 触发条件。SPreset ToolBindings 需要 consumeToolCalls=true 和 toolCallFormatter；助手请求拦截器可以自行声明并解包输出工具。未消费的工具必须交给显式 SPreset 格式化器，否则拒绝正文。SPreset 工具声明中的 action、actionBody、formatMessageBody、stealth 等执行/展示行为不运行，最终显示由输出格式化器和宿主负责。

## 受限酒馆助手接口

接口参考酒馆助手提交 `40e4b72d0e6abbe158fec85080cb93a5de9431ae` 的公开 [事件契约](https://github.com/n0vi028/JS-Slash-Runner/blob/40e4b72d0e6abbe158fec85080cb93a5de9431ae/@types/iframe/event.d.ts)、[宏契约](https://github.com/n0vi028/JS-Slash-Runner/blob/40e4b72d0e6abbe158fec85080cb93a5de9431ae/@types/function/macro_like.d.ts)和[脚本生命周期](https://github.com/n0vi028/JS-Slash-Runner/blob/40e4b72d0e6abbe158fec85080cb93a5de9431ae/src/panel/script/iframe.ts)独立实现，没有移植其浏览器环境或源代码。

| 接口 | 实现范围 |
| --- | --- |
| eventOn/Once/MakeFirst/MakeLast、stop、移除、清空、eventEmit | 逐个等候回调完成。新请求依次触发 GENERATION_STARTED、GENERATION_AFTER_COMMANDS（有监听或打包脚本）、CHAT_COMPLETION_PROMPT_READY、GENERATE_AFTER_DATA、CHAT_COMPLETION_SETTINGS_READY。回包后触发 MESSAGE_RECEIVED。其他未触发的监听会出现在诊断中 |
| registerMacroLike/unregisterMacroLike | 处理预设文本；自定义 `{{...}}` 可延迟到请求钩子，最终残留则失败 |
| getVariables/replaceVariables/insertOrAssignVariables/updateVariablesWith | chat/global/preset/script 本次内存表，初始 chat/global 为预设宏变量；不是宿主存档变量；script 以脚本 ID 隔离 |
| getScriptId、getPreset('in_use')、getChatMessages、SillyTavern.getContext | 当前预设和可见聊天的副本；预设使用助手的 settings/prompts/prompts_unused 结构，只提供已知映射的设置；聊天支持数字/范围、负数索引和 role/hide_state 筛选，include_swipes 明确拒绝（打包脚本可捕获错误）；不提供存档写入接口。`SillyTavern.getContext().ToolManager` 支持 `registerFunctionTool`/`unregisterFunctionTool` 注册输出工具 |
| window/parent/top、ready、pagehide、DOM/UI 桩 | 全部指向私有 QuickJS 全局，ready 初始化、回包结束 pagehide；打包脚本挂载的 DOM/jQuery/CSS/UI 以内存桩运行，外部网络请求与外部 `<script>` 加载明确拦截 |
| fetch、Request/Response/Headers、ReadableStream、UTF-8 编解码 | 仅供本次 `/api/backends/chat-completions/generate` 虚拟 POST；完整 JSON 回包，不提供网络与 SSE；其他 URL、额外请求、凭据及传输选项明确拒绝 |
| localStorage | 每次执行独立的内存表，不访问浏览器存储，不跨生成保存 |

助手接受普通 JavaScript 脚本，也接受仅导出本脚本命名绑定的模块（如 `export function f() {}` 或 `export { f }`）。模块代码在私有的异步严格模式作用域中初始化。静态导入、跨文件转出、默认导出、动态加载及 `import.meta` 超出支持范围。最多 32 个启用脚本；普通助手脚本每个不超过 512 KiB；包含 UI/DOM 挂载与生成期事件/ToolManager 的打包型助手脚本单脚本上限放宽至 4 MiB，其浏览器 UI 与定时器以惰性内存桩运行，仅生效生成期事件、ToolManager 工具与回复后处理。整组助手初始化/请求或回包处理各有 1800 ms 时限。父 Worker 的取消及超时仍有效。

打包型脚本中以字符串字面量出现的同源 `/api/...` 路径（除虚拟生成接口 `/api/backends/chat-completions/generate` 外）会在导入报告中以警告列出，如记忆/世界书编辑、聊天回读等依赖酒馆后端的接口。运行时对这些路径的 `fetch` 抛出可捕获的「本地管理接口未启用」错误，脚本通常会自行降级。该检查只做静态引用扫描，不能证明路径一定被调用（脚本可能只是打包了引用它的库代码），也不会阻止保存或生成；报告最多列出 12 个路径并注明总数。

ToolManager 输出工具使用以下契约：

- 注册时冻结工具定义并校验受支持的 JSON Schema。支持 type（含类型数组）、enum/const、对象 properties/required/additionalProperties、数组 items/uniqueItems、字符串 pattern/长度、数值范围/multipleOf、容器数量及 allOf/anyOf/oneOf/not。title/description/default/examples 等仅作注释；$ref、format 等未实现的关键字在模型调用前明确拒绝，不声称支持完整 JSON Schema。
- shouldRegister 可以是同步或纯异步函数；它和 action 在注册脚本的变量作用域中运行。所有属于 ToolManager 的调用先校验参数，再执行 action；action 只在 QuickJS 内处理本次数据，不能写入宿主。
- action 返回非空字符串时使用该正文，否则从 content 或唯一必填字符串参数提取；任何一个调用无法产生正文都会失败。原有文本与多个工具正文按调用顺序用两个换行拼接。
- 仅消费属于本次请求的 ToolManager 调用，其余调用原样交给 SPreset。SPreset 格式化器通过 calls 接收剩余调用，通过 defaultText 接收已生成的正文。fetch 包装器已经消费的调用不再执行 action；透明转发不会禁用 ToolManager。
- 每个阶段按注册顺序执行生成相关回调。异步初始化需返回 Promise 或注册 ready 回调。面板不按名称、ID 或源码哈希识别：导入时静态追踪初始化函数、ready 回调和可识别的生成回调。只创建界面、绑定点击等交互或只读消息统计并更新界面的脚本标为 `ui-only`，编译和回包都不执行。点击回调里的操作不会在生成时运行，但绑定时构造回调的函数会被分析。
- 混合脚本整段保留；动态 API、共享状态写入或无法追踪的控制流不会被猜成纯面板。报告解释未跳过的原因，执行仍受普通／打包脚本各自的上限约束。静态解析单脚本最多 4 MiB，大型源码另有解析预算。超过 512 KiB 的普通脚本若不能确认为纯面板，会报告阻断；若确认只需界面，可在「编辑预设 → 助手脚本」停用该脚本，不必删除源码。

插件保留模板与冻结材料的来源，使旧历史中的宏、EJS 及替换得到的字面文本保持原样。请求处理器可以按预设规则读取文本、合并历史、编码或调整工具声明。处理后的请求仍须通过消息角色、工具配对、模型路由和预算校验。

SPreset 的 `squashed_post_script` 和 `FinalRequestProcessing` 可读取和改写请求文本。冻结材料中原有的模板表达式保持字面含义；脚本改写使同文来源有歧义时优先保留字面含义。工具参数保持 JSON 转义。

模型请求与回包发生在不同 Worker 中。编译时记录固定时间、伪随机序列、输入和捕获请求；回包阶段重建脚本上下文并比较请求序列化结果，完全相同才给拦截器交付完整回包。该重放没有网络、模型调用或宿主副作用。随机值只用于可重放的标识符，不提供密码学随机性；预览仍直接展示已编译请求，不重放。

Meowssiah 的已知 SPreset 远程引擎加载器按完整源码 SHA-256 映射到内置 SPreset 接口，名称不参与识别，远程 URL 不访问；加载器内容变化时不会直接信任。昆仑原助手脚本直接在上述环境执行，无预设指纹适配器。Meowssiah 原文件可编译出工具历史、强制选择与签名；测试用模拟回包验证格式化，尚未进行真实提供商联调。

### Reverie 1.2 默认剧情

插件按启用的命定预设助手 v3.18.1 加载器源码指纹识别设置格式，从导入文件的 `data.managed_values` 读取字数与字数要求、正文与思维链语言、对白比例与轮次、战斗回合、人称、全局设定／偏好及用户附加设定。男女体型池按保存的权重抽取。加载器指向的远程脚本无需下载。内嵌的「消息后处理」脚本在 QuickJS 中执行，按预设边界整理历史与动态材料，并用 `<Participant_input>` 包住本轮玩家输入。默认预设传递 `Participant:` 停止串。

默认剧情使用非工具尾部，输入噪声关闭时 `{{general_prompt_noise}}` 展开为空。启用 `noise_padding.enabled` 会在准备阶段报错；所选尾部实际包含 `<|命定_工具输出|>` 时，编译会提示改选非工具尾部。当前适配将「本轮场外讨论」置为关闭。远程设置面板、场外讨论调度和独立辅助生成超出支持范围。

原文件的正则作用于写入、显示和后续历史。原文件测试以固定回包验证默认剧情，检查深度 10 的旧正文和深度 11 的摘要，并检查聊天摘要折叠显示。玩家输入中已有的 `{{user}}` 或 `<|命定_记忆区|>` 等字面文本会保留。

默认预设启用 `use_sysprompt`，预览中的角色依次为 `system / user / system`。OpenAI Chat Completions 按此顺序发送。通过 Gemini 兼容接口发送这三段纯文本时，第一段转入 `systemInstruction`，最后一段用两个换行接在原 user 文本之后，组成一条 Gemini user 消息。这与 SillyTavern 原生 Google 转换的角色和拼接顺序一致。此适配要求已识别的命定预设助手、上述开关与消息形状，且没有工具要求。[上游角色映射](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/prompt-converters.js#L432-L466) · [相邻消息合并](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/prompt-converters.js#L599-L622)

## 工具历史、选择与签名

请求接受 system/user/assistant 文本、assistant.tool_calls（正文可省略）和 tool 结果。调用必须使用已声明的工具、唯一 ID、完整 JSON 对象参数；所有结果必须与紧前调用组逐个配对，不能缺失、重复或跨越后续普通消息。这里只回放历史，不调用 action 或启动工具循环。

支持 tool_choice 的 auto、none、required、指定函数，以及 toolConfig.functionCallingConfig 的 AUTO/NONE/ANY 和 allowedFunctionNames。两套配置同时存在时必须一致。ANY 的回包必须包含允许的工具；NONE 的回包不得包含工具。失败时不采用正文。

支持消息 thoughtSignature、调用 signature、调用 extra_content.google.thoughtSignature。别名必须一致，签名只作为不透明字符串传输；不验证其密码学真实性、不生成签名、不保证提供商接受跳过校验标记。其他 extra_content 字段仍拒绝。

请求钩子可写入字符串或字符串数组形式的 `stop`。插件去掉空字符串和重复项，保留有意义的空格与换行。普通请求和无额外协议要求的自动工具历史由 DSH 发送。仅额外需要停止串时，DSH 官方 `deepseek-account` 与 `deepseek-official` 适配器直接接收 `GenerateOptions.stop`。其他服务商需支持下表的兼容发送路径。

强制工具选择、签名等扩展控制也使用兼容发送接口。插件读取公开服务商目录与 settings.describe 配置，使用同次 prepareCall 校验模型与预算，确认配置未变化后单次发送。预算使用最终提供商 JSON，计入历史参数、结果、工具描述及签名。此路径不经过 DSH 的 llm/stream 中间件、重试、缓存和 OAuth 刷新；宿主负责正文生成回调、冻结材料、取消和结算。

| 服务商协议 | 发送形式及限制 |
| --- | --- |
| openai-completions | `/chat/completions`、stream=false。停止串放在顶层 `stop`，历史与签名扩展原样发送。toolConfig 转为等价 tool_choice；ANY 的单工具限制转为指定函数，全部工具转为 required，多个但非全部的子集明确拒绝 |
| google-generative-ai | `/models/{model}:generateContent`。停止串放在 `generationConfig.stopSequences`，工具历史转为 functionCall/functionResponse，签名转为 part.thoughtSignature。支持 ANY 名称列表。中途的 system 消息只接受上文 Reverie 默认剧情的三段纯文本形式 |

从当前已配置服务商读取 api/baseURL；目录可能对不同模型采用不同默认协议，因此除原生 google 外要求明确配置这两项。API Key 经公开 credentials.resolve 取得，或使用服务商已配置的认证头；不从预设接收地址、凭据或请求头。只在发送前解析凭据，不传入 Worker、预览或结果。禁止 HTTP 重定向，不自动重试或改发其他路径；HTTP 错误仅报告状态码，避免把上游诊断中的敏感内容显示出来。认证不支持 OAuth、Codex、Copilot、Vertex 或 Azure 专用流程。

如果生成在发送前报服务商配置错误，应检查 **STcontext 面板选中的正文模型**对应的服务商，不是前台或后台模型。`配置缺少 api` 表示需要在 DSH 服务商设置中显式选择所用的 Chat Completions 或 Gemini 协议；`配置缺少 baseURL` 表示需要填写该协议的基础地址，即使宿主普通请求能够沿用目录默认值。`API 协议…不支持` 表示当前选用的协议不在上述范围内；只有服务商实际提供相应端点时才能改选协议，不能仅改名称。错误不会显示地址、认证头或密钥，也不会发送模型请求。

兼容发送保留温度和输出预算，支持 maxTokensField。OpenAI 推理强度采用模型显式 reasoningEfforts 映射或标准值；Gemini 3 使用 thinkingLevel，其他 Gemini 型号需要明确的 thinkingBudgets。未实现的 compat、缓存或 WebSocket 配置会拒绝；不能把这条接口当作完整的 pi-ai 替代品。请求与回包限制各为 8 MiB，超时采用服务商 timeoutMs/streamIdleTimeoutMs 或 300 秒，取消中断 HTTP 并拒绝结果。

compat 按实际值校验：支持显式 `thinkingFormat: openai`；已知的关闭开关、空路由/模板配置及未赋值字段不会仅因名称存在就被拒绝。模型级配置只覆盖有值的字段，不用默认空项覆盖服务商要求。支持 `requiresToolResultName`、`requiresAssistantAfterToolResult`（工具结果后接用户消息时补入协议要求的助手占位消息）、`requiresReasoningContentOnAssistantMessages`（补空 reasoning_content）、`supportsStore`（发送 store=false）和 `vllmPriority`。历史调用与签名仍保留。未知字段或实际启用的未实现功能仍拒绝，并在错误中列出具体 `compat.字段名`，不显示字段值或凭据。

## 明确拒绝与保留差异

- 当前不支持 ChatSquash 的 parse_clewd、user_role_system、re_split、enable_stop_string，以及启用的 MessageInjections 或非空 ForcedPostProcessing 模式。
- SPreset RegexBinding 仍只保存；只执行原生 extensions.regex_scripts，不合并两套规则。
- 启用的 tavern_helper/scripts 只在受限环境执行；远程脚本加载、LogUpload、真实 DOM、未实现的 ST 事件和持久化变量 API 不可用。未知能力在导入报告中提示，实际越界调用会失败；捕获拒绝异常也不能让本次处理成功。
- 最终请求允许上述工具协议。图像、其他推理块、任意私有字段和 custom_include_body 仍拒绝。模型路线和输出预算保持冻结，未显式覆盖温度时接受请求钩子的有效温度。
- 静态扫描报告脚本引用的协议字段；条件分支以编译后的实际请求校验为准。Meowssiah 中未运行的 custom_include_body 分支不会阻塞整个预设；一旦实际产生此字段仍报错。
- 基础编译保留经过发送规则投影的材料。存在显式请求改写时，校验最终结构与容量，允许历史压缩和工具化。
- 普通变量宏沿用 legacy 类别顺序。含 `{{if …}}…{{else}}…{{/if}}` 或块式 `{{#setvar …}}…{{/setvar}}` 的条目按块顺序执行，仅求值命中的条件分支。支持最多 32 层嵌套和 10000 个宏；lastMessageId 是本次可见快照的局部索引。
- 两个目标均关闭的规则在消息写入时执行，markdownOnly 用于显示，promptOnly 用于发送。深度按消息楼层计算。聊天显示保持生成时的显示投影，历史按本次请求深度重新计算。旧版宿主返回源文。

## 运行包与验证

QuickJS 0.32.0 和 Acorn 8.19.0 通过锁文件固定，打包产物随 lib/vendor 分发；不移植 ST 或酒馆助手源代码。保留完整第三方许可与产物摘要。WASM 内不绑定系统能力，但解释器自身仍需随安全修复更新，不能把资源限制视为绝对安全保证。

仓库测试使用固定模型回包，覆盖工具历史、楼层版本恢复、正则深度、脚本隔离、请求预算与宿主提交。另用 SillyTavern 1.19.0 和本机 OpenAI 兼容回显端点录制了天琴座两轮请求。在相同人物、开场和随机宏选项下，24 条和 26 条上传消息的角色与文本逐条相符。四份样本的 120 个原生正则对照结果一致。浪潮、昆仑和猫神的生成脚本通过插件沙箱与模拟回包验证。

## 预设提示词中的 EJS

启用的提示词条目支持 `<% … %>` 条件、循环与局部 JavaScript，`<%= … %>` 输出 HTML 转义文本，`<%- … %>` 输出原文。也支持 `print`、注释、转义标签、空白裁剪和纯计算的 `await`。兼容样例取自上游 v1.17.9 的好感度条件示例，并用同一版本的 EJS 引擎核对了转义和空白处理。[上游文档](https://github.com/zonde306/ST-Prompt-Template/blob/d6f520d149aba146305b0b781ddd691d449c28d2/README_CN.md)

模板可读 `userName`、`charName`、`assistantName`、会话标识与最后一条玩家或角色消息。通过 `variables` 或 `getvar` 可读冻结变量，支持点路径、数字下标、`defaults` 以及 `getLocalVar`、`getGlobalVar`、`getMessageVar`。全局变量来自本次编译已知的值。每个条目使用独立的 QuickJS 环境，默认执行时限 500 毫秒。模板使用未实现的世界书查询、文件包含、变量写入或不支持的变量作用域时，执行会报错。

ST-Prompt-Template v1.17.9 在 Chat Completions 路径上由 `CHAT_COMPLETION_SETTINGS_READY` 处理模板。SillyTavern 按事件监听器注册顺序逐一等待回调；`makeLast` 只会将监听器移到注册当时的末尾。[上游模板处理](https://github.com/zonde306/ST-Prompt-Template/blob/d6f520d149aba146305b0b781ddd691d449c28d2/src/modules/handler.ts#L174-L210) · [SillyTavern 事件分发](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/lib/eventemitter.js#L43-L103)

STcontext 先按条目顺序展开原生宏。启用条目准备完毕、助手的 `CHAT_COMPLETION_PROMPT_READY` 与 `GENERATE_AFTER_DATA` 回调返回后，插件在 `CHAT_COMPLETION_SETTINGS_READY` 阶段执行仍保留的预设模板。先前条目中的 EJS 能读到后续原生宏设置的值。助手可以移除或调换原消息，已移除的模板不会运行。助手与回包重放使用同一份已求值文本。

普通助手监听器也监听 `SETTINGS_READY`、助手重新创建或修改了含 EJS 的消息、以及同时启用 SPreset 合并或最终改写时，插件会报告来源或执行顺序冲突。跨条目共享 JavaScript 局部状态、运行时新增的模板也超出当前支持范围。EJS 程序只由预设原始代码块构建，玩家输入、角色和楼层文字通过数据传入。诸如 `<%= "{{user}}" %>` 的代码块内宏插值会在导入报告中指出，可在 EJS 中直接读取 `userName`。
