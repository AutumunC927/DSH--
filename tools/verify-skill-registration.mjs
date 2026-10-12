/**
 * 验证 entry.js 会不会把包里的 SKILL.md 正确注册成 DSH 技能。
 *
 * 不依赖真实 DSH：造一个最小 mock root/ctx，看注入与注册的参数对不对。
 *
 * 用法: node tools/verify-skill-registration.mjs
 */
import { apply } from '../entry.js'

let failed = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failed++
}

const injected = []
const registered = []

const ctx = {
  tools: { register: () => () => {} },
  skills: {
    register(skill) {
      registered.push(skill)
      return () => {}
    },
  },
  effect: () => () => {},
}

const root = {
  inject(services, fn) {
    injected.push(services.join(','))
    fn(ctx)
  },
}

console.log('=== 装载 entry.js ===')
apply(root, {})

console.log()
console.log('=== 注入声明 ===')
console.log('  ', injected.join('  |  '))
ok(injected.includes('tools'), '仍然注入 tools（注册说明书不能影响工具）')
ok(injected.includes('skills'), '注入了 skills')

console.log()
console.log('=== 注册到 skills 的内容 ===')
ok(registered.length === 1, `注册了 1 个技能（实际 ${registered.length}）`)

if (registered.length === 1) {
  const s = registered[0]
  const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

  ok(NAME.test(s.name), `name 合法: ${s.name}`)
  ok(typeof s.description === 'string' && s.description.length > 0,
    `description 非空（${(s.description || '').length} 字）`)
  ok(typeof s.content === 'string' && s.content.length > 200,
    `content 是说明书正文（${(s.content || '').length} 字）`)
  ok(!s.content.startsWith('---'), 'content 已剥掉 frontmatter')
  ok(s.invocation?.modelInvocable === true, 'modelInvocable = true（DSH 能读到）')
  ok(s.invocation?.userInvocable === true, 'userInvocable = true（用户也能看到）')

  console.log()
  console.log('  --- description 预览 ---')
  console.log('  ' + (s.description || '').slice(0, 100) + '…')
  console.log('  --- content 开头 ---')
  console.log('  ' + s.content.split('\n').slice(0, 3).join('\n  '))
}

console.log()
console.log('=== 说明书必含要素自检 ===')
const body = registered[0]?.content || ''
const required = [
  ['环境需知', /环境需知|环境要求/],
  ['有问题停下来问用户', /停下来问|不要猜|直接问/],
  ['一站式安装', /一站式安装/],
  ['主动引导导入', /主动引导导入|主动引导/],
  ['不要自己瞎琢磨', /不要自己瞎琢磨|不用自己瞎琢磨/],
  ['日常维护', /日常维护/],
  ['排障顺序', /排障顺序/],
  ['边界', /边界/],
]
for (const [label, re] of required) {
  ok(re.test(body), `包含「${label}」`)
}

console.log()
console.log(failed ? `== ${failed} 项失败 ==` : '== 全部通过 ==')
process.exit(failed ? 1 : 0)
