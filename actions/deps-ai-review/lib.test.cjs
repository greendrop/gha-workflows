// lib.cjs のテスト（node --test で実行する）
'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { describe, it } = require('node:test')

const lib = require('./lib.cjs')

// vitest の expect に近い書き方で node:assert を呼ぶ
const includes = (actual, expected) =>
  typeof actual === 'string' ? actual.includes(expected) : actual.some((v) => Object.is(v, expected))
const expect = (actual) => ({
  toBe: (expected) => assert.strictEqual(actual, expected),
  toEqual: (expected) => assert.deepStrictEqual(actual, expected),
  toContain: (expected) => assert.ok(includes(actual, expected), `${JSON.stringify(expected)} を含まない`),
  toMatch: (re) => assert.match(actual, re),
  toMatchObject: (expected) => {
    for (const [key, value] of Object.entries(expected)) assert.deepStrictEqual(actual[key], value, key)
  },
  toThrow: (message) => assert.throws(actual, (e) => e.message.includes(message)),
  toBeNull: () => assert.strictEqual(actual, null),
  toBeLessThan: (n) => assert.ok(actual < n, `${actual} < ${n}`),
  toHaveLength: (n) => assert.strictEqual(actual.length, n),
  not: {
    toBe: (expected) => assert.notStrictEqual(actual, expected),
    toContain: (expected) => assert.ok(!includes(actual, expected), `${JSON.stringify(expected)} を含む`)
  }
})
// 呼び出しを記録する必要はないので、関数をそのまま使う
const fn = (impl = () => {}) => impl

const packageJson = {
  filename: 'package.json',
  status: 'modified',
  patch: '@@ -5 +5 @@\n-"a": "1"\n+"a": "2"'
}
const lockfile = {
  filename: 'pnpm-lock.yaml',
  status: 'modified',
  patch: '@@ -1,3 +1,3 @@\n ctx\n-a@1\n+a@2'
}

describe('computeFingerprint', () => {
  it('変更行が同じ rebase（行番号・前後の行・ファイル順の違い）なら同じ値になる', () => {
    const rebased = [
      { ...lockfile, patch: '@@ -40,3 +40,3 @@\n other\n-a@1\n+a@2' },
      { ...packageJson, patch: '@@ -9 +9 @@\n-"a": "1"\n+"a": "2"' }
    ]
    expect(lib.computeFingerprint(rebased)).toBe(lib.computeFingerprint([packageJson, lockfile]))
  })

  it('lockfile の変更行が変わると値が変わる', () => {
    const changed = [packageJson, { ...lockfile, patch: '@@ -1,4 +1,4 @@\n-a@1\n+a@2\n-b@1\n+b@1.1' }]
    expect(lib.computeFingerprint(changed)).not.toBe(lib.computeFingerprint([packageJson, lockfile]))
  })

  it('patch が無いファイルは blob SHA が変わると値が変わる', () => {
    const big = { filename: 'pnpm-lock.yaml', status: 'modified' }
    expect(lib.computeFingerprint([{ ...big, sha: 'aaa' }])).not.toBe(lib.computeFingerprint([{ ...big, sha: 'bbb' }]))
  })

  it('16 文字の 16 進数を返す', () => {
    expect(lib.computeFingerprint([packageJson])).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('buildLlmDiff', () => {
  it('lockfile を diff から省いて一覧にする', () => {
    const { lockfiles, diff } = lib.buildLlmDiff([packageJson, lockfile, { filename: 'mise.lock', status: 'modified' }])
    expect(lockfiles).toEqual(['pnpm-lock.yaml', 'mise.lock'])
    expect(diff).toContain('diff --git a/package.json b/package.json')
    expect(diff).not.toContain('pnpm-lock.yaml')
  })

  it('60,000 文字で打ち切る', () => {
    const { diff } = lib.buildLlmDiff([{ filename: 'a.ts', status: 'modified', patch: '+'.repeat(70000) }])
    expect(diff).toContain('60000 文字で打ち切り')
    expect(diff.length).toBeLessThan(60100)
  })
})

describe('isRelevantEvent', () => {
  const repository = 'o/r'
  const pullRequest = { head: { repo: { full_name: 'o/r' } } }
  const relevant = (payload) => lib.isRelevantEvent({ payload: { pull_request: pullRequest, ...payload }, repository })

  it('ラベル以外のイベントは対象にする', () => {
    expect(relevant({ action: 'opened' })).toBe(true)
    expect(relevant({ action: 'synchronize' })).toBe(true)
  })

  it('フォークから出された PR は対象にしない', () => {
    const payload = { action: 'opened', pull_request: { head: { repo: { full_name: 'fork/r' } } } }
    expect(lib.isRelevantEvent({ payload, repository })).toBe(false)
  })

  it('pending ラベルは Renovate が付けたときだけ対象にする', () => {
    const label = { name: 'deps-ai-review:pending' }
    expect(relevant({ action: 'labeled', label, sender: { login: 'renovate[bot]' } })).toBe(true)
    expect(relevant({ action: 'labeled', label, sender: { login: 'my-app[bot]' } })).toBe(false)
  })

  it('retry・pass・manual-merge の付与と manual-merge の削除を対象にする', () => {
    for (const name of ['deps-ai-review:retry', 'deps-ai-review:pass', 'deps-ai-review:manual-merge']) {
      expect(relevant({ action: 'labeled', label: { name }, sender: { login: 'someone' } })).toBe(true)
    }
    expect(relevant({ action: 'unlabeled', label: { name: 'deps-ai-review:manual-merge' } })).toBe(true)
  })

  it('それ以外のラベルの付け外しは対象にしない', () => {
    expect(relevant({ action: 'labeled', label: { name: 'dependencies' }, sender: { login: 'someone' } })).toBe(false)
    expect(relevant({ action: 'labeled', label: { name: 'deps-ai-review:changes' }, sender: { login: 'x' } })).toBe(
      false
    )
    expect(relevant({ action: 'unlabeled', label: { name: 'deps-ai-review:pass' } })).toBe(false)
  })
})

describe('decideMode', () => {
  const base = { payload: { action: 'synchronize' }, hasRetry: false, fp: 'abc' }

  it('人が pass ラベルを付けたら manual', () => {
    const payload = { action: 'labeled', label: { name: 'deps-ai-review:pass' }, sender: { type: 'User' } }
    expect(lib.decideMode({ ...base, payload })).toBe('manual')
  })

  it('Bot が pass ラベルを付けたときは manual にしない', () => {
    const payload = { action: 'labeled', label: { name: 'deps-ai-review:pass' }, sender: { type: 'Bot' } }
    expect(lib.decideMode({ ...base, payload, previousFp: 'abc', previousVerdict: 'approve' })).toBe('reuse')
  })

  it('前回と差分が同じなら reuse', () => {
    expect(lib.decideMode({ ...base, previousFp: 'abc', previousVerdict: 'human_review' })).toBe('reuse')
  })

  it('retry ラベル・差分の変更・前回の error・前回なしなら review', () => {
    expect(lib.decideMode({ ...base, hasRetry: true, previousFp: 'abc', previousVerdict: 'approve' })).toBe('review')
    expect(lib.decideMode({ ...base, previousFp: 'xyz', previousVerdict: 'approve' })).toBe('review')
    expect(lib.decideMode({ ...base, previousFp: 'abc', previousVerdict: 'error' })).toBe('review')
    expect(lib.decideMode({ ...base, previousFp: '', previousVerdict: '' })).toBe('review')
  })
})

describe('buildReviewPrompt', () => {
  const input = {
    title: 'chore(deps): update dependency vitest to v5',
    body: 'This PR contains the following updates',
    lockfiles: ['pnpm-lock.yaml'],
    diff: 'diff --git a/package.json b/package.json',
    dependencies: [{ name: 'vitest', from: '^4.1.2', to: '^5.0.0', file: 'package.json' }],
    usage: "### vitest.config.ts\nimport { defineConfig } from 'vitest/config'"
  }

  it('PR の情報をタグで囲み、更新された依存とヒントを含める', () => {
    const prompt = lib.buildReviewPrompt({ ...input, dependenciesInstalled: true })
    expect(prompt).toContain('<pr_title>\nchore(deps): update dependency vitest to v5\n</pr_title>')
    expect(prompt).toContain('- vitest: ^4.1.2 → ^5.0.0（package.json、メジャー更新）')
    expect(prompt).toContain("<usage_hints>\n### vitest.config.ts\nimport { defineConfig } from 'vitest/config'")
    expect(prompt).toContain('この PR の本文にはリリースノートがありません')
    expect(prompt).toContain('依存パッケージは PR の新しいバージョンでインストール済みです')
    expect(prompt).not.toContain('## このリポジトリについて')
  })

  it('依存パッケージをインストールしていないときはそのことを伝える', () => {
    expect(lib.buildReviewPrompt({ ...input, dependenciesInstalled: false })).toContain(
      '依存パッケージはインストールされていません'
    )
  })

  it('呼び出し側の補足をリポジトリについての節として含める', () => {
    const prompt = lib.buildReviewPrompt({ ...input, instructions: '  Nuxt 4 のアプリです。\n' })
    expect(prompt).toContain('## このリポジトリについて\nNuxt 4 のアプリです。\n')
  })
})

describe('REVIEW_SCHEMA', () => {
  it('出力スキーマのすべてのプロパティを必須にする（構造化出力のスキーマの要件）', () => {
    expect([...lib.REVIEW_SCHEMA.required].sort()).toEqual(Object.keys(lib.REVIEW_SCHEMA.properties).sort())
    expect(lib.REVIEW_SCHEMA.additionalProperties).toBe(false)
  })
})

describe('buildClaudeArgs', () => {
  it('読み取り系のツールだけを許可し、出力スキーマを渡す', () => {
    const args = lib.buildClaudeArgs({ model: 'claude-model' })
    expect(args).toContain('--model claude-model')
    expect(args).toContain('--allowedTools Read,Grep,Glob')
    expect(args).toContain('--disallowedTools Edit,MultiEdit,Write,NotebookEdit,Bash,WebFetch,WebSearch')
    expect(args).toContain(`--json-schema '${JSON.stringify(lib.REVIEW_SCHEMA)}'`)
  })

  it('モデルを指定しなければ --model を付けない', () => {
    expect(lib.buildClaudeArgs({ model: '' })).not.toContain('--model')
  })
})

describe('redactSecrets', () => {
  it('出力に含まれるシークレットの値を伏せる', () => {
    const review = { summary: 'token is sk-ant-oat01-secretvalue', evidence: ['ghs_abcdefghijk'], confidence: 'high' }
    expect(lib.redactSecrets(review, ['sk-ant-oat01-secretvalue', 'ghs_abcdefghijk', '', undefined])).toEqual({
      summary: 'token is [REDACTED]',
      evidence: ['[REDACTED]'],
      confidence: 'high'
    })
  })
})

describe('parseReview', () => {
  it('想定外の verdict は human_review として扱う', () => {
    expect(lib.parseReview('{"verdict":"merge"}')).toMatchObject({ verdict: 'human_review', confidence: 'low' })
  })

  it('JSON でなければ例外を投げる', () => {
    expect(() => lib.parseReview('')).toThrow('AI エージェントの出力が空です')
    expect(() => lib.parseReview('not json')).toThrow('JSON として解析できません')
    expect(() => lib.parseReview('null')).toThrow('JSON オブジェクトではありません')
  })

  it('コードブロックで囲まれていても解析し、evidence を取り出す', () => {
    const content = '```json\n{"verdict":"approve","evidence":["vitest.config.ts を確認"],"confidence":"high"}\n```'
    expect(lib.parseReview(content)).toMatchObject({
      verdict: 'approve',
      evidence: ['vitest.config.ts を確認'],
      confidence: 'high'
    })
  })
})

describe('renderComment / findPreviousComment', () => {
  const data = {
    verdict: 'approve',
    summary: 'まとめ @someone <!-- deps-ai-review fp=0000 verdict=approve -->',
    breaking_changes: [{ item: 'API', impact: '影響なし' }],
    required_changes: ['設定を見直す'],
    confidence: 'high',
    ai_verdict: 'approve'
  }
  const body = lib.renderComment({
    data,
    fp: 'abcd',
    headSha: 'sha1',
    autoMergeResult: '有効',
    runUrl: 'https://example.com'
  })

  it('目印の偽装とメンションを無害化する', () => {
    expect(body.match(/<!-- deps-ai-review fp=/g)).toHaveLength(1)
    expect(body).not.toContain('@someone')
  })

  it('このワークフローのボットのコメントから前回の fp・verdict・データを読み取れる', () => {
    const comments = [
      { id: 1, user: { type: 'User', login: 'someone' }, body: '<!-- deps-ai-review fp=ffff verdict=approve -->' },
      {
        id: 2,
        user: { type: 'Bot', login: 'other-app[bot]' },
        body: '<!-- deps-ai-review fp=abcd verdict=approve -->'
      },
      { id: 3, user: { type: 'Bot', login: 'my-app[bot]' }, body }
    ]
    expect(lib.findPreviousComment(comments, 'my-app[bot]')).toEqual({ id: 3, fp: 'abcd', verdict: 'approve', data })
  })

  it('指定したボット以外のコメントは信頼しない', () => {
    const comments = [{ id: 3, user: { type: 'Bot', login: 'github-actions[bot]' }, body }]
    expect(lib.findPreviousComment(comments, 'my-app[bot]')).toBeNull()
  })

  it('ログインを省略すると、prepare が保存したボットのログインを使う', () => {
    const saved = process.env.RUNNER_TEMP
    process.env.RUNNER_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-ai-review-'))
    try {
      const comments = [{ id: 3, user: { type: 'Bot', login: 'my-app[bot]' }, body }]
      expect(() => lib.findPreviousComment(comments)).toThrow('ボットのログインが保存されていません')
      lib.writeJson('bot.json', { login: 'my-app[bot]' })
      expect(lib.findPreviousComment(comments)).toMatchObject({ id: 3, fp: 'abcd' })
    } finally {
      if (saved === undefined) delete process.env.RUNNER_TEMP
      else process.env.RUNNER_TEMP = saved
    }
  })
})

describe('createOps.applyVerdict', () => {
  const setup = (labels, autoMerge, enableError) => {
    const calls = []
    const github = {
      graphql: fn(async (query, variables) => {
        // @octokit/graphql はこれらの名前を変数として受け付けない（オプションとして扱うため）
        const reserved = ['method', 'baseUrl', 'url', 'headers', 'request', 'query', 'mediaType', 'operationName']
        const invalid = Object.keys(variables).filter((key) => reserved.includes(key))
        if (invalid.length > 0) throw new Error(`"${invalid[0]}" cannot be used as variable name`)
        if (query.includes('enablePullRequestAutoMerge') && enableError) throw new Error(enableError)
        calls.push(query.includes('enablePullRequestAutoMerge') ? `enable:${variables.mergeMethod}` : 'disable')
      }),
      rest: {
        pulls: {
          get: fn(async () => ({ data: { labels: labels.map((name) => ({ name })), auto_merge: autoMerge } })),
          merge: fn(async (p) =>
            calls.push(`merge:${p.merge_method}:${p.sha}`)
          )
        },
        issues: {
          removeLabel: fn(async (p) => calls.push(`-${p.name}`)),
          addLabels: fn(async (p) => calls.push(`+${p.labels.join(',')}`))
        }
      }
    }
    const context = {
      repo: { owner: 'o', repo: 'r' },
      payload: { pull_request: { number: 1 } },
      serverUrl: '',
      runId: 1
    }
    const ops = lib.createOps({ github, context, core: { warning: fn() } })
    return { ops, calls }
  }

  it('approve ならラベルを pass に付け替え、auto-merge を有効にする', async () => {
    const { ops, calls } = setup(['deps-ai-review:pending', 'deps-ai-review:retry'], null)
    const result = await ops.applyVerdict({ verdict: 'approve', headSha: 'sha', mergeMethod: 'SQUASH' })
    expect(calls).toEqual(['-deps-ai-review:pending', '-deps-ai-review:retry', '+deps-ai-review:pass', 'enable:SQUASH'])
    expect(result).toBe('有効（SQUASH）')
  })

  it('すでにマージできる状態で auto-merge を有効にできなければ、レビューしたコミットを直接マージする', async () => {
    const { ops, calls } = setup(['deps-ai-review:pending'], null, 'Pull request Pull request is in unstable status')
    const result = await ops.applyVerdict({ verdict: 'approve', headSha: 'sha1', mergeMethod: 'MERGE' })
    expect(calls).toEqual(['-deps-ai-review:pending', '+deps-ai-review:pass', 'merge:merge:sha1'])
    expect(result).toContain('マージ済み（MERGE')
  })

  it('それ以外の理由で auto-merge を有効にできなければ、マージせずに失敗を返す', async () => {
    const { ops, calls } = setup(['deps-ai-review:pending'], null, 'Auto merge is not allowed for this repository')
    const result = await ops.applyVerdict({ verdict: 'approve', headSha: 'sha1', mergeMethod: 'MERGE' })
    expect(calls).toEqual(['-deps-ai-review:pending', '+deps-ai-review:pass'])
    expect(result).toBe('有効化に失敗: Auto merge is not allowed for this repository')
  })

  it('approve でも自動マージの対象外なら、auto-merge を解除する', async () => {
    const { ops, calls } = setup(['deps-ai-review:pending'], {})
    const result = await ops.applyVerdict({
      verdict: 'approve',
      headSha: 'sha',
      mergeMethod: 'SQUASH',
      autoMerge: { enabled: false, reason: 'メジャー更新は自動マージの対象外のため、手動でマージしてください' }
    })
    expect(calls).toEqual(['-deps-ai-review:pending', '+deps-ai-review:pass', 'disable'])
    expect(result).toBe('無効（メジャー更新は自動マージの対象外のため、手動でマージしてください）')
  })

  it('changes_required なら auto-merge を解除し、ラベルを changes に付け替える（コミットステータスは付けない）', async () => {
    const { ops, calls } = setup(['deps-ai-review:pass'], {})
    await ops.applyVerdict({ verdict: 'changes_required', headSha: 'sha' })
    expect(calls).toEqual(['disable', '-deps-ai-review:pass', '+deps-ai-review:changes'])
  })

  it('error ならラベルを error に付け替える', async () => {
    const { ops, calls } = setup([], null)
    await ops.applyVerdict({ verdict: 'error', headSha: 'sha' })
    expect(calls).toEqual(['+deps-ai-review:error'])
  })
})

describe('extractUpdatedDependencies', () => {
  it('package.json・packageManager・mise.toml・GitHub Actions の更新を取り出す', () => {
    const files = [
      {
        filename: 'package.json',
        patch:
          '@@\n-    "vitest": "^4.1.2",\n+    "vitest": "^5.0.0",\n-  "packageManager": "pnpm@10.34.5",\n+  "packageManager": "pnpm@12.0.0",'
      },
      { filename: 'mise.toml', patch: '@@\n-pnpm = "10.34.5"\n+pnpm = "12.0.0"' },
      {
        filename: '.github/workflows/ci.yml',
        patch: '@@\n-        uses: actions/checkout@aaa # v6.0.0\n+        uses: actions/checkout@bbb # v7.0.1'
      },
      { filename: 'pnpm-lock.yaml', patch: '@@\n-    "x": "1"\n+    "x": "2"' }
    ]
    expect(lib.extractUpdatedDependencies(files)).toEqual([
      { name: 'vitest', from: '^4.1.2', to: '^5.0.0', file: 'package.json' },
      { name: 'pnpm', from: '10.34.5', to: '12.0.0', file: 'package.json' },
      { name: 'actions/checkout', from: 'v6.0.0', to: 'v7.0.1', file: '.github/workflows/ci.yml' }
    ])
  })

  it('追加・削除だけの行は更新として扱わない', () => {
    expect(
      lib.extractUpdatedDependencies([{ filename: 'package.json', patch: '@@\n+    "new-dep": "^1.0.0",' }])
    ).toEqual([])
  })
})

describe('isMajorBump / hasReleaseNotes', () => {
  it('メジャーが上がる更新と、0.x のマイナーが上がる更新をメジャー扱いにする', () => {
    expect(lib.isMajorBump({ from: '^4.1.2', to: '^5.0.0' })).toBe(true)
    expect(lib.isMajorBump({ from: '^0.22.0', to: '^0.23.0' })).toBe(true)
    expect(lib.isMajorBump({ from: '^4.1.2', to: '^4.2.0' })).toBe(false)
    expect(lib.isMajorBump({ from: 'abc', to: 'def' })).toBe(false)
  })

  it('Renovate の Release Notes 見出しを検出する', () => {
    expect(lib.hasReleaseNotes('### Release Notes\n\n...')).toBe(true)
    expect(lib.hasReleaseNotes('This PR contains the following updates')).toBe(false)
  })
})

describe('findPatchedDependencies', () => {
  const makeRepo = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-ai-review-'))
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      fs.writeFileSync(path.join(dir, name), content)
    }
    return dir
  }

  it('package.json・pnpm-workspace.yaml・patches/ のパッチや overrides を検出する', () => {
    const repoDir = makeRepo({
      'package.json': JSON.stringify({ pnpm: { overrides: { 'parent>vitest': '5.0.0' } } }),
      'pnpm-workspace.yaml':
        'packages:\n  - .\npatchedDependencies:\n  "@nuxt/ui@4.0.0": patches/@nuxt__ui@4.0.0.patch\n',
      'patches/@nuxt__ui@4.0.0.patch': '',
      'patches/tinybench+6.2.0.patch': ''
    })
    expect(lib.findPatchedDependencies({ repoDir, names: ['vitest', '@nuxt/ui', 'tinybench', 'vue'] })).toEqual([
      { name: 'vitest', sources: ['package.json pnpm.overrides: parent>vitest'] },
      {
        name: '@nuxt/ui',
        sources: ['pnpm-workspace.yaml patchedDependencies: @nuxt/ui@4.0.0', 'patches/@nuxt__ui@4.0.0.patch']
      },
      { name: 'tinybench', sources: ['patches/tinybench+6.2.0.patch'] }
    ])
  })
})

describe('collectUsage', () => {
  it('依存を参照しているコードだけを集める', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-ai-review-'))
    fs.writeFileSync(path.join(repoDir, 'a.ts'), "import { defineConfig } from 'vitest/config'\n")
    fs.writeFileSync(path.join(repoDir, 'b.ts'), "import { ref } from 'vue'\n")
    fs.mkdirSync(path.join(repoDir, 'openspec'))
    fs.writeFileSync(path.join(repoDir, 'openspec/c.md'), "'vitest'\n")
    execFileSync('git', ['init', '-q'], { cwd: repoDir })
    execFileSync('git', ['add', '.'], { cwd: repoDir })
    const usage = lib.collectUsage({ repoDir, names: ['vitest'] })
    expect(usage.files).toEqual(['a.ts'])
    expect(usage.text).toContain("from 'vitest/config'")
  })
})

describe('evaluateGuards', () => {
  it('パッチや overrides が当たっている依存の更新を理由にする', () => {
    const reasons = lib.evaluateGuards({ patched: [{ name: 'vitest', sources: ['patches/vitest+5.0.0.patch'] }] })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('patches/vitest+5.0.0.patch')
  })

  it('パッチが無ければガードに当たらない（リリースノートの有無は AI エージェントが判断する）', () => {
    expect(lib.evaluateGuards({ patched: [] })).toEqual([])
  })
})

describe('decideAutoMerge', () => {
  it('自動マージが有効で manual-merge ラベルが無ければ auto-merge を有効にする', () => {
    expect(lib.decideAutoMerge({ autoMergeEnabled: true, manualMerge: false })).toEqual({ enabled: true })
  })

  it('自動マージが有効になっていなければ（既定）手動マージにする', () => {
    expect(lib.decideAutoMerge({ manualMerge: false })).toEqual({
      enabled: false,
      reason:
        '自動マージが有効になっていない（auto-merge が true でない）ため、手動でマージしてください'
    })
  })

  it('manual-merge ラベルが付いていれば手動マージにする', () => {
    expect(lib.decideAutoMerge({ autoMergeEnabled: true, manualMerge: true })).toEqual({
      enabled: false,
      reason: '`deps-ai-review:manual-merge` ラベルが付いているため、手動でマージしてください'
    })
  })

  it('人の手動承認は設定やラベルにかかわらず auto-merge を有効にする', () => {
    expect(lib.decideAutoMerge({ approvedBy: 'someone', autoMergeEnabled: false, manualMerge: true })).toEqual({
      enabled: true
    })
  })
})

describe('parseAutoMergeEnabled', () => {
  it('true のときだけ有効にする', () => {
    expect(lib.parseAutoMergeEnabled('true')).toBe(true)
    expect(lib.parseAutoMergeEnabled(' TRUE ')).toBe(true)
    expect(lib.parseAutoMergeEnabled('')).toBe(false)
    expect(lib.parseAutoMergeEnabled('false')).toBe(false)
    expect(lib.parseAutoMergeEnabled('1')).toBe(false)
    expect(lib.parseAutoMergeEnabled(undefined)).toBe(false)
  })
})
