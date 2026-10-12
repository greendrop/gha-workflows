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

ツール（actionlint・ghalint・zizmor・yamlfmt・betterleaks・lefthook）は [mise](https://mise.jdx.dev/) でバージョンを固定している。CI も同じ `mise.toml` / `mise.lock` を使う。

```bash
# lefthook install も自動実行される
mise install
```

| チェック | 手元での実行 |
|---|---|
| GitHub Actions の lint | `actionlint -color`、`ghalint run`、`ghalint run-action actions/*/action.yml`、`zizmor --gh-token "$(gh auth token)" .` |
| YAML の書式 | `yamlfmt -lint .`（`yamlfmt .` で修正） |
| 秘密情報のスキャン | lefthook の pre-commit フックがコミット前に staged の変更をチェックする |
