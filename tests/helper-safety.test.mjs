import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePreset, processOutput } from '../lib/preset.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { materials, preset } from './fixtures/materials.mjs';
import { inspectHelpers, isBundledHelperScript, MAX_BUNDLED_HELPER_BYTES } from '../lib/helper.mjs';

const settings = { model: { provider: 'fixture', model: 'story' } };
const doc = source => ({ ...structuredClone(preset), extensions: {
  tavern_helper: { scripts: [{ id: 'review', name: 'review', enabled: true, content: source }] },
} });
const compile = (document, data = materials) => compilePreset(document, compilerMaterials(data), settings);
const output = (document, compiled, response) => processOutput({ document, response,
  helperState: compiled.helperState, toolNames: (compiled.request.tools || []).map(t => t.name) });
const register = `SillyTavern.getContext().ToolManager.registerFunctionTool({name:'reply',description:'reply',
  parameters:{type:'object',properties:{content:{type:'string'}},required:['content']}, action:args=>args.content});`;

test('bundled hook can replace request history while the host retains the original', () => {
  const document = doc(`document.createElement('div');
    eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, event => {
      for (const message of event.chat) message.content = message.content.replace('历史玩家输入', '被替换的历史');
    });`);
  const compiled = compile(document);
  assert.ok(compiled.request.messages.some(message => message.content === '被替换的历史'));
  assert.equal(materials.history[1].text, '历史玩家输入');
});

test('no-op bundled hook must preserve literal identity macros in history', () => {
  const data = structuredClone(materials);
  data.history.push({ role: 'assistant', text: 'literal {{user}} and {{char}}' });
  const compiled = compile(doc(`document.createElement('div'); eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, () => {});`), data);
  assert.ok(JSON.stringify(compiled.request.messages).includes('literal {{user}} and {{char}}'), 'literal historical macros expanded');
});

test('all ToolManager calls must be retained or explicitly rejected', () => {
  const document = doc(register), compiled = compile(document);
  const result = output(document, compiled, {toolCalls:[
    {id:'a',name:'reply',arguments:'{"content":"FIRST"}'},
    {id:'b',name:'reply',arguments:'{"content":"SECOND"}'},
  ]});
  assert.ok(result.text.includes('SECOND'), 'second valid call was silently discarded: ' + result.text);
});

test('ToolManager must preserve SPreset calls for the SPreset formatter', () => {
  const document = doc(register);
  document.extensions.SPreset = {
    ToolBindings: { identity: { enabled: true, editorMode: 'form', form: {
      name: 'native_reply', description: 'native reply', parameters: [{name:'body',type:'string',required:true}],
    } } },
    OutputPreprocessing: { consumeToolCalls: true, toolCallFormatter: { enabled: true,
      script: '({calls,defaultText}) => defaultText + calls.map(c=>JSON.parse(c.arguments).body).join("")' } },
  };
  const compiled = compile(document);
  const result = output(document, compiled, {toolCalls:[
    {id:'a',name:'reply',arguments:'{"content":"FIRST"}'},
    {id:'b',name:'native_reply',arguments:'{"body":"SECOND"}'},
  ]});
  assert.equal(result.text, 'FIRSTSECOND');
});

test('a transparent fetch wrapper must not disable ToolManager output', () => {
  const document = doc(register + `const original=fetch; window.fetch=(url,init)=>original(url,init);`);
  const compiled = compile(document);
  assert.equal(output(document, compiled, {toolCalls:[{name:'reply',arguments:'{"content":"BODY"}'}]}).text, 'BODY');
});

test('tool action must observe the same prompt-hook state as compilation', () => {
  const document = doc(`document.createElement('div'); let passes=0;
    eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, event => {
      passes++; for(const message of event.chat) message.content='pass='+passes+' '+message.content;
    });
    SillyTavern.getContext().ToolManager.registerFunctionTool({name:'reply',description:'reply',
      parameters:{type:'object',properties:{}},action:()=> 'passes='+passes});`);
  const compiled = compile(document);
  assert.ok(compiled.request.messages.some(m => m.content.startsWith('pass=1 ')));
  assert.equal(output(document, compiled, {toolCalls:[{name:'reply',arguments:'{}'}]}).text, 'passes=1');
});

test('ToolManager must reject schema-invalid arguments before action', () => {
  const document = doc(`SillyTavern.getContext().ToolManager.registerFunctionTool({name:'reply',description:'reply',
    parameters:{type:'object',properties:{content:{type:'string',minLength:10},count:{type:'integer',minimum:1}},required:['content','count']},
    action:args=>args.content});`);
  const compiled = compile(document);
  assert.throws(() => output(document, compiled, {toolCalls:[{name:'reply',arguments:'{"content":"tiny","count":"wrong"}'}]}), /参数|字段/);
});

test('bundled hooks must produce a valid request and cannot mutate the host even if caught', () => {
  assert.throws(() => compile(doc(`document.createElement('div');
    eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, event=>{event.chat=[]});`)), /消息|材料|完整/);
  assert.throws(() => compile(doc(`document.createElement('div');
    eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, ()=>{try {setChatMessages([])} catch {}});`)), /受限助手环境/);
});

test('ToolManager validates nested constraints and rejects unsupported schemas before generation', () => {
  const schema = { type:'object', properties: {
    content:{type:'string',minLength:2,maxLength:8,pattern:'^ok'},
    nested:{type:'object',properties:{count:{type:'integer',minimum:1,maximum:3}},required:['count'],additionalProperties:false},
    tags:{type:'array',minItems:1,maxItems:2,uniqueItems:true,items:{enum:['a','b']}},
    choice:{oneOf:[{const:1},{type:'null'}]},
  }, required:['content','nested','tags','choice'], additionalProperties:false };
  const document = doc(`SillyTavern.getContext().ToolManager.registerFunctionTool({name:'reply',description:'reply',parameters:${JSON.stringify(schema)},action:args=>args.content});`);
  const compiled = compile(document), valid = {content:'okay',nested:{count:2},tags:['a'],choice:null};
  const run = args => output(document, compiled, {toolCalls:[{name:'reply',arguments:JSON.stringify(args)}]});
  assert.equal(run(valid).text, 'okay');
  for (const patch of [{content:'o'}, {content:'no'}, {content:'okay-too-long'}, {nested:{count:0}}, {nested:{count:'2'}},
    {nested:{count:2,extra:1}}, {tags:[]}, {tags:['a','a']}, {tags:['z']}, {choice:2}, {extra:true}]) {
    assert.throws(() => run({...valid,...patch}), /参数.*Schema/, JSON.stringify(patch));
  }
  for (const invalid of [{type:'object',$ref:'#/schema'}, {type:'object',properties:{content:{format:'email'}}},
    {type:'object',properties:{content:{type:'unknown'}}}, {type:'object',required:'content'}]) {
    assert.throws(() => compile(doc(`SillyTavern.getContext().ToolManager.registerFunctionTool({name:'reply',parameters:${JSON.stringify(invalid)}});`)), /Schema/);
  }
});

test('ToolManager actions retain script scope and consuming interceptors do not run them twice', () => {
  const document = doc(`replaceVariables({value:'scoped'},{type:'script'});
    SillyTavern.getContext().ToolManager.registerFunctionTool({name:'reply',description:'reply',parameters:{type:'object'},
      shouldRegister:async()=>getVariables({type:'script'}).value==='scoped', action:()=>getScriptId()+':'+getVariables({type:'script'}).value});`);
  document.extensions.tavern_helper.scripts.push({id:'other',enabled:true,content:'void 0;'});
  const compiled = compile(document);
  assert.equal(output(document, compiled, {toolCalls:[{name:'reply',arguments:'{}'}]}).text, 'review:scoped');
  const intercepted = doc(register + `const original=fetch; fetch=async(url,init)=>{
    const response=await original(url,init), data=await response.json();
    data.choices[0].message={content:'intercepted'}; return new Response(JSON.stringify(data));
  };`);
  assert.equal(output(intercepted, compile(intercepted), {toolCalls:[{name:'reply',arguments:'{"content":"BODY"}'}]}).text, 'intercepted');
});

test('ToolManager rejects schema changes and empty per-call results without dropping other output', () => {
  assert.throws(() => compile(doc(register + `eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, r=>{r.tools[0].function.parameters={type:'object'};});`)), /Schema/);
  const document = doc(register), compiled = compile(document);
  assert.throws(() => output(document, compiled, {text:'existing',toolCalls:[
    {name:'reply',arguments:'{"content":"FIRST"}'},{name:'reply',arguments:'{"content":""}'},
  ]}), /有效正文/);
  assert.equal(output(document, compiled, {text:'existing',toolCalls:[
    {name:'reply',arguments:'{"content":"FIRST"}'},{name:'reply',arguments:'{"content":"SECOND"}'},
  ]}).text, 'existing\n\nFIRST\n\nSECOND');
});

test('bundled browser objects do not masquerade as promises or load external scripts', () => {
  compile(doc(`document.createElement('div'); eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, async()=>{
    const panel = await document.createElement('span'); await $('div');
    panel.style.setProperty('--size', '80px');
    document.body.append(panel);
    if (panel.style.getPropertyValue('--size') !== '80px') throw Error('style');
  });`));
  for (const method of ['append', 'appendChild', 'insertBefore']) assert.throws(() => compile(doc(`
    const s=document.createElement('script');s.src='https://example.invalid/a.js';
    eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY,()=>{try {document.body.${method}(s,null)} catch {}});
  `)), /远程脚本/);
});

test('bundled size limits are enforced in UTF-8 bytes', () => {
  const source = `eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY,()=>{});\n//`;
  const boundary = source + 'a'.repeat(MAX_BUNDLED_HELPER_BYTES - Buffer.byteLength(source));
  assert.equal(isBundledHelperScript(boundary), true);
  assert.equal(inspectHelpers(doc(boundary)).diagnostics.some(d=>d.severity==='error'), false);
  assert.equal(inspectHelpers(doc(boundary+'中')).diagnostics.some(d=>d.severity==='error'), true);
});

test('32 bundled scripts initialize returned promises without exhausting the microtask budget', () => {
  const document = doc('');
  document.extensions.tavern_helper.scripts = Array.from({length:32}, (_, i) => ({id:'script-'+i,enabled:true,
    content:`(async()=>{document.createElement('div');await Promise.resolve();
      eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY,event=>event.chat.push({role:'system',content:getScriptId()}));})();`,
  }));
  const compiled = compile(document);
  for (let i = 0; i < 32; i++) assert.ok(compiled.request.messages.some(m=>m.content==='script-'+i));
  assert.equal(output(document, compiled, {text:'done'}).text, 'done');
});
