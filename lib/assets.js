/**
 * Live2D 资产校验 —— 插件里唯一会向使用者报错的地方。
 *
 * 设计原则（来自把这类桌宠做出来这一路的实际踩坑）：
 *
 *   1. 只报【美术资源本身】的问题，并且每条都给出可直接照做的修法。
 *      引擎侧的问题（缺运行时、缺 VC 库、路径编码、渲染器不通用……）
 *      全部由插件自己消化，不允许冒到使用者面前。
 *
 *   2. 宁可多花几百毫秒做完整预检，也不要在渲染阶段抛一个看不懂的错误。
 *      所有模型相关文件都在这里一次性读完，后续步骤不再解析资产。
 *
 *   3. 报错是【清单式】的：一次列出全部问题，而不是修一个冒一个。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, basename, dirname, extname } from 'node:path'

/** 一个模型至少要有这些文件才能渲染。缺任何一个都是美术资源问题。 */
const REQUIRED_BY_KIND = {
  moc3: { pattern: /\.moc3$/i, label: '模型数据 (.moc3)' },
  model3: { pattern: /\.model3\.json$/i, label: '模型定义 (.model3.json)' },
}

/** 纹理扩展名（Live2D 只认 png/jpg）。 */
const TEXTURE_EXT = new Set(['.png', '.jpg', '.jpeg'])

/**
 * 递归列出目录下所有文件（相对 base 的 posix 路径）。
 *
 * 【注意 base 与 dir 必须分开】
 * 早先的写法是 walk(dir) 里用 relative(dir, abs)，递归时把子目录当成新的 dir，
 * 于是嵌套文件的相对路径变成「相对它自己所在的子目录」而不是相对模型根目录 ——
 * Hiyori.2048/texture_00.png 被记成 texture_00.png，预检就会误报「贴图不存在」。
 * 探测脚本正是靠一份正常素材发现了这个问题。
 *
 * @param {string} dir  当前遍历到的绝对目录
 * @param {string} base 模型根目录（相对路径的基准，全程不变）
 * @param {number} [depth]
 * @returns {Promise<string[]>}
 */
async function walk(dir, base = dir, depth = 0) {
  if (depth > 6) return []
  /** @type {string[]} */
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(abs, base, depth + 1)))
    else if (e.isFile()) out.push(relative(base, abs).split(/[\\/]/).join('/'))
  }
  return out
}

/**
 * 在目录里找满足条件的文件（递归）。
 * @param {string[]} files
 * @param {RegExp} pattern
 */
const findBy = (files, pattern) => files.filter(f => pattern.test(f))

/**
 * 校验一个 Live2D 模型目录。
 *
 * @param {string} modelDir 用户提供的模型目录（含 .model3.json 的那一层，或它的父目录）
 * @returns {Promise<{
 *   ok: boolean,
 *   modelDir: string|null,
 *   modelJson: string|null,
 *   modelName: string|null,
 *   textures: string[],
 *   expressions: string[],
 *   motions: string[],
 *   counts: {textures:number, expressions:number, motions:number},
 *   problems: Array<{code:string, message:string, fix:string}>,
 *   warnings: Array<{code:string, message:string}>
 * }>}
 */
export async function inspectModelDir(modelDir) {
  /** @type {Array<{code:string,message:string,fix:string}>} */
  const problems = []
  /** @type {Array<{code:string,message:string}>} */
  const warnings = []

  const fail = (code, message, fix) => problems.push({ code, message, fix })

  // ---- 目录本身 ----
  if (!existsSync(modelDir)) {
    fail('dir-missing', `目录不存在：${modelDir}`, '确认路径拼写；把包含 .model3.json 的文件夹整份拖进来。')
    return empty(modelDir, problems, warnings)
  }
  let st
  try { st = await stat(modelDir) } catch { st = null }
  if (!st || !st.isDirectory()) {
    fail('not-a-dir', `不是文件夹：${modelDir}`, '请提供文件夹，而不是单个文件。')
    return empty(modelDir, problems, warnings)
  }

  // ---- 找到 .model3.json（允许用户给的是它的父目录）----
  let files = await walk(modelDir)
  let model3 = findBy(files, REQUIRED_BY_KIND.model3.pattern)

  let root = modelDir
  if (model3.length === 0) {
    // 用户可能给的是「模型文件夹的上一层」，里面套着一层同名目录
    const subdirs = [...new Set(files.map(f => f.split('/')[0]).filter(Boolean))]
    for (const sd of subdirs) {
      const sub = join(modelDir, sd)
      let subSt
      try { subSt = await stat(sub) } catch { continue }
      if (!subSt.isDirectory()) continue
      const subFiles = await walk(sub)
      const hit = findBy(subFiles, REQUIRED_BY_KIND.model3.pattern)
      if (hit.length) { root = sub; files = subFiles; model3 = hit; break }
    }
  }

  if (model3.length === 0) {
    fail('model3-missing', '没有找到 .model3.json。',
      'Live2D 模型的入口文件叫 <名字>.model3.json，必须和 .moc3 放在一起。请确认导出模型时带上了它。')
    return empty(modelDir, problems, warnings)
  }
  if (model3.length > 1) {
    warnings.push({
      code: 'model3-multiple',
      message: `找到 ${model3.length} 个 .model3.json（${model3.join('、')}），将使用最浅层的那个：${model3[0]}`,
    })
  }

  // 取层级最浅的作为入口
  model3.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  const modelJsonRel = model3[0]
  const modelJsonAbs = join(root, modelJsonRel)
  const modelName = basename(modelJsonRel).replace(/\.model3\.json$/i, '')

  // ---- 解析 model3.json ----
  /** @type {any} */
  let doc
  try {
    const text = await readFile(modelJsonAbs, 'utf8')
    doc = JSON.parse(text)
  } catch (error) {
    fail('model3-unreadable', `.model3.json 读不了或不是合法 JSON：${modelJsonRel}`,
      `用文本编辑器打开它确认没有损坏。原始错误：${error.message}`)
    return empty(modelDir, problems, warnings)
  }

  if (!doc || typeof doc !== 'object') {
    fail('model3-shape', `.model3.json 内容不是对象：${modelJsonRel}`, 'Live2D 官方导出的文件顶层一定是一个 JSON 对象。')
    return empty(modelDir, problems, warnings)
  }

  // ---- .moc3 ----
  const mocName = doc.FileReferences?.Moc
  let mocRel = null
  if (typeof mocName === 'string' && mocName) {
    mocRel = join(dirname(modelJsonRel), mocName).split('\\').join('/')
    if (!files.includes(mocRel)) {
      fail('moc3-listed-missing',
        `.model3.json 里写的模型数据不存在：${mocName}`,
        `导出时漏掉了 .moc3，或者 .model3.json 被移动过。把 ${mocName} 放回 ${dirname(modelJsonRel)} 下，或重新导出模型。`)
    }
  } else {
    const found = findBy(files, REQUIRED_BY_KIND.moc3.pattern)
    if (found.length === 0) {
      fail('moc3-missing', '整个目录里没有 .moc3（模型数据）。',
        'Live2D 模型的形体数据是 .moc3。请确认导出时勾选了模型数据，或提供的是完整模型文件夹。')
    } else {
      mocRel = found[0]
      warnings.push({ code: 'moc3-unlisted', message: `.model3.json 没有写 Moc 字段，将直接使用 ${mocRel}。` })
    }
  }

  // ---- 纹理 ----
  /** @type {string[]} */
  let textures = []
  const texList = doc.FileReferences?.Textures
  if (Array.isArray(texList) && texList.length > 0) {
    for (const t of texList) {
      if (typeof t !== 'string' || !t) continue
      const rel = join(dirname(modelJsonRel), t).split('\\').join('/')
      if (!files.includes(rel)) {
        fail('texture-missing',
          `.model3.json 里列的贴图不存在：${t}`,
          `贴图是模型的脸面。确认 ${t} 与 .model3.json 的相对位置没变，或重新导出。`)
        continue
      }
      const ext = extname(rel).toLowerCase()
      if (!TEXTURE_EXT.has(ext)) {
        fail('texture-format',
          `贴图格式不被支持：${t}（${ext || '无扩展名'}）`,
          'Live2D 只支持 PNG 或 JPG 贴图。请转成 PNG 后修改 .model3.json 里的文件名。')
        continue
      }
      textures.push(rel)
    }
  } else {
    // 没写就按目录里现成的找
    const found = files.filter(f => TEXTURE_EXT.has(extname(f).toLowerCase()))
    if (found.length === 0) {
      fail('texture-none', '找不到任何贴图（png/jpg）。',
        '模型必须有贴图才能显示。请确认导出时带上了贴图文件。')
    } else {
      textures = found
      warnings.push({ code: 'texture-unlisted', message: `.model3.json 没有写 Textures，将使用目录里的 ${found.length} 张贴图。` })
    }
  }

  // ---- 贴图尺寸自检（超大贴图会在低端机上爆显存；只提示不拦）----
  // 只看 PNG 头，不解码整张图。
  for (const t of textures.slice(0, 8)) {
    try {
      const buf = await readFile(join(root, t))
      const size = pngSize(buf)
      if (size && (size.w > 8192 || size.h > 8192)) {
        warnings.push({
          code: 'texture-huge',
          message: `贴图 ${t} 是 ${size.w}x${size.h}，超过 8192，部分显卡会加载失败。建议降到 2048 或 4096。`,
        })
      }
    } catch { /* 读不了就算了，前面已经报过 */ }
  }

  // ---- 表情 / 动作（缺了不算错，只是功能少）----
  const expressions = findBy(files, /\.exp3\.json$/i)
  const motions = findBy(files, /\.motion3\.json$/i)

  if (expressions.length === 0) {
    warnings.push({ code: 'no-expressions', message: '没有 .exp3.json（表情），「换造型」按钮会没有可切换项。' })
  }
  if (motions.length === 0) {
    warnings.push({ code: 'no-motions', message: '没有 .motion3.json（动作），「换动作」按钮会没有可播放项。' })
  }

  // ---- 物理（缺了不算错，只是没有摆动）----
  if (!doc.FileReferences?.Physics && !files.some(f => /\.physics3\.json$/i.test(f))) {
    warnings.push({ code: 'no-physics', message: '没有物理文件（.physics3.json），头发/衣摆不会自然摆动。' })
  }

  return {
    ok: problems.length === 0,
    modelDir: root,
    modelJson: modelJsonRel,
    modelName,
    textures,
    expressions,
    motions,
    counts: { textures: textures.length, expressions: expressions.length, motions: motions.length },
    problems,
    warnings,
  }
}

/**
 * 从 PNG 头里取宽高（不解码图像）。
 * @param {Buffer} buf
 * @returns {{w:number,h:number}|null}
 */
function pngSize(buf) {
  if (buf.length < 24) return null
  // 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/** @returns {any} */
function empty(dir, problems, warnings) {
  return {
    ok: false,
    modelDir: null,
    modelJson: null,
    modelName: null,
    textures: [],
    expressions: [],
    motions: [],
    counts: { textures: 0, expressions: 0, motions: 0 },
    problems,
    warnings,
    inputDir: dir,
  }
}

/**
 * 把校验结果渲染成给使用者看的文本。
 * @param {Awaited<ReturnType<typeof inspectModelDir>>} r
 * @param {string} title
 */
export function renderReport(r, title) {
  const lines = []
  lines.push(title)
  lines.push('')
  if (r.ok) {
    lines.push(`模型：${r.modelName}`)
    lines.push(`贴图 ${r.counts.textures} 张，表情 ${r.counts.expressions} 个，动作 ${r.counts.motions} 个`)
  }
  if (r.problems.length) {
    lines.push(`发现 ${r.problems.length} 个必须修的问题：`)
    r.problems.forEach((p, i) => {
      lines.push('')
      lines.push(`${i + 1}. ${p.message}`)
      lines.push(`   怎么修：${p.fix}`)
    })
    lines.push('')
    lines.push('这些问题都出在美术资源上，修好素材再跑一次即可；引擎侧不需要你做任何事。')
  }
  if (r.warnings.length) {
    lines.push('')
    lines.push('提示（不影响生成，只是功能会少一些）：')
    r.warnings.forEach(w => lines.push(`  - ${w.message}`))
  }
  return lines.join('\n')
}
