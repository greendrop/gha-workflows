# gha-workflows

複数のリポジトリで共通に使う GitHub Actions の composite action・reusable workflow を管理するリポジトリ。

- public リポジトリだが、GitHub Marketplace には公開しない（Marketplace に公開できるのはルートの `action.yml` だけで、`actions/` 配下の composite action や reusable workflow は対象外）
- リポジトリの設定は [github-terraform](https://github.com/greendrop/github-terraform) で管理している

## composite action と reusable workflow の使い分け

| | composite action（`actions/<name>/action.yml`） | reusable workflow（`.github/workflows/<name>.yml`） |
|---|---|---|
| 呼び出し側 | ステップとして呼ぶ。checkout・ツールのインストールなどを前後に自由に書ける | ジョブとして呼ぶ。ジョブ全体を任せる |
| チェック名 | 呼び出し側のジョブ名のまま | 「呼び出し側のジョブ名 / reusable workflow のジョブ名」 |
| 複数ジョブ・ジョブごとの権限分離 | できない | できる |
| 向いているもの | lint・スキャンなど 1 ジョブで済む処理 | ジョブを分けて権限を絞りたい処理 |

基本は composite action にする。checkout やツールのインストール（mise など）はリポジトリごとに違うので呼び出し側に任せ、composite action では必要なツールが入っているかを最初にチェックする。

## composite action

| action | 内容 | 呼び出し側で用意するもの |
|---|---|---|
| [`secret-scan`](actions/secret-scan/action.yml) | betterleaks で PR の差分コミットから秘密情報を検出する | checkout（`fetch-depth: 0`）、betterleaks |
| [`github-actions-lint`](actions/github-actions-lint/action.yml) | actionlint・ghalint・zizmor で GitHub Actions を静的解析する（ツールごとに inputs で無効にできる） | checkout、有効にしたツール |
| [`deps-ai-review/prepare`](actions/deps-ai-review/prepare/action.yml)・[`deps-ai-review/review`](actions/deps-ai-review/review/action.yml) | Renovate の更新 PR を AI エージェントでレビューし、判定結果をラベル・auto-merge・PR コメントに反映する（[deps-ai-review](#deps-ai-review)） | checkout、AI レビュー用の GitHub App、Claude の OAuth トークン、依存のインストール（任意） |

`.github/workflows/` の `repo-` で始まるワークフローは、このリポジトリ自身の CI・リリース用（呼び出し側からは使わない）。

## 使い方

呼び出し側のリポジトリで、コミット SHA で固定してバージョンをコメントに書く（Renovate の github-actions マネージャーが更新する）。

```yaml
on:
  pull_request:

jobs:
  secret-scan:
    runs-on: ubuntu-slim
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha> # vX.Y.Z
        with:
          persist-credentials: false
          fetch-depth: 0
      # ツールのインストールはリポジトリに合った方法で行う（mise を使う例）
      - uses: jdx/mise-action@<sha> # vX.Y.Z
        with:
          install_args: betterleaks
      - uses: greendrop/gha-workflows/actions/secret-scan@<sha> # vX.Y.Z
```

reusable workflow を追加したときの注意:

- 呼び出し側のジョブで付けた `permissions` が上限になる。reusable workflow の中のジョブはその範囲で権限を絞る
- secrets は `secrets: inherit` ではなく、必要なものだけを明示的に渡す
- チェック名は「呼び出し側のジョブ名 / reusable workflow のジョブ名」になる。ruleset の必須チェックはこの名前で指定する

## deps-ai-review

Renovate の更新 PR を AI エージェント（[anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)）でレビューし、pass なら auto-merge を有効にする。

- 1 つのジョブで `prepare` → 依存のインストール（レビューするときだけ） → `review` の順に実行する
- 判定結果はラベル（`deps-ai-review:*`）と PR コメントで表す。対象の PR には Renovate が `deps-ai-review:pending` を付ける
- AI エージェントには書き込み権限を渡さない
  - ジョブの `permissions` は読み取りだけにする（ジョブの GITHUB_TOKEN を AI エージェントに渡す）
  - ラベル・コメント・auto-merge は GitHub App のトークンで書き込む。`prepare` で作ったトークンは AI エージェントの実行前に無効にし、`review` では AI エージェントの実行後にトークンを作る
  - AI エージェントには読み取り系のツール（Read・Grep・Glob）だけを許可する
- 依存のインストールは呼び出し側で行う（パッケージマネージャー・ツールの準備はリポジトリごとに違うため）。インストールできると、AI エージェントが新しいバージョンの CHANGELOG・型定義などを読める

```yaml
name: deps-ai-review

on:
  pull_request:
    types:
      - opened
      - reopened
      - synchronize
      - labeled
      - unlabeled

# 途中キャンセルでラベルが中途半端に残るのを防ぐため、PR ごとにキャンセルせずに順番に実行する
concurrency:
  group: deps-ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  deps-ai-review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    # 読み取りだけにする（書き込みは GitHub App のトークンで行う）
    permissions:
      contents: read
      pull-requests: read
      issues: read
    steps:
      - uses: actions/checkout@<sha> # vX.Y.Z
        with:
          persist-credentials: false

      - id: prepare
        uses: greendrop/gha-workflows/actions/deps-ai-review/prepare@<sha> # vX.Y.Z
        with:
          app-client-id: ${{ secrets.GH_APPS_AI_REVIEW_CLIENT_ID }}
          app-private-key: ${{ secrets.GH_APPS_AI_REVIEW_PRIVATE_KEY }}

      # レビューするときだけ依存をインストールする（失敗してもレビューは続ける。インストールスクリプトは実行しない）
      - id: mise
        if: steps.prepare.outputs.review-needed == 'true'
        continue-on-error: true
        uses: jdx/mise-action@<sha> # vX.Y.Z
      - id: install
        if: steps.mise.outcome == 'success'
        continue-on-error: true
        run: pnpm install --frozen-lockfile --ignore-scripts

      # prepare が途中で失敗したときも、error を反映するために実行する
      - if: always() && steps.prepare.outputs.target == 'true'
        uses: greendrop/gha-workflows/actions/deps-ai-review/review@<sha> # vX.Y.Z
        with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          app-client-id: ${{ secrets.GH_APPS_AI_REVIEW_CLIENT_ID }}
          app-private-key: ${{ secrets.GH_APPS_AI_REVIEW_PRIVATE_KEY }}
          dependencies-installed: ${{ steps.install.outcome == 'success' }}
          instructions: Nuxt 4 のアプリです。nuxt.config.ts の modules も依存の使用箇所として確認してください
          claude-model: ${{ vars.DEPS_AI_REVIEW_CLAUDE_MODEL }}
          auto-merge: ${{ vars.DEPS_AI_REVIEW_AUTO_MERGE }}
          merge-method: ${{ vars.DEPS_AI_REVIEW_MERGE_METHOD || 'MERGE' }}
```

| 設定 | 内容 |
|---|---|
| `app-client-id` / `app-private-key` | AI レビュー用の GitHub App（Contents・Pull requests・Issues の Read and write）。必須 |
| `claude-code-oauth-token` | Claude の OAuth トークン（Pro / Max プランで `claude setup-token` で発行）。必須 |
| `dependencies-installed` | 依存をインストールできたか（AI エージェントにインストール先のファイルも読むよう伝える） |
| `instructions` | AI エージェントに伝える、このリポジトリについての補足 |
| `claude-model` | モデル（未指定なら Claude Code の既定） |
| `auto-merge` | `true` で AI が approve した PR を自動マージする（既定値: 無効。導入初期はレビューだけさせて判断を確認する） |
| `merge-method` | 自動マージのマージ方法（MERGE / SQUASH / REBASE。既定値: MERGE） |

Renovate の設定で、レビュー対象の PR に `deps-ai-review:pending` を付ける。自動マージしない PR には `deps-ai-review:manual-merge` も付ける。

```json5
{
  packageRules: [
    { matchUpdateTypes: ["major", "minor", "patch"], addLabels: ["deps-ai-review:pending"] },
    { matchUpdateTypes: ["major"], addLabels: ["deps-ai-review:manual-merge"] },
  ],
}
```

- 再レビュー: `deps-ai-review:retry` ラベルを付ける
- 手動承認: `deps-ai-review:pass` ラベルを付ける（自動マージの設定や `deps-ai-review:manual-merge` にかかわらず auto-merge を有効にする）
- スクリプトは [`actions/deps-ai-review/lib.cjs`](actions/deps-ai-review/lib.cjs)。テストは `node --test 'actions/**/*.test.cjs'`

## バージョン管理

リポジトリ全体で 1 つのセマンティックバージョン（`vX.Y.Z`）を [release-please](https://github.com/googleapis/release-please) で管理する。

- PR は squash merge だけで、PR タイトルがコミットメッセージになる。PR タイトルは Conventional Commits の形式にする（`repo-pr-title-lint` でチェック）
  - `fix: ...` → パッチ、`feat: ...` → マイナー、`feat!: ...` → メジャー（1.0.0 未満の間はマイナー）
  - `chore:` / `docs:` / `ci:` などはリリースしない
  - scope に action・ワークフロー名を書くと、どれの変更か CHANGELOG で分かる（例: `feat(secret-scan): ...`）
- main に push されると release-please がリリース PR を作成・更新する。リリース PR をマージすると、タグと GitHub Release が作られる
- Renovate による GitHub Actions の更新は、呼び出し側に届けるため `fix(deps)` としてリリースする

## composite action を追加するとき

- `actions/<name>/action.yml` に作る
- 先頭のコメントに、内容・呼び出し側で用意するもの・呼び出し例を書く
- checkout・ツールのインストールは呼び出し側に任せ、最初のステップで必要なツール・前提条件をチェックして、足りなければ `::error::` で分かるように失敗させる
- inputs を `run` で使うときは `${{ }}` を直接埋め込まず、`env` で渡す（スクリプトインジェクション対策）
- このリポジトリでも使うなら、`repo-<name>.yml` から `uses: ./actions/<name>` で呼び出して動作を確認する
- 「composite action」の表に追加する

## 開発

ツール（actionlint・ghalint・zizmor・yamlfmt・betterleaks・lefthook・node）は [mise](https://mise.jdx.dev/) でバージョンを固定している。CI も同じ `mise.toml` / `mise.lock` を使う。

```bash
# lefthook install も自動実行される
mise install
```

| チェック | 手元での実行 |
|---|---|
| GitHub Actions の lint | `actionlint -color`、`ghalint run`、`ghalint run-action actions/*/action.yml actions/*/*/action.yml`、`zizmor --gh-token "$(gh auth token)" .` |
| テスト | `node --test 'actions/**/*.test.cjs'` |
| YAML の書式 | `yamlfmt -lint .`（`yamlfmt .` で修正） |
| 秘密情報のスキャン | lefthook の pre-commit フックがコミット前に staged の変更をチェックする |
