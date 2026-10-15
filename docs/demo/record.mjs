// Real UI capture. Requires a built app, Playwright + its FFmpeg runtime, and Chrome.
// Run from the repository root; output and the isolated database stay under .data/.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(process.env.DEMO_OUTPUT || path.join(root, '.data/showcase'))
await fs.mkdir(out, { recursive: true })
const data = await fs.mkdtemp(path.join(out, 'demo-db-'))
const appPort = Number(process.env.DEMO_PORT || 4393)
const base = `http://127.0.0.1:${appPort}`
try { await fetch(`${base}/api/projects`); throw new Error('Demo port already in use; choose another DEMO_PORT') }
catch (error) { if (error.message.includes('already in use')) throw error }
const server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
  cwd: root, env: { ...process.env, NOVELWEAVER_DATA_DIR: data, PORT: String(appPort), HOST: '127.0.0.1',
    DOTENV_CONFIG_PATH: '/dev/null', AI_API_KEY: '', AI_EMBEDDING_MODEL: '', AI_BASE_URL: '', AI_MODEL: '', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', chunk => process.stdout.write(chunk))
server.stderr.on('data', chunk => process.stderr.write(chunk))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser, context, stageServer
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${base}/api/projects`)).ok) { ready = true; break } } catch {}
    await sleep(250)
  }
  if (!ready) throw new Error('Demo server did not start')
  const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#102523;color:#f4f5ed;font-family:"PingFang SC","Microsoft YaHei",sans-serif;width:1920px;height:1080px;overflow:hidden}
  header{height:90px;padding:0 64px;display:flex;align-items:center;justify-content:space-between}header strong{font-size:28px;letter-spacing:-1px}header .right{display:flex;gap:26px;align-items:center;font-size:19px;color:#bbccc5}.mode{border:1px solid #577a6b;padding:9px 17px;border-radius:30px;color:#dce8ba}
  #screen{position:absolute;left:64px;top:92px;width:1792px;height:870px;overflow:hidden;border-radius:12px;border:1px solid #55736b;box-shadow:0 22px 50px #0005;background:#faf9f6}
  iframe{border:0;width:1600px;height:777px;transform:scale(1.12);transform-origin:top left}
  footer{position:absolute;top:980px;left:64px;right:64px;display:flex;align-items:center;gap:30px}#number{font-size:40px;font-weight:600;color:#b8d49d;line-height:1.1}#label{font-size:13px;letter-spacing:2px;color:#98b5a6;margin-top:6px}#caption{font-size:27px;line-height:1.45;margin:0}#sub{font-size:17px;color:#b8ccc2;margin:4px 0 0}#track{position:absolute;bottom:0;width:100%;height:4px;background:#29423c}#progress{height:100%;background:#c4daa2;width:0;transition:width .7s}
  #title{position:absolute;inset:0;z-index:5;background:radial-gradient(ellipse at 80% 25%,#2c5549 0%,#102523 60%);display:flex;flex-direction:column;justify-content:center;padding:100px 135px;transition:opacity .7s;pointer-events:none}
  .eyebrow{font-size:21px;letter-spacing:5px;color:#bed6a2;margin-bottom:35px}#title h1{font-family:Georgia,serif;font-size:130px;font-weight:500;letter-spacing:-5px;margin:0 0 35px}#title h2{font-weight:400;font-size:48px;margin:0 0 22px}#title p{font-size:25px;color:#b9ccc2;line-height:1.8}.pills{display:flex;gap:15px;margin-top:35px}.pills span{border:1px solid #577769;border-radius:50px;padding:14px 25px;font-size:23px}.title-bottom{position:absolute;bottom:80px;left:135px;right:135px;display:flex;justify-content:space-between;color:#afc4b8;font-size:20px}
  #cursor{position:absolute;z-index:9;pointer-events:none;width:23px;height:29px;filter:drop-shadow(1px 2px 2px #0009);left:1800px;top:950px}#ring{position:absolute;z-index:8;pointer-events:none;width:54px;height:54px;border:3px solid #e3b75b;border-radius:50%;opacity:0;transform:translate(-50%,-50%)}
  </style><header><strong>NovelWeaver <span style="font-weight:400;font-size:18px;color:#b7cbc0;margin-left:20px">小说创作 Agent 工作台</span></strong><div class="right"><span id="chapter">使用演示</span><span class="mode">本地规则模式 · 示例项目</span></div></header>
  <div id="screen"><iframe id="app" src="${base}"></iframe></div><footer><div><div id="number">01</div><div id="label">WORKFLOW</div></div><div><p id="caption"></p><p id="sub"></p></div></footer><div id="track"><div id="progress"></div></div>
  <div id="title"><div class="eyebrow">LOCAL-FIRST · NOVEL WRITING WORKBENCH</div><h1>NovelWeaver</h1><h2>让长篇创作有记忆、有依据。</h2><p>设定、剧情、证据与写作，在一个工作台中连接。<br>以原创示例《雾港纪事》演示真实操作流程。</p><div class="pills"><span>结构化设定</span><span>原文证据检索</span><span>作者掌握决定权</span></div><div class="title-bottom"><span>本地规则模式 · 中文字幕 · 真实界面录制</span><span>github.com/exuusiai/NovelWeaver</span></div></div>
  <svg id="cursor" viewBox="0 0 23 29"><path d="M2 2 L3 24 L9 18 L14 28 L19 25 L14 16 L22 15 Z" fill="#f7fbf8" stroke="#173c32" stroke-width="1.8"/></svg><div id="ring"></div></html>`
  stageServer = http.createServer((_req, res) => { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(html) })
  await new Promise(resolve => stageServer.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'})
  context = await browser.newContext({viewport:{width:1920,height:1080}, deviceScaleFactor:1, locale:'zh-CN', timezoneId:'Asia/Shanghai',
    recordVideo:{dir:path.join(out,'raw'),size:{width:1920,height:1080}}, acceptDownloads:true})
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  await page.goto(`http://127.0.0.1:${stageServer.address().port}`)
  const app = page.frameLocator('#app')
  await app.getByRole('heading',{name:'雾港纪事',exact:true}).waitFor()
  const start = Date.now()
  const chapters = []
  const subtitles = []
  async function caption(number, title, text, sub = '') {
    const at = (Date.now()-start)/1000
    subtitles.push({start:at,text:[text,sub].filter(Boolean).join('\n')})
    if (chapters.at(-1)?.title !== title) chapters.push({start:at,title})
    await page.evaluate(({number,title,text,sub}) => {
      document.querySelector('#number').textContent=String(number).padStart(2,'0')
      document.querySelector('#chapter').textContent=title
      document.querySelector('#caption').textContent=text
      document.querySelector('#sub').textContent=sub
      document.querySelector('#progress').style.width=`${number/8*100}%`
    }, {number,title,text,sub})
    console.log(`${at.toFixed(1)}s ${title}: ${text}`)
  }
  async function aim(locator, click = false) {
    await locator.scrollIntoViewIfNeeded()
    const b = await locator.boundingBox()
    if (!b) throw new Error('Missing recording target')
    const x=b.x+b.width/2,y=b.y+b.height/2
    await page.evaluate(({x,y}) => { const el=document.querySelector('#cursor'); el.style.transition='left .5s ease, top .5s ease';el.style.left=`${x}px`;el.style.top=`${y}px` },{x,y})
    await page.mouse.move(x,y,{steps:20}); await sleep(550)
    if (click) {
      await page.evaluate(({x,y}) => { const el=document.querySelector('#ring');el.style.left=`${x}px`;el.style.top=`${y}px`;el.animate([{opacity:0.85,scale:0.6},{opacity:0,scale:1.4}],{duration:550}) },{x,y})
      await locator.click(); await sleep(350)
    }
  }
  const click = locator => aim(locator,true)
  async function nav(name, heading) { await click(app.getByRole('link',{name,exact:true})); await app.getByRole('heading',{name:heading,exact:true}).first().waitFor(); await sleep(450) }
  async function shot(name) { await page.screenshot({path:path.join(out,`${name}.png`)}) }
  await shot('title'); await sleep(4.5e3)
  await page.evaluate(()=>{document.querySelector('#title').style.opacity='0'})
  await caption(1,'项目总览','从一个故事项目开始，章节、设定与剧情集中管理。','内置《雾港纪事》：4 个章节 · 10 条设定 · 3 条剧情线')
  await sleep(4e3); await shot('01-dashboard')
  await nav('设定','设定百科')
  await caption(2,'世界设定','把人物、地点与规则，整理成可维护的结构化档案。','示例设定已预先建立；正史状态由作者管理')
  await click(app.locator('.entity-list button').filter({hasText:'失忆的年轻制图师'}))
  await sleep(1800)
  await click(app.locator('.group-toggle').filter({hasText:'心理驱动'}))
  await sleep(2600); await shot('02-bible')
  await click(app.locator('.entity-list button').filter({hasText:'巡潮人，熟悉移动街区'})); await sleep(2200)
  await nav('关系图','关系图谱')
  await caption(3,'关系图谱','从关系网络，看清人物之间的联系与冲突。','点选节点查看人物档案；关系与原文证据相连接')
  await app.locator('.react-flow__node').first().waitFor(); await sleep(1800)
  await click(app.locator('.react-flow__node').filter({hasText:'林雾'})); await sleep(3300); await shot('03-graph')
  await nav('剧情','剧情工程')
  await caption(4,'剧情工程','主线、人物弧与伏笔，放在同一套故事结构中。','按时间轴追踪事件，也能切换为多轨线视图')
  await sleep(2500)
  await aim(app.getByRole('button',{name:'多轨线',exact:true})); await sleep(700)
  await click(app.getByRole('button',{name:'多轨线',exact:true})); await sleep(2600); await shot('04-plot')
  await nav('记忆','叙事记忆')
  await caption(5,'证据检索','第七码头与林澈失踪，有什么关系？','从章节与设定召回证据，查看原文和命中理由')
  await click(app.getByRole('button',{name:'检索',exact:true})); await app.locator('.memory-results button').first().waitFor(); await sleep(1800)
  await click(app.locator('.memory-results button').filter({hasText:'林雾发现第七码头线索'})); await sleep(3400); await shot('05-memory')
  await click(app.getByRole('button',{name:'打开原文章节',exact:true})); await app.locator('.manuscript-editor').waitFor()
  await caption(6,'写作工作台','从证据直达原文章节，正文与创作 Agent 同屏协作。','输入创作要求 → 预览上下文 → 检查连续性提示')
  await click(app.getByRole('button',{name:'正文草稿',exact:true}))
  await click(app.locator('.agent-compose textarea'))
  await app.locator('.agent-compose textarea').fill('')
  await app.locator('.agent-compose textarea').pressSequentially('续写林雾与季岚的对话，保持当前视角，不揭露姐姐失踪的真相。',{delay:55})
  await click(app.getByRole('button',{name:'预览生成依据',exact:true})); await app.locator('.context-preview').waitFor(); await sleep(3000); await shot('06-context')
  await caption(6,'写作工作台','先看本次生成依据，再确认生成候选。','本地规则模式：以下为固定短文本演示；完整创作需接入模型 API')
  await click(app.getByRole('button',{name:'确认并生成',exact:true}))
  const adopt = app.getByRole('button',{name:'追加「版本 A」到正文',exact:true})
  await adopt.waitFor(); await aim(adopt); await sleep(4e3); await shot('06-generation')
  await caption(6,'写作工作台','由作者采纳，保存后也能撤销这次插入。','示例库中实际执行追加与撤销，保留原始正文')
  await click(adopt); await app.getByText('已追加到正文并保存',{exact:false}).waitFor(); await sleep(2200)
  await click(app.getByRole('button',{name:'撤销采纳',exact:true})); await sleep(1700)
  await click(app.getByRole('button',{name:'保存',exact:true})); await sleep(500)
  await nav('审查','连续性审查')
  await caption(7,'连续性审查','运行规则审查，把未回收伏笔与结构提示集中检查。','每条提醒保留依据，最终由作者判断如何处理')
  await click(app.getByRole('button',{name:'重新运行审查',exact:true})); await app.locator('.issue').first().waitFor(); await sleep(4300); await shot('07-review')
  await nav('总览','项目总览')
  await caption(8,'稿件导出','完成的稿件可以导出，作品数据始终由你掌握。','TXT / Markdown / DOCX / EPUB · 全量 JSON 备份')
  await aim(app.getByRole('button',{name:'Markdown',exact:true})); await sleep(2200); await shot('08-export')
  const downloadPromise=page.waitForEvent('download')
  await click(app.getByRole('button',{name:'Markdown',exact:true}))
  const download = await downloadPromise
  await download.saveAs(path.join(out,'exported-manuscript.md'))
  const exported = await fs.readFile(path.join(out,'exported-manuscript.md'),'utf8')
  if (!exported.includes('林雾') || !exported.includes('序章')) throw new Error('Export verification failed')
  await caption(8,'稿件导出','Markdown 稿件已导出。','从设定到成稿，作者始终保留最终决定权。')
  await sleep(2300)
  await page.evaluate(()=>{document.querySelector('#title h2').textContent='让故事连贯，让创作由你决定。';document.querySelector('#title p').innerHTML='本地优先 · 可追溯 · 作者确认<br>在 GitHub 获取源码，开始你的故事。';document.querySelector('#title').style.opacity='1';document.querySelector('#cursor').style.opacity='0'})
  chapters.push({start:(Date.now()-start)/1000,title:'开始创作'})
  await sleep(4500); await shot('outro')
  const duration=(Date.now()-start)/1000
  const video=page.video()
  await context.close(); context=null
  const rawPath=path.join(out,'recording.webm')
  await video.saveAs(rawPath)
  const stamp = seconds => { const ms=Math.round(seconds*1000); return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}` }
  await fs.writeFile(path.join(out,'captions.zh-CN.srt'),subtitles.map((s,i)=>`${i+1}\n${stamp(s.start)} --> ${stamp(subtitles[i+1]?.start ?? duration)}\n${s.text}\n`).join('\n'))
  await fs.writeFile(path.join(out,'recording.json'),JSON.stringify({duration,chapters,errors,rawPath,exportVerified:true,data},null,2))
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
  console.log(`Recording complete: ${rawPath} (${duration.toFixed(1)}s); export verified`)
} finally {
  await context?.close(); await browser?.close()
  stageServer?.close(); server.kill('SIGTERM')
}
