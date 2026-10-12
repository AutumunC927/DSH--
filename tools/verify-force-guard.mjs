/**
 * pet_create 的 force 删除防护 —— 验证脚本。
 *
 * 覆盖三种情况：
 *   A. 危险目标（盘根 / 用户主目录 / 系统目录）→ 必须拒绝，且目录必须还在
 *   B. force 指向【非本插件产出】的非空目录 → 必须拒绝，且内容必须原封不动
 *   C. force 指向【本插件产出】的目录 → 必须成功覆盖
 *
 * 用法: node tools/verify-force-guard.mjs
 */

import { mkdir, writeFile, readdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createPet } from '../lib/pet.js'

const MODEL = process.argv[2]
if (!MODEL) {
  console.error('用法: node tools/verify-force-guard.mjs <一个已校验通过的模型目录>')
  process.exit(2)
}

let failed = 0
const ok = (cond, label) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failed++
}

const SANDBOX = join(tmpdir(), 'dsh-pet-guard-test')

async function expectReject(outDir, label, { mustSurvive } = {}) {
  let threw = false
  let message = ''
  try {
    await createPet({ modelDir: MODEL, outDir, force: true })
  } catch (e) {
    threw = true
    message = e.message
  }
  ok(threw, `${label} —— 被拒绝`)
  if (threw) console.log(`        理由: ${message.split('\n')[0]}`)
  if (mustSurvive) {
    ok(existsSync(mustSurvive), `${label} —— 目标内容仍然存在`)
  }
}

console.log('=== A. 危险目标必须拒绝（且不得被删除）===')
await expectReject('D:\\', '盘根 D:\\', { mustSurvive: 'D:\\' })
await expectReject('C:\\', '盘根 C:\\', { mustSurvive: 'C:\\' })
await expectReject(homedir(), '用户主目录', { mustSurvive: join(homedir(), '.dsh') })
await expectReject(process.env.SystemRoot || 'C:\\Windows', '系统目录', {
  mustSurvive: process.env.SystemRoot || 'C:\\Windows',
})

console.log()
console.log('=== B. 非本插件产出的非空目录必须拒绝，内容不得改动 ===')
const bystander = join(SANDBOX, 'bystander')
await rm(bystander, { recursive: true, force: true })
await mkdir(bystander, { recursive: true })
await writeFile(join(bystander, 'important.txt'), 'do not delete me', 'utf8')
await mkdir(join(bystander, 'sub'), { recursive: true })
await writeFile(join(bystander, 'sub', 'more.txt'), 'also important', 'utf8')

await expectReject(bystander, '无关目录 + force=true', { mustSurvive: bystander })
ok((await readdir(bystander)).includes('important.txt'), '无关目录 —— important.txt 还在')
ok(
  (await readFile(join(bystander, 'sub', 'more.txt'), 'utf8')) === 'also important',
  '无关目录 —— 子目录文件内容未变',
)

console.log()
console.log('=== C. 本插件产出的目录可以 force 覆盖 ===')
const petDir = join(SANDBOX, 'my-pet')
await rm(petDir, { recursive: true, force: true })
await createPet({ modelDir: MODEL, outDir: petDir, name: 'guard-test' })
ok(existsSync(join(petDir, 'XiaoXiaoQiu.Pet.exe')), '首次生成成功')
await writeFile(join(petDir, 'stale.tmp'), 'leftover', 'utf8')
await createPet({ modelDir: MODEL, outDir: petDir, name: 'guard-test', force: true })
ok(existsSync(join(petDir, 'XiaoXiaoQiu.Pet.exe')), '再次生成成功')
ok(!existsSync(join(petDir, 'stale.tmp')), '旧残留已被清掉（确实做了覆盖）')

console.log()
console.log('=== 清理 ===')
await rm(SANDBOX, { recursive: true, force: true })
console.log('  已清理', SANDBOX)

console.log()
console.log(failed ? `== ${failed} 项失败 ==` : '== 全部通过 ==')
process.exit(failed ? 1 : 0)
